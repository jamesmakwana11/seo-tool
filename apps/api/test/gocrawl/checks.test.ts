import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from './goHelpers';

/**
 * Post-crawl check accounting end to end (Go crawler → API → run record): every group reports checked / failed /
 * deferred / excluded / reused, groups add up, image ALT findings need no image request, and a run never stays running.
 */
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => { await container?.services.crawls.idle(); await site?.close(); site = undefined; container = undefined; });

describe.skipIf(!HAVE_GO)('post-crawl checks (Go crawler)', () => {
  it('reports checked, failed, deferred and reused targets per group and ends the run', async () => {
    site = await startFixtureSite({ missingAlt: ['vegetable-chopper'], linkErrorRoutes: true, slowMs: 100 });
    const s = site;
    container = await createContainer({
      env: loadEnv({
        NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'k'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: s.origin, CRAWLER_REQUEST_DELAY_MS: '0',
        CRAWLER_RETRIES: '0', CRAWLER_ENGINE: 'go', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'checks-')),
      }),
    });
    const c = container;
    // A capped live crawl: the pages it did not fetch become link targets to check.
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual', { startUrl: `${s.origin}/`, maxPages: 6, maxDepth: null, timeoutMs: 5000, concurrency: 3, requestDelayMs: 0 });
    await c.services.crawls.idle();
    const done = (await c.repos.crawls.get(run.id))!;
    expect(['completed', 'partial']).toContain(done.outcome);
    expect(done.status).toBe('completed'); // finished, not left running
    const checks = done.coverage?.checks;
    expect(checks, 'check accounting reaches the run record').toBeDefined();
    for (const [name, g] of Object.entries(checks!.groups)) {
      expect((g.done ?? 0) + (g.deferred ?? 0), `group ${name} adds up`).toBe(g.total);
      expect(g.failed ?? 0).toBeLessThanOrEqual(g.done);
    }
    const links = checks!.groups.links;
    expect(links.total).toBeGreaterThan(0);
    expect(links.reused, 'pages the crawl fetched are not requested again').toBeGreaterThan(0);
    expect(done.timings?.checksBudgetMs).toBeGreaterThan(0);
    // Missing ALT is found from the HTML alone.
    const issues = await c.repos.issues.list();
    expect(issues.some((i) => i.checkId === 'ONP-ALT' || /alt/i.test(i.title))).toBe(true);
  }, 60_000);
});
