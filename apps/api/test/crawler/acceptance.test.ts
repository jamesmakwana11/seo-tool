import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifySeverity, defaultConfig } from '@sentinel/shared';
import { startFixtureSite, type FixtureSite } from './fixtureSite';
import { findingsFor, makeEngine, tier2 } from './helpers';

/**
 * PDF §16 acceptance: "a new template-level bug injected in staging is detected within one daily cycle".
 */
describe('acceptance: template-level bug detected in one daily (smart) cycle', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await startFixtureSite();
  });
  afterAll(async () => {
    await site.close();
  });

  it('clean fixture → no product schema finding; product template loses offers → one smart crawl flags ALL product URLs template-wide', async () => {
    const engine = makeEngine(site.url);
    // Weekly full crawl of the clean staging site.
    const full = await engine.run({ type: 'full', baseUrl: site.url, maxPages: 200, tierOf: tier2 });
    expect(findingsFor(full.findings, 'TECH-SCHEMA-PRESENCE', 'product')).toEqual([]);
    expect(findingsFor(full.findings, 'TECH-SCHEMA-ERRORS', 'product')).toEqual([]);
    expect(full.evaluatedChecks).toContain('TECH-SCHEMA-PRESENCE');

    // Theme deploy breaks the product template: offers removed from every product's JSON-LD.
    site.opts.productTemplateNoOffers = true;

    // Next daily smart crawl: homepage + collections + top products (PDF §2.1 scope).
    const products = site.productUrls();
    const smart = await engine.run({
      type: 'smart', baseUrl: site.url, maxPages: 500, tierOf: tier2, previous: full.snapshot,
      urls: [...site.collectionUrls().map((url) => ({ url, reason: 'collection' as const })), ...products.map((url) => ({ url, reason: 'top_product' as const }))],
    });
    const f = findingsFor(smart.findings, 'TECH-SCHEMA-PRESENCE', 'product');
    expect(f).toHaveLength(1);
    expect(f[0].urls.sort()).toEqual([...products].sort());
    expect(f[0].severityContext?.templateWide).toBe(true);
    expect(f[0].title).toMatch(/^8 product pages Product schema missing offers/);
    expect(f[0].evidence.some((e) => e.kind === 'jsonld' && !String(e.content).includes('"offers"'))).toBe(true);
    expect(f[0].summary).toContain('template-level defect');
    // Template-wide flag escalates via the issue service's grouping; Google rich-result loss is also flagged as an error.
    const errs = findingsFor(smart.findings, 'TECH-SCHEMA-ERRORS', 'product');
    expect(errs[0]?.severityContext?.templateWide).toBe(true);
    expect(classifySeverity({ checkId: 'TECH-SCHEMA-ERRORS', highestTier: 1, ...errs[0].severityContext }, defaultConfig()).severity).toBe('critical');
    site.opts.productTemplateNoOffers = false;
  });
});
