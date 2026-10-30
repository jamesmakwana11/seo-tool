/**
 * Bulk SEO fixes and the SEO Optimization lists, end to end through the HTTP API against the in-memory mock Shopify
 * (no real store): scan of the crawl's pages, plan with suggestions only where values need work, manual-review list,
 * exclusions, apply with read-back and storefront checks, duplicate-click safety, page re-check (score refreshed),
 * issue closure only after a passed re-check, issue-scoped fixes, rate limits, partial failures and permissions.
 */
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CrawledUrl, CrawlPagesResponse, Issue, SeoBulkItemsPage, SeoBulkJob, SeoOptimizationPage } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { FIXTURE } from '../api/helpers';
import { createMockShopify, SHOP, STOREFRONT, TOKEN } from './mockShopify';

const RUN = 'CRL-BULK-1';
const at = '2026-01-01T00:00:00.000Z';
const row = (path: string, x: Partial<CrawledUrl>): CrawledUrl => ({ url: `${STOREFRONT}${path}`, status: 200, reason: 'link', crawlState: 'fetched', images: 0, imagesMissingAlt: 0, ...x } as CrawledUrl);

async function setup() {
  const mock = createMockShopify();
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'true', SESSION_SECRET: 'bulk-fix-test-secret-value-at-least-32-chars', LOG_LEVEL: 'silent',
    CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true', APP_BASE_URL: 'https://sentinel.example', SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_ADMIN_TOKEN: TOKEN,
  });
  const c = await createContainer({ env, fetchImpl: mock.fetchImpl });
  const agent = supertest(createApp(c));
  const tokenOf = async (email: string) => (await agent.post('/api/auth/login').send({ email, password: FIXTURE.password })).body.token as string;
  const as = (tok: string) => ({
    get: (p: string) => agent.get(p).set({ Authorization: `Bearer ${tok}` }),
    post: (p: string, b: unknown = {}) => agent.post(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
  });
  // A finished crawl of the mock storefront, as the crawler would have recorded it.
  const chopper = mock.products.get('gid://shopify/Product/1001')!;
  mock.pages.get('gid://shopify/Page/3002')!.body = '<h1>Bulk orders</h1><p>Order 50 pieces or more of any DeoDap product at wholesale prices. See <a href="/pages/old-wholesale">our old price list</a>.</p>';
  const rows: CrawledUrl[] = [
    row('/', { title: 'DeoDap Test', metaDescription: '', h1: [], template: 'home' }),
    row('/products/vegetable-chopper', { title: `${chopper.title} – DeoDap Test`, metaDescription: '', h1: [chopper.title, 'Vegetable Chopper'], template: 'product', images: 2, imagesMissingAlt: 1, imagesMissingAltSrc: ['https://cdn.example/c1.jpg'], auditScore: 40 }),
    row('/collections/kitchen-tools', { title: 'Kitchen Tools – DeoDap Test', metaDescription: 'Tools', h1: [], template: 'collection', auditScore: 70 }),
    row('/collections/kitchen-tools?page=2', { title: 'Kitchen Tools – DeoDap Test', metaDescription: '', h1: [], template: 'collection' }),
    row('/pages/about-us', { title: 'About Us – DeoDap Test', metaDescription: 'DeoDap ships household products from Rajkot since 2015. We pack every order by hand for customers across India.', h1: ['About Us', 'About DeoDap'], template: 'page', auditScore: 85 }),
    row('/pages/bulk-orders', { title: 'Bulk Orders – DeoDap Test', metaDescription: 'Order 50 pieces or more of any DeoDap product at wholesale prices — delivered across India from Rajkot.', h1: ['Bulk orders'], template: 'page', brokenLinks: [`${STOREFRONT}/pages/old-wholesale`], brokenLinkDetails: [{ url: `${STOREFRONT}/pages/old-wholesale`, status: 301 }] as never }),
    row('/pages/old-wholesale', { status: 301, redirects: 1, finalStatus: 200, finalUrl: `${STOREFRONT}/pages/bulk-orders`, title: undefined, h1: undefined }),
  ];
  await c.repos.crawls.insert({ id: RUN, type: 'full', status: 'completed', trigger: 'manual', startedAt: at, finishedAt: at, urlsPlanned: rows.length, urlsCrawled: rows.length, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], source: 'live' } as never);
  await c.repos.crawlUrls.upsert({ id: RUN, urls: rows } as never);
  const issue = (id: string, checkId: string, module: string, title: string, urls: string[]): Issue => ({
    id, checkId, module, title, summary: title, severity: 'medium', severityRationale: 'x', issueClass: 'medium', status: 'NEW', delta: 'new', affectedUrls: urls, affectedCount: urls.length,
    highestTier: 3, tierBreakdown: { 1: 0, 2: 0, 3: urls.length }, businessImpact: 'x', detectedAt: at, firstSeenAt: at, lastSeenAt: at, slaDueAt: at, occurrences: 1, recommendedTeam: 'content',
    allocation: [], severityHistory: [], evidence: [], source: 'live',
  } as unknown as Issue);
  await c.repos.issues.insert(issue('ISS-B1', 'ONP-TITLE', 'onpage', '1 page with a title longer than 60 characters', [`${STOREFRONT}/products/vegetable-chopper`]));
  await c.repos.issues.insert(issue('ISS-B2', 'TECH-SCHEMA-ERRORS', 'technical', 'Review markup without visible reviews', [`${STOREFRONT}/products/vegetable-chopper`]));
  await c.repos.issues.insert(issue('ISS-B3', 'ONP-META', 'onpage', '2 pages without a meta description', [`${STOREFRONT}/products/vegetable-chopper`, `${STOREFRONT}/`]));
  return { c, mock, agent, seo: as(await tokenOf(FIXTURE.seoLead)), dev: as(await tokenOf(FIXTURE.developer)), admin: as(await tokenOf(FIXTURE.admin)) };
}

describe('bulk SEO fixes', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { h = await setup(); });
  const idle = () => h.c.services.shopify.seoBulkIdle();
  const job = async () => (await h.seo.get('/api/seo/bulk-fix')).body as SeoBulkJob;
  const itemsOf = async (q = '') => (await h.seo.get(`/api/seo/bulk-fix/items?limit=100${q}`)).body as SeoBulkItemsPage;

  it('needs Shopify edit permission', async () => {
    expect((await h.dev.post('/api/seo/bulk-fix', { scope: 'pages' })).status).toBe(403);
  });

  it('scans every page and plans changes only where values need work; the rest is listed for a person', async () => {
    const r = await h.seo.post('/api/seo/bulk-fix', { scope: 'pages' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as SeoBulkJob).state).toBe('scanning');
    // A second bulk job of the same website while one is preparing is refused.
    const second = await h.seo.post('/api/seo/bulk-fix', { scope: 'pages' });
    if (second.status !== 200) expect(second.body.error.code).toBe('BULK_JOB_RUNNING');
    await idle();
    const j = await job();
    expect(j.state, j.error).toBe('ready');
    expect(h.mock.mutations()).toEqual([]); // nothing written while preparing
    const it = (await itemsOf()).items;
    const byUrl = Object.fromEntries(it.map((x) => [new URL(x.url).pathname, x]));
    // The chopper: SEO title (too long, theme suffix counted), meta description (missing), image alt, extra H1 in the description.
    const chopper = byUrl['/products/vegetable-chopper'];
    expect(chopper.changes.map((c) => c.key).sort()).toEqual(['bodyHtml', 'imageAlt:gid://shopify/MediaImage/501', 'seoDescription', 'seoTitle', 'title']);
    // The H1 is the 92-character product title: a shortened wording is listed for review, not selected.
    expect(chopper.changes.find((c) => c.key === 'title')).toMatchObject({ field: 'h1', included: false, confidence: 'review' });
    expect(chopper.changes.filter((c) => c.included).map((c) => c.key).sort()).toEqual(['bodyHtml', 'imageAlt:gid://shopify/MediaImage/501', 'seoDescription', 'seoTitle']);
    const title = chopper.changes.find((c) => c.key === 'seoTitle')!;
    expect(title.proposed.length + ' – DeoDap Test'.length).toBeLessThanOrEqual(60);
    expect(title.reason).toMatch(/theme adds/);
    expect(chopper.changes.find((c) => c.key === 'bodyHtml')!.field).toBe('h1');
    // The broken link in the bulk-orders content points to a page that redirects: replaced by the final page.
    const links = byUrl['/pages/bulk-orders'].changes.find((c) => c.field === 'links')!;
    expect(links.proposed).toContain('href="/pages/bulk-orders"');
    expect(links.proposed).not.toContain('old-wholesale');
    // Good values are left alone: about-us has a good title and meta description (its second H1 is in the content).
    expect(byUrl['/pages/about-us']?.changes.map((c) => c.key) ?? []).not.toContain('seoDescription');
    // Homepage and the paginated URL are not Shopify resources: listed for a person with the reason.
    expect(j.manual.some((m) => /Homepage/.test(m.reason) && m.urls.includes(`${STOREFRONT}/`))).toBe(true);
    expect(j.manual.some((m) => /Paginated/.test(m.reason))).toBe(true);
    expect(j.summary.selectedChanges).toBeGreaterThan(0);
    expect(j.summary.byField.seoTitle?.pages).toBeGreaterThan(0);
  });

  it('lets a person exclude a page or one change before applying', async () => {
    const j = await job();
    const chopper = `${STOREFRONT}/products/vegetable-chopper`;
    const r = await h.seo.post('/api/seo/bulk-fix/select', { jobId: j.id, url: chopper, key: 'seoDescription', included: false });
    expect(r.status).toBe(200);
    const after = (await itemsOf()).items.find((x) => x.url === chopper)!;
    expect(after.changes.find((c) => c.key === 'seoDescription')!.included).toBe(false);
    expect((r.body as SeoBulkJob).summary.selectedChanges).toBe(j.summary.selectedChanges - 1);
  });

  it('applies through a rate limit, reads every value back, checks the storefront, refreshes scores and closes only re-checked issues', async () => {
    const j = await job();
    h.mock.faults.push({ op: 'SentinelProductUpdate', kind: '429' });
    const a = await h.seo.post('/api/seo/bulk-fix/apply', { jobId: j.id });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    // Double click: the same job is returned, nothing is written twice.
    const again = await h.seo.post('/api/seo/bulk-fix/apply', { jobId: j.id });
    expect(again.status).toBe(200);
    expect(['applying', 'done']).toContain((again.body as SeoBulkJob).state);
    await idle();
    const done = await job();
    expect(done.state, done.error).toBe('done');
    expect(done.result!.verified).toBeGreaterThan(0);
    expect(done.result!.failed).toBe(0);
    const p = h.mock.products.get('gid://shopify/Product/1001')!;
    expect(p.seo.title).toBeTruthy();
    expect(p.seo.description ?? '').toBe(''); // excluded in the review: still no meta description
    expect(p.title).toMatch(/^3 in 1 Multipurpose Vegetable Chopper and Slicer with Stainless Steel Blades/); // review-only change not written
    expect(p.descriptionHtml).toContain('<h2>Vegetable Chopper</h2>');
    expect(p.media[0].alt).toMatch(/^3 in 1/);
    expect(h.mock.pages.get('gid://shopify/Page/3002')!.body).toContain('href="/pages/bulk-orders"');
    const writes = h.mock.mutations().filter((m) => m.startsWith('SentinelProductUpdate'));
    expect(writes[0]).toBe('SentinelProductUpdate:429'); // retried after the rate limit
    const chopper = (await itemsOf()).items.find((x) => x.url.endsWith('/products/vegetable-chopper'))!;
    expect(chopper.status).toBe('done');
    expect(chopper.changes.filter((c) => c.included).every((c) => c.result?.status === 'verified')).toBe(true);
    expect(chopper.changes.find((c) => c.key === 'seoDescription')!.result).toBeUndefined();
    expect(chopper.storefront?.checks.find((c) => c.field === 'Title tag')?.ok).toBe(true);
    // Page score: the crawl's, and the page fetched again after the fix.
    expect(typeof chopper.score?.before).toBe('number');
    expect(chopper.score!.after!).toBeGreaterThan(chopper.score!.before!);
    const pages = (await h.seo.get(`/api/crawls/${RUN}/pages?q=vegetable-chopper`)).body as CrawlPagesResponse;
    const pr = pages.rows.find((x) => x.url.endsWith('/products/vegetable-chopper'))!;
    expect(pr.recheckedAt).toBeTruthy();
    expect(pr.auditScore).toBe(chopper.score!.after);
    expect(pr.scoreBeforeRecheck).toBe(chopper.score!.before);
    // Issues: the title issue's only URL was fixed and re-checked → closed; the meta issue was not fixed (excluded) → open;
    // the schema issue is not a field the editor writes → listed for a person, never closed.
    const t = await h.c.repos.issues.get('ISS-B1');
    expect(t!.status).toBe('VERIFIED');
    expect(done.result!.issues.find((x) => x.issueId === 'ISS-B1')!.outcome).toBe('resolved');
    expect((await h.c.repos.issues.get('ISS-B3'))!.status).toBe('NEW');
    expect((await h.c.repos.issues.get('ISS-B2'))!.status).toBe('NEW');
  });

  it('fixes from the Issues board: eligible issues mapped to fields, the rest explained', async () => {
    const r = await h.seo.post('/api/seo/bulk-fix', { scope: 'issues' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await idle();
    const j = await job();
    expect(j.state, j.error).toBe('ready');
    const it = (await itemsOf()).items;
    // ONP-META → the chopper's meta description (the homepage URL of the same issue is listed for a person).
    expect(it.find((x) => x.url.endsWith('/products/vegetable-chopper'))!.changes.map((c) => c.key)).toEqual(['seoDescription']);
    expect(it.every((x) => x.issueIds.length > 0)).toBe(true);
    expect(j.manual.some((m) => m.issueId === 'ISS-B2' && /Theme code or app settings/.test(m.reason))).toBe(true);
    expect(j.manual.some((m) => m.issueId === 'ISS-B3' && /Homepage/.test(m.reason))).toBe(true);
    // Cancelling a prepared job writes nothing.
    const n = h.mock.mutations().length;
    expect(((await h.seo.post('/api/seo/bulk-fix/cancel', { jobId: j.id })).body as SeoBulkJob).state).toBe('cancelled');
    expect((await h.seo.post('/api/seo/bulk-fix/apply', { jobId: j.id })).status).toBe(409);
    expect(h.mock.mutations().length).toBe(n);
  });

  it('reports partial failures per change and keeps the successful ones', async () => {
    const r = await h.seo.post('/api/seo/bulk-fix', { scope: 'urls', urls: [`${STOREFRONT}/products/vegetable-chopper`, `${STOREFRONT}/collections/kitchen-tools`], fields: ['seoDescription', 'imageAlt'] });
    expect(r.status).toBe(200);
    await idle();
    const j = await job();
    expect(j.state).toBe('ready');
    h.mock.faults.push({ op: 'SentinelCollectionUpdate', kind: 'userErrors' });
    await h.seo.post('/api/seo/bulk-fix/apply', { jobId: j.id });
    await idle();
    const done = await job();
    expect(done.state).toBe('done');
    const it = (await itemsOf()).items;
    const col = it.find((x) => x.url.endsWith('/collections/kitchen-tools'))!;
    const chop = it.find((x) => x.url.endsWith('/products/vegetable-chopper'))!;
    expect(col.status).toBe('failed');
    expect(col.changes.every((c) => c.result?.status === 'failed' && /Simulated validation error/.test(c.result.message ?? ''))).toBe(true);
    expect(chop.changes.find((c) => c.key === 'seoDescription')!.result!.status).toBe('verified');
    expect(done.result!.failed).toBeGreaterThan(0);
    expect(done.result!.verified).toBeGreaterThan(0);
    expect(h.mock.products.get('gid://shopify/Product/1001')!.seo.description).toMatch(/^Chop onions/);
  });
});

describe('SEO Optimization lists', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { h = await setup(); });

  it('lists titles with problems and suggestions from the page content; good values are kept', async () => {
    const r = await h.seo.get('/api/seo/optimization/titles?limit=10');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body as SeoOptimizationPage;
    expect(p.runId).toBe(RUN);
    expect(p.total).toBe(6); // HTML pages of the crawl (the redirect is not a page)
    const chopper = p.rows.find((x) => x.url.endsWith('/products/vegetable-chopper'))!;
    expect(chopper.assessment.problems.map((x) => x.code)).toContain('too_long');
    expect(chopper.issueIds).toEqual(['ISS-B1']);
    expect(chopper.suggestion?.keep).toBe(false);
    expect(chopper.suggestion!.value.length).toBeLessThanOrEqual(46);
    const about = p.rows.find((x) => x.url.endsWith('/pages/about-us'))!;
    expect(about.assessment.verdict).toBe('good');
    expect(about.suggestion?.keep).toBe(true);
    const home = p.rows.find((x) => x.url === `${STOREFRONT}/`)!;
    expect(home.editable).toBe(false);
    expect(home.manualReason).toMatch(/Homepage/);
  });

  it('filters by problem, page type and issue status, and pages the result', async () => {
    const missing = (await h.seo.get('/api/seo/optimization/meta-descriptions?problem=missing')).body as SeoOptimizationPage;
    expect(missing.rows.map((x) => new URL(x.url).pathname).sort()).toEqual(['/', '/collections/kitchen-tools', '/products/vegetable-chopper']);
    expect(missing.counts.missing).toBe(3);
    const short = (await h.seo.get('/api/seo/optimization/meta-descriptions?problem=too_short')).body as SeoOptimizationPage;
    expect(short.rows.map((x) => new URL(x.url).pathname)).toEqual(['/collections/kitchen-tools']);
    const products = (await h.seo.get('/api/seo/optimization/h1?template=product')).body as SeoOptimizationPage;
    expect(products.rows).toHaveLength(1);
    expect(products.rows[0].assessment.problems.map((x) => x.code)).toContain('multiple');
    const withIssue = (await h.seo.get('/api/seo/optimization/meta-descriptions?issue=open')).body as SeoOptimizationPage;
    expect(withIssue.rows.map((x) => new URL(x.url).pathname).sort()).toEqual(['/', '/products/vegetable-chopper']);
    const page2 = (await h.seo.get('/api/seo/optimization/titles?limit=2&offset=2')).body as SeoOptimizationPage;
    expect(page2.rows).toHaveLength(2);
    expect(page2.total).toBe(6);
  });

  it('lists product tags from Shopify with clean-up suggestions (never adds tags)', async () => {
    const p = (await h.seo.get('/api/seo/optimization/tags')).body as SeoOptimizationPage;
    const chopper = p.rows.find((x) => x.title.startsWith('3 in 1'))!;
    expect(chopper.assessment.problems.map((x) => x.code)).toEqual(expect.arrayContaining(['blank_tags', 'duplicate_tags']));
    expect(chopper.suggestion).toMatchObject({ value: 'kitchen, chopper', keep: false, confidence: 'high' });
  });

  it('roles without Shopify access still see problems, without suggestions', async () => {
    const p = (await h.dev.get('/api/seo/optimization/titles')).body as SeoOptimizationPage;
    expect(p.rows.length).toBeGreaterThan(0);
    expect(p.rows.every((x) => x.suggestion === null)).toBe(true);
  });
});

describe('bulk SEO fixes: missing Shopify permissions', () => {
  it('lists changes the granted scopes cannot write for a person, with the scope to add, and still prepares the rest', async () => {
    const h = await setup();
    h.mock.setScopes(['read_products', 'write_products', 'read_content', 'write_content']); // no write_files
    const r = await h.seo.post('/api/seo/bulk-fix', { scope: 'urls', urls: [`${STOREFRONT}/products/vegetable-chopper`], fields: ['imageAlt', 'seoDescription'] });
    expect(r.status).toBe(200);
    await h.c.services.shopify.seoBulkIdle();
    const j = (await h.seo.get('/api/seo/bulk-fix')).body as SeoBulkJob;
    expect(j.state).toBe('ready');
    expect(j.manual.some((m) => /write_files/.test(m.reason) && /reconnect/.test(m.reason))).toBe(true);
    const items = ((await h.seo.get('/api/seo/bulk-fix/items')).body as SeoBulkItemsPage).items;
    expect(items[0].changes.map((c) => c.key)).toEqual(['seoDescription']);
  });
});
