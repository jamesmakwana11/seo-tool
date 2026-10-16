/**
 * Per-page SEO audit (SiteGuru-style "page report"): every element of one crawled page checked against clear rules,
 * with the value found and what to do about it. Pure and deterministic — computed from the crawl row only, so the
 * All Pages list (server) and the page report (browser) give the same answer.
 *
 * Score: 100, minus 15 per failed check and 5 per warning (never below 0). Only fetched HTML pages are scored.
 */
import type { CrawledUrl } from './types';

export type PageAuditArea = 'response' | 'title' | 'meta' | 'headings' | 'canonical' | 'indexability' | 'content' | 'links' | 'images';
export type PageAuditStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface PageAuditCheck {
  id: string;
  area: PageAuditArea;
  status: PageAuditStatus;
  label: string;
  /** What was found on the page. */
  value?: string;
  /** What to do (fails and warnings). */
  recommendation?: string;
  /** Extra items (broken link URLs, headings out of order …). */
  items?: string[];
}

export interface PageAudit {
  url: string;
  /** null when the page was not fetched as HTML (nothing to audit). */
  score: number | null;
  checks: PageAuditCheck[];
  counts: { pass: number; warn: number; fail: number; info: number };
  /** Why the page is not scored. */
  notAudited?: string;
}

export interface PageAuditLimits {
  titleMinChars: number;
  titleMaxChars: number;
  metaMinChars: number;
  metaMaxChars: number;
  thinContentWords: number;
  slowResponseMs: number;
}

export const DEFAULT_PAGE_AUDIT_LIMITS: PageAuditLimits = { titleMinChars: 30, titleMaxChars: 60, metaMinChars: 70, metaMaxChars: 160, thinContentWords: 150, slowResponseMs: 2000 };

export const PAGE_AUDIT_AREA_LABELS: Record<PageAuditArea, string> = {
  response: 'Response', title: 'Title', meta: 'Meta description', headings: 'Headings', canonical: 'Canonical', indexability: 'Indexability',
  content: 'Content', links: 'Links', images: 'Images',
};

export const FAIL_PENALTY = 15;
export const WARN_PENALTY = 5;
/** Templates whose pages are expected to carry real copy (thin-content and H2 checks). */
const CONTENT_TEMPLATES = new Set(['product', 'collection', 'page', 'blog_article', 'home']);

const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
const urlKey = (u: string) => { try { const x = new URL(u); x.hash = ''; let s = x.toString(); if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1); return s.toLowerCase(); } catch { return u.toLowerCase(); } };

/** Whether the row is a fetched HTML page with SEO data. */
export function isAuditable(u: CrawledUrl): boolean {
  if (u.skippedByRobots || (u.crawlState && u.crawlState !== 'fetched')) return false;
  return u.title !== undefined || u.h1 !== undefined || u.metaDescription !== undefined || u.headings !== undefined;
}

export function auditPage(u: CrawledUrl, limits: Partial<PageAuditLimits> = {}): PageAudit {
  const L = { ...DEFAULT_PAGE_AUDIT_LIMITS, ...limits };
  const checks: PageAuditCheck[] = [];
  const add = (c: PageAuditCheck) => checks.push(c);
  const status = u.redirects ? u.status : u.finalStatus ?? u.status;
  const flags = new Set(u.flags ?? []);

  // ---- response (also for pages that were not auditable)
  if (u.skippedByRobots || u.crawlState === 'robots') {
    return done(u, [{ id: 'robots-blocked', area: 'response', status: 'info', label: 'Not fetched: disallowed by robots.txt', recommendation: 'If this page should appear in search, allow it in robots.txt.' }], 'Disallowed by robots.txt, so the page was not fetched.');
  }
  if (u.crawlState && u.crawlState !== 'fetched') {
    return done(u, [{ id: 'not-fetched', area: 'response', status: 'info', label: 'Not fetched in this crawl', value: u.exclusionReason?.replace(/_/g, ' ') ?? u.indexabilityReason }], u.indexabilityReason ?? 'Not fetched in this crawl.');
  }
  if (status === null || status === undefined) {
    add({ id: 'no-response', area: 'response', status: 'fail', label: 'No response', value: u.error, recommendation: 'Check that the URL loads; a page that does not answer cannot be indexed.' });
  } else if (status >= 400) {
    add({ id: 'error-status', area: 'response', status: 'fail', label: `Answers HTTP ${status}`, value: String(status), recommendation: 'Restore the page, or 301-redirect it to the closest live page and update the links that point here.' });
  } else if (u.redirects || status >= 300) {
    add({ id: 'redirect', area: 'response', status: 'warn', label: u.redirects ? `Redirects (${u.redirects} hop${u.redirects > 1 ? 's' : ''})` : `Redirects (HTTP ${status})`, value: u.finalUrl, recommendation: 'Link straight to the final URL so visitors and crawlers skip the redirect.' });
  } else {
    add({ id: 'status-ok', area: 'response', status: 'pass', label: `Answers HTTP ${status}` });
  }
  if (u.responseMs !== undefined && u.responseMs > L.slowResponseMs) {
    add({ id: 'slow', area: 'response', status: 'warn', label: 'Slow server response', value: `${(u.responseMs / 1000).toFixed(1)} s`, recommendation: `Aim for under ${L.slowResponseMs / 1000} s: check heavy apps, uncached sections and large Liquid loops on this template.` });
  }
  if (status === null || status === undefined || status >= 400) return done(u, checks, 'The page did not load, so its content could not be audited.', 0);
  if (u.redirects || status >= 300) return done(u, checks, `Redirects to ${u.finalUrl ?? 'another URL'}: the content is audited on the final URL.`, null);
  if (!isAuditable(u)) return done(u, checks, 'No HTML content was read from this URL (not an HTML page).', null);

  // ---- title
  const title = norm(u.title);
  if (!title) add({ id: 'title-missing', area: 'title', status: 'fail', label: 'Title missing', recommendation: `Add a unique title of ${L.titleMinChars}–${L.titleMaxChars} characters that starts with the page's main topic.` });
  else {
    if (title.length > L.titleMaxChars) add({ id: 'title-long', area: 'title', status: 'warn', label: 'Title too long', value: `${title.length} characters: “${title}”`, recommendation: `Shorten to ${L.titleMaxChars} characters or less so it is not cut off in search results; keep the main keyword at the start.` });
    else if (title.length < L.titleMinChars) add({ id: 'title-short', area: 'title', status: 'warn', label: 'Title too short', value: `${title.length} characters: “${title}”`, recommendation: `Expand to ${L.titleMinChars}–${L.titleMaxChars} characters with the product / category name and a key detail.` });
    else add({ id: 'title-ok', area: 'title', status: 'pass', label: 'Title length is good', value: `${title.length} characters: “${title}”` });
    if ((u.titleCount ?? 1) > 1) add({ id: 'title-multiple', area: 'title', status: 'warn', label: `${u.titleCount} <title> tags`, recommendation: 'Keep one <title>: a second one usually comes from an app or a theme snippet, and search engines may show either.' });
    if (flags.has('dup-title')) add({ id: 'title-duplicate', area: 'title', status: 'warn', label: 'Same title as other pages in this crawl', value: title, recommendation: 'Make the title unique to this page (product name, variant, collection or location).' });
  }

  // ---- meta description
  const meta = norm(u.metaDescription);
  if (!meta) add({ id: 'meta-missing', area: 'meta', status: 'fail', label: 'Meta description missing', recommendation: `Write a ${L.metaMinChars}–${L.metaMaxChars} character summary that says what the page offers and why to click.` });
  else {
    if (meta.length > L.metaMaxChars) add({ id: 'meta-long', area: 'meta', status: 'warn', label: 'Meta description too long', value: `${meta.length} characters`, recommendation: `Trim to ${L.metaMaxChars} characters; search engines cut the rest.` });
    else if (meta.length < L.metaMinChars) add({ id: 'meta-short', area: 'meta', status: 'warn', label: 'Meta description too short', value: `${meta.length} characters: “${meta}”`, recommendation: `Expand to ${L.metaMinChars}–${L.metaMaxChars} characters with the main benefit and a reason to click.` });
    else add({ id: 'meta-ok', area: 'meta', status: 'pass', label: 'Meta description length is good', value: `${meta.length} characters` });
    if ((u.metaDescriptionCount ?? 1) > 1) add({ id: 'meta-multiple', area: 'meta', status: 'warn', label: `${u.metaDescriptionCount} meta description tags`, recommendation: 'Keep one meta description tag; remove the copy added by the theme or an app.' });
    if (flags.has('dup-meta')) add({ id: 'meta-duplicate', area: 'meta', status: 'warn', label: 'Same meta description as other pages', recommendation: 'Write a description specific to this page.' });
  }

  // ---- headings
  const h1s = (u.h1 ?? []).map(norm);
  if (!h1s.length) add({ id: 'h1-missing', area: 'headings', status: 'fail', label: 'No H1 heading', recommendation: 'Add one H1 that names the page topic (product or collection name).' });
  else if (h1s.length > 1) add({ id: 'h1-multiple', area: 'headings', status: 'warn', label: `${h1s.length} H1 headings`, items: h1s.map((h) => h || '(empty)'), recommendation: 'Keep one H1; turn the others into H2s (often a theme section repeats the title as H1).' });
  else if (!h1s[0]) add({ id: 'h1-empty', area: 'headings', status: 'warn', label: 'H1 is empty', recommendation: 'Put the page topic in the H1 text (an image-only H1 has no text).' });
  else add({ id: 'h1-ok', area: 'headings', status: 'pass', label: 'One H1', value: h1s[0] });
  const hs = u.headings ?? [];
  const h2 = hs.filter((h) => h.level === 2).length || u.h2Count || 0;
  const h3 = hs.filter((h) => h.level === 3).length;
  const contentPage = CONTENT_TEMPLATES.has(u.template ?? '');
  if (contentPage && !h2 && (u.wordCount ?? 0) >= 300) add({ id: 'h2-missing', area: 'headings', status: 'warn', label: 'No H2 subheadings', value: `${u.wordCount} words`, recommendation: 'Break the copy into sections with H2s (features, specifications, FAQs) so readers and search engines can scan it.' });
  else if (hs.length) add({ id: 'headings-count', area: 'headings', status: 'info', label: `${h2} H2 · ${h3} H3` });
  const skips: string[] = [];
  let prev = 0;
  for (const h of hs) {
    if (prev && h.level > prev + 1) skips.push(`H${prev} → H${h.level}: “${norm(h.text).slice(0, 80)}”`);
    prev = h.level;
  }
  if (skips.length) add({ id: 'headings-skip', area: 'headings', status: 'warn', label: 'Heading levels skipped', items: skips.slice(0, 10), recommendation: 'Nest headings in order (H2 before H3) — usually a theme block using an H4 for a section title.' });

  // ---- canonical
  if ((u.canonicalCount ?? 1) > 1) add({ id: 'canonical-multiple', area: 'canonical', status: 'fail', label: `${u.canonicalCount} different canonical tags`, value: u.canonical ? `first: ${u.canonical}` : undefined, recommendation: 'Search engines ignore conflicting canonicals. Keep one <link rel="canonical"> (theme.liquid) and remove the one an app or snippet adds.' });
  if (!u.canonical) add({ id: 'canonical-missing', area: 'canonical', status: 'warn', label: 'No canonical tag', recommendation: 'Add <link rel="canonical"> with this page’s preferred URL (Shopify themes output it in theme.liquid with {{ canonical_url }}).' });
  else if (urlKey(u.canonical) !== urlKey(u.finalUrl ?? u.url)) add({ id: 'canonical-other', area: 'canonical', status: 'info', label: 'Canonical points to another URL', value: u.canonical, recommendation: 'Fine for variants and collection-scoped product URLs; otherwise point it at this page.' });
  else add({ id: 'canonical-self', area: 'canonical', status: 'pass', label: 'Self-referencing canonical' });

  // ---- indexability
  if (u.indexable === false) {
    add({
      id: 'not-indexable', area: 'indexability', status: u.inSitemap ? 'fail' : 'info', label: u.inSitemap ? 'Not indexable but listed in the sitemap' : 'Not indexable', value: u.indexabilityReason,
      recommendation: u.inSitemap ? 'Either remove the noindex / canonical so it can rank, or take it out of the sitemap — the two signals conflict.' : 'Intended? If this page should rank, remove the noindex or point the canonical at it.',
    });
  } else if (u.indexable) add({ id: 'indexable', area: 'indexability', status: 'pass', label: 'Indexable' });
  if (u.inSitemap === false && u.indexable && contentPage) add({ id: 'not-in-sitemap', area: 'indexability', status: 'info', label: 'Not in the sitemap', recommendation: 'Shopify adds published products, collections, pages and articles automatically — check the page is published to the Online Store.' });

  const robots = `${u.metaRobots ?? ''} ${u.xRobotsTag ?? ''}`;
  if (/\bnofollow\b|\bnone\b/i.test(robots)) add({ id: 'page-nofollow', area: 'indexability', status: 'warn', label: 'Links on this page are not followed', value: robots.trim(), recommendation: 'Remove "nofollow" from the meta robots / X-Robots-Tag unless you want search engines to ignore every link on this page.' });

  // ---- content
  if (u.wordCount !== undefined && contentPage && u.template !== 'home') {
    if (u.wordCount < L.thinContentWords) add({ id: 'thin', area: 'content', status: 'warn', label: 'Thin content', value: `${u.wordCount} words`, recommendation: `Add at least ${L.thinContentWords} words of useful, page-specific copy (uses, materials, sizes, care, FAQs).` });
    else add({ id: 'words', area: 'content', status: 'pass', label: 'Enough copy', value: `${u.wordCount} words${u.uniqueWords !== undefined ? ` (${u.uniqueWords} unique to this page)` : ''}` });
  }

  // ---- links
  const broken = u.brokenLinks ?? [];
  if (broken.length) add({ id: 'broken-links', area: 'links', status: 'fail', label: `${broken.length}${broken.length >= 20 ? '+' : ''} broken internal link${broken.length === 1 ? '' : 's'}`, items: broken, recommendation: 'Update or remove these links (or redirect the targets) — they lead visitors and crawlers to errors.' });
  else if (u.internalLinks !== undefined) add({ id: 'links-ok', area: 'links', status: 'pass', label: 'No broken internal links found', value: `${u.internalLinks} internal links` });
  if (u.nofollowLinks) add({ id: 'nofollow-links', area: 'links', status: 'warn', label: `${u.nofollowLinks} internal link${u.nofollowLinks === 1 ? ' is' : 's are'} nofollow`, recommendation: 'Remove rel="nofollow" from links to your own pages, so they pass on ranking signals and get crawled.' });
  if (u.externalLinks !== undefined) add({ id: 'external-links', area: 'links', status: 'info', label: `${u.externalLinks} link${u.externalLinks === 1 ? '' : 's'} to other websites` });
  if (u.internalLinks === 0) add({ id: 'no-internal-links', area: 'links', status: 'warn', label: 'No internal links on the page', recommendation: 'Link to related products / collections so visitors and crawlers can continue.' });
  if (u.inlinks === 0 && u.template !== 'home') add({ id: 'orphan', area: 'links', status: 'warn', label: 'No internal links point here', value: u.inSitemap ? 'Found only through the sitemap' : undefined, recommendation: 'Link to this page from a collection, menu or related-products block; orphan pages get little crawl attention.' });
  else if (u.inlinks !== undefined && u.inlinks > 0) add({ id: 'inlinks', area: 'links', status: 'info', label: `${u.inlinks} internal link${u.inlinks === 1 ? '' : 's'} point here` });

  // ---- images
  if (u.images !== undefined) {
    const missing = u.imagesMissingAlt ?? 0;
    const shown = u.imagesMissingAltSrc ?? [];
    const altItems = shown.length ? [...shown, ...(missing > shown.length ? [`… and ${missing - shown.length} more`] : [])] : undefined;
    if (missing) add({ id: 'alt-missing', area: 'images', status: missing >= 3 || missing === u.images ? 'fail' : 'warn', label: `${missing} of ${u.images} image${u.images === 1 ? '' : 's'} without ALT text`, items: altItems, recommendation: 'Describe each product image in its ALT text (product, colour, angle); decorative images can use alt="".' });
    else if (u.images) add({ id: 'alt-ok', area: 'images', status: 'pass', label: 'All images have ALT text', value: `${u.images} images` });
  }
  return done(u, checks);
}

/** forced: the score when the content was not audited (0 = the page failed to load, null = not a page to score). */
function done(u: CrawledUrl, checks: PageAuditCheck[], notAudited?: string, forced: number | null = null): PageAudit {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status]++;
  const score = notAudited ? forced : Math.max(0, 100 - counts.fail * FAIL_PENALTY - counts.warn * WARN_PENALTY);
  const order: Record<PageAuditStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
  return { url: u.url, score, checks: [...checks].sort((a, b) => order[a.status] - order[b.status]), counts, ...(notAudited ? { notAudited } : {}) };
}

/** Score of a row as the All Pages list sorts it (same rules). -1 = not scored. */
export function pageScore(u: CrawledUrl, limits?: Partial<PageAuditLimits>): number {
  const s = auditPage(u, limits).score;
  return s === null ? -1 : s;
}

/** Page audit limits from the configured thresholds (Settings → Thresholds), falling back to the defaults. */
export function auditLimitsFrom(th?: Partial<Record<string, number>>): PageAuditLimits {
  const pick = (k: keyof PageAuditLimits) => (typeof th?.[k] === 'number' && th[k]! > 0 ? th[k]! : DEFAULT_PAGE_AUDIT_LIMITS[k]);
  return { titleMinChars: pick('titleMinChars'), titleMaxChars: pick('titleMaxChars'), metaMinChars: pick('metaMinChars'), metaMaxChars: pick('metaMaxChars'), thinContentWords: pick('thinContentWords'), slowResponseMs: DEFAULT_PAGE_AUDIT_LIMITS.slowResponseMs };
}

/** One page of a crawl with its audit (GET /api/crawls/:id/page?url=). */
export interface CrawlPageReport {
  runId: string;
  crawledAt?: string;
  row: CrawledUrl;
  audit: PageAudit;
  limits: PageAuditLimits;
  /** Other pages of the crawl with the same title / meta description (first 10 of `total`). */
  duplicates?: { title: { urls: string[]; total: number }; meta: { urls: string[]; total: number } };
}

/**
 * The to-do list of the All Pages inventory: every check that can fail or warn, with a short name. Order = bit
 * position in the server's per-page mask (append only).
 */
export const PAGE_AUDIT_TODO: { id: string; label: string; area: PageAuditArea }[] = [
  { id: 'no-response', label: 'No response', area: 'response' },
  { id: 'error-status', label: 'Error status (4xx / 5xx)', area: 'response' },
  { id: 'redirect', label: 'Redirecting URL linked', area: 'response' },
  { id: 'slow', label: 'Slow response', area: 'response' },
  { id: 'title-missing', label: 'Title missing', area: 'title' },
  { id: 'title-long', label: 'Title too long', area: 'title' },
  { id: 'title-short', label: 'Title too short', area: 'title' },
  { id: 'title-duplicate', label: 'Duplicate title', area: 'title' },
  { id: 'meta-missing', label: 'Meta description missing', area: 'meta' },
  { id: 'meta-long', label: 'Meta description too long', area: 'meta' },
  { id: 'meta-short', label: 'Meta description too short', area: 'meta' },
  { id: 'meta-duplicate', label: 'Duplicate meta description', area: 'meta' },
  { id: 'h1-missing', label: 'No H1', area: 'headings' },
  { id: 'h1-multiple', label: 'Several H1s', area: 'headings' },
  { id: 'h1-empty', label: 'Empty H1', area: 'headings' },
  { id: 'h2-missing', label: 'No H2 subheadings', area: 'headings' },
  { id: 'headings-skip', label: 'Heading levels skipped', area: 'headings' },
  { id: 'canonical-missing', label: 'No canonical', area: 'canonical' },
  { id: 'not-indexable', label: 'Not indexable but in the sitemap', area: 'indexability' },
  { id: 'thin', label: 'Thin content', area: 'content' },
  { id: 'broken-links', label: 'Broken internal links', area: 'links' },
  { id: 'no-internal-links', label: 'No internal links', area: 'links' },
  { id: 'orphan', label: 'No internal links point here', area: 'links' },
  { id: 'alt-missing', label: 'Images without ALT', area: 'images' },
  { id: 'title-multiple', label: 'Several <title> tags', area: 'title' },
  { id: 'meta-multiple', label: 'Several meta descriptions', area: 'meta' },
  { id: 'canonical-multiple', label: 'Conflicting canonical tags', area: 'canonical' },
  { id: 'page-nofollow', label: 'Page is nofollow', area: 'indexability' },
  { id: 'nofollow-links', label: 'Nofollow internal links', area: 'links' },
];
const TODO_BIT = new Map(PAGE_AUDIT_TODO.map((t, i) => [t.id, i]));

/** Bit mask of the failed / warned to-do checks of an audit. */
export function todoMask(a: PageAudit): number {
  let m = 0;
  for (const c of a.checks) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    const b = TODO_BIT.get(c.id);
    if (b !== undefined) m |= 1 << b;
  }
  return m >>> 0;
}
export const todoBit = (id: string): number | undefined => TODO_BIT.get(id);
/** Check ids of a to-do bit mask. */
export function todoIds(mask: number): string[] {
  const out: string[] = [];
  for (let b = 0; b < PAGE_AUDIT_TODO.length; b++) if (mask & (1 << b)) out.push(PAGE_AUDIT_TODO[b].id);
  return out;
}
export const PAGE_AUDIT_TODO_LABELS: Record<string, string> = Object.fromEntries(PAGE_AUDIT_TODO.map((t) => [t.id, t.label]));

/** Site-wide audit score summary of a crawl (All pages): average of scored pages, overall and per template. */
export interface PageScoreSummary {
  average: number | null;
  scored: number;
  byTemplate: Record<string, { average: number; pages: number }>;
}
/** Builds a PageScoreSummary from running sums. */
export function scoreSummaryFrom(sum: number, n: number, byT: Map<string, { sum: number; n: number }>): PageScoreSummary {
  const byTemplate: PageScoreSummary['byTemplate'] = {};
  for (const [t, v] of byT) if (v.n) byTemplate[t || 'other'] = { average: Math.round(v.sum / v.n), pages: v.n };
  return { average: n ? Math.round(sum / n) : null, scored: n, byTemplate };
}
