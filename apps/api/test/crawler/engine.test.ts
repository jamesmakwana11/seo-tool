import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineReadiness } from '../../src/crawler/engine';
import { isAllowed, parseRobots } from '../../src/crawler/robots';
import { templateOf } from '../../src/crawler/url';
import { startFixtureSite, type FixtureSite } from './fixtureSite';
import { makeEngine, tier2 } from './helpers';

describe('crawl engine against the fixture store', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await startFixtureSite({ linkErrorRoutes: true, slowMs: 1500 });
  });
  afterAll(async () => {
    await site.close();
  });

  it('full crawl: BFS from the homepage records statuses, click depth, failures and the sitemap diff', async () => {
    site.opts.orphanInSitemap = true;
    const engine = makeEngine(site.url);
    const progress: [number, number][] = [];
    const out = await engine.run(
      { type: 'full', baseUrl: site.url, maxPages: 200, tierOf: tier2, previous: { sitemapEntries: [{ url: `${site.origin}/`, lastmod: '2026-10-01' }, { url: `${site.origin}/pages/old`, lastmod: '2026-01-01' }] } },
      (c, f) => progress.push([c, f]),
    );
    site.opts.orphanInSitemap = false;
    const by = new Map(out.urls.map((u) => [u.url.replace(site.origin, ''), u]));

    expect(by.get('/')).toMatchObject({ status: 200, reason: 'homepage' });
    for (const p of site.productUrls()) expect(by.get(p.replace(site.origin, ''))?.status).toBe(200);
    expect(by.get('/pages/broken')?.status).toBe(500);
    expect(by.get('/pages/slow')?.status).toBeNull();
    expect(by.get('/pages/slow')?.error).toMatch(/timeout/);
    // Orphan: only reachable through the sitemap.
    expect(by.get('/pages/wholesale-price-list')).toMatchObject({ status: 200, reason: 'sitemap' });
    // sort_by URLs are disallowed by the fixture robots.txt and therefore skipped (respectRobots).
    const sorted = out.urls.find((u) => u.url.includes('sort_by'));
    expect(sorted?.status).toBeNull();
    expect(sorted?.error).toMatch(/robots\.txt/);

    expect(out.stats.urlsFailed).toBe(2);
    expect(out.stats.urlsCrawled).toBeGreaterThanOrEqual(25);
    expect(out.stats.jsRenderedSample).toBe(0);
    expect(progress.length).toBeGreaterThan(0);

    // Sitemap diff vs the previous entries.
    expect(out.sitemapDiff?.added).toContain(`${site.origin}/products/vegetable-chopper`);
    expect(out.sitemapDiff?.removed).toEqual([`${site.origin}/pages/old`]);
    expect(out.sitemapDiff?.lastmodChanged).toEqual([{ url: `${site.origin}/`, from: '2026-10-01', to: '2026-10-10' }]);

    // Orphan + depth are evaluated only on full crawls; orphan page is reported.
    expect(out.evaluatedChecks).toEqual(expect.arrayContaining(['TECH-ORPHAN', 'TECH-CRAWL-DEPTH']));
    const orphan = out.findings.find((f) => f.checkId === 'TECH-ORPHAN');
    expect(orphan?.urls).toEqual([`${site.origin}/pages/wholesale-price-list`]);
    // Failures reported honestly.
    const fivexx = out.findings.filter((f) => f.checkId === 'TECH-5XX').flatMap((f) => f.urls);
    expect(fivexx).toEqual(expect.arrayContaining([`${site.origin}/pages/broken`, `${site.origin}/pages/slow`]));
    // Never claims JS rendering / mobile checks.
    expect(out.evaluatedChecks).not.toContain('TECH-JS-RENDER');
    expect(out.evaluatedChecks).not.toContain('TECH-MOBILE');
    // Snapshot for the next run.
    expect(out.snapshot?.robotsTxt).toContain('User-agent: *');
    expect(out.snapshot?.headScriptsByTemplate?.product?.some((s) => s.endsWith('/theme.js'))).toBe(true);
    expect(out.pageTexts?.some((p) => p.template === 'blog_article')).toBe(true);
  });

  it('smart crawl: crawls the planned URLs + homepage and records redirect chains, 302s and loops', async () => {
    const engine = makeEngine(site.url);
    const urls = ['/old-chopper', '/promo', '/loop-a', '/products/vegetable-chopper', '/collections/toys'].map((p) => ({ url: `${site.origin}${p}`, reason: 'changed_48h' as const }));
    const out = await engine.run({ type: 'smart', baseUrl: site.url, maxPages: 50, tierOf: tier2, urls });
    const by = new Map(out.urls.map((u) => [u.url.replace(site.origin, ''), u]));
    expect(by.get('/')?.reason).toBe('homepage');
    expect(by.get('/old-chopper')).toMatchObject({ status: 301, reason: 'changed_48h' });
    expect(by.get('/promo')?.status).toBe(302);
    expect(by.get('/loop-a')?.status).toBe(301);
    // No BFS on smart crawls: blog articles are not crawled, orphan/depth not evaluated.
    expect(by.has('/blogs/news/how-to-start-dropshipping-in-india')).toBe(false);
    expect(out.evaluatedChecks).not.toContain('TECH-ORPHAN');
    expect(out.evaluatedChecks).not.toContain('TECH-CRAWL-DEPTH');

    const redirects = out.findings.filter((f) => f.checkId === 'TECH-REDIRECTS');
    const all = redirects.flatMap((f) => f.evidence.filter((e) => e.kind === 'note').map((e) => `${e.data?.problem}|${(e.data?.urls as string[]).join(',')}`)).join('\n');
    expect(all).toMatch(new RegExp(`chain of more than 1 hop\\|.*${site.origin}/old-chopper`));
    expect(all).toMatch(new RegExp(`temporary redirects \\(302\\).*\\|.*${site.origin}/promo`));
    expect(all).toMatch(new RegExp(`redirect loop\\|.*${site.origin}/loop-a`));
    const chainFinding = redirects.find((f) => f.urls.includes(`${site.origin}/old-chopper`))!;
    expect(chainFinding.severityContext?.metric).toBeGreaterThanOrEqual(2);
    const ev = chainFinding.evidence.find((e) => e.kind === 'http_response' && e.url === `${site.origin}/old-chopper`)!;
    expect(ev.content).toContain('/products/old-chopper-v2');
    expect(ev.data?.hops).toBe(2);
    // Sends the configured UA.
    expect(site.requests.some((r) => r.ua.startsWith('DeoDapSEOSentinel/1.0'))).toBe(true);
  });

  it('respectRobots skips disallowed URLs (and fetches them when disabled)', async () => {
    site.opts.robotsDisallowCollections = true;
    try {
      const plan = { type: 'smart' as const, baseUrl: site.url, maxPages: 20, tierOf: tier2, urls: [{ url: `${site.origin}/collections/toys`, reason: 'collection' as const }] };
      const before = site.requests.length;
      const out = await makeEngine(site.url).run(plan);
      const toys = out.urls.find((u) => u.url.endsWith('/collections/toys'))!;
      expect(toys.status).toBeNull();
      expect(toys.error).toMatch(/disallowed by robots\.txt.*Disallow: \/collections\//);
      expect(site.requests.slice(before).some((r) => r.method === 'GET' && r.path === '/collections/toys')).toBe(false);

      const out2 = await makeEngine(site.url, { respectRobots: false }).run(plan);
      expect(out2.urls.find((u) => u.url.endsWith('/collections/toys'))?.status).toBe(200);
    } finally {
      site.opts.robotsDisallowCollections = false;
    }
  });
});

describe('readiness', () => {
  it('requires CRAWLER_BASE_URL', () => {
    const r = makeEngine(undefined).readiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('CRAWLER_BASE_URL');
  });
  it('requires CRAWLER_ALLOW_LIVE for a non-local site', () => {
    const r = makeEngine('https://deodap.in').readiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('CRAWLER_ALLOW_LIVE');
    expect(makeEngine('https://deodap.in', { allowLive: true }).readiness().ready).toBe(true);
  });
  it('allows loopback base URLs without allowLive', () => {
    expect(engineReadiness('http://localhost:3000', false).ready).toBe(true);
    expect(engineReadiness('http://127.0.0.1:9', false).ready).toBe(true);
  });
  it('run() refuses when not ready', async () => {
    await expect(makeEngine('https://deodap.in').run({ type: 'smart', baseUrl: 'https://deodap.in', maxPages: 1, tierOf: tier2 })).rejects.toThrow(/CRAWLER_ALLOW_LIVE/);
  });
});

describe('robots.txt matcher and templates', () => {
  const r = parseRobots('User-agent: *\nDisallow: /collections/\nAllow: /collections/toys\nDisallow: /*?*sort_by*\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n');
  it('longest match wins, Allow wins ties, wildcards work, grouped agents share rules', () => {
    expect(isAllowed(r, 'Googlebot', '/collections/kitchen').allowed).toBe(false);
    expect(isAllowed(r, 'Googlebot', '/collections/toys').allowed).toBe(true);
    expect(isAllowed(r, 'Googlebot', '/products/x?sort_by=price').allowed).toBe(false);
    // Google semantics: the longer Allow (/collections/toys, 17 chars) beats the shorter wildcard Disallow.
    expect(isAllowed(r, 'Googlebot', '/collections/toys?sort_by=price').allowed).toBe(true);
    expect(isAllowed(r, 'GPTBot', '/products/x').allowed).toBe(false);
    expect(isAllowed(r, 'CCBot/2.0', '/').allowed).toBe(false);
    expect(isAllowed(r, 'PerplexityBot', '/products/x').allowed).toBe(true);
  });
  it('detects templates from Shopify paths', () => {
    expect(templateOf('https://x/')).toBe('home');
    expect(templateOf('https://x/collections/a')).toBe('collection');
    expect(templateOf('https://x/collections/a/products/b')).toBe('product');
    expect(templateOf('https://x/products/b')).toBe('product');
    expect(templateOf('https://x/blogs/news/post')).toBe('blog_article');
    expect(templateOf('https://x/blogs/news')).toBe('blog_index');
    expect(templateOf('https://x/pages/about')).toBe('page');
    expect(templateOf('https://x/search?q=a')).toBe('search');
  });
});
