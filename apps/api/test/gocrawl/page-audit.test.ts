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
 * The page audit on data the Go crawler actually read from a local fixture store (no external website): every element
 * of the report comes from the crawled HTML, and the problems planted in the fixture are the ones reported.
 */
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => { await container?.services.crawls.idle(); await site?.close(); site = undefined; container = undefined; });

describe.skipIf(!HAVE_GO)('page audit of a Go crawl', () => {
  it('reports the planted problems with the evidence from the crawled HTML', async () => {
    site = await startFixtureSite({ missingAlt: ['vegetable-chopper'], missingCanonical: ['/products/silicone-spatula-set'], slowMs: 100 });
    const s = site;
    container = await createContainer({
      env: loadEnv({
        NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'k'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: s.origin, CRAWLER_REQUEST_DELAY_MS: '0',
        CRAWLER_RETRIES: '0', CRAWLER_ENGINE: 'go', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')),
      }),
    });
    const c = container;
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual', { startUrl: `${s.origin}/`, maxPages: null, maxDepth: null, timeoutMs: 5000, concurrency: 3, requestDelayMs: 0 });
    await c.services.crawls.idle();
    expect((await c.repos.crawls.get(run.id))!.status).toBe('completed');

    const chopper = await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}/products/vegetable-chopper`);
    const alt = chopper.audit.checks.find((x) => x.id === 'alt-missing');
    expect(alt, 'missing ALT is reported').toBeDefined();
    expect(alt!.items?.[0]).toMatch(/\/cdn\/img\//); // the image itself, read from the HTML
    expect(chopper.row.headings?.some((h) => h.level === 1)).toBe(true);
    expect(chopper.row.externalLinks).toBeGreaterThanOrEqual(0);
    expect(chopper.audit.score).toBeGreaterThan(0);
    expect(chopper.audit.score).toBeLessThan(100);

    const spatula = await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}/products/silicone-spatula-set`);
    expect(spatula.audit.checks.find((x) => x.id === 'canonical-missing')?.recommendation).toMatch(/canonical/);
    expect(chopper.audit.checks.find((x) => x.id === 'canonical-self')?.status).toBe('pass');

    const pages = await c.services.crawls.pages(SYSTEM_ACTOR, run.id, { check: 'alt-missing', limit: 50 });
    expect(pages.rows.map((r) => r.url)).toContain(`${s.origin}/products/vegetable-chopper`);
    expect(pages.scoreSummary?.scored).toBeGreaterThan(5);
    expect(pages.scoreSummary?.byTemplate.product).toBeDefined();
    // Every scored row's stored score is the score of its full report.
    const sample = (await c.services.crawls.pages(SYSTEM_ACTOR, run.id, { limit: 30, sort: 'score' })).rows.filter((r) => r.auditScore !== undefined).slice(0, 8);
    for (const r of sample) expect((await c.services.crawls.page(SYSTEM_ACTOR, run.id, r.url)).audit.score, r.url).toBe(r.auditScore);
  }, 90_000);
});
