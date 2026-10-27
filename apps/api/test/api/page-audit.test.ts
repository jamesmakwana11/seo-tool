import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { auditPage, type CrawlPageReport, type CrawlPagesResponse, type CrawledUrl } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import type { CrawlEngine } from '../../src/services/ports';

/**
 * All Pages inventory and the per-page audit through the HTTP API. The engine is a stub returning fixed page rows — no
 * page is fetched and no network is used.
 */
const ORIGIN = 'https://audit-store.example';
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const page = (slug: string, over: Partial<CrawledUrl> = {}): CrawledUrl => ({
  url: `${ORIGIN}/products/${slug}`, status: 200, finalStatus: 200, reason: 'full', template: 'product', crawlState: 'fetched', contentType: 'text/html',
  title: `Kitchen ${slug} in stainless steel, set of three`, metaDescription: `Buy the ${slug}: stainless steel, easy to clean, dishwasher safe and built to last for years of everyday cooking.`,
  h1: [`Kitchen ${slug}`], h2Count: 1, headings: [{ level: 1, text: slug }, { level: 2, text: 'Features' }], canonical: `${ORIGIN}/products/${slug}`,
  indexable: true, indexabilityReason: 'Indexable', inSitemap: true, wordCount: 400, internalLinks: 40, inlinks: 3, brokenLinks: [], images: 4, imagesMissingAlt: 0, ...over,
});
const ROWS: CrawledUrl[] = [
  page('chopper'),
  page('grater', { title: '', imagesMissingAlt: 4 }),
  page('peeler', { metaDescription: undefined, h1: [], brokenLinks: [`${ORIGIN}/products/gone`] }),
  { url: `${ORIGIN}/products/gone`, status: 404, finalStatus: 404, reason: 'full', crawlState: 'fetched' },
  // Same title and meta description as the chopper.
  page('chopper-2', { title: 'Kitchen chopper in stainless steel, set of three', metaDescription: 'Buy the chopper: stainless steel, easy to clean, dishwasher safe and built to last for years of everyday cooking.' }),
];

const engine: CrawlEngine = {
  readiness: () => ({ ready: true, baseUrl: `${ORIGIN}/` }),
  async run() {
    return {
      urls: ROWS, findings: [], evaluatedChecks: [], evaluatedTemplates: {}, pageTexts: [],
      stats: { urlsPlanned: 5, urlsCrawled: 5, urlsFailed: 1, urlsSucceeded: 4, urlsDiscovered: 5, jsRenderedSample: 0, durationMs: 1, scope: [{ label: 'full', count: 5 }] },
    };
  },
};

describe('All Pages and the page audit API', () => {
  it('lists pages with scores, filters by check and score band, and returns a full page report', async () => {
    const container = await createContainer({
      env: loadEnv({ NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'p'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: ORIGIN, ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password }),
      engine,
    });
    const agent = supertest(createApp(container));
    const login = await agent.post('/api/auth/login').send(ADMIN);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const start = await agent.post('/api/crawls').set(auth).send({ type: 'full', options: { startUrl: `${ORIGIN}/`, maxPages: null, maxDepth: null, timeoutMs: 10000, concurrency: 2 } });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    await container.services.crawls.idle();
    const id = start.body.id as string;

    const all = (await agent.get(`/api/crawls/${id}/pages?limit=50`).set(auth)).body as CrawlPagesResponse;
    expect(all.total).toBe(5);
    expect(all.facets.check).toMatchObject({ 'title-missing': 1, 'alt-missing': 1, 'meta-missing': 1, 'h1-missing': 1, 'broken-links': 1, 'error-status': 1 });
    // chopper and its twin 90 (same title and description: two warnings); grater 70 (no title, no ALT on all 4 images);
    // peeler 55 (no meta, no H1, a broken link); the 404 scores 0.
    expect(all.facets.score).toEqual({ good: 2, fair: 2, poor: 1 });
    expect(all.scoreSummary?.average).toBe(Math.round((90 + 90 + 70 + 55 + 0) / 5));
    expect(all.scoreSummary?.byTemplate.product.pages).toBe(4);
    expect(all.auditLimits?.metaMaxChars).toBe(160);
    expect(all.rows.find((r) => r.url.endsWith('/chopper'))?.auditScore).toBe(90);
    expect(all.rows.find((r) => r.url.endsWith('/chopper'))?.auditTodo).toEqual(['title-duplicate', 'meta-duplicate']);

    const missing = (await agent.get(`/api/crawls/${id}/pages?check=title-missing`).set(auth)).body as CrawlPagesResponse;
    expect(missing.rows.map((r) => r.url)).toEqual([`${ORIGIN}/products/grater`]);
    const fair = (await agent.get(`/api/crawls/${id}/pages?score=fair&sort=score&dir=asc`).set(auth)).body as CrawlPagesResponse;
    expect(fair.rows.map((r) => r.auditScore)).toEqual([55, 70]);
    expect(((await agent.get(`/api/crawls/${id}/pages?score=poor`).set(auth)).body as CrawlPagesResponse).rows.map((r) => r.status)).toEqual([404]);

    const rep = await agent.get(`/api/crawls/${id}/page`).query({ url: `${ORIGIN}/products/peeler` }).set(auth);
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const report = rep.body as CrawlPageReport;
    expect(report.runId).toBe(id);
    expect(report.audit).toEqual(auditPage(report.row, report.limits));
    expect(report.audit.checks.filter((c) => c.status === 'fail').map((c) => c.id).sort()).toEqual(['broken-links', 'h1-missing', 'meta-missing']);
    expect(report.audit.checks.find((c) => c.id === 'broken-links')?.items).toEqual([`${ORIGIN}/products/gone`]);
    // "latest" resolves to the newest finished crawl; unknown URLs are a 404, a missing url a 400.
    const latest = (await agent.get('/api/crawls/latest/page').query({ url: `${ORIGIN}/products/chopper` }).set(auth)).body as CrawlPageReport;
    expect(latest.audit.score).toBe(90);
    // Duplicates carry the shared text, every other page and the exact count (H1 groups too).
    expect(latest.duplicates).toEqual({
      title: { text: 'Kitchen chopper in stainless steel, set of three', urls: [`${ORIGIN}/products/chopper-2`], total: 1 },
      meta: { text: 'Buy the chopper: stainless steel, easy to clean, dishwasher safe and built to last for years of everyday cooking.', urls: [`${ORIGIN}/products/chopper-2`], total: 1 },
      h1: { urls: [], total: 0 },
    });
    expect(report.duplicates).toEqual({ title: { urls: [], total: 0 }, meta: { urls: [], total: 0 }, h1: { urls: [], total: 0 } });
    // The export carries the score and what to fix.
    const csv = await agent.get(`/api/crawls/${id}/export?format=csv`).set(auth);
    expect(csv.status).toBe(200);
    const [head, ...lines] = csv.text.trim().split('\r\n');
    const cells = (l: string) => [...l.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1);
    const col = cells(head);
    const grater = cells(lines.find((l) => l.startsWith(`${ORIGIN}/products/grater`))!);
    expect(grater[col.indexOf('audit_score')]).toBe('70');
    expect(grater[col.indexOf('audit_to_do')]).toBe('Title missing | Images without ALT');
    expect((await agent.get(`/api/crawls/${id}/page`).query({ url: `${ORIGIN}/products/nope` }).set(auth)).status).toBe(404);
    expect((await agent.get(`/api/crawls/${id}/page`).set(auth)).status).toBe(400);
    // Without a second crawl there is no recorded change, and none is made up.
    const ch = await agent.get('/api/changes/for-url').query({ url: `${ORIGIN}/products/chopper` }).set(auth);
    expect(ch.status).toBe(200);
    expect(ch.body.change).toBeNull();
    // Sign-in is required.
    expect((await agent.get(`/api/crawls/${id}/page`).query({ url: `${ORIGIN}/products/chopper` })).status).toBe(401);
  }, 60000);
});
