/**
 * Google API requests: bearer / key auth, bounded retries for rate limits and server errors (honouring Retry-After),
 * and failures turned into a GoogleError with a plain-language message an Admin can act on. Never logs or returns
 * tokens or keys (messages pass through redact()).
 */
import { httpRequest, providerMessage, redact, type FetchLike, type HttpResult } from '../connectors/http';

export type GoogleErrorCode = 'expired' | 'permission' | 'not_found' | 'rate_limited' | 'api_disabled' | 'bad_request' | 'network' | 'server' | 'not_configured' | 'not_connected';

export class GoogleError extends Error {
  constructor(readonly code: GoogleErrorCode, message: string, readonly status?: number) { super(message); }
}

/** Google Cloud APIs the features need, as named in Google Cloud → APIs & Services → Library. */
export const API_NAMES: Record<string, string> = {
  'analyticsadmin.googleapis.com': 'Google Analytics Admin API',
  'analyticsdata.googleapis.com': 'Google Analytics Data API',
  'www.googleapis.com/webmasters': 'Google Search Console API',
  'searchconsole.googleapis.com': 'Google Search Console API',
  'www.googleapis.com/pagespeedonline': 'PageSpeed Insights API',
  'chromeuxreport.googleapis.com': 'Chrome UX Report API',
};
export function apiNameOf(url: string): string {
  for (const [k, v] of Object.entries(API_NAMES)) if (url.includes(k)) return v;
  return 'Google API';
}

function reasonOf(r: Extract<HttpResult, { kind: 'response' }>): string {
  const j = r.json as { error?: { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } } | undefined;
  return [j?.error?.status, ...(j?.error?.errors ?? []).map((e) => e.reason), ...(j?.error?.details ?? []).map((d) => d.reason)].filter(Boolean).join(' ');
}

/** Maps a non-2xx Google response to a GoogleError (message safe to show and store). */
export function googleFailure(label: string, url: string, r: HttpResult, secrets: string[] = []): GoogleError {
  const clean = (s: string) => redact(s, secrets);
  if (r.kind === 'network') return new GoogleError('network', clean(`${label}: Google could not be reached (${r.error}). Try again.`));
  const msg = clean(providerMessage(r)).slice(0, 300);
  const reason = reasonOf(r);
  const api = apiNameOf(url);
  if (r.status === 429 || /RESOURCE_EXHAUSTED|rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason)) {
    return new GoogleError('rate_limited', `${label}: Google’s rate limit or daily quota for the ${api} was reached. Try again in a few minutes${/quota/i.test(reason + msg) ? ' (or raise the quota in Google Cloud)' : ''}.`, r.status);
  }
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(reason + msg)) {
    return new GoogleError('api_disabled', `${label}: the ${api} is not enabled in the Google Cloud project of the OAuth client / API key. Enable it in Google Cloud → APIs & Services → Library, wait a minute, then test again.`, r.status);
  }
  if (r.status === 401) return new GoogleError('expired', `${label}: Google no longer accepts this account’s access (HTTP 401). Reconnect the Google account.`, 401);
  if (r.status === 403) return new GoogleError('permission', `${label}: Google refused access (HTTP 403)${msg ? ` — ${msg}` : ''}.`, 403);
  if (r.status === 404) return new GoogleError('not_found', `${label}: not found (HTTP 404)${msg ? ` — ${msg}` : ''}.`, 404);
  if (r.status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(r.text)) return new GoogleError('permission', `${label}: Google says the API key is not valid. Check the key (Google Cloud → APIs & Services → Credentials).`, 400);
    return new GoogleError('bad_request', `${label}: Google rejected the request (HTTP 400)${msg ? ` — ${msg}` : ''}.`, 400);
  }
  if (r.status >= 500) return new GoogleError('server', `${label}: Google answered with a server error (HTTP ${r.status}). Try again later.`, r.status);
  return new GoogleError('server', `${label}: unexpected answer from Google (HTTP ${r.status})${msg ? ` — ${msg}` : ''}.`, r.status);
}

export interface GoogleHttp {
  /** One request with retries for 429 / 5xx / network (max `retries`), waiting Retry-After (capped) between tries. */
  call(url: string, init: RequestInit, o?: { timeoutMs?: number; retries?: number }): Promise<HttpResult>;
}

export function createGoogleHttp(d: { fetchImpl: FetchLike; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number }): GoogleHttp {
  const sleep = d.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const maxWait = d.maxWaitMs ?? 8000;
  return {
    async call(url, init, o = {}) {
      const retries = o.retries ?? 2;
      let last: HttpResult | undefined;
      for (let attempt = 0; attempt <= retries; attempt++) {
        last = await httpRequest(d.fetchImpl, url, init, o.timeoutMs ?? 30_000);
        const retryable = last.kind === 'network' || last.status === 429 || last.status === 500 || last.status === 502 || last.status === 503 || last.status === 504;
        if (!retryable || attempt === retries) return last;
        const ra = last.kind === 'response' ? Number(last.headers.get('retry-after')) : NaN;
        await sleep(Math.min(maxWait, Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 500 * 2 ** attempt));
      }
      return last!;
    },
  };
}

/** Bounded concurrency (server-wide, per kind of call). */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}
