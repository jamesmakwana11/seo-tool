/**
 * Claude AI integration and AI SEO suggestions, end to end through the HTTP API against the mock Anthropic API and the
 * mock Shopify (no network): connect / test / model / disconnect with the key stored encrypted and never returned or
 * logged; editor suggestions written from the page's content and checked against their length targets (with a
 * corrective retry); already-good values kept; image alt text from the attached image; Fix All covering title,
 * description, tags and all SEO metadata with batched, verified writes; and the rule-based fallback when the key fails.
 */
import pino from 'pino';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, type ClaudeStatus, type CrawledUrl, type IntegrationStatus, type SeoBulkItemsPage, type SeoBulkJob, type ShopifyDraft } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { checkValue, sanitizeDescriptionHtml } from '../../src/ai/seoWriter';
import { FIXTURE } from '../api/helpers';
import { createMockShopify, SHOP, STOREFRONT, TOKEN } from '../shopify/mockShopify';
import { createMockClaude, GOOD_KEY } from './mockClaude';

const RUN = 'CRL-AI-1';
const at = '2026-01-01T00:00:00.000Z';
const row = (path: string, x: Partial<CrawledUrl>): CrawledUrl => ({ url: `${STOREFRONT}${path}`, status: 200, reason: 'link', crawlState: 'fetched', images: 0, imagesMissingAlt: 0, ...x } as CrawledUrl);

async function setup(claudeOpts: Parameters<typeof createMockClaude>[0] = {}) {
  const shop = createMockShopify();
  const claude = createMockClaude(claudeOpts);
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => { lines.push(s); } });
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'true', SESSION_SECRET: 'claude-seo-test-secret-value-at-least-32-chars', LOG_LEVEL: 'debug',
    CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true', APP_BASE_URL: 'https://sentinel.example', SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_ADMIN_TOKEN: TOKEN,
  });
  const c = await createContainer({ env, log, fetchImpl: claude.wrap(shop.fetchImpl) });
  const agent = supertest(createApp(c));
  const tokenOf = async (email: string) => (await agent.post('/api/auth/login').send({ email, password: FIXTURE.password })).body.token as string;
  const as = (tok: string) => ({
    get: (p: string) => agent.get(p).set({ Authorization: `Bearer ${tok}` }),
    post: (p: string, b: unknown = {}) => agent.post(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    patch: (p: string, b: unknown = {}) => agent.patch(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    del: (p: string) => agent.delete(p).set({ Authorization: `Bearer ${tok}` }),
  });
  // A product with no tags and a one-line description, found by Fix All's catalog scan (not in the crawl).
  shop.products.set('gid://shopify/Product/1002', {
    id: 'gid://shopify/Product/1002', handle: 'steel-water-bottle', title: 'Insulated Steel Water Bottle for Office and Travel',
    descriptionHtml: '<p>Keeps drinks cold for hours. Leak proof lid with carry loop. Made of food grade stainless steel.</p>', tags: [],
    seo: { title: 'Insulated Steel Water Bottle for Office, Travel and Gym Use | DeoDap Test', description: 'Keep water cold all day with this insulated stainless steel bottle. Leak proof lid with carry loop, made for office, travel and daily use. Order today.' },
    media: [{ id: 'gid://shopify/MediaImage/601', alt: 'Insulated steel water bottle with carry loop lid', url: 'https://cdn.example/b1.jpg' }], updatedAt: new Date().toISOString(),
  });
  const chopper = shop.products.get('gid://shopify/Product/1001')!;
  const rows: CrawledUrl[] = [
    row('/products/vegetable-chopper', { title: `${chopper.title} – DeoDap Test`, metaDescription: '', h1: [chopper.title, 'Vegetable Chopper'], template: 'product', images: 2, imagesMissingAlt: 1, imagesMissingAltSrc: ['https://cdn.example/c1.jpg'], auditScore: 40 }),
    row('/pages/about-us', { title: 'About Us – DeoDap Test', metaDescription: 'DeoDap ships household products from Rajkot since 2015. We pack every order by hand for customers across India.', h1: ['About Us'], template: 'page', auditScore: 85 }),
  ];
  await c.repos.crawls.insert({ id: RUN, type: 'full', status: 'completed', trigger: 'manual', startedAt: at, finishedAt: at, urlsPlanned: rows.length, urlsCrawled: rows.length, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], source: 'live' } as never);
  await c.repos.crawlUrls.upsert({ id: RUN, urls: rows } as never);
  return { c, shop, claude, lines, superAdmin: as(await tokenOf(FIXTURE.admin)), seo: as(await tokenOf(FIXTURE.seoLead)) };
}

const connect = async (h: Awaited<ReturnType<typeof setup>>) => {
  const r = await h.superAdmin.post('/api/ai/claude/connect', { apiKey: GOOD_KEY, model: 'claude-test-large' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

describe('Claude AI integration', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { h = await setup(); });

  it('tests a key, refuses a bad one or an unavailable model, connects, changes model and disconnects — the key is never returned or logged', async () => {
    let st = (await h.superAdmin.get('/api/ai/claude')).body as ClaudeStatus;
    expect(st).toMatchObject({ connected: false, canStore: true });
    const bad = await h.superAdmin.post('/api/ai/claude/test', { apiKey: 'sk-ant-wrong-key-0000000000000000000' });
    expect(bad.body).toMatchObject({ ok: false });
    expect(bad.body.message).toMatch(/rejected the API key/);
    const good = await h.superAdmin.post('/api/ai/claude/test', { apiKey: GOOD_KEY });
    expect(good.body.ok).toBe(true);
    expect(good.body.models.map((m: { id: string }) => m.id)).toEqual(['claude-test-large', 'claude-test-small']);
    expect((await h.superAdmin.post('/api/ai/claude/connect', { apiKey: GOOD_KEY, model: 'claude-made-up' })).status).toBe(400);
    expect((await h.superAdmin.get('/api/ai/claude')).body.connected).toBe(false);

    await connect(h);
    st = (await h.superAdmin.get('/api/ai/claude')).body;
    expect(st).toMatchObject({ connected: true, model: 'claude-test-large', modelName: 'Claude Test Large', lastTestOk: true });
    // Stored encrypted; nothing returns it.
    const doc = await h.c.repos.integrationSecrets.get('claude');
    expect(JSON.stringify(doc)).not.toContain(GOOD_KEY);
    expect(doc!.sealed.apiKey.data).toBeTruthy();
    const list = (await h.superAdmin.get('/api/integrations')).body as IntegrationStatus[];
    expect(list.find((i) => i.id === 'claude')).toMatchObject({ state: 'connected' });
    const audit = JSON.stringify((await h.superAdmin.get('/api/audit?pageSize=200')).body);
    expect(audit).toContain('Connected Claude AI');
    // Saved key re-tested without sending it again.
    expect((await h.superAdmin.post('/api/ai/claude/test', {})).body.ok).toBe(true);
    st = (await h.superAdmin.patch('/api/ai/claude/model', { model: 'claude-test-small' })).body;
    expect(st.model).toBe('claude-test-small');
    for (const body of [st, audit, list]) expect(JSON.stringify(body)).not.toContain(GOOD_KEY);
    expect(h.lines.join('\n')).not.toContain(GOOD_KEY);

    st = (await h.superAdmin.del('/api/ai/claude')).body;
    expect(st.connected).toBe(false);
    expect(await h.c.repos.integrationSecrets.get('claude')).toBeUndefined();
  });

  it('only roles that manage integrations can connect it (Admin and SEO Specialist cannot)', async () => {
    expect(ADMIN_PERMISSIONS).not.toContain('integrations.manage');
    expect((await h.seo.post('/api/ai/claude/connect', { apiKey: GOOD_KEY, model: 'claude-test-large' })).status).toBe(403);
    expect((await h.seo.post('/api/ai/claude/test', { apiKey: GOOD_KEY })).status).toBe(403);
  });
});

describe('AI SEO suggestions in the editor', () => {
  it('writes the fields that need work from the page content, at the target lengths; good values are kept; alt text sees the image', async () => {
    const h = await setup();
    await connect(h);
    const r = await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
    const d = r.body as ShopifyDraft;
    expect(d.ai).toMatchObject({ used: true, model: 'claude-test-large' });
    const f = (k: string) => d.fields.find((x) => x.key === k)!;
    // Meta description: missing → written, 140–160 characters, pre-selected.
    expect(f('seoDescription').suggestion).toMatchObject({ source: 'ai', confidence: 'high', target: [140, 160] });
    expect(f('seoDescription').proposed.length).toBeGreaterThanOrEqual(140);
    expect(f('seoDescription').proposed.length).toBeLessThanOrEqual(160);
    // SEO title: within 60 characters including the theme's “ – DeoDap Test” suffix.
    expect(f('seoTitle').suggestion?.source).toBe('ai');
    expect(f('seoTitle').proposed.length + ' – DeoDap Test'.length).toBeLessThanOrEqual(60);
    // Description: thin → a new description (a replaced description is always reviewed first), safe HTML only.
    expect(f('bodyHtml').suggestion).toMatchObject({ source: 'ai', purpose: 'description', confidence: 'review' });
    expect(f('bodyHtml').proposed).toMatch(/^<p>/);
    expect(f('bodyHtml').proposed).not.toMatch(/<h1|<script|<a /i);
    // A product name change is always reviewed first.
    expect(f('title').suggestion).toMatchObject({ source: 'ai', confidence: 'review' });
    // Image alt text: the missing one written, with the image attached to the request; the good one kept.
    expect(f('imageAlt:gid://shopify/MediaImage/501').suggestion?.source).toBe('ai');
    expect(f('imageAlt:gid://shopify/MediaImage/502').suggestion?.keep).toBe(true);
    const req = h.claude.requests[0].body;
    expect(req.messages[0].content.some((c) => c.type === 'image' && c.source.url === 'https://cdn.example/c1.jpg')).toBe(true);
    expect(req.tool_choice.name).toBe('submit_seo_fields');
    // The prompt carries the page's facts and the targets; it never asks for fields that are already good.
    const prompt = req.messages[0].content.find((c) => c.type === 'text')!;
    expect('text' in prompt && prompt.text).toContain('Chop onions, tomatoes and herbs');
    expect('text' in prompt && prompt.text).toContain('target length: 140–160 characters');
    expect('text' in prompt && prompt.text).not.toContain('MediaImage/502');
  });

  it('retries a value that misses its target with the exact problem, and offers it only when it passes', async () => {
    const h = await setup({ override: (key, n) => (key === 'seoDescription' && n === 1 ? 'Chop onions fast.' : undefined) });
    await connect(h);
    const d = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` })).body as ShopifyDraft;
    const meta = d.fields.find((x) => x.key === 'seoDescription')!;
    expect(h.claude.requests.length).toBe(2);
    const retryPrompt = h.claude.requests[1].body.messages[0].content.find((c) => c.type === 'text');
    expect(retryPrompt && 'text' in retryPrompt ? retryPrompt.text : '').toMatch(/seoDescription: 17 characters — under the target 140–160/);
    expect(meta.proposed.length).toBeGreaterThanOrEqual(140);
    expect(meta.suggestion).toMatchObject({ source: 'ai', confidence: 'high' });
  });

  it('a value still outside its target after the retry is offered for review with the reason, never pre-selected', async () => {
    const h = await setup({ override: (key) => (key === 'seoDescription' ? 'Chop onions, tomatoes and herbs in seconds with the stainless steel blades of this chopper.' : undefined) });
    await connect(h);
    const d = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` })).body as ShopifyDraft;
    const meta = d.fields.find((x) => x.key === 'seoDescription')!;
    expect(meta.suggestion).toMatchObject({ source: 'ai', confidence: 'review' });
    expect(meta.include).toBe(false);
    expect(meta.suggestion!.reason).toMatch(/under the target 140–160/);
  });

  it('falls back to the rule-based suggestions with the reason when the key stops working', async () => {
    const h = await setup();
    await connect(h);
    h.claude.revoke();
    const d = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` })).body as ShopifyDraft;
    expect(d.ai).toMatchObject({ used: false, errorCode: 'auth' });
    expect(d.ai!.note).toMatch(/rejected the API key/);
    expect(d.fields.find((x) => x.key === 'seoDescription')!.suggestion?.source).toBe('rules');
    expect((await h.superAdmin.get('/api/ai/claude')).body).toMatchObject({ lastTestOk: false });
  });

  it('without Claude the editor says so and keeps the rule-based suggestions', async () => {
    const h = await setup();
    const d = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` })).body as ShopifyDraft;
    expect(d.ai).toMatchObject({ used: false });
    expect(d.ai!.note).toMatch(/not connected/);
    expect(h.claude.requests.length).toBe(0);
  });
});

describe('Fix All with Claude AI', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { h = await setup(); await connect(h); });
  const job = async () => (await h.seo.get('/api/seo/bulk-fix')).body as SeoBulkJob;
  const items = async () => ((await h.seo.get('/api/seo/bulk-fix/items?limit=100')).body as SeoBulkItemsPage).items;

  it('covers title, description, tags and SEO metadata; products outside the crawl are found in the catalog; counts are shown before applying', async () => {
    const r = await h.seo.post('/api/seo/bulk-fix', { scope: 'pages', runId: RUN });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as SeoBulkJob).fields).toEqual(expect.arrayContaining(['title', 'description', 'tags', 'seoTitle', 'seoDescription', 'h1', 'imageAlt']));
    await h.c.services.shopify.seoBulkIdle();
    const j = await job();
    expect(j.state, j.error).toBe('ready');
    expect(h.shop.mutations()).toEqual([]);
    expect(j.ai).toMatchObject({ provider: 'claude', model: 'claude-test-large' });
    expect(j.ai!.generated).toBeGreaterThan(3);
    const list = await items();
    const by = Object.fromEntries(list.map((x) => [new URL(x.url).pathname, x]));
    const chopper = by['/products/vegetable-chopper'];
    const meta = chopper.changes.find((c) => c.key === 'seoDescription')!;
    expect(meta).toMatchObject({ source: 'ai', included: true, target: [140, 160] });
    expect(chopper.changes.find((c) => c.key === 'bodyHtml')).toMatchObject({ field: 'description', source: 'ai' });
    // The bottle is not in the crawl: the catalog scan found its missing tags and thin description.
    const bottle = by['/products/steel-water-bottle'];
    expect(bottle, JSON.stringify(Object.keys(by))).toBeTruthy();
    const tags = bottle.changes.find((c) => c.key === 'tags')!;
    expect(tags).toMatchObject({ field: 'tags', source: 'ai', included: true });
    expect(tags.proposed.split(',').length).toBeGreaterThanOrEqual(3);
    expect(bottle.changes.find((c) => c.key === 'bodyHtml')).toMatchObject({ field: 'description', source: 'ai', confidence: 'review', included: false });
    // Its good SEO title and meta description are left alone.
    expect(bottle.changes.map((c) => c.key)).not.toContain('seoTitle');
    expect(bottle.changes.map((c) => c.key)).not.toContain('seoDescription');
    expect(j.summary.byField.description?.pages).toBeGreaterThanOrEqual(2);
    expect(j.summary.byField.tags?.pages).toBeGreaterThanOrEqual(1);
  });

  it('applies the selection (plus a reviewed description) in batches and verifies each saved value', async () => {
    const j = await job();
    const bottleUrl = `${STOREFRONT}/products/steel-water-bottle`;
    expect((await h.seo.post('/api/seo/bulk-fix/select', { jobId: j.id, url: bottleUrl, key: 'bodyHtml', included: true })).status).toBe(200);
    expect((await h.seo.post('/api/seo/bulk-fix/apply', { jobId: j.id })).status).toBe(200);
    await h.c.services.shopify.seoBulkIdle();
    const done = await job();
    expect(done.state, done.error).toBe('done');
    expect(done.result!.failed).toBe(0);
    const bottle = (await items()).find((x) => x.url === bottleUrl)!;
    for (const c of bottle.changes.filter((x) => x.included)) expect(c.result?.status, c.key).toBe('verified');
    const p = h.shop.products.get('gid://shopify/Product/1002')!;
    expect(p.tags.length).toBeGreaterThanOrEqual(3);
    expect(p.descriptionHtml).toBe(bottle.changes.find((c) => c.key === 'bodyHtml')!.proposed);
    const chopperMeta = h.shop.products.get('gid://shopify/Product/1001')!.seo.description!;
    expect(chopperMeta.length).toBeGreaterThanOrEqual(140);
  }, 30_000);
});

describe('AI value checks', () => {
  const input = { kind: 'product' as const, title: 'Steel Bottle', descriptionText: 'Keeps drinks cold for 12 hours.', tags: ['bottle'], keywords: ['steel'], fields: [] };
  it('flags short, duplicate, invented-figure and keyword-dropping values; merges tags without removing existing ones', () => {
    expect(checkValue({ key: 'seoDescription', type: 'seoDescription', current: '', problems: [], target: [140, 160] }, 'Cold bottle.', input).issues.join(' ')).toMatch(/under the target/);
    expect(checkValue({ key: 'seoTitle', type: 'seoTitle', current: 'Steel Bottle', problems: [], target: [10, 60], avoid: ['Cold Steel Bottle for Travel'] }, 'Cold Steel Bottle for Travel', input).issues.join(' ')).toMatch(/another page/);
    expect(checkValue({ key: 'seoDescription', type: 'seoDescription', current: '', problems: [] }, 'Keeps drinks cold for 24 hours with steel walls.', input).issues.join(' ')).toMatch(/figures not in the content: 24/);
    expect(checkValue({ key: 'seoTitle', type: 'seoTitle', current: 'Steel Bottle', problems: [] }, 'Cold Bottle for Travel', input).issues.join(' ')).toMatch(/Drops the store keyword “steel”/);
    const t = checkValue({ key: 'tags', type: 'tags', current: 'bottle', problems: [], target: [3, 15] }, 'Bottle, drinkware, travel, steel bottle', input);
    expect(t.value).toBe('bottle, drinkware, travel, steel bottle');
    expect(t.issues).toEqual([]);
  });
  it('keeps description HTML simple and safe', () => {
    expect(sanitizeDescriptionHtml('<h1 class="x">Title</h1><p onclick="x()">Hi <a href="/x">there</a></p><script>bad()</script><img src=x>')).toBe('<h2>Title</h2><p>Hi there</p>');
    expect(sanitizeDescriptionHtml('First paragraph.\n\nSecond.')).toBe('<p>First paragraph.</p><p>Second.</p>');
  });
});

describe('Claude client limits and errors', () => {
  it('retries rate limits and overload with backoff, then succeeds; a rejected key stops at once', async () => {
    const { createClaudeClient } = await import('../../src/ai/claude');
    const m = createMockClaude();
    m.faults.push({ status: 429, times: 2 }, { status: 529, type: 'overloaded_error' });
    const waits: number[] = [];
    const c = createClaudeClient({ apiKey: GOOD_KEY, fetchImpl: m.wrap(async () => new Response('', { status: 404 })), sleep: async (ms) => { waits.push(ms); } });
    expect((await c.listModels()).length).toBe(2);
    expect(waits.length).toBe(3);
    const bad = createClaudeClient({ apiKey: 'sk-ant-wrong-key-0000000000000000000', fetchImpl: m.wrap(async () => new Response('', { status: 404 })), sleep: async () => undefined });
    await expect(bad.listModels()).rejects.toMatchObject({ code: 'auth' });
    // Never the key in the error.
    await expect(bad.listModels()).rejects.not.toThrow(/sk-ant-wrong/);
  });
});

describe('Fix All: duplicated descriptions', () => {
  it('finds products sharing a description and asks for a unique one for each', async () => {
    const h = await setup();
    await connect(h);
    const bottle = h.shop.products.get('gid://shopify/Product/1002')!;
    h.shop.products.set('gid://shopify/Product/1003', { ...bottle, id: 'gid://shopify/Product/1003', handle: 'steel-flask', title: 'Steel Flask with Carry Loop for Hot and Cold Drinks', tags: ['flask', 'steel', 'drinkware'], media: [] });
    const desc = '<p>Keeps drinks cold for hours and hot for longer. Leak proof lid with a strong carry loop. Made of food grade stainless steel for daily office and travel use.</p>';
    bottle.descriptionHtml = desc;
    h.shop.products.get('gid://shopify/Product/1003')!.descriptionHtml = desc;
    await h.seo.post('/api/seo/bulk-fix', { scope: 'pages', runId: RUN, fields: ['description'] });
    await h.c.services.shopify.seoBulkIdle();
    const list = ((await h.seo.get('/api/seo/bulk-fix/items?limit=100')).body as SeoBulkItemsPage).items;
    const flask = list.find((x) => x.url.endsWith('/products/steel-flask'))!;
    const bottleItem = list.find((x) => x.url.endsWith('/products/steel-water-bottle'))!;
    for (const it of [flask, bottleItem]) expect(it.changes.find((c) => c.key === 'bodyHtml')!.problems).toContain('Duplicated');
    expect(flask.changes[0].proposed).not.toBe(bottleItem.changes[0].proposed);
    const prompts = h.claude.requests.map((r) => r.body.messages[0].content.map((c) => ('text' in c ? c.text : '')).join(''));
    expect(prompts.some((p) => p.includes('must differ from') && p.includes('Keeps drinks cold for hours and hot for longer'))).toBe(true);
  });
});
