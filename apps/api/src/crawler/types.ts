import type { CrawledUrl, CrawlType, PageTemplate, PageTier, SentinelConfig } from '@sentinel/shared';
import type { PreviousCrawlState } from '../services/ports';
import type { ParsedRobots } from './robots';

/** One redirect hop: `url` answered `status` with a Location pointing at `location`. */
export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

/** Result of one HTTP request with manual redirect following. Never thrown — failures are data. */
export interface FetchResult {
  /** Requested (normalized) URL. */
  url: string;
  finalUrl: string;
  /** Status of the FIRST response (301/302 for redirects); null on network error / timeout. */
  status: number | null;
  /** Status of the last response in the chain; null when the chain failed. */
  finalStatus: number | null;
  chain: RedirectHop[];
  redirectLoop: boolean;
  tooManyRedirects: boolean;
  /** Time to response headers of the first request (ms). */
  responseMs?: number;
  /** Time to response headers of the final request (ms). */
  finalResponseMs?: number;
  totalMs: number;
  error?: string;
  /** Lower-cased response headers of the final response. */
  headers: Record<string, string>;
  contentType?: string;
  body?: string;
  bytes?: number;
  /** The body was larger than the read limit: only the first part was read. */
  truncated?: boolean;
}

export interface SchemaNode {
  [key: string]: unknown;
}

export interface Segment {
  kind: 'heading' | 'text';
  level?: number;
  text: string;
}

export interface ParsedHtml {
  lang?: string;
  hasViewport: boolean;
  title?: string;
  titleCount: number;
  metaDescription?: string;
  metaDescriptionCount: number;
  /** Combined content of meta robots / googlebot tags (lower-case). */
  metaRobots?: string;
  canonicals: string[];
  og: { url?: string; title?: string; image?: string; description?: string; type?: string };
  twitter: { card?: string; title?: string; image?: string };
  h1s: string[];
  headings: { level: number; text: string }[];
  links: { url: string; text: string; internal: boolean; inMain: boolean; rel?: string }[];
  internalLinks: string[];
  externalLinks: string[];
  /** Raw number of internal <a href> elements (not unique). */
  internalLinkCount: number;
  /** location: landmark › Shopify section › component class (where on the page), when identifiable. */
  images: { src: string; alt: string | null; width?: string; height?: string; loading?: string; inMain: boolean; index: number; location?: string }[];
  headScripts: { src: string; async: boolean; defer: boolean; module: boolean; type?: string }[];
  scriptSrcs: string[];
  stylesheets: string[];
  jsonld: { raw: string; ok: boolean; error?: string }[];
  /** Top-level JSON-LD nodes (incl. @graph members). */
  schemaNodes: SchemaNode[];
  /** Every @type found anywhere (incl. nested). */
  schemaTypes: string[];
  visiblePrices: { text: string; values: number[] }[];
  breadcrumb: { visible: boolean; text?: string };
  reviews: { visibleCount: number; texts: string[]; summaryText?: string; hasVisible: boolean };
  faq: { present: boolean; items: { q: string; a: string }[] };
  questionHeadings: { level: number; text: string; firstAnswer: string; firstAnswerWords: number }[];
  author: { name?: string; hasBio: boolean; bioText?: string };
  visibleDates: { label: string; text: string; iso?: string }[];
  mainText: string;
  wordCount: number;
  blocks: string[];
  /** Main-content text blocks excluding product grids / cards (a collection's own copy). */
  ownBlocks: string[];
  segments: Segment[];
  descriptionText?: string;
  descriptionWords: number;
  /** Main-content words excluding product grids/cards (collection "own copy"). */
  contentWordsExcludingGrid: number;
  mixedContent: string[];
  pagination: { next?: string; prev?: string };
  features: {
    tables: number;
    dataTables: number;
    orderedLists: number;
    definitionLists: number;
    video: boolean;
    specTable: boolean;
    definitionSentence?: string;
  };
  phoneVisible: boolean;
}

export interface ParsedPage extends FetchResult {
  template: PageTemplate;
  tier: PageTier;
  reason: CrawledUrl['reason'];
  /** BFS click depth from the homepage (full crawls only). */
  depth?: number;
  inSitemap: boolean;
  skippedByRobots?: boolean;
  /** Set when this entry was created from the final response of a redirect of another URL. */
  derivedFrom?: string;
  /** Parameter / faceted / tag URL fetched as a crawl-budget sample (value = reason). Excluded from page-content checks. */
  budgetSample?: string;
  /** /collections/{c}/products/{p} URL fetched only to verify its canonical (TECH-SHOPIFY-DUP-PATHS). */
  scopedSample?: boolean;
  /** ?page=N (N ≥ 2) URL. Excluded from page-content checks; used by TECH-PAGINATION. */
  paginated?: boolean;
  html?: ParsedHtml;
}

export interface RobotsInfo {
  url: string;
  status: number | null;
  error?: string;
  body?: string;
  parsed: ParsedRobots;
}

export interface SitemapEntry {
  url: string;
  lastmod?: string;
  file: string;
}

export interface SitemapFile {
  url: string;
  status: number | null;
  kind: 'urlset' | 'sitemapindex' | 'invalid' | 'unreachable';
  count: number;
  error?: string;
  /** Larger than the read limit: entries after the limit were not read. */
  truncated?: boolean;
}

export interface SitemapInfo {
  rootUrls: string[];
  files: SitemapFile[];
  entries: SitemapEntry[];
}

export interface LinkStatus {
  url: string;
  status: number | null;
  finalStatus: number | null;
  finalUrl: string;
  chain: RedirectHop[];
  redirectLoop: boolean;
  error?: string;
}

export interface AssetInfo {
  url: string;
  status: number | null;
  bytes?: number;
  contentType?: string;
  error?: string;
}

export interface TlsInfo {
  host: string;
  validTo?: string;
  daysLeft?: number;
  authorized?: boolean;
  authorizationError?: string;
  error?: string;
}

export interface HostVariant {
  url: string;
  isCanonical: boolean;
  status: number | null;
  finalStatus: number | null;
  finalUrl: string;
  chain: RedirectHop[];
  error?: string;
}

/** Everything analyzers may need beyond the page list. Optional members ⇒ that data was not collected. */
export interface SiteContext {
  baseUrl: string;
  origin: string;
  host: string;
  isLocal: boolean;
  crawlType: CrawlType;
  config: SentinelConfig;
  thresholds: Record<string, number>;
  previous?: PreviousCrawlState;
  now: Date;
  userAgent: string;
  tierOf: (url: string) => PageTier;
  robots?: RobotsInfo;
  sitemap?: SitemapInfo;
  /** HEAD/GET status of internal link targets, canonical targets and sitemap entries that were not crawled as pages. */
  linkTargets: Map<string, LinkStatus>;
  images?: Map<string, AssetInfo>;
  externalLinks?: Map<string, AssetInfo>;
  scripts?: Map<string, AssetInfo>;
  tls?: TlsInfo;
  hostVariants?: HostVariant[];
  trailingSlash?: { url: string; variant: string; status: number | null; canonical?: string; problem?: string };
  /** Distinct internal parameter / faceted / tag URLs linked from crawled pages (excluding plain ?page=N). */
  discoveredBudgetUrls?: string[];
  /** Homepage requested with search/AI-crawler user-agents (firewall / bot-protection probe). */
  botProbes?: { bot: string; userAgent: string; status: number | null; error?: string }[];
  /** The site answered this crawl itself with 429 / 503: a 429 to a bot probe may be our own rate limit, not bot blocking. */
  crawlRateLimited?: boolean;
  /** BFS stopped at maxPages with links still queued (graph-based checks are then not evaluated). */
  bfsTruncated: boolean;
}

export type CrawlLog = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
