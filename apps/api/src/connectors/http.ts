/**
 * Shared HTTP plumbing for connectors, delivery adapters, Task Ops and the LLM adapter.
 *
 * Every outbound call goes through an injectable `fetchImpl` (default: global fetch) so tests never touch
 * the network. Helpers never throw on HTTP/network failures and every human-readable string is passed
 * through `redact()` so tokens, API keys, webhook URLs and private keys never reach results or logs.
 */
import type { IntegrationId } from '@sentinel/shared';
import { configuredVars, type Env } from '../config/env';
import type { Connector, ConnectorTestResult } from '../services/ports';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Minimal logger surface (satisfied by pino). Callers must never pass message bodies or secrets. */
export interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------------------------- redaction

const SECRET_VAR = /TOKEN|SECRET|PASSWORD|KEY|_JSON$|WEBHOOK_URL/;

/** Parses a JSON env value that may be raw JSON or base64-encoded JSON. */
export function parseJsonMaybeBase64(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const attempts = [raw.trim()];
  if (!raw.trim().startsWith('{')) attempts.push(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Values of every secret-bearing env var (plus key material inside service-account JSON). */
export function secretValues(env: Env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_VAR.test(name) || typeof value !== 'string' || value.length < 4) continue;
    out.push(value);
    if (name.endsWith('_JSON')) {
      const j = parseJsonMaybeBase64(value);
      for (const f of ['private_key', 'private_key_id', 'client_secret']) {
        const v = j?.[f];
        if (typeof v === 'string' && v.length >= 4) out.push(v);
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Removes secret values and secret-looking fragments (key= params, bearer tokens, PEM blocks, Slack hook paths). */
export function redact(input: string, secrets: string[] = []): string {
  let s = input;
  for (const sec of secrets) if (sec && sec.length >= 4) s = s.split(sec).join('[redacted]');
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]');
  s = s.replace(/([?&](?:key|api_key|apikey|access_token|token|refresh_token|client_secret)=)[^&\s"'<>]+/gi, '$1[redacted]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]');
  s = s.replace(/(hooks\.slack\.com\/services\/)[^\s"'<>]+/gi, '$1[redacted]');
  return s;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? cause.message : typeof cause === 'object' && cause && 'code' in cause ? String((cause as { code: unknown }).code) : '';
    return causeMsg && !e.message.includes(causeMsg) ? `${e.message} (${causeMsg})` : e.message;
  }
  return String(e);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'configured host';
  }
}

const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------------------------------------- requests

export type HttpResult =
  | { kind: 'response'; status: number; text: string; json: unknown; headers: Headers }
  | { kind: 'network'; error: string };

/** Performs one request. Never throws: network/timeout failures are returned as `{ kind: 'network' }`. */
export async function httpRequest(fetchImpl: FetchLike, url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HttpResult> {
  try {
    const res = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { kind: 'response', status: res.status, text, json, headers: res.headers };
  } catch (e) {
    return { kind: 'network', error: errMsg(e) };
  }
}

/** Branded so the negative branch of the type guard keeps non-2xx responses (not just network errors). */
export type Http2xx = Extract<HttpResult, { kind: 'response' }> & { readonly __2xx: true };
export const is2xx = (r: HttpResult): r is Http2xx => r.kind === 'response' && r.status >= 200 && r.status < 300;

/** Best-effort provider error message (Google / OpenAI / Meta / Ahrefs / Slack shapes). */
export function providerMessage(r: HttpResult): string {
  if (r.kind === 'network') return r.error;
  const j = r.json as Record<string, unknown> | undefined;
  let m = '';
  if (j && typeof j === 'object') {
    const e = j.error;
    if (typeof e === 'string') m = typeof j.error_description === 'string' ? `${e}: ${j.error_description}` : e;
    else if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string') m = (e as Record<string, string>).message;
    else if (typeof j.message === 'string') m = j.message;
    else if (typeof j.errors === 'string') m = j.errors;
  }
  if (!m && r.text && !/^\s*[<{[]/.test(r.text)) m = r.text;
  return truncate(m.replace(/\s+/g, ' ').trim());
}

/** Is a delivery failure worth retrying? (5xx, 429, network) */
export function isRetryable(r: HttpResult): boolean {
  return r.kind === 'network' || r.status === 429 || r.status >= 500;
}

/** Maps a non-2xx/network result to an honest, secret-free connector result. */
export function failureResult(label: string, url: string, r: HttpResult): ConnectorTestResult {
  if (r.kind === 'network') return { ok: false, result: `${label}: could not reach host ${hostOf(url)} (${truncate(r.error)})` };
  const msg = providerMessage(r);
  const suffix = msg ? ` — ${msg}` : '';
  if (r.status === 401 || r.status === 403) return { ok: false, result: `${label}: credentials rejected (HTTP ${r.status})${suffix}` };
  if (r.status === 429) return { ok: false, rateLimited: true, result: `${label}: rate limited (HTTP 429) — retry later${suffix}` };
  return { ok: false, result: `${label}: request failed (HTTP ${r.status})${suffix}` };
}

/** Generic delivery/send error string. */
export function sendError(label: string, url: string, r: HttpResult): { ok: false; error: string; retryable: boolean } {
  const f = failureResult(label, url, r);
  return { ok: false, error: f.result, retryable: isRetryable(r) };
}

// ---------------------------------------------------------------------------------------------- connector factory

export interface ConnectorSpec {
  id: IntegrationId;
  env: Env;
  envVars: string[];
  optionalVars?: string[];
  /** Override for connectors with conditional requirements (e.g. backlinks provider). */
  isConfigured?: () => boolean;
  missingVars?: () => string[];
  run: () => Promise<ConnectorTestResult>;
}

/** A Connector that can also name its missing env vars (names only). */
export type HintedConnector = Connector & { missingVars(): string[] };

/** Wraps a connector so test() never throws, never runs unconfigured, and never leaks secrets. */
export function defineConnector(spec: ConnectorSpec): HintedConnector {
  const optional = new Set(spec.optionalVars ?? []);
  const missingVars = spec.missingVars ?? (() => spec.envVars.filter((n) => !optional.has(n) && !configuredVars(spec.env, [n]).length));
  const isConfigured = spec.isConfigured ?? (() => missingVars().length === 0);
  return {
    id: spec.id,
    envVars: spec.envVars,
    optionalVars: spec.optionalVars,
    isConfigured,
    missingVars,
    async test() {
      if (!isConfigured()) return { ok: false, result: `Not configured — missing ${missingVars().join(', ') || 'required settings'}` };
      let out: ConnectorTestResult;
      try {
        out = await spec.run();
      } catch (e) {
        out = { ok: false, result: `Unexpected error during connection test: ${truncate(errMsg(e))}` };
      }
      return { ...out, result: redact(out.result, secretValues(spec.env)) };
    },
  };
}
