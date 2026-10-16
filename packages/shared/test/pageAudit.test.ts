import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_AUDIT_LIMITS, FAIL_PENALTY, PAGE_AUDIT_TODO, WARN_PENALTY, auditLimitsFrom, auditPage, pageScore, queryCrawlRows, todoBit, todoMask,
  type CrawledUrl,
} from '../src';

const O = 'https://store.example';
/** A product page that passes every check. */
const good = (over: Partial<CrawledUrl> = {}): CrawledUrl => ({
  url: `${O}/products/steel-chopper`, status: 200, finalStatus: 200, reason: 'full', template: 'product', contentType: 'text/html',
  title: 'Stainless Steel Vegetable Chopper with 3 Blades', metaDescription: 'Chop onions, tomatoes and herbs in seconds with this stainless steel chopper: three blades, easy to clean, dishwasher safe.',
  h1: ['Stainless Steel Vegetable Chopper'], h2Count: 2, headings: [{ level: 1, text: 'Stainless Steel Vegetable Chopper' }, { level: 2, text: 'Features' }, { level: 3, text: 'Blades' }, { level: 2, text: 'Care' }],
  canonical: `${O}/products/steel-chopper`, indexable: true, indexabilityReason: 'Indexable', inSitemap: true, wordCount: 420, internalLinks: 60, inlinks: 4, brokenLinks: [],
  images: 5, imagesMissingAlt: 0, responseMs: 300, ...over,
});
const ids = (u: CrawledUrl) => auditPage(u).checks.filter((c) => c.status === 'fail' || c.status === 'warn').map((c) => c.id).sort();

describe('page audit', () => {
  it('scores a complete page 100 with no problems', () => {
    const a = auditPage(good());
    expect(a.score).toBe(100);
    expect(a.counts.fail + a.counts.warn).toBe(0);
    expect(a.checks.map((c) => c.area)).toEqual(expect.arrayContaining(['response', 'title', 'meta', 'headings', 'canonical', 'indexability', 'content', 'links', 'images']));
  });

  it('finds each element problem and gives a recommendation for it', () => {
    const u = good({ title: '', metaDescription: undefined, h1: [], headings: [{ level: 2, text: 'A' }, { level: 4, text: 'B' }], canonical: undefined, wordCount: 40, brokenLinks: [`${O}/products/gone`], imagesMissingAlt: 1 });
    expect(ids(u)).toEqual(['alt-missing', 'broken-links', 'canonical-missing', 'h1-missing', 'headings-skip', 'meta-missing', 'thin', 'title-missing']);
    const a = auditPage(u);
    for (const c of a.checks.filter((x) => x.status === 'fail' || x.status === 'warn')) expect(c.recommendation, c.id).toBeTruthy();
    expect(a.score).toBe(100 - a.counts.fail * FAIL_PENALTY - a.counts.warn * WARN_PENALTY);
    expect(a.checks[0].status).toBe('fail'); // problems first
    expect(a.checks.find((c) => c.id === 'broken-links')?.items).toEqual([`${O}/products/gone`]);
  });

  it('uses the configured length limits', () => {
    const u = good({ title: 'Steel chopper for the kitchen' }); // 29 characters
    expect(ids(u)).toEqual(['title-short']);
    expect(ids({ ...u })).toEqual(ids(u));
    expect(auditPage(u, { titleMinChars: 20 }).counts.warn).toBe(0);
    expect(auditLimitsFrom({ titleMaxChars: 70, metaMinChars: 0 })).toEqual({ ...DEFAULT_PAGE_AUDIT_LIMITS, titleMaxChars: 70 });
    expect(ids(good({ title: 'x'.repeat(61) }))).toEqual(['title-long']);
    expect(ids(good({ metaDescription: 'm'.repeat(161) }))).toEqual(['meta-long']);
  });

  it('flags duplicates, several H1s, noindex pages in the sitemap and orphans', () => {
    expect(ids(good({ flags: ['dup-title', 'dup-meta'] }))).toEqual(['meta-duplicate', 'title-duplicate']);
    expect(ids(good({ h1: ['A', 'B'] }))).toEqual(['h1-multiple']);
    expect(ids(good({ indexable: false, indexabilityReason: 'noindex' }))).toEqual(['not-indexable']);
    expect(auditPage(good({ indexable: false, inSitemap: false })).checks.find((c) => c.id === 'not-indexable')?.status).toBe('info');
    expect(ids(good({ inlinks: 0 }))).toEqual(['orphan']);
  });

  it('finds repeated tags, nofollow and lists the images without ALT text', () => {
    expect(ids(good({ titleCount: 2, metaDescriptionCount: 2 }))).toEqual(['meta-multiple', 'title-multiple']);
    const canon = auditPage(good({ canonicalCount: 2 }));
    expect(canon.checks.find((c) => c.id === 'canonical-multiple')?.status).toBe('fail');
    expect(ids(good({ metaRobots: 'index, nofollow' }))).toEqual(['page-nofollow']);
    expect(ids(good({ xRobotsTag: 'none', indexable: false, inSitemap: false }))).toEqual(['page-nofollow']);
    expect(ids(good({ nofollowLinks: 3 }))).toEqual(['nofollow-links']);
    expect(auditPage(good({ externalLinks: 4 })).checks.find((c) => c.id === 'external-links')?.label).toBe('4 links to other websites');
    const alt = auditPage(good({ imagesMissingAlt: 7, imagesMissingAltSrc: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'] })).checks.find((c) => c.id === 'alt-missing');
    expect(alt?.items).toEqual(['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg', '… and 5 more']);
  });

  it('does not score pages it could not audit, and never invents content checks for them', () => {
    const e404 = auditPage(good({ status: 404, finalStatus: 404, title: undefined }));
    expect(e404.score).toBe(0);
    expect(e404.checks.map((c) => c.id)).toEqual(['error-status']);
    const redirect = auditPage(good({ status: 301, redirects: 1, finalUrl: `${O}/products/new`, finalStatus: 200 }));
    expect(redirect.score).toBeNull();
    expect(redirect.checks.map((c) => c.id)).toEqual(['redirect']);
    // A 3xx answer without redirect details (older / sample rows) is a redirect too, not a page without HTML.
    const bare = auditPage({ url: `${O}/old`, status: 301, reason: 'full' });
    expect([bare.score, bare.checks.map((c) => c.id), bare.notAudited]).toEqual([null, ['redirect'], 'Redirects to another URL: the content is audited on the final URL.']);
    const robots = auditPage({ url: `${O}/cart`, status: null, reason: 'full', skippedByRobots: true });
    expect(robots.score).toBeNull();
    expect(robots.notAudited).toMatch(/robots/);
    const notFetched = auditPage({ url: `${O}/x`, status: null, reason: 'full', crawlState: 'page_limit' });
    expect(notFetched.score).toBeNull();
    expect(pageScore({ url: `${O}/x`, status: null, reason: 'full', crawlState: 'page_limit' })).toBe(-1);
  });

  it('keeps the to-do bit mask in line with the check ids', () => {
    const a = auditPage(good({ title: '', imagesMissingAlt: 2 }));
    const mask = todoMask(a);
    expect(mask & (1 << todoBit('title-missing')!)).toBeTruthy();
    expect(mask & (1 << todoBit('alt-missing')!)).toBeTruthy();
    expect(mask & (1 << todoBit('meta-missing')!)).toBe(0);
    expect(PAGE_AUDIT_TODO.length).toBeLessThanOrEqual(32);
    expect(new Set(PAGE_AUDIT_TODO.map((t) => t.id)).size).toBe(PAGE_AUDIT_TODO.length);
  });

  it('filters, counts and sorts the page list by score and check', () => {
    const rows = [good(), good({ url: `${O}/products/b`, title: '', metaDescription: 'Keep dals, rice and snacks fresh in airtight jars with locking lids, stackable and BPA-free plastic, sold as a set.' }), good({ url: `${O}/products/c`, title: 'Plastic Airtight Food Storage Container Set of 6', metaDescription: '', h1: [] }), { url: `${O}/old`, status: 301, redirects: 1, reason: 'full' as const }];
    const all = queryCrawlRows(rows, { limit: 50 });
    // Duplicate titles / descriptions are worked out over the whole crawl.
    expect(queryCrawlRows([good(), good({ url: `${O}/products/twin` })], {}).facets.check).toEqual({ 'title-duplicate': 2, 'meta-duplicate': 2 });
    expect(all.facets.score).toEqual({ good: 2, fair: 1, none: 1 });
    expect(all.facets.check).toEqual({ 'title-missing': 1, 'meta-missing': 1, 'h1-missing': 1, redirect: 1 });
    expect(queryCrawlRows(rows, { check: 'title-missing' }).rows.map((r) => r.url)).toEqual([`${O}/products/b`]);
    expect(queryCrawlRows(rows, { score: 'fair' }).rows.map((r) => r.url)).toEqual([`${O}/products/c`]);
    const asc = queryCrawlRows(rows, { sort: 'score', dir: 'asc' }).rows.map((r) => r.auditScore);
    expect(asc).toEqual([70, 85, 100, undefined]);
    expect(queryCrawlRows(rows, { check: 'title-missing' }).rows[0].auditTodo).toEqual(['title-missing']);
    // Site average over the scored pages (the redirect is not scored), per template too.
    expect(all.scoreSummary).toEqual({ average: 85, scored: 3, byTemplate: { product: { average: 85, pages: 3 } } });
  });
});
