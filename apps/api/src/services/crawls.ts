import {
  crawlExportFilename, crawlResultsCsv, crawlResultsJson, validateCrawlOptions,
  type CrawlDetail, type CrawlerStatus, type CrawlOptions, type CrawlRun, type CrawlType, type CrawledUrl, type CrawledUrlIssue, type PageTemplate, type SitePage,
} from '@sentinel/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { ApiError } from '../lib/errors';
import { audit, need, SYSTEM_ACTOR, type Actor, type Ctx } from './context';
import type { IssueService } from './issues';
import type { CrawlPlan } from './ports';
import type { RuleService } from './rules';
import { heapLimitMb } from '../crawler/memory';

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
/** Least time between two progress writes of one crawl (the progress panel polls every few seconds). */
const PROGRESS_WRITE_MS = 500;

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

export function createCrawlService(ctx: Ctx, issues: IssueService, rules: RuleService) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();
  const running = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();

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
    return { type, baseUrl, previous: prev, urls: dedup, maxPages: dedup.length + 50, tierOf };
  }

  async function recordPages(urls: CrawledUrl[], tierOf: (u: string) => SitePage['tier']) {
    // One read of the page inventory (a lookup per URL would copy the whole inventory for every one of 50,000 pages).
    const known = new Map<string, SitePage>();
    for (const p of await r.sitePages.list()) if (!known.has(p.url)) known.set(p.url, p);
    for (const u of urls) {
      if (u.status === null) continue;
      let path = u.url;
      try { path = new URL(u.url).pathname; } catch { continue; }
      const prev = known.get(u.url);
      const page: SitePage = {
        id: prev?.id ?? `page:${u.url}`, url: u.url, path, template: templateOfPath(path), title: prev?.title ?? path, tier: tierOf(u.url),
        tierReason: prev?.tierReason ?? (path === '/' ? 'Homepage' : 'Default Tier 3 until GA4/Shopify value data is connected'),
        indexable: u.status === 200, lastModified: prev?.lastModified, revenue90d: prev?.revenue90d, organicSessions90d: prev?.organicSessions90d,
        impressions28d: prev?.impressions28d, clicks28d: prev?.clicks28d, source: 'live',
      };
      await r.sitePages.upsert(page);
    }
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
        if (!v) return;
        const [crawled, failed, discovered, succeeded, politeness] = v;
        lastWrite = Date.now();
        const cur = await r.crawls.get(run.id);
        if (cur && (cur.status === 'running' || cur.status === 'queued')) {
          await r.crawls.update({
            ...cur, urlsCrawled: crawled, urlsFailed: failed, urlsDiscovered: discovered, urlsSucceeded: succeeded,
            urlsPlanned: Math.max(cur.urlsPlanned, Math.min(discovered, plan.maxPages)), ...(politeness ? { politeness } : {}),
          });
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
      if (out.cancelled) {
        // Partial crawl: keep the page results; never ingest findings (missing pages would wrongly resolve issues).
        await r.crawlUrls.upsert({ id: run.id, urls: out.urls });
        const cur = (await r.crawls.get(run.id))!;
        await r.crawls.update({
          ...cur, ...out.stats, status: 'cancelled', finishedAt: iso(), durationMs: Date.now() - started,
          error: `Cancelled${cur.cancelledBy ? ` by ${cur.cancelledBy}` : ''} after ${out.stats.urlsCrawled ?? 0} pages. Results show what was fetched before cancelling; no issues were created or resolved from this partial crawl.`,
        });
        await audit(ctx, SYSTEM_ACTOR, 'crawl.cancelled', 'crawl', run.id, `${run.type} crawl cancelled after ${out.stats.urlsCrawled ?? 0} pages`);
        return;
      }
      await r.crawlUrls.upsert({ id: run.id, urls: out.urls });
      if (out.sitemapDiff) await r.sitemapDiffs.upsert({ ...out.sitemapDiff, crawlRunId: run.id, id: run.id });
      if (out.snapshot) await r.crawlStates.upsert({ id: 'latest', runId: run.id, at: iso(), state: { ...(await r.crawlStates.get('latest'))?.state, ...out.snapshot } });
      await recordPages(out.urls, plan.tierOf);
      const stats = await issues.ingestFindings(run.id, out);
      await r.crawlUrls.upsert({ id: run.id, urls: await attachIssues(out.urls, startedIso) });
      // Stored page texts are read back only when a custom rule is enabled (50,000 large texts are not copied for nothing).
      const anyRule = (await r.rules.list()).some((x) => x.enabled);
      const texts = anyRule ? (out.pageTexts ?? []).map((p) => p.url) : [];
      const pageDocs: Awaited<ReturnType<typeof r.pageTexts.get>>[] = [];
      for (const u of texts) pageDocs.push(await r.pageTexts.get(u));
      const ruleStats = anyRule ? await rules.applyToPages(pageDocs.filter((x): x is NonNullable<typeof x> => !!x)) : { rules: 0, flagged: 0 };
      const cur = (await r.crawls.get(run.id))!;
      const final: CrawlRun = {
        ...cur, ...out.stats, status: 'completed', finishedAt: iso(), durationMs: Date.now() - started,
        ...(out.memoryStopped ? { error: `Stopped taking new pages after ${out.stats.urlsCrawled ?? 0} pages because the API server's memory was nearly full (limit ${heapLimitMb().toLocaleString('en-US')} MB). The pages fetched were analysed normally. To crawl more pages, start the API with more memory (see LOCAL_CRAWLING.md).` } : {}),
        newIssues: stats.newIssues, resolvedIssues: stats.resolvedIssues, recurringIssues: stats.recurringIssues,
        scope: [...(out.stats.scope ?? cur.scope), ...(stats.excludedUrls ? [{ label: 'URLs skipped by exclusions', count: stats.excludedUrls }] : []), { label: `Custom rules applied (${ruleStats.rules})`, count: ruleStats.flagged }],
      };
      await r.crawls.update(final);
      await ctx.integrations.recordSync?.('crawler', { ok: true });
      const m = await r.metrics.get();
      if (m.source !== 'demo') {
        m.siteSize = await r.sitePages.count();
        await r.metrics.set(m);
      }
      await audit(ctx, SYSTEM_ACTOR, 'crawl.complete', 'crawl', run.id, `${run.type} crawl completed: ${final.urlsCrawled} URLs, ${stats.newIssues} new / ${stats.resolvedIssues} resolved / ${stats.recurringIssues} recurring issues`);
    } catch (e) {
      const msg = (e as Error).message;
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

  async function start(actor: Actor, type: CrawlType, trigger: CrawlRun['trigger'] = 'manual', options?: CrawlOptions): Promise<CrawlRun> {
    if (!['full', 'smart', 'reverify'].includes(type)) throw badRequest('Crawl type must be full, smart or reverify.');
    if ((await r.crawls.list()).some((c) => c.status === 'running' || c.status === 'queued')) throw conflict('A crawl is already running for this website. Wait for it to finish or cancel it.');
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
    const plan = await buildPlan(type);
    if (options) {
      // null = no limit: every page the site has / links at any depth.
      Object.assign(plan, {
        startUrl: options.startUrl, maxPages: options.maxPages ?? Number.POSITIVE_INFINITY, maxDepth: options.maxDepth ?? undefined,
        timeoutMs: options.timeoutMs, concurrency: options.concurrency, requestDelayMs: options.requestDelayMs,
      });
    }
    const ctrl = new AbortController();
    plan.signal = ctrl.signal;
    const run: CrawlRun = {
      id: await r.crawls.nextId('CRL'), type, status: 'queued', trigger, startedAt: iso(), urlsPlanned: options ? 1 : plan.urls?.length ?? plan.maxPages, urlsCrawled: 0, urlsFailed: 0,
      urlsDiscovered: options ? 1 : undefined, urlsSucceeded: 0,
      jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0,
      scope: options
        ? [{ label: `Live crawl from ${options.startUrl} (${options.maxPages === null ? 'all pages' : `up to ${options.maxPages} pages`}, ${options.maxDepth === null ? 'any depth' : `depth ${options.maxDepth}`})`, count: options.maxPages ?? 0 }]
        : plan.urls ? Object.entries(plan.urls.reduce<Record<string, number>>((a, u) => ({ ...a, [u.reason]: (a[u.reason] ?? 0) + 1 }), {})).map(([label, count]) => ({ label, count })) : [{ label: `Full discovery from ${new URL(plan.baseUrl).host} (cap ${plan.maxPages})`, count: plan.maxPages }],
      options,
      source: 'live',
    };
    for (const k of Object.keys(run) as (keyof CrawlRun)[]) if (run[k] === undefined) delete run[k];
    await r.crawls.insert(run);
    await audit(ctx, actor, 'crawl.start', 'crawl', run.id, `Started ${type} crawl of ${new URL(options?.startUrl ?? plan.baseUrl).host} (${trigger})${options ? ` — ${options.maxPages === null ? 'all pages' : `max ${options.maxPages} pages`}, ${options.maxDepth === null ? 'any depth' : `depth ${options.maxDepth}`}` : ''}`);
    activeJobs++;
    controllers.set(run.id, ctrl);
    const p = execute(run, plan).finally(() => {
      activeJobs = Math.max(0, activeJobs - 1);
      running.delete(run.id);
      controllers.delete(run.id);
    });
    running.set(run.id, p);
    return run;
  }

  async function detail(id: string): Promise<CrawlDetail> {
    const run = await r.crawls.get(id);
    if (!run) throw notFound(`Crawl ${id}`);
    const end = run.finishedAt ? new Date(new Date(run.finishedAt).getTime() + 86400_000).toISOString() : undefined;
    const verification = (await r.verifications.list()).filter((v) => v.method === 'automated_recrawl' && run.startedAt && v.at >= run.startedAt && (!end || v.at <= end));
    const diff = await r.sitemapDiffs.get(id);
    return { run, urls: (await r.crawlUrls.get(id))?.urls ?? [], sitemapDiff: diff ? (({ id: _id, ...rest }) => rest)(diff) : undefined, verification };
  }

  return {
    start,
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
      const options = rawOptions === undefined || rawOptions === null ? undefined : validateCrawlOptions(rawOptions, await siteUrl(), ctx.env.CRAWLER_MAX_PAGES);
      if (options && type !== 'full') throw badRequest('Crawl settings apply to a live (full) crawl only.');
      return start(actor, type, 'manual', options);
    },
    async cancel(actor: Actor, id: string) {
      await need(ctx, actor, 'crawls.run');
      const run = await r.crawls.get(id);
      if (!run) throw notFound(`Crawl ${id}`);
      const ctrl = controllers.get(id);
      if (!ctrl || (run.status !== 'running' && run.status !== 'queued')) throw conflict(`Crawl ${id} is ${run.status}, so it cannot be cancelled.`, 'NOT_RUNNING');
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
        ready: !why, reason: why, siteUrl: await siteUrl(), maxPagesCap: ctx.env.CRAWLER_MAX_PAGES ?? null, temporaryStorage: r.storage.persistent === false,
        schedulerEnabled: ctx.env.SCHEDULER_ENABLED, respectsRobots: cfg.crawl.respectRobots, requestDelayMs: ctx.env.CRAWLER_REQUEST_DELAY_MS, maxBodyBytes: ctx.env.CRAWLER_MAX_BODY_BYTES,
      };
    },
    async exportResults(actor: Actor, id: string, format: string) {
      await need(ctx, actor, 'crawls.view');
      if (format !== 'csv' && format !== 'json') throw badRequest('Export format must be csv or json.');
      const d = await detail(id);
      return format === 'csv'
        ? { filename: crawlExportFilename(d, 'csv'), mimeType: 'text/csv; charset=utf-8', content: crawlResultsCsv(d) }
        : { filename: crawlExportFilename(d, 'json'), mimeType: 'application/json; charset=utf-8', content: crawlResultsJson(d, iso()) };
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
