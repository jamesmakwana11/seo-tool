/** Shopify building blocks: OAuth checks, the rate-limit-aware client, draft suggestions/validation, theme diff. No network. */
import { describe, expect, it } from 'vitest';
import { createAdminClient, ShopifyApiError } from '../../src/shopify/client';
import { buildFields, demoteBodyH1, detectH1Sources, leadSentences, newWords, shorten, sourceTexts, unsupportedFigures, validateField } from '../../src/shopify/drafts';
import { authorizeUrl, createStateStore, hmacMessage, missingScopes, normalizeShop, signQuery, verifyQueryHmac, STATE_TTL_MS } from '../../src/shopify/oauth';
import { parseStorefrontPath, sameValue, writeOps, type ShopifyResource } from '../../src/shopify/resources';
import { lineDiff } from '../../src/shopify/theme';

describe('Shopify OAuth checks', () => {
  it('accepts only *.myshopify.com shops', () => {
    expect(normalizeShop('deodap')).toBe('deodap.myshopify.com');
    expect(normalizeShop('https://DeoDap.myshopify.com/admin')).toBe('deodap.myshopify.com');
    expect(normalizeShop('deodap.in')).toBeUndefined();
    expect(normalizeShop('evil.com/.myshopify.com')).toBeUndefined();
    expect(normalizeShop('x.myshopify.com.evil.com')).toBeUndefined();
    expect(normalizeShop('-bad.myshopify.com')).toBeUndefined();
  });

  it('verifies the callback hmac over the sorted parameters (constant-time, tamper-proof)', () => {
    const q = { shop: 'a.myshopify.com', code: 'abc', state: 's1', timestamp: '1700000000', host: 'aG9zdA' };
    expect(hmacMessage(q)).toBe('code=abc&host=aG9zdA&shop=a.myshopify.com&state=s1&timestamp=1700000000');
    const hmac = signQuery(q, 'secret-1');
    expect(verifyQueryHmac({ ...q, hmac }, 'secret-1')).toBe(true);
    expect(verifyQueryHmac({ ...q, hmac }, 'secret-2')).toBe(false);
    expect(verifyQueryHmac({ ...q, code: 'abd', hmac }, 'secret-1')).toBe(false);
    expect(verifyQueryHmac({ ...q, hmac: hmac.slice(0, 10) }, 'secret-1')).toBe(false);
    expect(verifyQueryHmac({ ...q }, 'secret-1')).toBe(false);
  });

  it('builds an offline-token authorize URL', () => {
    const u = new URL(authorizeUrl({ shop: 'a.myshopify.com', apiKey: 'k', scopes: ['read_products', 'write_products'], redirectUri: 'https://app.example/api/shopify/oauth/callback', state: 'st' }));
    expect(u.host).toBe('a.myshopify.com');
    expect(u.pathname).toBe('/admin/oauth/authorize');
    expect(u.searchParams.get('scope')).toBe('read_products,write_products');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.has('grant_options[]')).toBe(false);
  });

  it('write scopes include read scopes', () => {
    expect(missingScopes(['read_products', 'write_products', 'read_content'], ['write_products'])).toEqual(['read_content']);
  });

  it('states are single-use and expire after 10 minutes', () => {
    let t = 1_000_000;
    const st = createStateStore(() => t);
    const a = st.issue({ shop: 's.myshopify.com', actorId: 'E1', actorName: 'A', owner: 'o' });
    expect(st.consume(a.state)?.shop).toBe('s.myshopify.com');
    expect(st.consume(a.state)).toBeUndefined();
    const b = st.issue({ shop: 's.myshopify.com', actorId: 'E1', actorName: 'A', owner: 'o' });
    t += STATE_TTL_MS + 1;
    expect(st.consume(b.state)).toBeUndefined();
    expect(st.consume(undefined)).toBeUndefined();
  });
});

describe('Admin API client', () => {
  const TOKEN = 'shpat_SECRET_token_value_123';
  const ok = (data: unknown, avail = 1000) => new Response(JSON.stringify({ data, extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: avail, restoreRate: 50 } } } }), { status: 200 });
  function client(responses: (() => Response | Promise<Response>)[]) {
    const waits: number[] = [];
    let i = 0;
    const seen: RequestInit[] = [];
    const c = createAdminClient({ shop: 'a.myshopify.com', token: TOKEN, apiVersion: '2026-07', fetchImpl: async (_u, init) => { seen.push(init!); return responses[Math.min(i++, responses.length - 1)](); }, sleep: async (ms) => { waits.push(ms); } });
    return { c, waits, seen };
  }

  it('retries 429 after Retry-After and succeeds', async () => {
    const { c, waits } = client([() => new Response('{}', { status: 429, headers: { 'retry-after': '3' } }), () => ok({ x: 1 })]);
    expect(await c.request('query A { x }')).toEqual({ x: 1 });
    expect(waits).toEqual([3000]);
    expect(c.stats.retries).toBe(1);
  });

  it('waits for the cost bucket on THROTTLED and retries', async () => {
    const { c, waits } = client([
      () => new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 300, throttleStatus: { currentlyAvailable: 50, restoreRate: 50 } } } }), { status: 200 }),
      () => ok({ y: 2 }),
    ]);
    expect(await c.request('query A { y }')).toEqual({ y: 2 });
    expect(waits[0]).toBe(5000);
  });

  it('slows down before the bucket runs out', async () => {
    const { c, waits } = client([() => ok({ a: 1 }, 20), () => ok({ a: 2 })]);
    await c.request('query A { a }');
    await c.request('query A { a }');
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('retries 5xx with back-off, then fails with a retryable error', async () => {
    const { c, waits } = client([() => new Response('oops', { status: 503 })]);
    const e = await c.request('query A { x }').catch((x) => x);
    expect(e).toBeInstanceOf(ShopifyApiError);
    expect(e.info.retryable).toBe(true);
    expect(waits.length).toBe(4);
  });

  it('does not retry 401 and never puts the token in errors', async () => {
    const { c, waits, seen } = client([() => new Response(JSON.stringify({ errors: `bad token ${TOKEN}` }), { status: 401 })]);
    const e = await c.request('query A { x }').catch((x) => x);
    expect(e.info.status).toBe(401);
    expect(waits.length).toBe(0);
    expect(String(e.message)).not.toContain(TOKEN);
    expect((seen[0].headers as Record<string, string>)['x-shopify-access-token']).toBe(TOKEN);
  });

  it('scrubs the token from GraphQL error text', async () => {
    const { c } = client([() => new Response(JSON.stringify({ errors: [{ message: `field error near ${TOKEN}` }] }), { status: 200 })]);
    const e = await c.request('query A { x }').catch((x) => x);
    expect(String(e.message)).toContain('[redacted]');
    expect(String(e.message)).not.toContain(TOKEN);
  });
});

const product = (o: Partial<ShopifyResource> = {}): ShopifyResource => ({
  kind: 'product', id: 'gid://shopify/Product/1', handle: 'chopper', path: '/products/chopper',
  title: '3 in 1 Multipurpose Vegetable Chopper and Slicer with Stainless Steel Blades for Kitchen Use',
  seoTitle: '', seoDescription: '',
  bodyHtml: '<h1>Vegetable Chopper</h1><p>Chop onions, tomatoes and herbs in seconds. The 500 ml bowl holds a whole salad.</p><p>Blades are stainless steel and easy to clean.</p>',
  tags: ['kitchen', 'Kitchen', 'chopper'], images: [{ id: 'gid://shopify/MediaImage/5', alt: '' }, { id: 'gid://shopify/MediaImage/6', alt: 'Lid open' }], ...o,
});

describe('SEO editor drafts', () => {
  it('suggests only text that already exists on the resource (no invented facts)', () => {
    const res = product();
    const fields = buildFields({ res, shopName: 'DeoDap', siteHost: 'deodap.test', pageH1s: [res.title, 'Vegetable Chopper'], h1Basis: 'crawl' });
    const suggested = fields.filter((f) => f.source === 'suggested');
    expect(suggested.map((f) => f.key).sort()).toEqual(['bodyHtml', 'imageAlt:gid://shopify/MediaImage/5', 'seoDescription', 'seoTitle', 'tags', 'title'].sort());
    // The 90-character product title gets a shortened suggestion for review — never pre-selected (wording is a human call).
    expect(fields.find((f) => f.key === 'title')!).toMatchObject({ include: false, suggestion: { confidence: 'review', keep: false } });
    expect(suggested.filter((f) => f.include).map((f) => f.key).sort()).toEqual(['bodyHtml', 'imageAlt:gid://shopify/MediaImage/5', 'seoDescription', 'seoTitle', 'tags'].sort());
    const sources = sourceTexts(res, 'DeoDap');
    for (const f of suggested) expect(newWords(f.key === 'bodyHtml' ? f.proposed.replace(/<[^>]+>/g, ' ') : f.proposed, [...sources, 'image']), f.key).toEqual([]);
    const title = fields.find((f) => f.key === 'seoTitle')!;
    expect(title.proposed.length).toBeLessThanOrEqual(60);
    expect(title.reason).toMatch(/Shortened/);
    expect(fields.find((f) => f.key === 'seoDescription')!.proposed).toBe('Chop onions, tomatoes and herbs in seconds. The 500 ml bowl holds a whole salad. Blades are stainless steel and easy to clean.');
    expect(fields.find((f) => f.key === 'bodyHtml')!.proposed).toContain('<h2>Vegetable Chopper</h2>');
    expect(fields.find((f) => f.key === 'tags')!.proposed).toBe('kitchen, chopper');
    expect(fields.find((f) => f.key === 'imageAlt:gid://shopify/MediaImage/6')!.source).toBe('unchanged');
    expect(fields.every((f) => f.applyVia === 'admin_api' && f.mutation)).toBe(true);
  });

  it('detects where each H1 comes from', () => {
    const res = product();
    const r = detectH1Sources(res, [res.title, 'Vegetable Chopper', 'Free shipping over ₹499'], 'crawl');
    expect(r.sources.map((s) => [s.source, s.applyVia])).toEqual([['title', 'admin_api'], ['body', 'admin_api'], ['theme', 'theme']]);
    expect(r.summary).toMatch(/3 H1s/);
    expect(detectH1Sources(res, [], 'none').summary).toMatch(/No crawl data/);
  });

  it('validates content and flags new figures typed by hand', () => {
    const res = product();
    const ctx = { res, siteHost: 'deodap.test', current: res.bodyHtml, sources: sourceTexts(res), source: 'manual' as const };
    expect(validateField('bodyHtml', '<p>x</p><script>alert(1)</script>', ctx).ok).toBe(false);
    expect(validateField('bodyHtml', '<a href="javascript:alert(1)">x</a>', ctx).ok).toBe(false);
    expect(validateField('bodyHtml', '<p onclick="x()">x</p>', ctx).ok).toBe(false);
    const links = validateField('bodyHtml', '<h2>A</h2><h4>B</h4><p><a href="http://deodap.test/collections/x/products/y">see</a></p>', ctx);
    expect(links.ok).toBe(true);
    expect(links.warnings.join(' ')).toMatch(/skipped/);
    expect(links.warnings.join(' ')).toMatch(/http:\/\//);
    expect(links.warnings.join(' ')).toMatch(/collection-scoped/);
    expect(validateField('title', '  ', { ...ctx, current: res.title }).ok).toBe(false);
    const figs = validateField('seoDescription', 'Holds 750 ml and lasts 5 years.', { ...ctx, current: '' });
    expect(figs.warnings.join(' ')).toMatch(/750 ml/);
    expect(unsupportedFigures('Holds 500 ml.', sourceTexts(res))).toEqual([]);
    expect(validateField('seoTitle', '', { ...ctx, current: 'Old title' }).ok).toBe(false);
  });

  it('text helpers keep whole words and sentences', () => {
    expect(shorten('alpha beta gamma delta', 12)).toBe('alpha beta');
    expect(shorten('3 in 1 Multipurpose Vegetable Chopper and Slicer with Stainless Steel Blades', 60)).toBe('3 in 1 Multipurpose Vegetable Chopper and Slicer');
    expect(leadSentences('One sentence here that is long enough to count. Two. Three is longer than the limit allows for sure.', 60)).toBe('One sentence here that is long enough to count. Two.');
    expect(demoteBodyH1('<h1 class="x">A</h1><p>b</p>')).toBe('<h2 class="x">A</h2><p>b</p>');
  });
});

describe('resources', () => {
  it('maps storefront URLs to resources (locale prefixes and collection-scoped products included)', () => {
    expect(parseStorefrontPath('https://deodap.in/products/abc')).toEqual({ kind: 'product', handle: 'abc' });
    expect(parseStorefrontPath('https://deodap.in/collections/kitchen/products/abc')).toEqual({ kind: 'product', handle: 'abc' });
    expect(parseStorefrontPath('https://deodap.in/hi/collections/kitchen')).toEqual({ kind: 'collection', handle: 'kitchen' });
    expect(parseStorefrontPath('https://deodap.in/pages/about-us/')).toEqual({ kind: 'page', handle: 'about-us' });
    expect(parseStorefrontPath('https://deodap.in/blogs/news/diwali')).toEqual({ kind: 'article', blogHandle: 'news', handle: 'diwali' });
    expect(parseStorefrontPath('https://deodap.in/blogs/news/tagged/x')).toBeUndefined();
    expect(parseStorefrontPath('https://deodap.in/search?q=x')).toBeUndefined();
  });

  it('plans the right mutations, keeping the other SEO field at its live value', () => {
    const live = product({ seoTitle: 'Live title', seoDescription: 'Live description' });
    const ops = writeOps(live, { seoDescription: 'New description', 'imageAlt:gid://shopify/MediaImage/5': 'Chopper' });
    expect(ops.map((o) => o.name)).toEqual(['productUpdate', 'fileUpdate']);
    const page = { ...live, kind: 'page' as const, id: 'gid://shopify/Page/1' };
    expect(writeOps(page, { seoTitle: 'T', bodyHtml: '<p>x</p>' }).map((o) => o.name)).toEqual(['pageUpdate', 'metafieldsSet']);
    expect(sameValue('bodyHtml', '<p>a</p>\n<p>b</p>', '<p>a</p><p>b</p>')).toBe(true);
    expect(sameValue('tags', 'b, a', 'a,b')).toBe(true);
  });
});

describe('theme diff', () => {
  it('shows changed lines with context', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 15', '<h2>line 15</h2>');
    const d = lineDiff(a, b);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines.filter((l) => l.op === '-').map((l) => l.text)).toEqual(['line 15']);
    expect(d.lines.filter((l) => l.op === '…').length).toBe(2);
  });
});
