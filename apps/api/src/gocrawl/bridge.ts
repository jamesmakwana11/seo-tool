/**
 * Node ⇄ Go bridge, protocol v1 (newline-delimited JSON over stdio; see services/crawler-go/main.go).
 *
 *   API → crawler  {"type":"start","protocol":1,"job":{…}}   then optionally {"type":"cancel","reason":"user"|"resource"}
 *   crawler → API  {"type":"hello"|"phase"|"progress"|"sitemap"|"warning"|"error"|"done", …}
 *
 * Page results are written by the crawler to files in the job's work directory; only progress and the summary travel
 * over stdout. Failure handling:
 *  - no "hello" within startTimeoutMs, or a protocol mismatch → the process is killed and the run fails with the reason;
 *  - the process exits without "done" (crash, out of memory, killed) → failed, with the exit code / signal and the last
 *    lines of stderr (the work files written so far are still read by the caller when they are usable);
 *  - cancel: a "cancel" message, then SIGKILL if the crawler has not finished within cancelGraceMs;
 *  - resource stop: the caller's memory check sends {"type":"cancel","reason":"resource"} (results are kept).
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { minimalEnv, PROTOCOL_VERSION } from './binaries';

export interface GoProgress {
  type: 'progress';
  phase?: string;
  discovered: number;
  queued: number;
  waiting: number;
  active: number;
  processed: number;
  succeeded: number;
  failed: number;
  robots: number;
  depthLimited: number;
  pageLimited: number;
  excluded: number;
  excludedBy: Record<string, number>;
  notProcessed: number;
  pagesPerMin: number;
  sitemapUrls: number;
  politeness?: { delayMs: number; floorMs?: number; crawlDelayMs?: number; slowDowns: number; retries: number; rateLimited?: number; waitedMs?: number; avgLatencyMs?: number; unavailable503?: number; limitedAnswers?: number };
  requests?: number;
  requestsPerMin?: number;
  lastRequestAt?: string | null;
  checks?: { total: number; done: number; groups: Record<string, { total: number; done: number }> };
  memory?: { goRssMB: number; goHeapMB: number; textCoreRssMB: number; goPeakMB: number; textCorePeakMB: number };
  elapsedMs: number;
}

export interface GoDone {
  type: 'done';
  state: 'completed' | 'partial' | 'cancelled' | 'resource_stopped' | 'failed';
  reason?: string;
  code?: string;
  counts?: Omit<GoProgress, 'type'>;
  timings?: Record<string, number>;
  textCore?: boolean;
  textCoreError?: string;
}

export type GoEvent =
  | { type: 'hello'; protocol: number; version: string; go: string; pid: number }
  | { type: 'phase'; phase: string; elapsedMs: number }
  | GoProgress
  | { type: 'sitemap'; file: { url: string; status: number | null; kind: string; count: number; error?: string } }
  | { type: 'warning'; code: string; message: string; active?: { url: string; seconds: number }[] }
  | { type: 'error'; code: string; message: string }
  | GoDone;

export interface GoRunOptions {
  bin: string;
  job: Record<string, unknown>;
  onEvent?: (e: GoEvent) => void;
  signal?: AbortSignal;
  /** Called every second while the crawler runs; return a reason to stop the crawl for resources (results are kept). */
  resourceCheck?: () => string | undefined;
  /** Called every second; return a reason to stop a crawl that has stopped making progress (results are kept, outcome partial). */
  stallCheck?: () => string | undefined;
  startTimeoutMs?: number;
  cancelGraceMs?: number;
  /** Kill the crawler if it sends nothing at all for this long (it reports progress every second). */
  silenceTimeoutMs?: number;
}

export interface GoRunResult {
  done?: GoDone;
  hello?: Extract<GoEvent, { type: 'hello' }>;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  /** Last part of the crawler's stderr (diagnostics; never contains secrets — the crawler gets none). */
  stderrTail: string;
  /** Why the bridge (not the crawler) ended the run. */
  bridgeError?: string;
  stoppedFor?: 'user' | 'resource' | 'stalled';
  resourceReason?: string;
  stallReason?: string;
  errors: { code: string; message: string }[];
}

export function runGoCrawler(o: GoRunOptions): Promise<GoRunResult> {
  const startTimeout = o.startTimeoutMs ?? 15_000;
  const grace = o.cancelGraceMs ?? 60_000;
  const silence = o.silenceTimeoutMs ?? 10 * 60_000;
  return new Promise((resolve) => {
    const res: GoRunResult = { exitCode: null, exitSignal: null, stderrTail: '', errors: [] };
    let settled = false;
    let lastEvent = Date.now();
    const child = spawn(o.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: minimalEnv(), windowsHide: true });
    const timers: NodeJS.Timeout[] = [];
    const send = (m: unknown) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(m)}\n`);
    };
    const kill = (why: string) => {
      res.bridgeError ??= why;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    };
    const cancel = (reason: 'user' | 'resource' | 'stalled') => {
      if (res.stoppedFor) return;
      res.stoppedFor = reason;
      send({ type: 'cancel', reason });
      const t = setTimeout(() => kill(`the crawler did not stop within ${Math.round(grace / 1000)} s of being cancelled`), grace);
      timers.push(t);
    };

    child.on('error', (e) => {
      res.bridgeError ??= `could not start the crawler: ${e.message}`;
      finish();
    });
    child.stdin.on('error', () => { /* the crawler exited; handled by 'close' */ });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      res.stderrTail = (res.stderrTail + d).slice(-8000);
    });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      lastEvent = Date.now();
      if (!line.trim()) return;
      let e: GoEvent;
      try {
        e = JSON.parse(line) as GoEvent;
      } catch {
        res.errors.push({ code: 'protocol', message: `unreadable line from the crawler: ${line.slice(0, 200)}` });
        return;
      }
      if (e.type === 'hello') {
        res.hello = e;
        if (e.protocol !== PROTOCOL_VERSION) {
          kill(`the crawler speaks protocol ${e.protocol}; the API needs protocol ${PROTOCOL_VERSION}`);
          return;
        }
      } else if (e.type === 'done') res.done = e;
      else if (e.type === 'error') res.errors.push({ code: e.code, message: e.message });
      try { o.onEvent?.(e); } catch { /* a progress consumer must never break the bridge */ }
    });

    child.on('close', (code, signal) => {
      res.exitCode = code;
      res.exitSignal = signal;
      finish();
    });

    function finish() {
      if (settled) return;
      settled = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      o.signal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve(res);
    }

    const onAbort = () => cancel('user');
    if (o.signal?.aborted) {
      // Never started: do not even send the job.
      kill('cancelled before the crawl started');
      res.stoppedFor = 'user';
      return;
    }
    o.signal?.addEventListener('abort', onAbort, { once: true });

    send({ type: 'start', protocol: PROTOCOL_VERSION, job: o.job });
    timers.push(setTimeout(() => {
      if (!res.hello) kill(`the crawler did not answer within ${Math.round(startTimeout / 1000)} s of starting`);
    }, startTimeout));
    timers.push(setInterval(() => {
      if (settled) return;
      if (Date.now() - lastEvent > silence) {
        kill(`the crawler sent nothing for ${Math.round(silence / 1000)} s`);
        return;
      }
      const why = o.resourceCheck?.();
      if (why && !res.stoppedFor) {
        res.resourceReason = why;
        cancel('resource');
        return;
      }
      const stall = o.stallCheck?.();
      if (stall && !res.stoppedFor) {
        res.stallReason = stall;
        cancel('stalled');
      }
    }, 1000));
  });
}
