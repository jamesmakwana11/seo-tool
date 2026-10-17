/**
 * Image Audit service: runs only when a user starts it, for one finished crawl, and never blocks crawling.
 *
 * 1. Reads the crawl's image references (written from the HTML already fetched — images/refs.ts) and deduplicates the
 *    image URLs (fragment removed, scheme / host lower-cased). ALT, width / height and lazy-loading facts come from the
 *    HTML; nothing is requested for them.
 * 2. Reuses what is already known: a 4xx the crawl's own link check got for an image URL, and the available / broken
 *    answers of an earlier audit of the same crawl. Those images are not requested again.
 * 3. The rest go to the Go crawler binary in "images" mode (a separate process): each unique image once, bounded
 *    concurrency, timeouts, a read of at most 64 KB per image, robots.txt, Retry-After and the SSRF guard.
 * Results stream back while it runs; images not answered stay pending / deferred / unverified — never "available".
 * Jobs and results are kept in memory (no database) and lost on restart, like crawl results.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  IMAGE_AUDIT_CSV, type CrawlRun, type ImageAuditCounts, type ImageAuditItem, type ImageAuditJob, type ImageAuditListResponse, type ImageAuditQuery,
  type ImageAuditStatusResponse, type ImageCheckState, type ImageIssueId,
} from '@sentinel/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { need, type Actor, type Ctx } from '../services/context';
import { runGoCrawler } from '../gocrawl/bridge';
import { readImageRefs } from './refs';

export interface ImageAuditDeps {
  /** Image reference files of a crawl still on this server. */
  refsOf: (runId: string) => { file: string; checkedFile?: string } | undefined;
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
  return { total: 0, pending: 0, checked: 0, ok: 0, broken: 0, failed: 0, unverified: 0, deferred: 0, reused: 0 };
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
  work.job.counts = c;
}

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
  if (it.refs > it.pageCount) { issues.push('repeated'); rec.push('Shown more than once on the same page — check for duplicated theme sections or galleries.'); }
  it.issues = issues;
  it.recommendations = rec;
}

export function createImageAuditService(ctx: Ctx, deps: ImageAuditDeps) {
  const env = ctx.env;
  const jobs = new Map<string, Work>();
  let running: Work | undefined;
  const iso = () => ctx.clock().toISOString();
  const heavyKb = async () => (await ctx.repos.config.get()).thresholds.imageMaxKb ?? 200;
  const limits = () => ({ maxImages: env.IMAGE_AUDIT_MAX_IMAGES, budgetMinutes: env.IMAGE_AUDIT_BUDGET_MINUTES, concurrency: env.IMAGE_AUDIT_CONCURRENCY, probeKb: PROBE_BYTES / 1024 });

  function remember(w: Work) {
    jobs.set(w.job.id, w);
    while (jobs.size > KEEP_JOBS) {
      const oldest = [...jobs.values()].find((x) => x !== running);
      if (!oldest) break;
      jobs.delete(oldest.job.id);
    }
  }

  /** Unique images of a crawl with their HTML facts (no request). */
  async function collect(file: string, job: ImageAuditJob, hk: number): Promise<Map<string, ImageAuditItem>> {
    const items = new Map<string, ImageAuditItem>();
    const groups = new Map<string, string[]>();
    const lastPage = new Map<ImageAuditItem, string>();
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
          it.pageCount++;
          if (it.pages.length < 5) it.pages.push(page.p);
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

  function apply(it: ImageAuditItem, r: GoImage, hk: number) {
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
  }

  async function run(work: Work, toCheck: string[], hk: number) {
    const job = work.job;
    const bin = deps.goBinary();
    const dir = await fsp.mkdtemp(path.join(deps.workDir ?? os.tmpdir(), 'image-audit-'));
    const input = path.join(dir, 'images.ndjson');
    try {
      await fsp.writeFile(input, toCheck.map((u) => JSON.stringify({ url: u })).join('\n'), { mode: 0o600 });
      const base = await deps.siteUrl();
      const go = await runGoCrawler({
        bin: bin.path!,
        job: {
          jobId: job.id, mode: 'images', baseUrl: base, startUrl: base, workDir: dir, imagesFile: input, probeBytes: PROBE_BYTES,
          concurrency: env.IMAGE_AUDIT_CONCURRENCY, timeoutMs: deps.timeoutMs, requestDelayMs: deps.requestDelayMs, retries: deps.retries,
          maxRetryWaitMs: deps.maxRetryWaitMs, maxCrawlDelayMs: deps.maxCrawlDelayMs, userAgent: deps.userAgent, respectRobots: await deps.respectRobots(),
          allowLoopback: deps.allowLoopback, checksBudgetMs: Math.round(env.IMAGE_AUDIT_BUDGET_MINUTES * 60_000), progressMs: 500,
        },
        signal: work.ctrl!.signal,
        // No request for a while is normal (Retry-After pauses, slow image hosts); the time budget ends the job.
        silenceTimeoutMs: Math.round(env.IMAGE_AUDIT_BUDGET_MINUTES * 60_000) + 5 * 60_000,
        onEvent: (e) => {
          const ev = e as unknown as { type: string; result?: GoImage; requests?: number; rateLimited?: number };
          if (ev.type === 'image' && ev.result) {
            const it = work.items.get(ev.result.url);
            if (it) apply(it, ev.result, hk);
            recount(work);
          } else if (ev.type === 'progress') {
            job.counts.requests = ev.requests;
            job.counts.rateLimited = ev.rateLimited;
          }
        },
      });
      const done = go.done as unknown as { state?: string; reason?: string } | undefined;
      // Anything the checker did not answer is not "available": it is deferred (cancelled / stopped) with the reason.
      const why = work.ctrl!.signal.aborted ? 'not checked: the Image Audit was cancelled' : done ? 'not checked in this job' : `not checked: the image checker stopped (${go.bridgeError || go.errors.map((x) => x.message).join('; ') || 'no reason given'})`;
      for (const it of work.items.values()) if (it.state === 'pending') { it.state = 'deferred'; it.reason = why; assess(it, hk); }
      recount(work);
      job.status = work.ctrl!.signal.aborted ? 'cancelled' : !done || done.state === 'failed' ? 'failed' : done.state === 'partial' ? 'partial' : done.state === 'cancelled' ? 'cancelled' : 'completed';
      job.reason = done?.reason || undefined;
      if (job.status === 'failed') job.error = done?.reason || go.bridgeError || go.errors.map((x) => x.message).join('; ') || 'the image checker stopped unexpectedly';
    } catch (e) {
      for (const it of work.items.values()) if (it.state === 'pending') { it.state = 'deferred'; it.reason = 'not checked: the job failed'; }
      recount(work);
      job.status = 'failed';
      job.error = (e as Error).message;
    } finally {
      job.finishedAt = iso();
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (running === work) running = undefined;
    }
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

  return {
    async status(actor: Actor): Promise<ImageAuditStatusResponse> {
      await need(ctx, actor, 'crawls.view');
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
      };
    },

    async start(actor: Actor, runId: string): Promise<ImageAuditJob> {
      await need(ctx, actor, 'crawls.run');
      if (!runId) throw badRequest('runId is required.');
      if (running) throw conflict(`Image Audit ${running.job.id} is still running (crawl ${running.job.runId}). Wait for it or cancel it.`, 'IMAGE_AUDIT_RUNNING');
      const bin = deps.goBinary();
      if (!bin.path || bin.problem) throw conflict(`The Image Audit uses the Go crawler, which is not available on this server (${bin.problem ?? 'not found'}).`, 'IMAGE_AUDIT_UNAVAILABLE');
      const refs = deps.refsOf(runId);
      if (!refs || !fs.existsSync(refs.file)) throw conflict(`The image references of crawl ${runId} are no longer on this server (results of older crawls are removed, and all of them on a restart). Run a crawl, then the Image Audit.`, 'NO_IMAGE_REFERENCES');
      const hk = await heavyKb();
      const job: ImageAuditJob = {
        id: `IMG-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, runId, status: 'running', startedAt: iso(), startedBy: actor.name || actor.id,
        counts: emptyCounts(), pages: 0, references: 0, images: 0, inlineImages: 0, overLimit: 0, budgetMs: Math.round(env.IMAGE_AUDIT_BUDGET_MINUTES * 60_000), heavyKb: hk,
      };
      const work: Work = { job, items: new Map(), ctrl: new AbortController() };
      running = work;
      try {
        work.items = await collect(refs.file, job, hk);
      } catch (e) {
        running = undefined;
        throw new Error(`The crawl's image references could not be read: ${(e as Error).message}`);
      }
      // Reuse: a definite 4xx from the crawl's own link check, and available / broken answers of the previous audit of
      // this crawl. Everything else is requested (once per unique image).
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
      const previous = [...jobs.values()].filter((w) => w.job.runId === runId && w.job.status !== 'running').sort((a, b) => b.job.startedAt.localeCompare(a.job.startedAt))[0];
      if (previous) {
        for (const [k, old] of previous.items) {
          const it = work.items.get(k);
          if (!it || it.state !== 'pending' || (old.state !== 'ok' && old.state !== 'broken') || old.reused === 'crawl') continue;
          Object.assign(it, { state: old.state, reason: old.reason, status: old.status, finalStatus: old.finalStatus, finalUrl: old.finalUrl, redirects: old.redirects, contentType: old.contentType, format: old.format, bytes: old.bytes, width: old.width, height: old.height, checkedAt: old.checkedAt, ms: old.ms, reused: 'audit' as const });
          assess(it, hk);
        }
      }
      recount(work);
      remember(work);
      const toCheck = [...work.items.values()].filter((it) => it.state === 'pending').sort((a, b) => Number(b.inMain) - Number(a.inMain) || b.pageCount - a.pageCount).map((it) => it.url);
      ctx.log.info({ job: job.id, runId, images: job.images, toCheck: toCheck.length, reused: job.counts.reused }, 'image audit started');
      if (!toCheck.length) {
        job.status = 'completed';
        job.finishedAt = iso();
        running = undefined;
        return job;
      }
      work.done = run(work, toCheck, hk);
      return job;
    },

    async get(actor: Actor, id: string) { await need(ctx, actor, 'crawls.view'); return workOf(id).job; },

    async cancel(actor: Actor, id: string) {
      await need(ctx, actor, 'crawls.run');
      const w = workOf(id);
      if (w.job.status === 'running') w.ctrl?.abort();
      await w.done;
      return w.job;
    },

    async list(actor: Actor, id: string, q: ImageAuditQuery): Promise<ImageAuditListResponse> {
      await need(ctx, actor, 'crawls.view');
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
    async idle() { await running?.done; },
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
