import { defaultConfig, setPriorityConfig } from '@sentinel/shared';
import type { Env } from './config/env';
import { createLogger, type Logger } from './lib/logger';
import { hashPassword, passwordPolicyError, randomToken } from './lib/passwords';
import { createInMemoryRepositories } from './repositories/memory/inMemory';
import { seedDemoData } from './repositories/seedDemo';
import type { Repositories } from './repositories/types';
import { createCrawlEngine, type CrawlEngineOptions } from './crawler/engine';
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
    thresholds: { ...cfg0.thresholds }, config: structuredClone(cfg0), fetchImpl: fetchImpl as typeof fetch | undefined, log: { info: (...a: unknown[]) => log.info(a), warn: (...a: unknown[]) => log.warn(a), error: (...a: unknown[]) => log.error(a) }, now: clock,
  };
  const baseEngine = createCrawlEngine(engineOpts);
  const engine: CrawlEngine = o.engine ?? {
    readiness: () => baseEngine.readiness(),
    async run(plan, cb) {
      // Pick up configuration changes made since start-up (thresholds, AI-crawler policy, intentional noindex…).
      const cfg = await repos.config.get();
      Object.assign(engineOpts.config, structuredClone(cfg));
      Object.assign(engineOpts.thresholds, cfg.thresholds);
      return baseEngine.run(plan, cb);
    },
  };
  const ctxRef: { tierOf?: (u: string) => 1 | 2 | 3 } = {};
  let latestState: import('./services/ports').PreviousCrawlState | undefined;
  const reverifier = o.reverifier ?? createReverifier({
    collector: baseEngine.collector,
    tierOf: (u) => ctxRef.tierOf?.(u) ?? 3,
    previous: () => latestState,
  });

  const ctx: Ctx = { env, repos, log, clock, integrations, delivery, taskOps, llm, engine, reverifier, sessionSecret: env.SESSION_SECRET ?? randomToken(32) };
  const recent: ReturnType<DiagnosticsSource['recent']> = [];
  const diagnostics: DiagnosticsSource = o.diagnostics ?? { endpoints: [], recent: () => recent };

  const auth = createAuthService(ctx);
  const tasks = createTaskService(ctx);
  const issues = createIssueService(ctx, tasks);
  const rules = createRuleService(ctx);
  const crawls = createCrawlService(ctx, issues, rules);
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

  log.info({ storage: repos.storage.kind, demoSeed: seeded ?? false, crawler: engine.readiness() }, 'container ready');
  return {
    env, log, clock, repos, ctx, diagnostics, recent,
    /** Injected outbound fetch (tests); undefined in production → adapters use global fetch. */
    fetchImpl,
    services: { auth, tasks, issues, rules, crawls, reports, insights, admin },
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
  const { hash, salt } = await hashPassword(password);
  await repos.credentials.insert({ id: email, employeeId: id, hash, salt, updatedAt: now.toISOString() });
}
