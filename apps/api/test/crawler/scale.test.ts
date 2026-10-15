/**
 * Large-crawl behaviour (no network: every response comes from a simulated site inside the test process).
 * Sitemaps of any size, pagination discovery, crawl traps, sitemap-only sections, trimmed headers, and the linear
 * helpers used by analysis and issue ingestion.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../src/crawler/http';
import { fetchSitemaps, parseSitemapXml } from '../../src/crawler/sitemap';
import { crawlTrapReason, paginationPage } from '../../src/crawler/url';
import { MAX_KEPT_EVIDENCE, perTemplate, prepare, problemCollector } from '../../src/analysis/context';
import { compileExclusions, exclusionMatches } from '../../src/services/issues';
import { InMemoryRepository } from '../../src/repositories/memory/inMemory';
import type { ParsedPage } from '../../src/crawler/types';
import { makeEngine, tier2 } from './helpers';

type Route = (n: number) => Response;
function net(routes: Record<string, Route>) {
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    const r = routes[url];
    return r ? r(n) : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { fetchImpl, count: (u: string) => counts.get(u) ?? 0, requested: () => [...counts.keys()] };
}
const html = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
const xml = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
const page = (title: string, links: string[]) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join('')}</main></body></html>`;
const urlset = (urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

describe('sitemap parsing', () => {
  it('reads <loc> / <lastmod>, decodes entities and CDATA, and ignores image:loc and comments', () => {
    const x = `<?xml version="1.0" encoding="UTF-8"?>
<!-- <url><loc>https://s.example/commented-out</loc></url> -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <image:image><image:loc>https://cdn.example/a.jpg</image:loc></image:image>
    <loc>https://s.example/products/a?x=1&amp;y=2</loc>
    <lastmod>2026-10-01</lastmod>
  </url>
  <url><loc><![CDATA[https://s.example/pages/b]]></loc></url>
  <url><lastmod>2026-10-02</lastmod></url>
</urlset>`;
    expect(parseSitemapXml(x)).toEqual({ kind: 'urlset', children: [], urls: [{ loc: 'https://s.example/products/a?x=1&y=2', lastmod: '2026-10-01' }, { loc: 'https://s.example/pages/b' }] });
  });

  it('reads sitemap indexes, namespace-prefixed files, and reports invalid files', () => {
    expect(parseSitemapXml('<sitemapindex><sitemap><loc>https://s.example/s1.xml</loc></sitemap><sitemap><loc> https://s.example/s2.xml.gz </loc></sitemap></sitemapindex>'))
      .toEqual({ kind: 'sitemapindex', urls: [], children: ['https://s.example/s1.xml', 'https://s.example/s2.xml.gz'] });
    expect(parseSitemapXml('<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:url><sm:loc>https://s.example/a</sm:loc></sm:url></sm:urlset>').urls).toEqual([{ loc: 'https://s.example/a' }]);
    expect(parseSitemapXml('hello')).toMatchObject({ kind: 'invalid', error: 'not XML' });
    expect(parseSitemapXml('<html><body>Not found</body></html>')).toMatchObject({ kind: 'invalid', error: 'no <urlset> or <sitemapindex> root element' });
  });

  it('parses a 50,000-URL sitemap', () => {
    const urls = Array.from({ length: 50000 }, (_, i) => `https://s.example/products/p-${i}`);
    const t0 = Date.now();
    const parsed = parseSitemapXml(urlset(urls));
    expect(parsed.urls.length).toBe(50000);
    expect(parsed.urls[49999].loc).toBe('https://s.example/products/p-49999');
    expect(Date.now() - t0).toBeLessThan(10000);
  });
});

describe('sitemap fetching', () => {
  it('follows an index with more than 50 child sitemaps, unzips .xml.gz files and keeps file order', async () => {
    const children = Array.from({ length: 70 }, (_, i) => `https://s.example/sitemap_products_${i + 1}.xml${i === 69 ? '.gz' : ''}`);
    const routes: Record<string, Route> = {
      'https://s.example/sitemap.xml': xml(`<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`),
    };
    children.forEach((c, i) => {
      const body = urlset([`https://s.example/products/a-${i}`, `https://s.example/products/b-${i}`]);
      routes[c] = c.endsWith('.gz')
        ? () => new Response(gzipSync(Buffer.from(body)), { status: 200, headers: { 'content-type': 'application/x-gzip' } })
        : xml(body);
    });
    const n = net(routes);
    const http = createHttpClient({ userAgent: 't', timeoutMs: 2000, fetchImpl: n.fetchImpl, retries: 0 });
    const sm = await fetchSitemaps(http, ['https://s.example/sitemap.xml'], { concurrency: 4 });
    expect(sm.files.length).toBe(71);
    expect(sm.files.map((f) => f.url)).toEqual(['https://s.example/sitemap.xml', ...children]);
    expect(sm.entries.length).toBe(140);
    expect(sm.entries.at(-1)).toMatchObject({ url: 'https://s.example/products/b-69', file: children[69] });
    expect(sm.files.every((f) => f.kind !== 'invalid' && f.kind !== 'unreachable')).toBe(true);
  });

  it('marks a sitemap larger than the read limit as cut off, keeping the entries read', async () => {
    const big = urlset(Array.from({ length: 2000 }, (_, i) => `https://s.example/products/p-${i}`));
    const n = net({ 'https://s.example/sitemap.xml': xml(big) });
    const http = createHttpClient({ userAgent: 't', timeoutMs: 2000, fetchImpl: n.fetchImpl, retries: 0 });
    const sm = await fetchSitemaps(http, ['https://s.example/sitemap.xml'], { maxBodyBytes: 20000 });
    expect(sm.files[0]).toMatchObject({ kind: 'urlset', truncated: true });
    expect(sm.files[0].error).toMatch(/only the first/);
    expect(sm.entries.length).toBeGreaterThan(100);
    expect(sm.entries.length).toBeLessThan(2000);
  });

  it('stops at the file limit', async () => {
    const children = Array.from({ length: 30 }, (_, i) => `https://s.example/s${i}.xml`);
    const routes: Record<string, Route> = { 'https://s.example/sitemap.xml': xml(`<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`) };
    for (const c of children) routes[c] = xml(urlset([`${c}/page`]));
    const n = net(routes);
    const http = createHttpClient({ userAgent: 't', timeoutMs: 2000, fetchImpl: n.fetchImpl, retries: 0 });
    const sm = await fetchSitemaps(http, ['https://s.example/sitemap.xml'], { maxFiles: 10 });
    expect(sm.files.length).toBe(10);
    expect(n.requested().length).toBe(10);
  });
});

describe('URL helpers', () => {
  it('recognises plain pagination only', () => {
    expect(paginationPage('https://s.example/collections/all?page=2')).toBe(2);
    expect(paginationPage('https://s.example/collections/all?page=1')).toBeUndefined();
    expect(paginationPage('https://s.example/collections/all?page=2&sort_by=price')).toBeUndefined();
    expect(paginationPage('https://s.example/collections/all?sort_by=price')).toBeUndefined();
    expect(paginationPage('https://s.example/collections/all')).toBeUndefined();
  });

  it('flags crawl traps and leaves normal store URLs alone', () => {
    for (const ok of ['https://s.example/', 'https://s.example/collections/kitchen/products/steel-chopper', 'https://s.example/blogs/news/2026/10/10-tips', 'https://s.example/collections/all?page=250']) {
      expect(crawlTrapReason(ok)).toBeUndefined();
    }
    expect(crawlTrapReason('https://s.example/a/b/a/b/a/b')).toMatch(/repeated 3 times/);
    expect(crawlTrapReason(`https://s.example/${Array.from({ length: 30 }, (_, i) => `s${i}`).join('/')}`)).toMatch(/path segments/);
    expect(crawlTrapReason(`https://s.example/p/${'x'.repeat(2100)}`)).toMatch(/longer than/);
    expect(crawlTrapReason('https://s.example/collections/all?page=99999')).toMatch(/beyond/);
  });
});

describe('link discovery on a store', () => {
  // Home → collection (page 1 lists products a, b; ?page=2 lists c, d; sort links are not followed).
  // A broken relative link creates an endless /x/x/x… path space. /pages/hidden is only in the sitemap and links to
  // /pages/deeper, which nothing else links to.
  const site = () => {
    const routes: Record<string, Route> = {
      'https://shop.example/robots.txt': () => new Response('User-agent: *\nDisallow: /cart\nSitemap: https://shop.example/sitemap.xml\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'https://shop.example/sitemap.xml': xml(urlset(['https://shop.example/', 'https://shop.example/pages/hidden'])),
      'https://shop.example/': html(page('Home', ['/collections/all', '/loop/x/']), { 'strict-transport-security': 'max-age=1', 'x-powered-by': 'demo' }),
      'https://shop.example/collections/all': html(page('All', ['/products/a', '/products/b', '/collections/all?page=2', '/collections/all?sort_by=price']), { 'x-robots-tag': 'all', 'set-cookie': 'a=b', 'x-powered-by': 'demo' }),
      'https://shop.example/collections/all?page=2': html(page('All page 2', ['/products/c', '/products/d', '/collections/all'])),
      'https://shop.example/pages/hidden': html(page('Hidden', ['/pages/deeper'])),
      'https://shop.example/pages/deeper': html(page('Deeper', ['/'])),
    };
    for (const p of ['a', 'b', 'c', 'd']) routes[`https://shop.example/products/${p}`] = html(page(`Product ${p}`, ['/collections/all']));
    // Endless relative-link space: /loop/x/ links to "x/" → /loop/x/x/ → /loop/x/x/x/ …
    let path = '/loop/x/';
    for (let i = 0; i < 40; i++) { routes[`https://shop.example${path}`] = html(page(`Loop ${i}`, ['x/'])); path += 'x/'; }
    return net(routes);
  };

  it('follows ?page=N pagination, skips sort links and crawl traps, and follows links on sitemap-only pages', async () => {
    const n = site();
    const engine = makeEngine('https://shop.example', { allowLive: true, fetchImpl: n.fetchImpl });
    const out = await engine.run({ type: 'full', baseUrl: 'https://shop.example/', startUrl: 'https://shop.example/', maxPages: Infinity, tierOf: tier2 });
    const ok = new Map(out.urls.filter((u) => u.status === 200).map((u) => [new URL(u.url).pathname + new URL(u.url).search, u]));
    for (const p of ['/products/a', '/products/b', '/products/c', '/products/d', '/collections/all?page=2', '/pages/hidden', '/pages/deeper']) expect(ok.has(p), p).toBe(true);
    // Sort / filter links are not followed; at most one is fetched as a crawl-budget sample (TECH-CRAWL-BUDGET).
    expect(n.count('https://shop.example/collections/all?sort_by=price')).toBeLessThanOrEqual(1);
    // Products only listed on page 2 have their true click depth (home → collection → page 2 → product).
    expect(ok.get('/products/c')?.depth).toBe(3);
    // Reached only through the sitemap: no click depth.
    expect(ok.get('/pages/hidden')).toMatchObject({ reason: 'sitemap' });
    expect(ok.get('/pages/hidden')?.depth).toBeUndefined();
    expect(ok.get('/pages/deeper')?.depth).toBeUndefined();
    // The relative-link loop stops once a segment repeats 3 times (the link may still get one status check, but it is
    // not crawled as a page); the skipped link is reported in the scope.
    expect(ok.has('/loop/x/x/')).toBe(true);
    expect(out.urls.find((u) => u.url === 'https://shop.example/loop/x/x/x/')).toBeUndefined();
    expect(n.count('https://shop.example/loop/x/x/x/x/')).toBe(0);
    expect(out.stats.scope?.find((s) => /crawl traps/.test(s.label))?.count).toBeGreaterThanOrEqual(1);
    // Each page is fetched once.
    expect(n.count('https://shop.example/products/c')).toBe(1);
    expect(n.count('https://shop.example/pages/deeper')).toBe(1);
  });

  it('does not follow links from sitemap-only pages when a depth limit is set', async () => {
    const n = site();
    const engine = makeEngine('https://shop.example', { allowLive: true, fetchImpl: n.fetchImpl });
    const out = await engine.run({ type: 'full', baseUrl: 'https://shop.example/', startUrl: 'https://shop.example/', maxPages: Infinity, maxDepth: 5, tierOf: tier2 });
    expect(out.urls.find((u) => u.url === 'https://shop.example/pages/hidden')).toMatchObject({ status: 200, reason: 'sitemap' });
    expect(out.urls.find((u) => u.url === 'https://shop.example/pages/deeper')).toBeUndefined();
  });

  it('keeps only the response headers analysis needs (all of them on the homepage)', async () => {
    const n = site();
    const engine = makeEngine('https://shop.example', { allowLive: true, fetchImpl: n.fetchImpl });
    const collected = await engine.collector.collect({
      type: 'full', baseUrl: 'https://shop.example/', urls: [], maxPages: 3, tierOf: tier2, needs: new Set(['bfs']), startUrl: 'https://shop.example/',
    });
    const home = collected.pages.find((p) => p.url === 'https://shop.example/')!;
    const col = collected.pages.find((p) => p.url === 'https://shop.example/collections/all')!;
    expect(home.headers['x-powered-by']).toBe('demo');
    expect(home.headers['strict-transport-security']).toBe('max-age=1');
    expect(col.headers).toEqual({ 'content-type': 'text/html', 'x-robots-tag': 'all' });
  });
});

describe('linear helpers used on large crawls', () => {
  it('compiled exclusions match exactly like exclusionMatches', () => {
    const list = [
      { checkId: 'TECH-4XX', urlPattern: '/products/old-*' },
      { urlPattern: '/pages/legal/' },
      { checkId: 'ONP-TITLE', urlPattern: '/collections/*/products/*' },
      { checkId: '', urlPattern: '/search' },
    ];
    const urls = ['https://s.example/products/old-1', 'https://s.example/products/new', 'https://s.example/pages/legal', 'https://s.example/pages/legal/', 'https://s.example/collections/a/products/b', 'https://s.example/search?q=x', 'not a url'];
    const c = compileExclusions(list);
    for (const checkId of ['TECH-4XX', 'ONP-TITLE', 'TECH-REDIRECTS']) for (const u of urls) {
      expect(c.matches(checkId, u), `${checkId} ${u}`).toBe(list.some((ex) => exclusionMatches(ex, checkId, u)));
    }
    expect(compileExclusions([{ checkId: 'A', urlPattern: '/x' }]).applies('B')).toBe(false);
  });

  it('nextId keeps counting without scanning, and never reuses a stored id', async () => {
    const repo = new InMemoryRepository<{ id: string }>('t');
    await repo.insert({ id: 'ISS-0007' });
    expect(await repo.nextId('ISS')).toBe('ISS-0008');
    expect(await repo.nextId('ISS')).toBe('ISS-0009');
    await repo.insert({ id: 'ISS-0050' }); // e.g. a seeded / imported id
    expect(await repo.nextId('ISS')).toBe('ISS-0051');
    expect(await repo.nextId('AIF', 3)).toBe('AIF-052');
  });

  it('problem collector and perTemplate de-duplicate URLs and cap kept evidence', () => {
    const c = problemCollector();
    for (let i = 0; i < 1000; i++) c.add('broken', `https://s.example/p/${i % 400}`, { kind: 'note', label: String(i) });
    expect(c.problems[0].urls.length).toBe(400);
    expect(c.problems[0].evidence!.length).toBe(MAX_KEPT_EVIDENCE);

    const pages = Array.from({ length: 5000 }, (_, i) => ({
      url: `https://s.example/products/p-${i}`, finalUrl: `https://s.example/products/p-${i}`, status: 200, finalStatus: 200, chain: [], redirectLoop: false, tooManyRedirects: false,
      totalMs: 1, headers: {}, template: 'product', tier: 2, reason: 'full', inSitemap: false,
    })) as unknown as ParsedPage[];
    const ctx = { linkTargets: new Map() } as never;
    const t0 = Date.now();
    const res = perTemplate(prepare([], ctx), pages, 'TECH-THIN', 'thin content', (p) => [{ label: 'are thin', evidence: [{ kind: 'note', label: p.url }] }]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.findings[0].urls.length).toBe(5000);
    expect(res.findings[0].evidence.length).toBeLessThanOrEqual(16);
  });
});
