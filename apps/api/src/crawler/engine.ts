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
import type { CrawledUrl, CrawlType, PageTemplate, PageTier, SentinelConfig, SitemapDiff } from '@sentinel/shared';
import type { CrawlEngine, CrawlOutcome, CrawlPlan, PreviousCrawlState } from '../services/ports';
import { runAnalyzers, snapshotFromPages } from '../analysis/analyzers';
import { createHttpClient, mapPool, type HttpClient } from './http';
import { parseHtml } from './parse';
import { isAllowed, parseRobots, pathAndQuery } from './robots';
import { fetchSitemaps } from './sitemap';
import { checkCertificate } from './tls';
import type { AssetInfo, CrawlLog, FetchResult, HostVariant, LinkStatus, ParsedPage, RobotsInfo, SiteContext, TlsInfo } from './types';
import { crawlBudgetReason, hostOf, isLocalHost, isSameSite, normalizeUrl, pageParam, sameUrl, templateOf } from './url';

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
  onProgress?: (crawled: number, failed: number) => void;
}

export interface Collected {
  pages: ParsedPage[];
  ctx: SiteContext;
  planned: number;
  durationMs: number;
}

const NON_HTML_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|pdf|zip|mp4|webm|mov|mp3|woff2?|ttf|eot|csv|xlsx?|docx?)(\?|$)/i;
const SKIP_PATHS = /^\/(cart|checkout|account|checkouts|orders|admin|apps\/|services\/|tools\/|password|challenge|cdn\/|wpm@|\.well-known)/i;
const FIRST_PARTY_CDN = /(^|\.)cdn\.shopify\.com$|(^|\.)shopifycdn\.(com|net)$|(^|\.)shopify\.com$|(^|\.)myshopify\.com$/i;
const IMAGE_CDN = /(^|\.)cdn\.shopify\.com$|(^|\.)shopifycdn\.(com|net)$|^cdn\.|imgix\.net$|cloudinary\.com$|cloudfront\.net$/i;

function isFailure(p: Pick<ParsedPage, 'status' | 'finalStatus' | 'skippedByRobots'>): boolean {
  if (p.skippedByRobots) return false;
  return p.status === null || p.status >= 500 || (p.finalStatus !== null && p.finalStatus >= 500);
}

/** True if the URL looks like a crawlable HTML page on the site. */
function isPageCandidate(url: string, siteHost: string): boolean {
  if (hostOf(url) !== siteHost) return false;
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
  if (!baseUrl) return { ready: false, reason: 'CRAWLER_BASE_URL is not set — the crawler has no site to crawl.' };
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ready: false, reason: 'CRAWLER_BASE_URL must be an http(s) URL.', baseUrl };
  } catch {
    return { ready: false, reason: 'CRAWLER_BASE_URL is not a valid URL.', baseUrl };
  }
  if (isLocalHost(baseUrl)) return { ready: true, baseUrl };
  if (!allowLive) return { ready: false, reason: 'CRAWLER_ALLOW_LIVE is not "true" — live crawling of a non-local site must be explicitly enabled.', baseUrl };
  return { ready: true, baseUrl };
}

/**
 * Low-level fetch + parse + context collection, shared by the crawl engine and the reverifier.
 */
export function createCollector(opts: CrawlEngineOptions) {
  const http: HttpClient = createHttpClient({ userAgent: opts.userAgent, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, maxRedirects: 5 });
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
    const page: ParsedPage = { ...r, template: templateOf(url), tier, reason, inSitemap: false };
    const isHtml = (ct?: string) => !ct || /html/i.test(ct);
    if (r.finalStatus === 200 && r.body !== undefined && isHtml(r.contentType)) {
      const parsed = parseHtml(r.body, r.finalUrl, siteHost);
      if (r.chain.length === 0) {
        page.html = parsed;
      } else if (hostOf(r.finalUrl) === siteHost) {
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

  async function checkLink(url: string): Promise<LinkStatus> {
    let r = await http.request(url, { method: 'HEAD', readBody: false });
    // Some servers reject HEAD — retry with GET (body discarded).
    if (r.finalStatus === 405 || r.finalStatus === 501 || (r.status === null && !/timeout/.test(r.error ?? ''))) r = await http.request(url, { method: 'GET', readBody: false });
    return { url, status: r.status, finalStatus: r.finalStatus, finalUrl: r.finalUrl, chain: r.chain, redirectLoop: r.redirectLoop, error: r.error };
  }

  async function collect(p: CollectParams): Promise<Collected> {
    const t0 = Date.now();
    const base = new URL(p.baseUrl);
    const origin = base.origin;
    const siteHost = base.host.toLowerCase();
    const homepage = `${origin}/`;
    const robots = await fetchRobots(origin);
    const robotsOk = (url: string) => {
      if (!opts.respectRobots || robots.body === undefined) return { allowed: true } as const;
      const d = isAllowed(robots.parsed, opts.userAgent, pathAndQuery(url));
      return { allowed: d.allowed, rule: d.rule };
    };

    const pages: ParsedPage[] = [];
    const byUrl = new Map<string, ParsedPage>();
    let crawled = 0;
    let failed = 0;
    const record = (pg: ParsedPage) => {
      pages.push(pg);
      byUrl.set(normalizeUrl(pg.url), pg);
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
      if (byUrl.has(key)) return undefined;
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
      const { page, derived } = await fetchPage(url, reason, tier, siteHost);
      page.depth = depth;
      markSample(page);
      if (derived) markSample(derived);
      byUrl.delete(key);
      record(page);
      crawled++;
      if (isFailure(page)) failed++;
      if (derived && !byUrl.has(normalizeUrl(derived.url))) {
        derived.depth = depth;
        derived.tier = p.tierOf(derived.url);
        record(derived);
      }
      p.onProgress?.(crawled, failed);
      return page;
    };

    // ------------------------------------------------------------- sitemap (fetched early: full crawls also crawl its URLs)
    let sitemap: SiteContext['sitemap'];
    if (p.needs.has('sitemap')) {
      const declared = robots.parsed.sitemaps.filter((s) => isSameSite(s, siteHost));
      sitemap = await fetchSitemaps(http, declared.length ? declared : [`${origin}/sitemap.xml`]);
    }

    let planned = 0;
    let bfsTruncated = false;
    if (p.needs.has('bfs')) {
      // Level-synchronous BFS so recorded click depth is the true shortest depth.
      let level: string[] = [homepage];
      const queued = new Set<string>([normalizeUrl(homepage)]);
      let depth = 0;
      while (level.length && crawled < p.maxPages) {
        const room = p.maxPages - crawled;
        const batch = level.slice(0, room);
        if (batch.length < level.length) bfsTruncated = true;
        const results = await mapPool(batch, conc, (u) => visit(u, depth === 0 ? 'homepage' : 'full', depth));
        const next: string[] = [];
        for (const pg of results) {
          const html = (pg && (pg.html ?? pages.find((x) => x.derivedFrom === pg.url)?.html)) || undefined;
          if (!html) continue;
          for (const l of html.internalLinks) {
            if (!isPageCandidate(l, siteHost) || l.includes('?')) continue;
            const k = normalizeUrl(l);
            if (queued.has(k)) continue;
            queued.add(k);
            next.push(l);
          }
        }
        level = next;
        depth++;
      }
      if (level.length && crawled >= p.maxPages) bfsTruncated = true;
      planned = crawled + level.length;
      // Sitemap URLs the link graph did not reach (orphan candidates) — crawled with remaining budget.
      if (sitemap) {
        const rest = sitemap.entries.map((e) => e.url).filter((u) => isPageCandidate(u, siteHost) && !byUrl.has(normalizeUrl(u)));
        const room = Math.max(0, p.maxPages - crawled);
        planned += rest.length;
        await mapPool(rest.slice(0, room), conc, (u) => visit(u, 'sitemap'));
      }
    } else {
      const list: { url: string; reason: CrawledUrl['reason'] }[] = [{ url: homepage, reason: 'homepage' }];
      for (const u of p.urls) {
        try {
          const abs = new URL(u.url, origin).toString();
          if (hostOf(abs) !== siteHost) continue;
          if (abs.endsWith('/robots.txt') || /\/sitemap[^/]*\.xml$/.test(new URL(abs).pathname)) continue;
          list.push({ url: abs, reason: u.reason });
        } catch {
          /* skip invalid */
        }
      }
      const seen = new Set<string>();
      const uniq = list.filter((x) => (seen.has(normalizeUrl(x.url)) ? false : (seen.add(normalizeUrl(x.url)), true))).slice(0, Math.max(1, p.maxPages));
      planned = uniq.length;
      await mapPool(uniq, conc, (x) => visit(x.url, x.reason));
    }

    // ------------------------------------------------------------- collection-scoped product URLs (canonical check)
    if (p.needs.has('collectionScoped')) {
      const scoped = new Set<string>();
      for (const pg of pages) for (const l of pg.html?.internalLinks ?? []) if (/^\/collections\/[^/]+\/products\//.test(new URL(l).pathname) && hostOf(l) === siteHost) scoped.add(l);
      const todo = [...scoped].filter((u) => !byUrl.has(normalizeUrl(u))).slice(0, limits.collectionScopedSamples);
      planned += todo.length;
      await mapPool(todo, conc, async (u) => {
        const pg = await visit(u, p.type === 'full' ? 'full' : 'collection');
        if (pg) pg.scopedSample = true;
        const d = pages.find((x) => x.derivedFrom === u);
        if (d && d.template === 'product' && /^\/collections\//.test(new URL(d.url).pathname)) d.scopedSample = true;
      });
    }
    // In full crawls, BFS may already have fetched collection-scoped product URLs: treat them as samples too.
    for (const pg of pages) if (/^\/collections\/[^/]+\/products\//.test(new URL(pg.url).pathname)) pg.scopedSample = true;

    // ------------------------------------------------------------- crawl-budget + pagination samples
    if (p.needs.has('budget') || p.needs.has('pagination')) {
      const budget: string[] = [];
      const pag: string[] = [];
      for (const pg of [...pages]) {
        const html = pg.html;
        if (!html || pg.budgetSample || pg.paginated) continue;
        const cands = [...html.internalLinks, ...(html.pagination.next ? [html.pagination.next] : [])];
        for (const l of cands) {
          if (hostOf(l) !== siteHost || byUrl.has(normalizeUrl(l)) || !isPageCandidate(l, siteHost)) continue;
          const n = pageParam(l);
          if (n !== undefined && n >= 2 && [...new URL(l).searchParams.keys()].length === 1) {
            if (p.needs.has('pagination') && pag.length < limits.paginationSamples && !pag.includes(l)) pag.push(l);
          } else if (crawlBudgetReason(l) && p.needs.has('budget') && budget.length < limits.budgetSamples && !budget.includes(l)) {
            budget.push(l);
          }
        }
      }
      planned += budget.length + pag.length;
      await mapPool([...budget, ...pag], conc, (u) => visit(u, p.type === 'full' ? 'full' : 'collection'));
    }
    const discoveredBudgetUrls = new Set<string>();
    for (const pg of pages) for (const l of pg.html?.internalLinks ?? []) {
      if (hostOf(l) !== siteHost) continue;
      const n = pageParam(l);
      if (n !== undefined && n >= 2 && [...new URL(l).searchParams.keys()].length === 1) continue;
      if (crawlBudgetReason(l)) discoveredBudgetUrls.add(normalizeUrl(l));
    }

    // ------------------------------------------------------------- bot probes (firewall / bot-protection)
    let botProbes: SiteContext['botProbes'];
    if (p.needs.has('botProbe')) {
      botProbes = await mapPool(BOT_PROBES, conc, async (b) => {
        const c = createHttpClient({ userAgent: b.userAgent, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
        const r = await c.request(homepage, { readBody: false });
        return { bot: b.bot, userAgent: b.userAgent, status: r.finalStatus ?? r.status, error: r.error };
      });
    }

    for (const pg of pages) {
      if (sitemap) pg.inSitemap = sitemap.entries.some((e) => sameUrl(e.url, pg.url));
    }

    // ------------------------------------------------------------- link targets (internal links, canonicals, sitemap entries)
    const linkTargets = new Map<string, LinkStatus>();
    const known = (u: string) => byUrl.has(normalizeUrl(u));
    if (p.needs.has('linkTargets') || p.needs.has('sitemap')) {
      const targets: string[] = [];
      const add = (u: string | undefined) => {
        if (!u || !isSameSite(u, siteHost) || known(u) || targets.includes(u)) return;
        targets.push(u);
      };
      if (p.needs.has('linkTargets')) {
        for (const pg of pages) {
          for (const c of pg.html?.canonicals ?? []) add(c);
        }
        let n = 0;
        for (const pg of pages) {
          for (const l of pg.html?.internalLinks ?? []) {
            if (n >= limits.linkChecks) break;
            if (hostOf(l) !== siteHost || NON_HTML_EXT.test(new URL(l).pathname) || SKIP_PATHS.test(new URL(l).pathname)) continue;
            if (!known(l) && !targets.includes(l)) {
              add(l);
              n++;
            }
          }
        }
      }
      if (sitemap && p.needs.has('sitemap')) {
        let n = 0;
        for (const e of sitemap.entries) {
          if (n >= limits.sitemapChecks) break;
          if (!known(e.url) && !targets.includes(e.url)) {
            add(e.url);
            n++;
          }
        }
      }
      const allowed = targets.filter((u) => robotsOk(u).allowed || !isSameSite(u, siteHost) || hostOf(u) !== siteHost);
      const results = await mapPool(allowed, conc, (u) => checkLink(u));
      for (const r of results) linkTargets.set(normalizeUrl(r.url), r);
    }

    // ------------------------------------------------------------- images
    let images: SiteContext['images'];
    if (p.needs.has('images')) {
      images = new Map<string, AssetInfo>();
      const todo: string[] = [];
      for (const pg of pages) {
        if (!pg.html) continue;
        for (const img of pg.html.images.filter((i) => i.inMain).slice(0, limits.imagesPerPage)) {
          const h = hostOf(img.src);
          if (!(isSameSite(img.src, siteHost) || IMAGE_CDN.test(h))) continue;
          if (todo.length >= limits.imagesTotal) break;
          if (!todo.includes(img.src)) todo.push(img.src);
        }
      }
      const imgHttp = createHttpClient({ userAgent: opts.userAgent, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
      const res = await mapPool(todo, conc, async (u) => ({ u, r: await sizeWithAccept(imgHttp, u, opts) }));
      for (const { u, r } of res) images.set(u, { url: u, ...r });
    }

    // ------------------------------------------------------------- outbound links
    let externalLinks: SiteContext['externalLinks'];
    if (p.needs.has('external')) {
      externalLinks = new Map<string, AssetInfo>();
      const todo: string[] = [];
      for (const pg of pages) for (const l of pg.html?.externalLinks ?? []) if (todo.length < limits.externalLinks && !todo.includes(l) && !FIRST_PARTY_CDN.test(hostOf(l))) todo.push(l);
      const res = await mapPool(todo, conc, (u) => checkLink(u));
      for (const r of res) externalLinks.set(r.url, { url: r.url, status: r.finalStatus, error: r.error });
    }

    // ------------------------------------------------------------- third-party scripts
    let scripts: SiteContext['scripts'];
    if (p.needs.has('scripts')) {
      scripts = new Map<string, AssetInfo>();
      const todo: string[] = [];
      for (const pg of pages) for (const s of pg.html?.scriptSrcs ?? []) if (!isSameSite(s, siteHost) && todo.length < limits.thirdPartyScripts && !todo.includes(s)) todo.push(s);
      const res = await mapPool(todo, conc, async (u) => ({ u, r: await http.assetSize(u) }));
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
    return { pages, ctx, planned, durationMs: Date.now() - t0 };
  }

  return { readiness, collect, http, limits };
}

export type Collector = ReturnType<typeof createCollector>;

async function sizeWithAccept(http: HttpClient, url: string, _opts: CrawlEngineOptions) {
  // Browsers advertise AVIF/WebP; Shopify's CDN negotiates on Accept, so mirror a browser request.
  const head = await http.request(url, { method: 'HEAD', readBody: false, headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
  const cl = head.headers['content-length'];
  if (head.finalStatus !== null && head.finalStatus < 400 && cl !== undefined && Number.isFinite(Number(cl))) {
    return { status: head.finalStatus, bytes: Number(cl), contentType: head.headers['content-type'] };
  }
  const r = await http.assetSize(url);
  return { status: r.status ?? head.finalStatus, bytes: r.bytes, contentType: r.contentType ?? head.headers['content-type'], error: r.error ?? head.error };
}

function buildSitemapDiff(pages: ParsedPage[], ctx: SiteContext, invalid: { url: string; problem: string }[]): SitemapDiff | undefined {
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
    inSitemapNotCrawled: entries.filter((e) => !pages.some((p) => sameUrl(p.url, e.url))).map((e) => e.url),
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
      const base = plan.baseUrl || opts.baseUrl!;
      if (!isLocalHost(base) && hostOf(base).replace(/^www\./, '') !== hostOf(opts.baseUrl!).replace(/^www\./, '')) {
        throw new Error(`Refusing to crawl ${hostOf(base)}: only the configured CRAWLER_BASE_URL host (${hostOf(opts.baseUrl!)}) may be crawled.`);
      }
      const needs = new Set<ContextNeed>(ALL_NEEDS);
      if (plan.type === 'full') needs.add('bfs');
      const { pages, ctx, planned, durationMs } = await collector.collect({
        type: plan.type, baseUrl: base, urls: plan.urls ?? [], maxPages: plan.maxPages, tierOf: plan.tierOf, previous: plan.previous, needs, onProgress,
      });
      const { findings, evaluatedChecks, evaluatedTemplates, sitemapInvalid } = runAnalyzers(pages, ctx);
      const urls: CrawledUrl[] = pages
        .filter((p) => !p.derivedFrom)
        .map((p) => ({ url: p.url, status: p.status, reason: p.reason, responseMs: p.responseMs, error: p.error }));
      const pageTexts: NonNullable<CrawlOutcome['pageTexts']> = pages
        .filter((p) => p.status === 200 && p.html && p.html.mainText)
        .map((p) => ({ url: p.url, template: p.template as PageTemplate, text: p.html!.mainText }));
      const fetched = pages.filter((p) => !p.skippedByRobots && !p.derivedFrom);
      return {
        urls,
        sitemapDiff: buildSitemapDiff(pages, ctx, sitemapInvalid),
        findings,
        evaluatedChecks,
        evaluatedTemplates,
        pageTexts,
        snapshot: snapshotFromPages(pages, ctx),
        stats: {
          urlsPlanned: Math.max(planned, fetched.length),
          urlsCrawled: fetched.length,
          urlsFailed: fetched.filter(isFailure).length,
          jsRenderedSample: 0,
          durationMs,
          scope: summarizeScope(pages),
        },
      };
    },
  };
}

function summarizeScope(pages: ParsedPage[]): { label: string; count: number }[] {
  const by = new Map<string, number>();
  for (const p of pages) if (!p.derivedFrom) by.set(p.reason, (by.get(p.reason) ?? 0) + 1);
  return [...by.entries()].map(([label, count]) => ({ label, count }));
}
