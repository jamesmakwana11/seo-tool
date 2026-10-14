import { loadEnv } from './config/env';
import { createLogger } from './lib/logger';
import { createContainer } from './container';
import { createApp } from './http/app';

async function main() {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  const container = await createContainer({ env, log });
  const app = createApp(container);

  if (env.SCHEDULER_ENABLED) container.scheduler.start();

  const server = app.listen(env.PORT, () => {
    log.info({ port: env.PORT, env: env.NODE_ENV, scheduler: env.SCHEDULER_ENABLED, demoSeed: env.SEED_DEMO_DATA }, `DeoDap SEO Sentinel API listening on :${env.PORT}`);
    log.warn('Storage is TEMPORARY in-memory (Phase 2). All data is lost on restart. No database integration has been performed (Phase 3 awaits explicit authorization).');
  });

  const shutdown = (sig: string) => {
    log.info({ sig }, 'shutting down');
    container.scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start API:', e instanceof Error ? e.message : e);
  process.exit(1);
});
