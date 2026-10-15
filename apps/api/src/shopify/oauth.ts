/**
 * Shopify OAuth (authorization code grant) for a standalone app: shop validation, single-use state, HMAC verification of
 * the callback, the code → access token exchange and the granted-scope check.
 *
 * Follows https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps:
 *  - the callback's `hmac` is a hex HMAC-SHA256 (app secret) of the other query parameters, sorted, as k=v joined by &;
 *  - the shop must be a *.myshopify.com host;
 *  - `state` must be the nonce this server issued (here: single-use, bound to the user and website, 10-minute expiry).
 */
import crypto from 'node:crypto';
import type { FetchLike } from '../connectors/http';

export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const STATE_TTL_MS = 10 * 60_000;
/** The callback timestamp may be at most this old (replay protection on top of the single-use state). */
export const CALLBACK_MAX_AGE_S = 15 * 60;

/** “deodap”, “deodap.myshopify.com” or “https://deodap.myshopify.com/admin” → “deodap.myshopify.com”; undefined when invalid. */
export function normalizeShop(input: string | undefined): string | undefined {
  if (!input) return undefined;
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return SHOP_RE.test(s) ? s : undefined;
}

type QueryValue = string | string[] | undefined;

/** The message Shopify signs: every parameter except hmac (and the legacy signature), sorted by key, k=v joined by &. */
export function hmacMessage(query: Record<string, QueryValue>): string {
  return Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature' && query[k] !== undefined)
    .sort()
    .map((k) => {
      const v = query[k]!;
      const val = Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : v;
      return `${k}=${val}`;
    })
    .join('&');
}

export function signQuery(query: Record<string, QueryValue>, secret: string): string {
  return crypto.createHmac('sha256', secret).update(hmacMessage(query)).digest('hex');
}

/** Constant-time check of the callback's hmac. */
export function verifyQueryHmac(query: Record<string, QueryValue>, secret: string): boolean {
  const given = query.hmac;
  if (typeof given !== 'string' || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const want = Buffer.from(signQuery(query, secret), 'utf8');
  const got = Buffer.from(given.toLowerCase(), 'utf8');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function authorizeUrl(o: { shop: string; apiKey: string; scopes: string[]; redirectUri: string; state: string }): string {
  const u = new URL(`https://${o.shop}/admin/oauth/authorize`);
  u.searchParams.set('client_id', o.apiKey);
  u.searchParams.set('scope', o.scopes.join(','));
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('state', o.state);
  // No grant_options[]=per-user: an offline token, so it keeps working when the merchant's session ends.
  return u.toString();
}

/** Requested scopes not covered by the grant. A write_* grant includes its read_* scope. */
export function missingScopes(requested: readonly string[], granted: readonly string[]): string[] {
  const g = new Set(granted.map((s) => s.trim()).filter(Boolean));
  return requested.filter((s) => !g.has(s) && !(s.startsWith('read_') && g.has(`write_${s.slice(5)}`)));
}

export interface PendingState {
  state: string;
  shop: string;
  actorId: string;
  actorName: string;
  /** Opaque owner key (the website workspace that started the flow). */
  owner: string;
  expiresAt: number;
}

/** Single-use OAuth states held in memory (lost on restart — the user simply starts the connection again). */
export function createStateStore(now: () => number = Date.now) {
  const pending = new Map<string, PendingState>();
  const sweep = () => { const t = now(); for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k); };
  return {
    issue(p: Omit<PendingState, 'state' | 'expiresAt'>): PendingState {
      sweep();
      if (pending.size > 200) pending.delete(pending.keys().next().value as string);
      const st: PendingState = { ...p, state: crypto.randomBytes(24).toString('hex'), expiresAt: now() + STATE_TTL_MS };
      pending.set(st.state, st);
      return st;
    },
    /** Returns and removes the state (single use); undefined when unknown or expired. */
    consume(state: string | undefined): PendingState | undefined {
      sweep();
      if (!state) return undefined;
      const st = pending.get(state);
      pending.delete(state);
      return st && st.expiresAt > now() ? st : undefined;
    },
    size: () => pending.size,
  };
}

export interface TokenGrant {
  accessToken: string;
  scopes: string[];
  expiresAt?: number;
  refreshToken?: string;
}

export class OAuthError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/** Exchanges the authorization code for an offline access token. Never includes the secret or token in errors. */
export async function exchangeCode(fetchImpl: FetchLike, o: { shop: string; apiKey: string; apiSecret: string; code: string; timeoutMs?: number }): Promise<TokenGrant> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), o.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetchImpl(`https://${o.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: o.apiKey, client_secret: o.apiSecret, code: o.code }).toString(),
      signal: ac.signal,
    });
  } catch (e) {
    throw new OAuthError(`Could not reach ${o.shop} to exchange the authorization code (${(e as Error).name === 'AbortError' ? 'timeout' : 'network error'}).`, 'EXCHANGE_NETWORK');
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new OAuthError(`Shopify refused the authorization code (HTTP ${res.status}). Start the connection again.`, 'EXCHANGE_REFUSED');
  let body: { access_token?: unknown; scope?: unknown; expires_in?: unknown; refresh_token?: unknown };
  try { body = (await res.json()) as typeof body; } catch { throw new OAuthError('Shopify answered the token exchange with something that is not JSON.', 'EXCHANGE_BAD_RESPONSE'); }
  if (typeof body.access_token !== 'string' || !body.access_token) throw new OAuthError('Shopify did not return an access token.', 'EXCHANGE_BAD_RESPONSE');
  return {
    accessToken: body.access_token,
    scopes: typeof body.scope === 'string' ? body.scope.split(',').map((s) => s.trim()).filter(Boolean) : [],
    expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}
