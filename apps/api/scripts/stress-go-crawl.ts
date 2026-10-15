/**
 * End-to-end stress run of a full "All pages" crawl through the real API service, the Go crawler and the Rust text
 * core, against the synthetic store (tools/synthetic-store/server.mjs) on 127.0.0.1 — no external website.
 *
 *   npx tsx scripts/stress-go-crawl.ts --products 50000 [--concurrency 16] [--budget 450] [--out results.json]
 *
 * Run it with a small heap to prove the 500 MB host case, e.g.:
 *   node --max-old-space-size=256 --import tsx scripts/stress-go-crawl.ts --products 50000 --budget 450
 *
 * Measures (sampled every 250 ms): RSS of this API process, of the Go crawler and of the Rust text core (as reported by
 * the crawler), their sum, Node heap; duration per phase; then times the Pages API (paging, filters, search), the
 * coverage report and a streamed CSV export of every row.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env';
import { createContainer } from '../src/container';
import { SYSTEM_ACTOR } from '../src/services/context';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PRODUCTS = Number(arg('products', '5000'));
const CONCURRENCY = Number(arg('concurrency', '16'));
const BUDGET = arg('budget');
const OUT = arg('out');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.SENTINEL_ROOT ?? path.resolve(here, '../../..');

async function main() {
  const site = spawn(process.execPath, [path.join(root, 'tools/synthetic-store/server.mjs'), '--products', String(PRODUCTS)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = await new Promise<{ url: string; products: number; collections: number; collectionPages: number; articles: number }>((resolve, reject) => {
    readline.createInterface({ input: site.stdout! }).once('line', (l) => resolve(JSON.parse(l)));
    site.once('exit', (c) => reject(new Error(`synthetic store exited ${c}`)));
  });
  const base = ready.url.replace(/\/$/, '');
  console.log(`synthetic store: ${JSON.stringify(ready)}`);
  const env = loadEnv({
    NODE_ENV: 'development', LOG_LEVEL: 'warn', SEED_DEMO_DATA: 'false', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: 'go', CRAWLER_REQUEST_DELAY_MS: '0',
    ...(BUDGET ? { CRAWLER_MEMORY_BUDGET_MB: BUDGET } : {}),
  });
  const c = await createContainer({ env });
  const crawls = c.services.crawls;
  const status = await crawls.status(SYSTEM_ACTOR);
  console.log(`engine: ${JSON.stringify(status.engine)}`);

  const t0 = Date.now();
  const run = await crawls.start(SYSTEM_ACTOR, 'full', 'manual', { startUrl: `${base}/`, maxPages: null, maxDepth: null, timeoutMs: 15000, concurrency: CONCURRENCY, requestDelayMs: 0 });
  const peaks = { nodeRss: 0, nodeHeap: 0, go: 0, textCore: 0, total: 0 };
  const phases: Record<string, number> = {};
  let lastPhase = '';
  let lastLog = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const cur = (await c.repos.crawls.get(run.id))!;
    const m = process.memoryUsage();
    const nodeRss = m.rss / 1048576;
    const go = cur.memory?.goRssMB ?? 0;
    const tc = cur.memory?.textCoreRssMB ?? 0;
    peaks.nodeRss = Math.max(peaks.nodeRss, nodeRss);
    peaks.nodeHeap = Math.max(peaks.nodeHeap, m.heapUsed / 1048576);
    peaks.go = Math.max(peaks.go, go);
    peaks.textCore = Math.max(peaks.textCore, tc);
    // Children are reported with their last progress sample; only add them while the crawler is still running.
    const childAlive = cur.phase !== 'analysing' && cur.phase !== 'saving' && cur.status === 'running';
    peaks.total = Math.max(peaks.total, nodeRss + (childAlive ? go + tc : 0));
    const ph = cur.phase ?? cur.status;
    if (ph !== lastPhase) { phases[ph] = Date.now() - t0; lastPhase = ph; }
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      console.log(`${Math.round((Date.now() - t0) / 1000)}s ${ph} processed=${cur.coverage?.processed ?? cur.urlsCrawled} discovered=${cur.coverage?.discovered ?? '?'} ${cur.coverage?.pagesPerMin ?? '?'}/min node=${nodeRss.toFixed(0)}MB go=${go}MB rust=${tc}MB`);
    }
    if (cur.status !== 'running' && cur.status !== 'queued') break;
  }
  const done = (await c.repos.crawls.get(run.id))!;
  const wall = Date.now() - t0;

  // ---- Pages API, coverage, export
  const timed = async <T>(fn: () => Promise<T>) => { const s = Date.now(); const v = await fn(); return { ms: Date.now() - s, v }; };
  const first = await timed(() => crawls.pages(SYSTEM_ACTOR, run.id, { limit: 50 }));
  const deep = await timed(() => crawls.pages(SYSTEM_ACTOR, run.id, { offset: Math.max(0, first.v.total - 50), limit: 50, sort: 'response', dir: 'desc' }));
  const filt = await timed(() => crawls.pages(SYSTEM_ACTOR, run.id, { problem: 'dup-title', limit: 50 }));
  const search = await timed(() => crawls.pages(SYSTEM_ACTOR, run.id, { q: 'chopper', limit: 50 }));
  const cov = await timed(() => crawls.coverage(SYSTEM_ACTOR, run.id));
  const exp = await timed(async () => {
    const f = await crawls.exportResults(SYSTEM_ACTOR, run.id, 'csv');
    let bytes = 0;
    let rows = 0;
    if (f.content !== undefined) bytes = f.content.length;
    else for await (const chunk of f.stream!) { bytes += chunk.length; rows += chunk.split('\r\n').length - 1; }
    return { bytes, rows };
  });
  const issues = (await c.repos.issues.list()).filter((i) => i.crawlRunId === run.id);
  const result = {
    products: PRODUCTS, site: ready, concurrency: CONCURRENCY, budgetMB: BUDGET ? Number(BUDGET) : null, heapLimitMB: Math.round((await import('node:v8')).getHeapStatistics().heap_size_limit / 1048576),
    status: done.status, outcome: done.outcome, outcomeReason: done.outcomeReason, error: done.error,
    wallMs: wall, phasesAtMs: phases, timings: done.timings,
    coverage: done.coverage, rows: done.urlCount, textCore: done.textCore,
    peaksMB: Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, Math.round(v)])), runMemory: done.memory,
    issues: { total: issues.length, byCheck: Object.fromEntries([...new Set(issues.map((i) => i.checkId))].map((k) => [k, issues.filter((i) => i.checkId === k).reduce((n, i) => n + i.affectedCount, 0)])) },
    newIssues: done.newIssues,
    dupTitleSample: filt.v.rows.slice(0, 6).map((r) => [r.url, r.title, r.status, r.flags]),
    pagesApiMs: { first: first.ms, last: deep.ms, filterDupTitle: filt.ms, search: search.ms, total: first.v.total, dupTitleRows: filt.v.total, searchRows: search.v.total },
    coverageMs: cov.ms, coverageSummary: { sitemapNotCrawled: cov.v.sitemapNotCrawled.count, failed: cov.v.failed.count, redirects: cov.v.redirects.count, nearGroups: cov.v.duplicates.nearContent.count, titleGroups: cov.v.duplicates.titles.count, orphanCandidates: cov.v.orphanCandidates.count },
    exportCsv: { ms: exp.ms, ...exp.v },
    warnings: done.warnings,
  };
  console.log(JSON.stringify(result, null, 2));
  if (OUT) fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  site.kill('SIGTERM');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
