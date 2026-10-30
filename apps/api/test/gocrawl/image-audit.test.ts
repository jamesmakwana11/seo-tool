import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import supertest from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ImageAuditItem } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from './goHelpers';

/**
 * Image Audit end to end on local fixtures only (127.0.0.1): a normal crawl makes no image request and starts no audit;
 * ALT findings still come from the HTML; the audit checks each unique image once and reports available, broken and
 * heavy images, duplicates and HTML facts; re-running reuses answers; cancelling defers what is left; exports work.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => {
  await container?.services.imageAudits.idle();
  await container?.services.crawls.idle();
  await site?.close();
  site = undefined;
  container = undefined;
});

function envFor(base: string, extra: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'i'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: 'go',
    CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'imgaudit-')),
    ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, ...extra,
  });
}

async function allImages(c: Container, id: string): Promise<ImageAuditItem[]> {
  const out: ImageAuditItem[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await c.services.imageAudits.list(SYSTEM_ACTOR, id, { offset, limit: 500, sort: 'url', dir: 'asc' });
    out.push(...r.rows);
    if (offset + 500 >= r.total) return out;
  }
}

describe.skipIf(!HAVE_GO)('Image Audit', () => {
  it('runs only when started, checks each unique image once and reports what it found', async () => {
    site = await startFixtureSite({ missingAlt: ['vegetable-chopper'], largeImage: ['led-fairy-lights-10m'], brokenImages: ['artificial-money-plant'], sharedBanner: true, slowMs: 50 });
    const s = site;
    container = await createContainer({ env: envFor(s.origin) });
    const c = container;

    // ---- a normal crawl: no image request, no audit, ALT still found from the HTML
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    const done = (await c.repos.crawls.get(run.id))!;
    expect(done.outcome).toBe('completed');
    expect(s.requests.filter((r) => r.path.startsWith('/cdn/img/')), 'the crawl requested images').toEqual([]);
    expect(done.coverage?.checks?.groups.images, 'no image check group in a normal crawl').toBeUndefined();
    const issues = await c.repos.issues.list();
    expect(issues.some((i) => i.checkId === 'ONP-IMAGES' && i.affectedUrls.some((u) => u.endsWith('/products/vegetable-chopper')))).toBe(true);
    expect(issues.some((i) => i.checkId === 'PERF-IMAGES' && /heavier than/.test(JSON.stringify(i))), 'no image weight is claimed without a measurement').toBe(false);
    const chopperRow = (await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}/products/vegetable-chopper`)).row;
    expect(chopperRow.imagesMissingAlt).toBe(2); // the product photo without alt + the banner with alt=""

    const st = await c.services.imageAudits.status(SYSTEM_ACTOR);
    expect(st.available).toBe(true);
    expect(st.runs.map((r) => r.runId)).toContain(run.id);
    expect(st.running).toBeUndefined();
    expect(st.jobs).toEqual([]);

    // ---- the audit
    const job = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    expect(job.status).toBe('running');
    await expect(c.services.imageAudits.start(SYSTEM_ACTOR, run.id)).rejects.toThrow(/still running/);
    await c.services.imageAudits.idle();
    const fin = await c.services.imageAudits.get(SYSTEM_ACTOR, job.id);
    expect(fin.status).toBe('completed');
    const imgs = await allImages(c, job.id);
    expect(fin.counts.total).toBe(imgs.length);
    expect(fin.counts.pending).toBe(0);
    expect(fin.counts.ok + fin.counts.broken + fin.counts.failed + fin.counts.unverified + fin.counts.deferred).toBe(fin.counts.total);
    const by = (p: string) => imgs.find((i) => i.url === `${s.origin}${p}`)!;

    // Each unique image requested once (the banner is on every page).
    const gets = s.requests.filter((r) => r.path.startsWith('/cdn/img/'));
    const perPath = new Map<string, number>();
    for (const g of gets) perPath.set(g.path, (perPath.get(g.path) ?? 0) + 1);
    for (const [p, n] of perPath) expect(n, p).toBe(1);
    const banner = by('/cdn/img/banner.webp?v=1');
    expect(banner.pageCount).toBe(fin.pages);
    expect(banner.pageCount).toBeGreaterThan(10);
    expect(banner.state).toBe('ok');
    expect(banner.altEmpty).toBe(banner.refs);
    expect(banner.noDimensions).toBe(banner.refs);
    expect(banner.issues).toEqual(expect.arrayContaining(['alt-empty', 'no-dimensions', 'duplicate']));
    expect(banner.duplicateUrls).toBe(1);
    expect(by('/cdn/img/banner.webp?v=2').duplicateOf).toBe(banner.url);

    const broken = by('/cdn/img/missing-artificial-money-plant.webp');
    expect([broken.state, broken.status, broken.issues.includes('broken')]).toEqual(['broken', 404, true]);
    expect(broken.pages).toEqual([`${s.origin}/products/artificial-money-plant`]);

    const big = by('/cdn/img/big-photo.jpg');
    expect([big.state, big.bytes, big.format]).toEqual(['ok', 300 * 1024, 'jpeg']);
    expect(big.issues).toEqual(expect.arrayContaining(['heavy', 'legacy-format']));
    expect(big.recommendations.join(' ')).toMatch(/300 KB/);

    const chopper = by('/cdn/img/vegetable-chopper.webp');
    expect([chopper.state, chopper.altMissing, chopper.htmlWidth, chopper.htmlHeight]).toEqual(['ok', 1, 800, 800]);
    expect(chopper.issues).toContain('alt-missing');
    expect(chopper.format).toBe('webp');

    // Filters and facets.
    const brokenList = await c.services.imageAudits.list(SYSTEM_ACTOR, job.id, { state: 'broken' });
    expect(brokenList.rows.map((r) => r.url)).toEqual([broken.url]);
    expect(brokenList.facets.state.broken).toBe(1);
    expect((await c.services.imageAudits.list(SYSTEM_ACTOR, job.id, { issue: 'alt-missing' })).rows.map((r) => r.url)).toContain(chopper.url);

    // ---- export over HTTP (CSV and JSON)
    const agent = supertest(createApp(c));
    const login = await agent.post('/api/auth/login').send(ADMIN);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const csv = await agent.get(`/api/image-audits/${job.id}/export?format=csv`).set(auth);
    expect(csv.status).toBe(200);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0].startsWith('image_url,state,reason')).toBe(true);
    expect(lines.length).toBe(imgs.length + 1);
    const json = await agent.get(`/api/image-audits/${job.id}/export?format=json&state=broken`).set(auth);
    expect(JSON.parse(json.text).images.map((i: ImageAuditItem) => i.url)).toEqual([broken.url]);
    expect((await agent.get(`/api/image-audits/${job.id}/images?issue=heavy`).set(auth)).body.rows.map((i: ImageAuditItem) => i.url)).toEqual([big.url]);

    // ---- a second audit of the same crawl reuses the answers: nothing is requested again
    const before = s.requests.filter((r) => r.path.startsWith('/cdn/img/')).length;
    const again = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    await c.services.imageAudits.idle();
    const fin2 = await c.services.imageAudits.get(SYSTEM_ACTOR, again.id);
    expect(fin2.status).toBe('completed');
    expect(fin2.counts.reused).toBe(fin2.counts.ok + fin2.counts.broken);
    expect(s.requests.filter((r) => r.path.startsWith('/cdn/img/')).length).toBe(before);
  }, 120_000);
});

// ---- cancellation and progress on a larger local store
const root = path.resolve(__dirname, '../../../..');
let store: ChildProcess | undefined;
afterAll(() => { store?.kill('SIGTERM'); });

describe.skipIf(!HAVE_GO)('Image Audit cancellation', () => {
  it('reports progress and defers the images it did not check when cancelled', async () => {
    store = spawn(process.execPath, [path.join(root, 'tools/synthetic-store/server.mjs'), '--products', '1500'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ready = await new Promise<{ url: string }>((resolve, reject) => {
      readline.createInterface({ input: store!.stdout! }).once('line', (l) => resolve(JSON.parse(l)));
      store!.once('exit', (code) => reject(new Error(`synthetic store exited ${code}`)));
    });
    const base = ready.url.replace(/\/$/, '');
    container = await createContainer({ env: envFor(base, { IMAGE_AUDIT_CONCURRENCY: '1', CRAWLER_REQUEST_DELAY_MS: '5' }) });
    const c = container;
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    const job = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    expect(job.images).toBeGreaterThan(2000);
    let seen = 0;
    for (let i = 0; i < 100 && seen < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      seen = (await c.services.imageAudits.get(SYSTEM_ACTOR, job.id)).counts.checked;
    }
    expect(seen, 'progress is reported while it runs').toBeGreaterThan(0);
    const cancelled = await c.services.imageAudits.cancel(SYSTEM_ACTOR, job.id);
    expect(cancelled.status).toBe('cancelled');
    const k = cancelled.counts;
    expect(k.pending).toBe(0);
    expect(k.deferred).toBeGreaterThan(1000);
    expect(k.ok).toBeGreaterThan(0);
    expect(k.ok + k.broken + k.failed + k.unverified + k.deferred).toBe(k.total);
    const deferred = await c.services.imageAudits.list(SYSTEM_ACTOR, job.id, { state: 'deferred', limit: 5 });
    for (const d of deferred.rows) {
      expect(d.reason).toMatch(/cancelled/);
      expect(d.status ?? null).toBeNull();
      expect(d.bytes).toBeUndefined();
    }
  }, 180_000);
});
