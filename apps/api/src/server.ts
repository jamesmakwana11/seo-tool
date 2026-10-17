import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { createContainer } from './container';
import { createApp } from './http/app';
import { describeDatabaseUrl, openPersistence } from './repositories/postgres/persistence';

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

  const server = app.listen(env.PORT, () => {
    log.info({ port: env.PORT, env: env.NODE_ENV, scheduler: env.SCHEDULER_ENABLED, demoSeed: env.SEED_DEMO_DATA }, `DeoDap SEO Sentinel API listening on :${env.PORT}`);
    if (persistence) log.info({ database: describeDatabaseUrl(env.DATABASE_URL!) }, 'Storage: PostgreSQL — websites, crawls and results are kept across restarts.');
    else log.warn('Storage is TEMPORARY in-memory: all websites, crawls and issues are lost on restart. Set DATABASE_URL to keep them in PostgreSQL.');
  });

  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, 'shutting down');
    container.scheduler.stop();
    // Render sends SIGTERM before a redeploy / restart: store every queued write first.
    let closing: Promise<void> | undefined;
    const done = () => (closing ??= (persistence ? persistence.close() : Promise.resolve()).catch((e: Error) => log.error({ err: e.message }, 'could not store every change before shutting down')));
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
