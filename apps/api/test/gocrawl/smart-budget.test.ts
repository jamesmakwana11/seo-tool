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
 * a Smart Crawl fetches at most 1,000 pages and reports the eligible URLs it left as pending; a Full Crawl on the same
 * store is not limited by that budget.
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

async function containerFor() {
  return createContainer({
    env: loadEnv({
      NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'b'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: 'go',
      CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'budget-')),
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
  it('is 1,000 pages', () => {
    expect(SMART_CRAWL_PAGE_BUDGET).toBe(1000);
    expect(loadEnv({ NODE_ENV: 'test' }).CRAWLER_SMART_MAX_PAGES).toBe(1000);
    expect(() => loadEnv({ NODE_ENV: 'test', CRAWLER_SMART_MAX_PAGES: '5000' })).toThrow();
  });

  it('stops a Smart Crawl at 1,000 pages and reports the pending eligible URLs; never as crawled or passed', async () => {
    const c = await containerFor();
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

  it('does not apply the Smart Crawl budget to a Full Crawl', async () => {
    const c = await containerFor();
    const started = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    expect(started.smart).toBeUndefined();
    await c.services.crawls.idle();
    const run = (await c.repos.crawls.get(started.id))!;
    expect(run.outcome).toBe('completed');
    expect(run.coverage!.processed).toBeGreaterThan(SMART_CRAWL_PAGE_BUDGET + 500);
    expect(run.coverage!.pageLimited).toBe(0);
    expect(run.smart).toBeUndefined();
  }, 240_000);
});
