/**
 * Change Monitor service: records every crawl's snapshot, compares it with the baseline (the last valid crawl), keeps the
 * baseline up to date, and serves the change lists (paged and filtered on the server, exported as streams).
 */
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import {
  CHANGE_FIELD_LABELS, type ChangeDetail, type ChangeKind, type ChangeListQuery, type ChangeListResponse, type ChangeMonitorStatus,
  type ChangeRecord, type ChangeRunSummary, type CrawlRun,
} from '@sentinel/shared';
import { gzWriter, readNdjsonGz } from '../gocrawl/files';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { need, type Actor, type Ctx } from '../services/context';
import type { EngineRunResult } from '../services/ports';
import { compareWithBaseline, firstBaseline, mergeIntoBaseline, replaceBaseline } from './diff';
import type { SnapRec } from './snapshot';
import { createChangeStore, type BaselineMeta, type ChangeStore } from './store';

const NOTABLE = new Set<ChangeKind>(['new', 'removed', 'failed', 'changed']);
const QUIET = new Set<ChangeKind>(['unchanged', 'unchecked']);
const MAX_PAGE_SIZE = 200;

export interface ChangeServiceDeps {
  /** The website's address (its host names the snapshot folder). */
  siteUrl: () => Promise<string>;
  /** Open issues on these URLs. */
  issuesFor: (urls: string[]) => Promise<Map<string, ChangeDetail['issues']>>;
}

export function defaultChangeDir(env: Ctx['env']): string {
  if (env.CHANGE_SNAPSHOT_DIR) return path.resolve(env.CHANGE_SNAPSHOT_DIR);
  // Tests: a private folder per process, so one test run never sees another run's baseline.
  if (process.env.VITEST || env.NODE_ENV === 'test') return fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-changes-test-'));
  return path.join(os.tmpdir(), 'sentinel-changes');
}

export const urlKey = (u: string) => {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
};

const compact = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function matches(r: ChangeRecord, q: ChangeListQuery, needle: string | undefined) {
  if (q.kind && q.kind !== 'all' && r.kind !== q.kind) return false;
  if (q.field && !r.fields.some((f) => f.field === q.field)) return false;
  if (q.confidence && r.confidence !== q.confidence) return false;
  if (q.template && r.template !== q.template) return false;
  if (needle && !r.url.toLowerCase().includes(needle) && !r.fields.some((f) => (f.old ?? '').toLowerCase().includes(needle) || (f.new ?? '').toLowerCase().includes(needle))) return false;
  return true;
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const CSV_HEADER = 'url,kind,confidence,template,changed_fields,status,baseline_status,observed_at,baseline_observed_at,baseline_run,evidence,details\n';
function csvRow(r: ChangeRecord) {
  const details = r.fields.map((f) => `${CHANGE_FIELD_LABELS[f.field]}: ${f.old ?? ''} → ${f.new ?? ''}${f.added?.length ? ` [+ ${f.added.join(', ')}]` : ''}${f.removed?.length ? ` [− ${f.removed.join(', ')}]` : ''}${f.note ? ` (${f.note})` : ''}`).join(' || ');
  return `${[r.url, r.kind, r.confidence, r.template, r.fields.map((f) => f.field).join(' '), r.status, r.baselineStatus, r.observedAt, r.baselineObservedAt, r.baselineRunId, r.evidence, details].map(csvCell).join(',')}\n`;
}

export function createChangeService(ctx: Ctx, deps: ChangeServiceDeps) {
  const env = ctx.env;
  const enabled = env.CHANGE_MONITOR_ENABLED !== false;
  const root = defaultChangeDir(env);
  let storeRef: { site: string; store: ChangeStore } | undefined;
  let onRecorded: ((s: ChangeRunSummary) => void) | undefined;
  /** Crawls being compared right now (the crawl already shows "completed"; its change list follows shortly). */
  const comparing = new Set<string>();
  async function store(): Promise<ChangeStore> {
    let site: string;
    try { site = new URL(await deps.siteUrl()).host; } catch { site = 'site'; }
    if (!storeRef || storeRef.site !== site) storeRef = { site, store: createChangeStore(root, site) };
    return storeRef.store;
  }

  const persistentHint = () => {
    const onRender = !!process.env.RENDER;
    const inTmp = root.startsWith(os.tmpdir());
    if (!env.CHANGE_SNAPSHOT_DIR || inTmp) {
      return `${onRender ? 'Render\'s filesystem is ephemeral: ' : ''}change history is kept in ${root}${inTmp ? ' (a temporary folder)' : ''} and is lost when the server restarts or is redeployed. To keep it, mount a persistent disk and set CHANGE_SNAPSHOT_DIR to a folder on it.`;
    }
    return `Change history is kept in ${root}.${onRender ? ' On Render this survives restarts only if the folder is on a mounted persistent disk.' : ''}`;
  };

  /** Records a finished crawl: compares it with the baseline and updates the baseline when the crawl qualifies. */
  async function record(run: CrawlRun, out: Pick<EngineRunResult, 'snapshotFile' | 'snapshotRecords'>): Promise<ChangeRunSummary | undefined> {
    if (!enabled || run.type === 'reverify') return undefined;
    if (!out.snapshotFile && !out.snapshotRecords) return undefined;
    const st = await store();
    comparing.add(run.id);
    return st.exclusive(async () => {
      const t0 = Date.now();
      await st.ensure();
      const ix = await st.readIndex();
      const observedAt = run.startedAt ?? run.finishedAt ?? ctx.clock().toISOString();
      const snapshotId = `${compact(observedAt)}-${run.id}`;
      const f = st.files(snapshotId);
      const outcome = run.status === 'cancelled' ? 'cancelled' : run.status === 'failed' ? 'failed' : run.outcome ?? 'completed';
      // Keep this crawl's snapshot (the crawl's own work folder is deleted by retention).
      if (out.snapshotFile && fs.existsSync(out.snapshotFile)) await fsp.copyFile(out.snapshotFile, `${f.snap}.tmp`);
      else {
        const w = gzWriter(`${f.snap}.tmp`);
        for (const r of out.snapshotRecords ?? []) await w.write(r);
        await w.close();
      }
      await fsp.rename(`${f.snap}.tmp`, f.snap);
      const current = () => readNdjsonGz<SnapRec>(f.snap);
      let urls = out.snapshotRecords?.length ?? -1;

      const prior = ix.baseline;
      const summary: ChangeRunSummary = {
        runId: run.id, snapshotId, crawlType: run.type, outcome, observedAt, finishedAt: run.finishedAt, urls,
        baseline: prior ? { snapshotId: prior.snapshotId, runId: prior.runId, observedAt: prior.observedAt, crawlType: prior.crawlType, urls: prior.urls } : null,
        baselineEffect: 'kept', baselineNote: '', notes: [],
      };
      const label = `${run.type} crawl, ${outcome.replace('_', ' ')}`;
      if (outcome === 'failed') {
        summary.notes.push('The crawl failed, so it was not compared and did not change the baseline.');
        summary.baselineNote = prior ? 'Baseline kept: a failed crawl never replaces it.' : 'No baseline yet.';
      } else {
        let res: Awaited<ReturnType<typeof compareWithBaseline>> | undefined;
        if (prior) {
          res = await compareWithBaseline({
            current: current(), baselineFile: st.baselinePath(prior), completeFull: run.type === 'full' && outcome === 'completed', crawlLabel: label,
            observedAt, notableFile: `${f.notable}.tmp`, quietFile: `${f.quiet}.tmp`, pendingFile: f.pending,
          });
          await fsp.rename(`${f.notable}.tmp`, f.notable);
          await fsp.rename(`${f.quiet}.tmp`, f.quiet);
          summary.counts = res.counts;
          urls = res.current;
          summary.comparedAt = ctx.clock().toISOString();
          if (outcome !== 'completed') summary.notes.push(`This crawl was ${outcome.replace('_', ' ')}: URLs it did not reach are listed as unchecked, never as removed.`);
          if (run.type === 'smart') summary.notes.push('Smart crawls fetch a budgeted selection of pages: URLs outside it are unchecked.');
          if (res.truncatedPages) summary.notes.push(`${res.truncatedPages} page(s) were larger than the read limit; differences on them are marked suspected.`);
          if (prior.crawlType !== 'full') summary.notes.push('The baseline was built from smart crawls only: a full crawl gives a complete baseline.');
        } else {
          summary.notes.push('No baseline to compare with yet.');
        }
        // ---- baseline update
        const complete = outcome === 'completed';
        if (!complete) {
          summary.baselineNote = prior
            ? `Baseline kept (${prior.crawlType} crawl of ${prior.observedAt.slice(0, 10)}): a ${outcome.replace('_', ' ')} crawl never replaces it.`
            : `No baseline yet: a ${outcome.replace('_', ' ')} crawl cannot become the baseline. The next completed crawl will.`;
        } else {
          const file = `baseline-${snapshotId}.ndjson.gz`;
          const dst = path.join(st.dir, file);
          let n: number;
          let effect: ChangeRunSummary['baselineEffect'];
          let mergedFrom: string[] = [];
          if (!prior) { n = await firstBaseline(current, `${dst}.tmp`, observedAt, run.id); effect = 'created'; }
          else if (run.type === 'full') { n = await replaceBaseline(current, st.baselinePath(prior), `${dst}.tmp`, observedAt, run.id, res?.carry); effect = 'replaced'; }
          else { n = await mergeIntoBaseline(current, st.baselinePath(prior), `${dst}.tmp`, observedAt, run.id); effect = 'merged'; mergedFrom = [...prior.mergedFrom, snapshotId]; }
          await fsp.rename(`${dst}.tmp`, dst);
          const meta: BaselineMeta = effect === 'merged'
            ? { ...prior!, urls: n, mergedFrom, file }
            : { snapshotId, runId: run.id, observedAt, crawlType: run.type, urls: n, mergedFrom: [], file };
          ix.baseline = meta;
          summary.baselineEffect = effect;
          summary.baselineNote = effect === 'created'
            ? `This ${run.type} crawl is now the baseline: changes are reported from the next crawl.`
            : effect === 'replaced'
              ? 'This completed full crawl replaced the baseline (URLs that failed this time keep their last good data).'
              : 'The pages this smart crawl fetched were updated in the baseline; all other baseline pages keep their earlier data.';
        }
      }
      if (urls < 0) { urls = 0; for await (const _ of current()) urls++; }
      summary.urls = urls;
      summary.compareMs = Date.now() - t0;
      ix.runs = [summary, ...ix.runs.filter((r) => r.snapshotId !== snapshotId)];
      await st.prune(ix, env.CHANGE_SNAPSHOT_KEEP ?? 5, env.CHANGE_SNAPSHOT_MAX_AGE_DAYS ?? 90, ctx.clock());
      await st.writeIndex(ix);
      ctx.log.info({ runId: run.id, snapshotId, urls, counts: summary.counts, baseline: summary.baselineEffect, ms: summary.compareMs }, 'change monitor recorded crawl');
      return summary;
    }).finally(() => comparing.delete(run.id)).then((summary) => {
      if (summary && summary.outcome !== 'failed') { try { onRecorded?.(summary); } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'after-crawl hook failed'); } }
      return summary;
    });
  }

  async function summaryOf(id: string): Promise<{ st: ChangeStore; s: ChangeRunSummary }> {
    const st = await store();
    const ix = await st.readIndex();
    const s = id === 'latest' ? ix.runs[0] : ix.runs.find((r) => r.snapshotId === id) ?? ix.runs.find((r) => r.runId === id);
    if (!s && comparing.has(id)) throw new ApiError(409, 'COMPARING', `Crawl ${id} is being compared with the baseline. The change list appears in a moment.`);
    if (!s) throw notFound(id === 'latest' ? 'Change Monitor history (no crawl has been recorded yet)' : `Change Monitor data for crawl ${id}`);
    return { st, s };
  }

  async function* records(st: ChangeStore, s: ChangeRunSummary, q: ChangeListQuery): AsyncGenerator<ChangeRecord> {
    const f = st.files(s.snapshotId);
    const kind = q.kind && q.kind !== 'all' ? q.kind : undefined;
    const needle = q.q?.trim().toLowerCase() || undefined;
    for (const [file, set] of [[f.notable, NOTABLE], [f.quiet, QUIET]] as const) {
      if (kind && !set.has(kind)) continue;
      if (q.field && set === QUIET) continue;
      for await (const r of readNdjsonGz<ChangeRecord>(file)) if (matches(r, q, needle)) yield r;
    }
  }

  /** Field weight when choosing which changed pages to screenshot first. */
  const WEIGHT: Partial<Record<string, number>> = { indexability: 9, status: 8, redirect: 8, canonical: 7, title: 6, h1: 6, content: 5, images: 4, structured_data: 4, meta: 3, h2: 2, h3: 1, links: 1, assets: 1 };
  const homeFirst = (u: string) => { try { return new URL(u).pathname === '/' ? 3 : 0; } catch { return 0; } };

  return {
    record,
    directory: root,
    /** Called (not awaited) after a crawl was recorded — the visual capture hook. */
    setOnRecorded(fn: (s: ChangeRunSummary) => void) { onRecorded = fn; },
    /** The most important changed URLs of a recorded crawl (for after-crawl screenshots). */
    async changedUrls(snapshotId: string, max: number): Promise<string[]> {
      if (max <= 0) return [];
      const st = await store();
      const top: { url: string; score: number }[] = [];
      for await (const r of readNdjsonGz<ChangeRecord>(st.files(snapshotId).notable)) {
        if (r.kind !== 'changed') continue;
        const score = Math.max(0, ...r.fields.map((f) => WEIGHT[f.field] ?? 0)) * 10 + r.fields.length + homeFirst(r.url) + (r.confidence === 'confirmed' ? 1 : 0);
        top.push({ url: r.url, score });
        if (top.length > max * 4) { top.sort((a, b) => b.score - a.score); top.length = max; }
      }
      return top.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.url);
    },
    /** This URL's record in the latest crawl that was compared with a baseline. */
    async latestChange(url: string): Promise<ChangeRecord | null> {
      const st = await store();
      const ix = await st.readIndex();
      const s = ix.runs.find((r) => r.counts);
      if (!s) return null;
      const key = urlKey(url);
      for await (const r of records(st, s, {})) if (urlKey(r.url) === key) return r;
      return null;
    },
    async status(actor: Actor): Promise<ChangeMonitorStatus> {
      await need(ctx, actor, 'crawls.view');
      const st = await store();
      const ix = await st.readIndex();
      const b = ix.baseline;
      return {
        enabled, directory: root, persistentHint: persistentHint(),
        retention: { keepRuns: env.CHANGE_SNAPSHOT_KEEP ?? 5, maxAgeDays: env.CHANGE_SNAPSHOT_MAX_AGE_DAYS ?? 90 },
        baseline: b ? { snapshotId: b.snapshotId, runId: b.runId, observedAt: b.observedAt, crawlType: b.crawlType, urls: b.urls, mergedFrom: b.mergedFrom } : null,
        runs: ix.runs, diskBytes: await st.diskBytes(),
      };
    },
    async summary(actor: Actor, id: string): Promise<ChangeRunSummary> {
      await need(ctx, actor, 'crawls.view');
      return (await summaryOf(id)).s;
    },
    /** One page of a crawl's change records, filtered while streaming from disk (never the whole list in memory). */
    async list(actor: Actor, id: string, q: ChangeListQuery): Promise<ChangeListResponse> {
      await need(ctx, actor, 'crawls.view');
      const { st, s } = await summaryOf(id);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? 50)));
      const page = Math.max(1, Math.floor(q.page ?? 1));
      const from = (page - 1) * pageSize;
      const items: ChangeRecord[] = [];
      let total = 0;
      if (s.counts) {
        for await (const r of records(st, s, q)) {
          if (total >= from && items.length < pageSize) items.push(r);
          total++;
        }
      }
      return { runId: s.runId, snapshotId: s.snapshotId, total, page, pageSize, items, counts: s.counts };
    },
    async detail(actor: Actor, id: string, url: string): Promise<ChangeDetail> {
      await need(ctx, actor, 'crawls.view');
      if (!url) throw badRequest('url is required.');
      const { st, s } = await summaryOf(id);
      const key = urlKey(url);
      let found: ChangeRecord | undefined;
      if (s.counts) for await (const r of records(st, s, {})) if (urlKey(r.url) === key) { found = r; break; }
      if (!found) throw notFound(`${url} in the Change Monitor data of crawl ${s.runId}`);
      const issues = (await deps.issuesFor([found.url])).get(urlKey(found.url)) ?? [];
      return { ...found, issues };
    },
    /** Open issues for a page of URLs (the list view attaches them lazily, a page at a time). */
    async issuesFor(actor: Actor, urls: string[]) {
      await need(ctx, actor, 'crawls.view');
      return Object.fromEntries(await deps.issuesFor(urls.slice(0, MAX_PAGE_SIZE)));
    },
    async export(actor: Actor, id: string, format: string, q: ChangeListQuery): Promise<{ filename: string; mimeType: string; stream: AsyncIterable<string> }> {
      await need(ctx, actor, 'crawls.view');
      if (format !== 'csv' && format !== 'json') throw badRequest('Export format must be csv or json.');
      const { st, s } = await summaryOf(id);
      const name = `changes-${s.runId}-${q.kind && q.kind !== 'all' ? q.kind : 'all'}${q.field ? `-${q.field}` : ''}.${format}`;
      async function* body(): AsyncGenerator<string> {
        let buf = format === 'csv' ? CSV_HEADER : `{"run":${JSON.stringify(s)},"filter":${JSON.stringify(q)},"records":[`;
        let first = true;
        if (s.counts) {
          for await (const r of records(st, s, q)) {
            buf += format === 'csv' ? csvRow(r) : `${first ? '' : ','}${JSON.stringify(r)}`;
            first = false;
            if (buf.length >= 256 * 1024) { yield buf; buf = ''; }
          }
        }
        if (format === 'json') buf += ']}';
        if (buf) yield buf;
      }
      return { filename: name, mimeType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', stream: body() };
    },
  };
}

export type ChangeService = ReturnType<typeof createChangeService>;
