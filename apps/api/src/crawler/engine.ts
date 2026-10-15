/**
 * Crawler & Renderer (PDF subsystem A) — raw-HTML crawler.
 *
 * Makes REAL HTTP requests (global fetch, `redirect: 'manual'`), follows redirects manually, records
 * response times, failures and redirect chains honestly, parses every HTML page with cheerio and hands
 * the parsed pages + site context to the analysis engine (subsystem C, ../analysis).
 *
 * Safety: the engine only contacts the configured base URL host (plus capped HEAD checks for images,
 * scripts and outbound links found on its pages). It is "ready" only when CRAWLER_BASE_URL is set and
 * CRAWLER_ALLOW_LIVE=true. Loopback base URLs (http://localhost, 127.0.0.1, ::1) are treated as allowed
 * without CRAWLER_ALLOW_LIVE because they cannot reach a live site — they are used for tests and
 * staging fixtures served on the same machine.
 *
 * JS rendering is NOT available (no headless browser is installed): TECH-JS-RENDER and TECH-MOBILE are
 * never evaluated and `jsRenderedSample` is always 0.
 */
import type { CrawledUrl, CrawlRun, CrawlType, PageTemplate, PageTier, SentinelConfig, SitemapDiff } from '@sentinel/shared';
import type { CrawlEngine, CrawlOutcome, CrawlPlan, PreviousCrawlState } from '../services/ports';
import { CRAWLER_BASE_URL_MISSING } from '../config/env';
import { runAnalyzers, snapshotFromPages } from '../analysis/analyzers';
import { createHttpClient, createThrottle, mapPool, type HttpClient } from './http';
import { assertAllowedUrl, createGuardedFetch, type NetPolicy } from './netguard';
import { createInterner, createMemoryGuard, heapLimitMb } from './memory';
import { parseHtml } from './parse';
import { groupFor, isAllowed, parseRobots, pathAndQuery } from './robots';
import { fetchSitemaps } from './sitemap';
import { checkCertificate } from './tls';
import type { AssetInfo, CrawlLog, FetchResult, HostVariant, LinkStatus, ParsedPage, RobotsInfo, SiteContext, TlsInfo } from './types';
import { crawlBudgetReason, crawlTrapReason, hostOf, isLocalHost, isSameSite, normalizeUrl, pageParam, paginationPage, sameUrl, templateOf, urlKey } from './url';

export interface CrawlEngineOptions {
  baseUrl?: string;
  allowLive: boolean;
  userAgent: string;
  timeoutMs: number;
  concurrency: number;
  respectRobots: boolean;
  thresholds: Record<string, number>;
  /** For aiCrawlerPolicy, intentionalNoindex, site brand, moneyKeywords. */
  config: SentinelConfig;
  fetchImpl?: typeof fetch;
  log?: CrawlLog;
  /** Caps (defaults suit a daily run against a Shopify store). */
  limits?: Partial<CollectorLimits>;
  now?: () => Date;
  /** TLS certificate probe (default: node:tls connect). Injectable for tests. */
  tlsCheck?: (host: string, port: number, timeoutMs: number, now: Date) => Promise<TlsInfo>;
  /**
   * SSRF policy: allow loopback destinations. Only for local fixture crawls outside production; defaults to true only
   * when the base URL itself is a loopback URL and NODE_ENV is not production.
   */
  allowLoopback?: boolean;
  /** Minimum gap between request starts within one crawl (ms). */
  requestDelayMs?: number;
  /** Largest response body read per request (bytes). */
  maxBodyBytes?: number;
  /** Cancels the crawl (set per run). */
  signal?: AbortSignal;
  /** Stop taking new pages when the heap is above this fraction of its limit (default 0.8). */
  memoryThreshold?: number;
  /** Retries per request for transient failures (429 / 502 / 503 / 504, timeouts, dropped connections). Default 2. */
  retries?: number;
  /** Longest Retry-After / backoff wait per retry (ms). Default 30 s. */
  maxRetryWaitMs?: number;
  /** Highest robots.txt Crawl-delay honoured (ms); a larger value is capped at this. Default 30 s. */
  maxCrawlDelayMs?: number;
  /** Most sitemap files read per crawl (index files included). Default 1,000. */
  maxSitemapFiles?: number;
  /** Largest sitemap file read, after decompression (bytes). Default 50 MB. */
  maxSitemapBytes?: number;
}

/** How the crawl paced itself (shown to people so a slow crawl is explained). */
export interface PolitenessStats {
  /** Current gap between requests (ms) — the configured delay, robots.txt Crawl-delay, or more after 429 / 503. */
  delayMs: number;
  /** robots.txt Crawl-delay applied (ms), when the site declares one. */
  crawlDelayMs?: number;
  /** Requests retried after a transient failure. */
  retries: number;
  /** Times the site answered 429 / 503 and the crawler slowed down. */
  slowDowns: number;
}

export function defaultAllowLoopback(baseUrl?: string): boolean {
  return !!baseUrl && isLocalHost(baseUrl) && process.env.NODE_ENV !== 'production';
}

export interface CollectorLimits {
  /** Internal link targets (not crawled as pages) checked with HEAD per run. */
  linkChecks: number;
  /** Sitemap entries (not crawled as pages) checked with HEAD per run. */
  sitemapChecks: number;
  imagesPerPage: number;
  imagesTotal: number;
  externalLinks: number;
  thirdPartyScripts: number;
  /** /collections/x/products/y links fetched to verify their canonical (smart crawls). */
  collectionScopedSamples: number;
  /** Parameter / tag URLs fetched as crawl-budget samples. */
  budgetSamples: number;
  /** ?page=N URLs fetched for TECH-PAGINATION. */
  paginationSamples: number;
}

const DEFAULT_LIMITS: CollectorLimits = {
  linkChecks: 400,
  sitemapChecks: 500,
  imagesPerPage: 10,
  imagesTotal: 300,
  externalLinks: 60,
  thirdPartyScripts: 40,
  collectionScopedSamples: 8,
  budgetSamples: 10,
  paginationSamples: 5,
};

/** User-agents used to probe whether a firewall / bot-protection app blocks search & AI crawlers (AEO-AI-CRAWLERS, TECH-4XX 429). */
export const BOT_PROBES: { bot: string; userAgent: string }[] = [
  { bot: 'Googlebot', userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { bot: 'Bingbot', userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  { bot: 'GPTBot', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.1; +https://openai.com/gptbot)' },
  { bot: 'PerplexityBot', userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { bot: 'CCBot', userAgent: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
];

/** Context data an analyzer needs beyond the page list (also drives what a re-verification fetches). */
export type ContextNeed =
  | 'robots' | 'sitemap' | 'linkTargets' | 'images' | 'external' | 'scripts' | 'tls' | 'host' | 'bfs' | 'collectionScoped' | 'budget' | 'pagination' | 'botProbe';

export const ALL_NEEDS: ContextNeed[] = ['robots', 'sitemap', 'linkTargets', 'images', 'external', 'scripts', 'tls', 'host', 'collectionScoped', 'budget', 'pagination', 'botProbe'];

export interface CollectParams {
  type: CrawlType;
  baseUrl: string;
  urls: { url: string; reason: CrawledUrl['reason'] }[];
  maxPages: number;
  tierOf: (url: string) => PageTier;
  previous?: PreviousCrawlState;
  needs: Set<ContextNeed>;
  onProgress?: (crawled: number, failed: number, discovered: number, succeeded: number, politeness?: PolitenessStats) => void;
  /** Where link discovery starts (default: the homepage). */
  startUrl?: string;
  /** Maximum link depth from the start URL (default unlimited). */
  maxDepth?: number;
  signal?: AbortSignal;
  /** maxPages is a hard cap on page fetches, including canonical / pagination / parameter samples (live crawls). */
  hardPageCap?: boolean;
}

export interface Collected {
  pages: ParsedPage[];
  ctx: SiteContext;
  planned: number;
  durationMs: number;
  /** Same-site page URLs found (start, links, sitemap). */
  discovered?: number;
  /** The crawl was cancelled: pages hold only what was fetched before. */
  cancelled?: boolean;
  /** The crawl stopped taking new pages because the server's memory was nearly full. */
  memoryStopped?: boolean;
  /** Distinct links not followed because they look like a crawl trap (endless URL space). */
  trapSkipped?: number;
}

const NON_HTML_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|mp4|webm|mov|mp3|woff2?|ttf|eot|csv|xlsx?|docx?)(\?|$)/i;
const SKIP_PATHS = /^\/(cart|checkout|account|checkouts|orders|admin|apps\/|services\/|tools\/|password|challenge|cdn\/|wpm@|\.well-known)/i;
const FIRST_PARTY_CDN = /(^|\.)cdn\.shopify\.com$|(^|\.)shopifycdn\.(com|net)$|(^|\.)shopify\.com$|(^|\.)myshopify\.com$/i;
const IMAGE_CDN = /(^|\.)cdn\.shopify\.com$|(^|\.)shopifycdn\.(com|net)$|^cdn\.|imgix\.net$|cloudinary\.com$|cloudfront\.net$/i;

function isFailure(p: Pick<ParsedPage, 'status' | 'finalStatus' | 'skippedByRobots'>): boolean {
  if (p.skippedByRobots) return false;
  return p.status === null || p.status >= 500 || (p.finalStatus !== null && p.finalStatus >= 500);
}

/** Response headers kept for every page; the homepage keeps all of them (HTTPS / HSTS evidence). */
const KEPT_HEADERS = ['x-robots-tag', 'strict-transport-security', 'content-type', 'content-language', 'link', 'last-modified'];

function trimHeaders(headers: Record<string, string>, keepAll: boolean): Record<string, string> {
  if (keepAll) return headers;
  const out: Record<string, string> = {};
  for (const k of KEPT_HEADERS) if (headers[k] !== undefined) out[k] = headers[k];
  return out;
}

/** True if the URL looks like a crawlable HTML page on the site. */
function isPageCandidate(url: string, siteHost: string): boolean {
  // www and non-www are the same website (a link to the other variant is fetched and its redirect recorded).
  if (!isSameSite(url, siteHost)) return false;
  try {
    const u = new URL(url);
    if (NON_HTML_EXT.test(u.pathname)) return false;
    if (SKIP_PATHS.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function engineReadiness(baseUrl: string | undefined, allowLive: boolean): { ready: boolean; reason?: string; baseUrl?: string } {
  if (!baseUrl) return { ready: false, reason: CRAWLER_BASE_URL_MISSING };
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ready: false, reason: 'CRAWLER_BASE_URL must be an http(s) URL.', baseUrl };
  } catch {
    return { ready: false, reason: 'CRAWLER_BASE_URL is not a valid URL.', baseUrl };
  }
  if (isLocalHost(baseUrl)) {
    if (process.env.NODE_ENV === 'production') return { ready: false, reason: 'Crawling a localhost address is disabled in production.', baseUrl };
    return { ready: true, baseUrl };
  }
  if (!allowLive) return { ready: false, reason: 'CRAWLER_ALLOW_LIVE is not "true" — live crawling of a non-local site must be explicitly enabled.', baseUrl };
  return { ready: true, baseUrl };
}

/**
 * Low-level fetch + parse + context collection, shared by the crawl engine and the reverifier.
 */
export function createCollector(opts: CrawlEngineOptions) {
  const policy: NetPolicy = { allowLoopback: opts.allowLoopback ?? defaultAllowLoopback(opts.baseUrl) };
  // Every request (pages, robots, sitemaps, link checks, images, scripts, bot probes) goes through the SSRF guard
  // unless a test injects its own fetch.
  const fetchImpl: typeof fetch = opts.fetchImpl ?? createGuardedFetch(policy);
  const throttle = createThrottle(opts.requestDelayMs ?? 0, opts.signal, Math.max(30000, opts.maxCrawlDelayMs ?? 30000));
  let retryCount = 0;
  let crawlDelayMs: number | undefined;
  const clientOpts = (userAgent: string) => ({
    userAgent, timeoutMs: opts.timeoutMs, fetchImpl, maxRedirects: 5, maxBodyBytes: opts.maxBodyBytes, signal: opts.signal, throttle,
    retries: opts.retries, maxRetryWaitMs: opts.maxRetryWaitMs, onRetry: () => { retryCount++; },
  });
  const politeness = (): PolitenessStats => ({ delayMs: throttle.intervalMs, crawlDelayMs, retries: retryCount, slowDowns: throttle.slowDowns });
  const http: HttpClient = createHttpClient(clientOpts(opts.userAgent));
  // Other websites (outbound links, third-party scripts): one attempt each, and they don't use this site's request pacing.
  const extHttp: HttpClient = createHttpClient({ ...clientOpts(opts.userAgent), throttle: undefined, retries: 0 });
  const interner = createInterner();
  const limits: CollectorLimits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const log: CrawlLog = opts.log ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
  const now = opts.now ?? (() => new Date());
  const conc = Math.max(1, opts.concurrency || 1);

  function readiness() {
    return engineReadiness(opts.baseUrl, opts.allowLive);
  }

  async function fetchRobots(origin: string): Promise<RobotsInfo> {
    const url = `${origin}/robots.txt`;
    const r = await http.request(url, { headers: { accept: 'text/plain,*/*;q=0.5' } });
    const ok = r.finalStatus !== null && r.finalStatus >= 200 && r.finalStatus < 300;
    const body = ok ? r.body ?? '' : undefined;
    return { url, status: r.finalStatus ?? r.status, error: r.error, body, parsed: parseRobots(body ?? '') };
  }

  async function fetchPage(url: string, reason: CrawledUrl['reason'], tier: PageTier, siteHost: string): Promise<{ page: ParsedPage; derived?: ParsedPage }> {
    const r: FetchResult = await http.request(url);
    // Large crawls keep tens of thousands of pages in memory: keep only the response headers the analysis reads.
    r.headers = trimHeaders(r.headers, templateOf(url) === 'home' || templateOf(r.finalUrl) === 'home');
    const page: ParsedPage = { ...r, template: templateOf(url), tier, reason, inSitemap: false };
    const isHtml = (ct?: string) => !ct || /html/i.test(ct);
    if (r.finalStatus === 200 && r.body !== undefined && isHtml(r.contentType)) {
      // Shared strings: repeated header / footer links, menus and image URLs are stored once for the whole crawl.
      const parsed = interner.parsed(parseHtml(r.body, r.finalUrl, siteHost));
      if (r.chain.length === 0) {
        page.html = parsed;
      } else if (isSameSite(r.finalUrl, siteHost)) {
        const derived: ParsedPage = {
          ...r, url: r.finalUrl, status: r.finalStatus, chain: [], redirectLoop: false, tooManyRedirects: false,
          responseMs: r.finalResponseMs, template: templateOf(r.finalUrl), tier, reason, inSitemap: false, derivedFrom: url, html: parsed,
        };
        delete page.body;
        return { page, derived };
      }
    }
    delete page.body;
    return { page };
  }

  async function checkLink(url: string, external = false): Promise<LinkStatus> {
    const c = external ? extHttp : http;
    let r = await c.request(url, { method: 'HEAD', readBody: false });
    // Some servers reject HEAD — retry with GET (body discarded).
    if (r.finalStatus === 405 || r.finalStatus === 501 || (r.status === null && !/timeout/.test(r.error ?? ''))) r = await c.request(url, { method: 'GET', readBody: false });
    return { url, status: r.status, finalStatus: r.finalStatus, finalUrl: r.finalUrl, chain: r.chain, redirectLoop: r.redirectLoop, error: r.error };
  }

  async function collect(p: CollectParams): Promise<Collected> {
    const t0 = Date.now();
    const base = new URL(p.baseUrl);
    const origin = base.origin;
    const siteHost = base.host.toLowerCase();
    const homepage = `${origin}/`;
    const robots = await fetchRobots(origin);
    if (opts.respectRobots && robots.body !== undefined) {
      const cd = groupFor(robots.parsed, opts.userAgent).crawlDelay;
      if (cd !== undefined && cd > 0) {
        crawlDelayMs = Math.min(Math.round(cd * 1000), opts.maxCrawlDelayMs ?? 30000);
        throttle.setFloor(crawlDelayMs);
        log.info({ crawlDelayMs, declaredSeconds: cd }, 'robots.txt Crawl-delay applied');
      }
    }
    const robotsOk = (url: string) => {
      if (!opts.respectRobots || robots.body === undefined) return { allowed: true } as const;
      const d = isAllowed(robots.parsed, opts.userAgent, pathAndQuery(url));
      return { allowed: d.allowed, rule: d.rule };
    };

    const pages: ParsedPage[] = [];
    const byUrl = new Map<string, ParsedPage>();
    const derivedOf = new Map<string, ParsedPage>();
    const guard = createMemoryGuard(opts.memoryThreshold ?? 0.8);
    let memoryStopped = false;
    const discovered = new Set<string>();
    const stopped = () => !!p.signal?.aborted;
    let crawled = 0;
    let failed = 0;
    let succeeded = 0;
    let inFlight = 0;
    const record = (pg: ParsedPage) => {
      pages.push(pg);
      byUrl.set(normalizeUrl(pg.url), pg);
      if (pg.derivedFrom && !derivedOf.has(pg.derivedFrom)) derivedOf.set(pg.derivedFrom, pg);
    };
    const markSample = (pg: ParsedPage) => {
      const n = pageParam(pg.url);
      const onlyPage = n !== undefined && [...new URL(pg.url).searchParams.keys()].length === 1;
      if (onlyPage && n >= 2) pg.paginated = true;
      else {
        const r = crawlBudgetReason(pg.url);
        if (r) pg.budgetSample = r;
      }
    };
    const visit = async (url: string, reason: CrawledUrl['reason'], depth?: number): Promise<ParsedPage | undefined> => {
      const key = normalizeUrl(url);
      if (byUrl.has(key) || stopped() || memoryStopped) return undefined;
      if (p.hardPageCap && crawled + inFlight >= p.maxPages) return undefined;
      if (guard.pressure()) {
        // Close to the heap limit: stop taking new pages and finish with what was fetched (instead of crashing the server).
        memoryStopped = true;
        log.warn({ crawled, heapLimitMb: heapLimitMb() }, 'crawl stopped taking new pages: server memory nearly full');
        return undefined;
      }
      discovered.add(key);
      const tier = p.tierOf(url);
      const rb = robotsOk(url);
      if (!rb.allowed) {
        const skipped: ParsedPage = {
          url, finalUrl: url, status: null, finalStatus: null, chain: [], redirectLoop: false, tooManyRedirects: false, totalMs: 0, headers: {},
          error: `skipped: disallowed by robots.txt for our user-agent${rb.rule ? ` (line ${rb.rule.line}: Disallow: ${rb.rule.path})` : ''}`,
          template: templateOf(url), tier, reason, inSitemap: false, skippedByRobots: true, depth,
        };
        record(skipped);
        return skipped;
      }
      byUrl.set(key, undefined as unknown as ParsedPage); // reserve
      inFlight++;
      const { page, derived } = await fetchPage(url, reason, tier, siteHost).finally(() => { inFlight--; });
      if (stopped() && page.error === 'cancelled') {
        byUrl.delete(key); // interrupted by cancellation — not a result
        return undefined;
      }
      page.depth = depth;
      markSample(page);
      if (derived) markSample(derived);
      byUrl.delete(key);
      record(page);
      crawled++;
      if (isFailure(page)) failed++;
      const st = page.finalStatus ?? page.status;
      if (!isFailure(page) && st !== null && st < 400) succeeded++;
      if (derived && !byUrl.has(normalizeUrl(derived.url))) {
        derived.depth = depth;
        derived.tier = p.tierOf(derived.url);
        record(derived);
      }
      p.onProgress?.(crawled, failed, discovered.size, succeeded, politeness());
      return page;
    };

    // ------------------------------------------------------------- sitemap (fetched early: full crawls also crawl its URLs)
    let sitemap: SiteContext['sitemap'];
    const loadSitemap = async () => {
      if (!p.needs.has('sitemap') || stopped()) return;
      const declared = robots.parsed.sitemaps.filter((s) => isSameSite(s, siteHost));
      sitemap = await fetchSitemaps(http, declared.length ? declared : [`${origin}/sitemap.xml`], {
        maxFiles: opts.maxSitemapFiles, maxBodyBytes: opts.maxSitemapBytes, concurrency: Math.min(conc, 4), signal: p.signal,
      });
      log.info({ files: sitemap.files.length, entries: sitemap.entries.length }, 'sitemaps read');
      if (p.needs.has('bfs')) for (const e of sitemap.entries) if (isPageCandidate(e.url, siteHost)) discovered.add(normalizeUrl(e.url));
    };
    // Link-following crawls start fetching pages immediately and read the sitemap afterwards (a large store's sitemap
    // can take a while); list-based crawls read it first.
    if (!p.needs.has('bfs')) await loadSitemap();

    let planned = 0;
    let bfsTruncated = false;
    const traps = new Set<string>();
    if (p.needs.has('bfs')) {
      // Breadth-first link discovery. URLs are deduplicated after normalisation (`queued`), stay on the site (www-insensitive),
      // skip non-HTML / cart & account paths and query strings (except plain ?page=N pagination, which is followed so
      // products listed only on later pages are found), skip likely crawl traps, and stop at maxPages / maxDepth — so link
      // loops and endless parameter spaces cannot keep the crawl going.
      const root = p.startUrl && isSameSite(p.startUrl, siteHost) ? p.startUrl : homepage;
      const maxDepth = p.maxDepth ?? Number.POSITIVE_INFINITY;
      const queued = new Set<string>([normalizeUrl(root)]);
      discovered.add(normalizeUrl(root));
      // Links repeat on every page (menus, footers): each distinct link string is examined once.
      const examined = new Set<string>();
      const follow = (l: string): string | undefined => {
        if (examined.has(l)) return undefined;
        examined.add(l);
        if (!isPageCandidate(l, siteHost)) return undefined;
        if (l.includes('?') && paginationPage(l) === undefined) return undefined;
        const trap = crawlTrapReason(l);
        if (trap) {
          if (traps.size < 100000) traps.add(l);
          return undefined;
        }
        const k = normalizeUrl(l);
        if (queued.has(k)) return undefined;
        queued.add(k);
        discovered.add(k);
        return l;
      };
      const linksOf = (pg: ParsedPage | undefined) => (pg && (pg.html ?? derivedOf.get(pg.url)?.html))?.internalLinks ?? [];
      /**
       * Level-synchronous BFS so a recorded click depth is the true shortest depth. `depth` undefined = pages reached from
       * sitemap-only pages (not linked from the start URL): their links are followed too, without a depth.
       */
      const bfs = async (seeds: string[], depth: number | undefined, seedReason: (u: string) => CrawledUrl['reason']): Promise<string[]> => {
        let level = seeds;
        let first = true;
        while (level.length && crawled < p.maxPages && !stopped() && !memoryStopped) {
          const room = p.maxPages - crawled;
          const batch = level.length > room ? level.slice(0, room) : level;
          if (batch.length < level.length) bfsTruncated = true;
          const d = depth;
          const results = await mapPool(batch, conc, (u) => visit(u, first ? seedReason(u) : 'full', d), p.signal);
          first = false;
          const next: string[] = [];
          for (const pg of results) for (const l of linksOf(pg)) {
            const u = follow(l);
            if (u) next.push(u);
          }
          p.onProgress?.(crawled, failed, discovered.size, succeeded, politeness());
          level = next;
          if (depth !== undefined) {
            depth++;
            if (depth > maxDepth) break;
          }
        }
        return level.filter((u) => !byUrl.has(normalizeUrl(u)));
      };
      const left = await bfs([root], 0, (u) => (sameUrl(u, homepage) ? 'homepage' : 'full'));
      await loadSitemap();
      p.onProgress?.(crawled, failed, discovered.size, succeeded, politeness());
      // Sitemap URLs the link graph did not reach (orphan candidates) are crawled with the remaining budget, and — when no
      // depth limit is set — the links on them are followed as well, so sections reachable only from those pages are found.
      let leftAfterSitemap: string[] = [];
      if (sitemap && !stopped()) {
        const rest: string[] = [];
        for (const e of sitemap.entries) {
          if (!isPageCandidate(e.url, siteHost)) continue;
          const k = normalizeUrl(e.url);
          if (queued.has(k) || byUrl.has(k)) continue;
          queued.add(k);
          rest.push(e.url);
        }
        if (rest.length && crawled < p.maxPages && !memoryStopped) {
          if (p.maxDepth === undefined) {
            leftAfterSitemap = await bfs(rest, undefined, () => 'sitemap');
          } else {
            const room = Math.max(0, p.maxPages - crawled);
            await mapPool(rest.slice(0, room), conc, (u) => visit(u, 'sitemap'), p.signal);
            leftAfterSitemap = rest.filter((u) => !byUrl.has(normalizeUrl(u)));
          }
        } else leftAfterSitemap = rest;
      }
      if (left.length || leftAfterSitemap.length) bfsTruncated = true;
      // Planned = everything fetched or blocked by robots.txt + everything found but not fetched (page cap, depth, memory, cancel).
      const robotsSkipped = pages.filter((x) => x.skippedByRobots).length;
      planned = crawled + robotsSkipped + left.length + leftAfterSitemap.length;
      if (traps.size) log.info({ trapSkipped: traps.size }, 'links skipped as likely crawl traps');
    } else {
      const list: { url: string; reason: CrawledUrl['reason'] }[] = [{ url: homepage, reason: 'homepage' }];
      for (const u of p.urls) {
        try {
          const abs = new URL(u.url, origin).toString();
          if (!isSameSite(abs, siteHost)) continue;
          if (abs.endsWith('/robots.txt') || /\/sitemap[^/]*\.xml$/.test(new URL(abs).pathname)) continue;
          list.push({ url: abs, reason: u.reason });
        } catch {
          /* skip invalid */
        }
      }
      const seen = new Set<string>();
      const uniq = list.filter((x) => (seen.has(normalizeUrl(x.url)) ? false : (seen.add(normalizeUrl(x.url)), true))).slice(0, Math.max(1, p.maxPages));
      planned = uniq.length;
      for (const x of uniq) discovered.add(normalizeUrl(x.url));
      await mapPool(uniq, conc, (x) => visit(x.url, x.reason), p.signal);
    }
    if (stopped()) {
      // Cancelled: no further requests. Only what was fetched so far is returned; no context checks run.
      const ctx: SiteContext = {
        baseUrl: p.baseUrl, origin, host: siteHost, isLocal: isLocalHost(p.baseUrl), crawlType: p.type, config: opts.config, thresholds: opts.thresholds,
        previous: p.previous, now: now(), userAgent: opts.userAgent, tierOf: p.tierOf, robots, sitemap, linkTargets: new Map(), discoveredBudgetUrls: [], bfsTruncated: true,
      };
      if (sitemap) {
        const keys = new Set(sitemap.entries.map((e) => urlKey(e.url)));
        for (const pg of pages) pg.inSitemap = keys.has(urlKey(pg.url));
      }
      log.info({ crawled, failed, pages: pages.length, ms: Date.now() - t0 }, 'crawl collection cancelled');
      return { pages, ctx, planned, durationMs: Date.now() - t0, discovered: discovered.size, cancelled: true, trapSkipped: traps.size };
    }

    // Every distinct internal link of the crawl, in first-seen order (links repeat on every page: examine each once).
    const allInternal = new Set<string>();
    for (const pg of pages) for (const l of pg.html?.internalLinks ?? []) allInternal.add(l);

    // ------------------------------------------------------------- collection-scoped product URLs (canonical check)
    if (p.needs.has('collectionScoped')) {
      const scoped = new Set<string>();
      for (const l of allInternal) if (l.includes('/collections/') && /^\/collections\/[^/]+\/products\//.test(new URL(l).pathname) && isSameSite(l, siteHost)) scoped.add(l);
      const todo = [...scoped].filter((u) => !byUrl.has(normalizeUrl(u))).slice(0, limits.collectionScopedSamples);
      planned += todo.length;
      await mapPool(todo, conc, async (u) => {
        const pg = await visit(u, p.type === 'full' ? 'full' : 'collection');
        if (pg) pg.scopedSample = true;
        const d = derivedOf.get(u);
        if (d && d.template === 'product' && /^\/collections\//.test(new URL(d.url).pathname)) d.scopedSample = true;
      }, p.signal);
    }
    // In full crawls, BFS may already have fetched collection-scoped product URLs: treat them as samples too.
    for (const pg of pages) if (/^\/collections\/[^/]+\/products\//.test(new URL(pg.url).pathname)) pg.scopedSample = true;

    // ------------------------------------------------------------- crawl-budget + pagination samples
    if (p.needs.has('budget') || p.needs.has('pagination')) {
      const budget: string[] = [];
      const pag: string[] = [];
      const wantBudget = p.needs.has('budget');
      const wantPag = p.needs.has('pagination');
      const quotasFull = () => (!wantBudget || budget.length >= limits.budgetSamples) && (!wantPag || pag.length >= limits.paginationSamples);
      const examined = new Set<string>();
      for (const pg of [...pages]) {
        if (quotasFull()) break;
        const html = pg.html;
        if (!html || pg.budgetSample || pg.paginated) continue;
        const cands = [...html.internalLinks, ...(html.pagination.next ? [html.pagination.next] : [])];
        for (const l of cands) {
          if (examined.has(l)) continue;
          examined.add(l);
          if (byUrl.has(normalizeUrl(l)) || !isPageCandidate(l, siteHost)) continue;
          const n = pageParam(l);
          if (n !== undefined && n >= 2 && [...new URL(l).searchParams.keys()].length === 1) {
            if (p.needs.has('pagination') && pag.length < limits.paginationSamples && !pag.includes(l)) pag.push(l);
          } else if (crawlBudgetReason(l) && p.needs.has('budget') && budget.length < limits.budgetSamples && !budget.includes(l)) {
            budget.push(l);
          }
        }
      }
      planned += budget.length + pag.length;
      await mapPool([...budget, ...pag], conc, (u) => visit(u, p.type === 'full' ? 'full' : 'collection'), p.signal);
    }
    const discoveredBudgetUrls = new Set<string>();
    for (const l of allInternal) {
      if (!l.includes('?') && !l.includes('/collections/')) continue; // neither a parameter URL nor a collection tag page
      if (!isSameSite(l, siteHost)) continue;
      const n = pageParam(l);
      if (n !== undefined && n >= 2 && [...new URL(l).searchParams.keys()].length === 1) continue;
      if (crawlBudgetReason(l)) discoveredBudgetUrls.add(normalizeUrl(l));
    }

    // ------------------------------------------------------------- bot probes (firewall / bot-protection)
    let botProbes: SiteContext['botProbes'];
    if (p.needs.has('botProbe')) {
      botProbes = await mapPool(BOT_PROBES, conc, async (b) => {
        const c = createHttpClient(clientOpts(b.userAgent));
        const r = await c.request(homepage, { readBody: false, retry: false }); // a measurement: record the first answer
        return { bot: b.bot, userAgent: b.userAgent, status: r.finalStatus ?? r.status, error: r.error };
      });
    }

    if (sitemap) {
      const keys = new Set(sitemap.entries.map((e) => urlKey(e.url)));
      for (const pg of pages) pg.inSitemap = keys.has(urlKey(pg.url));
    }

    // ------------------------------------------------------------- link targets (internal links, canonicals, sitemap entries)
    const linkTargets = new Map<string, LinkStatus>();
    const known = (u: string) => byUrl.has(normalizeUrl(u));
    if (p.needs.has('linkTargets') || p.needs.has('sitemap')) {
      const targets: string[] = [];
      const targetSet = new Set<string>();
      const add = (u: string | undefined) => {
        if (!u || targetSet.has(u) || !isSameSite(u, siteHost) || known(u)) return;
        targetSet.add(u);
        targets.push(u);
      };
      if (p.needs.has('linkTargets')) {
        for (const pg of pages) {
          for (const c of pg.html?.canonicals ?? []) add(c);
        }
        let n = 0;
        for (const l of allInternal) {
          if (n >= limits.linkChecks) break;
          if (targetSet.has(l)) continue;
          if (!isSameSite(l, siteHost) || NON_HTML_EXT.test(new URL(l).pathname) || SKIP_PATHS.test(new URL(l).pathname)) continue;
          if (!known(l)) {
            add(l);
            n++;
          }
        }
      }
      if (sitemap && p.needs.has('sitemap')) {
        let n = 0;
        for (const e of sitemap.entries) {
          if (n >= limits.sitemapChecks) break;
          if (!targetSet.has(e.url) && !known(e.url)) {
            add(e.url);
            n++;
          }
        }
      }
      const allowed = targets.filter((u) => robotsOk(u).allowed || !isSameSite(u, siteHost));
      const results = (await mapPool(allowed, conc, (u) => checkLink(u), p.signal)).filter(Boolean);
      for (const r of results) linkTargets.set(normalizeUrl(r.url), r);
    }

    // ------------------------------------------------------------- images
    let images: SiteContext['images'];
    if (p.needs.has('images')) {
      images = new Map<string, AssetInfo>();
      const todo: string[] = [];
      for (const pg of pages) {
        if (todo.length >= limits.imagesTotal) break;
        if (!pg.html) continue;
        for (const img of pg.html.images.filter((i) => i.inMain).slice(0, limits.imagesPerPage)) {
          const h = hostOf(img.src);
          if (!(isSameSite(img.src, siteHost) || IMAGE_CDN.test(h))) continue;
          if (todo.length >= limits.imagesTotal) break;
          if (!todo.includes(img.src)) todo.push(img.src);
        }
      }
      const res = (await mapPool(todo, conc, async (u) => ({ u, r: await sizeWithAccept(http, u, opts) }), p.signal)).filter(Boolean);
      for (const { u, r } of res) images.set(u, { url: u, ...r });
    }

    // ------------------------------------------------------------- outbound links
    let externalLinks: SiteContext['externalLinks'];
    if (p.needs.has('external')) {
      externalLinks = new Map<string, AssetInfo>();
      const todo: string[] = [];
      for (const pg of pages) for (const l of pg.html?.externalLinks ?? []) if (todo.length < limits.externalLinks && !todo.includes(l) && !FIRST_PARTY_CDN.test(hostOf(l))) todo.push(l);
      const res = (await mapPool(todo, conc, (u) => checkLink(u, true), p.signal)).filter(Boolean);
      for (const r of res) externalLinks.set(r.url, { url: r.url, status: r.finalStatus, error: r.error });
    }

    // ------------------------------------------------------------- third-party scripts
    let scripts: SiteContext['scripts'];
    if (p.needs.has('scripts')) {
      scripts = new Map<string, AssetInfo>();
      const todo: string[] = [];
      for (const pg of pages) {
        if (todo.length >= limits.thirdPartyScripts) break;
        for (const s of pg.html?.scriptSrcs ?? []) if (todo.length < limits.thirdPartyScripts && !todo.includes(s) && !isSameSite(s, siteHost)) todo.push(s);
      }
      const res = (await mapPool(todo, conc, async (u) => ({ u, r: await extHttp.assetSize(u) }), p.signal)).filter(Boolean);
      for (const { u, r } of res) scripts.set(u, { url: u, ...r });
    }

    // ------------------------------------------------------------- TLS + host variants (real domains only)
    const local = isLocalHost(p.baseUrl);
    let tls: SiteContext['tls'];
    if (p.needs.has('tls') && !local && base.protocol === 'https:') {
      tls = await (opts.tlsCheck ?? checkCertificate)(base.hostname, Number(base.port) || 443, opts.timeoutMs, now());
    }
    let hostVariants: HostVariant[] | undefined;
    let trailingSlash: SiteContext['trailingSlash'];
    if (p.needs.has('host') && !local) {
      const bare = base.hostname.replace(/^www\./, '');
      const hosts = [bare, `www.${bare}`];
      const variants = hosts.flatMap((h) => ['https:', 'http:'].map((proto) => `${proto}//${h}${base.port ? `:${base.port}` : ''}/`));
      hostVariants = await mapPool(variants, conc, async (v) => {
        const r = await http.request(v, { readBody: false });
        return { url: v, isCanonical: sameUrl(v, homepage), status: r.status, finalStatus: r.finalStatus, finalUrl: r.finalUrl, chain: r.chain, error: r.error };
      });
      const sample = pages.find((x) => x.html && x.status === 200 && (x.template === 'product' || x.template === 'collection') && !new URL(x.url).pathname.endsWith('/'));
      if (sample) {
        const variant = `${sample.url.replace(/\?.*$/, '')}/`;
        const r = await http.request(variant);
        const canon = r.finalStatus === 200 && r.body ? parseHtml(r.body, r.finalUrl, siteHost).canonicals[0] : undefined;
        trailingSlash = { url: sample.url, variant, status: r.status, canonical: canon };
        if (r.status === 200 && (!canon || !sameUrl(canon, sample.url)) && normalizeUrl(canon ?? '') !== normalizeUrl(sample.url)) {
          if (!canon || canon.endsWith('/')) trailingSlash.problem = 'trailing-slash variant resolves 200 without a canonical to the slash-less URL';
        }
      }
    }

    const ctx: SiteContext = {
      baseUrl: p.baseUrl, origin, host: siteHost, isLocal: local, crawlType: p.type, config: opts.config, thresholds: opts.thresholds,
      previous: p.previous, now: now(), userAgent: opts.userAgent, tierOf: p.tierOf, robots, sitemap, linkTargets, images, externalLinks, scripts,
      tls, hostVariants, trailingSlash, botProbes, discoveredBudgetUrls: [...discoveredBudgetUrls], bfsTruncated: p.needs.has('bfs') ? bfsTruncated : true,
    };
    log.info({ crawled, failed, pages: pages.length, ms: Date.now() - t0 }, 'crawl collection finished');
    return { pages, ctx, planned, durationMs: Date.now() - t0, discovered: discovered.size, cancelled: stopped(), memoryStopped, trapSkipped: traps.size };
  }

  return { readiness, collect, http, limits, politeness };
}

export type Collector = ReturnType<typeof createCollector>;

async function sizeWithAccept(http: HttpClient, url: string, _opts: CrawlEngineOptions) {
  // Browsers advertise AVIF/WebP; Shopify's CDN negotiates on Accept, so mirror a browser request.
  const head = await http.request(url, { method: 'HEAD', readBody: false, retry: false, headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
  const cl = head.headers['content-length'];
  if (head.finalStatus !== null && head.finalStatus < 400 && cl !== undefined && Number.isFinite(Number(cl))) {
    return { status: head.finalStatus, bytes: Number(cl), contentType: head.headers['content-type'] };
  }
  const r = await http.assetSize(url);
  return { status: r.status ?? head.finalStatus, bytes: r.bytes, contentType: r.contentType ?? head.headers['content-type'], error: r.error ?? head.error };
}

export function buildSitemapDiff(pages: ParsedPage[], ctx: SiteContext, invalid: { url: string; problem: string }[]): SitemapDiff | undefined {
  if (!ctx.sitemap) return undefined;
  const entries = ctx.sitemap.entries;
  const prev = ctx.previous?.sitemapEntries;
  const prevMap = new Map((prev ?? []).map((e) => [normalizeUrl(e.url), e]));
  const currMap = new Map(entries.map((e) => [normalizeUrl(e.url), e]));
  const crawledOk = pages.filter((p) => p.status === 200 && p.html);
  return {
    crawlRunId: '',
    added: prev ? entries.filter((e) => !prevMap.has(normalizeUrl(e.url))).map((e) => e.url) : [],
    removed: prev ? prev.filter((e) => !currMap.has(normalizeUrl(e.url))).map((e) => e.url) : [],
    lastmodChanged: prev
      ? entries
          .filter((e) => prevMap.has(normalizeUrl(e.url)) && (prevMap.get(normalizeUrl(e.url))!.lastmod ?? '') !== (e.lastmod ?? ''))
          .map((e) => ({ url: e.url, from: prevMap.get(normalizeUrl(e.url))!.lastmod, to: e.lastmod }))
      : [],
    inSitemapNotCrawled: ((keys) => entries.filter((e) => !keys.has(urlKey(e.url))).map((e) => e.url))(new Set(pages.map((p) => urlKey(p.url)))),
    crawledNotInSitemap: crawledOk
      .filter((p) => !p.inSitemap && !p.scopedSample && !p.budgetSample && !p.paginated && !p.derivedFrom && !/\?/.test(p.url) && p.template !== 'search' && p.template !== 'other')
      .filter((p) => !p.html!.canonicals[0] || sameUrl(p.html!.canonicals[0], p.url))
      .map((p) => p.url),
    invalidEntries: invalid,
    source: 'live',
  };
}

export function createCrawlEngine(opts: CrawlEngineOptions): CrawlEngine & { collector: Collector } {
  const collector = createCollector(opts);
  return {
    collector,
    readiness: collector.readiness,
    async run(plan: CrawlPlan, onProgress) {
      const ready = collector.readiness();
      if (!ready.ready) throw new Error(`Crawler not ready: ${ready.reason}`);
      // A live crawl from the Crawl Center starts at its start URL (validated to be on this website: www-insensitive).
      let base = plan.startUrl ? `${new URL(plan.startUrl).origin}/` : plan.baseUrl || opts.baseUrl!;
      const sameConfiguredSite = (u: string) => isLocalHost(u) || hostOf(u).replace(/^www\./, '') === hostOf(opts.baseUrl!).replace(/^www\./, '');
      if (!sameConfiguredSite(base)) {
        throw new Error(`Refusing to crawl ${hostOf(base)}: only the configured CRAWLER_BASE_URL host (${hostOf(opts.baseUrl!)}) may be crawled.`);
      }
      if (!opts.fetchImpl) {
        // Fail fast with a clear message when the site itself resolves to a blocked address (every request is re-checked anyway).
        try {
          await assertAllowedUrl(base, { allowLoopback: opts.allowLoopback ?? defaultAllowLoopback(opts.baseUrl) });
        } catch (e) {
          throw new Error(`Refusing to crawl ${hostOf(base)}: ${(e as Error).message}`);
        }
      }
      // A Crawl Center crawl scales the supporting checks (link / sitemap / image / script / outbound requests) to its page cap.
      const n = plan.maxPages;
      const scaled: Partial<CollectorLimits> | undefined = plan.startUrl
        ? { linkChecks: Math.min(400, n * 4), sitemapChecks: Math.min(500, n * 2), imagesTotal: Math.min(300, n * 3), externalLinks: Math.min(60, n * 2), thirdPartyScripts: Math.min(40, n * 2), collectionScopedSamples: Math.min(8, n), budgetSamples: Math.min(10, n), paginationSamples: Math.min(5, n) }
        : undefined;
      const runCollector = plan.timeoutMs || plan.concurrency || plan.signal || scaled || plan.requestDelayMs !== undefined
        ? createCollector({
          ...opts, timeoutMs: plan.timeoutMs ?? opts.timeoutMs, concurrency: plan.concurrency ?? opts.concurrency, signal: plan.signal,
          requestDelayMs: plan.requestDelayMs ?? opts.requestDelayMs, limits: { ...(opts.limits ?? {}), ...(scaled ?? {}) },
        })
        : collector;
      // Resolve the site's real address first: example.com → https://www.example.com is crawled as www.example.com
      // (otherwise the homepage's links would be on "another host" and the crawl would stop after one page).
      let startUrl = plan.startUrl;
      let resolvedFrom: string | undefined;
      if (plan.type === 'full') {
        const probeUrl = startUrl ?? base;
        const r = await runCollector.http.request(probeUrl, { readBody: false });
        if (r.finalStatus !== null && r.chain.length && r.finalUrl) {
          if (!isLocalHost(r.finalUrl) && hostOf(r.finalUrl).replace(/^www\./, '') !== hostOf(probeUrl).replace(/^www\./, '')) {
            throw new Error(`${probeUrl} redirects to ${r.finalUrl}, which is a different website. Add ${hostOf(r.finalUrl)} under Manage websites to crawl it.`);
          }
          resolvedFrom = probeUrl;
          base = `${new URL(r.finalUrl).origin}/`;
          if (startUrl) startUrl = r.finalUrl;
        }
      }
      const needs = new Set<ContextNeed>(ALL_NEEDS);
      if (plan.type === 'full') needs.add('bfs');
      const collected = await runCollector.collect({
        type: plan.type, baseUrl: base, urls: plan.urls ?? [], maxPages: plan.maxPages, tierOf: plan.tierOf, previous: plan.previous, needs, onProgress,
        startUrl, maxDepth: plan.maxDepth, signal: plan.signal, hardPageCap: !!plan.startUrl,
      });
      const { pages, ctx, planned, durationMs } = collected;
      const fetched = pages.filter((p) => !p.skippedByRobots && !p.derivedFrom);
      const stats: Partial<CrawlRun> = {
        // A Crawl Center crawl never plans beyond its page cap (the sitemap alone can list thousands of URLs).
        urlsPlanned: plan.startUrl ? Math.min(plan.maxPages, Math.max(planned, fetched.length)) : Math.max(planned, fetched.length),
        urlsCrawled: fetched.length,
        urlsFailed: fetched.filter(isFailure).length,
        urlsSucceeded: fetched.filter((p) => !isFailure(p) && (p.finalStatus ?? p.status ?? 0) < 400 && (p.finalStatus ?? p.status) !== null).length,
        urlsDiscovered: collected.discovered,
        jsRenderedSample: 0,
        durationMs,
        scope: [...summarizeScope(pages), ...(collected.trapSkipped ? [{ label: 'Links not followed (likely crawl traps: very long, very deep or repeating URLs)', count: collected.trapSkipped }] : [])],
        politeness: runCollector.politeness(),
        ...(resolvedFrom ? { resolvedStartUrl: startUrl ?? base, resolvedFrom } : {}),
      };
      const urls = pageRows(pages, ctx);
      if (collected.cancelled || plan.signal?.aborted) {
        // A partial crawl is never analysed: missing pages would wrongly "resolve" issues.
        return { urls, findings: [], evaluatedChecks: [], evaluatedTemplates: {}, pageTexts: [], stats, cancelled: true };
      }
      plan.onPhase?.('analysing');
      const tAnalysis = Date.now();
      const { findings, evaluatedChecks, evaluatedTemplates, sitemapInvalid, timings, prepared } = runAnalyzers(pages, ctx);
      const slow = Object.entries(timings ?? {}).filter(([, ms]) => ms >= 1000).sort((a, b) => b[1] - a[1]);
      (opts.log ?? { info: () => undefined }).info({ pages: pages.length, analysisMs: Date.now() - tAnalysis, slowAnalyzers: Object.fromEntries(slow) }, 'analysis finished');
      const pageTexts: NonNullable<CrawlOutcome['pageTexts']> = pages
        .filter((p) => p.status === 200 && p.html && p.html.mainText)
        .map((p) => ({ url: p.url, template: p.template as PageTemplate, text: p.html!.mainText }));
      return {
        urls,
        sitemapDiff: buildSitemapDiff(pages, ctx, sitemapInvalid),
        findings,
        evaluatedChecks,
        evaluatedTemplates,
        pageTexts,
        snapshot: snapshotFromPages(pages, ctx, prepared),
        stats,
        memoryStopped: collected.memoryStopped,
      };
    },
  };
}

/** Status a link target answered with: a crawled page, a checked link target, or unknown. */
function targetStatus(url: string, byUrl: Map<string, ParsedPage>, ctx: SiteContext): { status: number | null; known: boolean; blocked?: boolean } {
  const pg = byUrl.get(normalizeUrl(url));
  if (pg) return { status: pg.skippedByRobots ? null : pg.finalStatus ?? pg.status, known: true, blocked: pg.skippedByRobots };
  const lt = ctx.linkTargets?.get(normalizeUrl(url));
  if (lt) return { status: lt.finalStatus ?? lt.status, known: true };
  return { status: null, known: false };
}

export type TargetLookup = (url: string) => { status: number | null; known: boolean; blocked?: boolean };

/**
 * Per-page result rows (what the Crawl Center results screen and exports show). `lookup` answers link-target status
 * from the whole crawl when only a batch of pages is passed (streaming analysis).
 */
export function pageRows(pages: ParsedPage[], ctx: SiteContext, lookup?: TargetLookup): CrawledUrl[] {
  const byUrl = new Map<string, ParsedPage>();
  if (!lookup) for (const p of pages) byUrl.set(normalizeUrl(p.url), p);
  // A link is broken or not for every page that carries it: work it out once per distinct link (menus repeat on every page).
  const brokenCache = new Map<string, boolean>();
  const isBroken = (l: string) => {
    let b = brokenCache.get(l);
    if (b === undefined) {
      const t = lookup ? lookup(l) : targetStatus(l, byUrl, ctx);
      b = t.known && !t.blocked && (t.status === null || t.status >= 400);
      brokenCache.set(l, b);
    }
    return b;
  };
  return pages.map((p) => {
    const h = p.html;
    const finalStatus = p.finalStatus;
    const xRobots = p.headers?.['x-robots-tag'];
    const noindex = /noindex/i.test(h?.metaRobots ?? '') || /noindex/i.test(xRobots ?? '');
    const canonical = h?.canonicals[0];
    let indexable = false;
    let why: string;
    if (p.skippedByRobots) why = 'Blocked by robots.txt';
    else if (p.status === null && finalStatus === null) why = p.error ? `No response (${p.error})` : 'No response';
    else if (p.chain.length && !p.derivedFrom) why = `Redirects (${p.status}) to ${p.finalUrl}`;
    else if (finalStatus !== 200) why = `HTTP ${finalStatus ?? p.status}`;
    else if (!h) why = `Not an HTML page (${p.contentType ?? 'unknown type'})`;
    else if (noindex) why = /noindex/i.test(xRobots ?? '') ? 'noindex in X-Robots-Tag header' : 'noindex in meta robots';
    else if (canonical && !sameUrl(canonical, p.url)) why = `Canonical points to ${canonical}`;
    else { indexable = true; why = 'Indexable'; }
    const broken: string[] = [];
    if (h) {
      for (const l of h.internalLinks) {
        if (isBroken(l) && !broken.includes(l)) broken.push(l);
        if (broken.length >= 20) break;
      }
    }
    const row: CrawledUrl = {
      url: p.url, status: p.status, reason: p.reason, responseMs: p.responseMs, error: p.error,
      finalUrl: p.finalUrl !== p.url ? p.finalUrl : undefined, finalStatus, redirects: p.chain.length || undefined, redirectedFrom: p.derivedFrom,
      contentType: p.contentType, depth: p.depth, bytes: p.bytes, skippedByRobots: p.skippedByRobots || undefined,
      indexable, indexabilityReason: why, inSitemap: ctx.sitemap ? p.inSitemap : undefined,
    };
    if (h) {
      Object.assign(row, {
        title: h.title, metaDescription: h.metaDescription, h1: h.h1s, h2Count: h.headings.filter((x) => x.level === 2).length,
        canonical, metaRobots: h.metaRobots, xRobotsTag: xRobots, internalLinks: h.internalLinks.length, brokenLinks: broken,
        images: h.images.length, imagesMissingAlt: h.images.filter((i) => i.alt === null || !i.alt.trim()).length,
      });
    } else if (xRobots) row.xRobotsTag = xRobots;
    for (const k of Object.keys(row) as (keyof CrawledUrl)[]) if (row[k] === undefined) delete row[k];
    return row;
  });
}

function summarizeScope(pages: ParsedPage[]): { label: string; count: number }[] {
  const by = new Map<string, number>();
  for (const p of pages) if (!p.derivedFrom) by.set(p.reason, (by.get(p.reason) ?? 0) + 1);
  return [...by.entries()].map(([label, count]) => ({ label, count }));
}
