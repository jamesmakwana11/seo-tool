import { CRAWLER_BASE_URL_MISSING, loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { createContainer } from './container';
import { createApp } from './http/app';
import { describeDatabaseUrl, openPersistence } from './repositories/postgres/persistence';
import { busyCrawlJobs, suspendCrawlsForShutdown } from './services/crawls';
import { busyImageAudits, suspendImageAuditsForShutdown } from './images/audit';
import { startKeepAwake } from './jobs/keepAwake';
import type { Workspaces } from './websites';

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  // DATABASE_URL set: PostgreSQL storage, or no start at all (never a silent fallback to temporary memory).
  const persistence = env.DATABASE_URL
    ? await openPersistence({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL, log, waitMs: env.DATABASE_WAIT_SECONDS * 1000 })
    : undefined;
  const container = await createContainer({ env, log, persistence });
  const app = createApp(container);
  // Every saved website (and its data) is loaded before the server accepts requests.
  await (app.locals.ready as () => Promise<void>)();

  if (env.SCHEDULER_ENABLED) container.scheduler.start();
  // Crawls are background jobs of this server; keep an idle-stopping host from stopping it while one runs.
  const keepAwake = startKeepAwake({
    enabled: env.CRAWL_KEEP_AWAKE, url: env.KEEP_AWAKE_URL ?? env.RENDER_EXTERNAL_URL, intervalMs: env.KEEP_AWAKE_INTERVAL_SECONDS * 1000,
    busy: () => busyCrawlJobs() + busyImageAudits() > 0, log,
  });

  const server = app.listen(env.PORT, () => {
    log.info({ port: env.PORT, env: env.NODE_ENV, scheduler: env.SCHEDULER_ENABLED, demoSeed: env.SEED_DEMO_DATA }, `DeoDap SEO Sentinel API listening on :${env.PORT}`);
    if (persistence) log.info({ database: describeDatabaseUrl(env.DATABASE_URL!) }, 'Storage: PostgreSQL — websites, crawls and results are kept across restarts.');
    else log.warn('Storage is TEMPORARY in-memory: all websites, crawls and issues are lost on restart. Set DATABASE_URL to keep them in PostgreSQL.');
    // Live crawling: one switch for every registered website; each website's crawler only requests its own host.
    if (!env.CRAWLER_ALLOW_LIVE) log.warn('Live crawling is OFF (CRAWLER_ALLOW_LIVE is not "true"): no website can be crawled. Set CRAWLER_ALLOW_LIVE=true in the API environment and restart.');
    else if (!env.CRAWLER_BASE_URL) log.warn(CRAWLER_BASE_URL_MISSING);
    else log.info({ primary: env.CRAWLER_BASE_URL, websites: (app.locals.workspaces as Workspaces).entries().length }, 'Live crawling is ON for every registered website (each limited to its own host).');
  });

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'shutting down');
    container.scheduler.stop();
    keepAwake.stop();
    // A crawl still running is left "running" in the database (never recorded as failed or cancelled because of the
    // shutdown) and is started again when the server is back.
    suspendCrawlsForShutdown();
    // Render sends SIGTERM before a redeploy / restart: store every queued write first.
    let closing: Promise<void> | undefined;
    // Running Image Audits store their progress first (they continue after the restart with a database).
    const audits = Promise.race([suspendImageAuditsForShutdown(), new Promise((r) => setTimeout(r, 4000))]);
    const done = () => (closing ??= audits.then(() => (persistence ? persistence.close() : undefined)).catch((e: Error) => log.error({ err: e.message }, 'could not store every change before shutting down')));
    server.close(() => { void done().finally(() => process.exit(0)); });
    setTimeout(() => { void done().finally(() => process.exit(1)); }, 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start API:', e instanceof Error ? e.message : e);
  process.exit(1);
});
