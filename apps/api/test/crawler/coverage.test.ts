import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CrawlOutcome, PreviousCrawlState } from '../../src/services/ports';
import { findingsFor, makeEngine, urlsOf } from './helpers';

/**
 * Coverage for analyzers that the main fixture-store suite does not assert on. A small purpose-built store serves
 * pages that each carry deliberate defects; a second loopback server plays the third-party / outbound host.
 * Crawl 1 records the baseline (third-party JS ≈ 20 KB); crawl 2 runs with the widget grown to ≈ 200 KB.
 * Every assertion names the check id AND the URL that must be flagged — a finding elsewhere does not count.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 17}`).join(' ');

let ext: http.Server;
let site: http.Server;
let EXT = '';
let SITE = '';
let widgetKb = 20;
let outcome: Omit<CrawlOutcome, 'run'> & { snapshot?: PreviousCrawlState };

interface PageOpts {
  title: string; desc?: string; canonical?: string; ogImage?: boolean; jsonld?: unknown[]; body: string; footer?: string;
}
function page(o: PageOpts, path: string): string {
  const canonical = o.canonical ?? `${SITE}${path}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>${o.desc ? `<meta name="description" content="${esc(o.desc)}">` : ''}
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(o.title)}"><meta property="og:url" content="${canonical}">${o.ogImage === false ? '' : `<meta property="og:image" content="${SITE}/cdn/og.webp">`}
<meta name="twitter:card" content="summary_large_image">
<script src="${EXT}/js/widget.js" defer></script>
${(o.jsonld ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head><body><header><a href="/">DeoDap</a></header><main id="MainContent">${o.body}</main>
<footer>${o.footer ?? '<p>© DeoDap</p>'}</footer></body></html>`;
}

const glass = (ml: number) => {
  const h1 = `Glass Jar ${ml}ml`;
  return {
    path: `/products/glass-jar-${ml}`,
    html: () => page({
      title: `${h1} | DeoDap`, desc: `${h1} for kitchen storage.`,
      body: `<h1>${h1}</h1><div class="product__description rte"><p>The ${h1} keeps food fresh, looks great on any shelf and is easy to clean every day. Choose the ${h1} for pantry staples, snacks and spices in every modern kitchen. Order the ${h1} today for fast delivery across India.</p></div>`,
    }, `/products/glass-jar-${ml}`),
  };
};

const CITIES = ['Ahmedabad', 'Surat', 'Rajkot'];
const doorway = (city: string) => {
  const h1 = `Kitchen Supplies in ${city}`;
  return {
    path: `/pages/kitchen-supplies-${city.toLowerCase()}`,
    html: () => page({
      title: `${h1} | DeoDap`, desc: h1,
      body: `<h1>${h1}</h1><p>Looking for ${h1}? We deliver ${h1} to shops, homes and resellers with quick dispatch, secure packing and cash on delivery for every order of ${h1} placed through our website this season.</p><p>Browse the <a href="/collections/kitchen">kitchen collection</a>.</p>`,
    }, `/pages/kitchen-supplies-${city.toLowerCase()}`),
  };
};

const STUFFED = 'Steel Water Bottle';
const ROUTES: Record<string, () => string> = {
  '/': () => page({
    title: 'DeoDap – Kitchen Storage Online', desc: 'Kitchen storage online.',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'WebSite', name: 'DeoDap', url: `${SITE}/` }], // no Organization (AEO-ENTITY, ONP-TPL-HOME)
    body: `<h1>Kitchen storage for every home</h1><p>Wholesale kitchen storage with free shipping.</p>
<ul><li><a href="/collections/kitchen">Kitchen</a></li>${[500, 750, 1000].map((m) => `<li><a href="/products/glass-jar-${m}">Glass Jar ${m}ml</a></li>`).join('')}
<li><a href="/products/steel-water-bottle">${STUFFED}</a></li><li><a href="/blogs/news/best-storage-tips">Storage tips</a></li><li><a href="/blogs/news/old-diwali-guide">Diwali guide</a></li>
<li><a href="/pages/wholesale">Wholesale</a></li>${CITIES.map((c) => `<li><a href="/pages/kitchen-supplies-${c.toLowerCase()}">${c}</a></li>`).join('')}
<li><a href="/pages/missing-page">Bulk order form</a></li><li><a href="${EXT}/gone">Our supplier</a></li></ul>`,
  }, '/'),
  '/collections/kitchen': () => page({
    title: 'Kitchen | DeoDap', desc: 'Kitchen storage.', ogImage: false, // ONP-OG
    // No breadcrumb (ONP-BREADCRUMBS), H1 → H3 skip (ONP-HEADINGS), no FAQ (AEO-FAQ), thin description (ONP-TPL-COLLECTION).
    body: `<h1>Kitchen</h1><h3>Popular picks</h3><div class="collection__description"><p>Kitchen storage.</p></div>
<ul>${[500, 750, 1000].map((m) => `<li><a href="/products/glass-jar-${m}">Glass Jar ${m}ml</a></li>`).join('')}<li><a href="/collections/kitchen/products/steel-water-bottle">${STUFFED}</a></li></ul>
<p><a href="/collections/kitchen?page=2">Next page</a> <a href="/collections/kitchen?filter.v.color=red">Red only</a></p>`,
  }, '/collections/kitchen'),
  ...Object.fromEntries([500, 750, 1000].map((m) => { const g = glass(m); return [g.path, g.html]; })),
  '/products/steel-water-bottle': () => page({
    title: `${STUFFED} | DeoDap`, desc: STUFFED,
    // Keyword stuffing (AIC-09), literal markdown + stale "as of 2023" (AIC-12), no experience signals (CONT-AI-RISK).
    body: `<h1>${STUFFED}</h1><div class="product__description rte"><p>**Premium quality** ${STUFFED} for daily use. Buy the ${STUFFED} online. This ${STUFFED} is the best ${STUFFED} and every ${STUFFED} ships fast. As of 2023 our ${STUFFED} range keeps drinks cold, and the ${STUFFED} fits bags. Pick a ${STUFFED} in blue or a ${STUFFED} in black. ${words(40, 'bottle')}</p></div>`,
  }, '/products/steel-water-bottle'),
  '/blogs/news/best-storage-tips': () => page({
    title: 'Best Storage Tips: A Complete Guide | DeoDap', desc: 'Storage tips.',
    // Anonymous advice (AIC-05, AIC-11), no dates (GEO-FRESHNESS), 350 words under one heading (GEO-STRUCTURE), no question H2 (AEO-ANSWER-BLOCK),
    // no quotable format (AEO-EXTRACTABILITY).
    body: `<h1>Best storage tips</h1>${Array.from({ length: 7 }, (_, i) => `<p>${words(50, `tip${i}x`)}.</p>`).join('')}`,
  }, '/blogs/news/best-storage-tips'),
  '/blogs/news/old-diwali-guide': () => page({
    title: 'Diwali Decor Ideas | DeoDap', desc: 'Diwali decor.',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Article', headline: 'Diwali Decor Ideas', author: { '@type': 'Person', name: 'Rahul Mehta' }, datePublished: '2024-10-01', dateModified: '2025-01-05' }],
    body: `<h1>Diwali decor ideas</h1><p class="article__meta">By <span class="article__author">Rahul Mehta</span> · Last updated <time datetime="2025-01-05">2025-01-05</time></p><h2>Lights</h2><p>${words(60, 'lamp')}</p>`,
  }, '/blogs/news/old-diwali-guide'),
  '/pages/wholesale': () => page({ title: 'Wholesale | DeoDap', desc: 'Wholesale.', body: '<h1>Wholesale</h1><p>Contact us for wholesale rates on kitchen storage products. We ship across India. Minimum order quantities apply on some items. Write to us today.</p>' }, '/pages/wholesale'),
  ...Object.fromEntries(CITIES.map((c) => { const d = doorway(c); return [d.path, d.html]; })),
};

function serveSite(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url ?? '/', SITE);
  const send = (status: number, body: string, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)) });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (u.pathname === '/robots.txt') return send(200, `User-agent: *\nDisallow: /cart\nSitemap: ${SITE}/sitemap.xml\n`, 'text/plain');
  if (u.pathname === '/sitemap.xml') return send(200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(ROUTES).map((p) => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`, 'application/xml');
  if (u.pathname === '/collections/kitchen' && u.search) {
    // ?page=2 canonicalized to page 1 (TECH-PAGINATION); ?filter.* self-canonical and indexable (TECH-CRAWL-BUDGET).
    const canonical = u.searchParams.has('page') ? `${SITE}/collections/kitchen` : `${SITE}${u.pathname}${u.search}`;
    return send(200, page({ title: 'Kitchen | DeoDap', desc: 'Kitchen storage.', canonical, body: `<h1>Kitchen</h1><p>${words(30, 'item')}</p>` }, u.pathname));
  }
  const scoped = /^\/collections\/[^/]+\/products\/([^/]+)$/.exec(u.pathname);
  if (scoped && ROUTES[`/products/${scoped[1]}`]) {
    // Collection-scoped product URL that canonicalizes to itself instead of /products/{handle} (TECH-SHOPIFY-DUP-PATHS).
    return send(200, ROUTES[`/products/${scoped[1]}`]().replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${SITE}${u.pathname}">`));
  }
  const r = ROUTES[u.pathname];
  if (r) return send(200, r());
  return send(404, '<h1>Page not found</h1>'); // /pages/missing-page → TECH-BROKEN-INTERNAL
}

function serveExt(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/js/widget.js') {
    const body = `/*widget*/${'x'.repeat(widgetKb * 1024)}`;
    res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': String(Buffer.byteLength(body)) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(404, { 'content-type': 'text/plain', 'content-length': '9' });
  res.end(req.method === 'HEAD' ? undefined : 'not found'); // /gone → TECH-BROKEN-OUTBOUND
}

const listen = (s: http.Server, host: string) => new Promise<number>((r) => s.listen(0, host, () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  ext = http.createServer(serveExt);
  site = http.createServer(serveSite);
  // Different host names → the widget and /gone are third-party / outbound from the site's point of view.
  EXT = `http://localhost:${await listen(ext, '127.0.0.1')}`;
  SITE = `http://127.0.0.1:${await listen(site, '127.0.0.1')}`;
  const tierOf = (u: string) => (['/', '/blogs/news/old-diwali-guide'].includes(new URL(u).pathname) ? 1 : 2) as 1 | 2;
  const urls = Object.keys(ROUTES).map((p) => ({ url: `${SITE}${p}`, reason: 'top_product' as const }));
  const plan = { type: 'smart' as const, baseUrl: SITE, maxPages: 60, tierOf, urls };
  const engine = makeEngine(SITE, { timeoutMs: 3000 });
  const first = await engine.run(plan);
  widgetKb = 200;
  outcome = await engine.run({ ...plan, previous: first.snapshot });
}, 60_000);

afterAll(async () => {
  for (const s of [site, ext]) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

const at = (p: string) => `${SITE}${p}`;
const flagged = (checkId: string) => urlsOf(findingsFor(outcome.findings, checkId));
function expectFlag(checkId: string, path: string) {
  expect(outcome.evaluatedChecks, `${checkId} should be evaluated`).toContain(checkId);
  expect(flagged(checkId), `${checkId} should flag ${path}`).toContain(at(path));
}

describe('technical analyzers', () => {
  it('TECH-PAGINATION: ?page=2 canonicalized to page 1', () => expectFlag('TECH-PAGINATION', '/collections/kitchen?page=2'));
  it('TECH-CRAWL-BUDGET: a filter URL that is crawlable, self-canonical and indexable', () => expectFlag('TECH-CRAWL-BUDGET', '/collections/kitchen?filter.v.color=red'));
  it('TECH-BROKEN-INTERNAL: the homepage links to a 404', () => expectFlag('TECH-BROKEN-INTERNAL', '/'));
  it('TECH-BROKEN-OUTBOUND: the homepage links to a dead external page', () => expectFlag('TECH-BROKEN-OUTBOUND', '/'));
  it('TECH-SHOPIFY-DUP-PATHS: /collections/x/products/y canonicalizes to itself', () => expectFlag('TECH-SHOPIFY-DUP-PATHS', '/collections/kitchen/products/steel-water-bottle'));
  it('PERF-THIRD-PARTY: third-party JS grew >15% against the previous run', () => {
    const f = findingsFor(outcome.findings, 'PERF-THIRD-PARTY', 'product')[0];
    expect(f?.title).toMatch(/grew \d+%/);
  });
});

describe('on-page analyzers', () => {
  it('ONP-HEADINGS: H1 → H3 skip', () => expectFlag('ONP-HEADINGS', '/collections/kitchen'));
  it('ONP-BREADCRUMBS: collection without visible breadcrumb or BreadcrumbList', () => expectFlag('ONP-BREADCRUMBS', '/collections/kitchen'));
  it('ONP-OG: missing og:image', () => expectFlag('ONP-OG', '/collections/kitchen'));
  it('ONP-TPL-HOME / ONP-TPL-COLLECTION / ONP-TPL-PRODUCT: template checklists report failing items', () => {
    expectFlag('ONP-TPL-HOME', '/');
    expectFlag('ONP-TPL-COLLECTION', '/collections/kitchen');
    expectFlag('ONP-TPL-PRODUCT', '/products/glass-jar-500');
    expect(findingsFor(outcome.findings, 'ONP-TPL-HOME')[0].title).toBeTruthy();
  });
});

describe('content and AI-compliance analyzers', () => {
  it('CONT-QUALITY: a thin Tier 2 page scores below 50', () => expectFlag('CONT-QUALITY', '/pages/wholesale'));
  it('CONT-FRESHNESS: a Tier 1 article last updated over 180 days ago', () => expectFlag('CONT-FRESHNESS', '/blogs/news/old-diwali-guide'));
  it('CONT-AI-RISK: boilerplate/artifacts with no experience signals', () => expectFlag('CONT-AI-RISK', '/products/steel-water-bottle'));
  it('AIC-01: three products sharing fill-in-the-blank copy with only the name swapped', () => {
    const f = findingsFor(outcome.findings, 'AIC-01', 'product')[0];
    expect(f?.urls.sort()).toEqual([500, 750, 1000].map((m) => at(`/products/glass-jar-${m}`)).sort());
  });
  it('AIC-05: anonymous advice content without first-hand experience', () => expectFlag('AIC-05', '/blogs/news/best-storage-tips'));
  it('AIC-08: near-duplicate city landing pages all funnelling to one collection', () => {
    const f = findingsFor(outcome.findings, 'AIC-08')[0];
    expect(f?.urls.sort()).toEqual(CITIES.map((c) => at(`/pages/kitchen-supplies-${c.toLowerCase()}`)).sort());
    expect(f?.title).toContain('/collections/kitchen');
  });
  it('AIC-09: title phrase repeated above 3% density', () => expectFlag('AIC-09', '/products/steel-water-bottle'));
  it('AIC-11: blog article with no author attribution', () => expectFlag('AIC-11', '/blogs/news/best-storage-tips'));
  it('AIC-12: literal markdown and a stale "as of 2023" reference', () => {
    expectFlag('AIC-12', '/products/steel-water-bottle');
    const ev = findingsFor(outcome.findings, 'AIC-12')[0].evidence.map((e) => `${e.label} ${e.content ?? ''}`).join('\n');
    expect(ev).toMatch(/Markdown asterisks/);
    expect(ev).toMatch(/as of 2023/i);
  });
});

describe('AEO / GEO analyzers', () => {
  it('AEO-ANSWER-BLOCK: Tier 2 article without a question H2 + direct answer', () => expectFlag('AEO-ANSWER-BLOCK', '/blogs/news/best-storage-tips'));
  it('AEO-FAQ: collection without an FAQ block', () => expectFlag('AEO-FAQ', '/collections/kitchen'));
  it('AEO-EXTRACTABILITY: no quotable format on a Tier 2 page', () => expectFlag('AEO-EXTRACTABILITY', '/blogs/news/best-storage-tips'));
  it('AEO-ENTITY: homepage without Organization schema', () => {
    expectFlag('AEO-ENTITY', '/');
    expect(findingsFor(outcome.findings, 'AEO-ENTITY')[0].title).toMatch(/no Organization schema/);
  });
  it('GEO-EEAT: trust pages not linked sitewide and no visible phone number', () => {
    expectFlag('GEO-EEAT', '/');
    expect(findingsFor(outcome.findings, 'GEO-EEAT')[0].title).toMatch(/About page not linked sitewide/);
  });
  it('GEO-FRESHNESS: article without dateModified or a visible updated date', () => expectFlag('GEO-FRESHNESS', '/blogs/news/best-storage-tips'));
  it('GEO-STRUCTURE: 300+ words without a descriptive H2/H3', () => expectFlag('GEO-STRUCTURE', '/blogs/news/best-storage-tips'));
});

describe('precision controls', () => {
  it('a well-formed article (author, dates, headings) is not flagged for authorship or missing dates', () => {
    expect(flagged('AIC-11')).not.toContain(at('/blogs/news/old-diwali-guide'));
    const geo = findingsFor(outcome.findings, 'GEO-FRESHNESS').flatMap((f) => f.evidence).map((e) => JSON.stringify(e)).join('\n');
    expect(geo).not.toMatch(/old-diwali-guide[^\n]*without dateModified/);
  });
  it('the thin page is not reported as a doorway (it is not part of the near-duplicate cluster)', () => {
    expect(flagged('AIC-08')).not.toContain(at('/pages/wholesale'));
  });
});
