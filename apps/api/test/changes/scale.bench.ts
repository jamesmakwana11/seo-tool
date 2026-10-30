/* Change Monitor scale measurement: N synthetic URLs, two full crawls with ~10 % changed. Run: npx tsx test/changes/scale.bench.ts 50000 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CrawlRun } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createChangeService } from '../../src/changes/service';
import { gzWriter } from '../../src/gocrawl/files';
import type { SnapRec } from '../../src/changes/snapshot';
import { SYSTEM_ACTOR, type Ctx } from '../../src/services/context';

const N = Number(process.argv[2] ?? 25000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-changes-bench-'));
const env = loadEnv({ NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'b'.repeat(40), LOG_LEVEL: 'silent', CHANGE_SNAPSHOT_DIR: dir });
let now = new Date('2026-10-01T00:00:00Z');
const ctx = { env, clock: () => now, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, repos: { permissions: { get: async () => undefined } } } as unknown as Ctx;
const svc = createChangeService(ctx, { siteUrl: async () => 'https://bench.test/', issuesFor: async () => new Map() });
const links = Array.from({ length: 150 }, (_, i) => `/collections/c${i}/products/menu-item-${i}`);
function rec(i: number, v: number): SnapRec {
  const changed = v > 0 && i % 10 === 0;
  return {
    u: `https://bench.test/products/p-${i}`, st: 'fetched', s: 200, fs: 200, tpl: 'product', t: `Product ${i}${changed ? ' – new' : ''} | Bench`, m: `Meta description of product ${i} with some words`,
    h1: [`Product ${i}`], h2: ['Details', 'Reviews', 'Shipping'], h3: ['Size', 'Material'], c: `https://bench.test/products/p-${i}`, ix: 1, wc: 450, ch: `c${i}-${changed ? v : 0}`,
    tx: `Product ${i} description `.repeat(30).slice(0, 600), lc: links.length, lh: 'l', l: links, ih: `i${i}`, im: [[`/cdn/p-${i}.webp`, `Product ${i}`]], sh: `s${i}`, sd: ['BreadcrumbList', 'Product'], ah: 'a', as: ['/cdn/theme.css?v=1', '/cdn/theme.js?v=1'],
  };
}
async function snap(v: number) {
  const file = path.join(dir, `in-${v}.ndjson.gz`);
  const w = gzWriter(file);
  for (let i = 0; i < N; i++) await w.write(rec(i, v));
  await w.close();
  return file;
}
let peakRss = 0, peakHeap = 0;
const t = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); }, 20);
(async () => {
  const mb = (b: number) => Math.round(b / 1048576);
  for (const v of [0, 1]) {
    const file = await snap(v);
    now = new Date(now.getTime() + 86400_000);
    const run = { id: `CRL-${v + 1}`, type: 'full', status: 'completed', outcome: 'completed', startedAt: now.toISOString(), finishedAt: now.toISOString() } as unknown as CrawlRun;
    if (global.gc) global.gc();
    const base = process.memoryUsage();
    peakRss = base.rss; peakHeap = base.heapUsed;
    const t0 = Date.now();
    const s = await svc.record(run, { snapshotFile: file });
    console.log(JSON.stringify({ N, crawl: v + 1, ms: Date.now() - t0, effect: s?.baselineEffect, counts: s?.counts && { changed: s.counts.changed, unchanged: s.counts.unchanged }, heapBeforeMB: mb(base.heapUsed), peakHeapMB: mb(peakHeap), rssBeforeMB: mb(base.rss), peakRssMB: mb(peakRss), snapshotFileMB: +(fs.statSync(file).size / 1048576).toFixed(1) }));
  }
  const t1 = Date.now();
  const p = await svc.list(SYSTEM_ACTOR, 'latest', { kind: 'changed', page: 10, pageSize: 50 });
  const t2 = Date.now();
  const q = await svc.list(SYSTEM_ACTOR, 'latest', { q: 'p-4999', pageSize: 50 });
  const t3 = Date.now();
  let bytes = 0;
  for await (const ch of (await svc.export(SYSTEM_ACTOR, 'latest', 'csv', {})).stream) bytes += ch.length;
  const t4 = Date.now();
  const st = await svc.status(SYSTEM_ACTOR);
  console.log(JSON.stringify({ listChangedPage10Ms: t2 - t1, total: p.total, searchAllMs: t3 - t2, searchHits: q.total, exportCsvMs: t4 - t3, exportMB: +(bytes / 1048576).toFixed(1), diskMB: +(st.diskBytes / 1048576).toFixed(1), peakRssMB: mb(peakRss), peakHeapMB: mb(peakHeap) }));
  clearInterval(t);
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); else console.log(dir);
})();
