/**
 * Shopify connection + SEO editor end to end through the HTTP API, against an in-memory mock Shopify (no real store,
 * no network): OAuth with HMAC/state checks, drafts, confirmation, apply with rate limits, conflicts and partial failures,
 * read-back verification, storefront re-audit, theme proposals (live theme refused, never published), permissions,
 * and that the access token / app secret never appear in responses or logs.
 */
import { Writable } from 'node:stream';
import pino from 'pino';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ShopifyApplyBatchResult, ShopifyApplyPreview, ShopifyDraft, ShopifyStatus, ShopifyTheme, ShopifyThemeProposal } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { signQuery } from '../../src/shopify/oauth';
import { DEMO } from '../api/helpers';
import { API_KEY, API_SECRET, createMockShopify, SHOP, STOREFRONT, TOKEN, type MockShopify } from './mockShopify';

async function setup(extra: Record<string, string> = {}) {
  const mock = createMockShopify();
  const logs: string[] = [];
  const log = pino({ level: 'debug' }, new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } }));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'true', SESSION_SECRET: 'shopify-test-secret-value-at-least-32-chars', LOG_LEVEL: 'debug',
    CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true', APP_BASE_URL: 'https://sentinel.example', ...extra,
  });
  const container = await createContainer({ env, fetchImpl: mock.fetchImpl, log: log as never });
  const agent = supertest(createApp(container));
  const bodies: string[] = [];
  const tokenOf = async (email: string) => (await agent.post('/api/auth/login').send({ email, password: DEMO.password })).body.token as string;
  const as = (tok: string) => {
    const a = { Authorization: `Bearer ${tok}` };
    const rec = async <T extends { text?: string; headers: Record<string, string> }>(p: PromiseLike<T>) => { const r = await p; bodies.push(r.text ?? '', JSON.stringify(r.headers)); return r; };
    return {
      get: (p: string) => rec(agent.get(p).set(a)),
      post: (p: string, b: unknown = {}) => rec(agent.post(p).set(a).send(b as object)),
      patch: (p: string, b: unknown = {}) => rec(agent.patch(p).set(a).send(b as object)),
      del: (p: string) => rec(agent.delete(p).set(a)),
    };
  };
  const callback = async (q: Record<string, string>, sign = true) => {
    const query = sign ? { ...q, hmac: signQuery(q, API_SECRET) } : q;
    const r = await agent.get('/api/shopify/oauth/callback').query(query).redirects(0);
    bodies.push(r.text ?? '', JSON.stringify(r.headers));
    return r;
  };
  return { mock, logs, container, agent, bodies, as, admin: as(await tokenOf(DEMO.admin)), seo: as(await tokenOf(DEMO.seoLead)), dev: as(await tokenOf(DEMO.developer)), callback };
}

const OAUTH_ENV = { SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET };
const ts = () => String(Math.floor(Date.now() / 1000));

describe('Shopify OAuth', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { h = await setup(OAUTH_ENV); });

  it('reports how to connect when nothing is connected', async () => {
    const st = (await h.admin.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st).toMatchObject({ connected: false, via: null, oauthConfigured: true, redirectUrl: 'https://sentinel.example/api/shopify/oauth/callback' });
    expect(st.tokenNote).toMatch(/memory/);
    expect(st.requiredScopes).toEqual(['read_products', 'write_products', 'read_content', 'write_content']);
    const draft = await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` });
    expect(draft.status).toBe(409);
  });

  it('only admins (integrations.manage) can start the connection; the shop must be *.myshopify.com', async () => {
    expect((await h.seo.post('/api/shopify/oauth/start', { shop: 'sentinel-test' })).status).toBe(403);
    expect((await h.admin.post('/api/shopify/oauth/start', { shop: 'deodap.in' })).status).toBe(400);
  });

  it('rejects a bad hmac, an unknown state, an old timestamp and replays; accepts a valid callback', async () => {
    const start = await h.admin.post('/api/shopify/oauth/start', { shop: 'sentinel-test' });
    expect(start.status).toBe(200);
    const u = new URL(start.body.authorizeUrl);
    expect(u.host).toBe(SHOP);
    expect(u.searchParams.get('redirect_uri')).toBe('https://sentinel.example/api/shopify/oauth/callback');
    expect(u.searchParams.get('scope')).toContain('write_products');
    const state = u.searchParams.get('state')!;
    const q = { code: 'good-code', shop: SHOP, state, timestamp: ts(), host: 'aG9zdA' };

    const bad = await h.callback({ ...q, hmac: 'f'.repeat(64) }, false);
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toBe('https://sentinel.example/settings/shopify?shopify=error&reason=bad_hmac');
    expect((await h.callback({ ...q, state: 'not-a-state' })).headers.location).toMatch(/reason=bad_state/);
    expect((await h.callback({ ...q, timestamp: String(Number(ts()) - 3600) })).headers.location).toMatch(/reason=expired/);
    expect((await h.callback({ ...q, shop: 'other-shop.myshopify.com' })).headers.location).toMatch(/reason=bad_state|shop_mismatch/);
    expect(((await h.admin.get('/api/shopify/status')).body as ShopifyStatus).connected).toBe(false);
  });

  it('connects with a valid callback, keeps the token server-side, and the state cannot be replayed', async () => {
    const start = await h.admin.post('/api/shopify/oauth/start', { shop: SHOP });
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const q = { code: 'good-code', shop: SHOP, state, timestamp: ts(), host: 'aG9zdA' };
    const ok = await h.callback(q);
    expect(ok.headers.location).toBe('https://sentinel.example/settings/shopify?shopify=connected');
    const st = (await h.admin.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st).toMatchObject({ connected: true, via: 'oauth', shop: SHOP, shopName: 'DeoDap Test', missingScopes: [] });
    expect(st.capabilities).toEqual({ edit: true, themes: true, themeWrite: true, imageAlt: true });
    h.mock.addCode('good-code');
    expect((await h.callback(q)).headers.location).toMatch(/reason=bad_state/);
  });

  it('refuses a grant without the required scopes', async () => {
    h.mock.setScopes(['read_products']);
    h.mock.addCode('code-2');
    const start = await h.admin.post('/api/shopify/oauth/start', { shop: SHOP });
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    expect((await h.callback({ code: 'code-2', shop: SHOP, state, timestamp: ts() })).headers.location).toMatch(/reason=missing_scopes/);
    h.mock.setScopes(['write_products', 'write_content', 'write_themes', 'write_files']);
    expect(((await h.admin.get('/api/shopify/status')).body as ShopifyStatus).via).toBe('oauth');
  });

  it('never exposes the token or app secret in responses or logs', () => {
    expect(h.logs.some((l) => l.includes('shopify connected'))).toBe(true);
    const all = h.bodies.join('\n') + h.logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(API_SECRET);
    expect(h.logs.join('\n')).not.toContain('good-code');
  });
});

describe('SEO editor: drafts, apply, verify, re-audit', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  let m: MockShopify;
  beforeAll(async () => {
    h = await setup({ SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_ADMIN_TOKEN: TOKEN });
    m = h.mock;
  });

  it('uses SHOPIFY_ADMIN_TOKEN on the primary website and reads its scopes', async () => {
    const st = (await h.admin.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st).toMatchObject({ connected: true, via: 'env_token', shop: SHOP, oauthConfigured: false });
    expect(st.scopes).toContain('write_products');
  });

  it('developers cannot edit content; seo specialists can', async () => {
    expect((await h.dev.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` })).status).toBe(403);
    const r = await h.seo.get(`/api/shopify/resolve?url=${encodeURIComponent(`${STOREFRONT}/collections/kitchen-tools/products/vegetable-chopper`)}`);
    expect(r.status).toBe(200);
    expect(r.body.resource).toMatchObject({ kind: 'product', id: 'gid://shopify/Product/1001', handle: 'vegetable-chopper' });
    const other = await h.seo.get(`/api/shopify/resolve?url=${encodeURIComponent('https://elsewhere.example/products/x')}`);
    expect(other.body.problem).toMatch(/not this website/);
    const home = await h.seo.get(`/api/shopify/resolve?url=${encodeURIComponent(`${STOREFRONT}/`)}`);
    expect(home.body.problem).toMatch(/theme/);
  });

  let product: ShopifyDraft;
  it('builds a product draft from existing text only, writing nothing', async () => {
    const r = await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` });
    expect(r.status).toBe(201);
    product = r.body;
    const f = Object.fromEntries(product.fields.map((x) => [x.key, x]));
    expect(f.seoTitle.source).toBe('suggested');
    expect(f.seoTitle.proposed.length).toBeLessThanOrEqual(60);
    expect(f.seoDescription.proposed).toMatch(/^Chop onions/);
    expect(f.bodyHtml.proposed).toContain('<h2>Vegetable Chopper</h2>');
    expect(f['imageAlt:gid://shopify/MediaImage/501'].proposed).toMatch(/^3 in 1 Multipurpose/);
    expect(f.title.mutation).toBe('productUpdate (title)');
    expect(f.seoTitle.mutation).toBe('productUpdate (seo.title)');
    expect(product.h1.basis).toBe('none');
    expect(m.mutations()).toEqual([]);
  });

  it('accepts manual edits and validates them (new figures flagged, scripts refused)', async () => {
    const r = await h.seo.patch(`/api/shopify/drafts/${product.id}`, { fields: { seoTitle: { proposed: 'Vegetable Chopper and Slicer, 500 ml – DeoDap Test' }, title: { proposed: '<b>x</b>' } } });
    const f = Object.fromEntries((r.body as ShopifyDraft).fields.map((x) => [x.key, x]));
    expect(f.seoTitle.source).toBe('manual');
    expect(f.seoTitle.validation.warnings.join(' ')).not.toMatch(/500 ml/);
    expect(f.title.validation.ok).toBe(false);
    const r2 = await h.seo.patch(`/api/shopify/drafts/${product.id}`, { fields: { seoTitle: { proposed: 'Vegetable Chopper 750 ml – DeoDap Test' }, title: { proposed: product.fields.find((x) => x.key === 'title')!.current, include: false } } });
    const t = (r2.body as ShopifyDraft).fields.find((x) => x.key === 'seoTitle')!;
    expect(t.validation.warnings.join(' ')).toMatch(/750 ml/);
    await h.seo.patch(`/api/shopify/drafts/${product.id}`, { fields: { seoTitle: { proposed: 'Vegetable Chopper and Slicer – DeoDap Test' } } });
  });

  it('downloads the original values before anything is applied', async () => {
    const r = await h.seo.get(`/api/shopify/drafts/backup?ids=${product.id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/shopify-originals-.*\.json/);
    const j = JSON.parse(r.text);
    expect(j.resources[0].values.seoTitle).toBe('');
    expect(j.resources[0].values.bodyHtml).toContain('<h1>Vegetable Chopper</h1>');
  });

  it('requires the exact confirmation phrase; a wrong phrase writes nothing', async () => {
    const pv = (await h.seo.post('/api/shopify/drafts/preview', { ids: [product.id] })).body as ShopifyApplyPreview;
    expect(pv.total).toBe(5);
    expect(pv.confirmPhrase).toBe('APPLY 5 CHANGES');
    expect(pv.conflicts).toBe(0);
    const bad = await h.seo.post('/api/shopify/drafts/apply', { ids: [product.id], confirm: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/APPLY 5 CHANGES/);
    expect(m.mutations()).toEqual([]);
  });

  it('applies through a rate limit, verifies by reading back, and re-audits the storefront', async () => {
    m.faults.push({ op: 'SentinelProductUpdate', kind: '429' });
    const r = await h.seo.post('/api/shopify/drafts/apply', { ids: [product.id], confirm: 'APPLY 5 CHANGES' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = r.body as ShopifyApplyBatchResult;
    expect(res).toMatchObject({ applied: 5, failed: 0, skipped: 0 });
    const d = res.drafts[0];
    expect(d.status).toBe('applied');
    expect(d.result!.verified).toBe(true);
    expect(d.result!.fields.every((f) => f.status === 'verified')).toBe(true);
    expect(m.mutations()).toEqual(['SentinelProductUpdate:429', 'SentinelProductUpdate', 'SentinelAlt']);
    const p = m.products.get('gid://shopify/Product/1001')!;
    expect(p.seo.title).toBe('Vegetable Chopper and Slicer – DeoDap Test');
    expect(p.descriptionHtml).toContain('<h2>Vegetable Chopper</h2>');
    expect(p.tags).toEqual(['kitchen', 'chopper']);
    expect(p.media[0].alt).toMatch(/^3 in 1/);
    const ra = d.result!.reaudit!;
    expect(ra.status).toBe(200);
    expect(ra.checks.map((c) => [c.field, c.ok])).toEqual(expect.arrayContaining([['Title tag', true], ['Meta description', true], ['H1 count', true], ['Image alt', true]]));
    expect(d.fields.find((f) => f.key === 'seoTitle')!.current).toBe('Vegetable Chopper and Slicer – DeoDap Test');
  });

  it('skips fields changed in Shopify since the draft (conflict) and keeps the merchant’s value', async () => {
    const d = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/collections/kitchen-tools` })).body as ShopifyDraft;
    expect(d.fields.find((f) => f.key === 'seoTitle')!.proposed).toBe('Kitchen Tools – DeoDap Test');
    m.collections.get('gid://shopify/Collection/2001')!.seo.title = 'Kitchen Tools Edited By Merchant';
    const pv = (await h.seo.post('/api/shopify/drafts/preview', { ids: [d.id] })).body as ShopifyApplyPreview;
    expect(pv.conflicts).toBe(1);
    expect(pv.total).toBe(1);
    const r = (await h.seo.post('/api/shopify/drafts/apply', { ids: [d.id], confirm: pv.confirmPhrase })).body as ShopifyApplyBatchResult;
    const out = r.drafts[0];
    expect(out.status).toBe('partial');
    expect(out.result!.fields.find((f) => f.key === 'seoTitle')!.status).toBe('conflict');
    expect(out.result!.fields.find((f) => f.key === 'seoDescription')!.status).toBe('verified');
    const c = m.collections.get('gid://shopify/Collection/2001')!;
    expect(c.seo.title).toBe('Kitchen Tools Edited By Merchant');
    expect(c.seo.description).toMatch(/^Useful tools/);
  });

  it('reports partial failures per field (Shopify userErrors) and continues with the batch', async () => {
    const page = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/pages/about-us` })).body as ShopifyDraft;
    const article = (await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/blogs/news/diwali-decor` })).body as ShopifyDraft;
    expect(page.fields.find((f) => f.key === 'seoTitle')!.mutation).toBe('metafieldsSet (global.title_tag)');
    expect(article.fields.find((f) => f.key === 'seoTitle')!.proposed.length).toBeLessThanOrEqual(60);
    m.faults.push({ op: 'SentinelSeoTags', kind: 'userErrors' });
    const pv = (await h.seo.post('/api/shopify/drafts/preview', { ids: [page.id, article.id] })).body as ShopifyApplyPreview;
    const r = (await h.seo.post('/api/shopify/drafts/apply', { ids: [page.id, article.id], confirm: pv.confirmPhrase })).body as ShopifyApplyBatchResult;
    const [p, a] = r.drafts;
    expect(p.status).toBe('partial');
    expect(p.result!.fields.find((f) => f.key === 'seoTitle')!.status).toBe('failed');
    expect(p.result!.fields.find((f) => f.key === 'seoTitle')!.message).toMatch(/Simulated validation error/);
    expect(p.result!.fields.find((f) => f.key === 'bodyHtml')!.status).toBe('verified');
    expect(a.status).toBe('applied');
    expect(m.articles.get('gid://shopify/Article/4001')!.meta.title_tag.length).toBeLessThanOrEqual(60);
    expect(r.failed).toBe(2);
  });

  it('theme work: separate permission, live theme refused, never published, conflicts detected, backup kept', async () => {
    expect((await h.seo.get('/api/shopify/themes')).status).toBe(403);
    const themes = (await h.dev.get('/api/shopify/themes')).body as ShopifyTheme[];
    expect(themes.map((t) => [t.role, t.writable])).toEqual([['MAIN', false], ['UNPUBLISHED', true]]);
    const [live, copy] = themes;
    const file = await h.dev.get(`/api/shopify/themes/file?themeId=${encodeURIComponent(copy.id)}&filename=sections/main-product.liquid`);
    expect(file.body.content).toContain('product__title');
    expect((await h.dev.get(`/api/shopify/themes/file?themeId=${encodeURIComponent(copy.id)}&filename=config/settings_data.json`)).status).toBe(400);
    const next = file.body.content.replace('<h1 class="product__title">', '<h1 class="product__title" data-seo="h1">');

    const onLive = (await h.dev.post('/api/shopify/theme-proposals', { themeId: live.id, filename: 'sections/main-product.liquid', content: next, reason: 'mark H1' })).body as ShopifyThemeProposal;
    expect(onLive.added).toBe(1);
    const refused = await h.dev.post(`/api/shopify/theme-proposals/${onLive.id}/apply`, { confirm: onLive.confirmPhrase });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('LIVE_THEME');

    const prop = (await h.dev.post('/api/shopify/theme-proposals', { themeId: copy.id, filename: 'sections/main-product.liquid', content: next, reason: 'mark H1' })).body as ShopifyThemeProposal;
    expect(prop.diff.some((l) => l.op === '+' && l.text.includes('data-seo'))).toBe(true);
    expect((prop as unknown as Record<string, unknown>).original).toBeUndefined();
    expect((await h.dev.post(`/api/shopify/theme-proposals/${prop.id}/apply`, { confirm: 'ok' })).status).toBe(400);
    expect(m.mutations().filter((x) => x.startsWith('SentinelThemeWrite'))).toEqual([]);
    const done = (await h.dev.post(`/api/shopify/theme-proposals/${prop.id}/apply`, { confirm: 'APPLY TO Dawn copy' })).body as ShopifyThemeProposal;
    expect(done.status).toBe('applied');
    expect(done.result!.verified).toBe(true);
    expect(m.themes[1].files.get('sections/main-product.liquid')).toContain('data-seo');
    expect(m.themes[0].files.get('sections/main-product.liquid')).not.toContain('data-seo');
    const backup = await h.dev.get(`/api/shopify/theme-proposals/${prop.id}/backup`);
    expect(backup.text).not.toContain('data-seo');

    const p2 = (await h.dev.post('/api/shopify/theme-proposals', { themeId: copy.id, filename: 'layout/theme.liquid', content: '<html>\n<head><title>x</title></head>\n<body>{{ content_for_layout }}</body>\n</html>\n', reason: 'title' })).body as ShopifyThemeProposal;
    m.themes[1].files.set('layout/theme.liquid', '<html>changed by someone</html>');
    const c2 = (await h.dev.post(`/api/shopify/theme-proposals/${p2.id}/apply`, { confirm: p2.confirmPhrase })).body as ShopifyThemeProposal;
    expect(c2.status).toBe('conflict');
    expect(m.themes[1].files.get('layout/theme.liquid')).toBe('<html>changed by someone</html>');
    expect(m.requests.some((r) => /themePublish/.test(r.body))).toBe(false);
  });

  it('re-audit can be run again on request', async () => {
    const r = await h.seo.post(`/api/shopify/drafts/${product.id}/reaudit`);
    expect(r.status).toBe(200);
    expect((r.body as ShopifyDraft).result!.reaudit!.checks.length).toBeGreaterThan(0);
  });

  it('disconnect drops the token and the drafts', async () => {
    expect((await h.seo.post('/api/shopify/disconnect')).status).toBe(403);
    const st = (await h.admin.post('/api/shopify/disconnect')).body as ShopifyStatus;
    expect(st.connected).toBe(false);
    expect((await h.seo.get('/api/shopify/drafts')).body).toEqual([]);
  });

  it('never exposes the token in responses or logs', () => {
    expect(h.logs.some((l) => l.includes('shopify.apply'))).toBe(true);
    const all = h.bodies.join('\n') + h.logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(h.mock.requests.filter((r) => r.headers['x-shopify-access-token']).every((r) => r.url.startsWith(`https://${SHOP}/admin/api/2026-07/`))).toBe(true);
  });
});

describe('missing scopes', () => {
  it('blocks editing and says which scopes are missing', async () => {
    const h = await setup({ SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_ADMIN_TOKEN: TOKEN });
    h.mock.setScopes(['write_products', 'read_content']);
    const st = (await h.admin.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st.missingScopes).toEqual(['write_content']);
    expect(st.capabilities.edit).toBe(false);
    expect(st.missingOptionalScopes).toEqual(['read_themes', 'write_themes', 'write_files']);
    const r = await h.seo.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/write_content/);
  });
});
