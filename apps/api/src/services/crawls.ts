import {
  CRAWL_DETAIL_ROW_LIMIT, SMART_CRAWL_PAGE_BUDGET, CRAWL_EXPORT_NOTE, auditLimitsFrom, auditPage, type CrawlPageReport, crawlCsvHeader, crawlCsvRow, crawlExportFilename, crawlResultsCsv, crawlResultsJson, validateCrawlOptions,
  type CrawlCoverageReport, type CrawlDetail, type CrawlerStatus, type CrawlOptions, type CrawlPagesQuery, type CrawlPagesResponse, type CrawlRun, type CrawlType,
  type CrawledUrl, type CrawledUrlIssue, type PageTemplate, type SitePage,
} from '@sentinel/shared';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readNdjsonGz } from '../gocrawl/files';
import { FileResultStore, MemoryResultStore, type CrawlResultStore } from '../results/store';
import type { PageTextDoc } from '../repositories/types';
import { badRequest, conflict, notFound } from '../lib/errors';
import { ApiError } from '../lib/errors';
import { audit, need, SYSTEM_ACTOR, type Actor, type Ctx } from './context';
import type { IssueService } from './issues';
import type { CrawlPlan, EngineRunResult } from './ports';
import type { RuleService } from './rules';
import { heapLimitMb } from '../crawler/memory';
import type { ChangeService } from '../changes/service';

export function templateOfPath(path: string): PageTemplate {
  if (path === '/' || path === '') return 'home';
  if (/^\/collections\/[^/]+\/products\//.test(path) || /^\/products\//.test(path)) return 'product';
  if (/^\/collections\//.test(path)) return 'collection';
  if (/^\/blogs\/[^/]+\/[^/]+/.test(path)) return 'blog_article';
  if (/^\/blogs\//.test(path)) return 'blog_index';
  if (/^\/pages\//.test(path)) return 'page';
  if (/^\/search/.test(path)) return 'search';
  return 'other';
}

export function validCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.every((p, n) => p.split(',').every((seg) => {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(seg);
    if (!m) return false;
    const [lo, hi] = ranges[n];
    const a = m[2] !== undefined ? Number(m[2]) : lo;
    const b = m[3] !== undefined ? Number(m[3]) : a;
    if (m[4] !== undefined && Number(m[4]) < 1) return false;
    return a >= lo && b <= hi && a <= b;
  }));
}

/**
 * Crawl orchestration (PDF §2A, §16): plans smart / full / re-verify crawls, runs the real crawl engine,
 * stores URL results + sitemap diff + the observation snapshot, and feeds findings to the issue service.
 * The engine refuses to run unless CRAWLER_BASE_URL is set and CRAWLER_ALLOW_LIVE=true (loopback hosts excepted).
 */
/** Live crawls running on this server across ALL websites (each website has its own crawl service). */
let activeJobs = 0;
/** Crawls restarted after a server restart that wait for a free slot (CRAWLER_MAX_CONCURRENT_JOBS). */
let waitingJobs = 0;
/**
 * The server is shutting down (SIGTERM: redeploy, restart, idle stop). A crawl cut off by the shutdown is NOT finalised
 * as failed: it stays "running" in the database and is started again when the server is back (resumeInterrupted).
 */
let shuttingDown = false;
export function suspendCrawlsForShutdown() { shuttingDown = true; }
/** Crawls running or waiting to run on this server (all websites). */
export const busyCrawlJobs = () => activeJobs + waitingJobs;
const isActive = (c: Pick<CrawlRun, 'status'>) => c.status === 'running' || c.status === 'queued';
/** 409 for a second start while a crawl of this website runs; carries the running crawl so the web app can show it. */
const alreadyRunning = (run?: CrawlRun) => new ApiError(409, 'CRAWL_ALREADY_RUNNING', run
  ? `Crawl ${run.id} is already ${run.status} for this website, so no second crawl was started. Its progress is shown in the Crawl Center — wait for it to finish or cancel it.`
  : 'A crawl of this website is being started right now, so no second crawl was started.', run ? { runId: run.id, status: run.status } : undefined);
/** Least time between two progress writes of one crawl (the progress panel polls every few seconds). */
const PROGRESS_WRITE_MS = 500;
/** Page texts kept from a Go crawl for custom-rule dry runs (each capped at 20,000 characters). */
const STORED_TEXTS = 1000;

const sameUrlKey = (u: string) => {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
};

export function createCrawlService(ctx: Ctx, issues: IssueService, rules: RuleService, changes?: ChangeService) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();
  const running = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  /** Page rows of recent Go crawls (file-backed); older runs are evicted (CRAWLER_KEEP_RESULTS). */
  const stores = new Map<string, CrawlResultStore>();
  const coverageReports = new Map<string, CrawlCoverageReport>();
  async function keepStore(id: string, store: CrawlResultStore, coverage?: CrawlCoverageReport) {
    stores.set(id, store);
    if (coverage) coverageReports.set(id, coverage);
    const keep = ctx.env.CRAWLER_KEEP_RESULTS ?? 3;
    while (stores.size > keep) {
      const oldest = stores.keys().next().value as string;
      const st = stores.get(oldest);
      stores.delete(oldest);
      coverageReports.delete(oldest);
      await st?.dispose().catch(() => undefined);
    }
  }
  /** Image references of recent crawls (input of an Image Audit), kept like page rows (CRAWLER_KEEP_RESULTS). */
  const imageRefs = new Map<string, { file: string; checkedFile?: string; owned: boolean }>();
  function keepImageRefs(id: string, file: string) {
    // Go crawls write it into their results folder (removed with it); the built-in crawler into a temporary file.
    imageRefs.set(id, { file, checkedFile: path.join(path.dirname(file), 'images-checked.json'), owned: !stores.has(id) });
    const keep = ctx.env.CRAWLER_KEEP_RESULTS ?? 3;
    while (imageRefs.size > keep) {
      const oldest = imageRefs.keys().next().value as string;
      const ref = imageRefs.get(oldest);
      imageRefs.delete(oldest);
      if (ref?.owned) void fsp.rm(ref.file, { force: true }).catch(() => undefined);
    }
  }
  // ------------------------------------------------------------------ database (DATABASE_URL)
  const db = ctx.persistence;
  const scope = ctx.scope ?? 'site';
  /**
   * Saves a finished crawl's page rows and coverage report, so the Pages screen, page reports and exports work after a
   * restart. Only the page rows of the CRAWLER_KEEP_RESULTS most recent crawls are kept (every crawl keeps its run
   * record, issues and findings).
   */
  async function persistRun(id: string, store: CrawlResultStore | undefined, coverage?: CrawlCoverageReport) {
    if (!db) return;
    try {
      if (store && store.kind === 'file') await db.saveCrawlRows(scope, id, store.iterate());
      if (coverage) await db.saveFile(scope, `coverage/${id}.json`, Buffer.from(JSON.stringify(coverage)));
      const keep = ctx.env.CRAWLER_KEEP_RESULTS ?? 3;
      const withRows = (await r.crawls.list()).filter((c) => c.engine === 'go' && c.status !== 'running' && c.status !== 'queued')
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')).slice(0, keep).map((c) => c.id);
      if (!withRows.includes(id)) withRows.push(id);
      await db.pruneCrawlRows(scope, withRows);
      const covs = await db.listFiles(scope, 'coverage/');
      await db.deleteFiles(scope, covs.filter((f) => !withRows.includes(f.slice('coverage/'.length, -'.json'.length))));
    } catch (e) {
      ctx.log.error({ runId: id, err: (e as Error).message }, 'crawl results could not be saved in the database');
      throw e;
    }
  }
  const restoring = new Map<string, Promise<CrawlResultStore | undefined>>();
  /** A run's file-backed page rows: in memory, or rebuilt from the database after a restart. */
  async function savedStore(id: string): Promise<CrawlResultStore | undefined> {
    const st = stores.get(id);
    if (st || !db) return st;
    let p = restoring.get(id);
    if (!p) {
      p = (async () => {
        const run = await r.crawls.get(id);
        if (!run || !(await db.hasCrawlRows(scope, id))) return undefined;
        const dir = path.join(ctx.env.CRAWLER_WORK_DIR ?? path.join(os.tmpdir(), 'sentinel-crawls'), 'restored', `${scope}-${id}`.replace(/[^\w.-]/g, '_'));
        await fsp.rm(dir, { recursive: true, force: true });
        const fresh = new FileResultStore(dir, auditLimitsFrom((await r.config.get()).thresholds as unknown as Record<string, number>));
        for await (const row of db.crawlRows<CrawledUrl>(scope, id)) fresh.add(row);
        fresh.seal();
        fresh.setIssues(await issuesByUrl(run.startedAt ?? ''), sameUrlKey);
        let coverage: CrawlCoverageReport | undefined;
        const raw = await db.readFile(scope, `coverage/${id}.json`);
        if (raw) { try { coverage = JSON.parse(raw.toString('utf8')) as CrawlCoverageReport; } catch { /* unreadable: no coverage report */ } }
        await keepStore(id, fresh, coverage);
        ctx.log.info({ runId: id, rows: fresh.count() }, 'crawl page rows restored from the database');
        return fresh;
      })().finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    return p;
  }
  /** Rows of a run: its store, else the rows saved with the run (built-in crawler / small runs). */
  async function storeOf(id: string): Promise<CrawlResultStore> {
    const st = await savedStore(id);
    if (st) return st;
    return new MemoryResultStore((await r.crawlUrls.get(id))?.urls ?? [], auditLimitsFrom((await r.config.get()).thresholds as unknown as Record<string, number>));
  }

  /**
   * Change Monitor: compare the finished crawl with the baseline. Never fails the crawl — a problem is logged and shown
   * as a warning on the run.
   */
  async function recordChanges(runId: string, out: Pick<EngineRunResult, 'snapshotFile' | 'snapshotRecords'>) {
    if (!changes) return;
    const run = await r.crawls.get(runId);
    if (!run) return;
    try {
      await changes.record(run, out);
    } catch (e) {
      ctx.log.warn({ runId, err: (e as Error).message }, 'change monitor failed');
      const cur = (await r.crawls.get(runId)) ?? run;
      await r.crawls.update({ ...cur, warnings: [...(cur.warnings ?? []), { code: 'change_monitor', message: `Change Monitor could not compare this crawl: ${(e as Error).message}`, at: iso() }].slice(-20) });
    }
  }

  /** The website this service crawls (its configured URL). */
  async function siteUrl(): Promise<string> {
    const ready = ctx.engine.readiness();
    return ready.baseUrl ?? ctx.env.CRAWLER_BASE_URL ?? (await r.config.get()).site.baseUrl;
  }

  /** Why a live crawl cannot start for this website right now, or undefined. */
  async function blockedReason(): Promise<string | undefined> {
    const ready = ctx.engine.readiness();
    if (!ready.ready) return ready.reason;
    if ((await r.metrics.get()).source === 'demo') {
      return 'This website holds the labelled DEMO dataset, so live results would be mixed with sample data. Add the site under Manage websites, or start the server with SEED_DEMO_DATA=false, to crawl it live.';
    }
    return undefined;
  }

  /** Issues seen in this run, by page URL key (issue tracker records with their Fix Cards). */
  async function issuesByUrl(since: string) {
    const seen = (await r.issues.list()).filter((i) => i.source === 'live' && !i.isTemplateGroup && i.lastSeenAt >= since);
    const byUrl = new Map<string, CrawledUrlIssue[]>();
    for (const i of seen) {
      for (const u of i.affectedUrls) {
        const k = sameUrlKey(u);
        const list = byUrl.get(k) ?? [];
        if (!list.some((x) => x.id === i.id)) list.push({ id: i.id, checkId: i.checkId, title: i.title, severity: i.severity, summary: i.summary });
        byUrl.set(k, list);
      }
    }
    return byUrl;
  }

  /** Attach the issues seen in this run to each page row (issue tracker records with their Fix Cards). */
  async function attachIssues(urls: CrawledUrl[], since: string) {
    const seen = (await r.issues.list()).filter((i) => i.source === 'live' && !i.isTemplateGroup && i.lastSeenAt >= since);
    const byUrl = new Map<string, CrawledUrlIssue[]>();
    for (const i of seen) {
      for (const u of i.affectedUrls) {
        const k = sameUrlKey(u);
        const list = byUrl.get(k) ?? [];
        if (!list.some((x) => x.id === i.id)) list.push({ id: i.id, checkId: i.checkId, title: i.title, severity: i.severity, summary: i.summary });
        byUrl.set(k, list);
      }
    }
    const rank = { critical: 0, medium: 1, low: 2 } as const;
    return urls.map((u) => {
      const list = byUrl.get(sameUrlKey(u.url));
      return list?.length ? { ...u, issues: [...list].sort((a, b) => rank[a.severity] - rank[b.severity]) } : u;
    });
  }

  async function buildPlan(type: CrawlType): Promise<CrawlPlan> {
    const ready = ctx.engine.readiness();
    const baseUrl = ready.baseUrl ?? ctx.env.CRAWLER_BASE_URL!;
    const origin = new URL(baseUrl).origin;
    const cfg = await r.config.get();
    const tierOf = await issues.tierLookup();
    const prev = (await r.crawlStates.get('latest'))?.state;
    const onSite = (u: string) => {
      try { return new URL(new URL(u).pathname + new URL(u).search, origin).toString(); } catch { return undefined; }
    };
    const fixedUrls = (await r.issues.list())
      .filter((i) => i.source !== 'demo' && i.status === 'FIXED')
      .flatMap((i) => i.affectedUrls)
      .map(onSite).filter((u): u is string => !!u);
    if (type === 'reverify') {
      if (!fixedUrls.length) throw conflict('No live issues are in FIXED, so there is nothing to re-verify.', 'NOTHING_TO_VERIFY');
      return { type, baseUrl, previous: prev, urls: [...new Set(fixedUrls)].map((url) => ({ url, reason: 'reverify' as const })), maxPages: fixedUrls.length + 10, tierOf };
    }
    if (type === 'full') return { type, baseUrl, previous: prev, maxPages: ctx.env.CRAWLER_MAX_PAGES ?? Number.POSITIVE_INFINITY, tierOf };
    // Smart crawl (PDF §16): homepage + every collection + top products by value + pages changed in 48h + re-verify set.
    // Only pages discovered by previous LIVE crawls are used — DEMO inventory is never requested from the live site.
    const pages = (await r.sitePages.list()).filter((p) => p.source === 'live');
    const changedSince = ctx.clock().getTime() - cfg.crawl.changedWithinHours * 3600_000;
    const urls: { url: string; reason: CrawledUrl['reason'] }[] = [{ url: `${origin}/`, reason: 'homepage' }];
    for (const p of pages.filter((x) => x.template === 'collection')) urls.push({ url: p.url, reason: 'collection' });
    const products = pages.filter((x) => x.template === 'product').sort((a, b) => a.tier - b.tier || (b.revenue90d ?? 0) - (a.revenue90d ?? 0) || (b.organicSessions90d ?? 0) - (a.organicSessions90d ?? 0));
    for (const p of products.slice(0, cfg.crawl.smartTopProducts)) urls.push({ url: p.url, reason: 'top_product' });
    for (const p of pages.filter((x) => x.lastModified && new Date(x.lastModified).getTime() >= changedSince)) urls.push({ url: p.url, reason: 'changed_48h' });
    for (const u of fixedUrls) urls.push({ url: u, reason: 'reverify' });
    const dedup = [...new Map(urls.map((u) => [u.url, u])).values()].map((u) => ({ ...u, url: onSite(u.url) ?? u.url }));
    // Never more than the Smart Crawl budget (the Go crawler also enforces it; the built-in crawler fetches only these URLs).
    const budget = Math.min(ctx.env.CRAWLER_SMART_MAX_PAGES, SMART_CRAWL_PAGE_BUDGET);
    return { type, baseUrl, previous: prev, urls: dedup.slice(0, budget), maxPages: Math.min(dedup.length + 50, budget), tierOf };
  }

  async function recordPages(urls: CrawledUrl[] | CrawlResultStore, tierOf: (u: string) => SitePage['tier']) {
    // One read of the page inventory (a lookup per URL would copy the whole inventory for every one of 50,000 pages).
    const known = new Map<string, SitePage>();
    for (const p of await r.sitePages.list()) if (!known.has(p.url)) known.set(p.url, p);
    const each = Array.isArray(urls) ? async (fn: (u: CrawledUrl) => Promise<void>) => { for (const u of urls) await fn(u); } : (fn: (u: CrawledUrl) => Promise<void>) => urls.forEach(fn);
    await each(async (u) => {
      if (u.status === null || u.status === undefined) return;
      let path = u.url;
      try { path = new URL(u.url).pathname; } catch { return; }
      const prev = known.get(u.url);
      const page: SitePage = {
        id: prev?.id ?? `page:${u.url}`, url: u.url, path, template: templateOfPath(path), title: prev?.title ?? path, tier: tierOf(u.url),
        tierReason: prev?.tierReason ?? (path === '/' ? 'Homepage' : 'Default Tier 3 until GA4/Shopify value data is connected'),
        indexable: u.status === 200, lastModified: prev?.lastModified, revenue90d: prev?.revenue90d, organicSessions90d: prev?.organicSessions90d,
        impressions28d: prev?.impressions28d, clicks28d: prev?.clicks28d, source: 'live',
      };
      await r.sitePages.upsert(page);
    });
  }

  /**
   * Go crawls: custom rules read every page's main text from the crawl's text file in chunks (never all at once), and a
   * sample of page texts is kept for rule dry runs.
   */
  async function applyRulesFromFile(file: string, tierOf: (u: string) => SitePage['tier']) {
    const anyRule = (await r.rules.list()).some((x) => x.enabled);
    let chunk: PageTextDoc[] = [];
    let flagged = 0;
    let ruleCount = 0;
    let stored = 0;
    const now = iso();
    const flush = async () => {
      if (!chunk.length) return;
      if (anyRule) {
        const res = await rules.applyToPages(chunk);
        flagged += res.flagged;
        ruleCount = res.rules;
      }
      chunk = [];
    };
    for await (const t of readNdjsonGz<{ url: string; template: PageTemplate; text: string }>(file)) {
      let handle: string | undefined;
      try { handle = new URL(t.url).pathname.match(/^\/collections\/([^/]+)/)?.[1]; } catch { /* ignore */ }
      const prev = stored < STORED_TEXTS || anyRule ? await r.pageTexts.get(t.url) : undefined;
      const doc: PageTextDoc = { id: t.url, url: t.url, template: t.template, tier: tierOf(t.url), collectionHandle: handle, text: t.text, publishedAt: prev?.publishedAt ?? now, source: 'live' };
      if (stored < STORED_TEXTS) {
        await r.pageTexts.upsert({ ...doc, text: doc.text.slice(0, 20_000) });
        stored++;
      }
      if (anyRule) chunk.push(doc);
      if (chunk.length >= 200) await flush();
    }
    await flush();
    return { rules: ruleCount, flagged };
  }

  async function execute(run: CrawlRun, plan: CrawlPlan) {
    const started = Date.now();
    const startedIso = iso();
    try {
      const queuedRun = await r.crawls.get(run.id);
      if (queuedRun) await r.crawls.update({ ...queuedRun, status: 'running', startedAt: startedIso, phase: 'crawling' });
      let progress = Promise.resolve();
      const setPhase = (phase: NonNullable<CrawlRun['phase']>) => {
        progress = progress.then(async () => {
          const cur = await r.crawls.get(run.id);
          if (cur && cur.status === 'running') await r.crawls.update({ ...cur, phase });
        }).catch(() => undefined);
      };
      plan.onPhase = (phase) => setPhase(phase);
      plan.runId = run.id;
      plan.collectTexts = (await r.rules.list()).some((x) => x.enabled);
      // Live coverage / memory / diagnostics from the Go crawler, written with the coalesced progress updates.
      let live: Partial<CrawlRun> = {};
      plan.onLive = (l) => {
        if (l.coverage) live.coverage = l.coverage;
        if (l.memory) live.memory = l.memory;
        if (l.warning) live.warnings = [...(live.warnings ?? []), { ...l.warning, at: iso() }].slice(-20);
        if (!latest && !scheduled) {
          scheduled = true;
          progress = progress.then(() => new Promise<void>((res) => setTimeout(res, PROGRESS_WRITE_MS))).then(writeLatest).catch(() => undefined);
        }
      };
      // Progress writes are serialised and drained before the final status is written, so a late progress update can
      // never overwrite "completed" / "cancelled". The engine reports after every page; writes are coalesced so only the
      // latest counts are stored, at most every PROGRESS_WRITE_MS (a 50,000-page crawl does not queue 50,000 writes).
      let latest: [number, number, number, number, CrawlRun['politeness'] | undefined] | undefined;
      let scheduled = false;
      let lastWrite = 0;
      const writeLatest = async () => {
        scheduled = false;
        const v = latest;
        latest = undefined;
        const l = live;
        live = {};
        if (!v && !Object.keys(l).length) return;
        lastWrite = Date.now();
        const cur = await r.crawls.get(run.id);
        if (cur && (cur.status === 'running' || cur.status === 'queued')) {
          const counts = v
            ? (([crawled, failed, discovered, succeeded, politeness]) => ({
              urlsCrawled: crawled, urlsFailed: failed, urlsDiscovered: discovered, urlsSucceeded: succeeded,
              urlsPlanned: Math.max(cur.urlsPlanned, Math.min(discovered, plan.maxPages)), ...(politeness ? { politeness } : {}),
            }))(v)
            : {};
          const warnings = l.warnings ? [...(cur.warnings ?? []), ...l.warnings].slice(-20) : cur.warnings;
          await r.crawls.update({ ...cur, ...counts, ...l, ...(warnings ? { warnings } : {}) });
        }
      };
      const out = await ctx.engine.run(plan, (crawled, failed, discovered, succeeded, politeness) => {
        latest = [crawled, failed, discovered, succeeded, politeness];
        if (scheduled) return;
        scheduled = true;
        const wait = Math.max(0, PROGRESS_WRITE_MS - (Date.now() - lastWrite));
        progress = progress
          .then(() => (wait > 0 ? new Promise<void>((res) => setTimeout(res, wait)) : undefined))
          .then(writeLatest)
          .catch(() => undefined);
      });
      await progress;
      if (latest) await writeLatest().catch(() => undefined);
      if (!out.cancelled) {
        setPhase('saving');
        await progress;
      }
      // Go crawls: rows live in a file-backed store; only small runs are also kept inline with the run.
      const inlineRows = async () => (out.store ? (await out.store.allIfSmall(CRAWL_DETAIL_ROW_LIMIT)) ?? [] : out.urls);
      const urlCount = out.store ? out.store.count() : out.urls.length;
      if (shuttingDown && !plan.signal?.aborted && (out.failed || out.cancelled)) {
        // Cut off by the server shutting down, not by the user or the site: left "running" in the database so it is
        // started again when the server is back (never recorded as a finished, cancelled or failed audit).
        ctx.log.warn({ runId: run.id }, 'crawl interrupted by server shutdown; it will be restarted when the server is back');
        return;
      }
      if (out.store) await keepStore(run.id, out.store, out.coverageReport);
      if (out.imageRefsFile) keepImageRefs(run.id, out.imageRefsFile);
      if (out.cancelled) {
        // Partial crawl: keep the page results; never ingest findings (missing pages would wrongly resolve issues).
        await r.crawlUrls.upsert({ id: run.id, urls: await inlineRows() });
        const cur = (await r.crawls.get(run.id))!;
        await r.crawls.update({
          ...cur, ...out.stats, status: 'cancelled', outcome: 'cancelled', urlCount, finishedAt: iso(), durationMs: Date.now() - started,
          error: `Cancelled${cur.cancelledBy ? ` by ${cur.cancelledBy}` : ''} after ${out.stats.urlsCrawled ?? 0} pages. Results show what was fetched before cancelling; no issues were created or resolved from this partial crawl.`,
        });
        await persistRun(run.id, out.store, out.coverageReport).catch(() => undefined);
        await recordChanges(run.id, out);
        await out.cleanup?.();
        await audit(ctx, SYSTEM_ACTOR, 'crawl.cancelled', 'crawl', run.id, `${run.type} crawl cancelled after ${out.stats.urlsCrawled ?? 0} pages`);
        await db?.flush().catch(() => undefined);
        return;
      }
      if (out.failed) {
        // The crawler failed part-way: keep what it fetched, but never create or resolve issues from it.
        await r.crawlUrls.upsert({ id: run.id, urls: await inlineRows() });
        const cur = (await r.crawls.get(run.id))!;
        await r.crawls.update({ ...cur, ...out.stats, status: 'failed', outcome: 'failed', urlCount, finishedAt: iso(), durationMs: Date.now() - started, error: `${out.failed} ${out.stats.urlsCrawled ? `${out.stats.urlsCrawled} pages fetched before the failure are shown; no issues were created or resolved.` : ''}`.trim() });
        await persistRun(run.id, out.store, out.coverageReport).catch(() => undefined);
        await recordChanges(run.id, out);
        await out.cleanup?.();
        await ctx.integrations.recordSync?.('crawler', { ok: false, error: out.failed });
        await audit(ctx, SYSTEM_ACTOR, 'crawl.failed', 'crawl', run.id, `${run.type} crawl failed: ${out.failed}`);
        await db?.flush().catch(() => undefined);
        return;
      }
      await r.crawlUrls.upsert({ id: run.id, urls: await inlineRows() });
      if (out.sitemapDiff) await r.sitemapDiffs.upsert({ ...out.sitemapDiff, crawlRunId: run.id, id: run.id });
      if (out.snapshot) await r.crawlStates.upsert({ id: 'latest', runId: run.id, at: iso(), state: { ...(await r.crawlStates.get('latest'))?.state, ...out.snapshot } });
      await recordPages(out.store ?? out.urls, plan.tierOf);
      const stats = await issues.ingestFindings(run.id, { ...out, answeredUrls: out.answeredUrls });
      if (out.store) {
        out.store.setIssues(await issuesByUrl(startedIso), sameUrlKey);
        await r.crawlUrls.upsert({ id: run.id, urls: await inlineRows() });
      } else await r.crawlUrls.upsert({ id: run.id, urls: await attachIssues(out.urls, startedIso) });
      let ruleStats = { rules: 0, flagged: 0 };
      if (out.textsFile) {
        ruleStats = await applyRulesFromFile(out.textsFile, plan.tierOf);
      } else {
        // Stored page texts are read back only when a custom rule is enabled (50,000 large texts are not copied for nothing).
        const anyRule = (await r.rules.list()).some((x) => x.enabled);
        const texts = anyRule ? (out.pageTexts ?? []).map((p) => p.url) : [];
        const pageDocs: Awaited<ReturnType<typeof r.pageTexts.get>>[] = [];
        for (const u of texts) pageDocs.push(await r.pageTexts.get(u));
        if (anyRule) ruleStats = await rules.applyToPages(pageDocs.filter((x): x is NonNullable<typeof x> => !!x));
      }
      // Page rows and coverage report in the database (DATABASE_URL) before the run is reported as finished.
      let saveError: string | undefined;
      await persistRun(run.id, out.store, out.coverageReport).catch((e: Error) => { saveError = e.message; });
      await out.cleanup?.();
      const cur = (await r.crawls.get(run.id))!;
      const outcome = out.stats.outcome ?? (out.memoryStopped ? 'resource_stopped' : 'completed');
      const final: CrawlRun = {
        ...cur, ...out.stats, status: 'completed', outcome, urlCount, finishedAt: iso(), durationMs: Date.now() - started,
        ...(out.memoryStopped
          ? { error: out.stats.engine === 'go'
            ? `Stopped taking new pages after ${out.stats.urlsCrawled ?? 0} pages: ${out.stats.outcomeReason ?? 'the memory budget was reached'} The pages fetched were analysed normally; pages not fetched are listed as "not processed". Issues on pages that were not fetched are neither created nor resolved.`
            : `Stopped taking new pages after ${out.stats.urlsCrawled ?? 0} pages because the API server's memory was nearly full (limit ${heapLimitMb().toLocaleString('en-US')} MB). The pages fetched were analysed normally. The Go crawler (CRAWLER_ENGINE=go) keeps memory bounded on large sites.` }
          : outcome === 'partial' ? { error: `Partially completed: ${out.stats.outcomeReason ?? 'not every eligible URL was fetched'}` } : {}),
        newIssues: stats.newIssues, resolvedIssues: stats.resolvedIssues, recurringIssues: stats.recurringIssues,
        scope: [...(out.stats.scope ?? cur.scope), ...(stats.excludedUrls ? [{ label: 'URLs skipped by exclusions', count: stats.excludedUrls }] : []), { label: `Custom rules applied (${ruleStats.rules})`, count: ruleStats.flagged }],
      };
      if (saveError) final.warnings = [...(final.warnings ?? []), { code: 'database', message: `The page-level results could not be saved in the database (${saveError}); they are available until the server restarts. Issues, findings and the run itself are saved separately.`, at: iso() }];
      await r.crawls.update(final);
      await recordChanges(run.id, out);
      await ctx.integrations.recordSync?.('crawler', { ok: true });
      const m = await r.metrics.get();
      if (m.source !== 'demo') {
        m.siteSize = await r.sitePages.count();
        await r.metrics.set(m);
      }
      await audit(ctx, SYSTEM_ACTOR, 'crawl.complete', 'crawl', run.id, `${run.type} crawl completed: ${final.urlsCrawled} URLs, ${stats.newIssues} new / ${stats.resolvedIssues} resolved / ${stats.recurringIssues} recurring issues`);
      // Everything this crawl changed (run, issues, findings, page inventory, Health Score inputs) is stored before it ends.
      await db?.flush().catch((e: Error) => ctx.log.error({ runId: run.id, err: e.message }, 'crawl results are not saved in the database yet (retrying)'));
    } catch (e) {
      const msg = (e as Error).message;
      if (shuttingDown && !plan.signal?.aborted) {
        ctx.log.warn({ runId: run.id, err: msg }, 'crawl interrupted by server shutdown; it will be restarted when the server is back');
        return;
      }
      ctx.log.error({ runId: run.id, err: msg }, 'crawl failed');
      if (plan.signal?.aborted) {
        const cur = (await r.crawls.get(run.id)) ?? run;
        await r.crawls.update({ ...cur, status: 'cancelled', finishedAt: iso(), durationMs: Date.now() - started, error: `Cancelled${cur.cancelledBy ? ` by ${cur.cancelledBy}` : ''} before any page was fetched.` });
        return;
      }
      const cur = (await r.crawls.get(run.id)) ?? run;
      await r.crawls.update({ ...cur, status: 'failed', finishedAt: iso(), durationMs: Date.now() - started, error: msg });
      await ctx.integrations.recordSync?.('crawler', { ok: false, error: msg });
      const m = await r.metrics.get();
      m.errors.push({ id: `ERR-${run.id}`, at: iso(), level: 'error', component: 'crawler', message: `Crawl ${run.id} failed: ${msg}` });
      await r.metrics.set(m);
      await audit(ctx, SYSTEM_ACTOR, 'crawl.failed', 'crawl', run.id, `${run.type} crawl failed: ${msg}`);
    }
  }

  /** The plan of a crawl: its type plus the live-crawl settings (also used to start an interrupted crawl again). */
  async function planFor(type: CrawlType, options?: CrawlOptions): Promise<CrawlPlan> {
    const plan = await buildPlan(type);
    if (options) {
      // null = no limit: every page the site has / links at any depth.
      Object.assign(plan, {
        startUrl: options.startUrl, maxPages: options.maxPages ?? Number.POSITIVE_INFINITY, maxDepth: options.maxDepth ?? undefined,
        timeoutMs: options.timeoutMs, concurrency: options.concurrency, requestDelayMs: options.requestDelayMs, excludePatterns: options.excludePatterns,
      });
    }
    return plan;
  }

  /**
   * Runs a crawl as a server-side background job. Its lifetime belongs to the server: it is never tied to the HTTP
   * request that started it, to a browser tab or to anyone watching — only an explicit cancel (POST /cancel), the
   * crawl finishing or the server stopping ends it. `waitForSlot`: a restarted crawl waits for a free slot.
   */
  function launch(run: CrawlRun, plan: CrawlPlan, waitForSlot = false) {
    const ctrl = new AbortController();
    plan.signal = ctrl.signal;
    controllers.set(run.id, ctrl);
    const job = async () => {
      if (waitForSlot) {
        waitingJobs++;
        try {
          while (activeJobs >= ctx.env.CRAWLER_MAX_CONCURRENT_JOBS && !ctrl.signal.aborted && !shuttingDown) await new Promise((res) => setTimeout(res, 1000));
        } finally { waitingJobs--; }
        if (shuttingDown) return;
        if (ctrl.signal.aborted) {
          const cur = (await r.crawls.get(run.id)) ?? run;
          await r.crawls.update({ ...cur, status: 'cancelled', outcome: 'cancelled', finishedAt: iso(), error: `Cancelled${cur.cancelledBy ? ` by ${cur.cancelledBy}` : ''} before it started again.` });
          await db?.flush().catch(() => undefined);
          return;
        }
      }
      activeJobs++;
      try { await execute(run, plan); } finally { activeJobs = Math.max(0, activeJobs - 1); }
    };
    const p = job().finally(() => {
      running.delete(run.id);
      controllers.delete(run.id);
    });
    running.set(run.id, p);
  }

  /** One start at a time per website: a double click or a repeated request can never create a second crawl. */
  let starting = false;
  async function start(actor: Actor, type: CrawlType, trigger: CrawlRun['trigger'] = 'manual', options?: CrawlOptions): Promise<CrawlRun> {
    if (!['full', 'smart', 'reverify'].includes(type)) throw badRequest('Crawl type must be full, smart or reverify.');
    if (starting) throw alreadyRunning();
    starting = true;
    try {
      return await startOne(actor, type, trigger, options);
    } finally {
      starting = false;
    }
  }

  async function startOne(actor: Actor, type: CrawlType, trigger: CrawlRun['trigger'], options?: CrawlOptions): Promise<CrawlRun> {
    const activeRun = (await r.crawls.list()).find(isActive);
    if (activeRun) throw alreadyRunning(activeRun);
    const ready = ctx.engine.readiness();
    if (ready.ready && trigger !== 'schedule') {
      const why = await blockedReason();
      if (why) throw new ApiError(409, 'CRAWLER_NOT_READY', `The crawler cannot run: ${why}`);
    }
    if (ready.ready && activeJobs >= ctx.env.CRAWLER_MAX_CONCURRENT_JOBS) {
      throw new ApiError(429, 'CRAWL_CAPACITY', `${activeJobs} crawl${activeJobs === 1 ? ' is' : 's are'} already running on this server (limit ${ctx.env.CRAWLER_MAX_CONCURRENT_JOBS}). Try again when one finishes.`);
    }
    if (!ready.ready) {
      if (trigger === 'schedule') {
        const failed: CrawlRun = { id: await r.crawls.nextId('CRL'), type, status: 'failed', trigger, startedAt: iso(), finishedAt: iso(), urlsPlanned: 0, urlsCrawled: 0, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], error: `Crawler not ready: ${ready.reason}`, source: 'live' };
        await r.crawls.insert(failed);
        return failed;
      }
      throw new ApiError(409, 'CRAWLER_NOT_READY', `The crawler cannot run: ${ready.reason}`);
    }
    const plan = await planFor(type, options);
    const run: CrawlRun = {
      id: await r.crawls.nextId('CRL'), type, status: 'queued', trigger, startedAt: iso(), urlsPlanned: options ? 1 : plan.urls?.length ?? (Number.isFinite(plan.maxPages) ? plan.maxPages : 0), urlsCrawled: 0, urlsFailed: 0,
      urlsDiscovered: options ? 1 : undefined, urlsSucceeded: 0,
      jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0,
      scope: options
        ? [{ label: `Live crawl from ${options.startUrl} (${options.maxPages === null ? 'all pages' : `up to ${options.maxPages} pages`}, ${options.maxDepth === null ? 'any depth' : `depth ${options.maxDepth}`})`, count: options.maxPages ?? 0 }]
        : plan.urls ? Object.entries(plan.urls.reduce<Record<string, number>>((a, u) => ({ ...a, [u.reason]: (a[u.reason] ?? 0) + 1 }), {})).map(([label, count]) => ({ label, count })) : [{ label: `Full discovery from ${new URL(plan.baseUrl).host} (${Number.isFinite(plan.maxPages) ? `cap ${plan.maxPages}` : 'no page cap'})`, count: Number.isFinite(plan.maxPages) ? plan.maxPages : 0 }],
      options,
      // Shown while it runs; the crawler's final accounting replaces it.
      ...(type === 'smart' ? { smart: { budget: Math.min(ctx.env.CRAWLER_SMART_MAX_PAGES, SMART_CRAWL_PAGE_BUDGET), prioritized: plan.urls?.length ?? 0, notAudited: 0, basis: [] } } : {}),
      source: 'live',
    };
    for (const k of Object.keys(run) as (keyof CrawlRun)[]) if (run[k] === undefined) delete run[k];
    await r.crawls.insert(run);
    await audit(ctx, actor, 'crawl.start', 'crawl', run.id, `Started ${type} crawl of ${new URL(options?.startUrl ?? plan.baseUrl).host} (${trigger})${options ? ` — ${options.maxPages === null ? 'all pages' : `max ${options.maxPages} pages`}, ${options.maxDepth === null ? 'any depth' : `depth ${options.maxDepth}`}` : ''}`);
    // The run record (type, settings, trigger, progress) is the job's persistent state: with a database it is stored
    // (the request awaits the write) and an interrupted crawl is started again from it after a restart.
    launch(run, plan);
    return run;
  }

  async function detail(id: string): Promise<CrawlDetail> {
    const run = await r.crawls.get(id);
    if (!run) throw notFound(`Crawl ${id}`);
    const end = run.finishedAt ? new Date(new Date(run.finishedAt).getTime() + 86400_000).toISOString() : undefined;
    const verification = (await r.verifications.list()).filter((v) => v.method === 'automated_recrawl' && run.startedAt && v.at >= run.startedAt && (!end || v.at <= end));
    const diff = await r.sitemapDiffs.get(id);
    const store = await savedStore(id);
    // Large runs: the rows are paged on the server (getCrawlPages); the detail carries only the count.
    // Rows kept in the repository (built-in crawler, DEMO) are all returned, with their audit score and to-do checks.
    const rows = store ? await store.allIfSmall(CRAWL_DETAIL_ROW_LIMIT) : await (await storeOf(id)).allIfSmall(Number.MAX_SAFE_INTEGER);
    const urlCount = store ? store.count() : rows?.length ?? 0;
    return {
      run, urls: rows ?? [], urlCount, urlsPaged: !rows, sitemapDiff: diff ? (({ id: _id, ...rest }) => rest)(diff) : undefined, verification,
    };
  }

  return {
    start,
    /**
     * Start-up with a database: a crawl stored as running / queued was interrupted by a restart (its process is gone).
     * It is started again automatically under the same id with the same settings (type, start URL, limits, exclusions) —
     * from the beginning, because page-level checkpoints are not kept; nothing from the interrupted attempt became issues.
     * When it cannot be restarted (turned off, restarted too often, crawler not ready) it is marked failed with the reason.
     * Never marked completed.
     */
    async resumeInterrupted(): Promise<{ resumed: string[]; failed: string[] }> {
      const res = { resumed: [] as string[], failed: [] as string[] };
      const max = ctx.env.CRAWLER_RESUME_MAX_ATTEMPTS;
      for (const c of await r.crawls.list()) {
        if (!isActive(c) || running.has(c.id)) continue;
        const attempts = c.resume?.attempts ?? 0;
        const pages = c.urlsCrawled ?? 0;
        let why: string | undefined;
        if (!ctx.env.CRAWLER_RESUME_INTERRUPTED) why = 'automatic restart is turned off (CRAWLER_RESUME_INTERRUPTED=false).';
        else if (c.source !== 'live') why = 'only live crawls are restarted.';
        else if (attempts >= max) why = `it had already been restarted ${attempts} time${attempts === 1 ? '' : 's'} after earlier interruptions (limit CRAWLER_RESUME_MAX_ATTEMPTS=${max}).`;
        else {
          const ready = ctx.engine.readiness();
          why = ready.ready ? await blockedReason() : `the crawler cannot run: ${ready.reason}`;
        }
        let plan: CrawlPlan | undefined;
        if (!why) {
          try { plan = await planFor(c.type, c.options); } catch (e) { why = (e as Error).message; }
        }
        if (why || !plan) {
          await r.crawls.update({
            ...c, status: 'failed', outcome: 'failed', finishedAt: iso(), phase: undefined,
            error: `The server restarted while this crawl was running (${pages} pages fetched), so it could not finish, and it was not started again: ${why} No issues were created or resolved from it; the last completed audit is unchanged. Start the crawl again.`,
          });
          res.failed.push(c.id);
          continue;
        }
        const at = iso();
        const next: CrawlRun = {
          ...c, status: 'queued', phase: undefined, outcome: undefined, error: undefined, finishedAt: undefined, durationMs: undefined,
          urlsCrawled: 0, urlsFailed: 0, urlsSucceeded: 0, urlsDiscovered: c.options ? 1 : undefined, coverage: undefined, memory: undefined, politeness: undefined,
          resume: { attempts: attempts + 1, lastAt: at, firstStartedAt: c.resume?.firstStartedAt ?? c.startedAt, pagesBeforeRestart: pages },
          warnings: [...(c.warnings ?? []), {
            code: 'resumed', at,
            message: `The server restarted while this crawl was running (after ${pages} pages), so it was started again automatically with the same settings (restart ${attempts + 1} of at most ${max}). It starts from the beginning — page-level checkpoints are not kept — and issues are updated only when it finishes.`,
          }].slice(-20),
        };
        for (const k of Object.keys(next) as (keyof CrawlRun)[]) if (next[k] === undefined) delete next[k];
        await r.crawls.update(next);
        await audit(ctx, SYSTEM_ACTOR, 'crawl.resume', 'crawl', c.id, `${c.type} crawl ${c.id} started again after a server restart (restart ${attempts + 1} of ${max}; ${pages} pages had been fetched)`);
        await db?.flush().catch(() => undefined);
        launch(next, plan, true);
        res.resumed.push(c.id);
      }
      return res;
    },
    /** Image references of a crawl still on this server (Image Audit input). */
    imageRefsOf(id: string) { const r = imageRefs.get(id); return r ? { file: r.file, checkedFile: r.checkedFile } : undefined; },
    /** Finished crawls whose image references are still here, newest first. */
    async runsWithImageRefs(): Promise<CrawlRun[]> {
      const out: CrawlRun[] = [];
      for (const id of imageRefs.keys()) { const run = await r.crawls.get(id); if (run && run.status !== 'running' && run.status !== 'queued') out.push(run); }
      return out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
    },
    /** Await in-flight crawls (tests / graceful shutdown). */
    async idle() { await Promise.all([...running.values()]); },

    async list(actor: Actor) {
      await need(ctx, actor, 'crawls.view');
      return (await r.crawls.list()).sort((a, b) => (b.startedAt ?? b.scheduledFor ?? '').localeCompare(a.startedAt ?? a.scheduledFor ?? ''));
    },
    async get(actor: Actor, id: string) {
      await need(ctx, actor, 'crawls.view');
      return detail(id);
    },
    /** Start a crawl. A live crawl from the Crawl Center passes options (type 'full'); they are validated against this website. */
    async startManual(actor: Actor, type: CrawlType, rawOptions?: unknown) {
      await need(ctx, actor, 'crawls.run');
      // Configuration first: without a configured website (CRAWLER_BASE_URL) or with live crawling off, the start URL
      // cannot be checked against an allowed website, so the request is refused with the fix rather than validated
      // against the built-in display default.
      const ready = ctx.engine.readiness();
      if (!ready.ready) throw new ApiError(409, 'CRAWLER_NOT_READY', `The crawler cannot run: ${ready.reason}`);
      const options = rawOptions === undefined || rawOptions === null ? undefined : validateCrawlOptions(rawOptions, await siteUrl(), ctx.env.CRAWLER_MAX_PAGES);
      if (options && type !== 'full') throw badRequest('Crawl settings apply to a live (full) crawl only.');
      return start(actor, type, 'manual', options);
    },
    async cancel(actor: Actor, id: string) {
      await need(ctx, actor, 'crawls.run');
      const run = await r.crawls.get(id);
      if (!run) throw notFound(`Crawl ${id}`);
      const ctrl = controllers.get(id);
      if (!ctrl || !isActive(run)) throw conflict(`Crawl ${id} is ${run.status}, so it cannot be cancelled.`, 'NOT_RUNNING');
      await r.crawls.update({ ...run, cancelledBy: actor.name });
      ctrl.abort();
      await audit(ctx, actor, 'crawl.cancel', 'crawl', id, `Cancelled ${run.type} crawl ${id}`);
      await running.get(id)?.catch(() => undefined);
      return (await r.crawls.get(id))!;
    },
    async status(actor: Actor): Promise<CrawlerStatus> {
      await need(ctx, actor, 'crawls.view');
      const why = await blockedReason();
      const cfg = await r.config.get();
      return {
        ready: !why, reason: why, siteUrl: await siteUrl(), maxPagesCap: ctx.env.CRAWLER_MAX_PAGES ?? null, smartPageBudget: Math.min(ctx.env.CRAWLER_SMART_MAX_PAGES, SMART_CRAWL_PAGE_BUDGET), temporaryStorage: r.storage.persistent === false,
        schedulerEnabled: ctx.env.SCHEDULER_ENABLED, respectsRobots: cfg.crawl.respectRobots, requestDelayMs: ctx.env.CRAWLER_REQUEST_DELAY_MS, maxBodyBytes: ctx.env.CRAWLER_MAX_BODY_BYTES,
        ...(ctx.engineInfo ? { engine: ctx.engineInfo() } : {}),
      };
    },
    /**
     * CSV / JSON export. Large runs are streamed row by row from the result store (`stream`), so exporting 50,000 pages
     * never builds the whole file in memory.
     */
    async exportResults(actor: Actor, id: string, format: string): Promise<{ filename: string; mimeType: string; content?: string; stream?: AsyncIterable<string> }> {
      await need(ctx, actor, 'crawls.view');
      if (format !== 'csv' && format !== 'json') throw badRequest('Export format must be csv or json.');
      const d = await detail(id);
      const store = await savedStore(id);
      if (!store || !d.urlsPaged) {
        return format === 'csv'
          ? { filename: crawlExportFilename(d, 'csv'), mimeType: 'text/csv; charset=utf-8', content: crawlResultsCsv(d) }
          : { filename: crawlExportFilename(d, 'json'), mimeType: 'application/json; charset=utf-8', content: crawlResultsJson(d, iso()) };
      }
      const first = (await store.query({ limit: 1 })).rows[0];
      const named = { ...d, urls: first ? [first] : [] };
      const exportedAt = iso();
      /** Rows joined in ~256 KB chunks, pulled from the store at the pace the client downloads. */
      async function* rows(): AsyncGenerator<string> {
        let buf = '';
        let first = true;
        for await (const u of store!.iterate()) {
          buf += format === 'csv' ? crawlCsvRow(u) : `${first ? '' : ','}${JSON.stringify(u)}`;
          first = false;
          if (buf.length >= 256 * 1024) { yield buf; buf = ''; }
        }
        if (buf) yield buf;
      }
      async function* csv(): AsyncGenerator<string> {
        yield crawlCsvHeader();
        yield* rows();
      }
      async function* json(): AsyncGenerator<string> {
        yield `{"note":${JSON.stringify(CRAWL_EXPORT_NOTE)},"exportedAt":${JSON.stringify(exportedAt)},"run":${JSON.stringify(d.run)},"pages":[`;
        yield* rows();
        yield `],"sitemapDiff":${JSON.stringify(d.sitemapDiff ?? null)}}`;
      }
      return format === 'csv'
        ? { filename: crawlExportFilename(named, 'csv'), mimeType: 'text/csv; charset=utf-8', stream: csv() }
        : { filename: crawlExportFilename(named, 'json'), mimeType: 'application/json; charset=utf-8', stream: json() };
    },
    /** One page of a crawl's page rows, searched / filtered / sorted on the server, with facet counts. */
    async pages(actor: Actor, id: string, q: CrawlPagesQuery): Promise<CrawlPagesResponse> {
      await need(ctx, actor, 'crawls.view');
      if (!(await r.crawls.get(id))) throw notFound(`Crawl ${id}`);
      return (await storeOf(id)).query(q);
    },
    /**
     * One URL of a crawl with its page audit (the page report). `id` may be "latest": the newest completed or cancelled
     * crawl that still has page rows on this server.
     */
    async page(actor: Actor, id: string, url: string): Promise<CrawlPageReport> {
      await need(ctx, actor, 'crawls.view');
      if (!url) throw badRequest('url is required.');
      let run = id === 'latest' ? undefined : await r.crawls.get(id);
      if (id === 'latest') {
        // A cancelled or failed crawl never stands in for the latest valid audit.
        const runs = (await r.crawls.list()).filter((c) => c.status === 'completed' && c.source !== 'simulated' && c.type !== 'reverify')
          .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
        run = runs[0];
      }
      if (!run) throw notFound(id === 'latest' ? 'A finished crawl' : `Crawl ${id}`);
      const key = sameUrlKey(url);
      let path = url;
      try { path = new URL(url).pathname; } catch { /* keep */ }
      const store = await storeOf(run.id);
      const res = await store.query({ q: path === '/' ? url : path, limit: 500 });
      const row = res.rows.find((x) => sameUrlKey(x.url) === key);
      if (!row) throw notFound(`${url} in crawl ${run.id}`);
      const limits = res.auditLimits ?? auditLimitsFrom((await r.config.get()).thresholds as unknown as Record<string, number>);
      return { runId: run.id, crawledAt: run.startedAt, row, audit: auditPage(row, limits), limits, duplicates: await store.duplicatesOf(row.url) };
    },
    /**
     * The newest fetched row for one URL across the completed crawls this server still has (SEO editor: H1 source,
     * current issues). Internal — callers check their own permissions.
     */
    async latestRow(url: string): Promise<{ row: CrawledUrl; runId: string; at?: string } | undefined> {
      const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
      const want = norm(url);
      let path = want;
      try { path = new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { /* keep */ }
      const runs = (await r.crawls.list()).filter((c) => c.status === 'completed' || c.status === 'cancelled')
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      for (const run of runs.slice(0, 5)) {
        const res = await (await storeOf(run.id)).query({ q: path, limit: 200 });
        const row = res.rows.find((x) => norm(x.url) === want && x.status !== null && (x.crawlState ?? 'fetched') === 'fetched');
        if (row) return { row, runId: run.id, at: run.finishedAt ?? run.startedAt };
      }
      return undefined;
    },
    /** What the crawl found, crawled, failed, excluded, and where sitemap and link graph disagree. */
    async coverage(actor: Actor, id: string): Promise<CrawlCoverageReport> {
      await need(ctx, actor, 'crawls.view');
      const run = await r.crawls.get(id);
      if (!run) throw notFound(`Crawl ${id}`);
      if (!coverageReports.has(id)) await savedStore(id);
      const c = coverageReports.get(id);
      if (c) return { ...c, counts: { ...(run.coverage ?? {}) as unknown as Record<string, number>, ...c.counts }, excludedBy: run.coverage?.excludedBy ?? c.excludedBy };
      return {
        available: false,
        note: run.engine === 'go' ? 'The coverage report of this crawl is no longer kept on this server (only the most recent crawls are).' : 'Coverage reports are produced by the Go crawler. This crawl ran on the built-in crawler.',
        counts: {}, excludedBy: {}, foundVia: {}, listLimit: 0, sitemapNotCrawled: { count: 0, urls: [] }, linkedNotInSitemap: { count: 0, urls: [] },
        orphanCandidates: { count: 0, urls: [], evaluated: false }, failed: { count: 0, urls: [] }, redirects: { count: 0, urls: [] }, variantGroups: { count: 0, groups: [] },
        duplicates: { titles: { count: 0, groups: [] }, metaDescriptions: { count: 0, groups: [] }, exactContent: { count: 0, groups: [] }, nearContent: { count: 0, groups: [], threshold: 0.9 } },
        notProcessed: { count: 0, urls: [] },
      };
    },
    async listSchedules(actor: Actor) {
      await need(ctx, actor, 'crawls.view');
      return r.schedules.list();
    },
    async updateSchedule(actor: Actor, id: string, input: { cron?: string; enabled?: boolean }) {
      await need(ctx, actor, 'crawls.configure');
      const sc = await r.schedules.get(id);
      if (!sc) throw notFound('Schedule');
      if (input.cron !== undefined) {
        if (!validCron(input.cron)) throw badRequest('Cron must have 5 valid fields: minute hour day-of-month month day-of-week.');
        sc.cron = input.cron.trim().replace(/\s+/g, ' ');
      }
      if (input.enabled !== undefined) sc.enabled = !!input.enabled;
      await r.schedules.update(sc);
      await audit(ctx, actor, 'crawl.schedule_update', 'crawl', id, `Schedule ${sc.type}: ${sc.cron} IST (${sc.enabled ? 'enabled' : 'disabled'})`);
      return sc;
    },
    async listVerifications(actor: Actor) {
      await need(ctx, actor, 'crawls.view');
      return (await r.verifications.list()).sort((a, b) => b.at.localeCompare(a.at));
    },
    /** Shopify products/update webhook → mark page changed so the next smart crawl includes it (PDF §16). */
    async markChanged(urls: string[]) {
      for (const u of urls) {
        const p = (await r.sitePages.where({ url: u }))[0];
        if (p) await r.sitePages.update({ ...p, lastModified: iso() });
        else {
          let path = u;
          try { path = new URL(u).pathname; } catch { continue; }
          await r.sitePages.insert({ id: `page:${u}`, url: u, path, template: templateOfPath(path), title: path, tier: 3, tierReason: 'Seen via Shopify webhook', indexable: true, lastModified: iso(), source: 'live' });
        }
      }
    },
  };
}
export type CrawlService = ReturnType<typeof createCrawlService>;
