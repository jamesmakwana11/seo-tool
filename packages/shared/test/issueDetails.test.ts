import { describe, expect, it } from 'vitest';
import { CRAWL_PROBLEM_LABELS, auditPage, pageCheckFix, queryCrawlRows, type CrawledUrl } from '../src';

/** Every finding names the exact page, element and related pages: duplicate H1s and images repeated on one page. */
const O = 'https://store.example';
const page = (over: Partial<CrawledUrl> = {}): CrawledUrl => ({
  url: `${O}/products/a`, status: 200, finalStatus: 200, reason: 'full', template: 'product', contentType: 'text/html',
  title: 'Stainless Steel Vegetable Chopper with 3 Blades', metaDescription: 'Chop onions, tomatoes and herbs in seconds with this stainless steel chopper: three blades, easy to clean.',
  h1: ['Vegetable Chopper'], h2Count: 2, canonical: `${O}/products/a`, indexable: true, indexabilityReason: 'Indexable', inSitemap: true,
  wordCount: 420, internalLinks: 60, inlinks: 4, brokenLinks: [], images: 5, imagesMissingAlt: 0, responseMs: 300, ...over,
});
const find = (u: CrawledUrl, id: string) => auditPage(u).checks.find((c) => c.id === id);

describe('issue details: duplicate H1 and repeated images', () => {
  it('flags the same H1 across pages (crawl-wide) with the H1 text, and only then', () => {
    expect(find(page(), 'h1-duplicate')).toBeUndefined();
    const c = find(page({ flags: ['dup-h1'] }), 'h1-duplicate');
    expect(c).toMatchObject({ status: 'warn', value: 'Vegetable Chopper', area: 'headings' });
    expect(CRAWL_PROBLEM_LABELS['dup-h1']).toBe('Duplicate H1');
    // Two pages with one identical H1 (different titles / descriptions) are both counted.
    const rows = [page({ url: `${O}/products/a`, title: 'Chopper A for kitchen use, three blades' }), page({ url: `${O}/products/b`, title: 'Chopper B for kitchen use, five blades', metaDescription: 'Another description of a different chopper with five blades and a storage box for the kitchen.' }), page({ url: `${O}/products/c`, h1: ['Something else'], title: 'Other product with a long enough title', metaDescription: 'A third description that is unique and long enough to pass the meta description length check.' })];
    const res = queryCrawlRows(rows, { limit: 50 });
    expect(res.facets.check?.['h1-duplicate']).toBe(2);
    expect(res.facets.problem['dup-h1']).toBe(2);
    expect(res.rows.find((r) => r.url.endsWith('/c'))?.flags ?? []).not.toContain('dup-h1');
  });

  it('lists each image shown more than once on the page with its count; reuse across pages is not a page finding', () => {
    expect(find(page({ repeatedImages: [] }), 'images-repeated')).toBeUndefined();
    const u = page({ repeatedImages: [{ src: 'https://cdn.example/badge.png', count: 3, instances: [{ position: 1, alt: null, inMain: false, location: 'footer › section "footer" › .footer__badge' }, { position: 4, alt: null, inMain: true }, { position: 9, alt: '', inMain: true }] }] });
    const c = find(u, 'images-repeated')!;
    expect(c.status).toBe('warn');
    expect(c.label).toBe('1 image shown more than once on this page');
    expect(c.items).toEqual(['https://cdn.example/badge.png — 3×']);
  });

  it('both findings say where to fix them and how long it takes', () => {
    for (const id of ['h1-duplicate', 'images-repeated']) {
      const f = pageCheckFix(id, 'product');
      expect(f?.where.length, id).toBeGreaterThan(0);
      expect(f!.time.maxMinutes).toBeGreaterThan(f!.time.minMinutes);
    }
  });

  it('missing-ALT lists every recorded image address and says when some were not recorded', () => {
    const all = find(page({ imagesMissingAlt: 3, imagesMissingAltSrc: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg', 'https://cdn.example/3.jpg'] }), 'alt-missing')!;
    expect(all.items).toEqual(['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg', 'https://cdn.example/3.jpg']);
    const old = find(page({ imagesMissingAlt: 5, imagesMissingAltSrc: ['https://cdn.example/1.jpg'] }), 'alt-missing')!;
    expect(old.items?.at(-1)).toMatch(/4 more .*not recorded/);
  });
});
