/**
 * Image Audit service: runs only when a user starts it, for one finished crawl, and never blocks crawling. It runs on
 * the server as a background job (closing the browser does not stop it; only Cancel does).
 *
 * 1. Reads the crawl's image references (written from the HTML already fetched — images/refs.ts) and deduplicates the
 *    image URLs (fragment removed, scheme / host lower-cased). ALT, width / height and lazy-loading facts come from the
 *    HTML; nothing is requested for them.
 * 2. Reuses what is already known: a 4xx the crawl's own link check got for an image URL, and the available / broken
 *    answers of an earlier audit of the same crawl. Those images are not requested again.
 * 3. The rest go to the Go crawler binary in "images" mode (a separate process): each unique image once, bounded
 *    concurrency, timeouts, a read of at most 64 KB per image, robots.txt, Retry-After and the SSRF guard.
 * Results stream back while it runs; images not answered stay pending / deferred / unverified — never "available".
 * 4. Rounds: one checker process runs for at most IMAGE_AUDIT_BUDGET_MINUTES; the images it did not reach stay pending
 *    and the next round checks them — only them — so the audit continues until every image has an answer. Images
 *    answered "rate limited" are tried again after a pause (Retry-After honoured), up to IMAGE_AUDIT_RATE_LIMIT_ROUNDS.
 * 5. Checkpoints: every IMAGE_AUDIT_CHECKPOINT_SECONDS the answers received so far are stored. With DATABASE_URL they are
 *    stored in PostgreSQL (sentinel_files: a snapshot of every image plus small files with the answers since), so an
 *    audit running during a restart continues afterwards without requesting the images already answered. Without a
 *    database the checkpoint is the server's memory: Resume works until the server restarts, not after.
 * 6. Resume: a cancelled, stopped or failed audit continues with the images still pending / deferred only.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import {
  IMAGE_AUDIT_CSV, type CrawlRun, type ImageAuditCounts, type ImageAuditItem, type ImageAuditJob, type ImageAuditListResponse, type ImageAuditQuery,
  type ImageAuditStatusResponse, type ImageCheckState, type ImageIssueId, type ImageOccurrence, type ImageOccurrencesResponse,
} from '@sentinel/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { need, type Actor, type Ctx } from '../services/context';
import { runGoCrawler } from '../gocrawl/bridge';
import { readImageRefs } from './refs';

export interface ImageAuditDeps {
  /** Image reference files of a crawl still on this server (restored from the database after a restart). */
  refsOf: (runId: string) => Promise<{ file: string; checkedFile?: string } | undefined>;
  /** Runs with image references, newest first. */
  runsWithRefs: () => Promise<CrawlRun[]>;
  siteUrl: () => Promise<string>;
  goBinary: () => { path?: string; problem?: string };
  allowLoopback: boolean;
  userAgent: string;
  timeoutMs: number;
  requestDelayMs: number;
  retries: number;
  maxRetryWaitMs: number;
  maxCrawlDelayMs: number;
  respectRobots: () => Promise<boolean>;
  workDir?: string;
}

interface Work {
  job: ImageAuditJob;
  items: Map<string, ImageAuditItem>;
  ctrl?: AbortController;
  done?: Promise<void>;
  /** Images changed since the last checkpoint. */
  dirty: Set<string>;
  /** Answer files stored since the last full snapshot (database checkpoints). */
  seq: number;
  snapshotSaved: boolean;
  /** Serialises checkpoint writes. */
  saving: Promise<void>;
}

/** Image Audits running on this server (all websites), and the shutdown flag (a cut-off audit stays "running" in its checkpoint). */
let auditsRunning = 0;
let auditsShuttingDown = false;
const checkpointers = new Set<() => Promise<void>>();
export const busyImageAudits = () => auditsRunning;
/** SIGTERM: store every running audit's progress; they continue after the restart (with a database). */
export async function suspendImageAuditsForShutdown() {
  auditsShuttingDown = true;
  await Promise.all([...checkpointers].map((f) => f().catch(() => undefined)));
}

const PROBE_BYTES = 64 * 1024;
const LEGACY = /^(jpe?g|png|gif|bmp|tiff?)$/i;
const KEEP_JOBS = 5;

/** Image URL key: no fragment, lower-case scheme and host. */
export function imageKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.toString();
  } catch {
    return raw.split('#')[0];
  }
}
const fileKey = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname}`.toLowerCase(); } catch { return u.split(/[?#]/)[0].toLowerCase(); } };
const int = (v?: string) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) && n > 0 ? n : undefined; };
const kb = (b: number) => `${Math.round(b / 1024).toLocaleString('en-US')} KB`;

function emptyCounts(): ImageAuditCounts {
  return { total: 0, pending: 0, checked: 0, finished: 0, ok: 0, broken: 0, failed: 0, unverified: 0, deferred: 0, reused: 0 };
}

function recount(work: Work) {
  const c = emptyCounts();
  c.requests = work.job.counts.requests;
  c.rateLimited = work.job.counts.rateLimited;
  for (const it of work.items.values()) {
    c.total++;
    c[it.state]++;
    if (it.reused) c.reused++;
  }
  c.checked = c.ok + c.broken + c.failed;
  c.finished = c.checked + c.unverified;
  work.job.counts = c;
  work.job.resumable = work.job.status !== 'running' && c.pending + c.deferred > 0;
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => {
  if (signal?.aborted) return res();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); res(); }
  signal?.addEventListener('abort', done, { once: true });
});
/** Seconds of a Retry-After value (delta seconds or an HTTP date), if any. */
function retryAfterMs(reason?: string): number | undefined {
  const m = /Retry-After: (.+)$/.exec(reason ?? '');
  if (!m) return undefined;
  const v = m[1].trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}
/** What a checkpoint keeps of an image (issues / recommendations are derived again on load). */
const stored = (it: ImageAuditItem) => { const { issues: _i, recommendations: _r, ...rest } = it; return rest; };

/** Issues and recommendations of one image from the HTML facts and the check result. */
export function assess(it: ImageAuditItem, heavyKb: number) {
  const issues: ImageIssueId[] = [];
  const rec: string[] = [];
  const onPages = `${it.pageCount.toLocaleString('en-US')} page${it.pageCount === 1 ? '' : 's'}`;
  if (it.state === 'broken') { issues.push('broken'); rec.push(`Fix the file or its URL, or remove the <img> from the ${onPages} that show it (${it.reason ?? 'broken'}).`); }
  if (it.state === 'failed') { issues.push('failed'); rec.push(`The image could not be loaded (${it.reason ?? 'no answer'}). Check again later; if it keeps failing, fix the file or its host.`); }
  if (it.state === 'unverified') issues.push('unverified');
  if (it.altMissing) { issues.push('alt-missing'); rec.push(`Add ALT text describing the image (product, colour, angle) — missing on ${it.altMissing.toLocaleString('en-US')} reference${it.altMissing === 1 ? '' : 's'}.`); }
  if (it.altEmpty) { issues.push('alt-empty'); rec.push('alt="" hides the image from search engines and screen readers — keep it only for purely decorative images.'); }
  if (it.noDimensions) { issues.push('no-dimensions'); rec.push('Add width and height attributes so the page does not shift while the image loads (CLS).'); }
  if (it.eagerBelowFold) { issues.push('not-lazy'); rec.push('Add loading="lazy" — the image is below the first images of the page.'); }
  if (it.state === 'ok' && it.bytes !== undefined && it.bytes > heavyKb * 1024) { issues.push('heavy'); rec.push(`Compress or resize: ${kb(it.bytes)} (aim for under ${heavyKb} KB).`); }
  if (it.state === 'ok' && it.format && LEGACY.test(it.format)) { issues.push('legacy-format'); rec.push(`Served as ${it.format.toUpperCase()} although the browser accepts WebP / AVIF — serve a modern format (Shopify's image_url filter does).`); }
  if (it.state === 'ok' && it.width && it.htmlWidth && it.width >= it.htmlWidth * 2 && it.width - it.htmlWidth >= 400) {
    issues.push('oversized'); rec.push(`The file is ${it.width}×${it.height ?? '?'} px but shown at ${it.htmlWidth}×${it.htmlHeight ?? '?'} — serve a smaller size (srcset or the width parameter).`);
  }
  if (it.redirects) { issues.push('redirect'); rec.push(`Reference the final address directly${it.finalUrl ? ` (${it.finalUrl})` : ''}: every load costs an extra request.`); }
  if (it.duplicateUrls) { issues.push('duplicate'); rec.push(`The same file is referenced under ${it.duplicateUrls + 1} different URLs — use one URL so browsers download and cache it once.`); }
  if ((it.repeatedPages ?? (it.refs > it.pageCount ? 1 : 0)) > 0) {
    issues.push('repeated');
    rec.push(`Shown more than once on the same page — on ${(it.repeatedPages ?? 1).toLocaleString('en-US')} page${(it.repeatedPages ?? 1) === 1 ? '' : 's'}${it.maxPerPage ? `, up to ${it.maxPerPage} times on one page` : ''}. "Repeated on the same page" below lists each page and every copy with where it is (section / gallery) — remove the duplicate copies.`);
  }
  it.issues = issues;
  it.recommendations = rec;
}

export function createImageAuditService(ctx: Ctx, deps: ImageAuditDeps) {
  const env = ctx.env;
  const jobs = new Map<string, Work>();
  let running: Work | undefined;
  const iso = () => ctx.clock().toISOString();
  const db = ctx.persistence;
  const scope = ctx.scope ?? 'site';
  const storage: 'database' | 'memory' = db ? 'database' : 'memory';
  const heavyKb = async () => (await ctx.repos.config.get()).thresholds.imageMaxKb ?? 200;
  const limits = () => ({ maxImages: env.IMAGE_AUDIT_MAX_IMAGES, budgetMinutes: env.IMAGE_AUDIT_BUDGET_MINUTES, concurrency: env.IMAGE_AUDIT_CONCURRENCY, probeKb: PROBE_BYTES / 1024, maxHours: env.IMAGE_AUDIT_MAX_HOURS });
  const base = (id: string) => `image-audits/${id}/`;

  function remember(w: Work) {
    jobs.set(w.job.id, w);
    while (jobs.size > KEEP_JOBS) {
      const oldest = [...jobs.values()].find((x) => x !== running);
      if (!oldest) break;
      jobs.delete(oldest.job.id);
      if (db) void db.listFiles(scope, base(oldest.job.id)).then((f) => db.deleteFiles(scope, f)).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ checkpoints
  async function gz(lines: Iterable<string>): Promise<Buffer> {
    const z = zlib.createGzip();
    const out: Buffer[] = [];
    z.on('data', (b: Buffer) => out.push(b));
    const end = new Promise<void>((res, rej) => { z.on('end', res); z.on('error', rej); });
    for (const l of lines) if (!z.write(`${l}\n`)) await new Promise((r) => z.once('drain', r));
    z.end();
    await end;
    return Buffer.concat(out);
  }
  async function* gunzipLines(buf: Buffer): AsyncGenerator<string> {
    const rl = readline.createInterface({ input: Readable.from(buf).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const l of rl) if (l.trim()) yield l;
  }
  /**
   * Stores the audit's progress. With a database: the first time (and at the end of every round) a snapshot of every
   * image, in between only the images answered since (small files) — never all images every few seconds.
   */
  function checkpoint(w: Work, full = false): Promise<void> {
    w.saving = w.saving.then(async () => {
      recount(w);
      w.job.checkpoint = { at: iso(), storage, finished: w.job.counts.finished };
      if (!db) { w.dirty.clear(); return; }
      const b = base(w.job.id);
      try {
        if (full || !w.snapshotSaved) {
          w.dirty.clear();
          const items = [...w.items.values()];
          await db.saveFile(scope, `${b}items.ndjson.gz`, await gz((function* () { for (const it of items) yield JSON.stringify(stored(it)); })()));
          const old = (await db.listFiles(scope, `${b}answers-`));
          await db.deleteFiles(scope, old);
          w.seq = 0;
          w.snapshotSaved = true;
        } else if (w.dirty.size) {
          const changed = [...w.dirty].map((k) => w.items.get(k)).filter((x): x is ImageAuditItem => !!x);
          w.dirty.clear();
          w.seq++;
          await db.saveFile(scope, `${b}answers-${String(w.seq).padStart(6, '0')}.ndjson.gz`, await gz(changed.map((it) => JSON.stringify(stored(it)))));
        }
        await db.saveFile(scope, `${b}job.json`, Buffer.from(JSON.stringify(w.job)));
      } catch (e) {
        ctx.log.warn({ job: w.job.id, err: (e as Error).message }, 'image audit checkpoint could not be stored (retried at the next one)');
        w.snapshotSaved = false;
      }
    });
    return w.saving;
  }

  /** Audits stored in the database (after a restart); one that was running continues with the images not answered yet. */
  async function restore(): Promise<{ restored: number; resumed: number }> {
    if (!db) return { restored: 0, resumed: 0 };
    const files = await db.listFiles(scope, 'image-audits/');
    const ids = [...new Set(files.map((f) => f.split('/')[1]))];
    let resumed = 0;
    const loaded: Work[] = [];
    for (const id of ids) {
      try {
        const rawJob = await db.readFile(scope, `${base(id)}job.json`);
        const snap = await db.readFile(scope, `${base(id)}items.ndjson.gz`);
        if (!rawJob || !snap) continue;
        const job = JSON.parse(rawJob.toString('utf8')) as ImageAuditJob;
        const hk = job.heavyKb;
        const items = new Map<string, ImageAuditItem>();
        for await (const l of gunzipLines(snap)) { const it = JSON.parse(l) as ImageAuditItem; items.set(it.url, it); }
        const answers = files.filter((f) => f.startsWith(`${base(id)}answers-`)).sort();
        for (const f of answers) {
          const buf = await db.readFile(scope, f);
          if (buf) for await (const l of gunzipLines(buf)) { const it = JSON.parse(l) as ImageAuditItem; items.set(it.url, it); }
        }
        for (const it of items.values()) assess(it, hk);
        const w: Work = { job, items, dirty: new Set(), seq: answers.length, snapshotSaved: true, saving: Promise.resolve() };
        recount(w);
        loaded.push(w);
      } catch (e) {
        ctx.log.warn({ job: id, err: (e as Error).message }, 'a stored Image Audit could not be read');
      }
    }
    loaded.sort((a, b) => a.job.startedAt.localeCompare(b.job.startedAt));
    for (const w of loaded) remember(w);
    // The newest one that was running when the server stopped continues (one audit at a time per website).
    const wasRunning = loaded.filter((w) => w.job.status === 'running');
    for (const w of wasRunning) {
      if (w === wasRunning[wasRunning.length - 1] && jobs.has(w.job.id)) {
        w.job.reason = `Continued after a server restart: the ${w.job.counts.finished.toLocaleString('en-US')} images answered before it were not requested again.`;
        begin(w, await heavyKb());
        resumed++;
      } else {
        w.job.status = 'partial';
        w.job.reason = 'Interrupted by a server restart. Resume it to check the images not answered yet.';
        for (const it of w.items.values()) if (it.state === 'pending') { it.state = 'deferred'; it.reason = 'not checked yet: interrupted by a server restart'; }
        recount(w);
        void checkpoint(w, true);
      }
    }
    return { restored: loaded.length, resumed };
  }

  // ------------------------------------------------------------------ collect
  /** Unique images of a crawl with their HTML facts (no request). */
  async function collect(file: string, job: ImageAuditJob, hk: number): Promise<Map<string, ImageAuditItem>> {
    const items = new Map<string, ImageAuditItem>();
    const groups = new Map<string, string[]>();
    const lastPage = new Map<ImageAuditItem, string>();
    const onPage = new Map<ImageAuditItem, number>();
    let over = 0;
    for await (const page of readImageRefs(file)) {
      job.pages++;
      let mainIdx = 0;
      for (const ref of page.i) {
        const src = ref.s?.trim();
        if (!src) continue;
        if (/^data:/i.test(src)) { job.inlineImages++; continue; }
        job.references++;
        const key = imageKey(src);
        let it = items.get(key);
        if (!it) {
          if (items.size >= env.IMAGE_AUDIT_MAX_IMAGES) { over++; continue; }
          it = { url: key, state: 'pending', pageCount: 0, pages: [], refs: 0, altMissing: 0, altEmpty: 0, noDimensions: 0, lazy: 0, eagerBelowFold: 0, inMain: false, issues: [], recommendations: [] };
          items.set(key, it);
          const g = groups.get(fileKey(key)) ?? [];
          g.push(key);
          groups.set(fileKey(key), g);
        }
        it.refs++;
        // Each page is one line of the file, so a page is counted once per image.
        if (lastPage.get(it) !== page.p) {
          lastPage.set(it, page.p);
          onPage.set(it, 1);
          it.pageCount++;
          if (it.pages.length < 5) it.pages.push(page.p);
        } else {
          // A second (third …) copy on the same page: the page counts once as "repeated".
          const n = (onPage.get(it) ?? 1) + 1;
          onPage.set(it, n);
          if (n === 2) it.repeatedPages = (it.repeatedPages ?? 0) + 1;
          it.maxPerPage = Math.max(it.maxPerPage ?? 1, n);
        }
        if (ref.a === null) it.altMissing++;
        else if (!ref.a.trim()) it.altEmpty++;
        else it.altText ??= ref.a.trim().slice(0, 200);
        if (!ref.w || !ref.h) it.noDimensions++;
        else if (it.htmlWidth === undefined) { it.htmlWidth = int(ref.w); it.htmlHeight = int(ref.h); }
        if (ref.l === 'lazy') it.lazy++;
        if (ref.m) {
          it.inMain = true;
          if (mainIdx >= 2 && ref.l !== 'lazy') it.eagerBelowFold++;
          mainIdx++;
        }
      }
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const u of g) { const it = items.get(u)!; it.duplicateUrls = g.length - 1; it.duplicateOf = g[0] === u ? g[1] : g[0]; }
    }
    job.overLimit = over;
    job.images = items.size;
    for (const it of items.values()) assess(it, hk);
    return items;
  }

  const RATE_LIMITED = /^rate limited/;
  /** One answer of the checker. Deferred (round ended / cancelled) keeps the image pending; rate limited is tried again. */
  function apply(w: Work, it: ImageAuditItem, r: GoImage, hk: number): 'answered' | 'rate_limited' | 'not_reached' {
    if (r.state === 'deferred') return 'not_reached';
    if (r.state === 'unverified' && RATE_LIMITED.test(r.reason ?? '')) {
      it.rateLimitedRounds = (it.rateLimitedRounds ?? 0) + 1;
      if (it.rateLimitedRounds < env.IMAGE_AUDIT_RATE_LIMIT_ROUNDS) {
        it.reason = `${r.reason}; tried again after a pause (round ${it.rateLimitedRounds} of ${env.IMAGE_AUDIT_RATE_LIMIT_ROUNDS})`;
        w.dirty.add(it.url);
        return 'rate_limited';
      }
    }
    it.state = r.state;
    it.reason = r.reason || undefined;
    it.status = r.status ?? null;
    it.finalStatus = r.finalStatus ?? null;
    it.redirects = r.chain?.length || undefined;
    it.finalUrl = r.chain?.length ? r.finalUrl : undefined;
    it.contentType = r.contentType || undefined;
    it.format = r.format || undefined;
    it.bytes = r.bytes ?? undefined;
    it.width = r.width || undefined;
    it.height = r.height || undefined;
    it.ms = r.ms;
    it.checkedAt = iso();
    it.reused = undefined;
    assess(it, hk);
    w.dirty.add(it.url);
    return 'answered';
  }

  /** One checking round: a Go checker process for the images still pending, for at most one round's time. */
  async function round(work: Work, toCheck: string[], hk: number) {
    const job = work.job;
    const bin = deps.goBinary();
    const dir = await fsp.mkdtemp(path.join(deps.workDir ?? os.tmpdir(), 'image-audit-'));
    const input = path.join(dir, 'images.ndjson');
    const res = { answered: 0, rateLimited: 0, pauseMs: 0, fatal: undefined as string | undefined };
    const reqBase = job.counts.requests ?? 0;
    const rlBase = job.counts.rateLimited ?? 0;
    try {
      await fsp.writeFile(input, toCheck.map((u) => JSON.stringify({ url: u })).join('\n'), { mode: 0o600 });
      const site = await deps.siteUrl();
      const budgetMs = Math.round(env.IMAGE_AUDIT_BUDGET_MINUTES * 60_000);
      const go = await runGoCrawler({
        bin: bin.path!,
        job: {
          jobId: `${job.id}-r${job.rounds}`, mode: 'images', baseUrl: site, startUrl: site, workDir: dir, imagesFile: input, probeBytes: PROBE_BYTES,
          concurrency: env.IMAGE_AUDIT_CONCURRENCY, timeoutMs: deps.timeoutMs, requestDelayMs: deps.requestDelayMs, retries: deps.retries,
          maxRetryWaitMs: deps.maxRetryWaitMs, maxCrawlDelayMs: deps.maxCrawlDelayMs, userAgent: deps.userAgent, respectRobots: await deps.respectRobots(),
          allowLoopback: deps.allowLoopback, checksBudgetMs: budgetMs, progressMs: 500,
        },
        signal: work.ctrl!.signal,
        // No request for a while is normal (Retry-After pauses, slow image hosts); the round's time budget ends it.
        silenceTimeoutMs: budgetMs + 5 * 60_000,
        onEvent: (e) => {
          const ev = e as unknown as { type: string; result?: GoImage; requests?: number; rateLimited?: number };
          if (ev.type === 'image' && ev.result) {
            const it = work.items.get(ev.result.url);
            if (it && it.state === 'pending') {
              const a = apply(work, it, ev.result, hk);
              if (a === 'answered') res.answered++;
              else if (a === 'rate_limited') { res.rateLimited++; res.pauseMs = Math.max(res.pauseMs, retryAfterMs(ev.result.reason) ?? 0); }
            }
            recount(work);
          } else if (ev.type === 'progress') {
            job.counts.requests = reqBase + (ev.requests ?? 0);
            job.counts.rateLimited = rlBase + (ev.rateLimited ?? 0);
          }
        },
      });
      const done = go.done as unknown as { state?: string; reason?: string } | undefined;
      if (!work.ctrl!.signal.aborted && (!done || done.state === 'failed')) res.fatal = done?.reason || go.bridgeError || go.errors.map((x) => x.message).join('; ') || 'the image checker stopped unexpectedly';
    } catch (e) {
      res.fatal = (e as Error).message;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return res;
  }

  /** Waits for a free Image Audit slot on this server (all websites). False when cancelled first. */
  async function slot(work: Work): Promise<boolean> {
    while (auditsRunning >= env.IMAGE_AUDIT_MAX_CONCURRENT && !work.ctrl!.signal.aborted && !auditsShuttingDown) {
      work.job.waiting = `Waiting: ${auditsRunning} Image Audit${auditsRunning === 1 ? ' is' : 's are'} running on this server (limit ${env.IMAGE_AUDIT_MAX_CONCURRENT}).`;
      await sleep(1000, work.ctrl!.signal);
    }
    work.job.waiting = undefined;
    if (work.ctrl!.signal.aborted || auditsShuttingDown) return false;
    auditsRunning++;
    return true;
  }

  /** Runs rounds until every image has an answer, the audit is cancelled, or it stops (time limit, no progress, failure). */
  async function runAll(work: Work, hk: number) {
    const job = work.job;
    const signal = work.ctrl!.signal;
    const t0 = Date.now();
    const maxMs = env.IMAGE_AUDIT_MAX_HOURS * 3600_000;
    let stop: { status: ImageAuditJob['status']; reason: string; error?: string } | undefined;
    const timer = setInterval(() => { if (work.dirty.size) void checkpoint(work); }, env.IMAGE_AUDIT_CHECKPOINT_SECONDS * 1000);
    timer.unref();
    const flushNow = () => checkpoint(work);
    checkpointers.add(flushNow);
    let holds = false;
    try {
      holds = await slot(work);
      if (!holds) return;
      for (;;) {
        if (signal.aborted || auditsShuttingDown) break;
        const toCheck = [...work.items.values()].filter((it) => it.state === 'pending').sort((a, b) => Number(b.inMain) - Number(a.inMain) || b.pageCount - a.pageCount).map((it) => it.url);
        if (!toCheck.length) break;
        if (Date.now() - t0 > maxMs) { stop = { status: 'partial', reason: `Stopped after ${env.IMAGE_AUDIT_MAX_HOURS} hours (IMAGE_AUDIT_MAX_HOURS); ${toCheck.length.toLocaleString('en-US')} images are not checked yet. Resume to continue with them.` }; break; }
        job.rounds++;
        ctx.log.info({ job: job.id, round: job.rounds, images: toCheck.length }, 'image audit round');
        const r = await round(work, toCheck, hk);
        await checkpoint(work, true);
        if (signal.aborted || auditsShuttingDown) break;
        if (r.fatal) { stop = { status: 'failed', reason: 'The image checker stopped; the images answered so far are kept. Resume to check the rest.', error: r.fatal }; break; }
        if (!r.answered && !r.rateLimited) { stop = { status: 'partial', reason: 'A checking round got no answer for any image, so the audit stopped. Resume it later to try the images not checked yet.' }; break; }
        if (r.rateLimited) {
          const pause = Math.min(15 * 60_000, Math.max(env.IMAGE_AUDIT_RATE_LIMIT_PAUSE_SECONDS * 1000, r.pauseMs));
          job.waiting = `${r.rateLimited.toLocaleString('en-US')} image${r.rateLimited === 1 ? ' was' : 's were'} rate limited; trying again in ${Math.round(pause / 1000)} s (Retry-After respected).`;
          await sleep(pause, signal);
          job.waiting = undefined;
        }
      }
    } finally {
      clearInterval(timer);
      checkpointers.delete(flushNow);
      if (holds) auditsRunning = Math.max(0, auditsRunning - 1);
    }
    if (auditsShuttingDown && !signal.aborted) {
      // Server shutting down: the checkpoint keeps it "running", so it continues after the restart.
      await checkpoint(work);
      return;
    }
    const why = signal.aborted ? 'not checked: the Image Audit was cancelled — Resume continues with these' : stop ? `not checked yet: ${stop.reason}` : 'not checked';
    for (const it of work.items.values()) if (it.state === 'pending') { it.state = 'deferred'; it.reason = why; assess(it, hk); }
    job.status = signal.aborted ? 'cancelled' : stop ? stop.status : 'completed';
    job.reason = signal.aborted ? 'Cancelled; images not checked are deferred. Resume continues with them only.' : stop?.reason ?? (job.reason?.startsWith('Continued') ? job.reason : undefined);
    if (stop?.error) job.error = stop.error;
    job.finishedAt = iso();
    job.waiting = undefined;
    if (running === work) running = undefined;
    await checkpoint(work, true);
  }

  /** Starts (or continues) the rounds of an audit in the background. */
  function begin(work: Work, hk: number) {
    work.job.status = 'running';
    work.job.finishedAt = undefined;
    work.job.error = undefined;
    work.ctrl = new AbortController();
    running = work;
    recount(work);
    work.done = runAll(work, hk).catch((e) => {
      ctx.log.error({ job: work.job.id, err: (e as Error).message }, 'image audit failed');
      work.job.status = 'failed';
      work.job.error = (e as Error).message;
      work.job.finishedAt = iso();
      if (running === work) running = undefined;
      recount(work);
    });
  }

  function workOf(id: string): Work {
    const w = jobs.get(id);
    if (!w) throw notFound(`Image Audit ${id}`);
    return w;
  }

  function select(w: Work, q: ImageAuditQuery): ImageAuditItem[] {
    const needle = q.q?.trim().toLowerCase();
    let list = [...w.items.values()].filter((it) => (!q.state || it.state === q.state) && (!q.issue || it.issues.includes(q.issue))
      && (!needle || it.url.toLowerCase().includes(needle) || it.pages.some((p) => p.toLowerCase().includes(needle)) || (it.altText ?? '').toLowerCase().includes(needle)));
    const dir = q.dir === 'asc' ? 1 : -1;
    const order: Record<ImageCheckState, number> = { broken: 0, failed: 1, unverified: 2, deferred: 3, pending: 4, ok: 5 };
    const key = (it: ImageAuditItem): number | string => q.sort === 'bytes' ? it.bytes ?? -1 : q.sort === 'url' ? it.url : q.sort === 'state' ? order[it.state] : it.pageCount;
    list = list.map((it, i) => ({ it, i, k: key(it) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i) * (q.sort === 'url' || q.sort === 'state' ? -dir : dir)).map((x) => x.it);
    return list;
  }

  const restored = restore().catch((e) => { ctx.log.warn({ err: (e as Error).message }, 'stored Image Audits could not be loaded'); return { restored: 0, resumed: 0 }; });

  return {
    /** Loads stored audits (database) and continues the one a restart interrupted. */
    restored: () => restored,

    async status(actor: Actor): Promise<ImageAuditStatusResponse> {
      await need(ctx, actor, 'crawls.view');
      await restored;
      const bin = deps.goBinary();
      const runs = await deps.runsWithRefs();
      const latest = new Map<string, ImageAuditJob>();
      for (const w of jobs.values()) {
        const cur = latest.get(w.job.runId);
        if (!cur || cur.startedAt < w.job.startedAt) latest.set(w.job.runId, w.job);
      }
      return {
        runs: runs.map((r) => ({ runId: r.id, type: r.type, startedAt: r.startedAt, outcome: r.outcome, pages: r.urlsCrawled })),
        jobs: [...latest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        running: running?.job,
        available: !!bin.path && !bin.problem,
        reason: !bin.path || bin.problem ? `The Image Audit uses the Go crawler, which is not available on this server (${bin.problem ?? 'not found'}).` : undefined,
        limits: limits(),
        storage,
      };
    },

    async start(actor: Actor, runId: string): Promise<ImageAuditJob> {
      await need(ctx, actor, 'crawls.run');
      await restored;
      if (!runId) throw badRequest('runId is required.');
      if (running) throw conflict(`Image Audit ${running.job.id} is still running (crawl ${running.job.runId}). Wait for it or cancel it.`, 'IMAGE_AUDIT_RUNNING');
      const bin = deps.goBinary();
      if (!bin.path || bin.problem) throw conflict(`The Image Audit uses the Go crawler, which is not available on this server (${bin.problem ?? 'not found'}).`, 'IMAGE_AUDIT_UNAVAILABLE');
      const refs = await deps.refsOf(runId);
      if (!refs || !fs.existsSync(refs.file)) throw conflict(`The image references of crawl ${runId} are no longer on this server (only the most recent crawls keep them). Run a crawl, then the Image Audit.`, 'NO_IMAGE_REFERENCES');
      const hk = await heavyKb();
      const job: ImageAuditJob = {
        id: `IMG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, runId, status: 'running', startedAt: iso(), startedBy: actor.name || actor.id,
        counts: emptyCounts(), pages: 0, references: 0, images: 0, inlineImages: 0, overLimit: 0, budgetMs: Math.round(env.IMAGE_AUDIT_BUDGET_MINUTES * 60_000), heavyKb: hk, rounds: 0,
      };
      const work: Work = { job, items: new Map(), ctrl: new AbortController(), dirty: new Set(), seq: 0, snapshotSaved: false, saving: Promise.resolve() };
      running = work;
      try {
        work.items = await collect(refs.file, job, hk);
      } catch (e) {
        running = undefined;
        throw new Error(`The crawl's image references could not be read: ${(e as Error).message}`);
      }
      // Reuse: a definite 4xx from the crawl's own link check, and available / broken answers of earlier audits (this
      // crawl: any age; other crawls of this website: IMAGE_AUDIT_REUSE_HOURS). Those images are not requested again.
      if (refs.checkedFile && fs.existsSync(refs.checkedFile)) {
        try {
          const checked = JSON.parse(await fsp.readFile(refs.checkedFile, 'utf8')) as { url: string; status: number | null; finalStatus: number | null; finalUrl?: string; error?: string }[];
          for (const l of checked) {
            const it = work.items.get(imageKey(l.url));
            const st = l.finalStatus ?? l.status;
            if (it && st !== null && st >= 400 && st < 500 && st !== 429) {
              it.state = 'broken'; it.reason = `HTTP ${st} (from the crawl's link check)`; it.status = l.status; it.finalStatus = l.finalStatus; it.reused = 'crawl'; assess(it, hk);
            }
          }
        } catch { /* unreadable: everything is checked */ }
      }
      const since = ctx.clock().getTime() - env.IMAGE_AUDIT_REUSE_HOURS * 3600_000;
      const earlier = [...jobs.values()].filter((w) => w.job.status !== 'running').sort((a, b) => b.job.startedAt.localeCompare(a.job.startedAt));
      for (const prev of earlier) {
        const sameCrawl = prev.job.runId === runId;
        for (const [k, old] of prev.items) {
          const it = work.items.get(k);
          if (!it || it.state !== 'pending' || (old.state !== 'ok' && old.state !== 'broken') || old.reused === 'crawl') continue;
          if (!sameCrawl && !(old.checkedAt && Date.parse(old.checkedAt) >= since)) continue;
          Object.assign(it, { state: old.state, reason: old.reason, status: old.status, finalStatus: old.finalStatus, finalUrl: old.finalUrl, redirects: old.redirects, contentType: old.contentType, format: old.format, bytes: old.bytes, width: old.width, height: old.height, checkedAt: old.checkedAt, ms: old.ms, reused: 'audit' as const });
          assess(it, hk);
        }
      }
      recount(work);
      remember(work);
      ctx.log.info({ job: job.id, runId, images: job.images, toCheck: job.counts.pending, reused: job.counts.reused }, 'image audit started');
      if (!job.counts.pending) {
        job.status = 'completed';
        job.finishedAt = iso();
        running = undefined;
        recount(work);
        await checkpoint(work, true);
        return job;
      }
      await checkpoint(work, true);
      begin(work, hk);
      return job;
    },

    /** Continues a stopped / cancelled / failed audit with the images not answered yet (answered ones are never requested again). */
    async resume(actor: Actor, id: string): Promise<ImageAuditJob> {
      await need(ctx, actor, 'crawls.run');
      await restored;
      const w = workOf(id);
      if (w.job.status === 'running') throw conflict(`Image Audit ${id} is already running.`, 'IMAGE_AUDIT_RUNNING');
      if (running) throw conflict(`Image Audit ${running.job.id} is still running (crawl ${running.job.runId}). Wait for it or cancel it.`, 'IMAGE_AUDIT_RUNNING');
      const bin = deps.goBinary();
      if (!bin.path || bin.problem) throw conflict(`The Image Audit uses the Go crawler, which is not available on this server (${bin.problem ?? 'not found'}).`, 'IMAGE_AUDIT_UNAVAILABLE');
      let left = 0;
      for (const it of w.items.values()) if (it.state === 'deferred' || it.state === 'pending') { it.state = 'pending'; it.reason = undefined; w.dirty.add(it.url); left++; }
      if (!left) throw conflict(`Image Audit ${id} has no image left to check.`, 'NOTHING_TO_RESUME');
      w.job.resumes = (w.job.resumes ?? 0) + 1;
      w.job.reason = `Resumed by ${actor.name || actor.id}: ${left.toLocaleString('en-US')} images left; the ${w.job.counts.finished.toLocaleString('en-US')} answered are not requested again.`;
      begin(w, w.job.heavyKb);
      await checkpoint(w);
      return w.job;
    },

    async get(actor: Actor, id: string) { await need(ctx, actor, 'crawls.view'); await restored; const w = workOf(id); recount(w); return w.job; },

    async cancel(actor: Actor, id: string) {
      await need(ctx, actor, 'crawls.run');
      const w = workOf(id);
      if (w.job.status === 'running') w.ctrl?.abort();
      await w.done;
      return w.job;
    },

    async list(actor: Actor, id: string, q: ImageAuditQuery): Promise<ImageAuditListResponse> {
      await need(ctx, actor, 'crawls.view');
      await restored;
      const w = workOf(id);
      const facets: ImageAuditListResponse['facets'] = { state: {}, issue: {} };
      for (const it of w.items.values()) {
        facets.state[it.state] = (facets.state[it.state] ?? 0) + 1;
        for (const x of it.issues) facets.issue[x] = (facets.issue[x] ?? 0) + 1;
      }
      const all = select(w, q);
      const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit ?? 50)) || 50));
      const offset = Math.max(0, Math.min(Math.floor(Number(q.offset ?? 0)) || 0, all.length));
      return { job: w.job, total: all.length, offset, limit, rows: all.slice(offset, offset + limit), facets };
    },

    /**
     * Every page showing one image, with each <img> instance (position, ALT, size attributes, loading, where on the
     * page), read from the crawl's image references — nothing is kept in memory per image. repeated = only pages that
     * show it more than once. When the references are gone, says so instead of listing anything.
     */
    async occurrences(actor: Actor, id: string, url: string, q: { repeated?: boolean; offset?: number; limit?: number }): Promise<ImageOccurrencesResponse> {
      await need(ctx, actor, 'crawls.view');
      await restored;
      const w = workOf(id);
      if (!url) throw badRequest('url is required.');
      const key = imageKey(url);
      if (!w.items.has(key)) throw notFound(`Image ${url} in Image Audit ${id}`);
      const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit ?? 100)) || 100));
      const offset = Math.max(0, Math.floor(Number(q.offset ?? 0)) || 0);
      const res: ImageOccurrencesResponse = { url: key, available: true, pages: 0, repeatedPages: 0, references: 0, total: 0, offset, limit, rows: [] };
      const refs = await deps.refsOf(w.job.runId);
      if (!refs || !fs.existsSync(refs.file)) {
        return { ...res, available: false, reason: `The image references of crawl ${w.job.runId} are no longer on this server (only the most recent crawls keep them), so the pages showing this image could not be identified. Run a new crawl and Image Audit to list them.` };
      }
      for await (const page of readImageRefs(refs.file)) {
        let occ: ImageOccurrence | undefined;
        for (const ref of page.i) {
          const src = ref.s?.trim();
          if (!src || /^data:/i.test(src) || imageKey(src) !== key) continue;
          occ ??= { page: page.p, count: 0, instances: [] };
          occ.count++;
          occ.instances.push({ position: ref.x + 1, alt: ref.a, ...(ref.w ? { width: ref.w } : {}), ...(ref.h ? { height: ref.h } : {}), ...(ref.l ? { loading: ref.l } : {}), inMain: ref.m, ...(ref.c ? { location: ref.c } : {}) });
        }
        if (!occ) continue;
        res.pages++;
        res.references += occ.count;
        if (occ.count > 1) res.repeatedPages++;
        if (q.repeated && occ.count < 2) continue;
        if (res.total >= offset && res.rows.length < limit) res.rows.push(occ);
        res.total++;
      }
      return res;
    },

    async export(actor: Actor, id: string, format: string, q: ImageAuditQuery) {
      await need(ctx, actor, 'crawls.view');
      if (format !== 'csv' && format !== 'json') throw badRequest('Export format must be csv or json.');
      const w = workOf(id);
      const rows = select(w, { ...q, offset: 0, limit: undefined });
      const filename = `image-audit-${w.job.runId}-${w.job.id}.${format}`;
      const cell = (v: unknown) => { if (v === undefined || v === null) return ''; let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      async function* csv() {
        yield `${IMAGE_AUDIT_CSV.map((c) => c.header).join(',')}\r\n`;
        let buf = '';
        for (const it of rows) {
          buf += `${IMAGE_AUDIT_CSV.map((c) => cell(c.value(it))).join(',')}\r\n`;
          if (buf.length > 256 * 1024) { yield buf; buf = ''; }
        }
        if (buf) yield buf;
      }
      async function* json() {
        yield `{"job":${JSON.stringify(w.job)},"note":"Images not answered are pending, deferred or unverified — never counted as available.","images":[`;
        let buf = '';
        rows.forEach((it, i) => { buf += `${i ? ',' : ''}${JSON.stringify(it)}`; });
        yield buf;
        yield ']}';
      }
      return { filename, mimeType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', stream: format === 'csv' ? csv() : json() };
    },

    /** Tests / shutdown. */
    async idle() { await restored; await running?.done; },
  };
}

/** One result line of the Go checker. */
interface GoImage {
  url: string;
  state: Exclude<ImageCheckState, 'pending'>;
  reason?: string;
  status?: number | null;
  finalStatus?: number | null;
  finalUrl?: string;
  chain?: { url: string; status: number }[];
  contentType?: string;
  format?: string;
  bytes?: number;
  width?: number;
  height?: number;
  ms?: number;
}

export type ImageAuditService = ReturnType<typeof createImageAuditService>;
