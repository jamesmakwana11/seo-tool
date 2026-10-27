/**
 * Search / filter / sort / page an in-memory list of crawl page rows with the same rules as the API's result store
 * (used by the mock API and as the reference behaviour in tests). The API pages large runs with typed-array indexes.
 */
import type { CrawlPageProblem, CrawlPagesQuery, CrawlPagesResponse, CrawlPageStatusGroup } from './api';
import type { CrawledUrl, Severity } from './types';
import { auditPage, DEFAULT_PAGE_AUDIT_LIMITS, PAGE_AUDIT_TODO, scoreSummaryFrom, todoBit, todoIds, todoMask } from './pageAudit';

export const crawlRowStatus = (u: CrawledUrl): number | null | undefined => (u.redirects ? u.status : u.finalStatus ?? u.status);

export function crawlRowStatusGroup(u: CrawledUrl): CrawlPageStatusGroup {
  if (u.skippedByRobots || u.crawlState === 'robots') return 'robots';
  if (u.crawlState && u.crawlState !== 'fetched') return 'not_fetched';
  const s = crawlRowStatus(u);
  if (s === null || s === undefined) return 'none';
  return s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : '2xx';
}

export const CRAWL_STATUS_LABELS: Record<CrawlPageStatusGroup, string> = {
  '2xx': '2xx OK', '3xx': '3xx Redirect', '4xx': '4xx Client error', '5xx': '5xx Server error', none: 'No response', robots: 'Blocked by robots.txt', not_fetched: 'Found, not fetched',
};

export const CRAWL_PROBLEM_LABELS: Record<CrawlPageProblem, string> = {
  issues: 'Has tracked issues', broken: 'Broken internal links', 'no-title': 'Missing title', 'dup-title': 'Duplicate title', 'no-meta': 'Missing meta description',
  'dup-meta': 'Duplicate meta description', h1: 'Missing or multiple H1', alt: 'Images without alt text', noindex: 'Not indexable', 'dup-h1': 'Duplicate H1',
};

export const CRAWL_STATE_LABELS: Record<NonNullable<CrawledUrl['crawlState']>, string> = {
  fetched: 'Fetched', robots: 'Disallowed by robots.txt', excluded: 'Excluded by rule', depth_limit: 'Beyond depth limit', page_limit: 'Page limit reached', not_processed: 'Not processed (crawl stopped)',
};

const SEV: Record<Severity, number> = { critical: 3, medium: 2, low: 1 };

export function queryCrawlRows(all: CrawledUrl[], q: CrawlPagesQuery): CrawlPagesResponse {
  const html = (u: CrawledUrl) => u.title !== undefined || u.h1 !== undefined;
  const dupOf = (pick: (u: CrawledUrl) => string | undefined) => {
    const by = new Map<string, number>();
    for (const u of all) { const v = pick(u)?.trim().toLowerCase(); if (v && crawlRowStatus(u) === 200) by.set(v, (by.get(v) ?? 0) + 1); }
    return (u: CrawledUrl) => { const v = pick(u)?.trim().toLowerCase(); return !!v && crawlRowStatus(u) === 200 && (by.get(v) ?? 0) > 1; };
  };
  const dupTitle = dupOf((u) => u.title);
  const dupMeta = dupOf((u) => u.metaDescription);
  const dupH1 = dupOf((u) => (u.h1?.length === 1 ? u.h1[0] : undefined));
  const is = (u: CrawledUrl, p: CrawlPageProblem): boolean => {
    switch (p) {
      case 'issues': return !!(u.issues?.length ?? u.issueCount);
      case 'broken': return !!u.brokenLinks?.length;
      case 'no-title': return html(u) && !u.title?.trim();
      case 'dup-title': return dupTitle(u);
      case 'no-meta': return html(u) && !u.metaDescription?.trim();
      case 'dup-meta': return dupMeta(u);
      case 'h1': return html(u) && (u.h1?.length ?? 0) !== 1;
      case 'alt': return (u.imagesMissingAlt ?? 0) > 0;
      case 'noindex': return u.indexable === false;
      case 'dup-h1': return dupH1(u);
    }
  };
  const flagsOf = (u: CrawledUrl) => (Object.keys(CRAWL_PROBLEM_LABELS) as CrawlPageProblem[]).filter((p) => is(u, p));
  const audits = new Map<CrawledUrl, { score: number; todo: number }>();
  const auditOf = (u: CrawledUrl) => {
    let v = audits.get(u);
    if (!v) { const a = auditPage({ ...u, flags: flagsOf(u) }, DEFAULT_PAGE_AUDIT_LIMITS); v = { score: a.score === null ? -1 : a.score, todo: todoMask(a) }; audits.set(u, v); }
    return v;
  };
  const scoreOf = (u: CrawledUrl) => auditOf(u).score;
  const cbit = q.check !== undefined ? todoBit(q.check) : undefined;
  const band = (u: CrawledUrl) => { const v = scoreOf(u); return v < 0 ? 'none' : v < 50 ? 'poor' : v < 80 ? 'fair' : 'good'; };
  const facets: CrawlPagesResponse['facets'] = { status: {}, problem: {}, crawlState: {}, source: {}, template: {}, indexable: {}, score: {}, check: {} };
  const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
  let sum = 0;
  let scored = 0;
  const byT = new Map<string, { sum: number; n: number }>();
  for (const u of all) {
    const sc = scoreOf(u);
    if (sc >= 0) {
      sum += sc; scored++;
      const t = byT.get(u.template ?? '') ?? { sum: 0, n: 0 };
      t.sum += sc; t.n++; byT.set(u.template ?? '', t);
    }
    inc(facets.status, crawlRowStatusGroup(u));
    for (const p of Object.keys(CRAWL_PROBLEM_LABELS) as CrawlPageProblem[]) if (is(u, p)) inc(facets.problem, p);
    inc(facets.crawlState, u.crawlState ?? 'fetched');
    for (const v of u.foundVia ?? []) inc(facets.source, v);
    if (u.template) inc(facets.template, u.template);
    if (u.indexable !== undefined) inc(facets.indexable, u.indexable ? 'yes' : 'no');
    inc(facets.score!, band(u));
    const m = auditOf(u).todo;
    if (m) for (let b = 0; b < PAGE_AUDIT_TODO.length; b++) if (m & (1 << b)) inc(facets.check!, PAGE_AUDIT_TODO[b].id);
  }
  const needle = q.q?.trim().toLowerCase();
  let rows = all.filter((u) => (!q.status || crawlRowStatusGroup(u) === q.status)
    && (!q.indexable || (q.indexable === 'yes' ? u.indexable === true : u.indexable === false))
    && (!q.problem || is(u, q.problem))
    && (!q.crawlState || (u.crawlState ?? 'fetched') === q.crawlState)
    && (!q.source || (u.foundVia ?? []).includes(q.source))
    && (!q.template || u.template === q.template)
    && (!q.score || band(u) === q.score)
    && (!q.check || (cbit !== undefined && (auditOf(u).todo & (1 << cbit)) !== 0))
    && (!needle || u.url.toLowerCase().includes(needle) || (u.title ?? '').toLowerCase().includes(needle)));
  if (q.sort) {
    const dir = q.dir === 'desc' ? -1 : 1;
    const key = (u: CrawledUrl): number | string => {
      switch (q.sort) {
        case 'url': return u.url;
        case 'title': return (u.title ?? '').toLowerCase();
        case 'status': return crawlRowStatus(u) ?? 999;
        case 'depth': return u.depth ?? 998;
        case 'indexable': return u.indexable === undefined ? -1 : u.indexable ? 1 : 0;
        case 'issues': { const l = u.issues ?? []; return l.length * 10 + Math.max(0, ...l.map((i) => SEV[i.severity])); }
        case 'links': return u.internalLinks ?? -1;
        case 'inlinks': return u.inlinks ?? -1;
        case 'score': { const v = scoreOf(u); return v < 0 ? 1000 : v; }
        default: return u.responseMs ?? -1;
      }
    };
    rows = rows.map((u, i) => ({ u, i, k: key(u) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i) * dir).map((x) => x.u);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit ?? 50)) || 50));
  const offset = Math.max(0, Math.min(Math.floor(Number(q.offset ?? 0)) || 0, rows.length));
  const flagged = rows.slice(offset, offset + limit).map((u) => { const v = scoreOf(u); const t = todoIds(auditOf(u).todo); return { ...u, flags: flagsOf(u), ...(v >= 0 ? { auditScore: v } : {}), ...(t.length ? { auditTodo: t } : {}) }; });
  return { total: rows.length, offset, limit, rows: flagged, facets, auditLimits: DEFAULT_PAGE_AUDIT_LIMITS, scoreSummary: scoreSummaryFrom(sum, scored, byT) };
}
