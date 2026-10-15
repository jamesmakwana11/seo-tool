import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { CrawlDetail, CrawlRun, CrawledUrl } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import type { CrawlEngine, CrawlPlan, Finding } from '../../src/services/ports';

/**
 * The crawl service handling a very large result. The engine is a stub that returns 20,000 page rows at once — no page
 * is fetched and no network is used. It checks that storing rows, the page inventory, issue tracking and progress writes
 * stay fast at this size (they used to grow with the square of the page count).
 */
const N = 20000;
const ORIGIN = 'https://big-store.example';
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };

function stubEngine(seen: { progressCalls: number; phases: string[]; plan?: CrawlPlan }): CrawlEngine {
  return {
    readiness: () => ({ ready: true, baseUrl: `${ORIGIN}/` }),
    async run(plan, onProgress) {
      seen.plan = plan;
      for (let i = 1; i <= N; i++) { onProgress?.(i, 0, N, i); seen.progressCalls++; }
      await new Promise((r) => setTimeout(r, 30));
      plan.onPhase?.('analysing');
      seen.phases.push('analysing');
      const urls: CrawledUrl[] = Array.from({ length: N }, (_, i) => ({
        url: `${ORIGIN}/products/p-${i}`, status: 200, finalStatus: 200, reason: 'full', depth: 2, indexable: true, indexabilityReason: 'Indexable',
        title: `Product ${i}`, internalLinks: 120, brokenLinks: [],
      }));
      const all = urls.map((u) => u.url);
      const findings: Finding[] = [
        { checkId: 'TECH-THIN', template: 'product', key: 'TECH-THIN::product', title: `${N} product pages have thin content`, summary: 'thin', urls: all, evidence: [{ kind: 'note', label: 'x' }] },
        { checkId: 'ONP-META', template: 'product', key: 'ONP-META::product', title: 'missing meta', summary: 'meta', urls: all.slice(0, N / 2), evidence: [{ kind: 'note', label: 'y' }] },
      ];
      return {
        urls, findings, evaluatedChecks: ['TECH-THIN', 'ONP-META'], evaluatedTemplates: { 'TECH-THIN': ['product'], 'ONP-META': ['product'] }, pageTexts: [],
        stats: { urlsPlanned: N, urlsCrawled: N, urlsFailed: 0, urlsSucceeded: N, urlsDiscovered: N, jsRenderedSample: 0, durationMs: 1, scope: [{ label: 'full', count: N }] },
      };
    },
  };
}

describe(`a ${N.toLocaleString('en-US')}-page crawl result`, () => {
  it('is stored, tracked and served without slowing down', async () => {
    const seen = { progressCalls: 0, phases: [] as string[] } as { progressCalls: number; phases: string[]; plan?: CrawlPlan };
    const container = await createContainer({
      env: loadEnv({ NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'z'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: ORIGIN, ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password }),
      engine: stubEngine(seen),
    });
    const agent = supertest(createApp(container));
    const login = await agent.post('/api/auth/login').send(ADMIN);
    const auth = { Authorization: `Bearer ${login.body.token}` };

    const t0 = Date.now();
    const res = await agent.post('/api/crawls').set(auth).send({ type: 'full', options: { startUrl: `${ORIGIN}/`, maxPages: null, maxDepth: null, timeoutMs: 10000, concurrency: 4 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await container.services.crawls.idle();
    const ms = Date.now() - t0;

    const d = (await agent.get(`/api/crawls/${res.body.id}`).set(auth)).body as CrawlDetail;
    const run = d.run as CrawlRun;
    expect(run.status).toBe('completed');
    expect(run.urlsCrawled).toBe(N);
    expect(d.urls.length).toBe(N);
    // Every row carries the issues seen on it.
    expect(d.urls[0].issues?.map((i) => i.checkId).sort()).toEqual(['ONP-META', 'TECH-THIN']);
    expect(d.urls[N - 1].issues?.map((i) => i.checkId)).toEqual(['TECH-THIN']);
    expect(await container.repos.sitePages.count()).toBe(N);
    const issues = (await container.repos.issues.list()).filter((i) => i.source === 'live');
    expect(issues.find((i) => i.checkId === 'TECH-THIN')?.affectedCount).toBe(N);
    expect(run.newIssues).toBe(2);
    // Progress was reported after every page, but written in a handful of coalesced updates.
    expect(seen.progressCalls).toBe(N);
    expect(seen.phases).toEqual(['analysing']);
    expect(run.phase).toBe('saving');
    // Generous bound: the old per-page inventory lookup alone took minutes at this size.
    expect(ms).toBeLessThan(60000);

    const csv = await agent.get(`/api/crawls/${res.body.id}/export?format=csv`).set(auth);
    expect(csv.status).toBe(200);
    expect(csv.text.trim().split('\n').length).toBe(N + 1);
  }, 120000);
});
