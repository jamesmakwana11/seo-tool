import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CrawlDetail, CrawlRun } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { startFixtureSite, type FixtureOptions, type FixtureSite } from '../crawler/fixtureSite';

/**
 * Crawl Center live crawl, end to end over HTTP against a real loopback fixture store:
 * validation, limits, progress, page details, issues, cancellation, export, SSRF and error handling.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const sites: FixtureSite[] = [];
const containers: Container[] = [];
afterEach(async () => {
  for (const c of containers.splice(0)) await c.services.crawls.idle();
  for (const s of sites.splice(0)) await s.close();
});

async function harness(fixture: Partial<FixtureOptions> = {}, env: Record<string, string> = {}) {
  const site = await startFixtureSite(fixture);
  sites.push(site);
  const container = await createContainer({
    env: loadEnv({
      NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'z'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: site.origin,
      CRAWLER_REQUEST_DELAY_MS: '0', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, ...env,
    }),
  });
  containers.push(container);
  const agent = supertest(createApp(container));
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  const api = {
    get: (p: string) => agent.get(p).set(auth),
    post: (p: string, b: unknown = {}) => agent.post(p).set(auth).send(b as object),
  };
  const options = (o: Record<string, unknown> = {}) => ({ startUrl: `${site.origin}/`, maxPages: 40, maxDepth: 3, timeoutMs: 5000, concurrency: 3, ...o });
  const crawl = async (o: Record<string, unknown> = {}) => {
    const res = await api.post('/api/crawls', { type: 'full', options: options(o) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await container.services.crawls.idle();
    return (await api.get(`/api/crawls/${res.body.id}`)).body as CrawlDetail;
  };
  return { site, container, api, options, crawl };
}

describe('crawler status', () => {
  it('reports readiness, the site URL, limits and that storage is temporary', async () => {
    const h = await harness();
    const s = (await h.api.get('/api/crawls/status')).body;
    expect(s).toMatchObject({ ready: true, siteUrl: h.site.origin, temporaryStorage: true, schedulerEnabled: false, respectsRobots: true, maxPagesCap: null });
  });
});

describe('validation', () => {
  it('refuses a start URL on another host, out-of-range limits and settings on a non-live crawl', async () => {
    const h = await harness();
    const other = await h.api.post('/api/crawls', { type: 'full', options: h.options({ startUrl: 'https://example.org/' }) });
    expect(other.status).toBe(400);
    expect(other.body.error.details.fields.startUrl).toMatch(/must be on/);
    const bad = await h.api.post('/api/crawls', { type: 'full', options: h.options({ maxPages: 0, maxDepth: -1, timeoutMs: 100, concurrency: 50 }) });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields).sort()).toEqual(['concurrency', 'maxDepth', 'maxPages', 'timeoutMs']);
    const notUrl = await h.api.post('/api/crawls', { type: 'full', options: h.options({ startUrl: 'javascript:alert(1)' }) });
    expect(notUrl.status).toBe(400);
    const smart = await h.api.post('/api/crawls', { type: 'smart', options: h.options() });
    expect(smart.status).toBe(400);
  });

  it('has no page limit by default; an optional CRAWLER_MAX_PAGES cap is enforced when set', async () => {
    const open = await harness();
    expect((await open.api.get('/api/crawls/status')).body.maxPagesCap).toBeNull();
    const h = await harness({}, { CRAWLER_MAX_PAGES: '25' });
    const res = await h.api.post('/api/crawls', { type: 'full', options: h.options({ maxPages: 26 }) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.maxPages).toMatch(/limits a crawl to 25 pages/);
    const all = await h.api.post('/api/crawls', { type: 'full', options: h.options({ maxPages: null }) });
    expect(all.status).toBe(400);
  });

  it('refuses to crawl live in a workspace that holds the test fixtures', async () => {
    const h = await harness({}, { SEED_TEST_FIXTURES: 'true' });
    const login = await supertest(createApp(h.container)).post('/api/auth/login').send({ email: 'aarav.admin@team.deodap.local', password: 'Sentinel@Fixture1' });
    const res = await supertest(createApp(h.container)).get('/api/crawls/status').set({ Authorization: `Bearer ${login.body.token}` });
    expect(res.body.ready).toBe(false);
    expect(res.body.reason).toMatch(/sample test dataset/);
  });
});

describe('a live crawl', () => {
  it('discovers pages from links and the sitemap, records page details and real issues, and stays within limits', async () => {
    const h = await harness({ missingMeta: ['/pages/about'], multipleH1: ['/pages/about'], noindex: ['/pages/contact'] });
    const d = await h.crawl({ maxPages: 30 });
    expect(d.run.status).toBe('completed');
    expect(d.run.options?.maxPages).toBe(30);
    expect(d.run.urlsCrawled).toBeGreaterThan(5);
    expect(d.run.urlsCrawled).toBeLessThanOrEqual(30);
    expect(d.run.urlsDiscovered).toBeGreaterThanOrEqual(d.run.urlsCrawled);
    expect(d.run.urlsSucceeded).toBeGreaterThan(0);
    const home = d.urls.find((u) => u.url === `${h.site.origin}/`)!;
    expect(home).toMatchObject({ status: 200, depth: 0, indexable: true });
    expect(home.title).toBeTruthy();
    expect(home.h1?.length).toBeGreaterThan(0);
    expect(home.internalLinks).toBeGreaterThan(0);
    const contact = d.urls.find((u) => u.url.endsWith('/pages/contact'));
    if (contact) expect(contact).toMatchObject({ indexable: false, indexabilityReason: 'noindex in meta robots' });
    // Findings became tracked issues (severity + Fix Card) and are attached to the pages they affect.
    const withIssues = d.urls.filter((u) => u.issues?.length);
    expect(withIssues.length).toBeGreaterThan(0);
    const issue = withIssues[0].issues![0];
    expect(issue.id).toMatch(/^ISS-/);
    expect(['critical', 'medium', 'low']).toContain(issue.severity);
    const detail = await h.api.get(`/api/issues/${issue.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.fixCard).toBeTruthy();
  });

  it('"All pages" (no page or depth limit) crawls every distinct page of the site, once', async () => {
    const h = await harness({ orphanInSitemap: true });
    const d = await h.crawl({ maxPages: null, maxDepth: null });
    expect(d.run.status).toBe('completed');
    expect(d.run.options).toMatchObject({ maxPages: null, maxDepth: null });
    // Every HTML page the fixture serves was fetched — including the sitemap-only orphan — and each URL only once.
    const fetched = new Set(d.urls.filter((u) => !u.redirectedFrom).map((u) => u.url));
    expect(fetched.size).toBe(d.urls.filter((u) => !u.redirectedFrom).length);
    // Nothing was left behind: every sitemap URL was crawled, including the orphan no link points to.
    expect(d.sitemapDiff?.inSitemapNotCrawled).toEqual([]);
    expect(d.urls.some((u) => u.url.endsWith('/pages/wholesale-price-list') && u.reason === 'sitemap')).toBe(true);
    // Everything planned was either fetched or skipped because robots.txt disallows it.
    expect(d.run.urlsCrawled + d.urls.filter((u) => u.skippedByRobots).length).toBe(d.run.urlsPlanned);
    // A capped crawl of the same site stops earlier: the limit, not the site, ended it.
    const capped = await h.crawl({ maxPages: 10 });
    expect(capped.run.urlsCrawled).toBeLessThanOrEqual(10);
    expect(d.run.urlsCrawled).toBeGreaterThan(capped.run.urlsCrawled);
  });

  it('respects maxPages and maxDepth', async () => {
    const h = await harness();
    const tiny = await h.crawl({ maxPages: 3 });
    expect(tiny.run.urlsCrawled).toBeLessThanOrEqual(3);
    const shallow = await h.crawl({ maxDepth: 0, maxPages: 40 });
    // Fetched pages only: the Go crawler also lists URLs it found but did not fetch (crawlState depth_limit, …).
    const linkFollowed = shallow.urls.filter((u) => u.reason !== 'sitemap' && !u.redirectedFrom && (u.crawlState ?? 'fetched') === 'fetched');
    expect(linkFollowed.every((u) => (u.depth ?? 0) === 0)).toBe(true);
  });

  it('starts from a deeper start URL on the same site', async () => {
    const h = await harness();
    const d = await h.crawl({ startUrl: `${h.site.origin}/pages/about`, maxDepth: 0, maxPages: 1 });
    expect(d.urls[0].url).toBe(`${h.site.origin}/pages/about`);
  });

  it('survives timeouts, 500s, malformed HTML and a redirect to the cloud metadata endpoint without crashing', async () => {
    const h = await harness({ linkErrorRoutes: true, slowMs: 1500, ssrfRedirect: true, malformedPage: true });
    const d = await h.crawl({ timeoutMs: 2000, maxPages: 60 });
    expect(d.run.status).toBe('completed');
    const slow = d.urls.find((u) => u.url.endsWith('/pages/slow'));
    const broken = d.urls.find((u) => u.url.endsWith('/pages/broken'));
    const internal = d.urls.find((u) => u.url.endsWith('/pages/internal'));
    const malformed = d.urls.find((u) => u.url.endsWith('/pages/malformed'));
    expect(broken?.status).toBe(500);
    expect(slow).toBeTruthy();
    expect(internal?.status).toBe(302);
    expect(internal?.error).toMatch(/blocked: 169\.254\.169\.254 is a link-local \/ cloud metadata address/);
    expect(malformed?.status).toBe(200);
    // The metadata endpoint was never requested.
    expect(d.urls.some((u) => u.url.includes('169.254.169.254'))).toBe(false);
  });

  it('respects robots.txt', async () => {
    const h = await harness({ robotsDisallowCollections: true });
    const d = await h.crawl({ maxPages: 40 });
    const blocked = d.urls.filter((u) => u.skippedByRobots);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((u) => new URL(u.url).pathname.startsWith('/collections') && u.status === null)).toBe(true);
    expect(h.site.requests.some((r) => r.path.startsWith('/collections') && r.method === 'GET')).toBe(false);
  });
});

describe('cancellation', () => {
  it('stops sending requests, keeps partial results and creates no issues', async () => {
    const h = await harness({}, { CRAWLER_REQUEST_DELAY_MS: '150' });
    const res = await h.api.post('/api/crawls', { type: 'full', options: h.options({ maxPages: 200, concurrency: 1 }) });
    const id = res.body.id as string;
    await new Promise((r) => setTimeout(r, 700));
    const cancel = await h.api.post(`/api/crawls/${id}/cancel`);
    expect(cancel.status).toBe(200);
    expect((cancel.body as CrawlRun).status).toBe('cancelled');
    expect(cancel.body.error).toMatch(/Cancelled by .* no issues were created/);
    const requestsAtCancel = h.site.requests.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(h.site.requests.length).toBe(requestsAtCancel);
    const d = (await h.api.get(`/api/crawls/${id}`)).body as CrawlDetail;
    expect(d.urls.length).toBeGreaterThan(0);
    expect(d.urls.length).toBeLessThan(200);
    expect(await h.container.repos.issues.count()).toBe(0);
    const again = await h.api.post(`/api/crawls/${id}/cancel`);
    expect(again.status).toBe(409);
  });

  it('allows only one crawl per website at a time', async () => {
    const h = await harness({}, { CRAWLER_REQUEST_DELAY_MS: '100' });
    const first = await h.api.post('/api/crawls', { type: 'full', options: h.options({ maxPages: 50, concurrency: 1 }) });
    const second = await h.api.post('/api/crawls', { type: 'full', options: h.options() });
    expect(second.status).toBe(409);
    await h.api.post(`/api/crawls/${first.body.id}/cancel`);
  });
});

describe('export', () => {
  it('downloads the current results as CSV and JSON, labelled temporary', async () => {
    const h = await harness();
    const d = await h.crawl({ maxPages: 8 });
    const csv = await h.api.get(`/api/crawls/${d.run.id}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="crawl-127.0.0.1-${d.run.id}.csv"`));
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toMatch(/^url,final_url,status,/);
    expect(lines.length).toBe(d.urls.length + 1);
    const json = await h.api.get(`/api/crawls/${d.run.id}/export?format=json`);
    const body = JSON.parse(json.text);
    expect(body.note).toMatch(/TEMPORARY/);
    expect(body.pages).toHaveLength(d.urls.length);
    expect((await h.api.get(`/api/crawls/${d.run.id}/export?format=xml`)).status).toBe(400);
  });
});
