import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CrawlPagesResponse, CrawlRun, Issue, Paged, WebsiteSummary } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createLogger } from '../../src/lib/logger';
import { openPersistence } from '../../src/repositories/postgres/persistence';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from '../gocrawl/goHelpers';
import { ADMIN, DB_URL, boot, freshDatabase, sql, waitForCrawl, type Booted } from './helpers';

/**
 * Websites, crawls, page results, issues and Health Score in PostgreSQL: they survive API restarts (in-process and a
 * real process restart with SIGTERM), each website keeps its own data, cancelled crawls never replace a valid audit,
 * and a database that cannot be reached or written is reported — never replaced by temporary memory.
 * Local fixture websites only (127.0.0.1 / localhost).
 */
const sites: FixtureSite[] = [];
const dbs: { drop: () => Promise<void> }[] = [];
let running: Booted | undefined;
afterEach(async () => { await running?.stop().catch(() => undefined); running = undefined; for (const s of sites.splice(0)) await s.close(); });
afterAll(async () => { for (const d of dbs) await d.drop().catch(() => undefined); });

async function db() { const d = await freshDatabase(); dbs.push(d); return d; }
const issuesOf = async (b: Booted, siteId: string) => ((await b.agent.get('/api/issues?pageSize=500').set(b.site(siteId))).body as Paged<Issue>).items;
const websitesOf = async (b: Booted) => (await b.agent.get('/api/websites').set(b.auth)).body as WebsiteSummary[];

describe.skipIf(!DB_URL || !HAVE_GO)('PostgreSQL persistence', () => {
  it('keeps websites, crawls, page results, issues and each website\'s Health Score across API restarts', async () => {
    const { url } = await db();
    // Two different stores: the primary (127.0.0.1) and "grab" (localhost), with different defects.
    const primarySite = await startFixtureSite({ missingAlt: ['vegetable-chopper'], missingMeta: ['/products/silicone-spatula-set'] });
    const grabSite = await startFixtureSite({ host: 'localhost', multipleH1: ['/products/led-fairy-lights-10m'], brokenImages: ['artificial-money-plant'], missingCanonical: ['/collections/toys'] });
    sites.push(primarySite, grabSite);

    // ---- first API process
    let b = running = await boot(url, primarySite.origin);
    const add = async (name: string, u: string) => {
      const r = await b.agent.post('/api/websites').set(b.auth).send({ name, url: u, platform: 'shopify' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const grab = await add('grab', grabSite.url);
    const third = await add('Third shop', 'https://third-shop.example/');
    const primary = 'site-deodap';
    const startA = await b.agent.post('/api/crawls').set(b.site(primary)).send({ type: 'full' });
    const startB = await b.agent.post('/api/crawls').set(b.site(grab)).send({ type: 'full' });
    expect([startA.status, startB.status]).toEqual([200, 200]);
    const runA = await waitForCrawl(b, primary, startA.body.id) as CrawlRun;
    const runB = await waitForCrawl(b, grab, startB.body.id) as CrawlRun;
    expect([runA.outcome, runB.outcome]).toEqual(['completed', 'completed']);
    // Change Monitor history of each website is written when its comparison finishes.
    for (const [s, id] of [[primary, runA.id], [grab, runB.id]] as const) {
      for (let i = 0; i < 50; i++) { if ((await b.agent.get(`/api/changes/runs/${id}`).set(b.site(s))).status === 200) break; await new Promise((r) => setTimeout(r, 100)); }
    }
    await b.persistence.flush();

    const before = {
      websites: await websitesOf(b),
      issuesA: await issuesOf(b, primary), issuesB: await issuesOf(b, grab),
      healthA: (await b.agent.get('/api/health/score').set(b.site(primary))).body,
      healthB: (await b.agent.get('/api/health/score').set(b.site(grab))).body,
      pagesB: (await b.agent.get(`/api/crawls/${runB.id}/pages?limit=500`).set(b.site(grab))).body as CrawlPagesResponse,
    };
    expect(before.websites.map((w) => w.id)).toEqual([primary, grab, third]);
    expect(before.websites.find((w) => w.id === third)!.hasAuditData).toBe(false); // never crawled: no score, not "0 issues"
    expect(before.websites.find((w) => w.id === grab)!.hasAuditData).toBe(true);
    // No mixing: each website's findings name only its own URLs.
    expect(before.issuesA.length).toBeGreaterThan(0);
    expect(before.issuesB.length).toBeGreaterThan(0);
    for (const i of before.issuesA) for (const u of i.affectedUrls) expect(u.startsWith(primarySite.origin), `${i.checkId} ${u}`).toBe(true);
    for (const i of before.issuesB) for (const u of i.affectedUrls) expect(u.startsWith(grabSite.origin), `${i.checkId} ${u}`).toBe(true);
    // Crawl ids are per website: the same id under the primary website is the primary's own crawl, never grab's.
    const sameIdOnPrimary = (await b.agent.get(`/api/crawls/${runB.id}/pages?limit=500`).set(b.site(primary))).body as CrawlPagesResponse;
    for (const r of sameIdOnPrimary.rows) expect(r.url.startsWith(primarySite.origin), r.url).toBe(true);
    // What is stored, per website (scoped rows; no website's data under another's id).
    const rows = await sql(url, 'SELECT website_id, count(*)::int AS n FROM sentinel_crawl_rows GROUP BY website_id ORDER BY website_id');
    expect(rows.rows).toEqual([{ website_id: primary, n: expect.any(Number) }, { website_id: grab, n: before.pagesB.total }].sort((x, y) => x.website_id.localeCompare(y.website_id)));
    const files = (await sql(url, "SELECT website_id, path FROM sentinel_files WHERE path LIKE 'changes/%index.json'")).rows.map((x) => x.website_id).sort();
    expect(files).toEqual([grab, primary].sort());
    const crawlRecs = (await sql(url, "SELECT website_id, id FROM sentinel_records WHERE collection = 'crawls' ORDER BY website_id")).rows;
    expect(crawlRecs.map((x) => x.website_id)).toEqual([grab, primary].sort());
    await b.stop();

    // ---- second API process: empty disk, same database
    b = running = await boot(url, primarySite.origin);
    const after = await websitesOf(b);
    expect(after.map((w) => [w.id, w.name, w.domain, w.hasAuditData, w.healthScore])).toEqual(before.websites.map((w) => [w.id, w.name, w.domain, w.hasAuditData, w.healthScore]));
    const noTime = (h: { at?: string }) => ({ ...h, at: undefined });
    expect(noTime((await b.agent.get('/api/health/score').set(b.site(primary))).body)).toEqual(noTime(before.healthA));
    expect(noTime((await b.agent.get('/api/health/score').set(b.site(grab))).body)).toEqual(noTime(before.healthB));
    expect(before.healthA.score).not.toBe(before.healthB.score);
    const issuesB2 = await issuesOf(b, grab);
    expect(issuesB2.map((i) => [i.id, i.checkId, i.status, i.affectedCount]).sort()).toEqual(before.issuesB.map((i) => [i.id, i.checkId, i.status, i.affectedCount]).sort());
    expect((await issuesOf(b, primary)).length).toBe(before.issuesA.length);
    const fix = await b.agent.get(`/api/issues/${issuesB2[0].id}`).set(b.site(grab));
    expect(fix.status).toBe(200);
    expect(fix.body.issue.evidence.length).toBeGreaterThan(0); // evidence and Fix Card recommendations are kept
    // Crawl runs with their counts and completeness.
    const crawlsB = (await b.agent.get('/api/crawls').set(b.site(grab))).body as CrawlRun[];
    const rb = crawlsB.find((c) => c.id === runB.id)!;
    expect([rb.status, rb.outcome, rb.urlsCrawled, rb.coverage?.discovered, rb.coverage?.excluded, rb.finishedAt]).toEqual([runB.status, runB.outcome, runB.urlsCrawled, runB.coverage?.discovered, runB.coverage?.excluded, runB.finishedAt]);
    // Page-level results, rebuilt from the database (the crawl's files are gone).
    const pagesB2 = (await b.agent.get(`/api/crawls/${runB.id}/pages?limit=500`).set(b.site(grab))).body as CrawlPagesResponse;
    expect(pagesB2.total).toBe(before.pagesB.total);
    expect(pagesB2.rows.map((r) => [r.url, r.status, r.auditScore]).sort()).toEqual(before.pagesB.rows.map((r) => [r.url, r.status, r.auditScore]).sort());
    const report = await b.agent.get('/api/crawls/latest/page').query({ url: `${grabSite.origin}/products/led-fairy-lights-10m` }).set(b.site(grab));
    expect(report.status).toBe(200);
    expect(report.body.audit.checks.map((c: { id: string }) => c.id)).toContain('h1-multiple');
    expect((await b.agent.get(`/api/crawls/${runB.id}/coverage`).set(b.site(grab))).body.available).toBe(true);
    const csv = await b.agent.get(`/api/crawls/${runB.id}/export?format=csv`).set(b.site(grab));
    expect(csv.text.trim().split('\r\n').length).toBe(before.pagesB.total + 1);
    // Change Monitor baseline restored: the next crawl is compared with it.
    expect((await b.agent.get(`/api/changes/runs/${runB.id}`).set(b.site(grab))).status).toBe(200);
    await b.stop();
  }, 240_000);

  it('a cancelled crawl never replaces the last valid audit, also after a restart', async () => {
    const { url } = await db();
    const s = await startFixtureSite({ missingAlt: ['vegetable-chopper'] });
    sites.push(s);
    let b = running = await boot(url, s.origin);
    const primary = 'site-deodap';
    const first = await b.agent.post('/api/crawls').set(b.site(primary)).send({ type: 'full' });
    const good = await waitForCrawl(b, primary, first.body.id) as CrawlRun;
    expect(good.outcome).toBe('completed');
    const issues0 = await issuesOf(b, primary);
    const health0 = (await b.agent.get('/api/health/score').set(b.site(primary))).body;
    const latest0 = (await b.agent.get('/api/crawls/latest/page').query({ url: `${s.origin}/` }).set(b.site(primary))).body.runId;
    expect(latest0).toBe(good.id);

    // A slow crawl, cancelled after it started.
    const slow = await b.agent.post('/api/crawls').set(b.site(primary)).send({ type: 'full', options: { startUrl: `${s.origin}/`, maxPages: null, maxDepth: null, timeoutMs: 5000, concurrency: 1, requestDelayMs: 400 } });
    expect(slow.status, JSON.stringify(slow.body)).toBe(200);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await b.agent.post(`/api/crawls/${slow.body.id}/cancel`).set(b.site(primary))).status).toBe(200);
    const cancelled = await waitForCrawl(b, primary, slow.body.id) as CrawlRun;
    expect(cancelled.status).toBe('cancelled');

    const same = async () => {
      expect((await issuesOf(b, primary)).map((i) => [i.id, i.status, i.affectedCount]).sort()).toEqual(issues0.map((i) => [i.id, i.status, i.affectedCount]).sort());
      expect({ ...(await b.agent.get('/api/health/score').set(b.site(primary))).body, at: undefined }).toEqual({ ...health0, at: undefined });
      expect((await b.agent.get('/api/crawls/latest/page').query({ url: `${s.origin}/` }).set(b.site(primary))).body.runId).toBe(good.id);
      expect((await websitesOf(b))[0].hasAuditData).toBe(true);
    };
    await same();
    await b.stop();
    b = running = await boot(url, s.origin);
    await same();
    const runs = (await b.agent.get('/api/crawls').set(b.site(primary))).body as CrawlRun[];
    expect(runs.find((r) => r.id === slow.body.id)?.status).toBe('cancelled');
  }, 180_000);

  it('a crawl interrupted by a restart is started again from its stored settings and does not block the next crawl', async () => {
    const { url } = await db();
    const s = await startFixtureSite();
    sites.push(s);
    let b = running = await boot(url, s.origin);
    const done = await waitForCrawl(b, 'site-deodap', (await b.agent.post('/api/crawls').set(b.auth).send({ type: 'full' })).body.id) as CrawlRun;
    // As if the process died mid-crawl: the run is stored as running.
    await b.container.repos.crawls.insert({ ...done, id: 'CRL-0099', status: 'running', outcome: undefined, finishedAt: undefined, urlsCrawled: 4 });
    await b.persistence.flush();
    await b.stop();
    b = running = await boot(url, s.origin);
    const back = (await b.agent.get('/api/crawls/CRL-0099').set(b.auth)).body.run as CrawlRun;
    expect(['queued', 'running']).toContain(back.status);
    expect(back.resume).toMatchObject({ attempts: 1, pagesBeforeRestart: 4 });
    const again = await waitForCrawl(b, 'site-deodap', 'CRL-0099') as CrawlRun;
    expect([again.status, again.outcome]).toEqual(['completed', 'completed']);
    const next = await b.agent.post('/api/crawls').set(b.auth).send({ type: 'full' });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect((await waitForCrawl(b, 'site-deodap', next.body.id) as CrawlRun).outcome).toBe('completed');
  }, 120_000);

  it('reports a database that cannot be read or written instead of pretending the change was saved', async () => {
    const d = await db();
    const s = await startFixtureSite();
    sites.push(s);
    let b = running = await boot(d.url, s.origin);
    // Cannot be read: adding a website (its data is loaded from the database) answers 503, nothing is added.
    await sql(d.url, 'ALTER TABLE sentinel_records RENAME TO sentinel_records_away');
    const r = await b.agent.post('/api/websites').set(b.auth).send({ name: 'grab', url: 'https://grab.example/', platform: 'shopify' });
    expect([r.status, r.body.error.code]).toEqual([503, 'DATABASE_UNAVAILABLE']);
    expect(r.body.error.message).toMatch(/database could not be read/);
    expect((await websitesOf(b)).map((w) => w.domain), 'a website that was not stored is not listed').not.toContain('grab.example');
    await sql(d.url, 'ALTER TABLE sentinel_records_away RENAME TO sentinel_records');

    // Cannot be written: the change answers 503 "not saved yet", System health says so, and it is stored once the
    // database is back (kept in memory meanwhile, retried).
    await sql(d.url, 'ALTER TABLE sentinel_documents RENAME TO sentinel_documents_away');
    const w = await b.agent.patch('/api/websites/site-deodap').set(b.auth).send({ name: 'Renamed store', url: s.url, platform: 'shopify' });
    expect([w.status, w.body.error?.code]).toEqual([503, 'DATABASE_UNAVAILABLE']);
    expect(w.body.error.message).toMatch(/not saved yet/);
    const health = await b.agent.get('/api/system/health').set(b.auth);
    expect(health.body.components.find((c: { id: string }) => c.id === 'storage').status).toBe('down');
    expect(health.body.storage.error).toMatch(/sentinel_documents/);
    expect((await b.agent.get('/api/health')).body.ok).toBe(false);
    await sql(d.url, 'ALTER TABLE sentinel_documents_away RENAME TO sentinel_documents');
    for (let i = 0; i < 40 && !b.persistence.status().connected; i++) await new Promise((res) => setTimeout(res, 250));
    expect(b.persistence.status()).toMatchObject({ connected: true, pending: 0 });
    expect((await b.agent.get('/api/health')).body.ok).toBe(true);
    await b.stop();
    b = running = await boot(d.url, s.origin);
    const cfg = await b.agent.get('/api/config').set(b.auth);
    expect(cfg.body.site.brand).toBe('Renamed store');
  }, 60_000);
});

describe.skipIf(!DB_URL)('database start-up', () => {
  it('fails clearly when the database cannot be reached (no fallback to temporary memory)', async () => {
    const port = await new Promise<number>((res) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => res(p)); }); });
    const badUrl = `postgres://sentinel:secret-not-printed@127.0.0.1:${port}/nothing`;
    const err = await openPersistence({ url: badUrl, log: createLogger('silent'), waitMs: 300 }).then(() => undefined, (e: Error) => e);
    expect(err?.message).toMatch(/Cannot connect to the PostgreSQL database at 127\.0\.0\.1:\d+\/nothing/);
    expect(err?.message).toMatch(/never falls back to temporary memory/);
    expect(err?.message).not.toContain('secret-not-printed');
  });

  it('refuses to run in production without a database unless temporary storage is explicitly allowed', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) };
    expect(() => loadEnv(base)).toThrow(/Set DATABASE_URL/);
    expect(loadEnv({ ...base, DATABASE_URL: 'postgres://u:p@db/x' }).DATABASE_URL).toBeTruthy();
    expect(loadEnv({ ...base, ALLOW_EPHEMERAL_STORAGE: 'true' }).DATABASE_URL).toBeUndefined();
  });

  it('keeps added websites and the sign-in across a real API process restart (SIGTERM)', async () => {
    const { url } = await db();
    const root = path.resolve(__dirname, '../..');
    const port = 41000 + Math.floor(Math.random() * 2000);
    const env = {
      ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: url, SESSION_SECRET: 's'.repeat(40), ADMIN_EMAIL: ADMIN.email,
      ADMIN_INITIAL_PASSWORD: ADMIN.password, SEED_TEST_FIXTURES: 'false', LOG_LEVEL: 'warn', CRAWLER_BASE_URL: 'http://127.0.0.1:9/', SCHEDULER_ENABLED: 'false',
      CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'proc-')),
    };
    const start = async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child; } catch { /* not yet */ }
        if (child.exitCode !== null) throw new Error(`server exited: ${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`server did not start: ${out}`);
    };
    const stop = (child: ReturnType<typeof spawn>) => new Promise<number | null>((res) => { child.once('exit', (c) => res(c)); child.kill('SIGTERM'); });
    const api = (p: string, init: RequestInit = {}, token?: string) => fetch(`http://127.0.0.1:${port}/api${p}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });

    let child = await start();
    const login = await (await api('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json() as { token: string };
    for (const [name, u] of [['grab', 'https://grab.example/'], ['Kitchen store', 'https://kitchen.example/']]) {
      const r = await api('/websites', { method: 'POST', body: JSON.stringify({ name, url: u, platform: 'shopify' }) }, login.token);
      expect(r.status).toBe(201);
    }
    expect(await stop(child)).toBe(0);

    child = await start();
    try {
      // The same token still works (sessions are stored); the browser reloads the list from the server.
      const list = await (await api('/websites', {}, login.token)).json() as WebsiteSummary[];
      expect(list.map((w) => w.domain)).toEqual(['127.0.0.1', 'grab.example', 'kitchen.example']);
      const relogin = await api('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) });
      expect(relogin.status).toBe(200);
    } finally {
      await stop(child);
    }
  }, 90_000);
});
