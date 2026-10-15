import { gunzipSync } from 'node:zlib';
import type { FetchResult, RedirectHop } from './types';

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  /** Max body bytes read for HTML/XML/text (default 5 MB). */
  maxBodyBytes?: number;
  /** Cancels in-flight and future requests (crawl cancellation). */
  signal?: AbortSignal;
  /** Awaited before every request — a shared per-crawl throttle (see createThrottle). */
  throttle?: Throttle;
  /** Retries per request for 429 / 502 / 503 / 504, timeouts and dropped connections (default 2). */
  retries?: number;
  /** Longest wait before a retry; a longer Retry-After is not waited for (the response is recorded). Default 30 s. */
  maxRetryWaitMs?: number;
  /** Called before each retry (statistics). */
  onRetry?: (info: { url: string; status?: number; error?: string; waitMs: number; attempt: number }) => void;
}

/** Shared per-crawl request pacing. Call it before each request; it slows down when the site pushes back. */
export interface Throttle {
  (): Promise<void>;
  /** The site answered 429 / 503: at least double the gap (or follow Retry-After), up to `maxMs`. */
  slowDown(retryAfterMs?: number): void;
  /** A normal answer: after a run of them, halve the gap again (never below the floor). */
  relax(): void;
  /** Raise the minimum gap (e.g. robots.txt Crawl-delay). */
  setFloor(ms: number): void;
  readonly intervalMs: number;
  readonly floorMs: number;
  readonly slowDowns: number;
}

/**
 * Minimum gap between request starts, shared by every client of one crawl (politeness towards the site).
 * Adaptive: 429 / 503 answers widen the gap (up to `maxMs`); a run of normal answers narrows it back to the floor.
 */
export function createThrottle(minIntervalMs: number, signal?: AbortSignal, maxMs = 30000): Throttle {
  let next = 0;
  let lastStart = 0;
  let floor = Math.max(0, minIntervalMs);
  let interval = floor;
  let okRun = 0;
  let slowDowns = 0;
  const t = (async () => {
    const now = Date.now();
    if (interval <= 0) {
      lastStart = now;
      return;
    }
    const at = Math.max(now, next);
    lastStart = at;
    next = at + interval;
    const wait = at - now;
    if (wait > 0) await sleep(wait, signal);
  }) as Throttle;
  t.slowDown = (retryAfterMs?: number) => {
    slowDowns++;
    okRun = 0;
    interval = Math.min(maxMs, Math.max(floor, interval * 2, 1000, retryAfterMs ?? 0));
    next = Math.max(next, lastStart + interval);
  };
  t.relax = () => {
    if (interval <= floor) return;
    if (++okRun >= 20) {
      okRun = 0;
      interval = Math.max(floor, Math.floor(interval / 2));
    }
  };
  t.setFloor = (ms: number) => {
    floor = Math.min(maxMs, Math.max(floor, ms));
    interval = Math.max(interval, floor);
    next = Math.max(next, lastStart + interval); // the very next request already respects the new gap
  };
  Object.defineProperty(t, 'intervalMs', { get: () => interval });
  Object.defineProperty(t, 'floorMs', { get: () => floor });
  Object.defineProperty(t, 'slowDowns', { get: () => slowDowns });
  return t;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Retry-After header in ms (delta-seconds or HTTP date), or undefined. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** Network errors worth retrying (not SSRF blocks, DNS misses, bad URLs or cancellation). */
const NO_RETRY_ERROR = /^(cancelled|blocked:|could not resolve|more than \d+ redirects)|BLOCKED_DESTINATION|ENOTFOUND|EAI_AGAIN|invalid Location|ERR_INVALID_URL/i;

export interface RequestOptions {
  /** Retry transient failures (default true). Off for measurements such as bot-protection probes. */
  retry?: boolean;
  method?: 'GET' | 'HEAD';
  /** Read the body (only for textual content types). Default true for GET. */
  readBody?: boolean;
  headers?: Record<string, string>;
  /** Follow redirects (manually). Default true. */
  follow?: boolean;
  /** Read the body whatever the content type (e.g. sitemaps served as application/octet-stream). */
  anyContentType?: boolean;
  /** Decompress a gzip body (a .xml.gz sitemap served without Content-Encoding). */
  gunzip?: boolean;
  /** Body read limit for this request (default: the client's maxBodyBytes). */
  maxBodyBytes?: number;
}

const TEXTUAL = /(text\/|html|xml|json|javascript)/i;

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function describeError(e: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `timeout after ${timeoutMs}ms`;
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code;
  const msg = err?.cause?.message || err?.message || String(e);
  return code ? `${code}: ${msg}` : msg;
}

/**
 * HTTP client with manual redirect following (`redirect: 'manual'`), per-request AbortController
 * timeouts and honest failure reporting: network errors/timeouts return `status: null` + `error`, never throw.
 */
export function createHttpClient(opts: HttpClientOptions) {
  const f = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBody = opts.maxBodyBytes ?? 5 * 1024 * 1024;

  async function single(url: string, ro: RequestOptions): Promise<{ res?: Response; ms: number; error?: string; body?: string; bytes?: number; truncated?: boolean }> {
    if (opts.signal?.aborted) return { ms: 0, error: 'cancelled' };
    await opts.throttle?.();
    if (opts.signal?.aborted) return { ms: 0, error: 'cancelled' };
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, opts.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await f(url, {
        method: ro.method ?? 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(ro.headers ?? {}) },
      });
      const ms = Math.round(performance.now() - t0);
      const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
      let body: string | undefined;
      let bytes: number | undefined;
      let truncated: boolean | undefined;
      const ct = res.headers.get('content-type') ?? '';
      const wantBody = (ro.readBody ?? (ro.method ?? 'GET') === 'GET') && !isRedirect && (TEXTUAL.test(ct) || !ct || !!ro.anyContentType);
      if (wantBody && res.body) {
        const limit = ro.maxBodyBytes ?? maxBody;
        let { buf, truncated: cut } = await readLimited(res, limit);
        bytes = buf.byteLength;
        if (ro.gunzip && buf[0] === 0x1f && buf[1] === 0x8b) {
          if (cut) return { res, ms, bytes, truncated: true, error: `compressed file larger than ${Math.round(limit / 1048576)} MB` };
          try {
            buf = gunzipSync(buf, { maxOutputLength: limit });
          } catch (e) {
            const tooBig = (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
            return { res, ms, bytes, truncated: tooBig || undefined, error: tooBig ? `larger than ${Math.round(limit / 1048576)} MB after decompression` : `could not decompress gzip body: ${(e as Error).message}` };
          }
        }
        if (cut) truncated = true;
        body = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      } else {
        const cl = Number(res.headers.get('content-length'));
        if (Number.isFinite(cl) && res.headers.has('content-length')) bytes = cl;
        await res.body?.cancel().catch(() => undefined);
      }
      return { res, ms, body, bytes, truncated };
    } catch (e) {
      return { ms: Math.round(performance.now() - t0), error: opts.signal?.aborted ? 'cancelled' : describeError(e, timedOut, opts.timeoutMs) };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  const retries = Math.max(0, opts.retries ?? 2);
  const maxRetryWait = opts.maxRetryWaitMs ?? 30000;

  /** One hop with retries for transient failures; feeds the adaptive throttle. */
  async function attempt(url: string, ro: RequestOptions): Promise<ReturnType<typeof single> extends Promise<infer T> ? T : never> {
    for (let n = 0; ; n++) {
      const r = await single(url, ro);
      const status = r.res?.status;
      const ra = retryAfterMs(r.res?.headers.get('retry-after'));
      // Measurements (retry: false, e.g. bot-protection probes with other user-agents) never change the crawl's pace.
      if (ro.retry !== false) {
        if (status === 429 || status === 503) opts.throttle?.slowDown(ra);
        else if (status !== undefined && status < 500) opts.throttle?.relax();
      }
      const transient = status !== undefined ? RETRY_STATUS.has(status) : !!r.error && !NO_RETRY_ERROR.test(r.error);
      if (ro.retry === false || n >= retries || !transient || opts.signal?.aborted) return r;
      const backoff = 1000 * 2 ** n + Math.floor(Math.random() * 250);
      const waitMs = ra ?? backoff;
      if (waitMs > maxRetryWait) return r; // the site asked for a longer pause than we wait per page: record the answer
      opts.onRetry?.({ url, status, error: r.error, waitMs, attempt: n + 1 });
      await sleep(waitMs, opts.signal);
      if (opts.signal?.aborted) return r;
    }
  }

  async function request(url: string, ro: RequestOptions = {}): Promise<FetchResult> {
    const start = performance.now();
    const chain: RedirectHop[] = [];
    const seen = new Set<string>([url]);
    let current = url;
    let firstStatus: number | null = null;
    let firstMs: number | undefined;
    for (let hop = 0; ; hop++) {
      const r = await attempt(current, ro);
      if (firstMs === undefined) firstMs = r.ms;
      if (!r.res) {
        return {
          url, finalUrl: current, status: firstStatus, finalStatus: null, chain, redirectLoop: false, tooManyRedirects: false,
          responseMs: firstMs, finalResponseMs: r.ms, totalMs: Math.round(performance.now() - start), error: r.error, headers: {},
        };
      }
      const status = r.res.status;
      if (firstStatus === null) firstStatus = status;
      const headers = headersToRecord(r.res.headers);
      const loc = headers['location'];
      if (status >= 300 && status < 400 && loc && ro.follow !== false) {
        let next: string;
        try {
          next = new URL(loc, current).toString();
        } catch {
          return {
            url, finalUrl: current, status: firstStatus, finalStatus: status, chain, redirectLoop: false, tooManyRedirects: false,
            responseMs: firstMs, finalResponseMs: r.ms, totalMs: Math.round(performance.now() - start), error: `invalid Location header: ${loc}`, headers,
          };
        }
        chain.push({ url: current, status, location: next });
        if (seen.has(next)) {
          return {
            url, finalUrl: next, status: firstStatus, finalStatus: null, chain, redirectLoop: true, tooManyRedirects: false,
            responseMs: firstMs, totalMs: Math.round(performance.now() - start), error: 'redirect loop', headers,
          };
        }
        if (chain.length >= maxRedirects) {
          return {
            url, finalUrl: next, status: firstStatus, finalStatus: null, chain, redirectLoop: false, tooManyRedirects: true,
            responseMs: firstMs, totalMs: Math.round(performance.now() - start), error: `more than ${maxRedirects} redirects`, headers,
          };
        }
        seen.add(next);
        current = next;
        continue;
      }
      return {
        url, finalUrl: current, status: firstStatus, finalStatus: status, chain, redirectLoop: false, tooManyRedirects: false,
        responseMs: firstMs, finalResponseMs: r.ms, totalMs: Math.round(performance.now() - start), headers,
        contentType: headers['content-type'], body: r.body, bytes: r.bytes,
        ...(r.truncated ? { truncated: true } : {}), ...(r.error ? { error: r.error } : {}),
      };
    }
  }

  /** Size of an asset: HEAD content-length, falling back to a ranged / full GET (bytes counted, body discarded). */
  async function assetSize(url: string): Promise<{ status: number | null; bytes?: number; contentType?: string; error?: string }> {
    const head = await request(url, { method: 'HEAD', readBody: false, retry: false });
    const cl = Number(head.headers['content-length']);
    if (head.finalStatus && head.finalStatus < 400 && head.headers['content-length'] !== undefined && Number.isFinite(cl)) {
      return { status: head.finalStatus, bytes: cl, contentType: head.headers['content-type'] };
    }
    // Fallback: GET and count bytes (capped at 20 MB).
    const r = await countBytes(url);
    return r;
  }

  async function countBytes(url: string): Promise<{ status: number | null; bytes?: number; contentType?: string; error?: string }> {
    if (opts.signal?.aborted) return { status: null, error: 'cancelled' };
    await opts.throttle?.();
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, opts.timeoutMs);
    try {
      const res = await f(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': opts.userAgent } });
      const cr = res.headers.get('content-range');
      const total = cr?.match(/\/(\d+)$/)?.[1];
      if (total) {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, bytes: Number(total), contentType: res.headers.get('content-type') ?? undefined };
      }
      const { buf } = await readLimited(res, 20 * 1024 * 1024);
      return { status: res.status, bytes: buf.byteLength, contentType: res.headers.get('content-type') ?? undefined };
    } catch (e) {
      return { status: null, error: opts.signal?.aborted ? 'cancelled' : describeError(e, timedOut, opts.timeoutMs) };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  return { request, assetSize };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

async function readLimited(res: Response, max: number): Promise<{ buf: Uint8Array; truncated: boolean }> {
  if (!res.body) return { buf: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {
      // Keep exactly `max` bytes and stop reading: the rest of the body is not downloaded.
      parts.push(value.subarray(0, max - total));
      total = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return { buf: out, truncated };
}

/** Simple promise pool. Stops taking new items once `signal` is aborted (unfinished slots stay undefined). */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
