/**
 * Go crawler records → the analysis engine's ParsedPage, and the compact "lite" page kept for every page of a crawl.
 *
 * A full ParsedPage (links, images, text blocks, segments, JSON-LD …) costs tens of KB of memory; a 50,000-page crawl
 * cannot keep them all on a ~500 MB server. Full pages therefore live only while their batch is analysed. Every page
 * also gets a lite copy that keeps what the whole-crawl checks need (status, redirects, title, meta description, H1s,
 * canonical, robots directives, head scripts, schema types, word counts, a few flags) and drops the rest; repeated
 * values (script lists, schema type lists, canonical URLs, feature objects) are shared between pages.
 */
import type { CrawledUrl, PageTemplate, PageTier } from '@sentinel/shared';
import type { FetchResult, ParsedHtml, ParsedPage, SchemaNode } from '../crawler/types';
import { typesOf } from '../analysis/schema';

/** One line of pages.ndjson.gz (see PageRecord in services/crawler-go/crawl.go). */
export interface PageRecord extends Omit<FetchResult, 'body'> {
  id: number;
  template: PageTemplate;
  reason: CrawledUrl['reason'];
  depth?: number;
  inSitemap: boolean;
  skippedByRobots?: boolean;
  derivedFrom?: string;
  budgetSample?: string;
  scopedSample?: boolean;
  paginated?: boolean;
  foundVia?: string[];
  foundOn?: string;
  html?: Partial<ParsedHtml>;
}

/** One line of urls.ndjson.gz (URLRecord in crawl.go). */
export interface UrlRecord {
  url: string;
  state: 'queued' | 'active' | 'fetched' | 'excluded' | 'robots' | 'depth_limit' | 'page_limit' | 'not_processed' | 'waiting';
  reason?: string;
  depth?: number;
  foundVia: string[] | null;
  foundOn?: string;
  template: PageTemplate;
  inlinks: number;
  priority?: number;
  robots?: string;
  trap?: string;
  lastmod?: string;
  inSitemap: boolean;
}

export type GoPage = ParsedPage & { goId: number; foundVia?: string[]; foundOn?: string };

const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

/** Fills defaults (the crawler omits empty optional values) and derives mainText / blocks from the segments. */
export function normalizeHtml(h: Partial<ParsedHtml>): ParsedHtml {
  const segments = arr(h.segments);
  return {
    lang: h.lang,
    hasViewport: !!h.hasViewport,
    title: h.title,
    titleCount: h.titleCount ?? 0,
    metaDescription: h.metaDescription,
    metaDescriptionCount: h.metaDescriptionCount ?? 0,
    metaRobots: h.metaRobots,
    canonicals: arr(h.canonicals),
    og: h.og ?? {},
    twitter: h.twitter ?? {},
    h1s: arr(h.h1s),
    headings: arr(h.headings),
    links: arr(h.links),
    internalLinks: arr(h.internalLinks),
    externalLinks: arr(h.externalLinks),
    internalLinkCount: h.internalLinkCount ?? 0,
    images: arr(h.images),
    headScripts: arr(h.headScripts),
    scriptSrcs: arr(h.scriptSrcs),
    stylesheets: arr(h.stylesheets),
    jsonld: arr(h.jsonld),
    schemaNodes: arr(h.schemaNodes),
    schemaTypes: arr(h.schemaTypes),
    visiblePrices: arr(h.visiblePrices),
    breadcrumb: h.breadcrumb ?? { visible: false },
    reviews: { visibleCount: h.reviews?.visibleCount ?? 0, texts: arr(h.reviews?.texts), summaryText: h.reviews?.summaryText, hasVisible: !!h.reviews?.hasVisible },
    faq: { present: !!h.faq?.present, items: arr(h.faq?.items) },
    questionHeadings: arr(h.questionHeadings),
    author: h.author ?? { hasBio: false },
    visibleDates: arr(h.visibleDates),
    // parse.ts: mainText = every segment joined by newlines; blocks = the text segments.
    mainText: segments.map((s) => s.text).join('\n'),
    wordCount: h.wordCount ?? 0,
    blocks: segments.filter((s) => s.kind === 'text').map((s) => s.text),
    ownBlocks: arr(h.ownBlocks),
    segments,
    descriptionText: h.descriptionText,
    descriptionWords: h.descriptionWords ?? 0,
    contentWordsExcludingGrid: h.contentWordsExcludingGrid ?? 0,
    mixedContent: arr(h.mixedContent),
    pagination: h.pagination ?? {},
    features: h.features ?? { tables: 0, dataTables: 0, orderedLists: 0, definitionLists: 0, video: false, specTable: false },
    phoneVisible: !!h.phoneVisible,
  };
}

export function toParsedPage(r: PageRecord, tierOf: (url: string) => PageTier): GoPage {
  const p: GoPage = {
    url: r.url,
    finalUrl: r.finalUrl || r.url,
    status: r.status ?? null,
    finalStatus: r.finalStatus ?? null,
    chain: arr(r.chain),
    redirectLoop: !!r.redirectLoop,
    tooManyRedirects: !!r.tooManyRedirects,
    responseMs: r.responseMs,
    finalResponseMs: r.finalResponseMs,
    totalMs: r.totalMs ?? 0,
    error: r.error || undefined,
    headers: r.headers ?? {},
    contentType: r.contentType || undefined,
    bytes: r.bytes,
    truncated: r.truncated || undefined,
    template: r.template,
    tier: tierOf(r.url),
    reason: r.reason,
    depth: r.depth,
    inSitemap: !!r.inSitemap,
    skippedByRobots: r.skippedByRobots || undefined,
    derivedFrom: r.derivedFrom || undefined,
    budgetSample: r.budgetSample || undefined,
    scopedSample: r.scopedSample || undefined,
    paginated: r.paginated || undefined,
    html: r.html ? normalizeHtml(r.html) : undefined,
    goId: r.id,
    foundVia: r.foundVia ?? undefined,
    foundOn: r.foundOn || undefined,
  };
  return p;
}

/** Shares equal values between lite pages (most pages of a store carry the same scripts, schema types and features). */
export class Interner {
  private strings = new Map<string, string>();
  private values = new Map<string, unknown>();
  str<T extends string | undefined>(s: T): T {
    if (s === undefined) return s;
    const hit = this.strings.get(s);
    if (hit !== undefined) return hit as T;
    if (this.strings.size < 400_000) this.strings.set(s, s);
    return s;
  }
  /** Forget shared values (the lite index they belonged to is gone); strings stay shared. */
  dropValues() {
    this.values.clear();
  }
  /** Shared, frozen copy of a JSON-able value (arrays / small objects). */
  val<T>(v: T): T {
    const k = JSON.stringify(v);
    const hit = this.values.get(k);
    if (hit !== undefined) return hit as T;
    const frozen = deepFreeze(v);
    if (this.values.size < 200_000) this.values.set(k, frozen);
    return frozen;
  }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

const EMPTY: never[] = Object.freeze([]) as unknown as never[];

/**
 * Defaults every lite page shares (empty lists, no text): they live on one prototype instead of being copied into each
 * of tens of thousands of objects. The lists are frozen, so no analyzer can change them for every page at once; the
 * prototype itself is not (a frozen prototype would forbid giving a page its own value).
 */
const LITE_HTML_DEFAULTS = ({
  og: Object.freeze({}), twitter: Object.freeze({}), headings: EMPTY, links: EMPTY, externalLinks: EMPTY, images: EMPTY, stylesheets: EMPTY, jsonld: EMPTY,
  visiblePrices: EMPTY, questionHeadings: EMPTY, visibleDates: EMPTY, mainText: '', blocks: EMPTY, ownBlocks: EMPTY, segments: EMPTY, mixedContent: EMPTY,
  descriptionText: undefined, internalLinks: EMPTY, canonicals: EMPTY, schemaNodes: EMPTY, schemaTypes: EMPTY, headScripts: EMPTY, scriptSrcs: EMPTY,
  lang: undefined, metaRobots: undefined, title: undefined, metaDescription: undefined,
}) as Record<string, unknown>;
const TRUST_LINK = /\/(pages|policies)\//i;
const ORG_TYPES = ['Organization', 'OnlineStore', 'Corporation', 'Store', 'LocalBusiness'];
const BREADCRUMB_YES = Object.freeze({ visible: true });
const BREADCRUMB_NO = Object.freeze({ visible: false });
const NO_REVIEWS = Object.freeze({ visibleCount: 0, texts: EMPTY, hasVisible: false });
const FAQ_YES = Object.freeze({ present: true, items: EMPTY });
const FAQ_NO = Object.freeze({ present: false, items: EMPTY });
const NO_AUTHOR = Object.freeze({ hasBio: false });
const NO_PAGINATION = Object.freeze({});

/** Organization-type nodes anywhere in the page's JSON-LD (AEO-ENTITY compares them across the site). */
function orgNodes(nodes: SchemaNode[]): SchemaNode[] {
  const out: SchemaNode[] = [];
  const rec = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => rec(x, depth + 1));
    const o = v as SchemaNode;
    if (typesOf(o).some((t) => ORG_TYPES.includes(t))) out.push(o);
    for (const [k, val] of Object.entries(o)) if (k !== '@context') rec(val, depth + 1);
  };
  for (const n of nodes) rec(n, 0);
  return out;
}

/**
 * The lite copy of a page (see the file comment). Links are reduced to what whole-crawl checks read: links to
 * /pages/ and /policies/ (GEO-EEAT trust pages) and, on collection pages, links to products (TECH-DISCONTINUED).
 */
export function litePage(p: GoPage, I: Interner): GoPage {
  const h = p.html;
  const url = I.str(p.url);
  const lite: GoPage = {
    ...p,
    url,
    finalUrl: p.finalUrl === p.url ? url : I.str(p.finalUrl),
    headers: I.val(p.headers),
    contentType: I.str(p.contentType),
    error: I.str(p.error),
    chain: p.chain.length ? p.chain : EMPTY,
    // Page rows carry these; whole-crawl checks do not need them.
    foundVia: undefined,
    foundOn: undefined,
    html: undefined,
  };
  if (h) {
    const links = h.internalLinks.filter((l) => TRUST_LINK.test(l) || (p.template === 'collection' && l.includes('/products/')));
    const orgs = orgNodes(h.schemaNodes);
    // Only values that differ from the shared defaults become own properties.
    const o: Record<string, unknown> = Object.create(LITE_HTML_DEFAULTS);
    o.hasViewport = h.hasViewport;
    if (h.lang) o.lang = I.str(h.lang);
    if (h.title !== undefined) o.title = h.title;
    o.titleCount = h.titleCount;
    if (h.metaDescription !== undefined) o.metaDescription = h.metaDescription;
    o.metaDescriptionCount = h.metaDescriptionCount;
    if (h.metaRobots !== undefined) o.metaRobots = I.str(h.metaRobots);
    // A self-canonical page shares its URL string; the list itself is tiny.
    if (h.canonicals.length) o.canonicals = h.canonicals.map((c) => (c === p.url ? url : I.str(c)));
    o.h1s = h.h1s;
    if (links.length) o.internalLinks = I.val([...new Set(links)]);
    o.internalLinkCount = h.internalLinkCount;
    if (h.headScripts.length) o.headScripts = I.val(h.headScripts);
    if (h.scriptSrcs.length) o.scriptSrcs = I.val(h.scriptSrcs);
    if (orgs.length) o.schemaNodes = I.val(orgs);
    if (h.schemaTypes.length) o.schemaTypes = I.val(h.schemaTypes);
    o.breadcrumb = h.breadcrumb.visible ? BREADCRUMB_YES : BREADCRUMB_NO;
    o.reviews = h.reviews.visibleCount || h.reviews.hasVisible ? I.val({ visibleCount: h.reviews.visibleCount, texts: [], hasVisible: h.reviews.hasVisible }) : NO_REVIEWS;
    o.faq = h.faq.present ? FAQ_YES : FAQ_NO;
    o.author = h.author.name || h.author.hasBio ? I.val({ name: h.author.name, hasBio: h.author.hasBio }) : NO_AUTHOR;
    o.wordCount = h.wordCount;
    o.descriptionWords = h.descriptionWords;
    o.contentWordsExcludingGrid = h.contentWordsExcludingGrid;
    if (h.mixedContent.length) o.mixedContent = h.mixedContent.slice(0, 10);
    o.pagination = h.pagination.next || h.pagination.prev ? h.pagination : NO_PAGINATION;
    o.features = I.val(h.features);
    o.phoneVisible = h.phoneVisible;
    lite.html = o as unknown as ParsedHtml;
  }
  return lite;
}

/**
 * Adds back the parts of a page that whole-crawl checks need as evidence for duplicate clusters: its own text (capped),
 * and its in-content internal links (AIC-08 doorway destination).
 */
export function enrichLite(lite: GoPage, full: GoPage, withLinks: boolean): void {
  if (!lite.html || !full.html) return;
  const cap = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) : s);
  let budget = 3000;
  const own: string[] = [];
  for (const b of full.html.ownBlocks) {
    if (budget <= 0) break;
    own.push(b.length > budget ? b.slice(0, budget) : b);
    budget -= b.length;
  }
  // Keep the shared defaults (prototype) and the page's own values; add the evidence fields as own values.
  const o = Object.assign(Object.create(Object.getPrototypeOf(lite.html)), lite.html) as Record<string, unknown>;
  o.ownBlocks = own;
  o.descriptionText = cap(full.html.descriptionText, 3000);
  if (withLinks) o.links = full.html.links.filter((l) => l.internal && l.inMain).slice(0, 300);
  lite.html = o as unknown as ParsedHtml;
}
