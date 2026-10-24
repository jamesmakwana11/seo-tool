import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { WEBSITE_HEADER, type CrawlBatch, type CrawlRun, type Issue, type Paged, type WebsiteSummary } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { activeChildMemoryMB } from '../../src/gocrawl/engine';
import { slotStats } from '../../src/jobs/crawlSlots';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from '../gocrawl/goHelpers';
import { ADMIN, DB_URL, freshDatabase, startServerProcess, type ServerProcess } from './helpers';

/**
 * Multi-website batches: 11 local fixture websites (127.0.0.2 … 127.0.0.12 — all loopback) crawled with one start.
 * Each gets its own job; only CRAWLER_MAX_CONCURRENT_JOBS run at once, the rest queue and start in order; one website's
 * crawl can be cancelled while it runs or while it is queued without touching the others; results and findings never
 * mix. Memory of the API and every crawler process is sampled while the batch runs.
 */
const sites: FixtureSite[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  for (const s of sites.splice(0)) await s.close();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's own (primary) website on 127.0.0.1 — not part of the batches. */
async function primarySite() { const s = await startFixtureSite(); sites.push(s); return s.origin; }

async function startSites(n: number, first = 2) {
  const list: FixtureSite[] = [];
  for (let i = 0; i < n; i++) {
    const s = await startFixtureSite({ host: `127.0.0.${first + i}` });
    sites.push(s);
    list.push(s);
  }
  return list;
}

async function inMemory(primary: string, extra: Record<string, string>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-batch-'));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'k'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
    CRAWLER_BASE_URL: primary, CRAWLER_ENGINE: 'go', CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0',
    CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'), ...extra,
  });
  const container = await createContainer({ env });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const agent = supertest(app);
  const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  cleanups.push(async () => { container.scheduler.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
  return { container, agent, auth };
}

async function addSites(agent: supertest.Agent | ReturnType<typeof supertest>, auth: Record<string, string>, list: FixtureSite[]) {
  const ids: string[] = [];
  for (const [i, s] of list.entries()) {
    const r = await agent.post('/api/websites').set(auth).send({ name: `Store ${i + 1}`, url: s.url, platform: 'shopify' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push(r.body.id);
  }
  return ids;
}

async function untilFinished(get: () => Promise<CrawlBatch>, onTick?: (b: CrawlBatch) => void, ms = 240_000) {
  const t0 = Date.now();
  for (;;) {
    const b = await get();
    onTick?.(b);
    if (b.finished) return b;
    if (Date.now() - t0 > ms) throw new Error(`batch not finished: ${JSON.stringify(b.counts)}`);
    await sleep(250);
  }
}

describe.skipIf(!HAVE_GO)('crawl batches of up to 11 websites', () => {
  it('starts 11 websites at once: one job each, queued beyond the limit, independent cancel, results never mixed', async () => {
    const list = await startSites(11);
    // Slow enough that the queue is visible: ~22 pages per site, 60 ms apart.
    const { container, agent, auth } = await inMemory(await primarySite(), { CRAWLER_MAX_CONCURRENT_JOBS: '3' });
    cleanups.push(() => Promise.all(sitesOf(container).map((c) => c.services.crawls.idle())));
    const ids = await addSites(agent, auth, list);
    expect(ids.length).toBe(11);

    const started = await agent.post('/api/crawl-batches').set(auth).send({ websiteIds: ids, type: 'full', maxPages: null, requestDelayMs: 60 });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const b0 = started.body as CrawlBatch;
    expect(b0.jobs.length).toBe(11);
    expect(b0.jobs.every((j) => j.runId && !j.error), 'no website dropped').toBe(true);
    expect(b0.counts.running + b0.counts.queued).toBe(11);
    expect(b0.counts.running).toBeLessThanOrEqual(3);
    expect(b0.server.maxRunning).toBe(3);
    const queued = b0.jobs.filter((j) => j.status === 'queued');
    expect(queued.length).toBeGreaterThanOrEqual(8);
    expect(queued.map((j) => j.run?.queue?.position)).toEqual(queued.map((_, i) => i + 1));

    // Cancel one queued website (the last) and one running website; the other nine continue.
    const lastQueued = queued[queued.length - 1];
    const c1 = await agent.post(`/api/crawl-batches/${b0.id}/jobs/${lastQueued.websiteId}/cancel`).set(auth);
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    let runningJob: string | undefined;
    for (let i = 0; i < 40 && !runningJob; i++) {
      const b = (await agent.get(`/api/crawl-batches/${b0.id}`).set(auth)).body as CrawlBatch;
      runningJob = b.jobs.find((j) => j.status === 'running' && (j.run?.urlsCrawled ?? 0) > 2)?.websiteId;
      if (!runningJob) await sleep(150);
    }
    expect(runningJob).toBeDefined();
    const c2 = await agent.post(`/api/crawl-batches/${b0.id}/jobs/${runningJob}/cancel`).set(auth);
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);

    let peakRunning = 0;
    let peakTotalMB = 0;
    const done = await untilFinished(async () => (await agent.get(`/api/crawl-batches/${b0.id}`).set(auth)).body as CrawlBatch, (b) => {
      peakRunning = Math.max(peakRunning, b.counts.running, slotStats().running);
      peakTotalMB = Math.max(peakTotalMB, process.memoryUsage().rss / 1048576 + activeChildMemoryMB());
    });
    expect(peakRunning, 'never more than CRAWLER_MAX_CONCURRENT_JOBS at once').toBeLessThanOrEqual(3);
    expect(peakRunning).toBeGreaterThanOrEqual(2);
    expect(done.counts).toMatchObject({ completed: 9, cancelled: 2, failed: 0, not_started: 0, queued: 0, running: 0 });
    const byId = new Map(done.jobs.map((j) => [j.websiteId, j]));
    expect(byId.get(lastQueued.websiteId)!.run!.error).toMatch(/while it was queued/);
    expect(byId.get(lastQueued.websiteId)!.run!.urlsCrawled).toBe(0);
    expect(byId.get(runningJob!)!.status).toBe('cancelled');
    // eslint-disable-next-line no-console
    console.info(`[batch] 11 sites, limit 3: peak ${peakRunning} running, peak API RSS + crawler processes ${Math.round(peakTotalMB)} MB`);

    // Each website: its own pages and findings only.
    for (const [i, id] of ids.entries()) {
      const j = byId.get(id)!;
      const h = { ...auth, [WEBSITE_HEADER]: id };
      const runs = (await agent.get('/api/crawls').set(h)).body as CrawlRun[];
      expect(runs.map((r) => r.id)).toEqual([j.runId]);
      expect(runs[0].batchId).toBe(b0.id);
      if (j.status !== 'completed') continue;
      const pages = (await agent.get(`/api/crawls/${j.runId}/pages?limit=500`).set(h)).body as { rows: { url: string }[]; total: number };
      expect(pages.total).toBeGreaterThan(15);
      expect(pages.rows.every((p) => p.url.startsWith(list[i].origin)), `pages of ${list[i].origin}`).toBe(true);
      const issues = ((await agent.get('/api/issues?pageSize=500').set(h)).body as Paged<Issue>).items;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.flatMap((x) => x.affectedUrls).every((u) => u.startsWith(list[i].origin)), `findings of ${list[i].origin}`).toBe(true);
    }
    const summaries = (await agent.get('/api/websites').set(auth)).body as WebsiteSummary[];
    expect(summaries.filter((w) => ids.includes(w.id) && w.hasAuditData).length).toBe(9);
    // The primary website was not part of the batch: still no crawl.
    expect(((await agent.get('/api/crawls').set(auth)).body as CrawlRun[]).length).toBe(0);
  }, 300_000);

  it('accepts at most 11 websites, refuses duplicates and unknown ones, and never drops a website silently', async () => {
    const list = await startSites(12, 20);
    const { container, agent, auth } = await inMemory(await primarySite(), {});
    cleanups.push(() => Promise.all(sitesOf(container).map((c) => c.services.crawls.idle())));
    const ids = await addSites(agent, auth, list);
    const twelve = await agent.post('/api/crawl-batches').set(auth).send({ websiteIds: ids, type: 'smart' });
    expect(twelve.status).toBe(400);
    expect(twelve.body.error.message).toMatch(/at most 11 websites/);
    expect((await agent.post('/api/crawl-batches').set(auth).send({ websiteIds: [ids[0], ids[0]], type: 'smart' })).status).toBe(400);
    expect((await agent.post('/api/crawl-batches').set(auth).send({ websiteIds: ['site-nope'], type: 'smart' })).status).toBe(400);
    // A website already crawling is followed, not duplicated; the batch still lists every website.
    const solo = await agent.post('/api/crawls').set({ ...auth, [WEBSITE_HEADER]: ids[0] }).send({ type: 'smart' });
    expect(solo.status).toBe(200);
    const b = (await agent.post('/api/crawl-batches').set(auth).send({ websiteIds: ids.slice(0, 11), type: 'smart' })).body as CrawlBatch;
    expect(b.jobs.length).toBe(11);
    expect(b.jobs[0]).toMatchObject({ runId: solo.body.id, existing: true });
    expect(b.jobs.slice(1).every((j) => j.runId && !j.existing)).toBe(true);
    const all = await agent.post(`/api/crawl-batches/${b.id}/cancel`).set(auth);
    expect(all.status).toBe(200);
    const fin = await untilFinished(async () => (await agent.get(`/api/crawl-batches/${b.id}`).set(auth)).body as CrawlBatch);
    expect(fin.counts.cancelled + fin.counts.completed).toBe(11);
    expect((await agent.get('/api/crawl-batches').set(auth)).body[0].id).toBe(b.id);
  }, 240_000);
});

describe.skipIf(!DB_URL || !HAVE_GO)('crawl batches with PostgreSQL', () => {
  it('stores every queued job: after a real restart (SIGTERM) the queued websites are still queued and then crawled', async () => {
    const d = await freshDatabase();
    cleanups.push(() => d.drop());
    const list = await startSites(5, 40);
    const primary = await primarySite();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-restart-'));
    cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));
    const env = {
      NODE_ENV: 'development', DATABASE_URL: d.url, SESSION_SECRET: 'w'.repeat(40), ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
      SEED_DEMO_DATA: 'false', LOG_LEVEL: 'warn', SCHEDULER_ENABLED: 'false', CRAWLER_BASE_URL: primary, CRAWLER_ENGINE: 'go', CRAWLER_RETRIES: '0',
      CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_MAX_CONCURRENT_JOBS: '1', CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'),
    };
    const port = 47000 + Math.floor(Math.random() * 1500);
    let srv: ServerProcess = await startServerProcess(env, port);
    cleanups.push(() => srv.stop('SIGKILL'));
    const token = ((await (await srv.api('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()) as { token: string }).token;
    const ids: string[] = [];
    for (const [i, s2] of list.entries()) {
      const r = await srv.api('/websites', { method: 'POST', body: JSON.stringify({ name: `Store ${i + 1}`, url: s2.url, platform: 'shopify' }) }, token);
      expect(r.status).toBe(201);
      ids.push(((await r.json()) as { id: string }).id);
    }
    const started = (await (await srv.api('/crawl-batches', { method: 'POST', body: JSON.stringify({ websiteIds: ids, type: 'full', maxPages: null, requestDelayMs: 150 }) }, token)).json()) as CrawlBatch;
    expect(started.counts).toMatchObject({ running: 1, queued: 4 });
    await sleep(1000);
    // A redeploy while one website crawls and four wait: nothing is dropped.
    expect(await srv.stop('SIGTERM')).toBe(0);
    srv = await startServerProcess(env, port);
    const get = async () => (await (await srv.api(`/crawl-batches/${started.id}`, {}, token)).json()) as CrawlBatch;
    const back = await get();
    expect(back.jobs.map((j) => j.runId)).toEqual(started.jobs.map((j) => j.runId));
    expect(back.counts.queued + back.counts.running).toBe(5);
    expect(back.counts.running).toBeLessThanOrEqual(1);
    const fin = await untilFinished(get);
    expect(fin.counts.completed).toBe(5);
    // Only the crawl that was running had to start again; the queued ones were simply queued again.
    expect(fin.jobs.filter((j) => j.run?.resume).length).toBe(1);
    expect(await srv.stop('SIGTERM')).toBe(0);
  }, 300_000);
});

function sitesOf(c: Container): Container[] {
  return [c];
}
