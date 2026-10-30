import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrawlPagesResponse, CrawlRun, MonitorStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';

/**
 * Website sync (Sync Now / Auto Sync) against a local fixture store: after one full crawl, a sync finds new products,
 * new collections, edited and removed pages from the sitemap, sitemap dates and content fingerprints (ETag /
 * Last-Modified answered 304 where possible), crawls only those URLs, merges them into the stored results (the other
 * pages keep their rows, the first crawl is kept as history), updates the issues of the fetched pages only, and runs
 * by itself every 12 hours when Auto Sync is on.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup(site: FixtureSite, clock?: () => Date, extraEnv: Record<string, string> = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  const c: Container = await createContainer({
    env: loadEnv({
      NODE_ENV: 'test', SESSION_SECRET: 'm'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
      CRAWLER_BASE_URL: site.origin, CRAWLER_ENGINE: 'node', SCHEDULER_ENABLED: 'true', ...extraEnv, CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: path.join(tmp, 'c'), CRAWLER_WORK_DIR: path.join(tmp, 'w'),
    }),
    ...(clock ? { clock } : {}),
  });
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const agent = supertest(createApp(c));
  const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    c,
    syncNow: async () => { const r = await agent.post('/api/monitor/run').set(auth); return { status: r.status, body: r.body as MonitorStatus & { error?: { code: string; message: string } } }; },
    get: async () => { await c.services.crawls.idle(); return (await agent.get('/api/monitor').set(auth)).body as MonitorStatus; },
    settings: async (autoSync: boolean) => (await agent.patch('/api/monitor/settings').set(auth).send({ autoSync })).body as MonitorStatus,
    pages: async (runId: string, q = '') => (await agent.get(`/api/crawls/${runId}/pages?limit=200${q}`).set(auth)).body as CrawlPagesResponse,
  };
}
import { createApp } from '../../src/http/app';


async function fullCrawl(c: Container, site: FixtureSite): Promise<CrawlRun> {
  const run = await c.services.crawls.startManual(SYSTEM_ACTOR, 'full', { startUrl: site.url, maxPages: 100, maxDepth: null, timeoutMs: 10000, concurrency: 2 });
  await c.services.crawls.idle();
  const done = (await c.repos.crawls.get(run.id))!;
  expect(done.status).toBe('completed');
  return done;
}

describe('website sync', () => {
  it('needs a first Full or Smart crawl', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    const h = await setup(site);
    const r = await h.syncNow();
    expect(r.status).toBe(409);
    expect(r.body.error!.code).toBe('NO_BASELINE_CRAWL');
  });

  it('says when Auto Sync cannot run because the server scheduler is off', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    const h = await setup(site, undefined, { SCHEDULER_ENABLED: 'false' });
    await fullCrawl(h.c, site);
    const st = await h.get();
    expect(st.sync).toMatchObject({ autoSync: true, schedulerOff: true });
    expect(st.sync.nextSyncAt).toBeUndefined();
    // Sync Now still works.
    expect((await h.syncNow()).body.lastSync!.state).toBe('no_changes');
  });

  it('finds new products and collections, edited and removed pages, crawls only those and merges them into the results', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    const h = await setup(site);
    const base = await fullCrawl(h.c, site);
    const basePages = await h.pages(base.id);

    // 1st sync, nothing changed: no crawl; stored pages are content-checked and match.
    let st = (await h.syncNow()).body;
    expect(st.lastSync).toMatchObject({ state: 'no_changes', baseRunId: base.id, crawled: 0 });
    expect(st.lastSync!.checked).toBeGreaterThan(5);
    expect(st.lastSync!.unchanged).toBe(st.lastSync!.checked);
    // 2nd sync: the same pages answer 304 Not Modified to their stored ETags (nothing downloaded or parsed).
    const n0 = site.notModified.length;
    st = (await h.syncNow()).body;
    expect(st.lastSync!.state).toBe('no_changes');
    const pages304 = site.notModified.slice(n0).filter((p) => !p.includes('sitemap'));
    expect(pages304.length).toBe(st.lastSync!.checked);
    expect(st.lastSync!.sitemapsNotModified).toBeGreaterThan(0);

    // The store changes: a new product, a new collection, an edited product (new sitemap date), a deleted product.
    site.opts.newProducts = ['steel-water-bottle'];
    site.opts.newCollections = ['garden-tools'];
    site.opts.longTitle = ['/products/vegetable-chopper'];
    site.opts.lastmod = { '/products/vegetable-chopper': '2030-01-01' };
    site.opts.deletedProducts = ['silicone-spatula-set'];
    st = (await h.syncNow()).body;
    expect(st.lastSync!.state).toBe('crawling');
    expect(st.lastSync!.reasons.new_in_sitemap).toBe(2);
    expect(st.lastSync!.reasons.lastmod).toBeGreaterThanOrEqual(1);
    st = await h.get();
    const sync = st.history[0];
    expect(sync.state, sync.message).toBe('done');
    const run = (await h.c.repos.crawls.get(sync.crawlRunId!))!;
    expect(run).toMatchObject({ type: 'sync', status: 'completed', sync: { baseRunId: base.id } });
    // The new and edited pages, the deleted product, and the collection pages whose product grid changed.
    expect(run.sync!.fetched).toBeLessThanOrEqual(12);

    // The results: every page of the first crawl plus the new ones; changed rows updated, the rest kept.
    const merged = await h.pages(run.id);
    // New rows: the product, the collection, the product's collection-scoped URL and the new collection's sort link.
    const added = merged.rows.filter((x) => !basePages.rows.some((b) => b.url === x.url)).map((x) => new URL(x.url).pathname + new URL(x.url).search);
    expect(added).toEqual(expect.arrayContaining(['/products/steel-water-bottle', '/collections/garden-tools', '/collections/kitchen-tools/products/steel-water-bottle']));
    expect(added.length).toBeLessThanOrEqual(4);
    expect(merged.total).toBe(basePages.total + added.length);
    // Only the targeted pages were crawled — never the whole site again (unchanged pages answer the check with 304).
    const crawled = new Set(merged.rows.filter((x) => x.reason === 'sync').map((x) => new URL(x.url).pathname));
    for (const p of ['/products/steel-water-bottle', '/collections/garden-tools', '/products/vegetable-chopper', '/products/silicone-spatula-set']) expect(crawled.has(p), p).toBe(true);
    expect(crawled.size).toBeLessThan(basePages.total / 2);
    const row = (p: string) => merged.rows.find((x) => new URL(x.url).pathname === p);
    expect(row('/products/steel-water-bottle')?.status).toBe(200);
    expect(row('/collections/garden-tools')?.status).toBe(200);
    expect(row('/products/vegetable-chopper')!.title!.length).toBeGreaterThan(60);
    expect(row('/products/silicone-spatula-set')!.status).toBe(404);
    const untouched = basePages.rows.find((x) => new URL(x.url).pathname === '/pages/about-us')!;
    expect(row('/pages/about-us')).toMatchObject({ title: untouched.title, status: untouched.status });
    // History: the first crawl is unchanged and still listed.
    expect((await h.pages(base.id)).total).toBe(basePages.total);

    // Issues: the edited title is now a finding; issues on pages not fetched keep their URLs.
    const issues = await h.c.repos.issues.list();
    expect(issues.some((i) => i.checkId === 'ONP-TITLE' && i.affectedUrls.some((u) => u.endsWith('/products/vegetable-chopper')) && i.status !== 'VERIFIED')).toBe(true);

    // Nothing changed since: the next sync finds nothing to crawl (no duplicate processing).
    st = (await h.syncNow()).body;
    expect(st.lastSync!.state).toBe('no_changes');

    // The title is fixed: the next sync re-crawls that page only and the issue no longer lists it.
    site.opts.longTitle = [];
    st = (await h.syncNow()).body;
    expect(st.lastSync!.state).toBe('crawling');
    st = await h.get();
    expect(st.history[0].state).toBe('done');
    expect(st.history[0].crawled).toBeLessThanOrEqual(3);
    const after = await h.c.repos.issues.list();
    expect(after.some((i) => i.checkId === 'ONP-TITLE' && i.status !== 'VERIFIED' && i.affectedUrls.some((u) => u.endsWith('/products/vegetable-chopper')))).toBe(false);
    const latest = await h.pages(st.history[0].crawlRunId!);
    expect(latest.total).toBe(merged.total);
  }, 60_000);

  it('runs every 12 hours when Auto Sync is on, can be turned off, and shows the last and next sync', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    let now = Date.parse('2026-11-01T00:00:00Z');
    const h = await setup(site, () => new Date(now));
    await fullCrawl(h.c, site);
    let st = await h.get();
    expect(st.sync.autoSync).toBe(true);
    expect(st.sync.intervalHours).toBe(12);
    expect(Date.parse(st.sync.nextSyncAt!) - Date.parse(st.sync.baseline!.at!)).toBe(12 * 3600_000);
    // Not due yet: the scheduler tick does nothing.
    await h.c.services.monitor.tick();
    expect((await h.get()).lastSync).toBeUndefined();
    // Due: it runs by itself.
    now += 12 * 3600_000 + 60_000;
    site.opts.newProducts = ['bamboo-cutting-board'];
    await h.c.services.monitor.tick();
    st = await h.get();
    expect(st.history[0]).toMatchObject({ trigger: 'auto', state: 'done' });
    expect(st.sync.lastSyncAt).toBe(new Date(now).toISOString());
    expect(st.sync.nextSyncAt).toBe(new Date(now + 12 * 3600_000).toISOString());
    // Turned off: never runs, even when due.
    st = await h.settings(false);
    expect(st.sync.autoSync).toBe(false);
    expect(st.sync.nextSyncAt).toBeUndefined();
    now += 24 * 3600_000;
    site.opts.newProducts = ['bamboo-cutting-board', 'glass-jar-set'];
    await h.c.services.monitor.tick();
    expect((await h.get()).history).toHaveLength(1);
    // Back on: due 12 hours later.
    st = await h.settings(true);
    expect(st.sync.autoSync).toBe(true);
  }, 60_000);
});
