import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifySeverity, defaultConfig } from '@sentinel/shared';
import type { CrawlOutcome, PreviousCrawlState } from '../../src/services/ports';
import { startFixtureSite, type FixtureSite } from './fixtureSite';
import { findingsFor, makeEngine, tier2, urlsOf } from './helpers';

/**
 * One baseline crawl of the clean fixture (→ `previous`), then one smart crawl with every defect injected.
 * Each test asserts one defect is reported under the right check id with the right URL(s) and evidence.
 */
describe('analyzers detect injected defects', () => {
  let site: FixtureSite;
  let clean: Awaited<ReturnType<ReturnType<typeof makeEngine>['run']>>;
  let out: Omit<CrawlOutcome, 'run'> & { snapshot?: PreviousCrawlState };
  let previous: PreviousCrawlState;
  const P = (p: string) => `${site.origin}${p}`;

  beforeAll(async () => {
    site = await startFixtureSite();
    const engine = makeEngine(site.url);
    const urls = [
      ...site.collectionUrls(), ...site.productUrls(), P('/blogs/news'), P('/blogs/news/how-to-start-dropshipping-in-india'), P('/pages/about-us'),
      P('/old-chopper'), P('/promo'),
    ].map((url) => ({ url, reason: 'top_product' as const }));
    clean = await engine.run({ type: 'smart', baseUrl: site.url, maxPages: 100, tierOf: tier2, urls });
    previous = clean.snapshot!;

    Object.assign(site.opts, {
      noindex: ['/products/airtight-container-1200'],
      xRobotsNoindex: ['/pages/about-us'],
      deletedProducts: ['building-blocks-100'],
      missingCanonical: ['/products/silicone-spatula-set'],
      duplicateTitle: ['/products/led-fairy-lights-10m', '/products/artificial-money-plant'],
      thinCollections: ['toys'],
      longTitle: ['/products/adhesive-wall-hooks'],
      missingMeta: ['/products/pull-back-racing-car'],
      multipleH1: ['/collections/home-decor'],
      missingAlt: ['adhesive-wall-hooks'],
      largeImage: ['led-fairy-lights-10m'],
      noOffers: ['artificial-money-plant'],
      priceMismatch: { 'vegetable-chopper': '199.00' },
      reviewMarkupWithoutReviews: ['pull-back-racing-car'],
      robotsDisallowCollections: true,
      robotsBlockGptBot: true,
      aiBoilerplate: ['silicone-spatula-set'],
      ymylClaim: ['airtight-container-1200'],
      newHeadScriptOnProducts: true,
    });
    // respectRobots off for the defect crawl so the (now disallowed) collections are still examined.
    out = await makeEngine(site.url, { respectRobots: false }).run({ type: 'smart', baseUrl: site.url, maxPages: 100, tierOf: tier2, urls, previous });
  });
  afterAll(async () => {
    await site.close();
  });

  it('baseline crawl of the clean fixture has none of the injected-defect findings', () => {
    for (const id of ['TECH-NOINDEX', 'TECH-4XX', 'TECH-CANONICAL', 'TECH-SCHEMA-PRESENCE', 'TECH-SCHEMA-ERRORS', 'TECH-ROBOTS', 'AEO-AI-CRAWLERS', 'AIC-02', 'AIC-07', 'PERF-IMAGES', 'ONP-TITLE', 'ONP-META', 'ONP-H1', 'ONP-IMAGES', 'TECH-DUPLICATE']) {
      expect(findingsFor(clean.findings, id), id).toEqual([]);
    }
    // PERF-RENDER-BLOCKING / PERF-THIRD-PARTY need a baseline: not evaluated (never faked) on the first run.
    expect(clean.evaluatedChecks).not.toContain('PERF-RENDER-BLOCKING');
    expect(out.evaluatedChecks).toContain('PERF-RENDER-BLOCKING');
  });

  it('TECH-NOINDEX: new meta noindex and X-Robots-Tag on previously indexable URLs', () => {
    const f = findingsFor(out.findings, 'TECH-NOINDEX');
    expect(urlsOf(f).sort()).toEqual([P('/pages/about-us'), P('/products/airtight-container-1200')].sort());
    const prod = f.find((x) => x.template === 'product')!;
    expect(prod.evidence.some((e) => e.content?.includes('noindex'))).toBe(true);
    expect(f.find((x) => x.template === 'page')!.evidence.some((e) => e.content?.includes('X-Robots-Tag: noindex'))).toBe(true);
  });

  it('TECH-4XX + TECH-DISCONTINUED: deleted product 404 with suggested parent collection', () => {
    const f4 = findingsFor(out.findings, 'TECH-4XX', 'product');
    expect(urlsOf(f4)).toEqual([P('/products/building-blocks-100')]);
    expect(f4[0].title).toMatch(/newly return 404/);
    const d = findingsFor(out.findings, 'TECH-DISCONTINUED')[0];
    expect(d.urls).toEqual([P('/products/building-blocks-100')]);
    expect(d.evidence[0].data?.suggestedRedirect).toBe(P('/collections/toys'));
  });

  it('TECH-REDIRECTS: chain and 302', () => {
    const f = findingsFor(out.findings, 'TECH-REDIRECTS');
    const labels = f.flatMap((x) => x.evidence.filter((e) => e.kind === 'note').map((e) => ({ p: String(e.data?.problem), urls: e.data?.urls as string[] })));
    expect(labels.find((l) => l.p.includes('chain'))?.urls).toContain(P('/old-chopper'));
    expect(labels.find((l) => l.p.includes('temporary'))?.urls).toContain(P('/promo'));
  });

  it('TECH-CANONICAL: missing canonical', () => {
    const f = findingsFor(out.findings, 'TECH-CANONICAL', 'product')[0];
    expect(f.urls).toEqual([P('/products/silicone-spatula-set')]);
    expect(f.title).toContain('missing a canonical tag');
    expect(f.severityContext?.templateWide).toBeFalsy();
  });

  it('TECH-DUPLICATE + ONP-TITLE: duplicate titles', () => {
    const dup = findingsFor(out.findings, 'TECH-DUPLICATE', 'product')[0];
    expect(dup.urls.sort()).toEqual([P('/products/led-fairy-lights-10m'), P('/products/artificial-money-plant')].sort());
    expect(dup.evidence.some((e) => e.kind === 'text_passage' && e.content === 'Wholesale Products Online at Best Price | DeoDap')).toBe(true);
    const t = findingsFor(out.findings, 'ONP-TITLE', 'product')[0];
    const notes = t.evidence.filter((e) => e.kind === 'note').map((e) => ({ p: String(e.data?.problem), urls: e.data?.urls as string[] }));
    expect(notes.find((n) => n.p.includes('duplicated'))?.urls.sort()).toEqual([P('/products/led-fairy-lights-10m'), P('/products/artificial-money-plant')].sort());
    expect(notes.find((n) => n.p.includes('longer than 60'))?.urls).toEqual([P('/products/adhesive-wall-hooks')]);
  });

  it('TECH-THIN: collection without description', () => {
    const f = findingsFor(out.findings, 'TECH-THIN', 'collection')[0];
    expect(f.urls).toEqual([P('/collections/toys')]);
    expect(Number(f.evidence.find((e) => e.kind === 'metric')?.data?.uniqueWords)).toBeLessThan(150);
  });

  it('ONP-META missing, ONP-H1 multiple, ONP-IMAGES missing alt', () => {
    expect(findingsFor(out.findings, 'ONP-META', 'product')[0].urls).toEqual([P('/products/pull-back-racing-car')]);
    const h1 = findingsFor(out.findings, 'ONP-H1', 'collection')[0];
    expect(h1.urls).toEqual([P('/collections/home-decor')]);
    expect(h1.title).toContain('multiple H1s');
    const img = findingsFor(out.findings, 'ONP-IMAGES', 'product')[0];
    expect(img.urls).toEqual([P('/products/adhesive-wall-hooks')]);
    expect(img.evidence.some((e) => e.kind === 'html_snippet' && e.content?.includes('/cdn/img/adhesive-wall-hooks.webp'))).toBe(true);
  });

  it('PERF-IMAGES: a normal crawl never requests images, so it claims no image weight (the Image Audit measures it)', () => {
    // led-fairy-lights-10m shows a 300 KB JPEG: weight and format are reported by the Image Audit (test/gocrawl/image-audit.test.ts),
    // never guessed by a crawl that did not request the image.
    const all = out.findings.filter((f) => f.checkId === 'PERF-IMAGES');
    expect(all.some((f) => /heavier than|legacy formats/.test(f.title) || f.evidence.some((e) => e.label.includes('KB')))).toBe(false);
    expect(out.evaluatedChecks).toContain('PERF-IMAGES'); // width / height and lazy-loading are still checked from the HTML
    expect(site.requests.filter((r) => r.path.startsWith('/cdn/img/')), 'the built-in crawler requested images').toEqual([]);
    expect((out as { imageRefsFile?: string }).imageRefsFile, 'image references are recorded for a later Image Audit').toBeTruthy();
  });

  it('TECH-SCHEMA-PRESENCE: Product without offers; TECH-SCHEMA-ERRORS: price mismatch + review markup without visible reviews', () => {
    const sp = findingsFor(out.findings, 'TECH-SCHEMA-PRESENCE', 'product')[0];
    expect(sp.urls).toEqual([P('/products/artificial-money-plant')]);
    expect(sp.title).toContain('Product schema missing offers');
    expect(sp.severityContext?.templateWide).toBeFalsy();
    const se = findingsFor(out.findings, 'TECH-SCHEMA-ERRORS', 'product')[0];
    const notes = se.evidence.filter((e) => e.kind === 'note').map((e) => ({ p: String(e.data?.problem), urls: e.data?.urls as string[] }));
    expect(notes.find((n) => n.p.includes('offers.price ≠ visible price'))?.urls).toEqual([P('/products/vegetable-chopper')]);
    expect(notes.find((n) => n.p.includes('no visible reviews'))?.urls).toEqual([P('/products/pull-back-racing-car')]);
    const priceEv = se.evidence.find((e) => e.kind === 'jsonld' && e.label.includes('JSON-LD price 199'));
    expect(priceEv).toBeDefined();
    expect(se.evidence.some((e) => e.kind === 'html_snippet' && e.label.includes('Visible price 249'))).toBe(true);
    expect(se.severityContext?.isWarning).toBeFalsy();
    // AIC-06 sees the same review-markup problem as a fake-review signal.
    expect(findingsFor(out.findings, 'AIC-06', 'product')[0].urls).toEqual([P('/products/pull-back-racing-car')]);
  });

  it('TECH-ROBOTS: robots.txt now disallows /collections/ (diff vs previous) → affectsIndexablePaths', () => {
    const f = findingsFor(out.findings, 'TECH-ROBOTS')[0];
    expect(f.severityContext?.affectsIndexablePaths).toBe(true);
    expect(f.title).toContain('/collections/');
    const diff = f.evidence.find((e) => e.kind === 'diff')!;
    expect(diff.content).toContain('+ Disallow: /collections/');
    expect(classifySeverity({ checkId: 'TECH-ROBOTS', highestTier: 1, ...f.severityContext }, defaultConfig()).severity).toBe('critical');
  });

  it('AEO-AI-CRAWLERS: GPTBot blocked while policy says allow → unintentional', () => {
    const f = findingsFor(out.findings, 'AEO-AI-CRAWLERS').find((x) => x.key?.endsWith('GPTBot'))!;
    expect(f.severityContext?.unintentional).toBe(true);
    expect(f.evidence[0].content).toContain('User-agent: gptbot');
    expect(classifySeverity({ checkId: 'AEO-AI-CRAWLERS', highestTier: 1, ...f.severityContext }, defaultConfig()).severity).toBe('critical');
  });

  it('AEO-AI-CRAWLERS: a deliberate block_intentional policy is low, not critical', async () => {
    const r = await makeEngine(site.url, {}, (c) => { c.aiCrawlerPolicy.GPTBot = 'block_intentional'; }).run({ type: 'smart', baseUrl: site.url, maxPages: 5, tierOf: tier2, urls: [] });
    const f = findingsFor(r.findings, 'AEO-AI-CRAWLERS').find((x) => x.key?.endsWith('GPTBot'))!;
    expect(f.severityContext?.unintentional).toBe(false);
  });

  it('AIC-02: unedited AI boilerplate with the exact passage', () => {
    const f = findingsFor(out.findings, 'AIC-02', 'product')[0];
    expect(f.urls).toEqual([P('/products/silicone-spatula-set')]);
    const passages = f.evidence.filter((e) => e.kind === 'text_passage').map((e) => e.content);
    expect(passages.some((p) => p?.includes("In today's fast-paced world"))).toBe(true);
    expect(passages.some((p) => p?.includes('Unlock the power of'))).toBe(true);
  });

  it('AIC-07: YMYL "BPA-free" claim without a verified source', () => {
    const f = findingsFor(out.findings, 'AIC-07', 'product')[0];
    expect(f.urls).toEqual([P('/products/airtight-container-1200')]);
    expect(f.evidence[f.evidence.length - 1].content).toContain('BPA-free');
  });

  it('PERF-RENDER-BLOCKING: new synchronous head script vs previous, naming the app/host', () => {
    const f = findingsFor(out.findings, 'PERF-RENDER-BLOCKING', 'product');
    expect(f).toHaveLength(1);
    expect(f[0].urls.length).toBe(7); // 8 products minus the deleted one
    const diff = f[0].evidence.find((e) => e.kind === 'diff')!;
    expect(diff.data?.src).toBe(P('/apps/upsell-pro/widget.js'));
    expect(diff.data?.app).toBe('Shopify app proxy (upsell-pro)');
    expect(diff.data?.scriptHost).toBe(new URL(site.origin).host);
    expect(f[0].title).toContain('upsell-pro');
  });

  it('reports evaluatedChecks for passing checks and excludes non-crawler checks', () => {
    for (const id of ['TECH-SITEMAP', 'TECH-HTTPS', 'TECH-HOST']) expect(out.evaluatedChecks.includes(id), id).toBe(id === 'TECH-SITEMAP');
    for (const id of ['PERF-CRUX', 'PERF-PSI', 'TECH-INDEX-COVERAGE', 'CONT-DECAY', 'OFF-BACKLINKS', 'AIC-04', 'AIC-03', 'TECH-JS-RENDER', 'TECH-MOBILE']) expect(out.evaluatedChecks).not.toContain(id);
    expect(out.evaluatedTemplates?.['TECH-SCHEMA-PRESENCE']).toEqual(expect.arrayContaining(['product', 'collection', 'home']));
  });
});
