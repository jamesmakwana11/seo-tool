import type { Evidence, PageTemplate } from '@sentinel/shared';
import { wordCount } from '@sentinel/shared';
import type { Finding } from '../services/ports';
import type { LinkStatus, ParsedPage, SiteContext } from '../crawler/types';
import { normalizeUrl, pathOf, sameUrl, urlKey } from '../crawler/url';

export type Ev = Omit<Evidence, 'id' | 'capturedAt' | 'source'>;

export interface AnalyzerResult {
  /** false ⇒ the check could not be evaluated in this run (its open issues must NOT be auto-resolved). */
  evaluated: boolean;
  /** Templates the check actually examined (page-level checks). Empty/undefined for site-level checks. */
  templates?: PageTemplate[];
  findings: Finding[];
  reason?: string;
}

export interface StatusInfo {
  url: string;
  status: number | null;
  finalStatus: number | null;
  finalUrl: string;
  chain: LinkStatus['chain'];
  redirectLoop: boolean;
  error?: string;
  noindex?: boolean;
  page?: ParsedPage;
}

/** Pre-computed views shared by every analyzer (computed once per run). */
export interface Prepared {
  ctx: SiteContext;
  all: ParsedPage[];
  /** Pages that were requested (not robots-skipped, not derived duplicates of a redirect). */
  requested: ParsedPage[];
  /** 200 HTML pages without redirect (incl. final targets of redirects), excluding crawl-budget samples. */
  ok: ParsedPage[];
  /** `ok` pages that are indexable (no noindex, canonical absent or self). */
  indexable: ParsedPage[];
  /** `ok` pages whose content is evaluated by page-level checks: self-canonical (or no canonical), not intentionally noindexed, not search. */
  content: ParsedPage[];
  /** Crawl-budget samples (parameter / tag URLs). */
  budgetSamples: ParsedPage[];
  byTemplate: Map<PageTemplate, ParsedPage[]>;
  statusOf(url: string): StatusInfo | undefined;
  /** Main-content text minus blocks repeated across ≥50% of the template's pages (template chrome). */
  uniqueText(p: ParsedPage): string;
  uniqueWords(p: ParsedPage): number;
  boilerplateKnown(t: PageTemplate): boolean;
  /** Internal inlinks (source page URLs) per normalized target URL. */
  inlinks: Map<string, string[]>;
  /** Same lists keyed by urlKey (trailing-slash-insensitive): the first list per key, for inlinksOf's fallback. */
  inlinksByKey?: Map<string, string[]>;
}

export const TEMPLATE_NOUN: Record<PageTemplate, [string, string]> = {
  home: ['homepage', 'homepages'],
  collection: ['collection page', 'collection pages'],
  product: ['product page', 'product pages'],
  blog_article: ['blog article', 'blog articles'],
  blog_index: ['blog index page', 'blog index pages'],
  page: ['content page', 'content pages'],
  search: ['search page', 'search pages'],
  other: ['page', 'pages'],
};

export function noun(t: PageTemplate | undefined, n: number): string {
  const [s, p] = TEMPLATE_NOUN[t ?? 'other'];
  return n === 1 ? s : p;
}

export function isNoindex(p: ParsedPage): { noindex: boolean; via?: string; value?: string } {
  const meta = p.html?.metaRobots ?? '';
  if (/\b(noindex|none)\b/.test(meta)) return { noindex: true, via: 'meta robots', value: meta };
  const x = p.headers['x-robots-tag'] ?? '';
  if (/\b(noindex|none)\b/i.test(x)) return { noindex: true, via: 'X-Robots-Tag header', value: x };
  return { noindex: false };
}

export function isIntentionalNoindex(url: string, ctx: SiteContext): boolean {
  const path = pathOf(url);
  return (ctx.config.intentionalNoindex ?? []).some((pref) => path === pref || path.startsWith(pref.endsWith('/') ? pref : `${pref}/`) || path.startsWith(`${pref}?`));
}

export function canonicalOf(p: ParsedPage): string | undefined {
  return p.html?.canonicals[0];
}

export function isSelfCanonical(p: ParsedPage): boolean {
  const c = canonicalOf(p);
  return !c || sameUrl(c, p.url);
}

export function prepare(pages: ParsedPage[], ctx: SiteContext): Prepared {
  const requested = pages.filter((p) => !p.skippedByRobots && !p.derivedFrom);
  const ok = pages.filter((p) => !p.skippedByRobots && !p.budgetSample && !p.paginated && !p.scopedSample && p.status === 200 && p.chain.length === 0 && !!p.html);
  const indexable = ok.filter((p) => !isNoindex(p).noindex && isSelfCanonical(p));
  const budgetSamples = pages.filter((p) => p.budgetSample && !p.skippedByRobots);
  const content = ok.filter((p) => !p.paginated && p.template !== 'search' && isSelfCanonical(p) && !isIntentionalNoindex(p.url, ctx));
  const byTemplate = new Map<PageTemplate, ParsedPage[]>();
  for (const p of ok) { const list = byTemplate.get(p.template); if (list) list.push(p); else byTemplate.set(p.template, [p]); }

  // Indexed lookups (no per-link scans), so analysis stays fast on crawls of tens of thousands of pages.
  const pageIndex = new Map<string, ParsedPage>();
  const pageKeyIndex = new Map<string, ParsedPage>();
  const derivedOf = new Map<string, ParsedPage>();
  for (const p of pages) {
    if (p.derivedFrom && !derivedOf.has(p.derivedFrom)) derivedOf.set(p.derivedFrom, p);
    if (p.skippedByRobots) continue;
    pageIndex.set(normalizeUrl(p.url), p);
    pageKeyIndex.set(urlKey(p.url), p);
  }
  const linkKeyIndex = new Map<string, LinkStatus>();
  for (const l of ctx.linkTargets.values()) if (!linkKeyIndex.has(urlKey(l.url))) linkKeyIndex.set(urlKey(l.url), l);
  // Links repeat on most pages: normalise each distinct link string once.
  const normCache = new Map<string, string>();
  const norm = (u: string) => {
    let v = normCache.get(u);
    if (v === undefined) { v = normalizeUrl(u); normCache.set(u, v); }
    return v;
  };
  const statusCache = new Map<string, StatusInfo | undefined>();
  const statusOf = (url: string): StatusInfo | undefined => {
    if (statusCache.has(url)) return statusCache.get(url);
    const s = statusOfUncached(url);
    statusCache.set(url, s);
    return s;
  };
  const statusOfUncached = (url: string): StatusInfo | undefined => {
    const k = norm(url);
    const p = pageIndex.get(k) ?? pageKeyIndex.get(urlKey(url));
    if (p) {
      const target = p.chain.length ? derivedOf.get(p.url) : p;
      return {
        url: p.url, status: p.status, finalStatus: p.finalStatus, finalUrl: p.finalUrl, chain: p.chain, redirectLoop: p.redirectLoop, error: p.error,
        noindex: target ? isNoindex(target).noindex : undefined, page: p,
      };
    }
    const l = ctx.linkTargets.get(k) ?? linkKeyIndex.get(urlKey(url));
    if (l) return { url: l.url, status: l.status, finalStatus: l.finalStatus, finalUrl: l.finalUrl, chain: l.chain, redirectLoop: l.redirectLoop, error: l.error };
    return undefined;
  };

  // Template boilerplate: blocks appearing on ≥50% (and ≥3) of a template's pages.
  const boiler = new Map<PageTemplate, Set<string>>();
  for (const [t, list] of byTemplate) {
    if (list.length < 3) continue;
    const freq = new Map<string, number>();
    for (const p of list) for (const b of new Set(p.html!.ownBlocks)) freq.set(b, (freq.get(b) ?? 0) + 1);
    const min = Math.max(3, Math.ceil(list.length * 0.5));
    boiler.set(t, new Set([...freq.entries()].filter(([, n]) => n >= min).map(([b]) => b)));
  }
  const uniqCache = new Map<ParsedPage, string>();
  const uniqueText = (p: ParsedPage) => {
    if (!p.html) return '';
    const hit = uniqCache.get(p);
    if (hit !== undefined) return hit;
    const b = boiler.get(p.template);
    const text = p.html.ownBlocks.filter((x) => !b || !b.has(x)).join('\n');
    uniqCache.set(p, text);
    return text;
  };

  const inlinks = new Map<string, string[]>();
  const keyCache = new Map<string, string>();
  const keyOf = (u: string) => {
    let v = keyCache.get(u);
    if (v === undefined) { v = urlKey(u); keyCache.set(u, v); }
    return v;
  };
  for (const p of ok) {
    const self = urlKey(p.url);
    const seen = new Set<string>();
    for (const raw of p.html!.internalLinks) {
      const l = norm(raw);
      if (seen.has(l)) continue;
      seen.add(l);
      if (keyOf(l) === self) continue;
      { const list = inlinks.get(l); if (list) list.push(p.url); else inlinks.set(l, [p.url]); }
    }
  }
  const inlinksByKey = new Map<string, string[]>();
  for (const [k, v] of inlinks) { const kk = keyOf(k); if (!inlinksByKey.has(kk)) inlinksByKey.set(kk, v); }
  keyCache.clear();

  const wordsCache = new Map<ParsedPage, number>();
  return {
    ctx, all: pages, requested, ok, indexable, content, budgetSamples, byTemplate, statusOf, uniqueText,
    uniqueWords: (p) => {
      let n = wordsCache.get(p);
      if (n === undefined) { n = wordCount(uniqueText(p)); wordsCache.set(p, n); }
      return n;
    },
    boilerplateKnown: (t) => boiler.has(t),
    inlinks,
    inlinksByKey,
  };
}

export function inlinksOf(prep: Prepared, url: string): string[] {
  const k = normalizeUrl(url);
  const direct = prep.inlinks.get(k);
  if (direct) return direct;
  if (prep.inlinksByKey) return prep.inlinksByKey.get(urlKey(k)) ?? [];
  for (const [kk, v] of prep.inlinks) if (sameUrl(kk, k)) return v;
  return [];
}

export function groupByTemplate<T extends { template: PageTemplate }>(items: T[]): Map<PageTemplate, T[]> {
  const m = new Map<PageTemplate, T[]>();
  for (const i of items) { const list = m.get(i.template); if (list) list.push(i); else m.set(i.template, [i]); }
  return m;
}

// ------------------------------------------------------------------------------------------- finding builder

export interface Problem {
  /** Lower-case phrase completing "N product pages …" (e.g. "missing meta description"). */
  label: string;
  urls: string[];
  evidence?: Ev[];
}

export interface AggregateOpts {
  checkId: string;
  template?: PageTemplate;
  /** Phrase for multi-problem titles: "N product pages with {noun}". */
  noun: string;
  problems: Problem[];
  /** Pages of this template examined (for templateWide). */
  examined?: number;
  severityContext?: Finding['severityContext'];
  keySuffix?: string;
  businessImpact?: string;
  extraEvidence?: Ev[];
  summaryPrefix?: string;
  /** Override the computed title. */
  title?: string;
  maxEvidence?: number;
}

const uniq = <T>(a: T[]) => [...new Set(a)];

/** One finding per check per template aggregating several sub-problems. Returns undefined if nothing failed. */
export function aggregate(o: AggregateOpts): Finding | undefined {
  const problems = o.problems.filter((p) => p.urls.length);
  if (!problems.length) return undefined;
  const urls = uniq(problems.flatMap((p) => p.urls));
  const n = urls.length;
  const nn = noun(o.template, n);
  let title: string;
  if (o.title) title = o.title;
  else if (problems.length === 1) title = `${n} ${nn} ${problems[0].label}`;
  else title = `${n} ${nn} with ${o.noun} (${problems.map((p) => `${p.urls.length} ${p.label}`).join('; ')})`;
  const templateWide = (o.examined ?? 0) >= 2 && problems.some((p) => uniq(p.urls).length >= (o.examined ?? Infinity));
  const max = o.maxEvidence ?? 15;
  const evidence: Ev[] = [];
  for (const p of problems) {
    evidence.push({ kind: 'note', label: `${p.urls.length} URL(s): ${p.label}`, data: { problem: p.label, urls: p.urls.slice(0, 200), count: p.urls.length } });
  }
  const per = Math.max(2, Math.floor((max - evidence.length) / Math.max(1, problems.length)));
  for (const p of problems) evidence.push(...(p.evidence ?? []).slice(0, per));
  if (o.extraEvidence) evidence.push(...o.extraEvidence);
  const summary = [
    o.summaryPrefix,
    ...problems.map((p) => `• ${p.urls.length} ${noun(o.template, p.urls.length)} ${p.label}${p.urls.length <= 3 ? `: ${p.urls.join(', ')}` : ''}`),
    templateWide ? `Every examined ${noun(o.template, 1)} (${o.examined}) is affected — template-level defect.` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    checkId: o.checkId,
    template: o.template,
    key: `${o.checkId}::${o.template ?? 'site'}${o.keySuffix ? `::${o.keySuffix}` : ''}`,
    title,
    summary,
    businessImpact: o.businessImpact,
    urls,
    severityContext: { ...(templateWide ? { templateWide: true } : {}), ...(o.severityContext ?? {}) },
    evidence,
  };
}

/** Evidence items kept per problem while collecting (aggregate() shows at most 15 per finding). */
export const MAX_KEPT_EVIDENCE = 30;

/**
 * Collects problems by label with O(1) URL de-duplication and a cap on kept evidence — for analyzers that add URLs one
 * at a time (sitemap entries, 4xx pages, redirects), which can number in the tens of thousands on a large crawl.
 */
export function problemCollector() {
  const problems: Problem[] = [];
  const byLabel = new Map<string, { p: Problem; urls: Set<string> }>();
  /** Adds the URL (once) and its evidence (capped). Returns true when the URL was new for this label. */
  const add = (label: string, url: string, ev?: Ev, evidenceOnlyIfNew = false): boolean => {
    let e = byLabel.get(label);
    if (!e) { e = { p: { label, urls: [], evidence: [] }, urls: new Set() }; byLabel.set(label, e); problems.push(e.p); }
    const isNew = !e.urls.has(url);
    if (isNew) { e.urls.add(url); e.p.urls.push(url); }
    if (ev && (isNew || !evidenceOnlyIfNew) && e.p.evidence!.length < MAX_KEPT_EVIDENCE) e.p.evidence!.push(ev);
    return isNew;
  };
  return { problems, add, get: (label: string) => byLabel.get(label)?.p };
}

/** Largest / smallest of a list without spreading it into arguments (a spread of 100k+ values overflows the stack). */
export function maxOf(values: Iterable<number>, empty = -Infinity): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m === -Infinity ? empty : m;
}
export function minOf(values: Iterable<number>, empty = Infinity): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m === Infinity ? empty : m;
}

/** Run a per-page predicate over pages grouped by template and aggregate. */
export function perTemplate(
  prep: Prepared,
  pages: ParsedPage[],
  checkId: string,
  nounText: string,
  evaluate: (p: ParsedPage) => { label: string; evidence?: Ev[] }[],
  extra?: (t: PageTemplate, examined: ParsedPage[]) => Partial<AggregateOpts>,
): AnalyzerResult {
  const findings: Finding[] = [];
  const groups = groupByTemplate(pages);
  for (const [t, list] of groups) {
    const probs = new Map<string, Problem>();
    // Sets for membership and a cap on kept evidence: aggregate() shows at most `maxEvidence` (15) items, so a problem
    // shared by tens of thousands of pages does not hold evidence for every one of them.
    const seen = new Map<string, Set<string>>();
    for (const p of list) {
      for (const r of evaluate(p)) {
        let pr = probs.get(r.label);
        if (!pr) { pr = { label: r.label, urls: [], evidence: [] }; probs.set(r.label, pr); seen.set(r.label, new Set()); }
        const s = seen.get(r.label)!;
        if (!s.has(p.url)) { s.add(p.url); pr.urls.push(p.url); }
        if (r.evidence?.length && pr.evidence!.length < MAX_KEPT_EVIDENCE) pr.evidence!.push(...r.evidence.slice(0, MAX_KEPT_EVIDENCE - pr.evidence!.length));
      }
    }
    const f = aggregate({ checkId, template: t, noun: nounText, problems: [...probs.values()], examined: list.length, ...(extra?.(t, list) ?? {}) });
    if (f) findings.push(f);
  }
  void prep;
  return { evaluated: true, templates: [...groups.keys()], findings };
}

export function httpEv(url: string, s: Pick<StatusInfo, 'status' | 'finalStatus' | 'chain' | 'error'> & { responseMs?: number }, label?: string): Ev {
  const lines = [
    ...s.chain.map((h) => `${h.url} → ${h.status} Location: ${h.location}`),
    s.finalStatus !== null ? `${s.chain.length ? s.chain[s.chain.length - 1].location : url} → ${s.finalStatus}` : `${url} → ${s.error ?? 'no response'}`,
  ];
  return {
    kind: 'http_response',
    label: label ?? `HTTP ${s.status ?? 'error'} ${url}`,
    url,
    content: lines.join('\n'),
    data: { status: s.status, finalStatus: s.finalStatus, hops: s.chain.length, chain: s.chain, error: s.error, responseMs: s.responseMs },
  };
}

export function htmlEv(url: string, label: string, snippet: string): Ev {
  return { kind: 'html_snippet', label, url, content: snippet.slice(0, 1500) };
}

export function textEv(url: string, label: string, passage: string, data?: Record<string, unknown>): Ev {
  return { kind: 'text_passage', label, url, content: passage.slice(0, 1200), data };
}

export function metricEv(label: string, data: Record<string, unknown>, url?: string): Ev {
  return { kind: 'metric', label, url, data };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function trunc(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
