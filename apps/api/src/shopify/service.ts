/**
 * Shopify connection + SEO editor + theme proposals.
 *
 * App credentials: the Shopify app's Client ID / Client secret and Sentinel's public URL can be entered under Settings →
 * Shopify (per website). The Client secret is stored encrypted (AES-256-GCM, security/secretBox) in the database and
 * never returned to the browser; SHOPIFY_API_KEY / SHOPIFY_API_SECRET / APP_BASE_URL remain the fallback.
 *
 * Token handling: the Admin API access token from OAuth is kept in this closure's memory and, when encryption is
 * available, stored encrypted in the database so it survives restarts. SHOPIFY_ADMIN_TOKEN (primary website) is read
 * from the environment. A token is never returned by any method, logged, or passed to child processes.
 *
 * Writes: nothing is written to Shopify until a user with `shopify.edit` (content) or `shopify.theme` (theme files)
 * previews the exact changes and types the confirmation phrase. Every write is read back to verify it, then the
 * storefront page is fetched again (re-audit). Theme writes never publish a theme; the live theme is written only after
 * its original file was downloaded and its own confirmation phrase (WRITE TO LIVE THEME …) was typed.
 */
import type {
  CrawledUrl, H1SourceReport, SeoBulkItemsPage, SeoBulkJob, SeoBulkStartInput, SeoOptimizationField, SeoOptimizationPage, SeoOptimizationQuery,
  ShopifyApplyBatchResult, ShopifyApplyPreview, ShopifyApplyResult, ShopifyDraft, ShopifyFieldDraft, ShopifyFieldResult, ShopifyReaudit,
  ShopifyResolveResult, ShopifyResourceKind, ShopifyResourceList, ShopifyStatus, ShopifyTheme, ShopifyThemeFile, ShopifyThemeProposal,
  ThemeDiffResponse, ThemeSnapshotMeta,
} from '@sentinel/shared';
import { assessSeoField, seoGuidelinesFrom, SHOPIFY_OPTIONAL_SCOPES, SHOPIFY_REQUIRED_SCOPES } from '@sentinel/shared';
import type { Request } from 'express';
import { defaultFetch, type FetchLike } from '../connectors/http';
import { shopifyDomain } from '../connectors/connectors';
import type { Collector } from '../crawler/engine';
import { parseHtml } from '../crawler/parse';
import { hostOf } from '../crawler/url';
import { badRequest, conflict, ApiError, notFound } from '../lib/errors';
import { randomToken } from '../lib/passwords';
import { SecretBoxError, type SecretBox } from '../security/secretBox';
import { firstBasePath, registerBasePath } from '../http/basePath';
import { audit, can, need, type Actor, type Ctx } from '../services/context';
import { createBulkFixer, type SeoOpsDeps } from './bulk';
import { createAdminClient, ShopifyApiError, type AdminClient } from './client';
import { bodyHeadings, buildFields, detectH1Sources, sourceTexts, suggestText, themeNotes, validateField, type Limits } from './drafts';
import { authorizeUrl, createStateStore, exchangeCode, missingScopes, normalizeShop, OAuthError, verifyQueryHmac, CALLBACK_MAX_AGE_S } from './oauth';
import { adminUrl, fetchByHandle, fetchById, fieldValue, isGid, listResources, mutationFor, parseStorefrontPath, sameValue, summarize, writeOps, type ShopifyResource } from './resources';
import { EDITABLE_FILE, getTheme, lineDiff, listThemeFiles, listThemes, md5, MAX_THEME_FILE_BYTES, readThemeFile, readThemeFiles, SNAPSHOT_FILE, writeThemeFile } from './theme';
import { createThemeSnapshotStore } from './themeSnapshots';

export interface ShopifyDeps {
  fetchImpl?: FetchLike;
  collector: Collector;
  /** Newest crawl row of a URL (H1s, issues, flags). */
  latestRow: (url: string) => Promise<{ row: CrawledUrl & { flags?: string[] }; at?: string } | undefined>;
  /** SHOPIFY_ADMIN_TOKEN only applies to the primary website. */
  useEnvToken: boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Folder for read-only theme source snapshots (Change Monitor storage). */
  themeSnapshotDir?: () => Promise<string>;
  /** Website id: binds encrypted credentials to this website. */
  scope?: string;
  /** Encryption for credentials entered in the app; undefined = they cannot be stored (no key material). */
  secretBox?: SecretBox;
  /** Bulk SEO fixes: the crawl's rows (streamed), page re-checks after a fix, and issue confirmation after a passed re-check. */
  seo?: SeoOpsDeps;
}

/** Credentials entered in the app (decrypted, in memory only). */
interface SavedApp { clientId?: string; clientSecret?: string; appUrl?: string; updatedAt?: string; updatedBy?: string; problem?: string }

interface Connection {
  shop: string;
  token: string;
  via: 'oauth' | 'env_token';
  scopes?: string[];
  shopName?: string;
  connectedAt: string;
  connectedBy?: string;
  expiresAt?: number;
  scopeProblem?: string;
}

interface ThemeProposalInternal extends ShopifyThemeProposal { original: string; proposed: string; expectH1?: string }

/** OAuth states are shared by all website workspaces: the public callback has no website header, so the state says which one started it. */
const states = createStateStore();
const owners = new Map<string, ReturnType<typeof createShopifyService>>();

const PREVIEW_TTL_MS = 15 * 60_000;

const TOKEN_NOTE = 'The access token is kept only in this server’s memory: it is never sent to the browser, saved to disk, written to logs or included in exports. After a restart or redeploy, connect again — or set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN in the server environment (primary website only).';
const TOKEN_NOTE_SEALED = 'The access token is stored encrypted (AES-256-GCM) in the database and kept in this server’s memory while in use: it is never sent to the browser, written to logs or included in exports, and it survives restarts. Disconnect removes it.';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CLIENT_SECRET_RE = /^[\x21-\x7e]{16,256}$/;

/** Validated public URL of Sentinel (no trailing slash), or an error message. */
export function checkAppUrl(raw: string, production: boolean): { ok: true; value: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: 'Enter the full public address of Sentinel, e.g. https://apps.deodap.info/seo-tool.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'The app URL must start with https://.' };
  if (production && u.protocol !== 'https:') return { ok: false, error: 'Shopify only redirects to https addresses: the app URL must start with https://.' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: 'The app URL has no user name, password, ? query or # part.' };
  const path = u.pathname.replace(/\/+$/, '');
  if (/\/api(\/|$)/.test(path)) return { ok: false, error: 'Enter the address of the app itself (e.g. https://apps.deodap.info/seo-tool), not the callback URL.' };
  return { ok: true, value: `${u.protocol}//${u.host}${path}` };
}

export function createShopifyService(ctx: Ctx, deps: ShopifyDeps) {
  const env = ctx.env;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const iso = () => ctx.clock().toISOString();
  const ownerKey = randomToken(12);
  let conn: Connection | undefined;
  if (deps.useEnvToken && env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_ADMIN_TOKEN) {
    conn = { shop: shopifyDomain(env.SHOPIFY_STORE_DOMAIN), token: env.SHOPIFY_ADMIN_TOKEN, via: 'env_token', connectedAt: iso() };
  }
  const box = deps.secretBox;
  const aad = (field: string) => `${deps.scope ?? 'default'}:shopify:${field}`;
  let saved: SavedApp = {};
  let loaded: Promise<void> | undefined;
  let tokenPersisted = false;
  let tokenProblem: string | undefined;

  /** Credentials entered in the app (and a stored OAuth token), decrypted into memory once. */
  function load(force = false): Promise<void> {
    if (force) loaded = undefined;
    loaded ??= (async () => {
      const doc = await ctx.repos.integrationSecrets.get('shopify');
      saved = {};
      tokenPersisted = false;
      tokenProblem = undefined;
      if (!doc) return;
      saved = { clientId: doc.plain.clientId || undefined, appUrl: doc.plain.appUrl || undefined, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy };
      if (saved.appUrl) registerBasePath(saved.appUrl);
      const why = box ? `${box.keySource} changed since they were saved` : 'no encryption key is configured on the server';
      if (doc.sealed.clientSecret) {
        try {
          if (!box) throw new SecretBoxError('no key');
          saved.clientSecret = box.open(doc.sealed.clientSecret, aad('clientSecret'));
        } catch (e) {
          saved.problem = `The saved Shopify Client secret could not be decrypted — ${why}. Enter the Client secret again${doc.sealed.accessToken ? ' and connect the store again' : ''}.`;
          ctx.log.warn({ err: (e as Error).message }, 'stored Shopify Client secret could not be decrypted');
        }
      }
      if (doc.sealed.accessToken && doc.meta?.shop) {
        try {
          if (!box) throw new SecretBoxError('no key');
          const m = doc.meta as { shop: string; scopes?: string[]; connectedAt?: string; connectedBy?: string; expiresAt?: number };
          conn = { shop: m.shop, token: box.open(doc.sealed.accessToken, aad('accessToken')), via: 'oauth', scopes: m.scopes, connectedAt: m.connectedAt ?? iso(), connectedBy: m.connectedBy, expiresAt: m.expiresAt };
          tokenPersisted = true;
        } catch (e) {
          tokenProblem = `The stored connection to ${String(doc.meta.shop)} could not be decrypted — ${why}. Connect the store again.`;
          ctx.log.warn({ err: (e as Error).message }, 'stored Shopify token could not be decrypted');
        }
      }
    })();
    return loaded;
  }

  /** The app credentials in use: the pair entered in the app, else the server environment (never mixed). */
  const creds = (): { apiKey?: string; apiSecret?: string; source: 'saved' | 'env' | 'none' } => (saved.clientId
    ? { apiKey: saved.clientId, apiSecret: saved.clientSecret, source: 'saved' }
    : env.SHOPIFY_API_KEY || env.SHOPIFY_API_SECRET ? { apiKey: env.SHOPIFY_API_KEY, apiSecret: env.SHOPIFY_API_SECRET, source: 'env' } : { source: 'none' });
  const drafts = new Map<string, ShopifyDraft>();
  const proposals = new Map<string, ThemeProposalInternal>();
  /** Existing text of each draft's resource (facts check for hand edits). */
  const draftSources = new Map<string, string[]>();
  let applying = false;
  /** Reviews (preview step) by token: applying needs one; its result is kept so a repeated submission does not write twice. */
  const previews = new Map<string, { ids: string[]; actorId: string; expiresAt: string; running?: Promise<ShopifyApplyBatchResult>; result?: ShopifyApplyBatchResult }>();
  const snapshots = deps.themeSnapshotDir ? createThemeSnapshotStore(deps.themeSnapshotDir) : undefined;
  const requestedScopes = () => (env.SHOPIFY_SCOPES ? env.SHOPIFY_SCOPES.split(',').map((s) => s.trim()).filter(Boolean) : [...SHOPIFY_REQUIRED_SCOPES, ...SHOPIFY_OPTIONAL_SCOPES]);
  const appUrl = () => (saved.appUrl ?? env.SHOPIFY_APP_URL ?? env.APP_BASE_URL)?.replace(/\/$/, '');
  const appUrlSource = (): 'saved' | 'env' | 'none' => (saved.appUrl ? 'saved' : env.SHOPIFY_APP_URL || env.APP_BASE_URL ? 'env' : 'none');
  const redirectUrl = () => (appUrl() ? `${appUrl()}/api/shopify/oauth/callback` : undefined);
  const oauthConfigured = () => !!(creds().apiKey && creds().apiSecret && appUrl()) && !oauthSetupProblem();

  /**
   * What stops "Connect with Shopify" from working, in words an admin can act on (names only — never values), or
   * undefined when the server side of OAuth is complete. The Shopify Dev Dashboard side (the allowed redirection URL)
   * can only be checked by Shopify, so the exact URL to register is part of the message.
   */
  function oauthSetupProblem(): string | undefined {
    if (saved.problem) return saved.problem;
    const c = creds();
    const missing = [!c.apiKey && 'the Client ID', !c.apiSecret && 'the Client secret', !appUrl() && 'the app URL (the public address of Sentinel, e.g. https://apps.deodap.info/seo-tool)'].filter(Boolean);
    const register = redirectUrl() ? ` In the Shopify Dev Dashboard → your app → Configuration, the Allowed redirection URL must be exactly ${redirectUrl()}.` : '';
    if (missing.length) {
      return `Connect with Shopify needs the Shopify app’s credentials: enter ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]} under “Shopify app credentials” below (the Client secret is stored encrypted on the server)${c.source === 'env' ? ' — or complete SHOPIFY_API_KEY / SHOPIFY_API_SECRET / APP_BASE_URL in the API server environment' : ''}.${register}${deps.useEnvToken ? ' (Alternative for the primary website: SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN from a custom app.)' : ''}`;
    }
    const u = appUrl()!;
    if (env.NODE_ENV === 'production' && !/^https:\/\//i.test(u)) return `Shopify only redirects to https addresses: the app URL must start with https:// (now ${new URL(u).protocol}).`;
    const miss = missingScopes(SHOPIFY_REQUIRED_SCOPES, requestedScopes());
    if (miss.length) return `SHOPIFY_SCOPES leaves out ${miss.join(', ')}, which the SEO editor needs — remove SHOPIFY_SCOPES (the defaults are correct) or add them, then restart the API.`;
    return undefined;
  }

  /** Stores the OAuth token encrypted (when possible) so the connection survives restarts. */
  async function persistToken(): Promise<void> {
    if (!box || !conn || conn.via !== 'oauth') return;
    const prev = await ctx.repos.integrationSecrets.get('shopify');
    const sealedToken = box.seal(conn.token, aad('accessToken'));
    await ctx.repos.integrationSecrets.upsert({
      id: 'shopify', plain: prev?.plain ?? {}, sealed: { ...(prev?.sealed ?? {}), accessToken: sealedToken },
      meta: { shop: conn.shop, scopes: conn.scopes, connectedAt: conn.connectedAt, connectedBy: conn.connectedBy, expiresAt: conn.expiresAt },
      updatedAt: prev?.updatedAt ?? iso(), updatedBy: prev?.updatedBy,
    });
    tokenPersisted = true;
  }

  async function forgetToken(): Promise<void> {
    const prev = await ctx.repos.integrationSecrets.get('shopify');
    if (prev?.sealed.accessToken) {
      const { accessToken: _t, ...rest } = prev.sealed;
      await ctx.repos.integrationSecrets.upsert({ ...prev, sealed: rest, meta: undefined });
    }
    tokenPersisted = false;
  }

  function client(): AdminClient {
    if (!conn) throw new ApiError(409, 'SHOPIFY_NOT_CONNECTED', 'Shopify is not connected. Connect the store in Settings → Shopify.');
    if (conn.expiresAt && conn.expiresAt <= Date.now()) throw new ApiError(409, 'SHOPIFY_TOKEN_EXPIRED', 'The Shopify access token has expired. Connect the store again.');
    return createAdminClient({ shop: conn.shop, token: conn.token, apiVersion: env.SHOPIFY_API_VERSION, fetchImpl, sleep: deps.sleep, secrets: [env.SHOPIFY_API_SECRET ?? '', saved.clientSecret ?? ''].filter((s) => s.length >= 4) });
  }

  /** Shopify errors → API errors (502 for Shopify-side failures, 409 for configuration problems). Messages are already scrubbed. */
  async function call<T>(fn: (c: AdminClient) => Promise<T>): Promise<T> {
    const c = client();
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof ShopifyApiError) {
        if (e.info.status === 401) throw new ApiError(409, 'SHOPIFY_UNAUTHORIZED', e.message);
        if (e.info.code === 'BAD_ID' || e.info.code === 'BAD_FILE') throw badRequest(e.message);
        if (e.info.code === 'NOT_FOUND') throw new ApiError(404, 'NOT_FOUND', e.message);
        throw new ApiError(502, 'SHOPIFY_ERROR', e.message);
      }
      throw e;
    }
  }

  /** Granted scopes and shop name of the current token (once per connection). */
  async function loadScopes(): Promise<void> {
    if (!conn || conn.scopes) return;
    try {
      const d = await client().request<{ shop: { name: string; myshopifyDomain: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(
        'query SentinelScopes { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }',
      );
      conn.scopes = d.currentAppInstallation.accessScopes.map((s) => s.handle);
      conn.shopName = d.shop.name;
      conn.scopeProblem = undefined;
    } catch (e) {
      conn.scopeProblem = `Could not read the token’s access scopes: ${(e as Error).message}`;
    }
  }

  const granted = () => conn?.scopes ?? [];
  const hasScope = (s: string) => missingScopes([s], granted()).length === 0;

  async function siteBase(): Promise<string> {
    return (ctx.engine.readiness().baseUrl || (await ctx.repos.config.get()).site.baseUrl || '').replace(/\/$/, '');
  }
  async function limits(): Promise<Limits> {
    return seoGuidelinesFrom((await ctx.repos.config.get()).thresholds);
  }
  async function storeKeywords(): Promise<string[]> {
    return (await ctx.repos.config.get()).moneyKeywords ?? [];
  }

  async function status(): Promise<ShopifyStatus> {
    await load();
    await loadScopes();
    const problems: string[] = [];
    if (!conn) {
      const setup = oauthSetupProblem();
      if (setup) problems.push(setup);
    }
    if (!conn && tokenProblem) problems.push(tokenProblem);
    if (conn?.scopeProblem) problems.push(conn.scopeProblem);
    const missing = conn?.scopes ? missingScopes(SHOPIFY_REQUIRED_SCOPES, conn.scopes) : [];
    const missingOpt = conn?.scopes ? missingScopes(SHOPIFY_OPTIONAL_SCOPES, conn.scopes) : [];
    if (missing.length) problems.push(`Missing access scopes: ${missing.join(', ')}. The SEO editor cannot write without them — reconnect and approve them.`);
    if (conn?.expiresAt && conn.expiresAt <= Date.now()) problems.push('The access token has expired. Connect again.');
    const ok = !!conn && !!conn.scopes && !missing.length;
    return {
      connected: !!conn, via: conn?.via ?? null, shop: conn?.shop, shopName: conn?.shopName, apiVersion: env.SHOPIFY_API_VERSION,
      scopes: conn?.scopes ?? [], missingScopes: missing, missingOptionalScopes: missingOpt,
      requiredScopes: [...SHOPIFY_REQUIRED_SCOPES], optionalScopes: [...SHOPIFY_OPTIONAL_SCOPES],
      oauthConfigured: oauthConfigured(), redirectUrl: redirectUrl(), connectedAt: conn?.connectedAt, connectedBy: conn?.connectedBy, problems,
      tokenNote: conn?.via === 'oauth' && tokenPersisted ? TOKEN_NOTE_SEALED : TOKEN_NOTE,
      appCredentials: {
        source: creds().source, clientId: creds().apiKey, secretSet: !!creds().apiSecret, appUrl: appUrl(), appUrlSource: appUrlSource(),
        updatedAt: saved.updatedAt, updatedBy: saved.updatedBy, canStore: !!box, persistent: ctx.repos.storage.persistent !== false,
        ...(box ? {} : { storeProblem: 'Credentials cannot be stored: the API server has no SESSION_SECRET (or CREDENTIALS_ENCRYPTION_KEY) to encrypt them with.' }),
      },
      capabilities: { edit: ok, themes: ok && (hasScope('read_themes')), themeWrite: ok && hasScope('write_themes'), imageAlt: ok && (hasScope('write_files') || hasScope('write_themes')) },
    };
  }

  async function requireEditable() {
    const st = await status();
    if (!st.connected) throw new ApiError(409, 'SHOPIFY_NOT_CONNECTED', 'Shopify is not connected. Connect the store in Settings → Shopify.');
    if (!st.capabilities.edit) throw new ApiError(409, 'SHOPIFY_SCOPES', st.problems.join(' ') || 'The Shopify token cannot be used for editing.');
    return st;
  }

  // ------------------------------------------------------------------------------------------ resolving

  async function resolve(url: string): Promise<{ result: ShopifyResolveResult; res?: ShopifyResource }> {
    let u: URL;
    try { u = new URL(url); } catch { throw badRequest('Enter a full page URL (https://…).'); }
    const base = await siteBase();
    const site = base ? hostOf(base).replace(/^www\./, '') : '';
    if (site && u.host.replace(/^www\./, '') !== site && !u.host.endsWith('.myshopify.com')) {
      return { result: { url, problem: `${u.host} is not this website (${site}).` } };
    }
    const p = parseStorefrontPath(u.toString());
    if (!p) return { result: { url, problem: 'Not a product, collection, page or blog article URL. Home, search and other theme pages have no editable resource — they need theme edits.' } };
    const res = await call((c) => fetchByHandle(c, p.kind, p.handle, p.blogHandle));
    if (!res) return { result: { url, ...p, problem: `No ${p.kind} with handle “${p.handle}” in ${conn!.shop}. It may have been renamed (check redirects) or deleted.` } };
    return { result: { url, ...p, resource: summarize(conn!.shop, res) }, res };
  }

  // ------------------------------------------------------------------------------------------ drafts

  /** The live storefront page, parsed (undefined when it cannot be fetched: crawling off, other host, error). */
  async function storefrontPage(url: string): Promise<ReturnType<typeof parseHtml> | undefined> {
    const base = await siteBase();
    if (!ctx.engine.readiness().ready || !base || hostOf(url).replace(/^www\./, '') !== hostOf(base).replace(/^www\./, '')) return undefined;
    const r = await deps.collector.http.request(url, { readBody: true }).catch(() => undefined);
    if (!r || r.finalStatus !== 200 || !r.body) return undefined;
    return parseHtml(r.body, r.finalUrl, hostOf(url));
  }
  /** H1 texts of the live storefront page (undefined when it cannot be fetched: crawling off, other host, error). */
  async function storefrontH1s(url: string): Promise<string[] | undefined> {
    return (await storefrontPage(url))?.h1s.map((h) => h.replace(/\s+/g, ' ').trim());
  }

  const h1Source = (d: ShopifyDraft) => d.h1.sources[0]?.source;
  /** A field's value in Shopify; for the H1, read from where it comes from (the title, or the first <h1> of the body). */
  function liveField(d: ShopifyDraft, live: ShopifyResource, key: string): string {
    if (key !== 'h1') return fieldValue(live, key);
    const src = h1Source(d);
    if (src === 'title') return live.title;
    if (src === 'body') return bodyHeadings(live.bodyHtml).find((h) => h.level === 1)?.text ?? '';
    return d.fields.find((f) => f.key === 'h1')?.current ?? '';
  }

  /** H1 rules across fields: a theme-rendered H1 is changed in the theme; an H1 printed from the title cannot differ from it. */
  function checkH1(d: ShopifyDraft) {
    const f = d.fields.find((x) => x.key === 'h1');
    if (!f) return;
    const errs = f.validation.errors.filter((e) => !e.startsWith('[H1] '));
    if (f.include && f.applyVia === 'theme') errs.push('[H1] This H1 is printed by the theme — use “Change in theme” (diff, backup and confirmation); it is not written through the Admin API.');
    const title = d.fields.find((x) => x.key === 'title');
    if (f.include && h1Source(d) === 'title' && title?.include && title.proposed.replace(/\s+/g, ' ').trim() !== f.proposed.replace(/\s+/g, ' ').trim()) {
      errs.push('[H1] The theme prints the title as the H1, so both come from the same Shopify field: give them the same value, or select only one of them. A different H1 needs a theme change.');
    }
    f.validation = { ...f.validation, ok: errs.length === 0, errors: errs };
  }

  /** Changes to write, with the H1 turned into the field it comes from (title, or the <h1> in the description). */
  function translateH1(d: ShopifyDraft, live: ShopifyResource, changes: Record<string, string>): Record<string, string> {
    if (!('h1' in changes)) return changes;
    const { h1, ...rest } = changes;
    const src = h1Source(d);
    if (src === 'title') return { ...rest, title: rest.title ?? h1 };
    if (src === 'body') {
      const body = rest.bodyHtml ?? live.bodyHtml;
      let done = false;
      const esc = h1.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const next = body.replace(/(<h1(?:\s[^>]*)?>)([\s\S]*?)(<\/h1\s*>)/i, (_m, a, _t, b) => { done = true; return `${a}${esc}${b}`; });
      return done ? { ...rest, bodyHtml: next } : rest;
    }
    return rest;
  }

  /** `opts.crawlRow`: plan from the crawl's row (no storefront request) — bulk planning; applying always reads the live page. */
  async function buildDraft(actor: Actor, res: ShopifyResource, url: string | undefined, existing?: ShopifyDraft, opts: { crawlRow?: CrawledUrl } = {}): Promise<ShopifyDraft> {
    const base = await siteBase();
    const pageUrl = url ?? (base ? `${base}${res.path}` : undefined);
    const found = opts.crawlRow ? { row: opts.crawlRow, at: undefined } : pageUrl ? await deps.latestRow(pageUrl).catch(() => undefined) : undefined;
    // The H1 as the live storefront shows it now (one request); the latest crawl only when the page cannot be fetched.
    const liveH1s = pageUrl && !opts.crawlRow ? await storefrontH1s(pageUrl) : undefined;
    const pageH1s = liveH1s ?? found?.row.h1 ?? [];
    const basis: H1SourceReport['basis'] = liveH1s ? 'storefront' : found ? 'crawl' : 'none';
    const observedAt = liveH1s ? iso() : found?.at;
    const dctx = { res, shopName: conn?.shopName, siteHost: base ? hostOf(base) : '', row: found?.row, pageH1s, h1Basis: basis, observedAt, limits: await limits(), keywords: await storeKeywords() };
    const h1 = detectH1Sources(res, pageH1s, basis, observedAt);
    const fields = buildFields(dctx);
    // ---- H1 heading: its own field, written to wherever the live H1 comes from.
    {
      const src = h1.sources[0];
      const cur = src?.text ?? '';
      const via: 'admin_api' | 'theme' = src && src.source !== 'theme' ? 'admin_api' : 'theme';
      const where = src?.source === 'title' ? `${mutationFor(res.kind, 'title')} — the theme prints the ${res.kind} title as the H1`
        : src?.source === 'body' ? `${mutationFor(res.kind, 'bodyHtml')} — the <h1> inside the ${res.kind === 'product' || res.kind === 'collection' ? 'description' : 'content'}`
          : 'Theme file — change in theme (diff, backup and confirmation)';
      const at = fields.findIndex((f) => f.key === 'title') + 1;
      const titleField = fields.find((f) => f.key === 'title');
      const assessment = assessSeoField('h1', cur, { guidelines: dctx.limits, pageType: res.kind, h1Count: h1.pageH1s.length, duplicate: (found?.row.flags ?? []).includes('dup-h1') });
      // From the title: the Title field's suggestion is the H1 suggestion (one value in Shopify); from the content: its own.
      const suggestion = src?.source === 'title' && titleField
        ? { value: titleField.proposed, reason: titleField.proposed === cur ? (assessment.verdict === 'good' ? 'Already good — keep it.' : `${assessment.problems.filter((p) => p.severity !== 'note').map((p) => p.message).join(' ')} The theme prints the title as the H1: edit the Title field (one value).`) : `The theme prints the title as the H1, so the Title suggestion applies: ${titleField.reason}`, keep: titleField.proposed === cur && assessment.verdict === 'good', confidence: titleField.suggestion?.confidence ?? 'review' as const }
        : cur ? suggestText('h1', cur, assessment, { res, shopName: conn?.shopName, limits: dctx.limits, descText: '', keywords: dctx.keywords }) : undefined;
      const proposed = src?.source === 'body' && suggestion && !suggestion.keep ? suggestion.value : cur;
      fields.splice(at > 0 ? at : fields.length, 0, {
        key: 'h1', label: 'H1 heading', current: cur, proposed, reason: proposed !== cur ? suggestion!.reason : '', source: proposed !== cur ? 'suggested' : 'unchanged', applyVia: via, mutation: where,
        include: proposed !== cur && suggestion?.confidence === 'high', assessment, ...(suggestion ? { suggestion } : {}),
        validation: validateField('h1', proposed, { res, siteHost: base ? hostOf(base) : '', limits: dctx.limits, current: cur, sources: sourceTexts(res, conn?.shopName), source: proposed !== cur ? 'suggested' : 'unchanged', keywords: dctx.keywords }),
        hint: src ? `${src.explanation}${h1.pageH1s.length > 1 ? ` The page has ${h1.pageH1s.length} H1s; this field is the first.` : ''}` : basis === 'none' ? 'The live page could not be read, so its H1 is unknown.' : 'The live page has no H1 — the theme template needs one (change in theme).',
      });
    }
    const altOk = hasScope('write_files') || hasScope('write_themes');
    for (const f of fields) {
      if (f.key.startsWith('imageAlt:') && f.key !== 'imageAlt:featured' && !altOk) {
        f.include = false;
        f.validation = { ...f.validation, ok: false, errors: [...f.validation.errors, 'Needs the write_files (or write_themes) access scope — reconnect and approve it.'] };
      }
    }
    const notes = themeNotes(dctx, h1);
    const at = iso();
    const id = existing?.id ?? `SHD-${randomToken(6)}`;
    draftSources.set(id, sourceTexts(res, conn?.shopName));
    return {
      id, kind: res.kind, resourceId: res.id, handle: res.handle, resourceTitle: res.title, url: pageUrl, adminUrl: adminUrl(conn!.shop, res),
      createdBy: existing?.createdBy ?? actor.name, createdAt: existing?.createdAt ?? at, updatedAt: at, fields, h1, notes, status: 'draft',
    };
  }

  function getDraft(id: string): ShopifyDraft {
    const d = drafts.get(id);
    if (!d) throw notFound(`Draft ${id}`);
    return d;
  }

  function keepDraft(d: ShopifyDraft) {
    drafts.set(d.id, d);
    if (drafts.size > 300) { const old = drafts.keys().next().value as string; drafts.delete(old); draftSources.delete(old); }
  }

  /** Live values + what would be written; conflicts where Shopify changed since the draft was made. */
  async function planFor(d: ShopifyDraft, c: AdminClient) {
    const live = await fetchById(c, d.kind, d.resourceId);
    const problems: string[] = [];
    if (!live) return { live, changes: [] as { key: string; label: string; live: string; proposed: string; conflict: boolean; mutation?: string }[], problems: [`The ${d.kind} no longer exists in Shopify.`] };
    const changes = [];
    for (const f of d.fields.filter((x) => x.include)) {
      if (!f.validation.ok) { problems.push(`${f.label}: ${f.validation.errors.join(' ')}`); continue; }
      const lv = liveField(d, live, f.key);
      if (sameValue(f.key, f.proposed, lv)) continue;
      changes.push({ key: f.key, label: f.label, live: lv, proposed: f.proposed, conflict: !sameValue(f.key, f.current, lv), mutation: f.mutation });
    }
    return { live, changes, problems };
  }

  async function preview(ids: string[], actor: Actor): Promise<ShopifyApplyPreview> {
    if (!ids.length) throw badRequest('Choose at least one draft.');
    if (ids.length > 50) throw badRequest('At most 50 drafts per batch.');
    const list = ids.map(getDraft);
    return call(async (c) => {
      const out: ShopifyApplyPreview['drafts'] = [];
      for (const d of list) {
        const p = await planFor(d, c);
        out.push({ id: d.id, resourceTitle: d.resourceTitle, kind: d.kind, changes: p.changes, problems: p.problems });
      }
      const total = out.reduce((n, d) => n + d.changes.filter((x) => !x.conflict).length, 0);
      const conflicts = out.reduce((n, d) => n + d.changes.filter((x) => x.conflict).length, 0);
      // The review is recorded server-side: applying needs this token (no typed phrase), and reusing it never writes twice.
      const previewId = `PV-${randomToken(10)}`;
      const expiresAt = new Date(ctx.clock().getTime() + PREVIEW_TTL_MS).toISOString();
      for (const [k, v] of previews) if (Date.parse(v.expiresAt) < ctx.clock().getTime()) previews.delete(k);
      previews.set(previewId, { ids: [...ids], actorId: actor.id, expiresAt });
      return { drafts: out, total, conflicts, previewId, expiresAt };
    });
  }

  async function reaudit(d: ShopifyDraft, live: ShopifyResource, appliedKeys: string[]): Promise<ShopifyReaudit> {
    const at = iso();
    const url = d.url ?? `${await siteBase()}${live.path}`;
    const ready = ctx.engine.readiness();
    if (!ready.ready) return { url, at, status: null, checks: [], skipped: `Storefront not fetched: ${ready.reason ?? 'live crawling is off on this server'}. Check the page yourself or run a crawl.` };
    const base = await siteBase();
    if (!base || hostOf(url).replace(/^www\./, '') !== hostOf(base).replace(/^www\./, '')) return { url, at, status: null, checks: [], skipped: 'The page is not on the configured website, so it was not fetched.' };
    const r = await deps.collector.http.request(url, { readBody: true });
    if (r.finalStatus !== 200 || !r.body) return { url, at, status: r.finalStatus, checks: [], note: `The storefront answered ${r.finalStatus ?? r.error ?? 'nothing'}; checks not run.` };
    const html = parseHtml(r.body, r.finalUrl, hostOf(url));
    const n = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const checks: ShopifyReaudit['checks'] = [];
    for (const key of appliedKeys) {
      if (key === 'seoTitle' || (key === 'title' && !live.seoTitle)) {
        const exp = live.seoTitle || live.title;
        checks.push({ field: 'Title tag', expected: exp, found: html.title ?? '', ok: n(html.title).includes(n(exp)) });
      }
      if (key === 'seoDescription') checks.push({ field: 'Meta description', expected: live.seoDescription, found: html.metaDescription ?? '', ok: n(html.metaDescription) === n(live.seoDescription) });
      if (key === 'title' && d.h1.sources.some((s) => s.source === 'title')) checks.push({ field: 'H1', expected: live.title, found: html.h1s.join(' | '), ok: html.h1s.some((h) => n(h) === n(live.title)) });
      if (key === 'bodyHtml') checks.push({ field: 'H1 count', expected: '1', found: String(html.h1s.length), ok: html.h1s.length === 1 });
      if (key === 'h1') { const exp = liveField(d, live, 'h1'); checks.push({ field: 'H1', expected: exp, found: html.h1s.join(' | '), ok: html.h1s.some((h) => n(h) === n(exp)) }); }
      if (key.startsWith('imageAlt:')) {
        const alt = fieldValue(live, key);
        checks.push({ field: 'Image alt', expected: alt, found: html.images.some((i) => n(i.alt) === n(alt)) ? alt : '(not on the page)', ok: html.images.some((i) => n(i.alt) === n(alt)) });
      }
    }
    const bad = checks.filter((c) => !c.ok).length;
    return { url, at, status: r.finalStatus, checks, note: bad ? `${bad} value(s) not visible on the storefront yet. Shopify’s storefront cache or the theme may still show the old value — re-run the check in a few minutes; if it persists, the theme does not output this field.` : undefined };
  }

  async function applyOne(d: ShopifyDraft, c: AdminClient, actor: Actor): Promise<ShopifyDraft> {
    const plan = await planFor(d, c);
    const at = iso();
    const fields: ShopifyFieldResult[] = [];
    if (!plan.live) {
      d.status = 'failed';
      d.result = { at, by: actor.name, fields: d.fields.filter((f) => f.include).map((f) => ({ key: f.key, label: f.label, status: 'failed', before: f.current, message: plan.problems[0] })), verified: false };
      return d;
    }
    const live = plan.live;
    for (const f of d.fields.filter((x) => x.include && !x.validation.ok)) fields.push({ key: f.key, label: f.label, status: 'skipped', before: liveField(d, live, f.key), message: f.validation.errors.map((e) => e.replace(/^\[H1\] /, '')).join(' ') });
    for (const ch of plan.changes.filter((x) => x.conflict)) fields.push({ key: ch.key, label: ch.label, status: 'conflict', before: ch.live, message: 'Changed in Shopify after this draft was made — refresh the draft and review it again.' });
    const todo = plan.changes.filter((x) => !x.conflict);
    const changes = translateH1(d, live, Object.fromEntries(todo.map((x) => [x.key, x.proposed])));
    const h1Via = h1Source(d) === 'title' ? 'title' : 'bodyHtml';
    const ran = new Set<string>();
    for (const op of writeOps(live, changes)) {
      try {
        await op.run(c);
        op.keys.forEach((k) => ran.add(k));
        if (todo.some((x) => x.key === 'h1') && op.keys.includes(h1Via)) ran.add('h1');
      } catch (e) {
        const failedKeys = [...op.keys, ...(todo.some((x) => x.key === 'h1') && op.keys.includes(h1Via) ? ['h1'] : [])];
        for (const k of failedKeys) { const ch = todo.find((x) => x.key === k); if (ch) fields.push({ key: k, label: ch.label, status: 'failed', before: ch.live, message: (e as Error).message }); }
        if (e instanceof ShopifyApiError && e.info.status === 401) throw e;
      }
    }
    let after: ShopifyResource | undefined;
    if (ran.size) after = await fetchById(c, d.kind, d.resourceId).catch(() => undefined);
    for (const ch of todo.filter((x) => ran.has(x.key))) {
      const back = after ? liveField(d, after, ch.key) : undefined;
      const ok = back !== undefined && sameValue(ch.key, ch.proposed, back);
      fields.push({ key: ch.key, label: ch.label, status: ok ? 'verified' : 'applied_unverified', before: ch.live, after: back, message: ok ? undefined : back === undefined ? 'Written, but reading it back failed.' : 'Shopify stored a different value than sent (it may have re-formatted it).' });
    }
    const verifiedKeys = fields.filter((f) => f.status === 'verified').map((f) => f.key);
    const result: ShopifyApplyResult = { at, by: actor.name, fields, verified: fields.length > 0 && fields.every((f) => f.status === 'verified') };
    if (verifiedKeys.length && after) result.reaudit = await reaudit(d, after, verifiedKeys).catch((e) => ({ url: d.url ?? '', at: iso(), status: null, checks: [], skipped: `Re-audit failed: ${(e as Error).message}` }));
    const failed = fields.filter((f) => f.status === 'failed' || f.status === 'conflict').length;
    d.status = !fields.length ? d.status : failed === 0 ? 'applied' : verifiedKeys.length ? 'partial' : 'failed';
    d.result = result;
    // The draft now starts from what Shopify holds.
    if (after) {
      for (const f of d.fields) {
        const r = fields.find((x) => x.key === f.key);
        if (r?.status === 'verified' || r?.status === 'applied_unverified') { f.current = liveField(d, after, f.key); f.proposed = f.current; f.include = false; f.source = 'unchanged'; f.reason = ''; }
      }
    }
    d.updatedAt = iso();
    await audit(ctx, actor, 'shopify.apply', 'shopify', d.id, `Applied ${verifiedKeys.length} verified change(s) to ${d.kind} “${d.resourceTitle}” (${failed} failed/conflict) in ${conn!.shop}`);
    return d;
  }

  /** Writes reviewed drafts one resource at a time; fields unticked in the review are left out. */
  async function runApply(actor: Actor, ids: string[], exclude: Record<string, unknown>): Promise<ShopifyApplyBatchResult> {
    applying = true;
    try {
      for (const id of ids) {
        const skip = Array.isArray(exclude[id]) ? (exclude[id] as unknown[]).map(String) : [];
        for (const f of getDraft(id).fields) if (skip.includes(f.key)) f.include = false;
      }
      const list = ids.map(getDraft);
      if (!list.some((d) => d.fields.some((f) => f.include))) throw badRequest('Nothing is selected to apply.');
      const c = client();
      const out: ShopifyDraft[] = [];
      let stopped: string | undefined;
      for (const d of list) {
        if (stopped) {
          d.result = { at: iso(), by: actor.name, fields: d.fields.filter((f) => f.include).map((f) => ({ key: f.key, label: f.label, status: 'skipped', before: f.current, message: `Not attempted: ${stopped}` })), verified: false };
          out.push(d);
          continue;
        }
        try {
          out.push(await applyOne(d, c, actor));
        } catch (e) {
          stopped = (e as Error).message;
          d.status = 'failed';
          d.result = { at: iso(), by: actor.name, fields: d.fields.filter((f) => f.include).map((f) => ({ key: f.key, label: f.label, status: 'failed', before: f.current, message: stopped })), verified: false };
          out.push(d);
        }
      }
      const fl = out.flatMap((d) => d.result?.fields ?? []);
      return { applied: fl.filter((f) => f.status === 'verified' || f.status === 'applied_unverified').length, failed: fl.filter((f) => f.status === 'failed' || f.status === 'conflict').length, skipped: fl.filter((f) => f.status === 'skipped').length, drafts: out };
    } finally {
      applying = false;
    }
  }

  // ------------------------------------------------------------------------------------------ bulk SEO fixes
  const bulkSources = new WeakMap<ShopifyDraft, string[]>();
  async function validateFor(d: ShopifyDraft, f: ShopifyFieldDraft, value: string) {
    const base = await siteBase();
    const res = { kind: d.kind, id: d.resourceId, handle: d.handle, title: f.key === 'title' ? value : d.resourceTitle, seoTitle: '', seoDescription: '', bodyHtml: '', path: '' } as ShopifyResource;
    const v = validateField(f.key, value, { res, siteHost: base ? hostOf(base) : '', limits: await limits(), current: f.current, sources: bulkSources.get(d) ?? draftSources.get(d.id) ?? [], source: 'suggested', keywords: await storeKeywords() });
    if (f.key.startsWith('imageAlt:') && f.key !== 'imageAlt:featured' && !(hasScope('write_files') || hasScope('write_themes'))) { v.ok = false; v.errors.push('Needs the write_files (or write_themes) access scope — reconnect and approve it.'); }
    return v;
  }
  const bulk = createBulkFixer({
    ctx, requireEditable: async () => { await requireEditable(); }, connected: () => !!conn, call, client,
    resolveUrl: async (url) => { const r = await resolve(url); return { res: r.res, problem: r.result.problem }; },
    fetchById,
    buildDraft: async (actor, res, url, opts) => {
      const d = await buildDraft(actor, res, url, undefined, opts);
      bulkSources.set(d, draftSources.get(d.id) ?? []);
      draftSources.delete(d.id); // not kept in the editor's list
      return d;
    },
    validate: validateFor, applyOne,
    lock: () => { if (applying) return false; applying = true; return true; },
    unlock: () => { applying = false; },
    siteBase, latestRow: (u) => deps.latestRow(u), fetchPage: storefrontPage, shop: () => conn?.shop,
  }, deps.seo);

  const service = {
    ownerKey,
    status: async (actor: Actor) => { await need(ctx, actor, 'integrations.view'); return status(); },

    async startOAuth(actor: Actor, shopInput: string): Promise<{ authorizeUrl: string }> {
      await need(ctx, actor, 'integrations.manage');
      await load();
      if (!oauthConfigured()) throw new ApiError(409, 'SHOPIFY_OAUTH_NOT_CONFIGURED', oauthSetupProblem() ?? 'OAuth is not configured.');
      const shop = normalizeShop(shopInput);
      if (!shop) throw badRequest('Enter the store’s .myshopify.com domain (Shopify admin → Settings → Domains), e.g. deodap.myshopify.com — not the storefront domain.');
      const st = states.issue({ shop, actorId: actor.id, actorName: actor.name, owner: ownerKey });
      await audit(ctx, actor, 'shopify.oauth_start', 'shopify', shop, `Started Shopify connection for ${shop}`);
      return { authorizeUrl: authorizeUrl({ shop, apiKey: creds().apiKey!, scopes: requestedScopes(), redirectUri: redirectUrl()!, state: st.state }) };
    },

    /** Completes OAuth for the workspace that issued the state. Returns where to send the browser. */
    async completeOAuth(shop: string, code: string, actorId: string, actorName: string): Promise<void> {
      await load();
      const c = creds();
      if (!c.apiKey || !c.apiSecret) throw new OAuthError('The Shopify app credentials are no longer set.', 'NOT_CONFIGURED');
      const grant = await exchangeCode(fetchImpl, { shop, apiKey: c.apiKey, apiSecret: c.apiSecret, code });
      const miss = missingScopes(SHOPIFY_REQUIRED_SCOPES, grant.scopes);
      if (miss.length) throw new OAuthError(`Shopify granted the app without ${miss.join(', ')}. Approve all requested scopes.`, 'MISSING_SCOPES');
      conn = { shop, token: grant.accessToken, via: 'oauth', scopes: grant.scopes, connectedAt: iso(), connectedBy: actorName, expiresAt: grant.expiresAt };
      await loadScopes();
      try {
        const d = await client().request<{ shop: { name: string } }>('query SentinelShop { shop { name } }');
        conn.shopName = d.shop.name;
      } catch { /* name is cosmetic */ }
      await audit(ctx, { id: actorId, name: actorName, role: 'admin', teamIds: [], permissions: [], demo: false }, 'shopify.connect', 'shopify', shop, `Connected Shopify store ${shop} (OAuth; scopes ${grant.scopes.join(', ')})`);
      try {
        await persistToken();
      } catch (e) {
        ctx.log.warn({ err: (e as Error).message }, 'the Shopify token could not be stored (kept in memory only)');
      }
      ctx.log.info({ shop, via: 'oauth', scopes: grant.scopes, stored: tokenPersisted }, 'shopify connected');
    },

    async disconnect(actor: Actor): Promise<ShopifyStatus> {
      await need(ctx, actor, 'integrations.manage');
      await load();
      const shop = conn?.shop;
      conn = undefined;
      await forgetToken();
      drafts.clear();
      draftSources.clear();
      proposals.clear();
      if (shop) await audit(ctx, actor, 'shopify.disconnect', 'shopify', shop, `Disconnected Shopify store ${shop} (token dropped from memory; uninstall the app in Shopify to revoke it)`);
      return status();
    },

    /**
     * Change signal for incremental monitoring (as in the Shopify Optimizer: the Admin API's updated_at, newest first):
     * storefront URLs of active products and published collections updated after `since`. One GraphQL call (≤ 100 of
     * each) through the rate-limited client; nothing when Shopify is not connected or lacks read_products.
     */
    async changedSince(since: string): Promise<{ urls: string[]; capped: boolean; problem?: string }> {
      await load();
      if (!conn || (conn.scopes && !hasScope('read_products'))) return { urls: [], capped: false, problem: conn ? 'missing read_products scope' : undefined };
      const q = `updated_at:>'${new Date(since).toISOString()}'`;
      try {
        const d = await client().request<{ products: { nodes: { handle: string }[] }; collections: { nodes: { handle: string }[] } }>(
          'query SentinelChanged($p: String!, $c: String!) { products(first: 100, sortKey: UPDATED_AT, reverse: true, query: $p) { nodes { handle } } collections(first: 100, sortKey: UPDATED_AT, reverse: true, query: $c) { nodes { handle } } }',
          { p: `${q} AND status:active`, c: `${q} AND published_status:published` },
        );
        const base = await siteBase();
        const urls = [...d.products.nodes.map((n) => `${base}/products/${n.handle}`), ...d.collections.nodes.map((n) => `${base}/collections/${n.handle}`)];
        return { urls, capped: d.products.nodes.length >= 100 || d.collections.nodes.length >= 100 };
      } catch (e) {
        return { urls: [], capped: false, problem: (e as Error).message };
      }
    },

    /** Loads stored credentials / token at start-up (and registers the app URL's sub-path). */
    restore: () => load(),

    /** The secret used to verify a callback for this website (never leaves the server). */
    async callbackSecret(): Promise<string | undefined> { await load(); return creds().apiSecret; },
    async returnBase(): Promise<string> { await load(); return appUrl() ?? ''; },

    /**
     * Saves the Shopify app's Client ID, Client secret (encrypted) and Sentinel's public URL for this website. An empty
     * clientSecret keeps the stored one. Never returns or logs the secret.
     */
    async saveAppCredentials(actor: Actor, input: { clientId?: unknown; clientSecret?: unknown; appUrl?: unknown }): Promise<ShopifyStatus> {
      await need(ctx, actor, 'integrations.manage');
      await load();
      if (!box) throw new ApiError(409, 'NO_ENCRYPTION_KEY', 'Credentials cannot be stored: the API server has no SESSION_SECRET (or CREDENTIALS_ENCRYPTION_KEY, ≥ 32 characters) to encrypt them with. Set one and restart the API.');
      const fields: Record<string, string> = {};
      const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
      const secret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
      const url = typeof input.appUrl === 'string' ? input.appUrl.trim() : '';
      if (!CLIENT_ID_RE.test(clientId)) fields.clientId = 'Enter the Client ID from the Shopify Dev Dashboard → your app → Settings (letters and digits, usually 32 characters).';
      const prev = await ctx.repos.integrationSecrets.get('shopify');
      const keepSecret = !secret && !!prev?.sealed.clientSecret && prev.plain.clientId === clientId && !saved.problem;
      if (!secret && !keepSecret) fields.clientSecret = 'Enter the Client secret from the Shopify Dev Dashboard → your app → Settings.';
      else if (secret && !CLIENT_SECRET_RE.test(secret)) fields.clientSecret = 'That does not look like a Client secret (16–256 characters, no spaces).';
      if (secret && secret === clientId) fields.clientSecret = 'The Client secret is not the same as the Client ID.';
      let appUrlValue: string | undefined;
      if (url) {
        const chk = checkAppUrl(url, env.NODE_ENV === 'production');
        if (!chk.ok) fields.appUrl = chk.error; else appUrlValue = chk.value;
      } else if (!env.SHOPIFY_APP_URL && !env.APP_BASE_URL) fields.appUrl = 'Enter the public address of Sentinel, e.g. https://apps.deodap.info/seo-tool.';
      if (Object.keys(fields).length) throw new ApiError(400, 'VALIDATION', Object.values(fields).join(' '), { fields });
      const sealed = { ...(prev?.sealed ?? {}) };
      if (secret) sealed.clientSecret = box.seal(secret, aad('clientSecret'));
      // A stored token that can no longer be decrypted is useless: drop it (the store is connected again with OAuth).
      const dropToken = !!tokenProblem;
      if (dropToken) delete sealed.accessToken;
      await ctx.repos.integrationSecrets.upsert({
        id: 'shopify', plain: { clientId, ...(appUrlValue ? { appUrl: appUrlValue } : {}) }, sealed, meta: dropToken ? undefined : prev?.meta,
        updatedAt: iso(), updatedBy: actor.name,
      });
      await load(true);
      await audit(ctx, actor, 'shopify.app_credentials', 'shopify', clientId.slice(0, 6), `Saved the Shopify app credentials (Client ID ${clientId.slice(0, 6)}…, Client secret ${secret ? 'replaced' : 'kept'}, stored encrypted)${appUrlValue ? `; app URL ${appUrlValue}` : ''}`);
      ctx.log.info({ clientId: `${clientId.slice(0, 6)}…`, secretReplaced: !!secret }, 'shopify app credentials saved');
      return status();
    },

    /** Removes the credentials entered in the app (a stored token stays until Disconnect). */
    async removeAppCredentials(actor: Actor): Promise<ShopifyStatus> {
      await need(ctx, actor, 'integrations.manage');
      const prev = await ctx.repos.integrationSecrets.get('shopify');
      if (prev) {
        const { clientSecret: _s, ...rest } = prev.sealed;
        await ctx.repos.integrationSecrets.upsert({ ...prev, plain: {}, sealed: rest, updatedAt: iso(), updatedBy: actor.name });
      }
      await load(true);
      await audit(ctx, actor, 'shopify.app_credentials_removed', 'shopify', 'shopify', 'Removed the Shopify app credentials entered in Sentinel');
      return status();
    },

    async resolveUrl(actor: Actor, url: string): Promise<ShopifyResolveResult> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      return (await resolve(url)).result;
    },

    async list(actor: Actor, kind: ShopifyResourceKind, q?: string, after?: string): Promise<ShopifyResourceList> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      if (!['product', 'collection', 'page', 'article'].includes(kind)) throw badRequest('kind must be product, collection, page or article.');
      const r = await call((c) => listResources(c, kind, q, after));
      return { kind, items: r.items.map((x) => summarize(conn!.shop, x)), nextCursor: r.nextCursor };
    },

    async createDraft(actor: Actor, input: { url?: string; kind?: ShopifyResourceKind; id?: string }): Promise<ShopifyDraft> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      let res: ShopifyResource | undefined;
      let url = input.url;
      if (input.url) {
        const r = await resolve(input.url);
        if (!r.res) throw new ApiError(404, 'SHOPIFY_NO_RESOURCE', r.result.problem ?? 'No resource found.');
        res = r.res;
      } else if (input.kind && input.id) {
        if (!isGid(input.id)) throw badRequest('id must be a Shopify GID (gid://shopify/…).');
        res = await call((c) => fetchById(c, input.kind!, input.id!));
        if (!res) throw notFound(`${input.kind} ${input.id}`);
        url = undefined;
      } else throw badRequest('Give a page URL, or kind and id.');
      const d = await buildDraft(actor, res, url);
      keepDraft(d);
      return d;
    },

    async listDrafts(actor: Actor): Promise<ShopifyDraft[]> {
      await need(ctx, actor, 'shopify.edit');
      return [...drafts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getDraft(actor: Actor, id: string): Promise<ShopifyDraft> {
      await need(ctx, actor, 'shopify.edit');
      return getDraft(id);
    },

    async updateDraft(actor: Actor, id: string, input: { fields?: Record<string, { proposed?: unknown; include?: unknown }> }): Promise<ShopifyDraft> {
      await need(ctx, actor, 'shopify.edit');
      const d = getDraft(id);
      if (!input.fields || typeof input.fields !== 'object') throw badRequest('fields is required.');
      const base = await siteBase();
      const L = await limits();
      const keywords = await storeKeywords();
      const sources = draftSources.get(d.id) ?? [];
      for (const [key, ch] of Object.entries(input.fields)) {
        const f = d.fields.find((x) => x.key === key);
        if (!f) throw badRequest(`Unknown field ${key}.`);
        if (ch.proposed !== undefined) {
          if (typeof ch.proposed !== 'string') throw badRequest(`${key}: proposed must be text.`);
          if (ch.proposed.length > 200_000) throw badRequest(`${key}: too long.`);
          const changed = ch.proposed !== f.proposed;
          f.proposed = ch.proposed;
          if (changed) { f.source = ch.proposed === f.current ? 'unchanged' : 'manual'; if (f.source === 'manual') f.reason = f.reason || 'Edited by hand.'; }
          const res = { kind: d.kind, id: d.resourceId, handle: d.handle, title: f.key === 'title' ? f.proposed : d.resourceTitle, seoTitle: '', seoDescription: '', bodyHtml: '', path: '' } as ShopifyResource;
          const v = validateField(key, f.proposed, { res, siteHost: base ? hostOf(base) : '', limits: L, current: f.current, sources, source: f.source, keywords });
          if (key.startsWith('imageAlt:') && key !== 'imageAlt:featured' && !(hasScope('write_files') || hasScope('write_themes'))) { v.ok = false; v.errors.push('Needs the write_files (or write_themes) access scope — reconnect and approve it.'); }
          f.validation = v;
          if (ch.include === undefined) f.include = f.proposed !== f.current;
        }
        if (ch.include !== undefined) f.include = !!ch.include;
      }
      checkH1(d);
      d.updatedAt = iso();
      return d;
    },

    async deleteDraft(actor: Actor, id: string) {
      await need(ctx, actor, 'shopify.edit');
      getDraft(id);
      drafts.delete(id);
      draftSources.delete(id);
      return { ok: true as const };
    },

    async refreshDraft(actor: Actor, id: string): Promise<ShopifyDraft> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      const d = getDraft(id);
      const res = await call((c) => fetchById(c, d.kind, d.resourceId));
      if (!res) throw notFound(`${d.kind} ${d.resourceId}`);
      const fresh = await buildDraft(actor, res, d.url, d);
      keepDraft(fresh);
      return fresh;
    },

    async preview(actor: Actor, ids: string[]): Promise<ShopifyApplyPreview> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      return preview(ids, actor);
    },

    async backup(actor: Actor, ids: string[]): Promise<{ filename: string; mimeType: string; content: string }> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      const list = ids.map(getDraft);
      const resources = await call(async (c) => {
        const out = [];
        for (const d of list) {
          const live = await fetchById(c, d.kind, d.resourceId);
          out.push({ draftId: d.id, kind: d.kind, id: d.resourceId, handle: d.handle, exists: !!live, values: live ? Object.fromEntries(d.fields.map((f) => [f.key, liveField(d, live, f.key)])) : {} });
        }
        return out;
      });
      await audit(ctx, actor, 'shopify.backup', 'shopify', list.map((d) => d.id).join(','), `Downloaded original values of ${list.length} resource(s)`);
      const stamp = iso().replace(/[:.]/g, '-');
      return { filename: `shopify-originals-${stamp}.json`, mimeType: 'application/json; charset=utf-8', content: JSON.stringify({ shop: conn!.shop, takenAt: iso(), note: 'Values in Shopify at download time, before applying the drafts.', resources }, null, 2) };
    },

    /**
     * Applies reviewed drafts. `previewId` comes from the review (preview) step; `exclude` lists field keys per draft that
     * were unticked there. The same previewId twice returns the first result (no second write).
     */
    async apply(actor: Actor, ids: string[], opts: { previewId?: unknown; exclude?: unknown }): Promise<ShopifyApplyBatchResult> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      const previewId = typeof opts.previewId === 'string' ? opts.previewId : '';
      const rv = previews.get(previewId);
      if (!rv) throw new ApiError(400, 'REVIEW_REQUIRED', 'Nothing was written. Review the changes first (the review step lists exactly what will be written).');
      if (rv.actorId !== actor.id) throw new ApiError(403, 'REVIEW_REQUIRED', 'This review belongs to another user. Review the changes yourself.');
      if (rv.result) return rv.result;
      if (rv.running) return rv.running;
      if (Date.parse(rv.expiresAt) < ctx.clock().getTime()) { previews.delete(previewId); throw new ApiError(409, 'REVIEW_EXPIRED', 'The review is older than 15 minutes. Review the changes again — values may have changed in Shopify.'); }
      if (ids.length !== rv.ids.length || ids.some((x) => !rv.ids.includes(x))) throw badRequest('The drafts differ from the reviewed ones. Review the changes again.');
      if (applying) throw conflict('Another batch is being applied. Wait for it to finish.');
      const exclude = (opts.exclude && typeof opts.exclude === 'object' ? opts.exclude : {}) as Record<string, unknown>;
      rv.running = runApply(actor, ids, exclude);
      try {
        rv.result = await rv.running;
        return rv.result;
      } finally {
        rv.running = undefined;
      }
    },

    // -------------------------------------------------------------------------------------- bulk SEO fixes

    async seoBulkStart(actor: Actor, input: Partial<SeoBulkStartInput>): Promise<SeoBulkJob> {
      await need(ctx, actor, 'shopify.edit');
      if (input?.scope === 'issues') await need(ctx, actor, 'issues.view');
      return bulk.start(actor, input ?? {});
    },
    async seoBulkStatus(actor: Actor): Promise<SeoBulkJob | null> {
      await need(ctx, actor, 'shopify.edit');
      return bulk.status();
    },
    async seoBulkItems(actor: Actor, q: Record<string, unknown>): Promise<SeoBulkItemsPage> {
      await need(ctx, actor, 'shopify.edit');
      return bulk.items(q);
    },
    async seoBulkSelect(actor: Actor, input: Record<string, unknown>): Promise<SeoBulkJob> {
      await need(ctx, actor, 'shopify.edit');
      return bulk.select(input);
    },
    async seoBulkApply(actor: Actor, jobId: unknown): Promise<SeoBulkJob> {
      await need(ctx, actor, 'shopify.edit');
      return bulk.apply(actor, jobId);
    },
    async seoBulkCancel(actor: Actor, jobId: unknown): Promise<SeoBulkJob> {
      await need(ctx, actor, 'shopify.edit');
      return bulk.cancel(jobId);
    },
    /** Tests: wait for the bulk job's running phase. */
    seoBulkIdle: () => bulk.idle(),
    /** SEO Optimization lists: pages with current values, problems and suggestions (suggestions need Shopify edit access). */
    async seoOptimization(actor: Actor, field: SeoOptimizationField, q: SeoOptimizationQuery): Promise<SeoOptimizationPage> {
      await need(ctx, actor, 'crawls.view');
      await load();
      if (!(await can(ctx, actor, 'shopify.edit'))) {
        const page = await bulk.optimizationList(actor, field === 'tags' ? 'titles' : field, { ...q, limit: q.limit });
        if (field === 'tags') return { ...page, field, rows: [], total: 0, counts: {}, note: 'Tags live in Shopify; your role cannot read Shopify content.' };
        return { ...page, rows: page.rows.map((r) => ({ ...r, suggestion: null, suggestionNote: 'Your role cannot read Shopify content, so no suggestions.' })) };
      }
      return bulk.optimizationList(actor, field, q);
    },

    async reauditDraft(actor: Actor, id: string): Promise<ShopifyDraft> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      const d = getDraft(id);
      const live = await call((c) => fetchById(c, d.kind, d.resourceId));
      if (!live) throw notFound(`${d.kind} ${d.resourceId}`);
      const keys = (d.result?.fields ?? []).filter((f) => f.status === 'verified' || f.status === 'applied_unverified').map((f) => f.key);
      const ra = await reaudit(d, live, keys.length ? keys : ['seoTitle', 'seoDescription']);
      d.result = d.result ? { ...d.result, reaudit: ra } : { at: iso(), by: actor.name, fields: [], verified: false, reaudit: ra };
      d.updatedAt = iso();
      return d;
    },


    // -------------------------------------------------------------------------------------- theme source snapshots (read-only)

    /** Reads a theme's text files through the authorised connection and keeps them as a snapshot (never writes to Shopify). */
    async themeSnapshot(actor: Actor, themeId: unknown): Promise<ThemeSnapshotMeta> {
      await need(ctx, actor, 'shopify.theme');
      const st = await status();
      if (!st.capabilities.themes) throw new ApiError(409, 'SHOPIFY_SCOPES', st.connected ? 'The connection lacks the read_themes scope. Reconnect and approve it.' : 'Shopify is not connected: theme source can only be read through an authorised connection.');
      if (typeof themeId !== 'string') throw badRequest('themeId is required.');
      if (!snapshots) throw new ApiError(409, 'NOT_CONFIGURED', 'Theme snapshots need the Change Monitor storage folder.');
      const theme = await call((c) => getTheme(c, themeId));
      const names = (await call((c) => listThemeFiles(c, themeId))).filter((f) => SNAPSHOT_FILE.test(f.filename));
      const meta = await snapshots.save({ themeId, themeName: theme.name, themeRole: theme.role, at: iso(), takenBy: actor.name }, names, (fs) => call((c) => readThemeFiles(c, themeId, fs)));
      await audit(ctx, actor, 'shopify.theme_snapshot', 'shopify', meta.id, `Read ${meta.files} file(s) of theme “${theme.name}” (${theme.role}) for comparison (read-only)`);
      return meta;
    },
    async themeSnapshots(actor: Actor): Promise<ThemeSnapshotMeta[]> {
      await need(ctx, actor, 'shopify.theme');
      return snapshots ? snapshots.list() : [];
    },
    async themeSnapshotDiff(actor: Actor, from: string, to: string, file?: string): Promise<ThemeDiffResponse> {
      await need(ctx, actor, 'shopify.theme');
      if (!snapshots) throw new ApiError(409, 'NOT_CONFIGURED', 'Theme snapshots need the Change Monitor storage folder.');
      try {
        return await snapshots.diff(from, to, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || /Not a theme snapshot/.test((e as Error).message)) throw notFound(`Theme snapshot ${from} or ${to}`);
        throw e;
      }
    },

    // -------------------------------------------------------------------------------------- themes

    async themes(actor: Actor): Promise<ShopifyTheme[]> {
      await need(ctx, actor, 'shopify.theme');
      const st = await status();
      if (!st.capabilities.themes) throw new ApiError(409, 'SHOPIFY_SCOPES', st.connected ? 'The connection lacks the read_themes scope. Reconnect and approve it.' : 'Shopify is not connected.');
      return call((c) => listThemes(c));
    },

    async themeFile(actor: Actor, themeId: string, filename: string): Promise<ShopifyThemeFile> {
      await need(ctx, actor, 'shopify.theme');
      const st = await status();
      if (!st.capabilities.themes) throw new ApiError(409, 'SHOPIFY_SCOPES', 'The connection lacks the read_themes scope.');
      const f = await call((c) => readThemeFile(c, themeId, filename));
      if (f.size > MAX_THEME_FILE_BYTES) throw badRequest(`${filename} is larger than ${MAX_THEME_FILE_BYTES / 1024} KB.`);
      return f;
    },

    async propose(actor: Actor, input: { themeId?: unknown; filename?: unknown; content?: unknown; reason?: unknown }): Promise<ShopifyThemeProposal> {
      await need(ctx, actor, 'shopify.theme');
      const st = await status();
      if (!st.capabilities.themes) throw new ApiError(409, 'SHOPIFY_SCOPES', 'The connection lacks the read_themes scope.');
      if (typeof input.themeId !== 'string' || typeof input.filename !== 'string' || typeof input.content !== 'string') throw badRequest('themeId, filename and content are required.');
      if (typeof input.reason !== 'string' || !input.reason.trim()) throw badRequest('Say why the change is needed (reason).');
      if (Buffer.byteLength(input.content) > MAX_THEME_FILE_BYTES) throw badRequest('The new content is too large.');
      const { themeId, filename, content } = input as { themeId: string; filename: string; content: string };
      const [theme, file] = await call(async (c) => [await getTheme(c, themeId), await readThemeFile(c, themeId, filename)] as const);
      if (file.content === content) throw badRequest('The new content is the same as the current file.');
      const diff = lineDiff(file.content, content);
      const p: ThemeProposalInternal = {
        id: `THP-${randomToken(6)}`, themeId, themeName: theme.name, themeRole: theme.role, filename, reason: input.reason.trim().slice(0, 500),
        originalChecksum: file.checksumMd5, originalSize: file.size, diff: diff.lines, added: diff.added, removed: diff.removed,
        createdBy: actor.name, createdAt: iso(), status: 'proposed', confirmPhrase: theme.role === 'MAIN' ? `WRITE TO LIVE THEME ${theme.name}` : `APPLY TO ${theme.name}`,
        ...(theme.role === 'MAIN' ? { live: true } : {}), original: file.content, proposed: content,
      };
      proposals.set(p.id, p);
      if (proposals.size > 30) proposals.delete(proposals.keys().next().value as string);
      await audit(ctx, actor, 'shopify.theme_propose', 'shopify', p.id, `Proposed a change to ${filename} in theme “${theme.name}” (${theme.role}): +${diff.added} −${diff.removed} lines`);
      return publicProposal(p);
    },

    /**
     * H1 rendered by the theme: finds the live H1 text in the theme's files and proposes replacing it there (diff +
     * backup; nothing is written until the proposal is confirmed). Default theme: the live one; `themeId` for a copy.
     */
    async proposeH1Theme(actor: Actor, draftId: string, input: { text?: unknown; themeId?: unknown; filename?: unknown }): Promise<ShopifyThemeProposal> {
      await need(ctx, actor, 'shopify.theme');
      const d = getDraft(draftId);
      const st = await status();
      if (!st.capabilities.themes) throw new ApiError(409, 'SHOPIFY_SCOPES', st.connected ? 'The connection lacks the read_themes scope. Reconnect and approve it.' : 'Shopify is not connected.');
      const f = d.fields.find((x) => x.key === 'h1');
      const cur = f?.current.trim() ?? '';
      const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
      if (h1Source(d) === 'title' || h1Source(d) === 'body') throw badRequest('This H1 comes from Shopify content (the title or the description) — change it in the H1 field and apply it there.');
      if (!cur) throw new ApiError(409, 'NO_H1_TEXT', 'The live page shows no H1 text to find in the theme. Add the heading to the template yourself (Themes tab).');
      const v = validateField('h1', text, { res: { kind: d.kind, id: d.resourceId, handle: d.handle, title: d.resourceTitle, seoTitle: '', seoDescription: '', bodyHtml: '', path: '' }, siteHost: '', current: cur, sources: [], source: 'manual' });
      if (!v.ok) throw badRequest(v.errors.join(' '));
      if (text === cur) throw badRequest('The new H1 is the same as the current one.');
      const found = await call(async (c) => {
        const themes = await listThemes(c);
        const theme = typeof input.themeId === 'string' ? themes.find((t) => t.id === input.themeId) : themes.find((t) => t.role === 'MAIN');
        if (!theme) throw notFound('Theme');
        const names = (await listThemeFiles(c, theme.id)).filter((x) => EDITABLE_FILE.test(x.filename) && x.size <= MAX_THEME_FILE_BYTES).map((x) => x.filename).slice(0, 600);
        const files = await readThemeFiles(c, theme.id, typeof input.filename === 'string' ? names.filter((n) => n === input.filename) : names);
        const jsonCur = JSON.stringify(cur).slice(1, -1);
        const hits = [...files].filter(([, body]) => body.includes(cur) || body.includes(jsonCur)).map(([name]) => name);
        return { theme, files, hits, jsonCur };
      });
      if (!found.hits.length) throw new ApiError(409, 'H1_NOT_IN_THEME', `“${cur}” was not found in the files of “${found.theme.name}” (layout, templates, sections, snippets). It may come from an app block, a translation (locales/) or a metafield — change it there.`);
      if (found.hits.length > 1) throw new ApiError(409, 'H1_IN_SEVERAL_FILES', `“${cur}” is in ${found.hits.length} theme files: ${found.hits.join(', ')}. Choose the file to change.`, { files: found.hits });
      const filename = found.hits[0];
      const body = found.files.get(filename)!;
      const content = filename.endsWith('.json')
        ? body.split(found.jsonCur).join(JSON.stringify(text).slice(1, -1))
        : body.split(cur).join(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      const p = await service.propose(actor, { themeId: found.theme.id, filename, content, reason: `H1 on ${d.url ?? d.resourceTitle}: “${cur}” → “${text}”` });
      const internal = proposals.get(p.id)!;
      internal.pageUrl = d.url;
      internal.expectH1 = text;
      return publicProposal(internal);
    },

    async proposalsList(actor: Actor): Promise<ShopifyThemeProposal[]> {
      await need(ctx, actor, 'shopify.theme');
      return [...proposals.values()].reverse().map(publicProposal);
    },

    async applyProposal(actor: Actor, id: string, confirm: string): Promise<ShopifyThemeProposal> {
      await need(ctx, actor, 'shopify.theme');
      const p = proposals.get(id);
      if (!p) throw notFound(`Theme proposal ${id}`);
      if (p.status === 'applied') throw conflict('This proposal was already applied.');
      const st = await status();
      if (!st.capabilities.themeWrite) throw new ApiError(409, 'SHOPIFY_SCOPES', 'The connection lacks the write_themes scope.');
      if (typeof confirm !== 'string' || confirm.trim() !== p.confirmPhrase) throw new ApiError(400, 'CONFIRMATION_REQUIRED', `Nothing was written. Type “${p.confirmPhrase}” to apply.`);
      // The live theme changes the storefront at once: only with its own phrase, after the original file was downloaded.
      if (p.live && !p.backupTakenAt) throw new ApiError(409, 'BACKUP_REQUIRED', 'Nothing was written. Download the original file (backup) first — this proposal changes the live theme.');
      return call(async (c) => {
        const theme = await getTheme(c, p.themeId);
        if (theme.role === 'MAIN' && !p.live) {
          p.status = 'failed';
          p.result = { at: iso(), by: actor.name, message: 'Refused: this theme became the live theme after the proposal was made. Make a new proposal (it asks for the live-theme confirmation).', verified: false };
          throw new ApiError(409, 'LIVE_THEME', p.result.message);
        }
        if (p.live && theme.role !== 'MAIN') {
          p.status = 'failed';
          p.result = { at: iso(), by: actor.name, message: 'Refused: this theme is no longer the live theme. Make a new proposal.', verified: false };
          throw new ApiError(409, 'THEME_ROLE_CHANGED', p.result.message);
        }
        const now = await readThemeFile(c, p.themeId, p.filename);
        if ((p.originalChecksum && now.checksumMd5 !== p.originalChecksum) || (!p.originalChecksum && now.content !== p.original)) {
          p.status = 'conflict';
          p.result = { at: iso(), by: actor.name, message: 'The file changed in Shopify after this proposal was made. Nothing was written — make a new proposal from the current file.', verified: false };
          return publicProposal(p);
        }
        try {
          await writeThemeFile(c, theme, p.filename, p.proposed, { allowLive: !!p.live });
        } catch (e) {
          p.status = 'failed';
          p.result = { at: iso(), by: actor.name, message: (e as Error).message, verified: false };
          return publicProposal(p);
        }
        const back = await readThemeFile(c, p.themeId, p.filename).catch(() => undefined);
        const verified = !!back && (back.content === p.proposed || back.checksumMd5 === md5(p.proposed));
        p.status = 'applied';
        p.result = {
          at: iso(), by: actor.name, verified,
          message: !verified ? 'Written, but reading the file back returned different content.'
            : p.live ? `Written to the live theme “${theme.name}”: the storefront uses it now. Restore the downloaded backup if needed.` : `Written to “${theme.name}” (not published). Preview the theme in Shopify, then publish it yourself.`,
        };
        // Live theme + H1: check the storefront page shows the new H1.
        if (verified && p.live && p.pageUrl && p.expectH1) {
          const h1s = await storefrontH1s(p.pageUrl);
          const n = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
          p.result.liveCheck = h1s
            ? { url: p.pageUrl, expected: p.expectH1, found: h1s, ok: h1s.some((h) => n(h) === n(p.expectH1!)), ...(h1s.some((h) => n(h) === n(p.expectH1!)) ? {} : { note: 'Not visible on the storefront yet (Shopify’s cache) — check again in a few minutes.' }) }
            : { url: p.pageUrl, expected: p.expectH1, found: [], ok: false, note: 'The storefront page could not be fetched from this server.' };
        }
        await audit(ctx, actor, 'shopify.theme_apply', 'shopify', p.id, p.live ? `Wrote ${p.filename} in the LIVE theme “${theme.name}” (verified: ${verified}; backup downloaded ${p.backupTakenAt})` : `Wrote ${p.filename} in unpublished theme “${theme.name}” (verified: ${verified}); theme not published`);
        return publicProposal(p);
      });
    },

    async proposalBackup(actor: Actor, id: string): Promise<{ filename: string; mimeType: string; content: string }> {
      await need(ctx, actor, 'shopify.theme');
      const p = proposals.get(id);
      if (!p) throw notFound(`Theme proposal ${id}`);
      p.backupTakenAt ??= iso();
      await audit(ctx, actor, 'shopify.theme_backup', 'shopify', p.id, `Downloaded the original ${p.filename} of “${p.themeName}” before applying`);
      return { filename: `${p.filename.replace(/[^\w.-]+/g, '_')}.original-${p.createdAt.replace(/[:.]/g, '-')}.txt`, mimeType: 'text/plain; charset=utf-8', content: p.original };
    },

    /** Test hook: whether a token is held (never the token itself). */
    __connected: () => !!conn,
  };
  owners.set(ownerKey, service);
  return service;
}
export type ShopifyService = ReturnType<typeof createShopifyService>;

function publicProposal(p: ThemeProposalInternal): ShopifyThemeProposal {
  const { original: _o, proposed: _p, expectH1: _e, ...rest } = p;
  return rest;
}

/**
 * GET /api/shopify/oauth/callback — public (Shopify redirects the browser here). Finds the website that started the
 * flow from the (not yet consumed) state, verifies the HMAC with THAT website's Client secret (saved in the app or from
 * the environment), then the shop, timestamp and single-use state, then exchanges the code. Always answers with a
 * redirect to the app (never with the token); the reason for a failure is a short code in the query string.
 */
export async function handleOAuthCallback(req: Request, env: Ctx['env']): Promise<string> {
  const q = req.query as Record<string, string | string[] | undefined>;
  const stateParam = typeof q.state === 'string' ? q.state : undefined;
  const pending = states.peek(stateParam);
  const svc = pending ? owners.get(pending.owner) : undefined;
  const appBase = (svc ? await svc.returnBase() : (env.SHOPIFY_APP_URL ?? env.APP_BASE_URL ?? '')).replace(/\/$/, '') || firstBasePath();
  const back = (x: string) => `${appBase}/settings/shopify?${x}`;
  const fail = (code: string) => back(`shopify=error&reason=${encodeURIComponent(code)}`);
  if (!pending) return fail('bad_state');
  if (!svc) return fail('workspace_gone');
  const secret = await svc.callbackSecret();
  if (!secret) return fail('not_configured');
  if (!verifyQueryHmac(q, secret)) return fail('bad_hmac');
  const shop = typeof q.shop === 'string' ? normalizeShop(q.shop) : undefined;
  if (!shop || shop !== q.shop) return fail('bad_shop');
  const ts = Number(q.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > CALLBACK_MAX_AGE_S) return fail('expired');
  const st = states.consume(stateParam);
  if (!st) return fail('bad_state');
  if (st.shop !== shop) return fail('shop_mismatch');
  if (typeof q.code !== 'string' || !q.code) return fail('no_code');
  try {
    await svc.completeOAuth(shop, q.code, st.actorId, st.actorName);
  } catch (e) {
    return fail(e instanceof OAuthError ? e.code.toLowerCase() : 'exchange_failed');
  }
  return back('shopify=connected');
}

/** Test helper: issue a state as if /oauth/start had been called (no network). */
export const __oauthStates = states;
