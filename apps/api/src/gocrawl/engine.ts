/**
 * CrawlEngine backed by the Go production crawler (services/crawler-go) and the Rust text core (services/textcore-rs).
 *
 * The API stays the only thing people talk to: it validates the request, plans the crawl, starts the crawler as a
 * child process (bridge.ts), shows its live coverage / memory / diagnostics, enforces the memory budget across every
 * process, and analyses the result files in a bounded-memory streaming pass (analyze.ts). Page rows go to a
 * file-backed store that the Pages screen pages through on the server.
 *
 * Safety is unchanged: the crawler may only contact the configured website (CRAWLER_BASE_URL host, www-insensitive);
 * it re-checks every connection against the SSRF block list (private, loopback, link-local, metadata addresses) and
 * honours robots.txt. The child processes receive no API secrets (see minimalEnv).
 */
import crypto from 'node:crypto';
import v8 from 'node:v8';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CrawlCoverageCounts, CrawlMemory, CrawlRun, SentinelConfig } from '@sentinel/shared';
import type { CrawlEngine, CrawlPlan, EngineRunResult } from '../services/ports';
import { ALL_NEEDS, BOT_PROBES, engineReadiness } from '../crawler/engine';
import { parseRobots } from '../crawler/robots';
import type { AssetInfo, CrawlLog, HostVariant, LinkStatus, SitemapEntry, SitemapFile, SiteContext, TlsInfo } from '../crawler/types';
import { hostOf, isLocalHost, normalizeUrl } from '../crawler/url';
import { analyzeGoCrawl } from './analyze';
import { locateBinaries, type NativeBinaries } from './binaries';
import { runGoCrawler, type GoDone, type GoProgress } from './bridge';
import { readNdjsonGz } from './files';
import { analyzablePages, memoryPlan, nodeMemory } from './memoryBudget';

export interface GoEngineOptions {
  /** Time budget of the post-crawl checks (ms); undefined = the crawler's automatic budget. */
  checksBudgetMs?: number;
  /** Write Change Monitor snapshots during analysis (default true). */
  changeSnapshots?: boolean;
  baseUrl?: string;
  allowLive: boolean;
  userAgent: string;
  timeoutMs: number;
  concurrency: number;
  respectRobots: boolean;
  thresholds: Record<string, number>;
  config: SentinelConfig;
  requestDelayMs?: number;
  maxBodyBytes?: number;
  retries?: number;
  maxRetryWaitMs?: number;
  maxCrawlDelayMs?: number;
  maxSitemapFiles?: number;
  maxSitemapBytes?: number;
  allowLoopback?: boolean;
  now?: () => Date;
  log?: CrawlLog;
  /** Where crawl work files and page-row stores live (default: <os tmp>/sentinel-crawls). */
  workDir?: string;
  /** Keep the crawler's raw result files after analysis (debugging). */
  keepWorkFiles?: boolean;
  memoryBudgetMB?: number;
  goMemoryMB?: number;
  /** Pages a smart crawl may fetch (its budget). */
  smartMaxPages?: number;
  /** Stop a crawl with no answered request for this long (ms). Default 20 min. */
  stallTimeoutMs?: number;
  /** Full pages analysed together (memory vs. speed; default 250). */
  analysisBatchSize?: number;
  /** Most pages the API may analyse (default: worked out from the Node.js heap limit). */
  analysisPageCap?: number;
  env: { CRAWLER_GO_BIN?: string; TEXTCORE_BIN?: string };
}

const nodeHeapLimitMB = () => v8.getHeapStatistics().heap_size_limit / 1048576;

/** Priority of smart-crawl seeds by why they were chosen. */
const SEED_PRIORITY: Record<string, number> = { reverify: 100, homepage: 95, changed_48h: 80, collection: 60, top_product: 50 };

/** Native-process memory of every crawl running in this API process (several websites can crawl at once). */
const childMemory = new Map<string, number>();

/** Memory of the crawler / text-core processes of every crawl running now (MB). */
export function activeChildMemoryMB(): number {
  let n = 0;
  for (const v of childMemory.values()) n += v;
  return n;
}

export function defaultWorkDir(): string {
  return path.join(os.tmpdir(), 'sentinel-crawls');
}

export function createGoCrawlEngine(o: GoEngineOptions): CrawlEngine & { binaries: () => NativeBinaries } {
  const binaries = () => locateBinaries(o.env);
  const workRoot = o.workDir ?? defaultWorkDir();
  const log = o.log ?? { info: () => undefined, warn: () => undefined, error: () => undefined };

  function readiness() {
    const r = engineReadiness(o.baseUrl, o.allowLive);
    if (!r.ready) return r;
    const b = binaries();
    if (!b.crawler.path || b.crawler.problem) return { ready: false, reason: `The Go crawler is not available: ${b.crawler.problem ?? 'not found'}.`, baseUrl: r.baseUrl };
    return r;
  }

  async function run(plan: CrawlPlan, onProgress?: Parameters<CrawlEngine['run']>[1]): Promise<EngineRunResult> {
    const ready = readiness();
    if (!ready.ready) throw new Error(`Crawler not ready: ${ready.reason}`);
    const base = plan.startUrl ? `${new URL(plan.startUrl).origin}/` : plan.baseUrl || o.baseUrl!;
    const sameSite = (u: string) => isLocalHost(u) || hostOf(u).replace(/^www\./, '') === hostOf(o.baseUrl!).replace(/^www\./, '');
    if (!sameSite(base)) throw new Error(`Refusing to crawl ${hostOf(base)}: only the configured CRAWLER_BASE_URL host (${hostOf(o.baseUrl!)}) may be crawled.`);
    const bins = binaries();
    const jobId = `${plan.runId ?? 'run'}-${crypto.randomBytes(4).toString('hex')}`.replace(/[^\w.-]/g, '_');
    const workDir = path.join(workRoot, jobId);
    const resultsDir = path.join(workDir, 'results');
    await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
    const mem = memoryPlan({ CRAWLER_MEMORY_BUDGET_MB: o.memoryBudgetMB, CRAWLER_GO_MEMORY_MB: o.goMemoryMB });
    const smart = plan.type === 'smart';
    const n = plan.maxPages;
    const requested = smart ? Math.max(Number.isFinite(n) ? n : 0, o.smartMaxPages ?? 500) : Number.isFinite(n) ? n : 0;
    // The API analyses the fetched pages after the crawl; never fetch more than its heap can analyse, so a huge site
    // ends as "stopped for memory" with a reason instead of crashing the server during analysis.
    const memCap = o.analysisPageCap ?? analyzablePages();
    const maxPages = requested === 0 ? memCap : Math.min(requested, memCap);
    const cappedByMemory = maxPages === memCap && (requested === 0 || requested > memCap);
    const scaled = plan.startUrl && Number.isFinite(n)
      ? { linkChecks: Math.min(400, n * 4), sitemapChecks: Math.min(500, n * 2), imagesTotal: Math.min(300, n * 3), externalLinks: Math.min(60, n * 2), thirdPartyScripts: Math.min(40, n * 2), collectionScopedSamples: Math.min(8, n), budgetSamples: Math.min(10, n), paginationSamples: Math.min(5, n) }
      : {};
    const local = isLocalHost(base);
    const seeds = smart ? (plan.urls ?? []).map((u) => ({ url: u.url, reason: u.reason, priority: SEED_PRIORITY[u.reason] ?? 40 })) : [];
    const job = {
      jobId, mode: smart ? 'smart' : 'full', startUrl: plan.startUrl ?? base, baseUrl: o.baseUrl, resolveStart: plan.type === 'full',
      maxPages, maxDepth: plan.maxDepth ?? -1, concurrency: plan.concurrency ?? o.concurrency, timeoutMs: plan.timeoutMs ?? o.timeoutMs,
      requestDelayMs: plan.requestDelayMs ?? o.requestDelayMs ?? 0, retries: o.retries ?? 2, maxRetryWaitMs: o.maxRetryWaitMs, maxCrawlDelayMs: o.maxCrawlDelayMs,
      userAgent: o.userAgent, respectRobots: o.respectRobots, maxBodyBytes: o.maxBodyBytes, maxSitemapFiles: o.maxSitemapFiles, maxSitemapBytes: o.maxSitemapBytes,
      allowLoopback: o.allowLoopback ?? false, workDir, excludePatterns: plan.excludePatterns ?? [], seeds,
      needs: ALL_NEEDS, limits: scaled, botProbes: BOT_PROBES,
      textCore: { bin: bins.textCore.path && !bins.textCore.problem ? bins.textCore.path : '', brand: o.config.site.brand ?? '', disabled: !bins.textCore.path || !!bins.textCore.problem },
      memoryLimitMB: mem.goMemoryMB, progressMs: 1000, skipTls: local,
      ...(o.checksBudgetMs ? { checksBudgetMs: Math.round(o.checksBudgetMs) } : {}),
    };

    // ---- live state: coverage, memory of all processes, warnings
    const warnings: { code: string; message: string; at: string }[] = [];
    if (job.textCore.disabled) warnings.push({ code: 'textcore_missing', message: `Duplicate-content analysis is off: the Rust text core is not available (${bins.textCore.problem ?? 'not found'}).`, at: new Date().toISOString() });
    let lastProgress: GoProgress | undefined;
    let peakTotal = 0;
    let childrenGone = false;
    const memNow = (): CrawlMemory => {
      const nm = nodeMemory();
      const go = childrenGone ? undefined : lastProgress?.memory?.goRssMB;
      const tc = !childrenGone && lastProgress?.memory?.textCoreRssMB !== undefined && lastProgress.memory.textCoreRssMB >= 0 ? lastProgress.memory.textCoreRssMB : undefined;
      childMemory.set(jobId, (go ?? 0) + (tc ?? 0));
      let others = 0;
      for (const [k, v] of childMemory) if (k !== jobId) others += v;
      // The API process is shared by every crawl; the other crawls' native processes count against the same budget.
      const total = Math.round((nm.rssMB + (go ?? 0) + (tc ?? 0) + others) * 10) / 10;
      if (total > peakTotal) peakTotal = total;
      return { nodeRssMB: nm.rssMB, nodeHeapMB: nm.heapMB, goRssMB: go, textCoreRssMB: tc, totalMB: total, peakTotalMB: peakTotal, budgetMB: mem.budgetMB };
    };
    const coverageOf = (p: Omit<GoProgress, 'type'>): CrawlCoverageCounts => ({
      discovered: p.discovered, queued: p.queued, waiting: p.waiting, active: p.active, processed: p.processed, succeeded: p.succeeded, failed: p.failed,
      robots: p.robots, depthLimited: p.depthLimited, pageLimited: p.pageLimited, excluded: p.excluded, excludedBy: p.excludedBy ?? {}, notProcessed: p.notProcessed,
      sitemapUrls: p.sitemapUrls, pagesPerMin: p.pagesPerMin, politeness: p.politeness,
      requests: p.requests, requestsPerMin: p.requestsPerMin, lastRequestAt: p.lastRequestAt ?? undefined, checks: p.checks, phase: p.phase,
    });
    const t0 = Date.now();
    const go = await runGoCrawler({
      bin: bins.crawler.path!,
      job,
      signal: plan.signal,
      onEvent: (e) => {
        if (e.type === 'progress') {
          lastProgress = e;
          const pol = e.politeness;
          onProgress?.(e.processed, e.failed, e.discovered, e.succeeded, pol ? { delayMs: pol.delayMs, crawlDelayMs: pol.crawlDelayMs || undefined, retries: pol.retries, slowDowns: pol.slowDowns } : undefined);
          plan.onLive?.({ coverage: coverageOf(e), memory: memNow() });
        } else if (e.type === 'phase') {
          const ph = e.phase as CrawlRun['phase'];
          plan.onPhase?.(ph === 'text_analysis' ? 'text_analysis' : (ph ?? 'crawling'));
        } else if (e.type === 'warning') {
          warnings.push({ code: e.code, message: e.message, at: new Date().toISOString() });
          if (warnings.length > 20) warnings.shift();
          plan.onLive?.({ warning: { code: e.code, message: e.message } });
          log.warn({ code: e.code, message: e.message }, 'crawler warning');
        }
      },
      // A crawl that gets no answer at all for a long time (site down, endless rate limiting, a hung connection) ends as
      // "partial" with what it fetched, instead of showing "Running" forever. Phases without requests are exempt.
      stallCheck: () => {
        const p = lastProgress;
        if (!p?.lastRequestAt) return undefined;
        if (p.phase === 'text_analysis' || p.phase === 'finalizing' || p.phase === 'preflight') return undefined;
        const idle = Date.now() - Date.parse(p.lastRequestAt);
        const limit = o.stallTimeoutMs ?? 20 * 60_000;
        if (idle > limit) return `No request was answered for ${Math.round(idle / 60_000)} minutes during the "${p.phase ?? 'crawl'}" phase (current gap between requests ${p.politeness?.delayMs ?? '?'} ms). The crawl was stopped and everything fetched until then is kept.`;
        return undefined;
      },
      resourceCheck: () => {
        const m = memNow();
        if (mem.budgetMB && m.totalMB > mem.budgetMB) {
          return `The crawl's processes used ${Math.round(m.totalMB)} MB (API ${Math.round(m.nodeRssMB)} MB + crawler ${Math.round(m.goRssMB ?? 0)} MB + text core ${Math.round(m.textCoreRssMB ?? 0)} MB), above the ${mem.budgetMB} MB budget (${mem.basis}).`;
        }
        return undefined;
      },
    });
    const crawlMs = Date.now() - t0;
    childMemory.delete(jobId);
    // The crawler and the text core have exited: from here on only the API process holds memory for this crawl.
    childrenGone = true;
    const done: GoDone | undefined = go.done;
    const counts = done?.counts ?? lastProgress;
    const cancelledByUser = go.stoppedFor === 'user' || plan.signal?.aborted;

    // ---- outcome
    let outcome: NonNullable<CrawlRun['outcome']>;
    let outcomeReason: string | undefined;
    let failed: string | undefined;
    if (cancelledByUser) {
      outcome = 'cancelled';
      outcomeReason = done?.reason ?? 'Cancelled.';
    } else if (!done || done.state === 'failed') {
      outcome = 'failed';
      const exit = go.exitSignal ? `signal ${go.exitSignal}` : `exit code ${go.exitCode}`;
      const err = go.errors.map((x) => x.message).join('; ');
      failed = done?.reason || go.bridgeError || err || `the crawler stopped unexpectedly (${exit})${go.stderrTail ? `: ${go.stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}`;
      if (!done && !go.bridgeError) failed = `The crawler process ended without finishing (${exit}). ${failed}`;
      outcomeReason = failed;
    } else if (go.stoppedFor === 'stalled') {
      outcome = 'partial';
      outcomeReason = go.stallReason ?? done.reason ?? 'Stopped: no request was answered for a long time.';
    } else if (done.state === 'resource_stopped' || go.stoppedFor === 'resource') {
      outcome = 'resource_stopped';
      outcomeReason = go.resourceReason ?? done.reason ?? 'Stopped taking new pages because the memory limit was close.';
    } else if (done.state === 'partial' && cappedByMemory && (done.counts?.pageLimited ?? 0) > 0) {
      outcome = 'resource_stopped';
      outcomeReason = `Stopped at ${memCap.toLocaleString('en-US')} pages: that is as many as this API server can analyse with its memory (Node.js heap limit ${Math.round(nodeHeapLimitMB())} MB). The pages not fetched are listed as "page limit reached". Give the API more memory (see DEPLOYMENT.md) to crawl more pages.`;
    } else {
      outcome = done.state === 'partial' ? 'partial' : done.state === 'cancelled' ? 'cancelled' : 'completed';
      outcomeReason = done.reason || undefined;
    }

    // ---- site context from the crawler's files
    const ctx = await readContext(workDir, plan, o, base, outcome !== 'completed');
    const textCore = { ok: !!done?.textCore, error: done?.textCoreError || (job.textCore.disabled ? bins.textCore.problem ?? 'not available' : undefined) };
    const rowsOnly = outcome === 'cancelled' || outcome === 'failed';
    let analysis: Awaited<ReturnType<typeof analyzeGoCrawl>>;
    try {
      analysis = await analyzeGoCrawl({
        workDir, resultsDir, ctx, tierOf: plan.tierOf, textCore, rowsOnly, batchSize: o.analysisBatchSize, snapshot: o.changeSnapshots !== false,
        // Every page's text when custom rules will read it; otherwise a sample for rule dry runs.
        collectTexts: plan.collectTexts ? true : 1000,
        onPhase: (ph) => plan.onPhase?.(ph),
        onBatch: () => { plan.onLive?.({ memory: memNow() }); },
        log,
      });
    } catch (e) {
      if (!o.keepWorkFiles) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`Reading the crawl results failed: ${(e as Error).message}${failed ? ` (crawl: ${failed})` : ''}`);
    }
    for (const p of analysis.readProblems) warnings.push({ code: 'results', message: p, at: new Date().toISOString() });
    const memory = memNow();
    const coverage = counts ? coverageOf(counts) : undefined;
    const pol = counts?.politeness;
    const sizeNote = analysis.store.count();
    const smartInfo = smart
      ? {
        budget: maxPages, prioritized: seeds.length, notAudited: (counts?.pageLimited ?? 0) + (counts?.notProcessed ?? 0) + (counts?.queued ?? 0) + (counts?.waiting ?? 0),
        basis: [
          seeds.length ? `${seeds.length} URL(s) with evidence (known issues to re-check, pages changed in 48 h, homepage, collections, top products)` : 'no evidence from earlier crawls yet (first smart crawl on this server)',
          'then sitemap and linked pages by priority: homepage, collections, products with recent sitemap lastmod, shallow pages first',
        ],
      }
      : undefined;
    const stats: Partial<CrawlRun> = {
      engine: 'go', outcome, outcomeReason, coverage, memory, warnings: warnings.slice(-20), textCore,
      // Planned = every in-scope URL found (discovered minus URLs excluded by rule): fetched, robots-blocked, or left out
      // by a limit / an early stop — each of those is reported separately in `coverage`.
      urlsPlanned: counts ? Math.max(counts.processed, counts.discovered - counts.excluded) : 0,
      urlsCrawled: counts?.processed ?? 0,
      urlsFailed: counts?.failed ?? 0,
      urlsSucceeded: counts?.succeeded ?? 0,
      urlsDiscovered: counts?.discovered ?? 0,
      jsRenderedSample: 0,
      durationMs: crawlMs,
      urlCount: sizeNote,
      timings: { ...(done?.timings ?? {}), crawlProcessMs: crawlMs, ...analysis.timings },
      scope: scopeOf(counts, smartInfo),
      politeness: pol ? { delayMs: pol.delayMs, crawlDelayMs: pol.crawlDelayMs || undefined, retries: pol.retries, slowDowns: pol.slowDowns } : undefined,
      ...(smartInfo ? { smart: smartInfo } : {}),
      ...(ctx.resolvedFrom ? { resolvedStartUrl: ctx.resolvedStart, resolvedFrom: ctx.resolvedFrom } : {}),
    };
    const cleanup = async () => {
      // The crawler's raw files are no longer needed once rows and findings are stored; the results/ folder (page rows,
      // texts, coverage) stays for the Pages screen and exports until the run is evicted by retention.
      if (o.keepWorkFiles) return;
      for (const f of ['pages.ndjson.gz', 'urls.ndjson.gz', 'sitemap.ndjson.gz', 'context.json', 'text.json', 'textcore.spill', 'textcore.sets']) {
        await fsp.rm(path.join(workDir, f), { force: true }).catch(() => undefined);
      }
    };
    if (rowsOnly) {
      return { urls: [], findings: [], evaluatedChecks: [], evaluatedTemplates: {}, stats, cancelled: outcome === 'cancelled', failed, store: analysis.store, coverageReport: analysis.coverage, answeredUrls: analysis.store.answeredUrls(), snapshotFile: analysis.snapshotFile, cleanup };
    }
    return {
      urls: [], findings: analysis.findings, evaluatedChecks: analysis.evaluatedChecks, evaluatedTemplates: analysis.evaluatedTemplates,
      sitemapDiff: analysis.sitemapDiff, snapshot: analysis.snapshot, stats, memoryStopped: outcome === 'resource_stopped',
      store: analysis.store, coverageReport: analysis.coverage, answeredUrls: analysis.store.answeredUrls(), textsFile: analysis.textsFile, snapshotFile: analysis.snapshotFile, cleanup,
    };
  }

  return { readiness, run, binaries };
}

function scopeOf(c: Omit<GoProgress, 'type'> | undefined, smart?: { budget: number; prioritized: number; notAudited: number }): { label: string; count: number }[] {
  if (!c) return [];
  const out = [
    { label: 'URLs discovered', count: c.discovered },
    { label: 'Pages fetched', count: c.processed },
    { label: 'Not fetched: disallowed by robots.txt', count: c.robots },
    { label: 'Not fetched: excluded (parameters, cart/account, files, traps, your exclusions)', count: c.excluded },
    { label: 'Not fetched: beyond the depth limit', count: c.depthLimited },
    { label: 'Not fetched: page limit reached', count: c.pageLimited },
    { label: 'Not fetched: crawl stopped first', count: c.notProcessed + c.queued + c.waiting },
  ];
  if (smart) out.push({ label: `Smart crawl budget ${smart.budget} pages; ${smart.prioritized} prioritised by evidence; not audited this run`, count: smart.notAudited });
  return out.filter((x, i) => i < 2 || x.count > 0);
}

type Ctx = SiteContext & { resolvedStart?: string; resolvedFrom?: string };

/** SiteContext from context.json + sitemap.ndjson.gz (absent members ⇒ that check did not run). */
async function readContext(workDir: string, plan: CrawlPlan, o: GoEngineOptions, base: string, truncated: boolean): Promise<Ctx> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await fsp.readFile(path.join(workDir, 'context.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    /* crashed before writing it: context-based checks are reported as not evaluated */
  }
  const origin = (raw.origin as string | undefined) ?? new URL(base).origin;
  const host = (raw.host as string | undefined) ?? new URL(base).host;
  const robotsRaw = raw.robots as { url: string; status: number | null; error?: string; body?: string } | undefined;
  const sm = raw.sitemap as { rootUrls: string[]; files: SitemapFile[] } | undefined;
  let entries: SitemapEntry[] | undefined;
  if (sm) {
    entries = [];
    for await (const e of readNdjsonGz<SitemapEntry>(path.join(workDir, 'sitemap.ndjson.gz'))) entries.push(e);
  }
  const mapOf = <T extends { url: string }>(list: unknown, key: (u: string) => string = (u) => u) => (Array.isArray(list) ? new Map((list as T[]).map((x) => [key(x.url), x])) : undefined);
  const ctx: Ctx = {
    baseUrl: `${origin}/`, origin, host, isLocal: isLocalHost(base), crawlType: plan.type, config: o.config, thresholds: o.thresholds, previous: plan.previous,
    now: (o.now ?? (() => new Date()))(), userAgent: o.userAgent, tierOf: plan.tierOf,
    robots: robotsRaw ? { url: robotsRaw.url, status: robotsRaw.status ?? null, error: robotsRaw.error || undefined, body: robotsRaw.body, parsed: parseRobots(robotsRaw.body ?? '') } : undefined,
    sitemap: sm && entries ? { rootUrls: sm.rootUrls ?? [], files: sm.files ?? [], entries } : undefined,
    linkTargets: mapOf<LinkStatus>(raw.linkTargets, normalizeUrl) ?? new Map(),
    images: mapOf<AssetInfo>(raw.images),
    externalLinks: mapOf<AssetInfo>(raw.externalLinks),
    scripts: mapOf<AssetInfo>(raw.scripts),
    tls: raw.tls as TlsInfo | undefined,
    hostVariants: raw.hostVariants as HostVariant[] | undefined,
    trailingSlash: raw.trailingSlash as SiteContext['trailingSlash'],
    discoveredBudgetUrls: raw.discoveredBudgetUrls as string[] | undefined,
    botProbes: raw.botProbes as SiteContext['botProbes'],
    crawlRateLimited: (((raw.counts as { politeness?: { limitedAnswers?: number } } | undefined)?.politeness?.limitedAnswers) ?? 0) > 0,
    bfsTruncated: truncated || raw.bfsTruncated === true || raw.bfsTruncated === undefined,
    resolvedStart: raw.resolvedStartUrl as string | undefined,
    resolvedFrom: raw.resolvedFrom as string | undefined,
  };
  // Link statuses from Go use the same shape; normalise null chains.
  for (const l of ctx.linkTargets.values()) l.chain ??= [];
  for (const v of ctx.hostVariants ?? []) v.chain ??= [];
  return ctx;
}

const cleanedRoots = new Set<string>();

/**
 * Removes crawl work folders left by an earlier server process (their runs are gone with the in-memory store). Runs
 * once per folder per process, so a website added later does not delete the results of crawls already running.
 */
export async function cleanStaleWork(root = defaultWorkDir(), keep: Set<string> = new Set()): Promise<number> {
  if (cleanedRoots.has(path.resolve(root))) return 0;
  cleanedRoots.add(path.resolve(root));
  let removed = 0;
  let names: string[] = [];
  try {
    names = await fsp.readdir(root);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (keep.has(n)) continue;
    await fsp.rm(path.join(root, n), { recursive: true, force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

export const __test = { readContext, scopeOf };
