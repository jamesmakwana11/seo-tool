import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type { ChangeListResponse, ChangeRecord } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureOptions, type FixtureSite } from '../crawler/fixtureSite';

/** Change Monitor end to end: two real crawls of the loopback fixture store, with the store changed in between. */
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => { await container?.services.crawls.idle(); await site?.close(); site = undefined; container = undefined; });

async function setup(engine: 'go' | 'node', initial?: Partial<FixtureOptions>) {
  site = await startFixtureSite(initial);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-changes-e2e-'));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'c'.repeat(40), LOG_LEVEL: 'silent',
    CRAWLER_BASE_URL: site.origin, CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_ALLOW_LIVE: 'false', CRAWLER_RETRIES: '0', CRAWLER_ENGINE: engine,
    CHANGE_SNAPSHOT_DIR: dir,
  });
  container = await createContainer({ env });
  return { site, container, dir };
}

async function crawl(c: Container, type: 'full' | 'smart' = 'full') {
  const run = await c.services.crawls.start(SYSTEM_ACTOR, type, 'manual');
  await c.services.crawls.idle();
  return (await c.repos.crawls.get(run.id))!;
}

async function all(c: Container, id: string): Promise<ChangeRecord[]> {
  const out: ChangeRecord[] = [];
  for (let page = 1; ; page++) {
    const r = await c.services.changes.list(SYSTEM_ACTOR, id, { page, pageSize: 200 });
    out.push(...r.items);
    if (out.length >= r.total || !r.items.length) return out;
  }
}

const P = (handle: string) => `/products/${handle}`;

for (const engine of ['go', 'node'] as const) {
  describe(`Change Monitor (${engine} engine)`, () => {
    it('the first completed crawl becomes the baseline; the next one reports what changed, with old and new values', async () => {
      const { site: s, container: c, dir } = await setup(engine);
      const first = await crawl(c);
      expect(first.status).toBe('completed');
      const st1 = await c.services.changes.status(SYSTEM_ACTOR);
      expect(st1.directory).toBe(dir);
      expect(st1.baseline?.runId).toBe(first.id);
      expect(st1.runs[0].baselineEffect).toBe('created');
      expect(st1.runs[0].counts).toBeUndefined();

      // Change the store: one kind of change per page.
      Object.assign(s.opts, {
        longTitle: [P('vegetable-chopper')],
        missingMeta: [P('silicone-spatula-set')],
        multipleH1: [P('airtight-container-1200')],
        missingCanonical: [P('led-fairy-lights-10m')],
        noindex: [P('artificial-money-plant')],
        aiBoilerplate: ['adhesive-wall-hooks'],
        missingAlt: ['adhesive-wall-hooks'],
        noOffers: ['artificial-money-plant'],
        deletedProducts: ['pull-back-racing-car'],
        unavailable: [P('building-blocks-100')],
      } satisfies Partial<FixtureOptions>);
      const second = await crawl(c);
      expect(second.status).toBe('completed');
      const sum = await c.services.changes.summary(SYSTEM_ACTOR, second.id);
      expect(sum.baseline?.runId).toBe(first.id);
      expect(sum.baselineEffect).toBe('replaced');
      const recs = await all(c, second.id);
      const by = (h: string) => recs.find((r) => r.url.endsWith(P(h)));
      const field = (h: string, f: string) => by(h)?.fields.find((x) => x.field === f);

      expect(by('vegetable-chopper')?.kind).toBe('changed');
      expect(field('vegetable-chopper', 'title')?.old).toBe('Manual Vegetable Chopper 5 Blade – Wholesale Price | DeoDap');
      expect(field('vegetable-chopper', 'title')?.new).toContain('Buy Wholesale Online in India');
      expect(field('silicone-spatula-set', 'meta')?.new).toBe('(none)');
      expect(field('airtight-container-1200', 'h1')?.added?.[0]).toContain('– Wholesale');
      expect(field('led-fairy-lights-10m', 'canonical')?.new).toBe('(none)');
      expect(field('artificial-money-plant', 'indexability')?.new).toContain('not indexable');
      expect(field('artificial-money-plant', 'structured_data')).toBeDefined();
      expect(field('adhesive-wall-hooks', 'content')?.old).toMatch(/^\d+ words/);
      expect(field('adhesive-wall-hooks', 'images')?.note).toContain('Alt text changed');
      // 404 → removed (confirmed); 503 → failed, never "removed".
      expect(by('pull-back-racing-car')).toMatchObject({ kind: 'removed', confidence: 'confirmed' });
      expect(by('building-blocks-100')).toMatchObject({ kind: 'failed', confidence: 'confirmed' });
      expect(by('building-blocks-100')?.evidence).toContain('does not prove the page was removed');
      // Pages nobody touched are unchanged, with when each version was observed.
      const home = recs.find((r) => new URL(r.url).pathname === '/');
      expect(home?.kind).toBe('unchanged');
      expect(home?.baselineObservedAt).toBe(first.startedAt);
      expect(home?.observedAt).toBe(second.startedAt);
      expect(sum.counts!.changed).toBeGreaterThanOrEqual(6);
      expect(sum.counts!.byField.title).toBeGreaterThanOrEqual(1);

      // Filters run on the server.
      const titles = await c.services.changes.list(SYSTEM_ACTOR, second.id, { field: 'title' });
      expect(titles.items.every((r) => r.fields.some((f) => f.field === 'title'))).toBe(true);
      const removed = await c.services.changes.list(SYSTEM_ACTOR, 'latest', { kind: 'removed' });
      expect(removed.items.map((r) => new URL(r.url).pathname)).toContain(P('pull-back-racing-car'));
      const search = await c.services.changes.list(SYSTEM_ACTOR, second.id, { q: 'spatula', pageSize: 1 });
      expect(search.items).toHaveLength(1);

      // The site recovers: the 503 page is compared with its last GOOD data (carried in the baseline), not the failure.
      s.opts.unavailable = [];
      const third = await crawl(c);
      const rec3 = await all(c, third.id);
      const blocks = rec3.find((r) => r.url.endsWith(P('building-blocks-100')));
      expect(blocks?.kind).toBe('unchanged');
      expect(blocks?.baselineRunId).toBe(first.id);
    }, 60_000);
  });
}

describe('Change Monitor API (HTTP)', () => {
  it('pages, details with issues, CSV / JSON exports, and an honest empty state', async () => {
    const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
    site = await startFixtureSite();
    const s = site;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-changes-api-'));
    container = await createContainer({
      env: loadEnv({
        NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'd'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: s.origin, CRAWLER_REQUEST_DELAY_MS: '0',
        CRAWLER_RETRIES: '0', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, CHANGE_SNAPSHOT_DIR: dir,
      }),
    });
    const c = container;
    const agent = supertest(createApp(c));
    expect([401, 403]).toContain((await agent.get('/api/changes/status')).status); // signed-in users only
    const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    const get = (p: string) => agent.get(p).set({ Authorization: `Bearer ${token}` });

    const empty = await get('/api/changes/status');
    expect(empty.status).toBe(200);
    expect(empty.body.baseline).toBeNull();
    expect(empty.body.persistentHint).toContain('CHANGE_SNAPSHOT_DIR');
    expect((await get('/api/changes/runs/latest/urls')).status).toBe(404);

    await crawl(c);
    s.opts.longTitle = [P('vegetable-chopper')];
    s.opts.productTemplateNoOffers = true;
    const second = await crawl(c);

    const sum = await get(`/api/changes/runs/${second.id}`);
    expect(sum.body.counts.changed).toBeGreaterThan(0);
    const page = await get(`/api/changes/runs/${second.id}/urls?kind=changed&pageSize=3&page=1`);
    expect(page.status).toBe(200);
    expect(page.body.items.length).toBeLessThanOrEqual(3);
    expect(page.body.total).toBe(sum.body.counts.changed);
    expect(page.body.items.every((r: ChangeRecord) => r.kind === 'changed')).toBe(true);
    const bad = await get(`/api/changes/runs/${second.id}/urls?pageSize=100000`);
    expect(bad.body.pageSize).toBe(200); // capped

    const d = await get(`/api/changes/runs/${second.id}/url?url=${encodeURIComponent(`${s.origin}${P('vegetable-chopper')}`)}`);
    expect(d.status).toBe(200);
    expect(d.body.fields.some((f: { field: string }) => f.field === 'title')).toBe(true);
    expect(d.body.issues.length).toBeGreaterThan(0); // the template schema defect raised issues on product pages

    const csv = await get(`/api/changes/runs/${second.id}/export?format=csv&kind=changed`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('.csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toContain('url,kind,confidence');
    expect(lines.length - 1).toBe(sum.body.counts.changed);
    const json = await get(`/api/changes/runs/${second.id}/export?format=json`);
    const parsed = JSON.parse(json.text) as { records: ChangeRecord[] };
    const total = (await get(`/api/changes/runs/${second.id}/urls`)).body.total;
    expect(parsed.records.length).toBe(total);
    expect(total).toBeGreaterThanOrEqual(sum.body.urls); // every URL of the crawl has a record (plus baseline URLs not reached)
    const res: ChangeListResponse = (await get(`/api/changes/runs/${second.id}/urls?q=chopper`)).body;
    expect(res.items.every((r) => r.url.includes('chopper') || r.fields.some((f) => `${f.old}${f.new}`.toLowerCase().includes('chopper')))).toBe(true);
  }, 60_000);
});
