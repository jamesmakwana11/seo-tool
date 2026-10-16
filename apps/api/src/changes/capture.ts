/**
 * Visual comparison and code differences for selected / changed pages: a real Chromium (runtime/capture-runner.mjs, a
 * separate process, one browser at a time per server) takes a screenshot per viewport, keeps the rendered HTML and the
 * page's own CSS / JS, and diffs the screenshot against the previous capture of the same page and viewport.
 *
 * Nothing is made up: a page with one capture has no "previous" screenshot, and every view says why it is unavailable.
 * Storage: <CHANGE_SNAPSHOT_DIR>/<host>/captures/ (index.json, files/, assets/), bounded by retention.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_VIEWPORTS, type AssetChange, type CaptureJob, type CaptureStatus, type CaptureViewport, type ChangeRecord, type PageCapture, type PageComparison,
  type TextDiffView,
} from '@sentinel/shared';
import { assertAllowedUrl } from '../crawler/netguard';
import { activeChildMemoryMB } from '../gocrawl/engine';
import { minimalEnv } from '../gocrawl/binaries';
import { memoryPlan, nodeMemory } from '../gocrawl/memoryBudget';
import { findChrome } from '../lighthouse/service';
import { withBrowser } from '../lib/browserLock';
import { diffLines, formatCss, formatHtml, formatJs } from '../lib/diff';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { audit, need, type Actor, type Ctx } from '../services/context';
import { safeName } from './store';
import { urlKey } from './service';

const MAX_URLS_PER_JOB = 20;
const JOBS_KEPT = 20;
const ASSET_LIMITS = { count: 25, bytes: 1_500_000, total: 8_000_000 };

interface Stored extends PageCapture {
  files: { png?: string; html?: string; diffPng?: string };
}
interface CaptureIndex {
  version: 1;
  pages: Record<string, { url: string; lastAt: string; captures: Stored[] }>;
  watch: string[];
}

const here = (() => { try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); } })();
function findRunner(): string | undefined {
  for (const start of [here, process.cwd()]) {
    let d = start;
    for (let i = 0; i < 6; i++) {
      for (const c of [path.join(d, 'runtime', 'capture-runner.mjs'), path.join(d, 'apps', 'api', 'runtime', 'capture-runner.mjs')]) if (fs.existsSync(c)) return c;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return undefined;
}
function playwrightInstalled(runner: string | undefined): boolean {
  if (!runner) return false;
  let d = path.dirname(runner);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'node_modules', 'playwright-core', 'package.json'))) return true;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}

const publicView = (c: Stored): PageCapture => {
  const { files, ...rest } = c;
  return { ...rest, hasImage: !!files.png, hasHtml: !!files.html, hasDiffImage: !!files.diffPng };
};
const assetKey = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname}`; } catch { return u.split('?')[0]; } };
const sameSite = (a: string, b: string) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

export interface CaptureDeps {
  siteUrl: () => Promise<string>;
  root: string;
  allowLoopback: boolean;
  userAgent: string;
  /** The Change Monitor record of a URL in the latest compared crawl. */
  latestChange: (url: string) => Promise<ChangeRecord | null>;
  /** Changed URLs of a crawl, most important first. */
  changedUrls: (snapshotId: string, max: number) => Promise<string[]>;
}

export function createCaptureService(ctx: Ctx, deps: CaptureDeps) {
  const env = ctx.env;
  const iso = () => ctx.clock().toISOString();
  const jobs: CaptureJob[] = [];
  let seq = 0;
  const runner = findRunner();
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };
  const afterCrawl = env.CHANGE_CAPTURE_AFTER_CRAWL ?? env.NODE_ENV !== 'test';
  const afterViewports = (env.CHANGE_CAPTURE_VIEWPORTS ?? 'desktop').split(',').map((v) => v.trim()).filter((v): v is CaptureViewport => (CAPTURE_VIEWPORTS as string[]).includes(v));

  async function site() {
    const u = new URL(await deps.siteUrl());
    return { origin: u.origin, host: u.host, hostname: u.hostname };
  }
  async function dirs() {
    const s = await site();
    const base = path.join(deps.root, safeName(s.host), 'captures');
    return { base, files: path.join(base, 'files'), assets: path.join(base, 'assets'), index: path.join(base, 'index.json') };
  }
  async function readIndex(): Promise<CaptureIndex> {
    const d = await dirs();
    try {
      const ix = JSON.parse(await fsp.readFile(d.index, 'utf8')) as CaptureIndex;
      if (ix.version === 1) return ix;
    } catch { /* first use */ }
    return { version: 1, pages: {}, watch: [] };
  }
  async function writeIndex(ix: CaptureIndex) {
    const d = await dirs();
    await fsp.mkdir(d.base, { recursive: true });
    await fsp.writeFile(`${d.index}.tmp`, JSON.stringify(ix));
    await fsp.rename(`${d.index}.tmp`, d.index);
  }

  function memory() {
    const plan = memoryPlan({ CRAWLER_MEMORY_BUDGET_MB: env.CRAWLER_MEMORY_BUDGET_MB, CRAWLER_GO_MEMORY_MB: env.CRAWLER_GO_MEMORY_MB });
    if (!plan.budgetMB) return undefined;
    return Math.round(plan.budgetMB - nodeMemory().rssMB - activeChildMemoryMB());
  }

  function problems(): { list: string[]; chrome?: string } {
    const list: string[] = [];
    const chrome = findChrome(env.LIGHTHOUSE_CHROME_PATH);
    if (!env.CHANGE_CAPTURE_ENABLED) list.push('Page captures are switched off on this server (CHANGE_CAPTURE_ENABLED=false).');
    if (!runner) list.push('The capture runner (apps/api/runtime/capture-runner.mjs) is missing from this installation.');
    else if (!playwrightInstalled(runner)) list.push('The playwright-core package is not installed on the API server (npm install in apps/api installs it as an optional dependency).');
    if (!chrome) list.push('No Chrome / Chromium found on the API server. Build the Docker image with INSTALL_CHROMIUM=true (needs a plan with ≥ 1 GB RAM) or set LIGHTHOUSE_CHROME_PATH.');
    return { list, chrome };
  }

  async function validUrl(raw: string): Promise<string> {
    let u: URL;
    try { u = new URL(raw); } catch { throw badRequest(`Not a valid URL: ${raw.slice(0, 200)}`); }
    const s = await site();
    if (!sameSite(u.hostname, s.hostname)) throw badRequest(`${u.host} is not this website (${s.host}). Only this website's pages can be captured.`);
    u.hash = '';
    await assertAllowedUrl(u.toString(), { allowLoopback: deps.allowLoopback }).catch((e: Error) => { throw badRequest(e.message); });
    return u.toString();
  }

  function runRunner(job: Record<string, unknown>, timeoutMs: number, onLine: (v: Record<string, unknown>) => void): Promise<{ fatal?: string; exit: number | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [runner!], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...minimalEnv(), NODE_OPTIONS: '--max-old-space-size=128' }, windowsHide: true });
      let buf = '';
      let err = '';
      let fatal: string | undefined;
      const kill = setTimeout(() => { fatal ??= `timed out after ${Math.round(timeoutMs / 1000)} s`; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        buf += d;
        let k: number;
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k);
          buf = buf.slice(k + 1);
          try {
            const v = JSON.parse(line) as Record<string, unknown>;
            if (typeof v.fatal === 'string') fatal = v.fatal; else onLine(v);
          } catch { /* not ours */ }
        }
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-4000); });
      child.on('error', (e) => { clearTimeout(kill); resolve({ fatal: `could not start the capture runner: ${e.message}`, exit: null }); });
      child.on('close', (code) => {
        clearTimeout(kill);
        if (code && !fatal) fatal = `the browser process ended (exit ${code})${err ? `: ${err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}`;
        resolve({ fatal, exit: code });
      });
      child.stdin.end(JSON.stringify(job));
    });
  }

  /** Drops old captures (per page and viewport, and least recently captured pages) and files nothing refers to. */
  async function prune(ix: CaptureIndex) {
    const keep = env.CHANGE_CAPTURE_KEEP ?? 3;
    for (const p of Object.values(ix.pages)) {
      const kept: Stored[] = [];
      for (const vp of CAPTURE_VIEWPORTS) {
        const list = p.captures.filter((c) => c.viewport === vp);
        kept.push(...list.filter((c) => c.ok).slice(0, keep), ...list.filter((c) => !c.ok).slice(0, 1));
      }
      p.captures = kept.sort((a, b) => b.at.localeCompare(a.at));
    }
    const pages = Object.entries(ix.pages).sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt));
    const watch = new Set(ix.watch.map(urlKey));
    let n = 0;
    for (const [k] of pages) { if (!watch.has(k) && ++n > (env.CHANGE_CAPTURE_MAX_PAGES ?? 200)) delete ix.pages[k]; }
    const d = await dirs();
    const files = new Set<string>();
    const hashes = new Set<string>();
    for (const p of Object.values(ix.pages)) for (const c of p.captures) {
      for (const f of Object.values(c.files)) if (f) files.add(f);
      for (const a of c.assets ?? []) hashes.add(a.hash);
    }
    for (const name of await fsp.readdir(d.files).catch(() => [] as string[])) if (!files.has(name)) await fsp.rm(path.join(d.files, name), { force: true }).catch(() => undefined);
    for (const name of await fsp.readdir(d.assets).catch(() => [] as string[])) if (!hashes.has(name.replace(/\.gz$/, ''))) await fsp.rm(path.join(d.assets, name), { force: true }).catch(() => undefined);
  }

  async function execute(job: CaptureJob) {
    job.status = 'running';
    job.startedAt = iso();
    const { list, chrome } = problems();
    if (list.length) { job.status = 'failed'; job.error = list.join(' '); job.finishedAt = iso(); return; }
    const free = memory();
    const needMb = env.CHANGE_CAPTURE_MIN_FREE_MB ?? 300;
    if (free !== undefined && free < needMb) {
      job.status = 'failed';
      job.error = `Not enough memory for a browser: ${free} MB free within the memory budget, ${needMb} MB needed. Try again when no crawl is running, or give the server more memory.`;
      job.finishedAt = iso();
      return;
    }
    job.memoryNote = free === undefined ? 'No memory limit detected; the browser was started without a memory check.' : `${free} MB free within the memory budget when the browser started.`;
    const d = await dirs();
    await fsp.mkdir(d.files, { recursive: true });
    await fsp.mkdir(d.assets, { recursive: true });
    const tmp = await fsp.mkdtemp(path.join(d.base, 'tmp-'));
    const s = await site();
    try {
      const ix = await exclusive(readIndex);
      const captures = job.items.map((it, k) => {
        const prev = ix.pages[urlKey(it.url)]?.captures.find((c) => c.viewport === it.viewport && c.ok && c.files.png);
        return { key: `c${k}`, url: it.url, viewport: it.viewport, previousPng: prev ? path.join(d.files, prev.files.png!) : undefined, prev };
      });
      const results = new Map<string, Record<string, unknown>>();
      const timeoutMs = (env.CHANGE_CAPTURE_TIMEOUT_MS ?? 45000) * (captures.length + 1) + 30_000;
      const r = await runRunner({
        chromePath: chrome, userAgent: deps.userAgent, timeoutMs: env.CHANGE_CAPTURE_TIMEOUT_MS ?? 45000, outDir: tmp, assetDir: d.assets,
        concurrency: env.CHANGE_CAPTURE_CONCURRENCY ?? 1, maxHeight: env.CHANGE_CAPTURE_MAX_HEIGHT ?? 6000, allowLoopback: deps.allowLoopback, siteHost: s.hostname,
        assetHosts: (env.CHANGE_CAPTURE_ASSET_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean), assetLimits: ASSET_LIMITS,
        chromeFlags: (env.LIGHTHOUSE_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean),
        captures: captures.map(({ prev: _p, ...c }) => c),
      }, timeoutMs, (v) => { if (typeof v.key === 'string') results.set(v.key, v); });
      const at = iso();
      await exclusive(async () => {
        const ix2 = await readIndex();
        for (const [k, c] of captures.entries()) {
          const it = job.items[k];
          const v = results.get(c.key);
          const id = `CAP-${at.replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
          const stored: Stored = { id, url: c.url, viewport: c.viewport, at, ok: false, trigger: job.trigger, files: {}, hasImage: false, hasHtml: false, hasDiffImage: false };
          if (!v) { stored.error = r.fatal ?? 'no result from the browser'; }
          else if (!v.ok) { stored.error = String(v.error ?? 'capture failed'); stored.ms = v.ms as number; }
          else {
            const move = async (from: unknown, ext: string) => {
              if (typeof from !== 'string' || !fs.existsSync(from)) return undefined;
              const name = `${id}.${c.viewport}${ext}`;
              await fsp.rename(from, path.join(d.files, name));
              return name;
            };
            stored.ok = true;
            stored.files.png = await move(v.png, '.png');
            stored.files.html = await move(v.html, '.html.gz');
            const diff = v.diff as { png?: string; ratio: number; changedPixels: number; sizeChanged: boolean } | undefined;
            if (diff && c.prev) {
              stored.files.diffPng = await move(diff.png, '.diff.png');
              stored.diff = { previousId: c.prev.id, previousAt: c.prev.at, ratio: diff.ratio, changedPixels: diff.changedPixels, sizeChanged: diff.sizeChanged };
            } else stored.diff = null;
            Object.assign(stored, {
              status: v.status as number | null, finalUrl: v.finalUrl as string, width: v.width as number, height: v.height as number, docHeight: v.docHeight as number,
              cut: !!v.cut, ms: v.ms as number, fields: v.fields as PageCapture['fields'], assets: v.assets as PageCapture['assets'],
            });
            try { if (stored.finalUrl && !sameSite(new URL(stored.finalUrl).hostname, s.hostname)) stored.error = `The page redirected to another website (${stored.finalUrl}).`; } catch { /* keep */ }
          }
          if (job.runId) stored.runId = job.runId;
          it.state = stored.ok ? 'done' : 'failed';
          it.captureId = id;
          if (!stored.ok) it.error = stored.error;
          const key = urlKey(c.url);
          const page = ix2.pages[key] ?? { url: c.url, lastAt: at, captures: [] };
          page.lastAt = at;
          page.captures.unshift(stored);
          ix2.pages[key] = page;
        }
        await prune(ix2);
        await writeIndex(ix2);
      });
      job.status = job.items.some((i) => i.state === 'done') ? 'done' : 'failed';
      if (r.fatal) job.error = r.fatal;
    } catch (e) {
      job.status = 'failed';
      job.error = (e as Error).message;
    } finally {
      job.finishedAt = iso();
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function enqueue(urls: string[], viewports: CaptureViewport[], trigger: CaptureJob['trigger'], by: string, runId?: string): Promise<CaptureJob> {
    const job: CaptureJob = {
      id: `CJ-${++seq}`, status: 'queued', trigger, createdAt: iso(), requestedBy: by,
      items: urls.flatMap((url) => viewports.map((viewport) => ({ url, viewport, state: 'queued' as const }))), ...(runId ? { runId } : {}),
    };
    jobs.unshift(job);
    jobs.splice(JOBS_KEPT);
    job.status = 'queued';
    const p = withBrowser('capture', () => execute(job)).catch((e) => { job.status = 'failed'; job.error = (e as Error).message; });
    track(p);
    return { ...job, items: job.items.map((i) => ({ ...i })) };
  }
  function track<T>(p: Promise<T>): Promise<T> {
    running.add(p);
    void p.finally(() => running.delete(p)).catch(() => undefined);
    return p;
  }
  const running = new Set<Promise<unknown>>();

  async function capturesOf(url: string): Promise<Stored[]> {
    const ix = await readIndex();
    return ix.pages[urlKey(url)]?.captures ?? [];
  }

  async function readGz(file: string, maxBytes = 8_000_000): Promise<string | undefined> {
    try {
      const buf = zlib.gunzipSync(await fsp.readFile(file));
      return buf.subarray(0, maxBytes).toString('utf8');
    } catch { return undefined; }
  }

  return {
    /** Await queued captures (tests / shutdown). */
    async idle() { while (running.size) await Promise.all([...running]); },
    async status(actor: Actor): Promise<CaptureStatus> {
      await need(ctx, actor, 'crawls.view');
      const p = problems();
      const ix = await readIndex();
      return {
        available: !p.list.length, problems: p.list, chromePath: p.chrome, memoryNeededMB: env.CHANGE_CAPTURE_MIN_FREE_MB ?? 300, memoryFreeMB: memory(),
        afterCrawl: { enabled: afterCrawl, changedPages: env.CHANGE_CAPTURE_CHANGED_PAGES ?? 5, viewports: afterViewports },
        watch: ix.watch, jobs: jobs.map((j) => ({ ...j })),
        limits: { keepPerPage: env.CHANGE_CAPTURE_KEEP ?? 3, maxPages: env.CHANGE_CAPTURE_MAX_PAGES ?? 200, maxHeight: env.CHANGE_CAPTURE_MAX_HEIGHT ?? 6000, concurrency: env.CHANGE_CAPTURE_CONCURRENCY ?? 1 },
      };
    },
    async request(actor: Actor, input: { urls?: unknown; viewports?: unknown }): Promise<CaptureJob> {
      await need(ctx, actor, 'crawls.run');
      const p = problems();
      if (p.list.length) throw new ApiError(409, 'CAPTURE_UNAVAILABLE', `Page captures are not available on this server: ${p.list.join(' ')}`);
      const raw = Array.isArray(input.urls) ? input.urls.map(String) : [];
      if (!raw.length) throw badRequest('Give at least one URL to capture.');
      if (raw.length > MAX_URLS_PER_JOB) throw badRequest(`At most ${MAX_URLS_PER_JOB} URLs per capture request.`);
      const vps = (Array.isArray(input.viewports) && input.viewports.length ? input.viewports.map(String) : ['desktop']);
      for (const v of vps) if (!(CAPTURE_VIEWPORTS as string[]).includes(v)) throw badRequest(`Unknown viewport ${v} (desktop or mobile).`);
      const urls = [...new Set(await Promise.all(raw.map(validUrl)))];
      const job = await enqueue(urls, [...new Set(vps)] as CaptureViewport[], 'manual', actor.name);
      await audit(ctx, actor, 'changes.capture', 'crawl', job.id, `Queued screenshots of ${urls.length} page(s) (${vps.join(', ')})`);
      return job;
    },
    async job(actor: Actor, id: string): Promise<CaptureJob> {
      await need(ctx, actor, 'crawls.view');
      const j = jobs.find((x) => x.id === id);
      if (!j) throw notFound(`Capture job ${id}`);
      return { ...j };
    },
    async setWatch(actor: Actor, urls: unknown): Promise<string[]> {
      await need(ctx, actor, 'crawls.configure');
      const list = Array.isArray(urls) ? urls.map(String) : [];
      if (list.length > 50) throw badRequest('At most 50 watched pages.');
      const valid = [...new Set(await Promise.all(list.map(validUrl)))];
      await exclusive(async () => { const ix = await readIndex(); ix.watch = valid; await writeIndex(ix); });
      await audit(ctx, actor, 'changes.watch', 'crawl', 'watch', `Watched pages for screenshots after each crawl: ${valid.length}`);
      return valid;
    },
    /** After a crawl: capture the watched pages (so the next change has a "before") and the most important changed pages. */
    afterCrawl(runId: string, snapshotId: string, compared: boolean): Promise<CaptureJob | undefined> {
      if (!afterCrawl || problems().list.length || !afterViewports.length) return Promise.resolve(undefined);
      return track((async () => {
        const ix = await readIndex();
        const s = await site();
        const watch = ix.watch.length ? ix.watch : [`${s.origin}/`];
        const changed = compared ? await deps.changedUrls(snapshotId, env.CHANGE_CAPTURE_CHANGED_PAGES ?? 5) : [];
        const urls = [...new Map([...watch, ...changed].map((u) => [urlKey(u), u])).values()].slice(0, MAX_URLS_PER_JOB);
        return enqueue(urls, afterViewports, 'after_crawl', 'Sentinel (after crawl)', runId);
      })());
    },
    async list(actor: Actor, url: string): Promise<PageCapture[]> {
      await need(ctx, actor, 'crawls.view');
      return (await capturesOf(url)).map(publicView);
    },
    async pages(actor: Actor): Promise<{ url: string; lastAt: string; captures: number }[]> {
      await need(ctx, actor, 'crawls.view');
      const ix = await readIndex();
      return Object.values(ix.pages).map((p) => ({ url: p.url, lastAt: p.lastAt, captures: p.captures.length })).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    },
    /** The file of a capture's screenshot, pixel-diff image or rendered HTML (served by the route). */
    async file(actor: Actor, id: string, kind: 'image' | 'diff' | 'html'): Promise<{ path: string; type: string; name: string }> {
      await need(ctx, actor, 'crawls.view');
      const ix = await readIndex();
      for (const p of Object.values(ix.pages)) {
        const c = p.captures.find((x) => x.id === id);
        if (!c) continue;
        const name = kind === 'image' ? c.files.png : kind === 'diff' ? c.files.diffPng : c.files.html;
        if (!name) throw notFound(`${kind === 'diff' ? 'Visual difference image' : kind === 'html' ? 'Rendered HTML' : 'Screenshot'} of capture ${id}`);
        const d = await dirs();
        return { path: path.join(d.files, name), type: kind === 'html' ? 'text/html; charset=utf-8' : 'image/png', name };
      }
      throw notFound(`Capture ${id}`);
    },
    async compare(actor: Actor, q: { url: string; viewport?: string; from?: string; to?: string }): Promise<PageComparison> {
      await need(ctx, actor, 'crawls.view');
      if (!q.url) throw badRequest('url is required.');
      const viewport = (q.viewport ?? 'desktop') as CaptureViewport;
      if (!CAPTURE_VIEWPORTS.includes(viewport)) throw badRequest('viewport must be desktop or mobile.');
      const all = (await capturesOf(q.url)).filter((c) => c.viewport === viewport && c.ok);
      const to = q.to ? all.find((c) => c.id === q.to) ?? null : all[0] ?? null;
      if (q.to && !to) throw notFound(`Capture ${q.to} of ${q.url} (${viewport})`);
      const older = to ? all.filter((c) => c.at < to.at || (c.at === to.at && c.id !== to.id)) : [];
      const from = q.from ? all.find((c) => c.id === q.from) ?? null : older[0] ?? null;
      if (q.from && !from) throw notFound(`Capture ${q.from} of ${q.url} (${viewport})`);
      const d = await dirs();
      const change = await deps.latestChange(q.url).catch(() => null);
      const res: PageComparison = {
        url: q.url, viewport, from: from ? publicView(from) : null, to: to ? publicView(to) : null, change,
        visual: { available: false }, dom: { available: false, note: '' }, seoFields: [], assets: { available: false, items: [] },
      };
      const none = !to
        ? `No ${viewport} screenshot of this page yet. Capture it to start its history; a comparison needs two captures.`
        : !from ? `Only one ${viewport} capture of this page (${to.at.slice(0, 16).replace('T', ' ')} UTC). No earlier screenshot exists, so there is nothing to compare with — a previous screenshot is never made up.` : undefined;
      if (none) {
        res.visual.reason = none;
        res.dom.reason = none;
        res.assets.reason = none;
      } else {
        // Visual: both screenshots are shown side by side; the pixel-difference image exists for consecutive captures.
        res.visual = to!.diff && to!.diff.previousId === from!.id && to!.files.diffPng
          ? { available: true, ratio: to!.diff.ratio, sizeChanged: to!.diff.sizeChanged, diffOf: [from!.id, to!.id] }
          : { available: true, reason: 'Side by side only: the pixel-difference image is made when a capture is taken, against the capture just before it.' };
        const [ha, hb] = await Promise.all([from!.files.html ? readGz(path.join(d.files, from!.files.html)) : undefined, to!.files.html ? readGz(path.join(d.files, to!.files.html)) : undefined]);
        if (ha !== undefined && hb !== undefined) {
          res.dom = { available: true, diff: diffLines(formatHtml(ha), formatHtml(hb), { maxLines: 3000 }) as TextDiffView, note: '' };
        } else res.dom.reason = 'The rendered HTML of one of the captures is not available.';
        const pair = new Map<string, AssetChange>();
        for (const a of from!.assets ?? []) pair.set(assetKey(a.url), { key: assetKey(a.url), type: a.type, state: 'removed', from: a });
        for (const b of to!.assets ?? []) {
          const k = assetKey(b.url);
          const p = pair.get(k);
          if (!p) pair.set(k, { key: k, type: b.type, state: 'added', to: b });
          else { p.to = b; p.state = p.from!.hash === b.hash ? 'same' : 'changed'; }
        }
        const order = { changed: 0, added: 1, removed: 2, same: 3 };
        res.assets = { available: true, items: [...pair.values()].sort((a, b) => order[a.state] - order[b.state] || a.key.localeCompare(b.key)) };
        if (!res.assets.items.length) res.assets.reason = 'Neither capture kept any CSS / JS file of this website or its CDN.';
      }
      res.dom.note = 'Rendered HTML after JavaScript, as Chromium received and built it (inline script and style bodies are shown as a size + hash; nonces and tokens are removed). A difference shows that what the page delivers changed — it does not prove that the Shopify theme code changed: apps, content, settings, prices and scripts change the DOM too. Theme source can only be compared through an authorised Shopify connection.';
      const f = (c: Stored | null) => c?.fields ?? {};
      const fields: [string, (x: PageCapture['fields']) => string | undefined][] = [
        ['Title', (x) => x?.title], ['Meta description', (x) => x?.meta], ['H1', (x) => x?.h1?.join(' | ')], ['Canonical', (x) => x?.canonical], ['Meta robots', (x) => x?.robots],
      ];
      if (to) res.seoFields = fields.map(([name, get]) => ({ field: name, from: from ? get(f(from)) : undefined, to: get(f(to)), changed: !!from && (get(f(from)) ?? '') !== (get(f(to)) ?? '') }));
      return res;
    },
    /** Line diff of one CSS / JS file between two captures (the files the browser actually loaded). */
    async assetDiff(actor: Actor, q: { url: string; viewport?: string; from: string; to: string; key: string }): Promise<{ key: string; from?: string; to?: string; diff: TextDiffView; formatted: boolean; note: string }> {
      await need(ctx, actor, 'crawls.view');
      const all = await capturesOf(q.url);
      const a = all.find((c) => c.id === q.from);
      const b = all.find((c) => c.id === q.to);
      if (!a || !b) throw notFound('One of the captures');
      const fa = a.assets?.find((x) => assetKey(x.url) === q.key);
      const fb = b.assets?.find((x) => assetKey(x.url) === q.key);
      if (!fa && !fb) throw notFound(`Asset ${q.key} in these captures`);
      const d = await dirs();
      const load = async (x?: { hash: string }) => (x ? (await readGz(path.join(d.assets, `${x.hash}.gz`), 2_000_000)) ?? '' : '');
      const [ta, tb] = await Promise.all([load(fa), load(fb)]);
      const type = (fa ?? fb)!.type;
      const fmt = type === 'css' ? formatCss : formatJs;
      return {
        key: q.key, from: fa?.url, to: fb?.url, formatted: true, diff: diffLines(fmt(ta), fmt(tb), { maxLines: 3000 }) as TextDiffView,
        note: `The ${type.toUpperCase()} files Chromium downloaded during each capture, re-flowed one rule / statement per line so minified files can be compared. This is the public file, not the theme's source.`,
      };
    },
  };
}

export type CaptureService = ReturnType<typeof createCaptureService>;
