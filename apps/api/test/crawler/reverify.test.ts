import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReverifier } from '../../src/analysis/reverify';
import { startFixtureSite, type FixtureSite } from './fixtureSite';
import { findingsFor, issueFromFinding, makeEngine, tier2 } from './helpers';

describe('reverifier', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await startFixtureSite();
  });
  afterAll(async () => {
    await site.close();
  });

  it('canVerify: crawler-evaluable checks with an analyzer, only when the crawler is ready', () => {
    const rv = createReverifier({ collector: makeEngine(site.url).collector });
    expect(rv.canVerify('TECH-4XX').ok).toBe(true);
    expect(rv.canVerify('PERF-CRUX')).toMatchObject({ ok: false });
    expect(rv.canVerify('PERF-CRUX').reason).toContain('crux');
    expect(rv.canVerify('TECH-JS-RENDER').ok).toBe(false);
    expect(rv.canVerify('ONP-KEYWORD-MAP').reason).toMatch(/no crawler analyzer/);
    const notReady = createReverifier({ collector: makeEngine('https://deodap.in').collector });
    expect(notReady.canVerify('TECH-4XX')).toMatchObject({ ok: false });
    expect(notReady.canVerify('TECH-4XX').reason).toContain('CRAWLER_ALLOW_LIVE');
  });

  it('404 issue fails before the fix and passes after the route is fixed', async () => {
    site.opts.deletedProducts = ['building-blocks-100'];
    const engine = makeEngine(site.url);
    const urls = site.productUrls().map((url) => ({ url, reason: 'top_product' as const }));
    const crawl = await engine.run({ type: 'smart', baseUrl: site.url, maxPages: 50, tierOf: tier2, urls, previous: { okUrls: site.productUrls() } });
    const finding = findingsFor(crawl.findings, 'TECH-4XX', 'product')[0];
    expect(finding.urls).toEqual([`${site.origin}/products/building-blocks-100`]);
    const issue = issueFromFinding(finding);
    const rv = createReverifier({ collector: engine.collector });

    const before = await rv.verify(issue);
    expect(before).toMatchObject({ outcome: 'failed', checkedUrls: 1, failingUrls: 1 });
    expect(before.details).toContain('building-blocks-100');
    expect(before.evidence?.some((e) => e.kind === 'http_response')).toBe(true);

    site.opts.deletedProducts = []; // developer restores the product
    const after = await rv.verify(issue);
    expect(after).toMatchObject({ outcome: 'passed', checkedUrls: 1, failingUrls: 0 });
  });

  it('honest counts: a page-level fix on 2 of 3 URLs still fails with failingUrls = 1', async () => {
    site.opts.missingMeta = ['/products/vegetable-chopper', '/products/silicone-spatula-set', '/products/airtight-container-1200'];
    const engine = makeEngine(site.url);
    const crawl = await engine.run({ type: 'smart', baseUrl: site.url, maxPages: 50, tierOf: tier2, urls: site.productUrls().map((url) => ({ url, reason: 'top_product' as const })) });
    const issue = issueFromFinding(findingsFor(crawl.findings, 'ONP-META', 'product')[0]);
    expect(issue.affectedUrls).toHaveLength(3);
    site.opts.missingMeta = ['/products/airtight-container-1200'];
    const rv = createReverifier({ collector: engine.collector });
    const r = await rv.verify(issue);
    expect(r).toMatchObject({ outcome: 'failed', checkedUrls: 3, failingUrls: 1 });
    expect(r.details).toContain('airtight-container-1200');
    site.opts.missingMeta = [];
    expect(await rv.verify(issue)).toMatchObject({ outcome: 'passed', failingUrls: 0 });
  });

  it('a content fix cannot be "verified" on a URL that now errors — reports error, never a fake pass', async () => {
    site.opts.missingMeta = ['/products/vegetable-chopper'];
    const engine = makeEngine(site.url);
    const crawl = await engine.run({ type: 'smart', baseUrl: site.url, maxPages: 10, tierOf: tier2, urls: [{ url: `${site.origin}/products/vegetable-chopper`, reason: 'top_product' }] });
    const issue = issueFromFinding(findingsFor(crawl.findings, 'ONP-META', 'product')[0]);
    site.opts.missingMeta = [];
    site.opts.deletedProducts = ['vegetable-chopper'];
    try {
      const r = await createReverifier({ collector: engine.collector }).verify(issue);
      expect(r.outcome).toBe('error');
      expect(r.failingUrls).toBe(0);
      expect(r.details).toMatch(/could not be verified.*HTTP 404/);
    } finally {
      site.opts.deletedProducts = [];
    }
  });

  it('site-level check (robots.txt blocking /collections/) re-verifies against the live file', async () => {
    site.opts.robotsDisallowCollections = true;
    const engine = makeEngine(site.url);
    const crawl = await engine.run({ type: 'smart', baseUrl: site.url, maxPages: 5, tierOf: tier2, urls: [], previous: { robotsTxt: 'User-agent: *\nDisallow: /cart\n' } });
    const issue = issueFromFinding(findingsFor(crawl.findings, 'TECH-ROBOTS')[0]);
    const rv = createReverifier({ collector: engine.collector });
    expect((await rv.verify(issue)).outcome).toBe('failed');
    site.opts.robotsDisallowCollections = false;
    expect(await rv.verify(issue)).toMatchObject({ outcome: 'passed', failingUrls: 0 });
  });
});
