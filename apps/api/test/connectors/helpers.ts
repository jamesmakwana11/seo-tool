import { generateKeyPairSync } from 'node:crypto';
import { loadEnv, type Env } from '../../src/config/env';
import type { FetchLike } from '../../src/connectors/http';

export interface Call { url: string; init?: RequestInit; body?: string; headers: Record<string, string> }
export type Responder = (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

/** Mock fetch that records calls. `responder` decides per call. */
export function mockFetch(responder: Responder): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, init, body: typeof init?.body === 'string' ? init.body : undefined, headers });
    return responder(url, init, calls.length);
  }) as FetchLike & { calls: Call[] };
  f.calls = calls;
  return f;
}

/** A network failure whose message contains the URL (and therefore possibly an API key) — must be redacted. */
export const networkError = (url: string) => {
  const e = new TypeError(`fetch failed while requesting ${url}`);
  (e as Error & { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  throw e;
};

let keyCache: { privateKey: string; publicKey: string } | undefined;
export function rsaKeys() {
  keyCache ??= generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return keyCache;
}

export function serviceAccountJson(email = 'sentinel@deodap-seo.iam.gserviceaccount.com') {
  return JSON.stringify({ type: 'service_account', client_email: email, private_key: rsaKeys().privateKey, private_key_id: 'pkid-SECRET-0123456789' });
}

/** Secret values used across tests — results/logs/errors must never contain any of them. */
export const SECRETS = {
  AHREFS_API_TOKEN: 'ahrefs-SECRET-token-abcdef',
  SEMRUSH_API_KEY: 'semrush-SECRET-key-abcdef',
  SHOPIFY_ADMIN_TOKEN: 'shpat_SECRET_abcdef123456',
  SHOPIFY_WEBHOOK_SECRET: 'whsec-SECRET-abcdef',
  GOOGLE_API_KEY: 'AIzaSECRET-google-key-123',
  GBP_OAUTH_CLIENT_SECRET: 'gbp-SECRET-client-secret',
  GBP_OAUTH_REFRESH_TOKEN: '1//gbp-SECRET-refresh-token',
  OPENAI_API_KEY: 'sk-SECRET-openai-abcdef',
  GEMINI_API_KEY: 'AIzaSECRET-gemini-key-456',
  PERPLEXITY_API_KEY: 'pplx-SECRET-abcdef',
  SMTP_PASSWORD: 'smtp-SECRET-password',
  WHATSAPP_API_TOKEN: 'EAAG-SECRET-whatsapp-token',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/SECRETslackhookpath',
  TASK_OPS_TOKEN: 'taskops-SECRET-token',
};

export const FULL_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  CRAWLER_BASE_URL: 'https://deodap.in',
  CRAWLER_USER_AGENT: 'DeoDapSentinelBot/1.0',
  CRAWLER_ALLOW_LIVE: 'true',
  GSC_SERVICE_ACCOUNT_JSON: '', // filled lazily
  GSC_PROPERTY: 'https://deodap.in/',
  GA4_SERVICE_ACCOUNT_JSON: '',
  GA4_PROPERTY_ID: '123456789',
  BACKLINK_PROVIDER: 'ahrefs',
  SHOPIFY_STORE_DOMAIN: 'deodap.myshopify.com',
  GBP_OAUTH_CLIENT_ID: 'gbp-client-id.apps.googleusercontent.com',
  GBP_LOCATION_ID: 'locations/42',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'alerts@deodap.test',
  SMTP_FROM: 'Sentinel <alerts@deodap.test>',
  DIGEST_RECIPIENTS: 'seo@deodap.test, dev@deodap.test',
  WHATSAPP_PHONE_NUMBER_ID: '1098765432',
  WHATSAPP_RECIPIENTS: '+91 98765 43210,919812345678',
  TASK_OPS_BASE_URL: 'https://tasks.deodap.test',
  ...SECRETS,
};

export function makeEnv(overrides: Record<string, string | undefined> = {}, base: Record<string, string> = FULL_ENV): Env {
  const sa = serviceAccountJson();
  const src: Record<string, string | undefined> = { ...base, ...overrides };
  if (src.GSC_SERVICE_ACCOUNT_JSON === '') src.GSC_SERVICE_ACCOUNT_JSON = sa;
  if (src.GA4_SERVICE_ACCOUNT_JSON === '') src.GA4_SERVICE_ACCOUNT_JSON = sa;
  return loadEnv(src);
}

export const emptyEnv = () => loadEnv({ NODE_ENV: 'test' });

export function allSecretStrings(): string[] {
  return [...Object.values(SECRETS), rsaKeys().privateKey, 'pkid-SECRET-0123456789', 'SECRETslackhookpath', 'access-token-SECRET'];
}

export function expectNoSecrets(s: string | undefined) {
  if (!s) return;
  for (const sec of allSecretStrings()) {
    if (s.includes(sec)) throw new Error(`secret leaked (${sec.slice(0, 12)}…) in: ${s}`);
  }
  if (/PRIVATE KEY/.test(s)) throw new Error(`private key leaked in: ${s}`);
}

export const silentLog = () => {
  const entries: { level: string; obj: object; msg?: string }[] = [];
  return {
    entries,
    info: (obj: object, msg?: string) => void entries.push({ level: 'info', obj, msg }),
    warn: (obj: object, msg?: string) => void entries.push({ level: 'warn', obj, msg }),
    error: (obj: object, msg?: string) => void entries.push({ level: 'error', obj, msg }),
  };
};
