/**
 * Google OAuth helpers (no SDK):
 *  - service-account JWT bearer flow (RS256 signed with node:crypto) — GSC, GA4
 *  - OAuth refresh-token exchange — Google Business Profile (GBP requires a *user* with Manager access on the
 *    profile; service accounts cannot be added as GBP managers, so GBP uses an OAuth client + refresh token).
 * Access tokens are cached in-process until shortly before expiry.
 */
import { createHash, createSign } from 'node:crypto';
import type { ConnectorTestResult } from '../services/ports';
import { defaultFetch, failureResult, httpRequest, is2xx, parseJsonMaybeBase64, providerMessage, type FetchLike, type HttpResult } from './http';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(raw: string | undefined): ServiceAccount | { error: string } {
  const j = parseJsonMaybeBase64(raw);
  if (!j) return { error: 'service-account JSON could not be parsed (expected the JSON key file contents, raw or base64)' };
  if (typeof j.client_email !== 'string' || !j.client_email) return { error: 'service-account JSON has no client_email' };
  if (typeof j.private_key !== 'string' || !j.private_key.includes('PRIVATE KEY')) return { error: 'service-account JSON has no private_key' };
  return { client_email: j.client_email, private_key: j.private_key };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Builds the signed RS256 assertion for the JWT-bearer grant. */
export function signServiceAccountJwt(sa: ServiceAccount, scope: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(sa.private_key).toString('base64url')}`;
}

export type TokenResult = { ok: true; accessToken: string } | { ok: false; http?: HttpResult; error: string };

export interface GoogleAuth {
  serviceAccountToken(sa: ServiceAccount, scope: string): Promise<TokenResult>;
  refreshTokenAccess(clientId: string, clientSecret: string, refreshToken: string): Promise<TokenResult>;
  clearCache(): void;
}

export function createGoogleAuth(deps: { fetchImpl?: FetchLike; clock?: () => Date } = {}): GoogleAuth {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const clock = deps.clock ?? (() => new Date());
  const cache = new Map<string, { token: string; expiresAtMs: number }>();

  async function exchange(cacheKey: string, body: URLSearchParams): Promise<TokenResult> {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAtMs > clock().getTime()) return { ok: true, accessToken: hit.token };
    const r = await httpRequest(fetchImpl, GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!is2xx(r)) return { ok: false, http: r, error: providerMessage(r) };
    const j = r.json as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (!j || typeof j.access_token !== 'string') return { ok: false, http: r, error: 'token endpoint returned no access_token' };
    const ttl = typeof j.expires_in === 'number' ? j.expires_in : 3600;
    cache.set(cacheKey, { token: j.access_token, expiresAtMs: clock().getTime() + Math.max(0, ttl - 60) * 1000 });
    return { ok: true, accessToken: j.access_token };
  }

  return {
    async serviceAccountToken(sa, scope) {
      let assertion: string;
      try {
        assertion = signServiceAccountJwt(sa, scope, Math.floor(clock().getTime() / 1000));
      } catch {
        return { ok: false, error: 'could not sign JWT with the service-account private_key (malformed key)' };
      }
      return exchange(`sa|${sa.client_email}|${scope}`, new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }));
    },
    async refreshTokenAccess(clientId, clientSecret, refreshToken) {
      const key = `rt|${clientId}|${createHash('sha256').update(refreshToken).digest('hex').slice(0, 16)}`;
      return exchange(key, new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }));
    },
    clearCache: () => cache.clear(),
  };
}

/** Maps a failed token exchange to an honest connector result. */
export function tokenFailure(label: string, t: Extract<TokenResult, { ok: false }>): ConnectorTestResult {
  if (!t.http) return { ok: false, result: `${label}: ${t.error}` };
  if (t.http.kind === 'response' && (t.http.status === 400 || t.http.status === 401)) {
    return { ok: false, result: `${label}: credentials rejected by Google token endpoint (HTTP ${t.http.status})${t.error ? ` — ${t.error}` : ''}` };
  }
  return failureResult(`${label} (token exchange)`, GOOGLE_TOKEN_URL, t.http);
}
