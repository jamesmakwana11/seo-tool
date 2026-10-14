import type { FetchResult, RedirectHop } from './types';

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  /** Max body bytes read for HTML/XML/text (default 5 MB). */
  maxBodyBytes?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  /** Read the body (only for textual content types). Default true for GET. */
  readBody?: boolean;
  headers?: Record<string, string>;
  /** Follow redirects (manually). Default true. */
  follow?: boolean;
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

  async function single(url: string, ro: RequestOptions): Promise<{ res?: Response; ms: number; error?: string; body?: string; bytes?: number }> {
    const ctrl = new AbortController();
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
      const ct = res.headers.get('content-type') ?? '';
      const wantBody = (ro.readBody ?? (ro.method ?? 'GET') === 'GET') && !isRedirect && (TEXTUAL.test(ct) || !ct);
      if (wantBody && res.body) {
        const buf = await readLimited(res, maxBody);
        bytes = buf.byteLength;
        body = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      } else {
        const cl = Number(res.headers.get('content-length'));
        if (Number.isFinite(cl) && res.headers.has('content-length')) bytes = cl;
        await res.body?.cancel().catch(() => undefined);
      }
      return { res, ms, body, bytes };
    } catch (e) {
      return { ms: Math.round(performance.now() - t0), error: describeError(e, timedOut, opts.timeoutMs) };
    } finally {
      clearTimeout(timer);
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
      const r = await single(current, ro);
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
      };
    }
  }

  /** Size of an asset: HEAD content-length, falling back to a ranged / full GET (bytes counted, body discarded). */
  async function assetSize(url: string): Promise<{ status: number | null; bytes?: number; contentType?: string; error?: string }> {
    const head = await request(url, { method: 'HEAD', readBody: false });
    const cl = Number(head.headers['content-length']);
    if (head.finalStatus && head.finalStatus < 400 && head.headers['content-length'] !== undefined && Number.isFinite(cl)) {
      return { status: head.finalStatus, bytes: cl, contentType: head.headers['content-type'] };
    }
    // Fallback: GET and count bytes (capped at 20 MB).
    const r = await countBytes(url);
    return r;
  }

  async function countBytes(url: string): Promise<{ status: number | null; bytes?: number; contentType?: string; error?: string }> {
    const ctrl = new AbortController();
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
      const buf = await readLimited(res, 20 * 1024 * 1024);
      return { status: res.status, bytes: buf.byteLength, contentType: res.headers.get('content-type') ?? undefined };
    } catch (e) {
      return { status: null, error: describeError(e, timedOut, opts.timeoutMs) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { request, assetSize };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    if (total >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Simple promise pool. */
export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
