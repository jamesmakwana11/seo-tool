import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChangeRecord, CrawlRun } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createChangeService } from '../../src/changes/service';
import { compare, type SnapRec } from '../../src/changes/snapshot';
import { SYSTEM_ACTOR, type Ctx } from '../../src/services/context';

/** Change Monitor rules on synthetic snapshots: baseline protection, confirmed vs suspected, retention, missing files. */
function harness(over: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-changes-unit-'));
  let now = new Date('2026-10-01T00:00:00Z');
  const env = loadEnv({ NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'u'.repeat(40), LOG_LEVEL: 'silent', CHANGE_SNAPSHOT_DIR: dir, ...over });
  const ctx = {
    env, clock: () => now, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    repos: { permissions: { get: async () => undefined } },
  } as unknown as Ctx;
  const svc = createChangeService(ctx, { siteUrl: async () => 'https://shop.test/', issuesFor: async () => new Map() });
  let n = 0;
  const record = async (type: CrawlRun['type'], outcome: string, recs: SnapRec[], status: CrawlRun['status'] = 'completed') => {
    n++;
    now = new Date(now.getTime() + 86400_000);
    const run = { id: `CRL-${n}`, type, status, outcome, startedAt: now.toISOString(), finishedAt: now.toISOString() } as unknown as CrawlRun;
    return svc.record(run, { snapshotRecords: recs });
  };
  const all = async (id: string) => {
    const out: ChangeRecord[] = [];
    for (let page = 1; ; page++) {
      const r = await svc.list(SYSTEM_ACTOR, id, { page, pageSize: 200 });
      out.push(...r.items);
      if (!r.items.length || out.length >= r.total) return out;
    }
  };
  return { svc, record, all, dir };
}

const U = (p: string) => `https://shop.test${p}`;
const page = (p: string, over: Partial<SnapRec> = {}): SnapRec => ({
  u: U(p), st: 'fetched', s: 200, fs: 200, tpl: 'product', t: `Title ${p}`, m: `Meta ${p}`, h1: [`H1 ${p}`], h2: ['Details'], h3: [], c: U(p),
  ix: 1, wc: 120, ch: `hash-${p}`, tx: `text of ${p}`, lc: 2, lh: 'links-a', l: ['/', '/collections/all'], ih: 'img-a', im: [['/a.webp', 'A']],
  sh: 'ld-a', sd: ['Product'], ah: 'as-a', as: ['/theme.css?v=1'], ...over,
});
const SITE = ['/', '/products/a', '/products/b', '/products/c', '/products/d'];

describe('Change Monitor rules', () => {
  it('partial and cancelled crawls are compared but never replace the last complete baseline', async () => {
    const h = harness();
    await h.record('full', 'completed', SITE.map((p) => page(p)));
    const base = (await h.svc.status(SYSTEM_ACTOR)).baseline!;
    // Partial crawl: reached 2 pages, one of them changed.
    const partial = await h.record('full', 'partial', [page('/'), page('/products/a', { t: 'New title' })]);
    expect(partial?.baselineEffect).toBe('kept');
    expect(partial?.baselineNote).toContain('never replaces it');
    expect(partial?.counts).toMatchObject({ changed: 1, unchanged: 1, unchecked: 3, removed: 0 }); // unreached = unchecked, never removed
    const cancelled = await h.record('full', 'cancelled', [page('/')], 'cancelled');
    expect(cancelled?.baselineEffect).toBe('kept');
    expect(cancelled?.counts?.removed).toBe(0);
    const failed = await h.record('full', 'failed', [page('/', { t: 'x' })], 'failed');
    expect(failed?.counts).toBeUndefined();
    expect(failed?.notes.join(' ')).toContain('not compared');
    expect((await h.svc.status(SYSTEM_ACTOR)).baseline).toEqual(base);
    // A smart crawl keeps the old title as the comparison point too (the partial crawl changed nothing).
    const recs = await h.all(partial!.snapshotId);
    expect(recs.find((r) => r.url === U('/products/a'))?.fields[0]).toMatchObject({ field: 'title', old: 'Title /products/a', new: 'New title' });
  });

  it('a partial first crawl cannot become the baseline', async () => {
    const h = harness();
    const s = await h.record('full', 'partial', [page('/')]);
    expect(s?.baselineEffect).toBe('kept');
    expect(s?.baselineNote).toContain('cannot become the baseline');
    expect((await h.svc.status(SYSTEM_ACTOR)).baseline).toBeNull();
  });

  it('confirmed vs suspected: 404 is removed, 503 / timeout is failed, missing from a complete full crawl is a suspected removal', async () => {
    const h = harness();
    await h.record('full', 'completed', SITE.map((p) => page(p)));
    const s = await h.record('full', 'completed', [
      page('/'),
      { u: U('/products/a'), st: 'fetched', s: 404, fs: 404, tpl: 'product' },
      { u: U('/products/b'), st: 'fetched', s: 503, fs: 503, tpl: 'product' },
      { u: U('/products/c'), st: 'fetched', s: null, fs: null, e: 'timeout', tpl: 'product' },
      page('/products/new'),
    ]);
    const recs = await h.all(s!.snapshotId);
    const k = (p: string) => recs.find((r) => r.url === U(p));
    expect(k('/products/a')).toMatchObject({ kind: 'removed', confidence: 'confirmed' });
    expect(k('/products/b')).toMatchObject({ kind: 'failed', confidence: 'confirmed' });
    expect(k('/products/c')).toMatchObject({ kind: 'failed' });
    expect(k('/products/d')).toMatchObject({ kind: 'removed', confidence: 'suspected' });
    expect(k('/products/d')?.evidence).toContain('not confirmed');
    expect(k('/products/new')).toMatchObject({ kind: 'new', confidence: 'confirmed' });
    expect(s?.counts?.suspected).toBe(1);
    // The failed pages keep their last good record in the new baseline: they come back as unchanged.
    const s3 = await h.record('full', 'completed', ['/', '/products/b', '/products/c', '/products/new'].map((p) => page(p)));
    const r3 = await h.all(s3!.snapshotId);
    expect(r3.find((r) => r.url === U('/products/b'))?.kind).toBe('unchanged');
    expect(r3.find((r) => r.url === U('/products/c'))?.kind).toBe('unchanged');
    // A smart crawl that does not reach a page reports it unchecked, never removed.
    const s4 = await h.record('smart', 'completed', [page('/')]);
    expect(s4?.counts?.removed).toBe(0);
    expect(s4?.counts?.unchecked).toBe(3);
  });

  it('a smart crawl merges its pages into the baseline; other pages keep their earlier data', async () => {
    const h = harness();
    await h.record('full', 'completed', SITE.map((p) => page(p)));
    const s = await h.record('smart', 'completed', [page('/products/a', { m: 'New meta' }), page('/products/zz')]);
    expect(s?.baselineEffect).toBe('merged');
    const st = await h.svc.status(SYSTEM_ACTOR);
    expect(st.baseline?.urls).toBe(6);
    expect(st.baseline?.mergedFrom).toEqual([s!.snapshotId]);
    // Next crawl compares /products/a against the merged (new) meta and the rest against the full crawl.
    const s2 = await h.record('full', 'completed', [...SITE.map((p) => page(p)), page('/products/zz')]);
    const r2 = await h.all(s2!.snapshotId);
    const a = r2.find((r) => r.url === U('/products/a'))!;
    expect(a.kind).toBe('changed');
    expect(a.fields[0]).toMatchObject({ field: 'meta', old: 'New meta', new: 'Meta /products/a' });
    expect(a.baselineRunId).toBe('CRL-2');
    expect(r2.find((r) => r.url === U('/products/b'))?.baselineRunId).toBe('CRL-1');
  });

  it('robots.txt blocks, redirects and status changes are reported; truncated pages make a difference suspected', async () => {
    const h = harness();
    await h.record('full', 'completed', SITE.map((p) => page(p)));
    const s = await h.record('full', 'completed', [
      page('/'),
      { u: U('/products/a'), st: 'robots', tpl: 'product' },
      { u: U('/products/b'), st: 'fetched', s: 301, fs: 200, rc: 1, fu: U('/products/b2'), tpl: 'product' },
      page('/products/c', { tr: 1, ch: 'other' }),
      page('/products/d', { lh: 'links-b', l: ['/', '/collections/all', '/pages/new'], lc: 3 }),
    ]);
    const recs = await h.all(s!.snapshotId);
    const k = (p: string) => recs.find((r) => r.url === U(p))!;
    expect(k('/products/a').fields[0]).toMatchObject({ field: 'indexability', new: 'blocked by robots.txt' });
    expect(k('/products/b').fields.map((f) => f.field)).toEqual(['status', 'redirect']);
    expect(k('/products/c')).toMatchObject({ kind: 'changed', confidence: 'suspected' });
    expect(k('/products/d').fields[0]).toMatchObject({ field: 'links', added: ['/pages/new'], removed: [] });
  });

  it('retention keeps the newest snapshots and always the baseline; a missing baseline file means "no baseline", not an error', async () => {
    const h = harness({ CHANGE_SNAPSHOT_KEEP: '2' });
    const first = await h.record('full', 'completed', SITE.map((p) => page(p)));
    for (let i = 0; i < 3; i++) await h.record('full', 'partial', [page('/')]);
    const st = await h.svc.status(SYSTEM_ACTOR);
    expect(st.runs).toHaveLength(2);
    expect(st.baseline?.snapshotId).toBe(first!.snapshotId); // the baseline survives retention
    const runFiles = fs.readdirSync(path.join(h.dir, 'shop.test', 'runs'));
    expect(runFiles.some((f) => f.startsWith(first!.snapshotId))).toBe(false);
    await expect(h.svc.list(SYSTEM_ACTOR, first!.snapshotId, {})).rejects.toThrow(/Change Monitor data/);
    // The baseline file disappears (ephemeral disk): the next crawl starts a new baseline instead of failing.
    for (const f of fs.readdirSync(path.join(h.dir, 'shop.test'))) if (f.startsWith('baseline-')) fs.rmSync(path.join(h.dir, 'shop.test', f));
    const again = await h.record('full', 'completed', SITE.map((p) => page(p)));
    expect(again?.baseline).toBeNull();
    expect(again?.baselineEffect).toBe('created');
  });

  it('compares field by field with old / new values and added / removed lists', () => {
    const o = page('/x', { h2: ['Details', 'Reviews'], im: [['/a.webp', 'Old alt'], ['/b.webp', null]], ih: 'i1', as: ['/theme.css?v=1'], ah: 'a1' });
    const n = page('/x', { h2: ['Details', 'FAQ'], im: [['/a.webp', 'New alt']], ih: 'i2', as: ['/theme.css?v=2'], ah: 'a2', sd: ['Product', 'FAQPage'], sh: 'ld-b' });
    const f = Object.fromEntries(compare(o, n).map((x) => [x.field, x]));
    expect(f.h2).toMatchObject({ added: ['FAQ'], removed: ['Reviews'] });
    expect(f.images.removed).toEqual(['/b.webp']);
    expect(f.images.note).toContain('“Old alt” → “New alt”');
    expect(f.assets.note).toContain('New version of: /theme.css');
    expect(f.structured_data.added).toEqual(['FAQPage']);
    expect(compare(o, o)).toEqual([]);
  });
});
