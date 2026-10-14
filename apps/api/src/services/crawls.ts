import type { CrawlRun, CrawlType, CrawledUrl, PageTemplate, SitePage } from '@sentinel/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { ApiError } from '../lib/errors';
import { audit, need, SYSTEM_ACTOR, type Actor, type Ctx } from './context';
import type { IssueService } from './issues';
import type { CrawlPlan } from './ports';
import type { RuleService } from './rules';

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
export function createCrawlService(ctx: Ctx, issues: IssueService, rules: RuleService) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();
  const running = new Map<string, Promise<void>>();

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
    if (type === 'full') return { type, baseUrl, previous: prev, maxPages: ctx.env.CRAWLER_MAX_PAGES, tierOf };
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
    for (const u of urls) {
      if (u.status === null) continue;
      let path = u.url;
      try { path = new URL(u.url).pathname; } catch { continue; }
      const prev = (await r.sitePages.where({ url: u.url }))[0];
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
    try {
      const out = await ctx.engine.run(plan, async (crawled, failed) => {
        const cur = await r.crawls.get(run.id);
        if (cur) await r.crawls.update({ ...cur, urlsCrawled: crawled, urlsFailed: failed });
      });
      await r.crawlUrls.upsert({ id: run.id, urls: out.urls });
      if (out.sitemapDiff) await r.sitemapDiffs.upsert({ ...out.sitemapDiff, crawlRunId: run.id, id: run.id });
      if (out.snapshot) await r.crawlStates.upsert({ id: 'latest', runId: run.id, at: iso(), state: { ...(await r.crawlStates.get('latest'))?.state, ...out.snapshot } });
      await recordPages(out.urls, plan.tierOf);
      const stats = await issues.ingestFindings(run.id, out);
      const texts = (out.pageTexts ?? []).map((p) => p.url);
      const pageDocs = (await Promise.all(texts.map((u) => r.pageTexts.get(u)))).filter((x): x is NonNullable<typeof x> => !!x);
      const ruleStats = await rules.applyToPages(pageDocs);
      const cur = (await r.crawls.get(run.id))!;
      const final: CrawlRun = {
        ...cur, ...out.stats, status: 'completed', finishedAt: iso(), durationMs: Date.now() - started,
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
      const cur = (await r.crawls.get(run.id)) ?? run;
      await r.crawls.update({ ...cur, status: 'failed', finishedAt: iso(), durationMs: Date.now() - started, error: msg });
      await ctx.integrations.recordSync?.('crawler', { ok: false, error: msg });
      const m = await r.metrics.get();
      m.errors.push({ id: `ERR-${run.id}`, at: iso(), level: 'error', component: 'crawler', message: `Crawl ${run.id} failed: ${msg}` });
      await r.metrics.set(m);
      await audit(ctx, SYSTEM_ACTOR, 'crawl.failed', 'crawl', run.id, `${run.type} crawl failed: ${msg}`);
    }
  }

  async function start(actor: Actor, type: CrawlType, trigger: CrawlRun['trigger'] = 'manual'): Promise<CrawlRun> {
    if (!['full', 'smart', 'reverify'].includes(type)) throw badRequest('Crawl type must be full, smart or reverify.');
    if ((await r.crawls.list()).some((c) => c.status === 'running' || c.status === 'queued')) throw conflict('A crawl is already running. Wait for it to finish.');
    const ready = ctx.engine.readiness();
    if (!ready.ready) {
      if (trigger === 'schedule') {
        const failed: CrawlRun = { id: await r.crawls.nextId('CRL'), type, status: 'failed', trigger, startedAt: iso(), finishedAt: iso(), urlsPlanned: 0, urlsCrawled: 0, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], error: `Crawler not ready: ${ready.reason}`, source: 'live' };
        await r.crawls.insert(failed);
        return failed;
      }
      throw new ApiError(409, 'CRAWLER_NOT_READY', `The crawler cannot run: ${ready.reason}`);
    }
    const plan = await buildPlan(type);
    const run: CrawlRun = {
      id: await r.crawls.nextId('CRL'), type, status: 'running', trigger, startedAt: iso(), urlsPlanned: plan.urls?.length ?? plan.maxPages, urlsCrawled: 0, urlsFailed: 0,
      jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0,
      scope: plan.urls ? Object.entries(plan.urls.reduce<Record<string, number>>((a, u) => ({ ...a, [u.reason]: (a[u.reason] ?? 0) + 1 }), {})).map(([label, count]) => ({ label, count })) : [{ label: `Full discovery from ${new URL(plan.baseUrl).host} (cap ${plan.maxPages})`, count: plan.maxPages }],
      source: 'live',
    };
    await r.crawls.insert(run);
    await audit(ctx, actor, 'crawl.start', 'crawl', run.id, `Started ${type} crawl of ${new URL(plan.baseUrl).host} (${trigger})`);
    const p = execute(run, plan).finally(() => running.delete(run.id));
    running.set(run.id, p);
    return run;
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
      const run = await r.crawls.get(id);
      if (!run) throw notFound(`Crawl ${id}`);
      const end = run.finishedAt ? new Date(new Date(run.finishedAt).getTime() + 86400_000).toISOString() : undefined;
      const verification = (await r.verifications.list()).filter((v) => v.method === 'automated_recrawl' && run.startedAt && v.at >= run.startedAt && (!end || v.at <= end));
      const diff = await r.sitemapDiffs.get(id);
      return { run, urls: (await r.crawlUrls.get(id))?.urls ?? [], sitemapDiff: diff ? (({ id: _id, ...rest }) => rest)(diff) : undefined, verification };
    },
    async startManual(actor: Actor, type: CrawlType) {
      await need(ctx, actor, 'crawls.run');
      return start(actor, type, 'manual');
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
