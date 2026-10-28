import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonitorStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createCollector } from '../../src/crawler/engine';
import { createApp } from '../../src/http/app';
import { createMonitorService } from '../../src/monitor/monitor';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';

/**
 * Incremental monitoring against a local fixture store: after one crawl, runs request only what the signals point at
 * (conditional requests, 304 = not parsed), report new pages, SEO changes, errors and resolutions once each, and never
 * re-crawl the site.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function setup(site: FixtureSite) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
  const c: Container = await createContainer({ env: loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'm'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
    CRAWLER_BASE_URL: site.origin, CRAWLER_ENGINE: 'node', CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: path.join(tmp, 'c'), CRAWLER_WORK_DIR: path.join(tmp, 'w'),
  }) });
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const agent = supertest(createApp(c));
  const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  return { c, run: async () => (await agent.post('/api/monitor/run').set(auth)).body as MonitorStatus, get: async () => (await agent.get('/api/monitor').set(auth)).body as MonitorStatus };
}

const pageRequests = (site: FixtureSite, from: number) => site.requests.slice(from).filter((r) => r.path !== '/robots.txt' && !r.path.startsWith('/sitemap'));

describe('incremental monitoring', () => {
  it('checks only changed pages with conditional requests and records each change once', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    const h = await setup(site);
    const run = await h.c.services.crawls.startManual(SYSTEM_ACTOR, 'full', { startUrl: site.url, maxPages: 60, maxDepth: null, timeoutMs: 10000, concurrency: 2 });
    await h.c.services.crawls.idle();
    expect((await h.c.repos.crawls.get(run.id))!.status).toBe('completed');

    // 1st run: baseline (sitemap recorded), no page requests, no events.
    let n = site.requests.length;
    let st = await h.run();
    expect(st.lastRun?.baseline).toBe(true);
    expect(pageRequests(site, n)).toEqual([]);
    expect(st.events).toEqual([]);

    // 2nd run, nothing changed: the sitemap answers 304, nothing else is requested.
    n = site.requests.length;
    st = await h.run();
    expect(st.lastRun).toMatchObject({ sitemapsNotModified: 1, sitemapsFetched: 0, checked: 0, events: 0 });
    expect(site.notModified).toContain('/sitemap.xml');
    expect(pageRequests(site, n)).toEqual([]);

    // Changes on the site: a new page in the sitemap, a product title changed, a product deleted (404).
    site.opts.orphanInSitemap = true;
    site.opts.longTitle = ['/products/vegetable-chopper'];
    site.opts.deletedProducts = ['silicone-spatula-set'];
    // The sitemap only says "new page"; the edits are signalled like Shopify webhooks do (products/update).
    await h.c.services.crawls.markChanged([`${site.origin}/products/vegetable-chopper`, `${site.origin}/products/silicone-spatula-set`]);
    n = site.requests.length;
    st = await h.run();
    const req = pageRequests(site, n).map((r) => r.path).sort();
    expect(req).toEqual(['/pages/wholesale-price-list', '/products/silicone-spatula-set', '/products/vegetable-chopper']); // targeted only
    const kinds = st.events.map((e) => `${e.kind}:${e.field ?? ''}:${new URL(e.url).pathname}`).sort();
    expect(kinds).toEqual([
      'error:status:/products/silicone-spatula-set',
      'new_page::/pages/wholesale-price-list',
      'seo_change:title:/products/vegetable-chopper',
    ]);
    const title = st.events.find((e) => e.kind === 'seo_change')!;
    expect(title.before).toMatch(/Manual Vegetable Chopper/);
    expect(title.after).toMatch(/Buy Wholesale Online in India/);
    expect(title.source).toBe('webhook');
    expect(st.openErrors).toBe(1);

    // Same state again: only the open error is re-checked; no duplicate events.
    n = site.requests.length;
    st = await h.run();
    expect(pageRequests(site, n).map((r) => r.path)).toEqual(['/products/silicone-spatula-set']);
    expect(st.lastRun?.events).toBe(0);
    expect(st.events).toHaveLength(3);

    // The product is restored: resolved once.
    site.opts.deletedProducts = [];
    st = await h.run();
    expect(st.events.filter((e) => e.kind === 'resolved').map((e) => new URL(e.url).pathname)).toEqual(['/products/silicone-spatula-set']);
    expect(st.openErrors).toBe(0);
    st = await h.run();
    expect(st.lastRun).toMatchObject({ checked: 0, events: 0 });
    expect(st.events).toHaveLength(4);

    // An unchanged page that is signalled again answers 304 and is not parsed.
    await h.c.services.crawls.markChanged([`${site.origin}/products/vegetable-chopper`]);
    st = await h.run();
    expect(st.lastRun).toMatchObject({ checked: 1, notModified: 1, events: 0 });
    expect(site.notModified).toContain('/products/vegetable-chopper');
  });

  it('uses the Shopify updated_at signal, and stays within the per-run cap', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    const h = await setup(site);
    const calls: string[] = [];
    const m = createMonitorService(h.c.ctx, {
      collector: createCollector({ baseUrl: site.origin, allowLive: true, allowLoopback: true, userAgent: 'TestBot/1.0', timeoutMs: 5000, concurrency: 1, respectRobots: true, requestDelayMs: 0, retries: 0 } as never),
      userAgent: 'TestBot/1.0', latestRow: async () => undefined, crawlRunning: async () => false, maxChecks: 1, intervalMinutes: 60,
      shopifyChangedSince: async (since) => { calls.push(since); return { urls: [`${site.origin}/products/vegetable-chopper`, `${site.origin}/collections/toys`, 'https://elsewhere.example/products/x'], capped: false }; },
    });
    await m.runNow(); // baseline: no Shopify call yet (no cursor)
    expect(calls).toEqual([]);
    const n = site.requests.length;
    const s = await m.runNow();
    expect(calls).toHaveLength(1);
    expect(s).toMatchObject({ checked: 1, deferred: 1, signals: { shopify: 3 } });
    expect(pageRequests(site, n).map((r) => r.path)).toEqual(['/products/vegetable-chopper']); // other host ignored, cap respected
    // The scheduler tick does nothing until the interval has passed.
    const before = site.requests.length;
    await m.tick();
    expect(site.requests.length).toBe(before);
  });

  it('is skipped while a crawl of the website runs', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    cleanups.push(() => site.close());
    const h = await setup(site);
    await h.c.repos.crawls.insert({ id: 'CRL-9', type: 'full', status: 'running', source: 'live' } as never);
    expect(await h.c.services.monitor.runNow()).toEqual({ skipped: 'a crawl of this website is running' });
  });
});
