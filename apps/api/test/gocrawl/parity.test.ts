/**
 * The Go crawler + Rust text core + streaming batch analysis must find what the in-memory Node pipeline finds on the
 * same site: same evaluated checks and, per finding key, the same affected URLs. Runs against the local fixture store
 * (loopback only — no external website is contacted).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { makeEngine, tier2 } from '../crawler/helpers';
import { HAVE_GO, HAVE_RUST, makeGoEngine } from './goHelpers';
import type { Finding } from '../../src/services/ports';

const keyOf = (f: Finding) => f.key ?? `${f.checkId}::${f.template ?? 'site'}`;
/** Sub-problems are listed in the order pages were met, which differs between crawlers: compare them as a set. */
const titleParts = (t: string) => {
  const m = /^(.*?)\((.*)\)$/.exec(t);
  return m ? [m[1], ...m[2].split('; ').sort()] : [t];
};

function byKey(findings: Finding[]) {
  const m = new Map<string, string[]>();
  for (const f of findings) m.set(keyOf(f), [...new Set(f.urls)].sort());
  return m;
}

describe.skipIf(!HAVE_GO || !HAVE_RUST)('Go + Rust pipeline matches the Node pipeline on the fixture store', () => {
  let site: FixtureSite;
  beforeAll(async () => {
    site = await startFixtureSite({
      noindex: ['/pages/about'], deletedProducts: ['building-blocks-100'], missingCanonical: ['/products/silicone-spatula-set'],
      duplicateTitle: ['/products/led-fairy-lights-10m', '/products/artificial-money-plant'], thinCollections: ['toys'], missingMeta: ['/products/adhesive-wall-hooks'],
      multipleH1: ['/products/pull-back-racing-car'], missingAlt: ['vegetable-chopper'], largeImage: ['vegetable-chopper'], noOffers: ['airtight-container-1200'],
      reviewMarkupWithoutReviews: ['silicone-spatula-set'], robotsBlockGptBot: true, aiBoilerplate: ['led-fairy-lights-10m'], ymylClaim: ['airtight-container-1200'],
      linkErrorRoutes: true, slowMs: 1500, orphanInSitemap: true, scopedSelfCanonical: true, malformedPage: true,
    });
  });
  afterAll(async () => {
    await site.close();
  });

  it.each([250, 3])('evaluates the same checks and reports the same URLs per finding (analysis batches of %i pages)', async (batch) => {
    const node = await makeEngine(site.url).run({ type: 'full', baseUrl: site.url, maxPages: 500, tierOf: tier2 });
    const goEngine = makeGoEngine(site.url, { analysisBatchSize: batch });
    const go = await goEngine.run({ type: 'full', baseUrl: site.url, maxPages: 500, tierOf: tier2 });
    try {
      expect(go.stats.engine).toBe('go');
      expect(go.stats.textCore?.ok).toBe(true);
      expect(go.stats.outcome).toBe('completed');
      expect([...go.evaluatedChecks].sort()).toEqual([...node.evaluatedChecks].sort());
      const n = byKey(node.findings);
      const g = byKey(go.findings);
      const diffs: string[] = [];
      for (const [k, urls] of n) {
        const gu = g.get(k);
        if (!gu) diffs.push(`missing in Go: ${k} (${urls.length} URLs)`);
        else if (JSON.stringify(gu) !== JSON.stringify(urls)) diffs.push(`${k}: node ${JSON.stringify(urls)} go ${JSON.stringify(gu)}`);
      }
      for (const k of g.keys()) if (!n.has(k)) diffs.push(`extra in Go: ${k} ${JSON.stringify(g.get(k))}`);
      expect(diffs).toEqual([]);
      expect(node.findings.length).toBeGreaterThan(20);
      expect(go.findings.length).toBe(node.findings.length);
      // Template-wide flags and titles are rebuilt over the whole crawl, not per batch.
      for (const f of node.findings) {
        const gf = go.findings.find((x) => keyOf(x) === keyOf(f))!;
        expect(titleParts(gf.title), keyOf(f)).toEqual(titleParts(f.title));
        expect(!!gf.severityContext?.templateWide, keyOf(f)).toBe(!!f.severityContext?.templateWide);
        if (typeof f.severityContext?.metric === 'number') expect(Math.abs((gf.severityContext?.metric as number) - f.severityContext.metric), `${keyOf(f)} metric`).toBeLessThanOrEqual(1);
      }
      // Every fetched page has a row, plus rows for URLs found but not fetched.
      expect(go.store!.count()).toBeGreaterThanOrEqual(node.urls.length);
    } finally {
      await go.cleanup?.();
      await go.store?.dispose();
    }
  }, 120_000);
});

/** The synthetic store (tools/synthetic-store) — collections with pagination, facets, scoped product paths, sitemap
 * index with gzip sitemaps, near-duplicate templated copy, 404s and 301s — crawled by both pipelines. */
describe.skipIf(!HAVE_GO || !HAVE_RUST)('Go + Rust pipeline vs Node pipeline on the synthetic store', () => {
  let proc: import('node:child_process').ChildProcess;
  let url = '';
  beforeAll(async () => {
    const { spawn } = await import('node:child_process');
    const path = await import('node:path');
    const readline = await import('node:readline');
    proc = spawn(process.execPath, [path.resolve(__dirname, '../../../../tools/synthetic-store/server.mjs'), '--products', '400'], { stdio: ['ignore', 'pipe', 'ignore'] });
    url = await new Promise<string>((res) => readline.createInterface({ input: proc.stdout! }).once('line', (l) => res((JSON.parse(l) as { url: string }).url.replace(/\/$/, ''))));
  });
  afterAll(() => { proc?.kill(); });

  it('finds the same problems on the same URLs', async () => {
    const node = await makeEngine(url).run({ type: 'full', baseUrl: url, maxPages: 5000, tierOf: tier2, requestDelayMs: 0, concurrency: 8, timeoutMs: 15000 });
    const go = await makeGoEngine(url, { analysisBatchSize: 97, concurrency: 8, timeoutMs: 15000, requestDelayMs: 0 }).run({ type: 'full', baseUrl: url, maxPages: 5000, tierOf: tier2 });
    try {
      expect(go.stats.outcome).toBe('completed');
      const n = byKey(node.findings);
      const g = byKey(go.findings);
      const diffs: string[] = [];
      const scoped = (u: string) => /\/collections\/[^/]+\/products\//.test(u);
      for (const [k, urls] of n) {
        const gu = g.get(k) ?? [];
        const missing = urls.filter((u) => !gu.includes(u));
        const extra = gu.filter((u) => !urls.includes(u));
        // Intended differences, each checked for what it must be:
        // - the Go crawler does not fetch /collections/{c}/products/{p} duplicates of product pages (it fetches the
        //   product once), so a deleted product is reported once, under its own URL;
        if (/^TECH-(4XX|DISCONTINUED)::/.test(k)) { expect(missing.every(scoped), k).toBe(true); expect(extra, k).toEqual([]); continue; }
        // - for the same reason a product's click depth is measured through the collection link to it (shallower);
        if (k.startsWith('TECH-CRAWL-DEPTH::')) { expect(extra, k).toEqual([]); continue; }
        // - image weights are measured on a capped sample of images taken in crawl order (same size, other images).
        if (k.startsWith('PERF-IMAGES::')) { expect(gu.length, k).toBe(urls.length); continue; }
        if (missing.length || extra.length) diffs.push(`${k}: node ${urls.length} go ${gu.length}; missing in go ${JSON.stringify(missing.slice(0, 3))}; extra in go ${JSON.stringify(extra.slice(0, 3))}`);
      }
      for (const k of g.keys()) if (!n.has(k)) diffs.push(`extra in Go: ${k} (${g.get(k)!.length} URLs)`);
      console.log(`node pages ${node.urls.length}, go rows ${go.store!.count()}, node findings ${node.findings.length}, go findings ${go.findings.length}`);
      expect(diffs).toEqual([]);
    } finally {
      await go.cleanup?.();
      await go.store?.dispose();
    }
  }, 300_000);
});
