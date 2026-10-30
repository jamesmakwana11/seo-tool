import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ImageAuditItem, ImageAuditJob } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { ADMIN, DB_URL, freshDatabase, sql, startServerProcess, type ServerProcess } from '../persistence/helpers';
import { HAVE_GO } from './goHelpers';

/**
 * Image Audit completion: it runs in rounds until every image has an answer, stores checkpoints, resumes with only the
 * images not answered yet, retries rate-limited images after Retry-After, and (with PostgreSQL) continues after a server
 * restart. Every image request is counted at the local fixture site: an answered image is never requested again.
 */
let site: FixtureSite | undefined;
let container: Container | undefined;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await container?.services.imageAudits.idle();
  await container?.services.crawls.idle();
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  await site?.close();
  site = undefined;
  container = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function envFor(base: string, extra: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'j'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: 'go',
    CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'imgresume-')),
    ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, ...extra,
  });
}
/** Image requests the fixture received (path → count), from index `from` of its request log. */
function imageRequests(s: FixtureSite, from = 0) {
  const n = new Map<string, number>();
  for (const r of s.requests.slice(from)) if (r.path.startsWith('/cdn/img/')) n.set(r.path, (n.get(r.path) ?? 0) + 1);
  return n;
}
const pathOf = (u: string) => { const x = new URL(u); return `${x.pathname}${x.search}`; };
async function allImages(c: Container, id: string): Promise<ImageAuditItem[]> {
  return (await c.services.imageAudits.list(SYSTEM_ACTOR, id, { limit: 500, sort: 'url', dir: 'asc' })).rows;
}
async function untilDone(get: () => Promise<ImageAuditJob>, ms = 120_000) {
  const t0 = Date.now();
  for (;;) {
    const j = await get();
    if (j.status !== 'running') return j;
    if (Date.now() - t0 > ms) throw new Error('audit did not finish');
    await sleep(200);
  }
}

describe.skipIf(!HAVE_GO)('Image Audit: rounds, checkpoints and resume', () => {
  it('continues in rounds until every image is answered — each unique image requested once — and only then shows 100 %', async () => {
    site = await startFixtureSite({ galleryImages: 5, sharedBanner: true });
    const s = site;
    // A short round (3 s) at 250 ms per image: several rounds are needed for ~50 images.
    container = await createContainer({ env: envFor(s.origin, { IMAGE_AUDIT_BUDGET_MINUTES: '0.05', IMAGE_AUDIT_CONCURRENCY: '1', CRAWLER_REQUEST_DELAY_MS: '250', IMAGE_AUDIT_CHECKPOINT_SECONDS: '1' }) });
    const c = container;
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    expect(imageRequests(s).size, 'the crawl itself requests no image').toBe(0);
    const from = s.requests.length;
    const job = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    expect(job.images).toBeGreaterThan(40);
    const mid = await (async () => { await sleep(1500); return c.services.imageAudits.get(SYSTEM_ACTOR, job.id); })();
    expect(mid.status).toBe('running');
    expect(mid.checkpoint?.storage).toBe('memory');
    const done = await untilDone(() => c.services.imageAudits.get(SYSTEM_ACTOR, job.id));
    expect(done.status).toBe('completed');
    expect(done.rounds, 'the time budget of one round was not enough: it continued').toBeGreaterThan(1);
    const k = done.counts;
    expect([k.pending, k.deferred]).toEqual([0, 0]);
    expect(k.finished).toBe(k.total);
    expect(k.ok + k.broken + k.failed + k.unverified).toBe(k.total);
    // Each unique image (deduplicated across pages) was requested exactly once.
    const req = imageRequests(s, from);
    const items = await allImages(c, job.id);
    expect(items.length).toBe(job.images);
    for (const it of items.filter((x) => x.state === 'ok' || x.state === 'broken')) expect(req.get(pathOf(it.url)), it.url).toBe(1);
    expect([...req.values()].every((n) => n === 1)).toBe(true);
    // The shared banner / logo appear on every page but are one image each.
    const banner = items.find((i) => i.url.endsWith('/cdn/img/banner.webp?v=1'))!;
    expect(banner.pageCount).toBeGreaterThan(10);
  }, 180_000);

  it('cancel then resume: only the images not answered are requested, none twice', async () => {
    site = await startFixtureSite({ galleryImages: 5 });
    const s = site;
    container = await createContainer({ env: envFor(s.origin, { IMAGE_AUDIT_CONCURRENCY: '1', CRAWLER_REQUEST_DELAY_MS: '200' }) });
    const c = container;
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    const from = s.requests.length;
    const job = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    for (let i = 0; i < 100 && (await c.services.imageAudits.get(SYSTEM_ACTOR, job.id)).counts.finished < 8; i++) await sleep(100);
    const cancelled = await c.services.imageAudits.cancel(SYSTEM_ACTOR, job.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.resumable).toBe(true);
    const answeredBefore = (await allImages(c, job.id)).filter((i) => i.state !== 'deferred').map((i) => pathOf(i.url));
    expect(answeredBefore.length).toBeGreaterThanOrEqual(8);
    expect(cancelled.counts.deferred).toBeGreaterThan(10);
    const mark = s.requests.length;

    const resumed = await c.services.imageAudits.resume(SYSTEM_ACTOR, job.id);
    expect(resumed.status).toBe('running');
    const done = await untilDone(() => c.services.imageAudits.get(SYSTEM_ACTOR, job.id));
    expect(done.status).toBe('completed');
    expect([done.counts.pending, done.counts.deferred]).toEqual([0, 0]);
    expect(done.resumes).toBe(1);
    const after = imageRequests(s, mark);
    for (const p of answeredBefore) expect(after.get(p), `${p} was answered before the resume`).toBeUndefined();
    // Overall: every image at most once (one image may have been in flight at the cancel).
    const overall = [...imageRequests(s, from).values()];
    expect(overall.filter((n) => n > 1).length).toBeLessThanOrEqual(1);
    await expect(c.services.imageAudits.resume(SYSTEM_ACTOR, job.id)).rejects.toThrow(/no image left/);
  }, 180_000);

  it('retries a rate-limited image after Retry-After instead of leaving it unverified', async () => {
    site = await startFixtureSite({ limitImages: { '/cdn/img/vegetable-chopper.webp': 1 } });
    const s = site;
    container = await createContainer({ env: envFor(s.origin, { IMAGE_AUDIT_RATE_LIMIT_PAUSE_SECONDS: '0' }) });
    const c = container;
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    const job = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    const done = await untilDone(() => c.services.imageAudits.get(SYSTEM_ACTOR, job.id));
    expect(done.status).toBe('completed');
    expect(done.rounds).toBe(2);
    const it = (await allImages(c, job.id)).find((i) => i.url.endsWith('/vegetable-chopper.webp'))!;
    expect([it.state, it.rateLimitedRounds]).toEqual(['ok', 1]);
    expect(imageRequests(s).get('/cdn/img/vegetable-chopper.webp')).toBe(2);
    expect(done.counts.unverified).toBe(0);
  }, 120_000);

  it('a new audit of a later crawl reuses recent answers instead of requesting the images again', async () => {
    site = await startFixtureSite({ galleryImages: 2 });
    const s = site;
    container = await createContainer({ env: envFor(s.origin) });
    const c = container;
    const r1 = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    const a1 = await c.services.imageAudits.start(SYSTEM_ACTOR, r1.id);
    await untilDone(() => c.services.imageAudits.get(SYSTEM_ACTOR, a1.id));
    const r2 = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    const mark = s.requests.length;
    const a2 = await c.services.imageAudits.start(SYSTEM_ACTOR, r2.id);
    const done = await untilDone(() => c.services.imageAudits.get(SYSTEM_ACTOR, a2.id));
    expect(done.status).toBe('completed');
    expect(done.counts.reused).toBe(done.counts.ok + done.counts.broken);
    expect(imageRequests(s, mark).size).toBe(0);
  }, 120_000);
});

describe.skipIf(!DB_URL || !HAVE_GO)('Image Audit across a server restart (PostgreSQL)', () => {
  const dbs: { drop: () => Promise<void> }[] = [];
  afterAll(async () => { for (const d of dbs) await d.drop().catch(() => undefined); });

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    it(`continues after a ${signal === 'SIGTERM' ? 'restart / redeploy (SIGTERM)' : 'crash (SIGKILL)'} without requesting the images answered before it`, async () => {
      const d = await freshDatabase();
      dbs.push(d);
      site = await startFixtureSite({ galleryImages: 5 });
      const s = site;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'img-restart-'));
      cleanups.push(async () => fs.rmSync(tmp, { recursive: true, force: true }));
      const env = {
        NODE_ENV: 'development', DATABASE_URL: d.url, SESSION_SECRET: 'q'.repeat(40), ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
        SEED_TEST_FIXTURES: 'false', LOG_LEVEL: 'warn', SCHEDULER_ENABLED: 'false', CRAWLER_BASE_URL: s.origin, CRAWLER_ENGINE: 'go', CRAWLER_RETRIES: '0',
        CRAWLER_REQUEST_DELAY_MS: '200', IMAGE_AUDIT_CONCURRENCY: '1', IMAGE_AUDIT_CHECKPOINT_SECONDS: '1',
        CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'),
      };
      const port = 45000 + Math.floor(Math.random() * 2000);
      let srv: ServerProcess = await startServerProcess(env, port);
      cleanups.push(() => srv.stop('SIGKILL'));
      const token = ((await (await srv.api('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()) as { token: string }).token;
      const runId = ((await (await srv.api('/crawls', { method: 'POST', body: JSON.stringify({ type: 'full' }) }, token)).json()) as { id: string }).id;
      for (let i = 0; i < 300; i++) {
        const st = ((await (await srv.api(`/crawls/${runId}`, {}, token)).json()) as { run: { status: string } }).run.status;
        if (st !== 'running' && st !== 'queued') break;
        await sleep(200);
      }
      const from = s.requests.length;
      const started = await srv.api('/image-audits', { method: 'POST', body: JSON.stringify({ runId }) }, token);
      expect(started.status, await started.clone().text()).toBe(202);
      const id = ((await started.json()) as ImageAuditJob).id;
      const get = async () => (await (await srv.api(`/image-audits/${id}`, {}, token)).json()) as ImageAuditJob;
      for (let i = 0; i < 200 && (await get()).counts.finished < 10; i++) await sleep(100);
      const before = (await get()).counts.finished;
      const answered = ((await (await srv.api(`/image-audits/${id}/images?limit=500`, {}, token)).json()) as { rows: ImageAuditItem[] }).rows
        .filter((i) => i.state !== 'pending').map((i) => pathOf(i.url));
      expect(answered.length).toBeGreaterThanOrEqual(10);
      // SIGKILL (crash): only what a checkpoint already holds survives — checkpoints are every second here.
      if (signal === 'SIGKILL') await sleep(1500);
      await srv.stop(signal);
      const stored = (await sql(d.url, `SELECT path FROM sentinel_files WHERE path LIKE 'image-audits/${id}/%'`)).rows.map((r) => r.path as string);
      expect(stored).toContain(`image-audits/${id}/items.ndjson.gz`);
      const mark = s.requests.length;

      srv = await startServerProcess(env, port);
      const back = await get();
      expect(back.status).toBe('running');
      expect(back.reason).toMatch(/Continued after a server restart/);
      expect(back.counts.finished).toBeGreaterThanOrEqual(before);
      let done: ImageAuditJob | undefined;
      for (let i = 0; i < 600 && !done; i++) { const j = await get(); if (j.status !== 'running') done = j; else await sleep(200); }
      expect(done?.status).toBe('completed');
      expect([done!.counts.pending, done!.counts.deferred]).toEqual([0, 0]);
      const after = imageRequests(s, mark);
      // Images answered before the stop are not requested again (SIGTERM: stored at shutdown; SIGKILL: in a checkpoint).
      for (const p of answered) expect(after.get(p), `${p} answered before the restart`).toBeUndefined();
      const overall = [...imageRequests(s, from).values()];
      expect(overall.filter((n) => n > 1).length).toBeLessThanOrEqual(signal === 'SIGTERM' ? 1 : 3);

      // The crawl's image references were stored with its results: a new audit of it still starts after the restart,
      // and reuses every answer (no image requested).
      const mark2 = s.requests.length;
      const again = await srv.api('/image-audits', { method: 'POST', body: JSON.stringify({ runId }) }, token);
      expect(again.status, await again.clone().text()).toBe(202);
      const a2 = (await again.json()) as ImageAuditJob;
      expect(a2.counts.reused).toBe(a2.counts.ok + a2.counts.broken);
      expect(imageRequests(s, mark2).size).toBe(0);
      expect(await srv.stop('SIGTERM')).toBe(0);
    }, 240_000);
  }
});
