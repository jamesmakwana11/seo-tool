import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMART_CRAWL_PAGE_BUDGET, type CrawledUrl } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { HAVE_GO } from './goHelpers';

/**
 * Smart Crawl page budget against the local synthetic store (127.0.0.1, ~2,400 eligible pages; no external site):
 * the Smart Crawl budget is 10,000 pages by default (configurable lower); a Smart Crawl fetches at most its budget and
 * reports the eligible URLs it left as pending; a Full Crawl on the same store is not limited by that budget.
 */
const root = path.resolve(__dirname, '../../../..');
let store: ChildProcess | undefined;
let base = '';

beforeAll(async () => {
  if (!HAVE_GO) return;
  store = spawn(process.execPath, [path.join(root, 'tools/synthetic-store/server.mjs'), '--products', '1500'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = await new Promise<{ url: string }>((resolve, reject) => {
    readline.createInterface({ input: store!.stdout! }).once('line', (l) => resolve(JSON.parse(l)));
    store!.once('exit', (c) => reject(new Error(`synthetic store exited ${c}`)));
  });
  base = ready.url.replace(/\/$/, '');
});
afterAll(() => { store?.kill('SIGTERM'); });

async function containerFor(extra: Record<string, string> = {}) {
  return createContainer({
    env: loadEnv({
      NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'b'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: 'go',
      CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')), ...extra,
    }),
  });
}

async function allRows(c: Awaited<ReturnType<typeof containerFor>>, id: string): Promise<CrawledUrl[]> {
  const out: CrawledUrl[] = [];
  for (let offset = 0; ; offset += 500) {
    const p = await c.services.crawls.pages(SYSTEM_ACTOR, id, { offset, limit: 500 });
    out.push(...p.rows);
    if (offset + 500 >= p.total) return out;
  }
}

describe.skipIf(!HAVE_GO)('Smart Crawl page budget', () => {
  it('is 10,000 pages by default and at most', () => {
    expect(SMART_CRAWL_PAGE_BUDGET).toBe(10000);
    expect(loadEnv({ NODE_ENV: 'test' }).CRAWLER_SMART_MAX_PAGES).toBe(10000);
    expect(loadEnv({ NODE_ENV: 'test', CRAWLER_SMART_MAX_PAGES: '5000' }).CRAWLER_SMART_MAX_PAGES).toBe(5000);
    expect(() => loadEnv({ NODE_ENV: 'test', CRAWLER_SMART_MAX_PAGES: '10001' })).toThrow();
  });

  it('stops a Smart Crawl at its budget (here set to 1,000) and reports the pending eligible URLs; never as crawled or passed', async () => {
    const c = await containerFor({ CRAWLER_SMART_MAX_PAGES: '1000' });
    const started = await c.services.crawls.start(SYSTEM_ACTOR, 'smart');
    expect(started.smart?.budget).toBe(1000);
    await c.services.crawls.idle();
    const run = (await c.repos.crawls.get(started.id))!;
    expect(run.status).toBe('completed');
    expect(run.outcome).toBe('partial');
    expect(run.coverage!.processed).toBe(1000);
    expect(run.urlsCrawled).toBe(1000);
    expect(run.smart!.budget).toBe(1000);
    const pending = run.coverage!.pageLimited;
    expect(pending).toBeGreaterThan(500);
    expect(run.smart!.notAudited).toBe(pending + run.coverage!.notProcessed + run.coverage!.queued + run.coverage!.waiting);
    expect(run.outcomeReason).toContain('Smart Crawl budget of 1000 pages was reached');
    expect(run.outcomeReason).toContain(`${pending} eligible URLs were not fetched`);
    const rows = await allRows(c, run.id);
    // Pages requested by the crawler (a redirect's target arrives with the redirect's own response).
    expect(rows.filter((r) => r.crawlState === 'fetched' && !r.redirectedFrom).length).toBeLessThanOrEqual(1000);
    const limited = rows.filter((r) => r.crawlState === 'page_limit');
    expect(limited.length).toBe(pending);
    for (const r of limited) {
      expect(r.status, r.url).toBeNull();
      expect(r.auditScore, r.url).toBeUndefined();
      expect(r.title, r.url).toBeUndefined();
    }
    // No page-content finding lists a URL that was not fetched. (A link target that was not crawled may still be
    // HEAD-checked after the crawl; a 4xx / 5xx / redirect from that real check is evidence, not an audit of the page.)
    const notFetched = new Set(limited.map((r) => r.url));
    const linkStatus = /^TECH-(4XX|5XX|3XX|BROKEN|REDIRECT|DISCONTINUED|CHAIN)/;
    for (const i of await c.repos.issues.list()) {
      if (linkStatus.test(i.checkId)) continue;
      for (const u of i.affectedUrls) expect(notFetched.has(u), `${i.checkId} ${u}`).toBe(false);
    }
  }, 180_000);

  it('a website sync after a budget-limited Smart Crawl crawls URLs it left unfetched, within the per-sync limit', async () => {
    const c = await containerFor({ CRAWLER_SMART_MAX_PAGES: '1000', SYNC_MAX_URLS: '300', MONITOR_MAX_CHECKS: '20' });
    const started = await c.services.crawls.start(SYSTEM_ACTOR, 'smart');
    await c.services.crawls.idle();
    const base = (await c.repos.crawls.get(started.id))!;
    const baseRows = await allRows(c, base.id);
    const limitedBefore = baseRows.filter((r) => r.crawlState === 'page_limit').length;
    expect(limitedBefore).toBeGreaterThan(300);
    const s = (await c.services.monitor.runNow('manual', SYSTEM_ACTOR)) as import('@sentinel/shared').SyncSummary;
    expect(s.state).toBe('crawling');
    expect(s.reasons.not_crawled).toBeGreaterThan(0);
    expect(Object.values(s.reasons).reduce((a, b) => a + (b ?? 0), 0)).toBeLessThanOrEqual(300);
    await c.services.crawls.idle();
    const run = (await c.repos.crawls.get(s.crawlRunId!))!;
    expect(run).toMatchObject({ type: 'sync', status: 'completed' });
    const rows = await allRows(c, run.id);
    // Same URL set as the Smart Crawl's results (plus any new URL), with fewer pages left unfetched.
    expect(rows.length).toBeGreaterThanOrEqual(baseRows.length);
    const limitedAfter = rows.filter((r) => r.crawlState === 'page_limit').length;
    expect(limitedAfter).toBeLessThanOrEqual(limitedBefore - s.reasons.not_crawled! + 5);
    expect(limitedAfter).toBeLessThan(limitedBefore);
  }, 240_000);

  it('with the default 10,000-page budget, a Smart Crawl of this ~2,400-page store is not cut short', async () => {
    const c = await containerFor();
    const started = await c.services.crawls.start(SYSTEM_ACTOR, 'smart');
    expect(started.smart?.budget).toBe(10000);
    await c.services.crawls.idle();
    const run = (await c.repos.crawls.get(started.id))!;
    expect(run.status).toBe('completed');
    expect(run.coverage!.processed).toBeGreaterThan(1500);
    expect(run.coverage!.pageLimited).toBe(0);
  }, 240_000);

  it('does not apply the Smart Crawl budget to a Full Crawl', async () => {
    const c = await containerFor();
    const started = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    expect(started.smart).toBeUndefined();
    await c.services.crawls.idle();
    const run = (await c.repos.crawls.get(started.id))!;
    expect(run.outcome).toBe('completed');
    expect(run.coverage!.processed).toBeGreaterThan(1500);
    expect(run.coverage!.pageLimited).toBe(0);
    expect(run.smart).toBeUndefined();
  }, 240_000);
});
