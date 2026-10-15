/**
 * Node ⇄ Go bridge failure handling, with stand-in crawler processes (small Node scripts speaking protocol v1) and,
 * where the real binary is needed, the Go crawler against the local fixture store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGoCrawler } from '../../src/gocrawl/bridge';
import { locateBinaries, minimalEnv } from '../../src/gocrawl/binaries';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { tier2 } from '../crawler/helpers';
import { HAVE_GO, makeGoEngine, tmpWork } from './goHelpers';

const isWin = process.platform === 'win32';

/** Writes an executable stand-in crawler (a Node script) and returns its path. */
function fakeCrawler(body: string): string {
  const dir = tmpWork();
  const file = path.join(dir, 'fake-crawler');
  fs.writeFileSync(file, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('sentinel-crawler fake (protocol 1)'); process.exit(0); }\nconst rl = require('readline').createInterface({ input: process.stdin });\nconst out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');\n${body}\n`, { mode: 0o755 });
  return file;
}

describe.skipIf(isWin)('bridge: crawler process failures', () => {
  it('a crawler that exits without "done" is reported with its exit code and stderr, not as success', async () => {
    const bin = fakeCrawler(`rl.once('line', () => { out({ type: 'hello', protocol: 1, version: 'fake', go: 'none', pid: process.pid }); out({ type: 'progress', processed: 3 }); process.stderr.write('panic: boom\\n'); process.exit(3); });`);
    const r = await runGoCrawler({ bin, job: { workDir: tmpWork() } });
    expect(r.done).toBeUndefined();
    expect(r.exitCode).toBe(3);
    expect(r.stderrTail).toContain('panic: boom');
  });

  it('kills a crawler that never answers the start message', async () => {
    const bin = fakeCrawler(`setInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const r = await runGoCrawler({ bin, job: {}, startTimeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.bridgeError).toMatch(/did not answer within/);
  });

  it('refuses a crawler speaking another protocol version', async () => {
    const bin = fakeCrawler(`rl.once('line', () => { out({ type: 'hello', protocol: 2, version: 'future', go: 'none', pid: process.pid }); setInterval(() => {}, 1000); });`);
    const r = await runGoCrawler({ bin, job: {} });
    expect(r.bridgeError).toMatch(/protocol 2; the API needs protocol 1/);
  });

  it('cancel: sends a cancel message, then kills a crawler that ignores it after the grace period', async () => {
    const bin = fakeCrawler(`rl.on('line', (l) => { const m = JSON.parse(l); if (m.type === 'start') out({ type: 'hello', protocol: 1, version: 'fake', go: 'none', pid: process.pid }); if (m.type === 'cancel') out({ type: 'warning', code: 'got_cancel', message: m.reason }); }); setInterval(() => out({ type: 'progress', processed: 1 }), 100);`);
    const ctrl = new AbortController();
    const events: string[] = [];
    setTimeout(() => ctrl.abort(), 300);
    const r = await runGoCrawler({ bin, job: {}, signal: ctrl.signal, cancelGraceMs: 400, onEvent: (e) => { if (e.type === 'warning') events.push(e.message); } });
    expect(events).toContain('user');
    expect(r.stoppedFor).toBe('user');
    expect(r.bridgeError).toMatch(/did not stop within/);
  });

  it('a resource check stops the crawl with reason "resource" and keeps the crawler\'s own summary', async () => {
    const bin = fakeCrawler(`rl.on('line', (l) => { const m = JSON.parse(l); if (m.type === 'start') out({ type: 'hello', protocol: 1, version: 'fake', go: 'none', pid: process.pid }); if (m.type === 'cancel') { out({ type: 'done', state: 'resource_stopped', reason: 'stopped: ' + m.reason }); process.exit(0); } }); setInterval(() => out({ type: 'progress', processed: 1 }), 100);`);
    let calls = 0;
    const r = await runGoCrawler({ bin, job: {}, resourceCheck: () => (++calls >= 2 ? 'over budget' : undefined) });
    expect(r.stoppedFor).toBe('resource');
    expect(r.resourceReason).toBe('over budget');
    expect(r.done?.state).toBe('resource_stopped');
    expect(r.done?.reason).toBe('stopped: resource');
  });

  it('passes no API secrets to the crawler process', () => {
    process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_test_secret_value';
    process.env.SESSION_SECRET = 'x'.repeat(40);
    try {
      const env = minimalEnv();
      expect(Object.keys(env)).not.toContain('SHOPIFY_ADMIN_TOKEN');
      expect(Object.keys(env)).not.toContain('SESSION_SECRET');
      expect(JSON.stringify(env)).not.toContain('shpat_test_secret_value');
    } finally {
      delete process.env.SHOPIFY_ADMIN_TOKEN;
      delete process.env.SESSION_SECRET;
    }
  });

  it('reports a missing or wrong binary instead of crawling', () => {
    const b = locateBinaries({ CRAWLER_GO_BIN: '/nonexistent/sentinel-crawler', TEXTCORE_BIN: '/nonexistent/sentinel-textcore' }, true);
    expect(b.crawler.problem).toBe('not found');
    expect(b.textCore.problem).toBe('not found');
  });
});

describe.skipIf(isWin)('engine: a crawler crash keeps what was written and fails the run', () => {
  let site: FixtureSite;
  beforeAll(async () => { site = await startFixtureSite(); });
  afterAll(async () => { await site.close(); });

  it('reads the complete records before a truncated results file and reports the crawl as failed', async () => {
    // Stand-in crawler: writes two page records and a cut-off gzip tail into its work dir, then dies.
    const bin = fakeCrawler(`
const fs = require('fs'); const zlib = require('zlib'); const path = require('path');
rl.once('line', (l) => {
  const job = JSON.parse(l).job;
  out({ type: 'hello', protocol: 1, version: 'fake', go: 'none', pid: process.pid });
  const rec = (id, p) => JSON.stringify({ id, url: job.baseUrl.replace(/\\/$/, '') + p, finalUrl: job.baseUrl.replace(/\\/$/, '') + p, status: 200, finalStatus: 200, chain: [], redirectLoop: false, tooManyRedirects: false, totalMs: 1, headers: {}, contentType: 'text/html', template: 'page', reason: 'full', inSitemap: false });
  const gz = zlib.gzipSync(rec(0, '/pages/a') + '\\n' + rec(1, '/pages/b') + '\\n' + rec(2, '/pages/c') + '\\n');
  fs.writeFileSync(path.join(job.workDir, 'pages.ndjson.gz'), gz.subarray(0, gz.length - 12));
  out({ type: 'progress', processed: 3, discovered: 3, failed: 0, succeeded: 3 });
  process.stderr.write('fatal error: out of memory\\n');
  process.exit(2);
});`);
    const engine = makeGoEngine(site.url, { env: { CRAWLER_GO_BIN: bin, TEXTCORE_BIN: '/nonexistent' } });
    const out = await engine.run({ type: 'full', baseUrl: site.url, maxPages: 50, tierOf: tier2 });
    try {
      expect(out.stats.outcome).toBe('failed');
      expect(out.failed).toMatch(/ended without finishing \(exit code 2\)/);
      expect(out.failed).toMatch(/out of memory/);
      expect(out.findings).toEqual([]);
      const rows = (await out.store!.query({ limit: 50 })).rows.map((r) => r.url.replace(site.url.replace(/\/$/, ''), ''));
      // gzip cuts off mid-stream: every record that decompressed completely is kept, nothing is invented.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((u) => ['/pages/a', '/pages/b', '/pages/c'].includes(u))).toBe(true);
      expect(out.stats.warnings?.some((w) => /ended early|missing/.test(w.message))).toBe(true);
    } finally {
      await out.cleanup?.();
      await out.store?.dispose();
    }
  });
});

describe.skipIf(!HAVE_GO)('engine: memory budget across all crawl processes', () => {
  let site: FixtureSite;
  beforeAll(async () => { site = await startFixtureSite(); });
  afterAll(async () => { await site.close(); });

  it('stops taking new pages when API + crawler + text core exceed the budget, and still analyses what was fetched', async () => {
    // A budget below what this test process alone uses: the first memory check stops the crawl.
    const engine = makeGoEngine(site.url, { memoryBudgetMB: 64, concurrency: 1, requestDelayMs: 300 });
    const out = await engine.run({ type: 'full', baseUrl: site.url, maxPages: 500, tierOf: tier2 });
    try {
      expect(out.stats.outcome).toBe('resource_stopped');
      expect(out.memoryStopped).toBe(true);
      expect(out.stats.outcomeReason).toMatch(/above the 64 MB budget/);
      expect(out.stats.memory?.budgetMB).toBe(64);
      expect(out.stats.memory?.peakTotalMB).toBeGreaterThan(64);
      // Unfetched URLs are listed as not processed, not silently dropped.
      expect((out.stats.coverage?.notProcessed ?? 0) + (out.stats.coverage?.queued ?? 0) + (out.stats.coverage?.waiting ?? 0)).toBeGreaterThan(0);
      expect(out.evaluatedChecks.length).toBeGreaterThan(0);
    } finally {
      await out.cleanup?.();
      await out.store?.dispose();
    }
  }, 60_000);
});

