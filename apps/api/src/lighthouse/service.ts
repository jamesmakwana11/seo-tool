/**
 * Lighthouse lab audits (mobile / desktop) and rendered-page checks (raw HTML vs the DOM after JavaScript), on demand.
 *
 * - Real runs: the `lighthouse` npm package drives a real Chrome / Chromium in a separate process
 *   (runtime/lighthouse-runner.mjs), so a browser crash or memory spike never takes the API down.
 * - One run at a time per server (a browser needs ~250–400 MB), queued; refused with the reason when the memory budget
 *   cannot fit a browser next to what is running (crawls included).
 * - Only URLs on this website, and only public addresses (the same SSRF rules as the crawler). The page then loads its
 *   own resources (CDNs, apps) as in any browser.
 * - Missing pieces are reported, never faked: no package → "not installed"; no browser → "no Chrome found".
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LighthouseFormFactor, LighthouseRun, LighthouseStatus, LighthouseSummary, RenderComparison } from '@sentinel/shared';
import { badRequest, conflict } from '../lib/errors';
import { ApiError } from '../lib/errors';
import { assertAllowedUrl } from '../crawler/netguard';
import { parseHtml } from '../crawler/parse';
import { hostOf, isLocalHost } from '../crawler/url';
import type { Collector } from '../crawler/engine';
import { activeChildMemoryMB } from '../gocrawl/engine';
import { memoryPlan, nodeMemory } from '../gocrawl/memoryBudget';
import { minimalEnv } from '../gocrawl/binaries';
import { audit, need, type Actor, type Ctx } from '../services/context';

export interface LighthouseEnv {
  LIGHTHOUSE_ENABLED: boolean;
  LIGHTHOUSE_CHROME_PATH?: string;
  LIGHTHOUSE_CHROME_FLAGS?: string;
  LIGHTHOUSE_MIN_FREE_MB: number;
  LIGHTHOUSE_TIMEOUT_MS: number;
  CRAWLER_MEMORY_BUDGET_MB?: number;
  CRAWLER_GO_MEMORY_MB?: number;
}

const here = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

function findUp(rel: string): string | undefined {
  for (const start of [here, process.cwd()]) {
    let d = start;
    for (let i = 0; i < 6; i++) {
      for (const c of [path.join(d, rel), path.join(d, 'apps', 'api', rel)]) if (fs.existsSync(c)) return c;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return undefined;
}

export function lighthouseVersion(): string | undefined {
  try {
    const req = createRequire(path.join(here, 'x.js'));
    return (JSON.parse(fs.readFileSync(req.resolve('lighthouse/package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return undefined;
  }
}

/** Chrome / Chromium: LIGHTHOUSE_CHROME_PATH, CHROME_PATH, Playwright's Chromium, or a system Chrome. */
export function findChrome(explicit?: string): string | undefined {
  const cands: string[] = [];
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  const pw = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')].filter(Boolean) as string[];
  for (const root of pw) {
    try {
      for (const d of fs.readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
        cands.push(path.join(root, d, 'chrome-linux', 'chrome'), path.join(root, d, 'chrome-linux64', 'chrome'), path.join(root, d, 'chrome-win', 'chrome.exe'), path.join(root, d, 'chrome-win64', 'chrome.exe'));
      }
    } catch { /* not there */ }
  }
  cands.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
}

// One browser at a time for the whole API process (several websites share the server).
const queue: { run: LighthouseRun; exec: () => Promise<void> }[] = [];
let active: LighthouseRun | undefined;
async function pump() {
  if (active) return;
  const next = queue.shift();
  if (!next) return;
  active = next.run;
  try { await next.exec(); } finally {
    active = undefined;
    void pump();
  }
}

type RunnerOut = { ok: true; mode: 'lighthouse'; ms: number } & Omit<LighthouseSummary, 'ms'> | { ok: true; mode: 'render'; status: number | null; ms: number; rendered: Record<string, unknown> } | { ok: false; error: string; missing?: string };

function runRunner(runner: string, job: Record<string, unknown>, timeoutMs: number): Promise<RunnerOut> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...minimalEnv(), NODE_OPTIONS: '' }, windowsHide: true });
    let out = '';
    let err = '';
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs + 15_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(kill); resolve({ ok: false, error: `could not start the runner: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(kill);
      const line = out.trim().split('\n').pop();
      try {
        resolve(JSON.parse(line ?? '') as RunnerOut);
      } catch {
        resolve({ ok: false, error: `the browser process ended (exit ${code})${err ? `: ${err.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}` });
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

export function createLighthouseService(ctx: Ctx, env: LighthouseEnv, collector: Collector, opts: { allowLoopback: boolean; userAgent: string }) {
  const runs: LighthouseRun[] = [];
  let seq = 0;
  const iso = () => ctx.clock().toISOString();
  const runner = findUp(path.join('runtime', 'lighthouse-runner.mjs'));
  const chromeFlags = (env.LIGHTHOUSE_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean);

  function memory() {
    const plan = memoryPlan({ CRAWLER_MEMORY_BUDGET_MB: env.CRAWLER_MEMORY_BUDGET_MB, CRAWLER_GO_MEMORY_MB: env.CRAWLER_GO_MEMORY_MB });
    if (!plan.budgetMB) return { free: undefined as number | undefined };
    return { free: Math.round(plan.budgetMB - nodeMemory().rssMB - activeChildMemoryMB()) };
  }

  function status(): LighthouseStatus {
    const problems: string[] = [];
    const version = lighthouseVersion();
    const chrome = findChrome(env.LIGHTHOUSE_CHROME_PATH);
    if (!env.LIGHTHOUSE_ENABLED) problems.push('Lighthouse is switched off on this server (LIGHTHOUSE_ENABLED=false).');
    if (!version) problems.push('The lighthouse package is not installed on the API server (npm install in apps/api installs it as an optional dependency).');
    if (!chrome) problems.push('No Chrome / Chromium browser was found on the API server. Install one, or set LIGHTHOUSE_CHROME_PATH (Docker: build with INSTALL_CHROMIUM=true).');
    if (!runner) problems.push('runtime/lighthouse-runner.mjs is missing from the API build.');
    const m = memory();
    if (m.free !== undefined && m.free < env.LIGHTHOUSE_MIN_FREE_MB) {
      problems.push(`Not enough free memory for a browser: ${m.free} MB left of the crawl memory budget, ${env.LIGHTHOUSE_MIN_FREE_MB} MB needed (LIGHTHOUSE_MIN_FREE_MB). A crawl may be running; on a ~500 MB server, run Lighthouse when no crawl is running, or use PageSpeed Insights.`);
    }
    if (!ctx.engine.readiness().baseUrl) problems.push('No website is configured (CRAWLER_BASE_URL).');
    return {
      available: !problems.length, problems, lighthouseVersion: version, chromePath: chrome, memoryNeededMB: env.LIGHTHOUSE_MIN_FREE_MB, memoryFreeMB: m.free,
      queued: queue.length, running: active?.id,
    };
  }

  async function checkUrl(raw: string): Promise<string> {
    let u: URL;
    try { u = new URL(String(raw).trim()); } catch { throw badRequest('Enter a full URL, for example https://www.example.com/products/x.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('The URL must start with http:// or https://.');
    if (u.username || u.password) throw badRequest('Remove the user name or password from the URL.');
    const base = ctx.engine.readiness().baseUrl;
    if (!base || hostOf(u.toString()).replace(/^www\./, '') !== hostOf(base).replace(/^www\./, '')) throw badRequest(`Only pages of ${base ? hostOf(base) : 'the configured website'} can be audited.`);
    try {
      await assertAllowedUrl(u.toString(), { allowLoopback: opts.allowLoopback && isLocalHost(u.toString()) });
    } catch (e) {
      throw badRequest(`Refusing to audit ${u.host}: ${(e as Error).message}`);
    }
    u.hash = '';
    return u.toString();
  }

  async function renderCompare(url: string, rendered: Record<string, unknown>, status: number | null, ms: number): Promise<RenderComparison> {
    const r = await collector.http.request(url, { readBody: true });
    const site = hostOf(url);
    const raw = r.body && r.finalStatus === 200 ? parseHtml(r.body, r.finalUrl, site) : undefined;
    const str = (v: unknown) => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join(' | ') : String(v)).trim();
    const fields: RenderComparison['fields'] = [];
    const add = (field: string, a: unknown, b: unknown, differs?: boolean) => fields.push({ field, raw: str(a), rendered: str(b), differs: differs ?? str(a) !== str(b) });
    add('Title', raw?.title, rendered.title);
    add('Meta description', raw?.metaDescription, rendered.metaDescription);
    add('Canonical', raw?.canonicals[0], rendered.canonical);
    add('Meta robots', raw?.metaRobots, typeof rendered.metaRobots === 'string' ? rendered.metaRobots.toLowerCase() : rendered.metaRobots);
    add('H1', raw?.h1s, rendered.h1s);
    const rl = Number(rendered.internalLinks ?? 0);
    const al = new Set(raw?.internalLinks ?? []).size;
    add('Internal links', al, rl, rl > al * 1.2 + 5);
    const rw = Number(rendered.wordCount ?? 0);
    const aw = raw?.wordCount ?? 0;
    add('Words of content', aw, rw, rw > aw * 1.3 + 50);
    add('JSON-LD blocks', raw?.jsonld.length ?? 0, rendered.jsonLdBlocks);
    return { status, ms, fields, differences: fields.filter((f) => f.differs).length };
  }

  function enqueue(run: LighthouseRun) {
    runs.unshift(run);
    if (runs.length > 50) runs.length = 50;
    queue.push({
      run,
      exec: async () => {
        run.status = 'running';
        run.startedAt = iso();
        const st = status();
        if (!st.available) {
          run.status = 'failed';
          run.error = st.problems.join(' ');
          run.finishedAt = iso();
          return;
        }
        const out = await runRunner(runner!, { url: run.url, mode: run.kind, formFactor: run.formFactor, chromePath: st.chromePath, timeoutMs: env.LIGHTHOUSE_TIMEOUT_MS, chromeFlags, userAgent: opts.userAgent }, env.LIGHTHOUSE_TIMEOUT_MS);
        if (!out.ok) {
          run.status = 'failed';
          run.error = out.error;
        } else if (out.mode === 'render') {
          try {
            run.render = await renderCompare(run.url, out.rendered, out.status, out.ms);
            run.status = 'completed';
          } catch (e) {
            run.status = 'failed';
            run.error = `rendered page fetched, raw HTML could not be compared: ${(e as Error).message}`;
          }
        } else {
          const { ok: _ok, mode: _m, ...summary } = out;
          run.result = summary as LighthouseSummary;
          run.status = summary.runtimeError ? 'failed' : 'completed';
          if (summary.runtimeError) run.error = `Lighthouse could not audit the page: ${summary.runtimeError}`;
        }
        run.finishedAt = iso();
      },
    });
    void pump();
  }

  return {
    async status(actor: Actor) {
      await need(ctx, actor, 'crawls.view');
      return status();
    },
    async start(actor: Actor, input: { url?: unknown; formFactors?: unknown; render?: unknown }) {
      await need(ctx, actor, 'crawls.run');
      const st = status();
      if (!st.available) throw new ApiError(409, 'LIGHTHOUSE_UNAVAILABLE', st.problems.join(' '));
      const url = await checkUrl(String(input.url ?? ''));
      const ffs = (Array.isArray(input.formFactors) ? input.formFactors : []).filter((f): f is LighthouseFormFactor => f === 'mobile' || f === 'desktop');
      if (!ffs.length && !input.render) throw badRequest('Choose mobile, desktop and/or the rendered check.');
      if (queue.length + ffs.length + (input.render ? 1 : 0) > 10) throw conflict('Too many audits are waiting. Try again when the queue is shorter.');
      const created: LighthouseRun[] = [];
      for (const f of [...new Set(ffs)]) created.push({ id: `LH-${++seq}`, url, kind: 'lighthouse', formFactor: f, status: 'queued', requestedBy: actor.name, createdAt: iso() });
      if (input.render) created.push({ id: `LH-${++seq}`, url, kind: 'render', status: 'queued', requestedBy: actor.name, createdAt: iso() });
      for (const r of created) enqueue(r);
      await audit(ctx, actor, 'lighthouse.start', 'crawl', created[0].id, `Lighthouse / rendered check queued for ${url} (${created.map((r) => r.formFactor ?? 'render').join(', ')})`);
      return created;
    },
    async list(actor: Actor) {
      await need(ctx, actor, 'crawls.view');
      return runs;
    },
    /** Tests: wait for the queue to drain. */
    async idle() {
      while (active || queue.length) await new Promise((r) => setTimeout(r, 100));
    },
  };
}
export type LighthouseService = ReturnType<typeof createLighthouseService>;
