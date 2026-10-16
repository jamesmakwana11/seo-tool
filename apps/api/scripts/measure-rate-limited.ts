/**
 * Crawl a rate-limited synthetic store (token bucket, 429 + Retry-After — like a storefront's bot protection) through
 * the real API service and Go crawler, and report throughput, 429s, pacing, post-crawl checks and memory.
 * 127.0.0.1 only — no external website.
 *
 *   npx tsx scripts/measure-rate-limited.ts --products 300 --rate 4 --burst 8 --retry-after 30 [--concurrency 8] [--delay 250] [--out r.json]
 *
 * CRAWLER_GO_BIN may point at another crawler build to compare versions on the same store.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env';
import { createContainer } from '../src/container';
import { SYSTEM_ACTOR } from '../src/services/context';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

async function main() {
  const storeArgs = ['--products', arg('products', '300'), '--rate', arg('rate', '4'), '--burst', arg('burst', '8'), '--retry-after', arg('retry-after', '30')];
  const site = spawn(process.execPath, [path.join(root, 'tools/synthetic-store/server.mjs'), ...storeArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let storeFinal: Record<string, number> = {};
  readline.createInterface({ input: site.stderr! }).on('line', (l) => { try { const v = JSON.parse(l); if (v.final) storeFinal = v; } catch { /* other output */ } });
  const ready = await new Promise<{ url: string }>((resolve) => readline.createInterface({ input: site.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
  const base = ready.url.replace(/\/$/, '');
  const c = await createContainer({ env: loadEnv({
    NODE_ENV: 'development', LOG_LEVEL: 'warn', SEED_DEMO_DATA: 'false', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: 'go', CRAWLER_REQUEST_DELAY_MS: arg('delay', '250'),
    CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rl-')), CHANGE_CAPTURE_AFTER_CRAWL: 'false',
    ...(process.env.CRAWLER_GO_BIN ? { CRAWLER_GO_BIN: process.env.CRAWLER_GO_BIN } : {}),
  }) });
  const t0 = Date.now();
  const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual', { startUrl: `${base}/`, maxPages: null, maxDepth: null, timeoutMs: 15000, concurrency: Number(arg('concurrency', '8')), requestDelayMs: Number(arg('delay', '250')) });
  const phases: Record<string, number> = {};
  let maxGap = 0;
  let peakRss = 0;
  let peakGo = 0;
  let last = '';
  const timeoutMin = Number(arg('timeout-min', '30'));
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = (await c.repos.crawls.get(run.id))!;
    peakRss = Math.max(peakRss, process.memoryUsage().rss / 1048576);
    peakGo = Math.max(peakGo, cur.memory?.goRssMB ?? 0);
    maxGap = Math.max(maxGap, cur.coverage?.politeness?.delayMs ?? cur.politeness?.delayMs ?? 0);
    const ph = cur.phase ?? cur.status;
    if (ph !== last) { phases[ph] = Date.now() - t0; last = ph; }
    if (cur.status !== 'running' && cur.status !== 'queued') break;
    if (Date.now() - t0 > timeoutMin * 60_000) { await c.services.crawls.cancel(SYSTEM_ACTOR, run.id); }
  }
  await c.services.crawls.idle();
  const done = (await c.repos.crawls.get(run.id))!;
  site.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  const wallMs = Date.now() - t0;
  const out = {
    store: storeArgs.join(' '), bin: process.env.CRAWLER_GO_BIN ?? 'bin/sentinel-crawler', status: done.status, outcome: done.outcome, wallMs,
    pages: done.coverage?.processed, discovered: done.coverage?.discovered, pagesPerMinOverall: done.coverage?.processed ? Math.round((done.coverage.processed / (done.timings?.crawlProcessMs ?? wallMs)) * 60000) : 0,
    store429: storeFinal.limited, storeRequests: storeFinal.served, maxGapSeenMs: maxGap, politeness: done.coverage?.politeness ?? done.politeness,
    checks: done.coverage?.checks, timings: { crawlProcessMs: done.timings?.crawlProcessMs, crawlMs: done.timings?.crawlMs, checksMs: done.timings?.checksMs, checksBudgetMs: done.timings?.checksBudgetMs, sitemapMs: done.timings?.sitemapMs },
    phasesAtMs: phases, peakMB: { apiRss: Math.round(peakRss), go: Math.round(peakGo) }, memory: done.memory,
  };
  console.log(JSON.stringify(out, null, 2));
  const o = arg('out', '');
  if (o) fs.writeFileSync(o, `${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
