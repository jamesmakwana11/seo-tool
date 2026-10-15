import { describe, expect, it } from 'vitest';
import { crawlOptionErrors, crawlResultsCsv, defaultCrawlOptions, validateCrawlOptions, type CrawlDetail } from '../src';

const SITE = 'https://deodap.in/';
const ok = { startUrl: 'https://deodap.in/collections/kitchen', maxPages: 100, maxDepth: 3, timeoutMs: 15000, concurrency: 2 };

describe('crawl options', () => {
  it('defaults to all pages at any depth (no limit) and are valid for the site', () => {
    const d = defaultCrawlOptions(SITE);
    expect(d.maxPages).toBeNull();
    expect(d.maxDepth).toBeNull();
    expect(crawlOptionErrors(d, SITE)).toEqual({});
    expect(defaultCrawlOptions(SITE, 20).maxPages).toBe(20);
  });

  it('has no upper page or depth limit unless the server sets a cap', () => {
    expect(crawlOptionErrors({ ...ok, maxPages: 250000, maxDepth: 500 }, SITE)).toEqual({});
    expect(validateCrawlOptions({ ...ok, maxPages: null, maxDepth: null }, SITE)).toMatchObject({ maxPages: null, maxDepth: null });
    expect(crawlOptionErrors({ ...ok, maxPages: null }, SITE, 1000).maxPages).toMatch(/limits a crawl to 1,000 pages/);
  });

  it('accepts www and non-www of the selected website and strips the fragment', () => {
    expect(validateCrawlOptions({ ...ok, startUrl: 'https://www.deodap.in/pages/about#team' }, SITE).startUrl).toBe('https://www.deodap.in/pages/about');
  });

  it.each([
    ['', /Enter the page/],
    ['deodap.in', /full URL/],
    ['ftp://deodap.in/', /http/],
    ['https://user:pw@deodap.in/', /user name or password/],
    ['https://evil.example/', /must be on deodap\.in/],
    ['https://deodap.in.evil.example/', /must be on deodap\.in/],
    ['http://169.254.169.254/latest/', /must be on deodap\.in/],
  ])('rejects start URL %s', (startUrl, msg) => {
    expect(crawlOptionErrors({ ...ok, startUrl }, SITE).startUrl).toMatch(msg);
  });

  it('enforces numeric limits and the optional server page cap', () => {
    const e = crawlOptionErrors({ ...ok, maxPages: 0, maxDepth: -1, timeoutMs: 999, concurrency: 1.5 }, SITE);
    expect(Object.keys(e).sort()).toEqual(['concurrency', 'maxDepth', 'maxPages', 'timeoutMs']);
    expect(crawlOptionErrors({ ...ok, maxPages: 101 }, SITE, 100).maxPages).toMatch(/limits a crawl to 100 pages/);
    expect(crawlOptionErrors({ ...ok, maxPages: '10' as unknown as number }, SITE).maxPages).toMatch(/whole number/);
    expect(crawlOptionErrors({ ...ok, maxPages: undefined }, SITE).maxPages).toMatch(/All pages/);
  });

  it('accepts an optional per-crawl delay between requests (0–10,000 ms)', () => {
    expect(validateCrawlOptions({ ...ok, requestDelayMs: 500 }, SITE).requestDelayMs).toBe(500);
    expect(validateCrawlOptions({ ...ok }, SITE).requestDelayMs).toBeUndefined();
    expect(crawlOptionErrors({ ...ok, requestDelayMs: 10001 }, SITE).requestDelayMs).toMatch(/between 0 and 10,000 ms/);
    expect(crawlOptionErrors({ ...ok, requestDelayMs: -1 }, SITE).requestDelayMs).toMatch(/between 0/);
  });

  it('validateCrawlOptions throws a 400 listing every field', () => {
    try {
      validateCrawlOptions({ startUrl: 'https://x.example/', maxPages: 0 }, SITE);
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as { status: number; details: { fields: Record<string, string> } };
      expect(err.status).toBe(400);
      expect(Object.keys(err.details.fields)).toEqual(expect.arrayContaining(['startUrl', 'maxPages', 'maxDepth', 'timeoutMs', 'concurrency']));
    }
  });
});

describe('crawl CSV export', () => {
  const detail = (title: string): CrawlDetail => ({
    run: { id: 'CRL-0001', type: 'full', status: 'completed', trigger: 'manual', urlsPlanned: 1, urlsCrawled: 1, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], source: 'live' },
    urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage', title, h1: ['A', 'B'], issues: [{ id: 'ISS-0001', checkId: 'ONP-META', title: 'Missing meta', severity: 'medium', summary: '' }] }],
    verification: [],
  });
  it('quotes commas, quotes and newlines', () => {
    const csv = crawlResultsCsv(detail('Hello, "world"\nline'));
    expect(csv).toContain('"Hello, ""world""\nline"');
    expect(csv).toContain('A | B');
    expect(csv).toContain('ISS-0001 ONP-META [medium] Missing meta');
  });
  it('neutralises spreadsheet formulas in page content', () => {
    expect(crawlResultsCsv(detail('=HYPERLINK("http://x","y")'))).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(crawlResultsCsv(detail('+1+2'))).toContain(",'+1+2,");
    expect(crawlResultsCsv(detail('@cmd'))).toContain(",'@cmd,");
  });
});
