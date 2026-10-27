import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrawledUrl, CrawlerStatus } from '@sentinel/shared';
import { CRAWLER_BASE_URL_MISSING, loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { BlockedDestinationError, assertAllowedUrl, registrationBlockReason } from '../../src/crawler/netguard';
import { createApp } from '../../src/http/app';
import type { Workspaces } from '../../src/websites';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from '../gocrawl/goHelpers';

/**
 * Self-hosted live crawling for every registered website (local fixture sites on 127.0.0.x and mocked / injected
 * network only — no real website is contacted):
 * - each website registered under Manage websites is crawled with ITS OWN URL, independently, results never mixed;
 * - Start URLs must be on the selected website (resolved from the server-side website id); unregistered sites and
 *   unknown website ids are refused;
 * - a redirect to another website is refused without requesting that website;
 * - private / internal / metadata addresses stay blocked (registration and crawl time);
 * - CRAWLER_ALLOW_LIVE=true without CRAWLER_BASE_URL no longer blocks the registered websites.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const sites: FixtureSite[] = [];
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const s of sites.splice(0)) await s.close();
});

async function server(env: Record<string, string>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-sites-'));
  const container = await createContainer({ env: loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'w'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
    CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'), ...env,
  }) });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const ws = app.locals.workspaces as Workspaces;
  const agent = supertest(app);
  const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
  const h = (site?: string) => ({ Authorization: `Bearer ${token}`, ...(site ? { 'X-Website-Id': site } : {}) });
  cleanups.push(async () => { for (const e of ws.entries()) { e.container.scheduler.stop(); await e.container.services.crawls.idle(); } fs.rmSync(tmp, { recursive: true, force: true }); });
  return {
    agent, ws,
    get: (p: string, site?: string) => agent.get(p).set(h(site)),
    post: (p: string, body: unknown, site?: string) => agent.post(p).set(h(site)).send(body as object),
    idle: () => Promise.all(ws.entries().map((e) => e.container.services.crawls.idle())),
  };
}
type Server = Awaited<ReturnType<typeof server>>;

const opts = (startUrl: string, o: Record<string, unknown> = {}) => ({ startUrl, maxPages: 40, maxDepth: null, timeoutMs: 15000, concurrency: 2, ...o });

async function rows(s: Server, runId: string, site?: string): Promise<CrawledUrl[]> {
  const r = await s.get(`/api/crawls/${runId}/pages?limit=500`, site);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.rows as CrawledUrl[];
}

describe.each(HAVE_GO ? (['go', 'node'] as const) : (['node'] as const))('registered websites are each crawled with their own URL (%s engine)', (engine) => {
  it('crawls several registered websites independently, never mixing results, and refuses unregistered sites', async () => {
    const primary = await startFixtureSite({ slowMs: 10 });
    const c = await startFixtureSite({ host: '127.0.0.3', slowMs: 10 });
    const b = await startFixtureSite({ host: '127.0.0.2', slowMs: 10, offsiteRedirects: { '/go-to-c': `${c.origin}/` } });
    sites.push(primary, b, c);
    const s = await server({ CRAWLER_BASE_URL: primary.origin, CRAWLER_ENGINE: engine });

    // Added through Manage websites — crawlable at once, no code change, no restart.
    const add = async (name: string, site: FixtureSite) => {
      const r = await s.post('/api/websites', { name, url: site.url, platform: 'shopify' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const bId = await add('Store B', b);
    const cId = await add('Store C', c);

    // Each website's crawler is bound to its own registered URL (resolved from the website id on the server).
    for (const [id, site] of [[undefined, primary], [bId, b], [cId, c]] as const) {
      const st = (await s.get('/api/crawls/status', id)).body as CrawlerStatus;
      expect(st.ready, `${site.origin}: ${st.reason}`).toBe(true);
      expect(st.siteUrl.replace(/\/$/, '')).toBe(site.origin);
    }

    // All three crawls run at the same time.
    const started = await Promise.all([[undefined, primary], [bId, b], [cId, c]].map(async ([id, site]) => {
      const r = await s.post('/api/crawls', { type: 'full', options: opts((site as FixtureSite).url) }, id as string | undefined);
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
      return { id: id as string | undefined, site: site as FixtureSite, runId: r.body.id as string };
    }));
    await s.idle();
    for (const { id, site, runId } of started) {
      const d = (await s.get(`/api/crawls/${runId}`, id)).body;
      expect(d.run.status, `${site.origin}: ${d.run.error ?? ''}`).toBe('completed');
      const list = await rows(s, runId, id);
      expect(list.length).toBeGreaterThan(5);
      // Only this website's pages are in its results.
      for (const u of list) expect(u.url.startsWith(`${site.origin}/`), u.url).toBe(true);
      // Each website has exactly its own crawl; another website cannot read it.
      const mine = (await s.get('/api/crawls', id)).body as { id: string }[];
      expect(mine.map((x) => x.id)).toEqual([runId]);
    }
    for (const site of [primary, b, c]) expect(site.requests.length, site.origin).toBeGreaterThan(5);
    // Run ids are numbered per website (each has its own CRL-0001): the same id read under another website returns that
    // website's own crawl, never Store B's.
    const bRun = started[1].runId;
    const underC = await s.get(`/api/crawls/${bRun}`, cId);
    if (underC.status === 200) expect(underC.body.run.options.startUrl.startsWith(c.origin)).toBe(true);
    for (const u of await rows(s, started[2].runId, cId)) expect(u.url.startsWith(b.origin)).toBe(false);

    // ---- refused: start URL of another (registered or unregistered) website, unknown website id
    const before = { b: b.requests.length, c: c.requests.length };
    const wrong = await s.post('/api/crawls', { type: 'full', options: opts(c.url) }, bId);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/must be on 127\.0\.0\.2/);
    const unregistered = await s.post('/api/crawls', { type: 'full', options: opts('https://unregistered-store.example/') }, bId);
    expect(unregistered.status).toBe(400);
    expect(unregistered.body.error.message).toMatch(/add it under Manage websites/);
    const unknown = await s.post('/api/crawls', { type: 'full', options: opts(b.url) }, 'site-not-registered-example');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('WEBSITE_NOT_FOUND');
    // The engine itself refuses another host too (defence in depth, loopback test sites included).
    const bEngine = s.ws.entries().find((e) => e.website.id === bId)!.container.ctx.engine;
    await expect(bEngine.run({ type: 'full', baseUrl: b.url, startUrl: c.url, maxPages: 5, tierOf: () => 2 })).rejects.toThrow(/only this website's own host/);
    expect(c.requests.length).toBe(before.c);

    // ---- a start URL that redirects to another website: refused, and that website is never requested
    const redirected = await s.post('/api/crawls', { type: 'full', options: opts(`${b.origin}/go-to-c`) }, bId);
    expect(redirected.status).toBeLessThan(300);
    await s.idle();
    const rd = (await s.get(`/api/crawls/${redirected.body.id}`, bId)).body;
    expect(rd.run.status).toBe('failed');
    expect(JSON.stringify(rd.run)).toMatch(/redirects to http:\/\/127\.0\.0\.3:\d+\/, which is a different website/);
    expect(c.requests.length, 'the other website was contacted').toBe(before.c);
    expect(b.requests.length).toBeGreaterThan(before.b);
  });
});

describe('registration: only public website addresses authorize crawling', () => {
  it('refuses private, link-local, metadata, internal and credential URLs (loopback only for local tests)', () => {
    const prod = { allowLoopback: false };
    for (const bad of ['http://10.0.0.5/', 'http://192.168.1.20/', 'http://172.16.4.4/', 'http://169.254.169.254/', 'http://[::1]/', 'http://127.0.0.2:8080/', 'https://metadata.google.internal/', 'https://shop.internal/', 'http://localhost:3000/', 'https://user:pw@shop.example/']) {
      expect(registrationBlockReason(bad, prod), bad).toBeTruthy();
    }
    expect(registrationBlockReason('https://grabnix.in/', prod)).toBeUndefined();
    expect(registrationBlockReason('http://127.0.0.2:8080/', { allowLoopback: true })).toBeUndefined();
    expect(registrationBlockReason('http://169.254.169.254/', { allowLoopback: true })).toMatch(/metadata/);
  });

  it('a registered name that resolves to a private address is still blocked at crawl time', async () => {
    const policy = { allowLoopback: false };
    await expect(assertAllowedUrl('https://grabnix.example/', policy, async () => ['10.1.2.3'])).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(assertAllowedUrl('https://grabnix.example/', policy, async () => ['93.184.216.34', '169.254.169.254'])).rejects.toThrow(/metadata/);
    await expect(assertAllowedUrl('https://grabnix.example/', policy, async () => ['93.184.216.34'])).resolves.toBeUndefined();
  });
});

describe('self-hosted production configuration (no network)', () => {
  const PROD = { NODE_ENV: 'production', ALLOW_EPHEMERAL_STORAGE: 'true', SESSION_SECRET: 'q'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, SEED_WEBSITES: 'none', CRAWLER_ENGINE: 'node' };

  it('CRAWLER_ALLOW_LIVE=true without CRAWLER_BASE_URL: registered websites are crawlable, the primary says what to set', async () => {
    expect(loadEnv(PROD).CRAWLER_ALLOW_LIVE).toBe(false); // off unless explicitly enabled
    const s = await prodServer({ ...PROD, CRAWLER_ALLOW_LIVE: 'true' });
    const primary = (await s.get('/api/crawls/status')).body as CrawlerStatus;
    expect(primary.ready).toBe(false);
    expect(primary.reason).toBe(CRAWLER_BASE_URL_MISSING);

    const g = await s.post('/api/websites', { name: 'Grabnix', url: 'https://grabnix.example/', platform: 'shopify' });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const st = (await s.get('/api/crawls/status', g.body.id)).body as CrawlerStatus;
    expect(st.ready, st.reason).toBe(true);
    expect(st.siteUrl.replace(/\/$/, '')).toBe('https://grabnix.example');
    // The Start URL is checked against THIS website (no request is made for a refused crawl).
    const other = await s.post('/api/crawls', { type: 'full', options: opts('https://deodap.example/') }, g.body.id);
    expect(other.status).toBe(400);
    expect(other.body.error.message).toMatch(/must be on grabnix\.example/);

    // Private / internal / loopback addresses cannot be registered in production.
    for (const url of ['http://10.0.0.5/', 'http://169.254.169.254/', 'http://127.0.0.2:8080/', 'https://metadata.google.internal/', 'http://localhost:3000/']) {
      const r = await s.post('/api/websites', { name: 'Internal', url, platform: 'shopify' });
      expect(r.status, url).toBe(400);
      expect(r.body.error.message, url).toMatch(/cannot be added for crawling/);
    }
  });

  it('live crawling off: every website explains how to switch it on', async () => {
    const s = await prodServer({ ...PROD, CRAWLER_BASE_URL: 'https://deodap.example' });
    const g = await s.post('/api/websites', { name: 'Grabnix', url: 'https://grabnix.example/', platform: 'shopify' });
    for (const id of [undefined, g.body.id as string]) {
      const st = (await s.get('/api/crawls/status', id)).body as CrawlerStatus;
      expect(st.ready).toBe(false);
      expect(st.reason).toMatch(/CRAWLER_ALLOW_LIVE/);
    }
  });

  async function prodServer(env: Record<string, string>) {
    const container = await createContainer({ env: loadEnv(env) });
    const app = createApp(container);
    await (app.locals.ready as () => Promise<void>)();
    const agent = supertest(app);
    const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    const h = (site?: string) => ({ Authorization: `Bearer ${token}`, ...(site ? { 'X-Website-Id': site } : {}) });
    cleanups.push(() => { for (const e of (app.locals.workspaces as Workspaces).entries()) e.container.scheduler.stop(); });
    return {
      get: (p: string, site?: string) => agent.get(p).set(h(site)),
      post: (p: string, body: unknown, site?: string) => agent.post(p).set(h(site)).send(body as object),
    };
  }
});
