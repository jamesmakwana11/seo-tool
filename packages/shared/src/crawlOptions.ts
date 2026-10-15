/**
 * Live-crawl settings: safe limits, validation and result export. Shared by the API (authoritative validation) and the
 * web app (inline form errors), so both always agree on what is allowed.
 */
import { ApiError, type CrawlDetail } from './api';
import type { CrawlOptions, CrawledUrl } from './types';

/**
 * Bounds for the numeric settings. Pages and depth have NO upper bound: null means "crawl every page" / "follow links
 * at any depth". A server may still set an optional page cap with CRAWLER_MAX_PAGES (unset by default).
 */
export const CRAWL_LIMITS = {
  maxPages: { min: 1 },
  maxDepth: { min: 0 },
  timeoutMs: { min: 2000, max: 60000, default: 15000 },
  concurrency: { min: 1, max: 8, default: 2 },
  requestDelayMs: { min: 0, max: 10000 },
} as const;

export type CrawlOptionField = keyof CrawlOptions;

/** Default: every page, any depth (or the server cap when one is configured). */
export function defaultCrawlOptions(siteUrl: string, maxPagesCap: number | null = null): CrawlOptions {
  return {
    startUrl: siteUrl,
    maxPages: maxPagesCap ?? null,
    maxDepth: null,
    timeoutMs: CRAWL_LIMITS.timeoutMs.default,
    concurrency: CRAWL_LIMITS.concurrency.default,
  };
}

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, '');

/**
 * Field-level problems with a crawl request, or {} when it is valid. The start URL must be an http(s) URL on the website
 * selected in Sentinel (www / non-www both accepted) — a crawl can never be pointed at another host from here.
 */
export function crawlOptionErrors(input: Partial<Record<CrawlOptionField, unknown>>, siteUrl: string, maxPagesCap: number | null = null): Partial<Record<CrawlOptionField, string>> {
  const errs: Partial<Record<CrawlOptionField, string>> = {};
  const raw = typeof input.startUrl === 'string' ? input.startUrl.trim() : '';
  let site: URL | undefined;
  try { site = new URL(siteUrl); } catch { /* reported below */ }
  if (!raw) errs.startUrl = 'Enter the page to start crawling from.';
  else {
    let u: URL | undefined;
    try { u = new URL(raw); } catch { errs.startUrl = 'Enter a full URL, for example https://www.example.com/.'; }
    if (u) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errs.startUrl = 'The URL must start with http:// or https://.';
      else if (u.username || u.password) errs.startUrl = 'Remove the user name or password from the URL.';
      else if (!site || stripWww(u.hostname) !== stripWww(site.hostname)) errs.startUrl = `The start URL must be on ${site ? stripWww(site.hostname) : 'the selected website'} — the website selected in Sentinel. To crawl another site, add it under Manage websites.`;
    }
  }
  const whole = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
  const fmt = (n: number) => n.toLocaleString('en-US');
  // Pages: null = all pages. A number must be at least 1 (and within the server cap, if one is set).
  if (input.maxPages === null || input.maxPages === undefined) {
    if (input.maxPages === undefined) errs.maxPages = 'Choose All pages or enter a number of pages.';
    else if (maxPagesCap) errs.maxPages = `This server limits a crawl to ${fmt(maxPagesCap)} pages (CRAWLER_MAX_PAGES). Enter ${fmt(maxPagesCap)} or fewer.`;
  } else if (!whole(input.maxPages)) errs.maxPages = 'Maximum pages must be a whole number.';
  else if ((input.maxPages as number) < CRAWL_LIMITS.maxPages.min) errs.maxPages = 'Maximum pages must be at least 1.';
  else if (maxPagesCap && (input.maxPages as number) > maxPagesCap) errs.maxPages = `This server limits a crawl to ${fmt(maxPagesCap)} pages (CRAWLER_MAX_PAGES).`;
  // Depth: null = no limit.
  if (input.maxDepth === undefined) errs.maxDepth = 'Choose No limit or enter a crawl depth.';
  else if (input.maxDepth !== null) {
    if (!whole(input.maxDepth)) errs.maxDepth = 'Crawl depth must be a whole number.';
    else if ((input.maxDepth as number) < CRAWL_LIMITS.maxDepth.min) errs.maxDepth = 'Crawl depth must be 0 or more.';
  }
  const num = (field: 'timeoutMs' | 'concurrency', lo: number, hi: number, label: string, unit = '') => {
    const v = input[field];
    if (!whole(v)) errs[field] = `${label} must be a whole number.`;
    else if ((v as number) < lo || (v as number) > hi) errs[field] = `${label} must be between ${fmt(lo)} and ${fmt(hi)}${unit}.`;
  };
  num('timeoutMs', CRAWL_LIMITS.timeoutMs.min, CRAWL_LIMITS.timeoutMs.max, 'Request timeout', ' ms');
  if (input.requestDelayMs !== undefined && input.requestDelayMs !== null) {
    const v = input.requestDelayMs;
    if (!whole(v)) errs.requestDelayMs = 'Delay between requests must be a whole number of milliseconds.';
    else if ((v as number) < CRAWL_LIMITS.requestDelayMs.min || (v as number) > CRAWL_LIMITS.requestDelayMs.max) errs.requestDelayMs = `Delay between requests must be between 0 and ${fmt(CRAWL_LIMITS.requestDelayMs.max)} ms.`;
  }
  num('concurrency', CRAWL_LIMITS.concurrency.min, CRAWL_LIMITS.concurrency.max, 'Concurrency');
  return errs;
}

/** Validated options (start URL normalised, fragment removed) or a 400 VALIDATION error listing every bad field. */
export function validateCrawlOptions(input: unknown, siteUrl: string, maxPagesCap: number | null = null): CrawlOptions {
  const o = (input && typeof input === 'object' ? input : {}) as Partial<Record<CrawlOptionField, unknown>>;
  const errs = crawlOptionErrors(o, siteUrl, maxPagesCap);
  const fields = Object.keys(errs) as CrawlOptionField[];
  if (fields.length) throw new ApiError(400, 'VALIDATION', fields.map((f) => errs[f]).join(' '), { fields: errs });
  const u = new URL(String(o.startUrl).trim());
  u.hash = '';
  const out: CrawlOptions = { startUrl: u.toString(), maxPages: o.maxPages as number | null, maxDepth: o.maxDepth as number | null, timeoutMs: o.timeoutMs as number, concurrency: o.concurrency as number };
  if (typeof o.requestDelayMs === 'number') out.requestDelayMs = o.requestDelayMs;
  return out;
}

// ------------------------------------------------------------------ export

export const CRAWL_EXPORT_NOTE =
  'TEMPORARY results: crawl jobs and results are kept in server memory only and are erased when the server restarts or is redeployed.';

const CSV_COLUMNS: { header: string; value: (u: CrawledUrl) => unknown }[] = [
  { header: 'url', value: (u) => u.url },
  { header: 'final_url', value: (u) => u.finalUrl },
  { header: 'status', value: (u) => u.status },
  { header: 'final_status', value: (u) => u.finalStatus },
  { header: 'redirects', value: (u) => u.redirects },
  { header: 'redirected_from', value: (u) => u.redirectedFrom },
  { header: 'depth', value: (u) => u.depth },
  { header: 'found_via', value: (u) => u.reason },
  { header: 'content_type', value: (u) => u.contentType },
  { header: 'indexable', value: (u) => (u.indexable === undefined ? '' : u.indexable ? 'yes' : 'no') },
  { header: 'indexability_reason', value: (u) => u.indexabilityReason },
  { header: 'title', value: (u) => u.title },
  { header: 'title_length', value: (u) => u.title?.length },
  { header: 'meta_description', value: (u) => u.metaDescription },
  { header: 'meta_description_length', value: (u) => u.metaDescription?.length },
  { header: 'h1_count', value: (u) => u.h1?.length },
  { header: 'h1', value: (u) => u.h1?.join(' | ') },
  { header: 'h2_count', value: (u) => u.h2Count },
  { header: 'canonical', value: (u) => u.canonical },
  { header: 'meta_robots', value: (u) => u.metaRobots },
  { header: 'x_robots_tag', value: (u) => u.xRobotsTag },
  { header: 'in_sitemap', value: (u) => (u.inSitemap === undefined ? '' : u.inSitemap ? 'yes' : 'no') },
  { header: 'internal_links', value: (u) => u.internalLinks },
  { header: 'broken_links', value: (u) => u.brokenLinks?.length },
  { header: 'broken_link_urls', value: (u) => u.brokenLinks?.join(' ') },
  { header: 'images', value: (u) => u.images },
  { header: 'images_missing_alt', value: (u) => u.imagesMissingAlt },
  { header: 'response_ms', value: (u) => u.responseMs },
  { header: 'bytes', value: (u) => u.bytes },
  { header: 'issue_count', value: (u) => u.issues?.length },
  { header: 'issues', value: (u) => u.issues?.map((i) => `${i.id} ${i.checkId} [${i.severity}] ${i.title}`).join(' | ') },
  { header: 'error', value: (u) => u.error },
];

/** One CSV cell. Values that a spreadsheet would run as a formula (=, +, -, @, tab, CR) are prefixed with a quote. */
function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function crawlResultsCsv(d: CrawlDetail): string {
  const lines = [CSV_COLUMNS.map((c) => c.header).join(',')];
  for (const u of d.urls) lines.push(CSV_COLUMNS.map((c) => csvCell(c.value(u))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function crawlResultsJson(d: CrawlDetail, exportedAt: string): string {
  return JSON.stringify({ note: CRAWL_EXPORT_NOTE, exportedAt, run: d.run, pages: d.urls, sitemapDiff: d.sitemapDiff ?? null }, null, 2);
}

export function crawlExportFilename(d: CrawlDetail, format: 'csv' | 'json'): string {
  let host = 'site';
  try { host = new URL(d.run.options?.startUrl ?? d.urls[0]?.url ?? '').hostname.replace(/^www\./, ''); } catch { /* keep default */ }
  return `crawl-${host}-${d.run.id}.${format}`;
}
