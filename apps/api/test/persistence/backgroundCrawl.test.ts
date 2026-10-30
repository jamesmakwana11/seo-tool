import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WEBSITE_HEADER, type CrawlRun } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { startKeepAwake } from '../../src/jobs/keepAwake';
import { createLogger } from '../../src/lib/logger';
import { busyCrawlJobs } from '../../src/services/crawls';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from '../gocrawl/goHelpers';
import { ADMIN, DB_URL, boot, freshDatabase, sql, startServerProcess, waitForCrawl, type Booted, type ServerProcess } from './helpers';

/**
 * Crawls are server-side background jobs: the browser that started one can disconnect, refresh, close or come back from
 * another browser without stopping, duplicating or losing it; only an explicit cancel stops it; a server restart starts
 * an interrupted crawl again from its stored settings. Local fixture websites only (127.0.0.1).
 */
const PRIMARY = 'site-deodap';
const sites: FixtureSite[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  for (const s of sites.splice(0)) await s.close();
});

async function fixture() { const s = await startFixtureSite(); sites.push(s); return s; }
/** A slow live crawl of the fixture (~22 pages, one at a time, 400 ms apart: about 10 s). */
const slowOptions = (origin: string) => ({ startUrl: `${origin}/`, maxPages: null, maxDepth: null, timeoutMs: 5000, concurrency: 1, requestDelayMs: 400 });
const pageRequests = (s: FixtureSite) => s.requests.filter((r) => !r.path.startsWith('/robots.txt') && !r.path.includes('sitemap')).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The API listening on a real port without a database (temporary storage), like `npm run dev:api`. */
async function listen(origin: string): Promise<{ base: string; container: Container; login: () => Promise<string> }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-bg-'));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'b'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
    CRAWLER_BASE_URL: origin, CRAWLER_ENGINE: 'go', CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0',
    CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'),
  });
  const container = await createContainer({ env });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    await container.services.crawls.idle();
    container.scheduler.stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // Each login is a separate session — like a second browser.
  const login = async () => ((await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) })).json()) as { token: string }).token;
  return { base, container, login };
}
const call = (base: string, token: string, p: string, init: RequestInit = {}) =>
  fetch(`${base}/api${p}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, [WEBSITE_HEADER]: PRIMARY } });
const runOf = async (base: string, token: string, id: string) => ((await (await call(base, token, `/crawls/${id}`)).json()) as { run: CrawlRun }).run;
async function untilDone(base: string, token: string, id: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const run = await runOf(base, token, id);
    if (run.status !== 'running' && run.status !== 'queued') return run;
    if (Date.now() - t0 > timeoutMs) throw new Error(`crawl ${id} did not finish`);
    await sleep(200);
  }
}

describe.skipIf(!HAVE_GO)('crawls run as server-side background jobs', () => {
  it('keeps running when the browser that started it disconnects; another browser sees the same job and its progress', async () => {
    const s = await fixture();
    const { base, login } = await listen(s.origin);
    const first = await login();

    // The browser sends "Start crawl" and is closed at once: the connection is destroyed before the answer arrives.
    await new Promise<void>((resolve) => {
      const u = new URL(`${base}/api/crawls`);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first}`, [WEBSITE_HEADER]: PRIMARY } });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.end(JSON.stringify({ type: 'full', options: slowOptions(s.origin) }), () => req.destroy());
    });

    // Another browser (a new sign-in) reconnects: it finds that crawl running, with progress moving on.
    const second = await login();
    let run: CrawlRun | undefined;
    for (let i = 0; i < 50 && !run; i++) {
      run = ((await (await call(base, second, '/crawls')).json()) as CrawlRun[]).find((r) => r.status === 'running' || r.status === 'queued');
      if (!run) await sleep(100);
    }
    expect(run, 'the crawl was started although the browser disconnected').toBeDefined();
    expect(busyCrawlJobs()).toBeGreaterThan(0);
    await sleep(1500);
    const mid = await runOf(base, second, run!.id);
    expect(mid.status).toBe('running');
    const seenMid = mid.urlsCrawled;
    await sleep(1500);
    const later = await runOf(base, second, run!.id);
    expect(later.urlsCrawled, 'progress continues with nobody connected to the start request').toBeGreaterThan(seenMid);
    expect(later.urlsDiscovered).toBeGreaterThan(0);
    expect(later.coverage, 'queued / active / not-processed accounting is reported').toBeDefined();

    // Nobody watches for a while (laptop closed): the crawl still completes on the server.
    const done = await untilDone(base, second, run!.id);
    expect([done.status, done.outcome]).toEqual(['completed', 'completed']);
    expect(done.urlsCrawled).toBeGreaterThanOrEqual(20);
    expect(((await (await call(base, first, '/crawls')).json()) as CrawlRun[]).length, 'exactly one crawl').toBe(1);
  }, 90_000);

  it('never starts a duplicate: repeated or simultaneous Start requests return the running crawl instead', async () => {
    const s = await fixture();
    const { base, login } = await listen(s.origin);
    const a = await login();
    const b = await login();
    // A double click in one browser plus a click in another, at the same moment.
    const answers = await Promise.all([a, a, a, b, b].map((t) => call(base, t, '/crawls', { method: 'POST', body: JSON.stringify({ type: 'full', options: slowOptions(s.origin) }) })));
    const ok = answers.filter((r) => r.status === 200);
    const dup = answers.filter((r) => r.status === 409);
    expect(ok.length).toBe(1);
    expect(dup.length).toBe(4);
    const started = (await ok[0].json()) as CrawlRun;
    for (const r of dup) {
      const body = (await r.json()) as { error: { code: string; details?: { runId?: string } } };
      expect(body.error.code).toBe('CRAWL_ALREADY_RUNNING');
      if (body.error.details?.runId) expect(body.error.details.runId).toBe(started.id);
    }
    // Refreshing the page only reads: still one crawl.
    for (let i = 0; i < 3; i++) await call(base, b, '/crawls');
    const again = await call(base, b, '/crawls', { method: 'POST', body: JSON.stringify({ type: 'smart' }) });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { details: { runId: string } } }).error.details.runId).toBe(started.id);
    const list = (await (await call(base, a, '/crawls')).json()) as CrawlRun[];
    expect(list.map((r) => r.id)).toEqual([started.id]);
    await call(base, a, `/crawls/${started.id}/cancel`, { method: 'POST' });
  }, 60_000);

  it('stops only on an explicit cancel, which stops its workers and requests', async () => {
    const s = await fixture();
    const { base, login, container } = await listen(s.origin);
    const a = await login();
    const started = (await (await call(base, a, '/crawls', { method: 'POST', body: JSON.stringify({ type: 'full', options: slowOptions(s.origin) }) })).json()) as CrawlRun;
    await sleep(1800);
    // Cancelled from another browser.
    const res = await call(base, await login(), `/crawls/${started.id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    const cancelled = (await res.json()) as CrawlRun;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toMatch(/Cancelled by/);
    const atCancel = pageRequests(s);
    expect(atCancel).toBeGreaterThan(0);
    await container.services.crawls.idle();
    expect(busyCrawlJobs()).toBe(0);
    await sleep(1500);
    expect(pageRequests(s), 'no request after the cancel was confirmed').toBe(atCancel);
    expect((await call(base, a, `/crawls/${started.id}/cancel`, { method: 'POST' })).status).toBe(409);
  }, 60_000);
});

describe('keep-awake while crawls run', () => {
  it('requests the server\'s own /healthz only while a crawl is busy, and nothing without an address', async () => {
    let hits = 0;
    const srv = http.createServer((req, res) => { if (req.url === '/healthz') hits++; res.end('ok'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise((r) => srv.close(r)));
    let busy = false;
    const k = startKeepAwake({ enabled: true, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, intervalMs: 60_000, busy: () => busy, log: createLogger('silent') });
    cleanups.push(async () => k.stop());
    expect(await k.tick()).toBe(false);
    expect(hits).toBe(0);
    busy = true;
    expect(await k.tick()).toBe(true);
    expect(hits).toBe(1);
    busy = false;
    await k.tick();
    expect(hits).toBe(1);
    expect(startKeepAwake({ enabled: true, url: undefined, intervalMs: 1000, busy: () => true, log: createLogger('silent') }).enabled).toBe(false);
    expect(startKeepAwake({ enabled: false, url: 'http://127.0.0.1:9/', intervalMs: 1000, busy: () => true, log: createLogger('silent') }).enabled).toBe(false);
  });
});

describe.skipIf(!DB_URL || !HAVE_GO)('crawls interrupted by a server restart (PostgreSQL)', () => {
  const dbs: { drop: () => Promise<void> }[] = [];
  afterAll(async () => { for (const d of dbs) await d.drop().catch(() => undefined); });
  async function db() { const d = await freshDatabase(); dbs.push(d); return d; }

  const serverEnv = (url: string, origin: string, tmp: string) => ({
    NODE_ENV: 'development', DATABASE_URL: url, SESSION_SECRET: 'r'.repeat(40), ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
    SEED_TEST_FIXTURES: 'false', LOG_LEVEL: 'warn', SCHEDULER_ENABLED: 'false', CRAWLER_BASE_URL: origin, CRAWLER_ENGINE: 'go', CRAWLER_RETRIES: '0',
    CRAWLER_REQUEST_DELAY_MS: '0', CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'),
  });
  const storedRun = async (url: string, id: string) => (await sql(url, `SELECT doc FROM sentinel_records WHERE website_id = $1 AND collection = 'crawls' AND id = $2`, [PRIMARY, id])).rows[0]?.doc as CrawlRun | undefined;

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`a crawl cut off by a ${signal === 'SIGTERM' ? 'redeploy / restart (SIGTERM)' : 'crash (SIGKILL)'} is started again with the same settings and completes`, async () => {
      const { url } = await db();
      const s = await fixture();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-restart-'));
      cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));
      const port = 43000 + Math.floor(Math.random() * 2000);
      let srv: ServerProcess = await startServerProcess(serverEnv(url, s.origin, tmp), port);
      cleanups.push(() => srv.stop('SIGKILL'));
      const token = ((await (await srv.api('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()) as { token: string }).token;
      const options = slowOptions(s.origin);
      const start = await srv.api('/crawls', { method: 'POST', body: JSON.stringify({ type: 'full', options }) }, token);
      expect(start.status, await start.clone().text()).toBe(200);
      const id = ((await start.json()) as CrawlRun).id;
      for (let i = 0; i < 100; i++) {
        const r = ((await (await srv.api(`/crawls/${id}`, {}, token)).json()) as { run: CrawlRun }).run;
        if (r.urlsCrawled >= 3) break;
        await sleep(200);
      }
      await srv.stop(signal);

      // While the server is down the job is stored as running — never completed, cancelled or failed by the shutdown.
      const down = await storedRun(url, id);
      expect(down?.status).toBe('running');
      const pagesBefore = down!.urlsCrawled;

      srv = await startServerProcess(serverEnv(url, s.origin, tmp), port);
      // The same sign-in (another browser would sign in again) finds the same crawl, started again.
      const back = ((await (await srv.api(`/crawls/${id}`, {}, token)).json()) as { run: CrawlRun }).run;
      expect(['queued', 'running']).toContain(back.status);
      expect(back.resume?.attempts).toBe(1);
      expect(back.resume?.pagesBeforeRestart).toBe(pagesBefore);
      expect(back.options).toEqual(options);
      expect(back.warnings?.some((w) => w.code === 'resumed')).toBe(true);
      // No second crawl was created, and a Start click now is refused as a duplicate.
      expect(((await (await srv.api('/crawls', {}, token)).json()) as CrawlRun[]).map((r) => r.id)).toEqual([id]);
      expect((await srv.api('/crawls', { method: 'POST', body: JSON.stringify({ type: 'full', options }) }, token)).status).toBe(409);

      let done: CrawlRun | undefined;
      for (let i = 0; i < 300 && !done; i++) {
        const r = ((await (await srv.api(`/crawls/${id}`, {}, token)).json()) as { run: CrawlRun }).run;
        if (r.status !== 'running' && r.status !== 'queued') done = r;
        else await sleep(200);
      }
      expect([done?.status, done?.outcome]).toEqual(['completed', 'completed']);
      expect(done!.urlsCrawled).toBeGreaterThanOrEqual(20);
      expect(done!.resume?.attempts).toBe(1);
      const issues = (await (await srv.api('/issues?pageSize=500', {}, token)).json()) as { items: unknown[] };
      expect(issues.items.length).toBeGreaterThan(0);
      expect(await srv.stop('SIGTERM')).toBe(0);
    }, 150_000);
  }

  it('a crawl interrupted more often than allowed, or with restarting turned off, is marked failed with the reason — never completed', async () => {
    const { url } = await db();
    const s = await fixture();
    let b: Booted = await boot(url, s.origin);
    cleanups.push(() => b.stop());
    const done = await waitForCrawl(b, PRIMARY, (await b.agent.post('/api/crawls').set(b.auth).send({ type: 'full' })).body.id) as CrawlRun;
    const stale = (id: string, attempts?: number): CrawlRun => ({ ...done, id, status: 'running', outcome: undefined, finishedAt: undefined, ...(attempts ? { resume: { attempts, lastAt: done.startedAt!, pagesBeforeRestart: 5 } } : {}) });
    await b.container.repos.crawls.insert(stale('CRL-0098', 2));
    await b.persistence.flush();
    await b.stop();
    b = await boot(url, s.origin);
    const r98 = (await b.agent.get('/api/crawls/CRL-0098').set(b.auth)).body.run as CrawlRun;
    expect([r98.status, r98.outcome]).toEqual(['failed', 'failed']);
    expect(r98.error).toMatch(/server restarted.*already been restarted 2 times/);

    await b.container.repos.crawls.insert(stale('CRL-0099'));
    await b.persistence.flush();
    await b.stop();
    b = await boot(url, s.origin, { CRAWLER_RESUME_INTERRUPTED: 'false' });
    const r99 = (await b.agent.get('/api/crawls/CRL-0099').set(b.auth)).body.run as CrawlRun;
    expect([r99.status, r99.outcome]).toEqual(['failed', 'failed']);
    expect(r99.error).toMatch(/automatic restart is turned off/);
    // Neither blocks the next crawl.
    const next = await b.agent.post('/api/crawls').set(b.auth).send({ type: 'full' });
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect((await waitForCrawl(b, PRIMARY, next.body.id) as CrawlRun).outcome).toBe('completed');
  }, 120_000);

  it('a restarted crawl can be cancelled explicitly', async () => {
    const { url } = await db();
    const s = await fixture();
    let b: Booted = await boot(url, s.origin);
    cleanups.push(() => b.stop());
    const started = await b.agent.post('/api/crawls').set(b.auth).send({ type: 'full', options: slowOptions(s.origin) });
    expect(started.status).toBe(200);
    await b.agent.post(`/api/crawls/${started.body.id}/cancel`).set(b.auth);
    // As if the server had died while it ran: stored as running.
    const run = (await b.agent.get(`/api/crawls/${started.body.id}`).set(b.auth)).body.run as CrawlRun;
    await b.container.repos.crawls.insert({ ...run, id: 'CRL-0050', status: 'running', outcome: undefined, error: undefined, finishedAt: undefined, cancelledBy: undefined });
    await b.persistence.flush();
    await b.stop();
    b = await boot(url, s.origin);
    expect(((await b.agent.get('/api/crawls/CRL-0050').set(b.auth)).body.run as CrawlRun).resume?.attempts).toBe(1);
    await sleep(800);
    const res = await b.agent.post('/api/crawls/CRL-0050/cancel').set(b.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('cancelled');
  }, 120_000);
});
