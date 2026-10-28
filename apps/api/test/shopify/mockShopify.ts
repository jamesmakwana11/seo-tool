/**
 * In-memory Shopify for tests: OAuth token exchange, the Admin GraphQL operations the SEO editor uses, and a storefront
 * that renders pages from the same state (so re-audits can be checked). No network, no real store.
 */
export const SHOP = 'sentinel-test.myshopify.com';
export const STOREFRONT = 'https://shop.sentinel-test.example';
export const TOKEN = 'shpat_mock_TOKEN_9f8e7d6c5b4a';
export const API_KEY = 'mock-client-id-1234';
export const API_SECRET = 'mock-client-secret-abcdef987654';

type Media = { id: string; alt: string | null; url: string };
interface Product { id: string; handle: string; title: string; descriptionHtml: string; tags: string[]; seo: { title: string | null; description: string | null }; media: Media[]; updatedAt: string }
interface Collection { id: string; handle: string; title: string; descriptionHtml: string; seo: { title: string | null; description: string | null }; image: { altText: string | null; url: string } | null; updatedAt: string }
interface Page { id: string; handle: string; title: string; body: string; meta: Record<string, string>; updatedAt: string; noTitleH1?: boolean }
interface Article extends Page { summary: string; tags: string[]; blog: string; image: { altText: string | null; url: string } | null }
interface Theme { id: string; name: string; role: string; files: Map<string, string> }

export type Fault = { op?: string; kind: '429' | '500' | 'throttled' | 'userErrors' | 'network'; times?: number };

export function createMockShopify() {
  const products = new Map<string, Product>();
  const collections = new Map<string, Collection>();
  const pages = new Map<string, Page>();
  const articles = new Map<string, Article>();
  const themes: Theme[] = [];
  const calls: { op: string; variables: Record<string, unknown>; raw: string }[] = [];
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  const faults: Fault[] = [];
  let scopes = ['write_products', 'write_content', 'write_themes', 'write_files'];
  let codes = new Set(['good-code']);
  const now = () => new Date().toISOString();

  products.set('gid://shopify/Product/1001', {
    id: 'gid://shopify/Product/1001', handle: 'vegetable-chopper',
    title: '3 in 1 Multipurpose Vegetable Chopper and Slicer with Stainless Steel Blades for Kitchen Use',
    descriptionHtml: '<h1>Vegetable Chopper</h1><p>Chop onions, tomatoes and herbs in seconds. The 500 ml bowl holds a whole salad.</p><p>Blades are stainless steel and easy to clean.</p>',
    tags: ['kitchen', 'Kitchen', 'chopper', ' '], seo: { title: null, description: null },
    media: [{ id: 'gid://shopify/MediaImage/501', alt: null, url: 'https://cdn.example/c1.jpg' }, { id: 'gid://shopify/MediaImage/502', alt: 'Chopper with lid open', url: 'https://cdn.example/c2.jpg' }],
    updatedAt: now(),
  });
  collections.set('gid://shopify/Collection/2001', {
    id: 'gid://shopify/Collection/2001', handle: 'kitchen-tools', title: 'Kitchen Tools', descriptionHtml: '<p>Useful tools for every Indian kitchen, from choppers to graters and peelers. Delivered across India.</p>',
    seo: { title: 'Kitchen Tools', description: 'Tools' }, image: { altText: null, url: 'https://cdn.example/kitchen.jpg' }, updatedAt: now(),
  });
  pages.set('gid://shopify/Page/3001', {
    id: 'gid://shopify/Page/3001', handle: 'about-us', title: 'About Us', body: '<h1>About DeoDap</h1><p>DeoDap ships household products from Rajkot since 2015. We pack every order by hand.</p>',
    meta: {}, updatedAt: now(),
  });
  // A page template that does not print the page title: the H1 is the one inside the page content.
  pages.set('gid://shopify/Page/3002', {
    id: 'gid://shopify/Page/3002', handle: 'bulk-orders', title: 'Bulk Orders', body: '<h1>Bulk orders</h1><p>Order 50 pieces or more of any DeoDap product at wholesale prices.</p>',
    meta: {}, updatedAt: now(), noTitleH1: true,
  });
  articles.set('gid://shopify/Article/4001', {
    id: 'gid://shopify/Article/4001', handle: 'diwali-decor', title: 'Diwali Decor Ideas', blog: 'news', body: '<p>Light up your home with these simple decor ideas for Diwali.</p>', summary: '', tags: ['diwali'], image: { altText: 'diya', url: 'https://cdn.example/diya.jpg' },
    meta: { title_tag: 'Diwali Decor Ideas for a Bright Festive Home This Year and Every Year After That Too' }, updatedAt: now(),
  });
  themes.push(
    { id: 'gid://shopify/OnlineStoreTheme/9001', name: 'Dawn (live)', role: 'MAIN', files: new Map([['sections/main-product.liquid', '<div>\n  <h1 class="product__title">{{ product.title }}</h1>\n</div>\n']]) },
    { id: 'gid://shopify/OnlineStoreTheme/9002', name: 'Dawn copy', role: 'UNPUBLISHED', files: new Map([['sections/main-product.liquid', '<div>\n  <h1 class="product__title">{{ product.title }}</h1>\n</div>\n'], ['layout/theme.liquid', '<html>\n<head></head>\n<body>{{ content_for_layout }}</body>\n</html>\n']]) },
  );

  const cost = (avail = 1000) => ({ requestedQueryCost: 20, actualQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: avail, restoreRate: 100 } });
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const ue = (field: string, message: string) => ({ userErrors: [{ field: [field], message }] });

  const prodOut = (p: Product) => ({ id: p.id, handle: p.handle, title: p.title, descriptionHtml: p.descriptionHtml, tags: p.tags, updatedAt: p.updatedAt, seo: p.seo, media: { nodes: p.media.map((m) => ({ id: m.id, alt: m.alt, image: { url: m.url } })) } });
  const colOut = (c: Collection) => ({ id: c.id, handle: c.handle, title: c.title, descriptionHtml: c.descriptionHtml, updatedAt: c.updatedAt, seo: c.seo, image: c.image });
  const pageOut = (p: Page) => ({ id: p.id, handle: p.handle, title: p.title, body: p.body, updatedAt: p.updatedAt, titleTag: p.meta.title_tag ? { value: p.meta.title_tag } : null, descTag: p.meta.description_tag ? { value: p.meta.description_tag } : null });
  const artOut = (a: Article) => ({ ...pageOut(a), summary: a.summary, tags: a.tags, blog: { handle: a.blog }, image: a.image });

  function graphql(op: string, v: Record<string, unknown>): unknown {
    switch (op) {
      case 'SentinelScopes': return { shop: { name: 'DeoDap Test', myshopifyDomain: SHOP }, currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } };
      case 'SentinelShop': return { shop: { name: 'DeoDap Test' } };
      case 'SentinelRead': {
        const id = String(v.id);
        const n = products.get(id) ? prodOut(products.get(id)!) : collections.get(id) ? colOut(collections.get(id)!) : pages.get(id) ? pageOut(pages.get(id)!) : articles.get(id) ? artOut(articles.get(id)!) : null;
        return { node: n };
      }
      case 'SentinelByHandle': {
        const h = String(v.h);
        const p = [...products.values()].find((x) => x.handle === h);
        const c = [...collections.values()].find((x) => x.handle === h);
        return { r: p ? prodOut(p) : c ? colOut(c) : null };
      }
      case 'SentinelSearch': {
        const h = JSON.parse(String(v.q).replace(/^handle:/, '')) as string;
        return { r: { nodes: [...[...pages.values()].filter((x) => x.handle === h).map(pageOut), ...[...articles.values()].filter((x) => x.handle === h).map(artOut)] } };
      }
      case 'SentinelList': return { r: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...products.values()].map(prodOut) } };
      case 'SentinelProductUpdate': {
        const inp = v.product as Partial<Product> & { id: string };
        const p = products.get(inp.id);
        if (!p) return { productUpdate: { product: null, ...ue('id', 'Product does not exist') } };
        if (inp.title !== undefined) p.title = inp.title;
        if (inp.descriptionHtml !== undefined) p.descriptionHtml = inp.descriptionHtml;
        if (inp.tags !== undefined) p.tags = inp.tags;
        if (inp.seo) p.seo = { title: inp.seo.title ?? null, description: inp.seo.description ?? null };
        p.updatedAt = now();
        return { productUpdate: { product: { id: p.id }, userErrors: [] } };
      }
      case 'SentinelCollectionUpdate': {
        const inp = v.input as Partial<Collection> & { id: string };
        const c = collections.get(inp.id)!;
        if (inp.title !== undefined) c.title = inp.title;
        if (inp.descriptionHtml !== undefined) c.descriptionHtml = inp.descriptionHtml;
        if (inp.seo) c.seo = { title: inp.seo.title ?? null, description: inp.seo.description ?? null };
        if (inp.image) { if (!c.image) return { collectionUpdate: { collection: null, ...ue('image', 'Collection has no image') } }; c.image.altText = inp.image.altText; }
        c.updatedAt = now();
        return { collectionUpdate: { collection: { id: c.id }, userErrors: [] } };
      }
      case 'SentinelPageUpdate': {
        const p = pages.get(String(v.id))!;
        const inp = v.page as { title?: string; body?: string };
        if (inp.title !== undefined) p.title = inp.title;
        if (inp.body !== undefined) p.body = inp.body;
        return { pageUpdate: { page: { id: p.id }, userErrors: [] } };
      }
      case 'SentinelArticleUpdate': {
        const a = articles.get(String(v.id))!;
        const { image, ...inp } = v.article as { title?: string; body?: string; summary?: string; tags?: string[]; image?: { altText: string } };
        Object.assign(a, Object.fromEntries(Object.entries(inp).filter(([, x]) => x !== undefined)));
        if (image) { if (!a.image) return { articleUpdate: { article: null, ...ue('image', 'Article has no image') } }; a.image.altText = image.altText; }
        return { articleUpdate: { article: { id: a.id }, userErrors: [] } };
      }
      case 'SentinelSeoTags': {
        for (const m of v.m as { ownerId: string; namespace: string; key: string; value: string }[]) {
          const o = pages.get(m.ownerId) ?? articles.get(m.ownerId);
          if (!o) return { metafieldsSet: { metafields: [], ...ue('ownerId', 'Owner not found') } };
          o.meta[m.key] = m.value;
        }
        return { metafieldsSet: { metafields: [], userErrors: [] } };
      }
      case 'SentinelAlt': {
        for (const f of v.files as { id: string; alt: string }[]) {
          const m = [...products.values()].flatMap((p) => p.media).find((x) => x.id === f.id);
          if (!m) return { fileUpdate: { files: [], ...ue('id', 'File not found') } };
          m.alt = f.alt;
        }
        return { fileUpdate: { files: [], userErrors: [] } };
      }
      case 'SentinelThemes': return { themes: { nodes: themes.map((t) => ({ id: t.id, name: t.name, role: t.role, updatedAt: now() })) } };
      case 'SentinelThemeFile': {
        const t = themes.find((x) => x.id === v.id);
        const name = (v.f as string[])[0];
        const content = t?.files.get(name);
        return { theme: t ? { files: { nodes: content === undefined ? [] : [{ filename: name, checksumMd5: null, size: content.length, body: { content } }] } } : null };
      }
      case 'SentinelThemeFileList': {
        const t = themes.find((x) => x.id === v.id);
        if (!t) return { theme: null };
        const names = [...t.files.keys()].sort();
        const start = v.after ? Number(v.after) : 0;
        const slice = names.slice(start, start + 250);
        return { theme: { files: { nodes: slice.map((f) => ({ filename: f, size: t.files.get(f)!.length, checksumMd5: null })), pageInfo: { hasNextPage: start + 250 < names.length, endCursor: String(start + 250) } } } };
      }
      case 'SentinelThemeFiles': {
        const t = themes.find((x) => x.id === v.id);
        if (!t) return { theme: null };
        return { theme: { files: { nodes: (v.f as string[]).filter((f) => t.files.has(f)).map((f) => ({ filename: f, body: { content: t.files.get(f) } })) } } };
      }
      case 'SentinelThemeWrite': {
        const t = themes.find((x) => x.id === v.themeId)!;
        for (const f of v.files as { filename: string; body: { value: string } }[]) t.files.set(f.filename, f.body.value);
        return { themeFilesUpsert: { upsertedThemeFiles: [], userErrors: [] } };
      }
      default: throw new Error(`mock: unknown operation ${op}`);
    }
  }

  function storefront(path: string): Response {
    const page = (title: string, desc: string | null, body: string, imgs: Media[] = []) => new Response(
      `<!doctype html><html><head><title>${title.includes('DeoDap Test') ? title : `${title} – DeoDap Test`}</title>${desc ? `<meta name="description" content="${desc.replace(/"/g, '&quot;')}">` : ''}</head><body><main>${body}${imgs.map((m) => `<img src="${m.url}" alt="${m.alt ?? ''}">`).join('')}</main></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
    const seg = path.split('/').filter(Boolean);
    if (seg[0] === 'products') {
      const p = [...products.values()].find((x) => x.handle === seg[1]);
      if (p) return page(p.seo.title || p.title, p.seo.description, `<h1 class="product__title">${p.title}</h1>${p.descriptionHtml}`, p.media);
    }
    if (seg[0] === 'collections') {
      // The H1 is whatever the live theme's banner section renders (hard-coded text, or {{ collection.title }}).
      const c = [...collections.values()].find((x) => x.handle === seg[1]);
      const banner = themes.find((t) => t.role === 'MAIN')?.files.get('sections/main-collection-banner.liquid') ?? '';
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(banner)?.[1].replace('{{ collection.title }}', c?.title ?? '') ?? '';
      if (c) return page(c.seo.title || c.title, c.seo.description, `${h1 ? `<h1 class="collection-hero__title">${h1}</h1>` : ''}${c.descriptionHtml}`, c.image ? [{ id: 'featured', alt: c.image.altText, url: c.image.url }] : []);
    }
    if (seg[0] === 'pages') {
      const p = [...pages.values()].find((x) => x.handle === seg[1]);
      if (p) return page(p.meta.title_tag || p.title, p.meta.description_tag ?? null, `${p.noTitleH1 ? '' : `<h1>${p.title}</h1>`}${p.body}`);
    }
    return new Response('not found', { status: 404 });
  }

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ url, body, headers });
    if (u.origin === STOREFRONT) return storefront(u.pathname);
    if (u.host !== SHOP) throw new Error(`mock: no network for ${u.host}`);
    if (u.pathname === '/admin/oauth/access_token') {
      const form = new URLSearchParams(body);
      if (form.get('client_id') !== API_KEY || form.get('client_secret') !== API_SECRET || !codes.has(form.get('code') ?? '')) return json({ error: 'invalid_request' }, 400);
      codes.delete(form.get('code')!);
      return json({ access_token: TOKEN, scope: scopes.join(',') });
    }
    if (!/^\/admin\/api\/[\w-]+\/graphql\.json$/.test(u.pathname)) return json({ errors: 'Not Found' }, 404);
    if (headers['x-shopify-access-token'] !== TOKEN) return json({ errors: '[API] Invalid API key or access token' }, 401);
    const { query, variables } = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'anonymous';
    const fi = faults.findIndex((f) => !f.op || f.op === op);
    if (fi >= 0) {
      const f = faults[fi];
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) faults.splice(fi, 1);
      calls.push({ op: `${op}:${f.kind}`, variables, raw: body });
      if (f.kind === '429') return json({ errors: 'Throttled' }, 429, { 'retry-after': '1' });
      if (f.kind === '500') return json({ errors: 'Internal' }, 500);
      if (f.kind === 'network') throw new TypeError('fetch failed');
      if (f.kind === 'throttled') return json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { ...cost(5), requestedQueryCost: 205 } } });
      if (f.kind === 'userErrors') {
        const key = ({ SentinelProductUpdate: 'productUpdate', SentinelCollectionUpdate: 'collectionUpdate', SentinelPageUpdate: 'pageUpdate', SentinelArticleUpdate: 'articleUpdate', SentinelSeoTags: 'metafieldsSet', SentinelAlt: 'fileUpdate', SentinelThemeWrite: 'themeFilesUpsert' } as Record<string, string>)[op] ?? 'x';
        return json({ data: { [key]: { userErrors: [{ field: ['input'], message: 'Simulated validation error from Shopify' }] } }, extensions: { cost: cost() } });
      }
    }
    calls.push({ op, variables, raw: body });
    return json({ data: graphql(op, variables), extensions: { cost: cost() } });
  };

  return {
    fetchImpl, products, collections, pages, articles, themes, calls, requests, faults,
    setScopes: (s: string[]) => { scopes = s; },
    addCode: (c: string) => { codes.add(c); },
    resetCodes: () => { codes = new Set(); },
    mutations: () => calls.filter((c) => /Update|Set|Tags|Alt|Write/.test(c.op)).map((c) => c.op),
  };
}
export type MockShopify = ReturnType<typeof createMockShopify>;
