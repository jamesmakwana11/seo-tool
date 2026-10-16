import { createHmac } from 'node:crypto';
import path from 'node:path';
import { defaultConfig, setPriorityConfig } from '@sentinel/shared';
import type { Env } from './config/env';
import { createLogger, type Logger } from './lib/logger';
import { hashPassword, passwordPolicyError, randomToken } from './lib/passwords';
import { createInMemoryRepositories } from './repositories/memory/inMemory';
import { seedDemoData } from './repositories/seedDemo';
import type { Repositories } from './repositories/types';
import { createCrawlEngine, type CrawlEngineOptions } from './crawler/engine';
import { cleanStaleWork, createGoCrawlEngine, defaultWorkDir } from './gocrawl/engine';
import { memoryPlan } from './gocrawl/memoryBudget';
import { createLighthouseService } from './lighthouse/service';
import { createShopifyService } from './shopify/service';
import { isLocalHost } from './crawler/url';
import { createReverifier } from './analysis/reverify';
import { createConnectors, createDeliveryAdapters, createDeliveryService, createIntegrationRegistry, createLlmAdapter, createTaskOpsAdapter, type FetchLike, type MailTransportFactory } from './connectors';
import type { RetryPolicy } from './notifications/delivery';
import type { Ctx } from './services/context';
import type { CrawlEngine, Reverifier } from './services/ports';
import { createAuthService } from './services/auth';
import { createTaskService } from './services/tasks';
import { createIssueService } from './services/issues';
import { createRuleService } from './services/rules';
import { createCrawlService } from './services/crawls';
import { createChangeService, urlKey } from './changes/service';
import { createCaptureService } from './changes/capture';
import { safeName } from './changes/store';
import { createReportService } from './services/reports';
import { createInsightService } from './services/insights';
import { createAdminService, type DiagnosticsSource } from './services/admin';
import { createScheduler } from './jobs/scheduler';
import { runEscalations } from './jobs/escalation';

export interface ContainerOptions {
  env: Env;
  repos?: Repositories;
  log?: Logger;
  clock?: () => Date;
  /** Injected for tests: every outbound HTTP call (connectors, delivery, Task Ops, LLM, crawler). */
  fetchImpl?: FetchLike;
  mailTransport?: MailTransportFactory;
  retry?: RetryPolicy;
  /** Override the crawl engine / reverifier (tests). */
  engine?: CrawlEngine;
  reverifier?: Reverifier;
  diagnostics?: DiagnosticsSource;
}

/** Composition root: wires repositories (in-memory, Phase 2) → adapters → services. No storage implementation leaks into services. */
export async function createContainer(o: ContainerOptions) {
  const env = o.env;
  const log = o.log ?? createLogger(env.LOG_LEVEL);
  const clock = o.clock ?? (() => new Date());
  const repos = o.repos ?? createInMemoryRepositories(clock());
  let seeded: Awaited<ReturnType<typeof seedDemoData>> | undefined;
  if (!o.repos && env.SEED_DEMO_DATA) seeded = await seedDemoData(repos, clock());
  if (!o.repos && !env.SEED_DEMO_DATA) {
    // Clean live start: real configuration with the crawler pointed at CRAWLER_BASE_URL; no DEMO records.
    const cfg = defaultConfig(clock());
    if (env.CRAWLER_BASE_URL) cfg.site.baseUrl = env.CRAWLER_BASE_URL;
    await repos.config.set(cfg);
    await repos.schedules.insert({ id: 'SCH-smart', type: 'smart', cron: '0 2 * * *', description: 'Daily smart crawl (PDF §16)', enabled: true, timezone: 'Asia/Kolkata' });
    await repos.schedules.insert({ id: 'SCH-full', type: 'full', cron: '0 3 * * 0', description: 'Weekly full crawl (PDF §16)', enabled: true, timezone: 'Asia/Kolkata' });
  }
  setPriorityConfig(await repos.config.get());
  if (!o.repos && env.ADMIN_EMAIL && env.ADMIN_INITIAL_PASSWORD && (await repos.employees.count()) === 0) {
    await bootstrapAdmin(repos, env, clock());
    log.info({ email: env.ADMIN_EMAIL }, 'created the first admin account from ADMIN_EMAIL (password from ADMIN_INITIAL_PASSWORD — change it after first sign-in)');
  }

  const fetchImpl = o.fetchImpl;
  const connectors = createConnectors(env, fetchImpl, { mailTransport: o.mailTransport });
  const integrations = createIntegrationRegistry({ env, repos, connectors, clock, log });
  const adapters = createDeliveryAdapters(env, fetchImpl, { mailTransport: o.mailTransport });
  const delivery = createDeliveryService({ repos, adapters, clock, log, retry: o.retry });
  const taskOps = createTaskOpsAdapter({ env, fetchImpl, appBaseUrl: env.APP_BASE_URL });
  const llm = createLlmAdapter({ env, fetchImpl });

  const cfg0 = await repos.config.get();
  const engineOpts: CrawlEngineOptions = {
    baseUrl: env.CRAWLER_BASE_URL, allowLive: env.CRAWLER_ALLOW_LIVE, userAgent: env.CRAWLER_USER_AGENT ?? cfg0.crawl.userAgent,
    timeoutMs: cfg0.crawl.requestTimeoutMs, concurrency: cfg0.crawl.maxConcurrency, respectRobots: cfg0.crawl.respectRobots,
    // SSRF policy: loopback only for a local fixture site outside production; private / metadata addresses never.
    allowLoopback: !!env.CRAWLER_BASE_URL && isLocalHost(env.CRAWLER_BASE_URL) && env.NODE_ENV !== 'production',
    requestDelayMs: env.CRAWLER_REQUEST_DELAY_MS, maxBodyBytes: env.CRAWLER_MAX_BODY_BYTES,
    retries: env.CRAWLER_RETRIES, maxRetryWaitMs: env.CRAWLER_MAX_RETRY_WAIT_MS, maxCrawlDelayMs: env.CRAWLER_MAX_CRAWL_DELAY_MS,
    maxSitemapFiles: env.CRAWLER_MAX_SITEMAP_FILES, maxSitemapBytes: env.CRAWLER_MAX_SITEMAP_MB * 1024 * 1024,
    changeSnapshots: env.CHANGE_MONITOR_ENABLED !== false,
    thresholds: { ...cfg0.thresholds }, config: structuredClone(cfg0), fetchImpl: fetchImpl as typeof fetch | undefined, log: { info: (...a: unknown[]) => log.info(a), warn: (...a: unknown[]) => log.warn(a), error: (...a: unknown[]) => log.error(a) }, now: clock,
  };
  const baseEngine = createCrawlEngine(engineOpts);
  const workDir = env.CRAWLER_WORK_DIR ?? defaultWorkDir();
  const goEngine = createGoCrawlEngine({
    ...engineOpts, workDir, keepWorkFiles: env.CRAWLER_KEEP_WORK_FILES, memoryBudgetMB: env.CRAWLER_MEMORY_BUDGET_MB, goMemoryMB: env.CRAWLER_GO_MEMORY_MB,
    smartMaxPages: env.CRAWLER_SMART_MAX_PAGES, stallTimeoutMs: env.CRAWLER_STALL_MINUTES * 60_000,
    checksBudgetMs: env.CRAWLER_CHECKS_BUDGET_MINUTES ? env.CRAWLER_CHECKS_BUDGET_MINUTES * 60_000 : undefined, env: { CRAWLER_GO_BIN: env.CRAWLER_GO_BIN, TEXTCORE_BIN: env.TEXTCORE_BIN },
  });
  if (!o.repos && !o.engine) await cleanStaleWork(workDir).catch(() => 0);
  /** Which engine runs a plan: re-verification → built-in; otherwise CRAWLER_ENGINE (auto = Go when installed). */
  const goInstalled = () => { const b = goEngine.binaries(); return !!b.crawler.path && !b.crawler.problem; };
  // An injected fetch (tests with a simulated network) can only drive the built-in crawler.
  const pick = (type?: string) => (type === 'reverify' || fetchImpl || env.CRAWLER_ENGINE === 'node' || (env.CRAWLER_ENGINE === 'auto' && !goInstalled()) ? 'node' : 'go');
  const engine: CrawlEngine = o.engine ?? {
    readiness: () => (pick() === 'go' ? goEngine.readiness() : baseEngine.readiness()),
    async run(plan, cb) {
      // Pick up configuration changes made since start-up (thresholds, AI-crawler policy, intentional noindex…).
      const cfg = await repos.config.get();
      Object.assign(engineOpts.config, structuredClone(cfg));
      Object.assign(engineOpts.thresholds, cfg.thresholds);
      if (pick(plan.type) === 'go') return goEngine.run(plan, cb);
      const out = await baseEngine.run(plan, cb);
      const warn = plan.type !== 'reverify' && env.CRAWLER_ENGINE === 'auto'
        ? [{ code: 'node_engine', message: `The Go crawler is not installed on this server (${goEngine.binaries().crawler.problem ?? 'not found'}), so the built-in Node.js crawler ran. It keeps every page in memory and is not suited to very large sites.`, at: clock().toISOString() }]
        : undefined;
      return { ...out, stats: { ...out.stats, engine: 'node', ...(warn ? { warnings: warn } : {}) } };
    },
  };
  const engineInfo = () => {
    const b = goEngine.binaries();
    const mem = memoryPlan({ CRAWLER_MEMORY_BUDGET_MB: env.CRAWLER_MEMORY_BUDGET_MB, CRAWLER_GO_MEMORY_MB: env.CRAWLER_GO_MEMORY_MB });
    return {
      active: (o.engine ? 'node' : pick()) as 'go' | 'node',
      goCrawler: { available: !b.crawler.problem && !!b.crawler.path, version: b.crawler.version, problem: b.crawler.problem },
      textCore: { available: !b.textCore.problem && !!b.textCore.path, version: b.textCore.version, problem: b.textCore.problem },
      memoryBudgetMB: mem.budgetMB, memoryBasis: mem.basis,
      note: env.CRAWLER_ENGINE === 'node' ? 'CRAWLER_ENGINE=node: the built-in crawler is used.' : undefined,
    };
  };
  const ctxRef: { tierOf?: (u: string) => 1 | 2 | 3 } = {};
  let latestState: import('./services/ports').PreviousCrawlState | undefined;
  const reverifier = o.reverifier ?? createReverifier({
    collector: baseEngine.collector,
    tierOf: (u) => ctxRef.tierOf?.(u) ?? 3,
    previous: () => latestState,
  });

  const ctx: Ctx = { env, repos, log, clock, integrations, delivery, taskOps, llm, engine, engineInfo, reverifier, sessionSecret: env.SESSION_SECRET ?? randomToken(32) };
  const recent: ReturnType<DiagnosticsSource['recent']> = [];
  const diagnostics: DiagnosticsSource = o.diagnostics ?? { endpoints: [], recent: () => recent };

  const auth = createAuthService(ctx);
  const tasks = createTaskService(ctx);
  const issues = createIssueService(ctx, tasks);
  const rules = createRuleService(ctx);
  const changes = createChangeService(ctx, {
    siteUrl: async () => engine.readiness().baseUrl ?? env.CRAWLER_BASE_URL ?? (await repos.config.get()).site.baseUrl,
    issuesFor: async (urls) => {
      const want = new Set(urls.map(urlKey));
      const out = new Map<string, { id: string; checkId: string; title: string; severity: string }[]>();
      if (!want.size) return out;
      for (const i of await repos.issues.list()) {
        if (i.source !== 'live' || i.isTemplateGroup || i.supersededById || ['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE', 'SUPERSEDED'].includes(i.status)) continue;
        for (const u of i.affectedUrls) {
          const k = urlKey(u);
          if (!want.has(k)) continue;
          const list = out.get(k) ?? [];
          if (!list.some((x) => x.id === i.id)) list.push({ id: i.id, checkId: i.checkId, title: i.title, severity: i.severity });
          out.set(k, list);
        }
      }
      return out;
    },
  });
  const captures = createCaptureService(ctx, {
    siteUrl: async () => engine.readiness().baseUrl ?? env.CRAWLER_BASE_URL ?? (await repos.config.get()).site.baseUrl,
    root: changes.directory, allowLoopback: engineOpts.allowLoopback ?? false, userAgent: engineOpts.userAgent,
    latestChange: (u) => changes.latestChange(u), changedUrls: (id, max) => changes.changedUrls(id, max),
  });
  changes.setOnRecorded((s) => { void captures.afterCrawl(s.runId, s.snapshotId, !!s.counts).catch((e) => log.warn({ err: (e as Error).message }, 'after-crawl captures failed')); });
  const crawls = createCrawlService(ctx, issues, rules, changes);
  const lighthouse = createLighthouseService(ctx, env, baseEngine.collector, { allowLoopback: engineOpts.allowLoopback ?? false, userAgent: engineOpts.userAgent });
  // SHOPIFY_ADMIN_TOKEN belongs to the primary website only; added websites connect their own store with OAuth.
  const shopify = createShopifyService(ctx, {
    fetchImpl, collector: baseEngine.collector, latestRow: (u) => crawls.latestRow(u), useEnvToken: !o.repos,
    themeSnapshotDir: async () => path.join(changes.directory, safeName(new URL(engine.readiness().baseUrl ?? env.CRAWLER_BASE_URL ?? (await repos.config.get()).site.baseUrl).host), 'themes'),
  });
  const reports = createReportService(ctx);
  const insights = createInsightService(ctx);
  let schedulerRef: { running: () => boolean } = { running: () => false };
  const admin = createAdminService(ctx, auth, diagnostics, { schedulerRunning: () => schedulerRef.running() });
  const scheduler = createScheduler({ ctx, crawls, issues, reports });
  schedulerRef = scheduler;

  /** Keep the reverifier's tier lookup and crawl baseline fresh. */
  async function refreshVerifierInputs() {
    ctxRef.tierOf = await issues.tierLookup();
    latestState = (await repos.crawlStates.get('latest'))?.state;
  }
  await refreshVerifierInputs();

  const crawlerReady = engine.readiness();
  log.info({ storage: repos.storage.kind, demoSeed: seeded ?? false, crawler: crawlerReady }, 'container ready');
  // Say at start-up (in the server log) why live crawling will be refused, so a missing setting is not found only in the UI.
  if (!o.repos && !crawlerReady.ready) log.warn({ reason: crawlerReady.reason }, 'live crawling is not available for the primary website');
  return {
    env, log, clock, repos, ctx, diagnostics, recent,
    /** Injected outbound fetch (tests); undefined in production → adapters use global fetch. */
    fetchImpl,
    services: { auth, tasks, issues, rules, crawls, changes, captures, reports, insights, admin, lighthouse, shopify },
    scheduler,
    refreshVerifierInputs,
    runEscalations: () => runEscalations(ctx, issues),
  };
}
export type Container = Awaited<ReturnType<typeof createContainer>>;

/** Creates the first live admin on a clean start (no DEMO seed), so a production server is usable without preview accounts. */
async function bootstrapAdmin(repos: Repositories, env: Env, now: Date) {
  const password = env.ADMIN_INITIAL_PASSWORD!;
  const weak = passwordPolicyError(password);
  if (weak) throw new Error(`ADMIN_INITIAL_PASSWORD is too weak: ${weak}`);
  const email = env.ADMIN_EMAIL!.trim().toLowerCase();
  const id = await repos.employees.nextId('EMP', 3);
  await repos.employees.insert({
    id, name: env.ADMIN_NAME ?? 'Administrator', email, role: 'admin', teamIds: [], title: 'Administrator', status: 'active',
    capacityHoursPerWeek: 40, createdAt: now.toISOString(), source: 'live',
  });
  // Same salt at every start (keyed with SESSION_SECRET): sessions signed before a restart stay valid after it.
  const fixedSalt = env.SESSION_SECRET ? createHmac('sha256', env.SESSION_SECRET).update(`admin-salt:${email}`).digest('hex').slice(0, 32) : undefined;
  const { hash, salt } = await hashPassword(password, fixedSalt);
  await repos.credentials.insert({ id: email, employeeId: id, hash, salt, updatedAt: now.toISOString() });
}
