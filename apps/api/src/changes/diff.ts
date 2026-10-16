/**
 * Streamed comparison of a crawl snapshot with the baseline, and the baseline updates. Memory stays bounded on 50,000-URL
 * crawls: only a short fingerprint per baseline URL is held (pass A); the current crawl is streamed (pass B); full old
 * records are joined in chunks for the changed URLs only (pass C).
 */
import fsp from 'node:fs/promises';
import type { ChangeCounts, ChangeKind, ChangeRecord } from '@sentinel/shared';
import { gzWriter, readNdjsonGz } from '../gocrawl/files';
import { compare, fingerprint, gone, ok, transientFailure, type SnapRec } from './snapshot';

/** A baseline record carries when (and by which crawl) it was observed. */
export interface BaseRec extends SnapRec {
  at: string;
  rid: string;
}

/** Changed pages joined with their old record per pass (each pair can be ~10 KB with 150 links: ~20 MB per chunk). */
const JOIN_CHUNK = 1000;

/**
 * URL of a snapshot line without parsing it: records are written with `u` first ({"u":"…",…}). Lines that do not
 * start that way, or whose URL holds an escape, return undefined and are parsed normally.
 */
export function lineUrl(line: string): string | undefined {
  if (!line.startsWith('{"u":"')) return undefined;
  const end = line.indexOf('"', 6);
  const u = line.slice(6, end);
  return end > 6 && !u.includes('\\') ? u : undefined;
}
/** Keep-filter for readNdjsonGz: only lines whose URL is in `set` (undecidable lines are kept and checked after parsing). */
const inSet = (set: { has(u: string): boolean }) => (line: string) => { const u = lineUrl(line); return u === undefined || set.has(u); };
const UNFETCHED = new Set(['excluded', 'depth_limit', 'page_limit', 'not_processed']);
const STATE_WORDS: Record<string, string> = {
  excluded: 'excluded by the crawl settings', depth_limit: 'beyond the depth limit', page_limit: 'the page limit was reached', not_processed: 'the crawl stopped before reaching it',
};

export function statusText(r: SnapRec): string {
  if (r.st === 'robots') return 'blocked by robots.txt';
  if (UNFETCHED.has(r.st)) return `not fetched (${STATE_WORDS[r.st] ?? r.st})`;
  if (r.s === null || r.s === undefined) return r.e ? `no answer (${r.e})` : 'no answer';
  if (r.fu) return `${r.s} → ${r.fs ?? 'no answer'} (${r.fu})`;
  return String(r.fs ?? r.s);
}

type BaseClass = 'ok' | 'gone' | 'fail' | 'robots' | 'unf' | 'other';
function classOf(r: SnapRec): BaseClass {
  if (r.st === 'robots') return 'robots';
  if (UNFETCHED.has(r.st)) return 'unf';
  if (transientFailure(r)) return 'fail';
  if (gone(r)) return 'gone';
  if (ok(r) || (r.fs !== null && r.fs !== undefined && r.fs < 400)) return 'ok';
  return 'other';
}

export interface CompareInput {
  current: AsyncIterable<SnapRec>;
  baselineFile: string;
  /** This crawl: a complete full crawl may call URLs it never found "removed (suspected)"; other crawls call them "unchecked". */
  completeFull: boolean;
  crawlLabel: string;
  observedAt: string;
  notableFile: string;
  quietFile: string;
  /** Temp file for the changed pages waiting for their old record. */
  pendingFile: string;
}

export interface CompareOutput {
  counts: ChangeCounts;
  truncatedPages: number;
  /** URLs whose current record must not replace their baseline record, which holds page data (failures, not fetched this time). */
  keepOld: number;
  carry: Set<string>;
  /** Records in this crawl's snapshot. */
  current: number;
}

const emptyCounts = (): ChangeCounts => ({ new: 0, removed: 0, failed: 0, changed: 0, unchanged: 0, unchecked: 0, suspected: 0, byField: {} });

export async function compareWithBaseline(i: CompareInput): Promise<CompareOutput> {
  const counts = emptyCounts();
  const notable = gzWriter(i.notableFile);
  const quiet = gzWriter(i.quietFile);
  const pending = gzWriter(i.pendingFile);
  let pendingCount = 0;
  let truncatedPages = 0;
  let keepOld = 0;
  const carry = new Set<string>();
  const emit = async (rec: ChangeRecord) => {
    counts[rec.kind]++;
    if (rec.confidence === 'suspected' && rec.kind !== 'unchecked' && rec.kind !== 'unchanged') counts.suspected++;
    if (rec.kind === 'changed') for (const f of rec.fields) counts.byField[f.field] = (counts.byField[f.field] ?? 0) + 1;
    await (rec.kind === 'unchanged' || rec.kind === 'unchecked' ? quiet : notable).write(rec);
  };

  // ---- pass A: a fingerprint per baseline URL (repeated strings — times, crawl ids, templates, statuses — are shared)
  type Idx = { fp: string; cls: BaseClass; status: string; at: string; rid: string; tpl?: string; seen?: 1 };
  const index = new Map<string, Idx>();
  const pool = new Map<string, string>();
  const intern = <T extends string | undefined>(v: T): T => { if (v === undefined) return v; const x = pool.get(v); if (x !== undefined) return x as T; if (pool.size < 50_000) pool.set(v, v); return v; };
  for await (const b of readNdjsonGz<BaseRec>(i.baselineFile)) {
    index.set(b.u, { fp: fingerprint(b), cls: classOf(b), status: intern(statusText(b)), at: intern(b.at), rid: intern(b.rid), tpl: intern(b.tpl) });
  }

  // ---- pass B: classify every URL of this crawl
  let currentCount = 0;
  for await (const n of i.current) {
    currentCount++;
    const b = index.get(n.u);
    if (b) b.seen = 1;
    if (n.tr) truncatedPages++;
    const base = (kind: ChangeKind, confidence: ChangeRecord['confidence'], evidence: string): ChangeRecord => ({
      url: n.u, kind, confidence, evidence, template: n.tpl ?? b?.tpl, observedAt: i.observedAt, status: statusText(n), fields: [],
      ...(b ? { baselineObservedAt: b.at, baselineRunId: b.rid, baselineStatus: b.status } : {}),
    });
    if (UNFETCHED.has(n.st)) {
      if (b) {
        if (b.cls !== 'unf') { keepOld++; carry.add(n.u); }
        await emit(base('unchecked', 'confirmed', b.cls === 'unf' ? `Not fetched in this crawl or the baseline: ${STATE_WORDS[n.st] ?? n.st}.` : `Not fetched by this crawl: ${STATE_WORDS[n.st] ?? n.st}. Its last observed data is kept.`));
      }
      else await emit(base('new', 'suspected', `Found for the first time (${STATE_WORDS[n.st] ?? n.st}), but not fetched, so its content is unknown.`));
      continue;
    }
    if (!b) {
      if (transientFailure(n)) await emit(base('failed', 'confirmed', `New URL that did not answer usefully (${statusText(n)}).`));
      else await emit(base('new', 'confirmed', `Not in the baseline: first seen in this crawl (${statusText(n)}).`));
      continue;
    }
    if (b.cls === 'unf') {
      await emit(base('new', 'suspected', 'The baseline found this URL but did not fetch it, so there is nothing to compare with. Its current data becomes the baseline.'));
      continue;
    }
    if (transientFailure(n)) {
      if (b.cls !== 'fail') { keepOld++; carry.add(n.u); }
      await emit(base('failed', 'confirmed', `Did not answer usefully (${statusText(n)}). A failure does not prove the page was removed: it is not reported as removed and its last good data stays in the baseline.`));
      continue;
    }
    if (n.st === 'robots' || b.cls === 'robots') {
      if (n.st === 'robots' && b.cls === 'robots') { await emit(base('unchanged', 'confirmed', 'Still blocked by robots.txt.')); continue; }
      const rec = base('changed', 'confirmed', n.st === 'robots' ? 'Now blocked by robots.txt (it was fetched before).' : 'No longer blocked by robots.txt.');
      rec.fields.push({ field: 'indexability', old: b.status, new: statusText(n), confidence: 'confirmed' });
      await emit(rec);
      continue;
    }
    if (gone(n)) {
      if (b.cls === 'gone') await emit(base('unchanged', 'confirmed', `Still answers ${n.fs}.`));
      else {
        const rec = base('removed', 'confirmed', `Answered ${n.fs} in this crawl (it answered ${b.status} on ${b.at.slice(0, 10)}).`);
        rec.fields.push({ field: 'status', old: b.status, new: statusText(n), confidence: 'confirmed' });
        await emit(rec);
      }
      continue;
    }
    if (fingerprint(n) === b.fp) { await emit(base('unchanged', 'confirmed', 'Same status, title, meta, headings, canonical, indexability, content, links, images, structured data and assets.')); continue; }
    await pending.write(n);
    pendingCount++;
  }
  await pending.close();

  // ---- URLs of the baseline this crawl never reached
  for (const [url, b] of index) {
    if (b.seen) continue;
    const rec: ChangeRecord = { url, kind: 'unchecked', confidence: 'confirmed', evidence: '', template: b.tpl, observedAt: i.observedAt, baselineObservedAt: b.at, baselineRunId: b.rid, baselineStatus: b.status, fields: [] };
    if (i.completeFull && (b.cls === 'ok' || b.cls === 'other')) {
      rec.kind = 'removed';
      rec.confidence = 'suspected';
      rec.evidence = 'Not found by this complete full crawl: no link or sitemap entry led to it. It may have been deleted or only unlinked — it was not requested, so the removal is not confirmed.';
    } else if (i.completeFull && b.cls === 'gone') {
      continue; // was already gone and is no longer linked: nothing to report, and it leaves the baseline
    } else {
      rec.evidence = `Not reached by this crawl (${i.crawlLabel}). Its last observed data is kept in the baseline.`;
    }
    await emit(rec);
  }
  index.clear();

  // ---- pass C: changed pages — join their old records chunk by chunk
  if (pendingCount) {
    let chunk = new Map<string, SnapRec>();
    const run = async () => {
      if (!chunk.size) return;
      const old = new Map<string, BaseRec>();
      for await (const b of readNdjsonGz<BaseRec>(i.baselineFile, undefined, inSet(chunk))) if (chunk.has(b.u)) old.set(b.u, b);
      for (const [url, n] of chunk) {
        const o = old.get(url);
        if (!o) continue;
        const fields = compare(o, n);
        const rec: ChangeRecord = {
          url, kind: fields.length ? 'changed' : 'unchanged', confidence: fields.length && fields.every((f) => f.confidence === 'suspected') ? 'suspected' : 'confirmed',
          evidence: fields.length ? `${fields.length} field${fields.length === 1 ? '' : 's'} differ from the baseline observed on ${o.at.slice(0, 10)}.` : 'No SEO-relevant difference.',
          template: n.tpl ?? o.tpl, observedAt: i.observedAt, baselineObservedAt: o.at, baselineRunId: o.rid, status: statusText(n), baselineStatus: statusText(o), fields,
        };
        await emit(rec);
      }
      chunk = new Map();
    };
    for await (const n of readNdjsonGz<SnapRec>(i.pendingFile)) {
      chunk.set(n.u, n);
      if (chunk.size >= JOIN_CHUNK) await run();
    }
    await run();
  }
  await fsp.rm(i.pendingFile, { force: true });
  await notable.close();
  await quiet.close();
  return { counts, truncatedPages, keepOld, carry, current: currentCount };
}

/** Records that must not replace a baseline record: failures and URLs this crawl did not fetch. */
const keepsOld = (n: SnapRec) => UNFETCHED.has(n.st) || transientFailure(n);

/**
 * New baseline after a completed FULL crawl: this crawl's records, except where the crawl failed to fetch a URL whose
 * baseline record holds page data — then that record is carried over (`carryUrls`, found by the comparison; without it
 * every failure is looked up). URLs the crawl never found leave the baseline.
 */
export async function replaceBaseline(current: () => AsyncIterable<SnapRec>, oldFile: string | undefined, outFile: string, at: string, rid: string, carryUrls?: Set<string>): Promise<number> {
  const out = gzWriter(outFile);
  let n = 0;
  let carry = new Map<string, SnapRec>();
  const flushCarry = async () => {
    if (!carry.size) return;
    const found = new Set<string>();
    if (oldFile) {
      for await (const b of readNdjsonGz<BaseRec>(oldFile, undefined, inSet(carry))) {
        if (!carry.has(b.u) || keepsOld(b)) continue;
        await out.write(b);
        found.add(b.u);
        n++;
      }
    }
    for (const [u, r] of carry) if (!found.has(u)) { await out.write({ ...r, at, rid }); n++; }
    carry = new Map();
  };
  for await (const r of current()) {
    if (keepsOld(r) && oldFile && (!carryUrls || carryUrls.has(r.u))) {
      carry.set(r.u, r);
      if (carry.size >= JOIN_CHUNK) await flushCarry();
      continue;
    }
    await out.write({ ...r, at, rid });
    n++;
  }
  await flushCarry();
  await out.close();
  return n;
}

/**
 * New baseline after a completed SMART crawl: the old baseline, with the URLs this crawl fetched replaced and new URLs
 * added. Failures and URLs not fetched keep their old record. Smart crawls are budgeted (hundreds to a few thousand pages),
 * so their records are held in memory; above MERGE_LIMIT the merge is done in several passes.
 */
export async function mergeIntoBaseline(current: () => AsyncIterable<SnapRec>, oldFile: string, outFile: string, at: string, rid: string): Promise<number> {
  const MERGE_LIMIT = 20_000;
  let src = oldFile;
  let n = 0;
  let pass = 0;
  const it = current()[Symbol.asyncIterator]();
  let done = false;
  while (!done) {
    const repl = new Map<string, SnapRec>();
    while (repl.size < MERGE_LIMIT) {
      const x = await it.next();
      if (x.done) { done = true; break; }
      if (!keepsOld(x.value)) repl.set(x.value.u, x.value);
    }
    if (!repl.size && pass > 0) break;
    const dst = `${outFile}.pass${pass}`;
    const out = gzWriter(dst);
    n = 0;
    for await (const b of readNdjsonGz<BaseRec>(src)) {
      const r = repl.get(b.u);
      if (r) { await out.write({ ...r, at, rid }); repl.delete(b.u); } else await out.write(b);
      n++;
    }
    for (const r of repl.values()) { await out.write({ ...r, at, rid }); n++; }
    await out.close();
    if (src !== oldFile) await fsp.rm(src, { force: true });
    src = dst;
    pass++;
  }
  await fsp.rename(src, outFile);
  return n;
}

/** First baseline: this crawl's records as they are (a failure is replaced by the first good answer in a later crawl). */
export async function firstBaseline(current: () => AsyncIterable<SnapRec>, outFile: string, at: string, rid: string): Promise<number> {
  const out = gzWriter(outFile);
  let n = 0;
  for await (const r of current()) { await out.write({ ...r, at, rid }); n++; }
  await out.close();
  return n;
}
