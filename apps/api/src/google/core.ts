/**
 * Google connections for the whole server (stored once, with the primary website — like Claude AI):
 *  - the OAuth 2.0 client (Client ID + Client secret) entered on the Integrations screen; the secret is stored encrypted;
 *  - Google accounts connected with "Connect Google account" (OAuth, offline access): each refresh token is stored
 *    encrypted (AES-256-GCM, security/secretBox) and only ever used on the server;
 *  - the PageSpeed Insights API key (encrypted).
 * Short-lived access tokens are kept in memory only. Nothing secret is returned to the browser, logged or audited.
 *
 * The one-time Google Cloud step that cannot be avoided: create an OAuth client (type "Web application") and register
 * the redirect URI shown on the screen (<Sentinel URL>/api/google/oauth/callback), and enable the Analytics Admin,
 * Analytics Data, Search Console and PageSpeed Insights APIs in that project.
 */
import crypto from 'node:crypto';
import {
  GA4_OAUTH_SCOPE, GOOGLE_OAUTH_CALLBACK_PATH, GOOGLE_OAUTH_SCOPES, GSC_OAUTH_SCOPE, normalizeGscProperty,
  type Ga4PropertyOption, type GoogleAccount, type GoogleOAuthClientStatus, type GoogleProduct, type GscSiteOption, type PsiStatus,
} from '@sentinel/shared';
import type { Env } from '../config/env';
import { is2xx, redact, type FetchLike } from '../connectors/http';
import { ApiError, badRequest, notFound } from '../lib/errors';
import type { GoogleConnectionDoc, Repositories } from '../repositories/types';
import { SecretBoxError, type SecretBox } from '../security/secretBox';
import { registerBasePath } from '../http/basePath';
import { createGoogleHttp, createLimiter, GoogleError, googleFailure } from './http';
import { runPsi } from './psi';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GA4_ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
export const GA4_DATA = 'https://analyticsdata.googleapis.com/v1beta';
export const GSC_API = 'https://www.googleapis.com/webmasters/v3';
export const GSC_INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const CLIENT_ID_RE = /^[0-9]{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/i;
const SECRET_RE = /^[\x21-\x7e]{10,200}$/;
const PSI_KEY_RE = /^[A-Za-z0-9_-]{20,100}$/;
const STATE_TTL_MS = 10 * 60_000;

export interface Actorish { id: string; name: string }

interface PendingState { state: string; actorId: string; actorName: string; websiteId: string; accountId?: string; redirectUri: string; appBase: string; expiresAt: number }

export interface GoogleCoreDeps {
  repos: Pick<Repositories, 'googleConnections' | 'storage'>;
  box?: SecretBox;
  env: Env;
  fetchImpl: FetchLike;
  clock: () => Date;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
  audit: (actor: Actorish, action: string, entityId: string, summary: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** Validated public address of Sentinel (no trailing slash), or an error message. */
export function checkGoogleAppUrl(raw: string, production: boolean): { ok: true; value: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: 'Enter the full public address of Sentinel, e.g. https://apps.deodap.info/seo-tool.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The address must start with https://.' };
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (production && u.protocol !== 'https:' && !local) return { ok: false, error: 'Google only redirects to https addresses (or localhost): the address must start with https://.' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: 'The address has no user name, password, ? query or # part.' };
  const path = u.pathname.replace(/\/+$/, '');
  if (/\/api(\/|$)/.test(path)) return { ok: false, error: 'Enter the address of the app itself (e.g. https://apps.deodap.info/seo-tool), not the callback URL.' };
  return { ok: true, value: `${u.protocol}//${u.host}${path}` };
}

const productsOf = (scopes: string[]): GoogleProduct[] => [
  ...(scopes.includes(GA4_OAUTH_SCOPE) ? ['ga4' as const] : []),
  ...(scopes.includes(GSC_OAUTH_SCOPE) ? ['gsc' as const] : []),
];

export function createGoogleCore(d: GoogleCoreDeps) {
  const repo = d.repos.googleConnections;
  const http = createGoogleHttp({ fetchImpl: d.fetchImpl, sleep: d.sleep });
  /** Google API calls server-wide (reports make several at once). */
  const apiSlot = createLimiter(4);
  /** PageSpeed Insights runs server-wide (each takes 10–40 s at Google). */
  const psiSlot = createLimiter(2);
  const tokens = new Map<string, { token: string; exp: number }>();
  const pending = new Map<string, PendingState>();
  const iso = () => d.clock().toISOString();
  const now = () => d.clock().getTime();
  const production = d.env.NODE_ENV === 'production';

  const aad = (docId: string, field: string) => `google:${docId}:${field}`;
  function open(doc: GoogleConnectionDoc | undefined, field: string): string | undefined {
    const s = doc?.sealed[field];
    if (!s) return undefined;
    if (!d.box) return undefined;
    try { return d.box.open(s, aad(doc!.id, field)); } catch (e) {
      if (e instanceof SecretBoxError) d.log.warn({ doc: doc!.id, field }, 'a stored Google credential could not be decrypted');
      return undefined;
    }
  }
  function requireBox(): SecretBox {
    if (!d.box) throw new ApiError(409, 'NO_ENCRYPTION_KEY', 'Credentials cannot be stored: the API server has no SESSION_SECRET (or CREDENTIALS_ENCRYPTION_KEY, 32+ characters) to encrypt them with. Set one once on the server and restart it.');
    return d.box;
  }
  const secrets = async () => {
    const out: string[] = [];
    for (const doc of await repo.list()) for (const f of Object.keys(doc.sealed)) { const v = open(doc, f); if (v && v.length >= 4) out.push(v); }
    if (d.env.GOOGLE_OAUTH_CLIENT_SECRET) out.push(d.env.GOOGLE_OAUTH_CLIENT_SECRET);
    if (d.env.GOOGLE_API_KEY) out.push(d.env.GOOGLE_API_KEY);
    for (const t of tokens.values()) out.push(t.token);
    return out;
  };

  // ------------------------------------------------------------------------------------------- OAuth client
  async function client() {
    const doc = await repo.get('client');
    const savedId = doc?.plain.clientId;
    const savedSecret = open(doc, 'clientSecret');
    const fromEnv = !savedId && !!d.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientId = savedId ?? d.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = savedId ? savedSecret : d.env.GOOGLE_OAUTH_CLIENT_SECRET;
    // The callback must also work when Sentinel runs under a sub-path (e.g. /seo-tool).
    if (doc?.plain.appUrl) registerBasePath(doc.plain.appUrl);
    const problem = savedId && doc?.sealed.clientSecret && !savedSecret
      ? `The saved Client secret could not be decrypted — ${d.box ? `${d.box.keySource} changed since it was saved` : 'no encryption key is configured on the server'}. Enter it again.`
      : undefined;
    return { doc, clientId, clientSecret, source: (savedId ? 'saved' : fromEnv ? 'env' : 'none') as GoogleOAuthClientStatus['source'], savedAppUrl: doc?.plain.appUrl, problem };
  }
  /** App URL: saved with the client → APP_BASE_URL → the address the browser is using. */
  function appUrlOf(c: Awaited<ReturnType<typeof client>>, origin?: string): { url?: string; source: GoogleOAuthClientStatus['appUrlSource'] } {
    if (c.savedAppUrl) return { url: c.savedAppUrl, source: 'saved' };
    if (d.env.APP_BASE_URL) return { url: d.env.APP_BASE_URL.replace(/\/$/, ''), source: 'env' };
    if (origin) { const chk = checkGoogleAppUrl(origin, production); if (chk.ok) { registerBasePath(chk.value); return { url: chk.value, source: 'request' }; } }
    return { source: 'none' };
  }

  async function clientStatus(origin?: string): Promise<GoogleOAuthClientStatus> {
    const c = await client();
    const app = appUrlOf(c, origin);
    const redirectUri = app.url ? `${app.url}${GOOGLE_OAUTH_CALLBACK_PATH}` : undefined;
    const missing = [!c.clientId && 'the Client ID', !c.clientSecret && 'the Client secret', !app.url && 'Sentinel’s public address'].filter(Boolean) as string[];
    const problem = c.problem ?? (missing.length ? `Enter ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]} of the Google OAuth client.` : undefined);
    return {
      configured: !problem, clientId: c.clientId, secretSet: !!c.clientSecret, source: c.source, appUrl: app.url, appUrlSource: app.source, redirectUri,
      ...(problem ? { problem } : {}), updatedAt: c.doc?.updatedAt, updatedBy: c.doc?.updatedBy,
    };
  }

  async function saveClient(actor: Actorish, input: { clientId?: unknown; clientSecret?: unknown; appUrl?: unknown }) {
    const box = requireBox();
    const prev = await repo.get('client');
    const clientId = String(input.clientId ?? '').trim();
    const secret = String(input.clientSecret ?? '').trim();
    const appUrlRaw = String(input.appUrl ?? '').trim();
    const fields: Record<string, string> = {};
    if (!CLIENT_ID_RE.test(clientId)) fields.clientId = 'A Google OAuth Client ID looks like 123456789012-abc123….apps.googleusercontent.com (Google Cloud → APIs & Services → Credentials).';
    if (secret && !SECRET_RE.test(secret)) fields.clientSecret = 'That does not look like a Client secret (no spaces, 10+ characters).';
    if (!secret && !(prev?.sealed.clientSecret && prev.plain.clientId === clientId)) fields.clientSecret = 'Enter the Client secret.';
    let appUrl: string | undefined;
    if (appUrlRaw) { const chk = checkGoogleAppUrl(appUrlRaw, production); if (chk.ok) appUrl = chk.value; else fields.appUrl = chk.error; }
    if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], { fields });
    const sealed = secret ? { clientSecret: box.seal(secret, aad('client', 'clientSecret')) } : prev!.sealed;
    await repo.upsert({ id: 'client', kind: 'oauth_client', plain: { clientId, ...(appUrl ? { appUrl } : {}) }, sealed, meta: {}, updatedAt: iso(), updatedBy: actor.name });
    await d.audit(actor, 'google.oauth_client', clientId.slice(0, 12), `Saved the Google OAuth client (Client ID ${clientId.slice(0, 12)}…, Client secret ${secret ? 'replaced' : 'kept'}, stored encrypted)${appUrl ? `; app address ${appUrl}` : ''}`);
    return clientStatus();
  }

  async function removeClient(actor: Actorish) {
    await repo.delete('client');
    await d.audit(actor, 'google.oauth_client_removed', 'client', 'Removed the Google OAuth client credentials (connected accounts stop refreshing until a client is saved again)');
    tokens.clear();
    return clientStatus();
  }

  // ------------------------------------------------------------------------------------------- OAuth flow
  function sweep() { const t = now(); for (const [k, v] of pending) if (v.expiresAt <= t) pending.delete(k); }

  async function startOAuth(actor: Actorish, o: { websiteId: string; origin?: string; accountId?: string }): Promise<{ authorizeUrl: string; redirectUri: string }> {
    requireBox();
    const c = await client();
    const st = await clientStatus(o.origin);
    if (!st.configured || !c.clientId || !c.clientSecret) throw new ApiError(409, 'GOOGLE_OAUTH_NOT_CONFIGURED', st.problem ?? 'The Google OAuth client is not set up.');
    let loginHint: string | undefined;
    if (o.accountId) {
      const acct = await repo.get(o.accountId);
      if (!acct || acct.kind !== 'account') throw notFound('Google account');
      loginHint = acct.plain.email;
    }
    sweep();
    if (pending.size > 200) pending.delete(pending.keys().next().value as string);
    const state = crypto.randomBytes(24).toString('hex');
    pending.set(state, { state, actorId: actor.id, actorName: actor.name, websiteId: o.websiteId, accountId: o.accountId, redirectUri: st.redirectUri!, appBase: st.appUrl!, expiresAt: now() + STATE_TTL_MS });
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', c.clientId);
    u.searchParams.set('redirect_uri', st.redirectUri!);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    // Always ask for consent so Google returns a refresh token (also on Reconnect).
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', state);
    if (loginHint) u.searchParams.set('login_hint', loginHint);
    await d.audit(actor, 'google.oauth_start', o.accountId ?? 'new', `Started ${o.accountId ? `reconnecting Google account ${loginHint}` : 'connecting a Google account'}`);
    return { authorizeUrl: u.toString(), redirectUri: st.redirectUri! };
  }

  /** Handles Google's redirect. Returns where to send the browser (never throws). */
  async function completeOAuth(q: Record<string, unknown>, fallbackBase: string): Promise<string> {
    sweep();
    const stateParam = typeof q.state === 'string' ? q.state : undefined;
    const st = stateParam ? pending.get(stateParam) : undefined;
    if (stateParam) pending.delete(stateParam); // single use
    const base = (st?.appBase ?? fallbackBase).replace(/\/$/, '');
    const back = (x: string) => `${base}/settings/integrations?${x}`;
    const fail = (reason: string) => back(`google=error&reason=${encodeURIComponent(reason)}`);
    if (!st || st.expiresAt <= now()) return fail('bad_state');
    if (typeof q.error === 'string') return fail(q.error === 'access_denied' ? 'denied' : 'google_error');
    if (typeof q.code !== 'string' || !q.code) return fail('no_code');
    const c = await client();
    if (!c.clientId || !c.clientSecret) return fail('not_configured');
    const actor = { id: st.actorId, name: st.actorName };
    try {
      const tr = await http.call(GOOGLE_TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: st.redirectUri }).toString(),
      }, { retries: 1 });
      if (!is2xx(tr)) {
        const err = tr.kind === 'response' ? String((tr.json as { error?: string })?.error ?? '') : '';
        d.log.warn({ status: tr.kind === 'response' ? tr.status : 'network', err }, 'Google OAuth code exchange failed');
        return fail(err === 'redirect_uri_mismatch' ? 'redirect_uri_mismatch' : err === 'invalid_client' ? 'invalid_client' : 'exchange_failed');
      }
      const t = tr.json as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
      if (!t.access_token) return fail('exchange_failed');
      const scopes = String(t.scope ?? '').split(/\s+/).filter(Boolean);
      const products = productsOf(scopes);
      if (!products.length) return fail('missing_scopes');
      const ui = await http.call(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${t.access_token}` } }, { retries: 1 });
      if (!is2xx(ui)) return fail('userinfo_failed');
      const u = ui.json as { sub?: string; email?: string; name?: string; picture?: string };
      if (!u.sub || !u.email) return fail('userinfo_failed');
      const id = `acct:${u.sub}`;
      if (st.accountId && st.accountId !== id) return fail('different_account');
      const prev = await repo.get(id);
      const refresh = t.refresh_token ?? open(prev, 'refreshToken');
      if (!refresh) return fail('no_refresh_token');
      const box = requireBox();
      await repo.upsert({
        id, kind: 'account',
        plain: { email: u.email, name: u.name ?? '', picture: u.picture ?? '', scopes: scopes.join(' ') },
        sealed: { refreshToken: box.seal(refresh, aad(id, 'refreshToken')) },
        meta: { ...(prev?.meta ?? {}), connectedAt: prev?.meta.connectedAt ?? iso(), connectedBy: prev?.meta.connectedBy ?? actor.name, reconnectedAt: prev ? iso() : undefined, state: 'connected', stateDetail: undefined },
        updatedAt: iso(), updatedBy: actor.name,
      });
      tokens.set(id, { token: t.access_token, exp: now() + Math.max(0, (t.expires_in ?? 3600) - 60) * 1000 });
      await d.audit(actor, prev ? 'google.account_reconnect' : 'google.account_connect', u.email, `${prev ? 'Reconnected' : 'Connected'} Google account ${u.email} (${products.map((p) => (p === 'ga4' ? 'Analytics' : 'Search Console')).join(' + ')}, read-only)`);
      d.log.info({ account: u.email, products, reconnect: !!prev }, 'Google account connected');
      return back(`google=connected&account=${encodeURIComponent(u.email)}&site=${encodeURIComponent(st.websiteId)}`);
    } catch (e) {
      d.log.warn({ err: redact((e as Error).message, await secrets()) }, 'Google OAuth callback failed');
      return fail('exchange_failed');
    }
  }

  // ------------------------------------------------------------------------------------------- accounts
  async function accountDoc(id: string): Promise<GoogleConnectionDoc> {
    const doc = await repo.get(id);
    if (!doc || doc.kind !== 'account') throw new GoogleError('not_connected', 'That Google account is no longer connected. Connect it again or choose another account.');
    return doc;
  }
  async function setAccountMeta(id: string, patch: Record<string, unknown>) {
    const doc = await repo.get(id);
    if (doc) await repo.upsert({ ...doc, meta: { ...doc.meta, ...patch } });
  }

  async function accessToken(id: string, force = false): Promise<string> {
    const hit = tokens.get(id);
    if (!force && hit && hit.exp > now()) return hit.token;
    const doc = await accountDoc(id);
    const c = await client();
    if (!c.clientId || !c.clientSecret) throw new GoogleError('not_configured', 'The Google OAuth client (Client ID and secret) is not set up on the Integrations screen, so connected accounts cannot be used.');
    const refresh = open(doc, 'refreshToken');
    if (!refresh) {
      await setAccountMeta(id, { state: 'expired', stateDetail: 'The stored access could not be decrypted (the server’s encryption key changed). Reconnect the account.' });
      throw new GoogleError('expired', `Google account ${doc.plain.email}: the stored access could not be decrypted. Reconnect the account.`);
    }
    const r = await http.call(GOOGLE_TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.clientId, client_secret: c.clientSecret }).toString(),
    }, { retries: 2 });
    if (!is2xx(r)) {
      const err = r.kind === 'response' ? String((r.json as { error?: string })?.error ?? '') : '';
      if (err === 'invalid_grant' || (r.kind === 'response' && r.status === 401 && err !== 'invalid_client')) {
        const detail = 'Google revoked or expired this account’s access (the password changed, access was removed, or the OAuth app is in Testing mode, where access expires after 7 days). Reconnect the account.';
        await setAccountMeta(id, { state: 'expired', stateDetail: detail });
        tokens.delete(id);
        throw new GoogleError('expired', `Google account ${doc.plain.email}: ${detail}`);
      }
      if (err === 'invalid_client') throw new GoogleError('not_configured', 'Google rejected the OAuth Client ID / secret. Check them on the Integrations screen.');
      throw googleFailure(`Google account ${doc.plain.email}`, GOOGLE_TOKEN_URL, r, [refresh, c.clientSecret]);
    }
    const t = r.json as { access_token?: string; expires_in?: number };
    if (!t.access_token) throw new GoogleError('server', 'Google’s token endpoint returned no access token.');
    tokens.set(id, { token: t.access_token, exp: now() + Math.max(0, (t.expires_in ?? 3600) - 60) * 1000 });
    if (doc.meta.state !== 'connected') await setAccountMeta(id, { state: 'connected', stateDetail: undefined });
    return t.access_token;
  }

  /** Authorized JSON request for an account: one forced token refresh on 401, rate-limit retries, GoogleError on failure. */
  async function api<T>(accountId: string, label: string, url: string, init: RequestInit = {}, o: { timeoutMs?: number } = {}): Promise<T> {
    return apiSlot(async () => {
      let token = await accessToken(accountId);
      const go = (tk: string) => http.call(url, { ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${tk}` } }, { timeoutMs: o.timeoutMs });
      let r = await go(token);
      if (r.kind === 'response' && r.status === 401) { token = await accessToken(accountId, true); r = await go(token); }
      if (!is2xx(r)) {
        const e = googleFailure(label, url, r, await secrets());
        if (e.code === 'expired') await setAccountMeta(accountId, { state: 'expired', stateDetail: e.message });
        throw e;
      }
      return r.json as T;
    });
  }

  async function listAccounts(): Promise<Omit<GoogleAccount, 'usedBy'>[]> {
    return (await repo.list()).filter((x) => x.kind === 'account').map((x) => {
      const scopes = x.plain.scopes ? x.plain.scopes.split(' ') : [];
      const m = x.meta as Record<string, string | boolean | undefined>;
      return {
        id: x.id, email: x.plain.email, name: x.plain.name || undefined, picture: x.plain.picture || undefined, scopes, products: productsOf(scopes),
        state: (m.state as GoogleAccount['state']) ?? 'connected', stateDetail: m.stateDetail as string | undefined,
        connectedAt: String(m.connectedAt ?? x.updatedAt), connectedBy: m.connectedBy as string | undefined,
        lastTestAt: m.lastTestAt as string | undefined, lastTestOk: m.lastTestOk as boolean | undefined, lastTestResult: m.lastTestResult as string | undefined,
      };
    }).sort((a, b) => a.email.localeCompare(b.email));
  }

  async function listGa4Properties(accountId: string): Promise<Ga4PropertyOption[]> {
    const out: Ga4PropertyOption[] = [];
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const j = await api<{ accountSummaries?: { account?: string; displayName?: string; propertySummaries?: { property?: string; displayName?: string; propertyType?: string }[] }[]; nextPageToken?: string }>(
        accountId, 'Google Analytics', `${GA4_ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      );
      for (const a of j.accountSummaries ?? []) {
        for (const p of a.propertySummaries ?? []) {
          const pid = String(p.property ?? '').replace(/^properties\//, '');
          if (/^\d+$/.test(pid)) out.push({ propertyId: pid, displayName: p.displayName ?? pid, accountName: a.displayName ?? '', accountId: String(a.account ?? '').replace(/^accounts\//, ''), propertyType: p.propertyType });
        }
      }
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return out;
  }

  async function listGscSites(accountId: string): Promise<GscSiteOption[]> {
    const j = await api<{ siteEntry?: { siteUrl?: string; permissionLevel?: string }[] }>(accountId, 'Google Search Console', `${GSC_API}/sites`);
    return (j.siteEntry ?? []).filter((e) => typeof e.siteUrl === 'string').map((e) => ({
      siteUrl: e.siteUrl!, permissionLevel: e.permissionLevel ?? 'unknown', usable: e.permissionLevel !== 'siteUnverifiedUser',
    })).sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
  }

  async function testAccount(actor: Actorish, id: string) {
    const doc = await accountDoc(id);
    const scopes = doc.plain.scopes ? doc.plain.scopes.split(' ') : [];
    const products = productsOf(scopes);
    const parts: string[] = [];
    let ok = true;
    let rateLimited = false;
    let expired = false;
    try {
      if (products.includes('ga4')) { const n = (await listGa4Properties(id)).length; parts.push(`Analytics: ${n} propert${n === 1 ? 'y' : 'ies'} visible`); }
      if (products.includes('gsc')) { const n = (await listGscSites(id)).length; parts.push(`Search Console: ${n} propert${n === 1 ? 'y' : 'ies'} visible`); }
    } catch (e) {
      ok = false;
      const ge = e instanceof GoogleError ? e : new GoogleError('network', (e as Error).message);
      rateLimited = ge.code === 'rate_limited';
      expired = ge.code === 'expired';
      parts.push(ge.message);
    }
    const message = ok ? `${doc.plain.email}: access works — ${parts.join('; ')}.` : parts.join(' ');
    await setAccountMeta(id, { lastTestAt: iso(), lastTestOk: ok, lastTestResult: message });
    await d.audit(actor, 'google.account_test', doc.plain.email, `Tested Google account ${doc.plain.email}: ${ok ? 'OK' : 'failed'}`);
    return { ok, message, ...(rateLimited ? { rateLimited } : {}), ...(expired ? { expired } : {}) };
  }

  async function disconnectAccount(actor: Actorish, id: string) {
    const doc = await accountDoc(id);
    const refresh = open(doc, 'refreshToken');
    let revoked = false;
    if (refresh) {
      const r = await http.call(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refresh }).toString() }, { retries: 1 });
      revoked = is2xx(r);
    }
    await repo.delete(id);
    tokens.delete(id);
    await d.audit(actor, 'google.account_disconnect', doc.plain.email, `Disconnected Google account ${doc.plain.email} (stored access removed${revoked ? ', revoked at Google' : '; revoke it in the Google account’s security settings if needed'})`);
    return { revoked, email: doc.plain.email };
  }

  // ------------------------------------------------------------------------------------------- PageSpeed Insights key
  async function psiKey(): Promise<string | undefined> {
    return open(await repo.get('psi'), 'apiKey') ?? (d.env.GOOGLE_API_KEY || undefined);
  }
  async function psiStatus(): Promise<PsiStatus> {
    const doc = await repo.get('psi');
    const saved = open(doc, 'apiKey');
    const m = (doc?.meta ?? {}) as Record<string, string | boolean | undefined>;
    const problem = doc?.sealed.apiKey && !saved ? `The saved API key could not be decrypted — ${d.box ? `${d.box.keySource} changed since it was saved` : 'no encryption key is configured on the server'}. Enter it again.` : undefined;
    const source: PsiStatus['keySource'] = saved ? 'saved' : d.env.GOOGLE_API_KEY ? 'env' : 'none';
    return {
      connected: source !== 'none' && m.lastTestOk !== false, keySource: source,
      connectedAt: m.connectedAt as string | undefined, connectedBy: m.connectedBy as string | undefined,
      lastTestAt: m.lastTestAt as string | undefined, lastTestOk: m.lastTestOk as boolean | undefined, lastTestResult: m.lastTestResult as string | undefined,
      ...(problem ? { problem } : {}),
    };
  }
  async function recordPsiTest(ok: boolean, message: string) {
    const doc = await repo.get('psi');
    const meta = { lastTestAt: iso(), lastTestOk: ok, lastTestResult: message };
    if (doc) await repo.upsert({ ...doc, meta: { ...doc.meta, ...meta } });
    else if (d.env.GOOGLE_API_KEY) await repo.upsert({ id: 'psi', kind: 'psi', plain: {}, sealed: {}, meta, updatedAt: iso() });
  }
  /** One PSI run with a key (or the stored key). */
  function psi(key: string, url: string, strategy: 'mobile' | 'desktop') {
    return psiSlot(() => runPsi(http, key, url, strategy));
  }
  async function savePsiKey(actor: Actorish, raw: unknown, testUrl: string) {
    const box = requireBox();
    const key = String(raw ?? '').trim();
    if (!PSI_KEY_RE.test(key)) throw badRequest('That does not look like a Google API key (Google Cloud → APIs & Services → Credentials → API key; it usually starts with AIza).');
    let run;
    try {
      run = await psi(key, testUrl, 'mobile');
    } catch (e) {
      const ge = e instanceof GoogleError ? e : new GoogleError('network', (e as Error).message);
      // A page that Lighthouse cannot load still proves the key works only when Google answered — otherwise refuse.
      throw new ApiError(ge.code === 'rate_limited' ? 429 : 400, 'PSI_TEST_FAILED', `The key was not saved: ${redact(ge.message, [key])}`);
    }
    const message = `Key works: PageSpeed Insights tested ${testUrl} (mobile)${typeof run.performanceScore === 'number' ? ` — performance score ${run.performanceScore}` : ''}.`;
    await repo.upsert({ id: 'psi', kind: 'psi', plain: {}, sealed: { apiKey: box.seal(key, aad('psi', 'apiKey')) }, meta: { connectedAt: iso(), connectedBy: actor.name, lastTestAt: iso(), lastTestOk: true, lastTestResult: message }, updatedAt: iso(), updatedBy: actor.name });
    await d.audit(actor, 'google.psi_key', 'psi', 'Saved the PageSpeed Insights API key (tested, stored encrypted)');
    return { status: await psiStatus(), run, testUrl };
  }
  async function removePsiKey(actor: Actorish) {
    await repo.delete('psi');
    await d.audit(actor, 'google.psi_key_removed', 'psi', 'Removed the PageSpeed Insights API key');
    return psiStatus();
  }

  /** Every website with its Google settings (set by the workspaces; used for "used by" on accounts). */
  const siteRegistry: { list?: () => { id: string; name: string; settings: () => Promise<Partial<Record<GoogleProduct, Record<string, string | number | boolean>>>> }[] } = {};

  return {
    siteRegistry,
    canStore: () => !!d.box,
    persistent: () => d.repos.storage.persistent !== false,
    clientStatus, saveClient, removeClient, startOAuth, completeOAuth,
    listAccounts, accountDoc, accessToken, api, listGa4Properties, listGscSites, testAccount, disconnectAccount,
    psiKey, psiStatus, recordPsiTest, psi, savePsiKey, removePsiKey,
    secrets,
    /** Normalised GSC property, or an error message. */
    normalizeGsc: (v: string) => normalizeGscProperty(v),
    /** Test helper: pending OAuth states. */
    __pending: pending,
  };
}
export type GoogleCore = ReturnType<typeof createGoogleCore>;
