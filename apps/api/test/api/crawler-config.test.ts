import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { CrawlerStatus } from '@sentinel/shared';
import { CRAWLER_BASE_URL_MISSING, loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { engineReadiness } from '../../src/crawler/engine';
import { createApp } from '../../src/http/app';
import type { CrawlEngine, CrawlPlan } from '../../src/services/ports';

/**
 * Regression: "Live crawling is not available for this website — CRAWLER_BASE_URL is not set".
 * CRAWLER_BASE_URL is the primary website AND the boundary of what its crawler may request. It must come from the
 * server environment; the crawler never falls back to the built-in display default (https://deodap.in).
 * No page is fetched in these tests: the crawl step is a stub (or never reached), so no network is used.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const BASE = { NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'z'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password };
const PROD = { NODE_ENV: 'production', SESSION_SECRET: 'p'.repeat(40), ALLOW_EPHEMERAL_STORAGE: 'true', LOG_LEVEL: 'silent' };

async function harness(env: Record<string, string>, engine?: CrawlEngine) {
  const fetched: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const container = await createContainer({ env: loadEnv({ ...BASE, ...env }), fetchImpl, engine });
  const agent = supertest(createApp(container));
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  return {
    container, fetched,
    get: (p: string) => agent.get(p).set(auth),
    post: (p: string, b: unknown) => agent.post(p).set(auth).send(b as object),
  };
}
const options = (o: Record<string, unknown> = {}) => ({ startUrl: 'https://deodap.in', maxPages: null, maxDepth: null, timeoutMs: 15000, concurrency: 2, requestDelayMs: 250, ...o });

describe('start-up validation of the crawler configuration', () => {
  it('starts in production with live crawling on and no CRAWLER_BASE_URL (registered websites stay crawlable)', () => {
    // CRAWLER_BASE_URL only addresses the primary website; refusing to start would also block every website added under
    // Manage websites, each of which has its own registered URL. The primary website reports the fix instead.
    expect(loadEnv({ ...PROD, CRAWLER_ALLOW_LIVE: 'true' }).CRAWLER_ALLOW_LIVE).toBe(true);
    expect(loadEnv({ ...PROD, CRAWLER_ALLOW_LIVE: 'true', CRAWLER_BASE_URL: 'https://deodap.in' }).CRAWLER_BASE_URL).toBe('https://deodap.in');
    expect(() => loadEnv({ ...PROD })).not.toThrow();
  });

  it('accepts only an http(s) URL without credentials, and trims spaces pasted into a dashboard', () => {
    for (const bad of ['deodap.in', 'ftp://deodap.in', 'https://user:pass@deodap.in', 'javascript:alert(1)']) {
      expect(() => loadEnv({ ...PROD, CRAWLER_ALLOW_LIVE: 'true', CRAWLER_BASE_URL: bad }), bad).toThrow(/Invalid environment configuration: CRAWLER_BASE_URL/);
    }
    expect(loadEnv({ ...PROD, CRAWLER_BASE_URL: '  https://deodap.in  ' }).CRAWLER_BASE_URL).toBe('https://deodap.in');
  });

  it('explains the fix wherever the problem is reported', () => {
    expect(engineReadiness(undefined, true)).toEqual({ ready: false, reason: CRAWLER_BASE_URL_MISSING });
    expect(CRAWLER_BASE_URL_MISSING).toMatch(/CRAWLER_BASE_URL=https:\/\/deodap\.in/);
    expect(CRAWLER_BASE_URL_MISSING).toMatch(/apps\/api\/\.env/);
    expect(CRAWLER_BASE_URL_MISSING).toMatch(/Manage websites/);
  });
});

describe('Crawl Center without CRAWLER_BASE_URL (the reported error)', () => {
  it('reports why crawling is unavailable and refuses to start, without contacting any website', async () => {
    const h = await harness({ CRAWLER_ALLOW_LIVE: 'true' });
    const status = (await h.get('/api/crawls/status')).body as CrawlerStatus;
    expect(status.ready).toBe(false);
    expect(status.reason).toBe(CRAWLER_BASE_URL_MISSING);

    const res = await h.post('/api/crawls', { type: 'full', options: options() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CRAWLER_NOT_READY');
    expect(res.body.error.message).toContain('CRAWLER_BASE_URL is not set');
    // Configuration is reported first, even when other settings are also wrong.
    expect((await h.post('/api/crawls', { type: 'full', options: options({ maxPages: -5 }) })).status).toBe(409);
    expect(await h.container.repos.crawls.count()).toBe(0);
    expect(h.fetched).toEqual([]);
  });
});

describe('Crawl Center with CRAWLER_BASE_URL=https://deodap.in', () => {
  // Real readiness rule; the crawl itself is a stub that records the plan (no requests are made).
  const stub = (env: { base?: string; live: boolean }, seen: { plan?: CrawlPlan }): CrawlEngine => ({
    readiness: () => engineReadiness(env.base, env.live),
    async run(plan) {
      seen.plan = plan;
      return { urls: [], findings: [], evaluatedChecks: [], evaluatedTemplates: {}, pageTexts: [], stats: { urlsPlanned: 0, urlsCrawled: 0, urlsFailed: 0, jsRenderedSample: 0 } };
    },
  });

  it('starts a crawl from the entered start URL, and still refuses other websites', async () => {
    const seen: { plan?: CrawlPlan } = {};
    const h = await harness({ CRAWLER_BASE_URL: 'https://deodap.in', CRAWLER_ALLOW_LIVE: 'true' }, stub({ base: 'https://deodap.in', live: true }, seen));
    const status = (await h.get('/api/crawls/status')).body as CrawlerStatus;
    expect(status).toMatchObject({ ready: true, siteUrl: 'https://deodap.in' });

    const other = await h.post('/api/crawls', { type: 'full', options: options({ startUrl: 'https://example.org/' }) });
    expect(other.status).toBe(400);
    expect(other.body.error.message).toMatch(/deodap\.in/);
    const internal = await h.post('/api/crawls', { type: 'full', options: options({ startUrl: 'http://169.254.169.254/' }) });
    expect(internal.status).toBe(400);

    const ok = await h.post('/api/crawls', { type: 'full', options: options() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await h.container.services.crawls.idle();
    expect(seen.plan).toMatchObject({ type: 'full', startUrl: 'https://deodap.in/', maxPages: Number.POSITIVE_INFINITY, requestDelayMs: 250 });
    expect(seen.plan?.maxDepth).toBeUndefined();
    expect((await h.container.repos.crawls.get(ok.body.id))?.status).toBe('completed');
    // www and non-www are the same website.
    expect((await h.post('/api/crawls', { type: 'full', options: options({ startUrl: 'https://www.deodap.in/collections/all' }) })).status).toBe(200);
    expect(h.fetched).toEqual([]);
  });

  it('still requires CRAWLER_ALLOW_LIVE=true before a live site is crawled', async () => {
    const seen: { plan?: CrawlPlan } = {};
    const h = await harness({ CRAWLER_BASE_URL: 'https://deodap.in' }, stub({ base: 'https://deodap.in', live: false }, seen));
    const res = await h.post('/api/crawls', { type: 'full', options: options() });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/CRAWLER_ALLOW_LIVE/);
    expect(seen.plan).toBeUndefined();
  });
});
