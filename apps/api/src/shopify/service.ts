/**
 * Shopify connection + SEO editor + theme proposals.
 *
 * Token handling: the Admin API access token (from OAuth on this server, or SHOPIFY_ADMIN_TOKEN on the primary website)
 * lives only in this closure's memory. It is never returned by any method, never logged, never written to disk, and
 * never passed to child processes. After a restart the merchant connects again (or the env token is used).
 *
 * Writes: nothing is written to Shopify until a user with `shopify.edit` (content) or `shopify.theme` (theme files)
 * previews the exact changes and types the confirmation phrase. Every write is read back to verify it, then the
 * storefront page is fetched again (re-audit). Theme writes never touch the live theme and never publish.
 */
import type {
  CrawledUrl, ShopifyApplyBatchResult, ShopifyApplyPreview, ShopifyApplyResult, ShopifyDraft, ShopifyFieldResult, ShopifyReaudit,
  ShopifyResolveResult, ShopifyResourceKind, ShopifyResourceList, ShopifyStatus, ShopifyTheme, ShopifyThemeFile, ShopifyThemeProposal,
  ThemeDiffResponse, ThemeSnapshotMeta,
} from '@sentinel/shared';
import { SHOPIFY_OPTIONAL_SCOPES, SHOPIFY_REQUIRED_SCOPES } from '@sentinel/shared';
import type { Request } from 'express';
import { defaultFetch, type FetchLike } from '../connectors/http';
import { shopifyDomain } from '../connectors/connectors';
import type { Collector } from '../crawler/engine';
import { parseHtml } from '../crawler/parse';
import { hostOf } from '../crawler/url';
import { badRequest, conflict, ApiError, notFound } from '../lib/errors';
import { randomToken } from '../lib/passwords';
import { audit, need, type Actor, type Ctx } from '../services/context';
import { createAdminClient, ShopifyApiError, type AdminClient } from './client';
import { buildFields, detectH1Sources, sourceTexts, themeNotes, validateField, type Limits } from './drafts';
import { authorizeUrl, createStateStore, exchangeCode, missingScopes, normalizeShop, OAuthError, verifyQueryHmac, CALLBACK_MAX_AGE_S } from './oauth';
import { adminUrl, fetchByHandle, fetchById, fieldValue, isGid, listResources, parseStorefrontPath, sameValue, summarize, writeOps, type ShopifyResource } from './resources';
import { getTheme, lineDiff, listThemeFiles, listThemes, md5, MAX_THEME_FILE_BYTES, readThemeFile, readThemeFiles, SNAPSHOT_FILE, writeThemeFile } from './theme';
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
}

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

interface ThemeProposalInternal extends ShopifyThemeProposal { original: string; proposed: string }

/** OAuth states are shared by all website workspaces: the public callback has no website header, so the state says which one started it. */
const states = createStateStore();
const owners = new Map<string, ReturnType<typeof createShopifyService>>();

const TOKEN_NOTE = 'The access token is kept only in this server’s memory: it is never sent to the browser, saved to disk, written to logs or included in exports. After a restart or redeploy, connect again — or set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN in the server environment (primary website only).';

export function createShopifyService(ctx: Ctx, deps: ShopifyDeps) {
  const env = ctx.env;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const iso = () => ctx.clock().toISOString();
  const ownerKey = randomToken(12);
  let conn: Connection | undefined;
  if (deps.useEnvToken && env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_ADMIN_TOKEN) {
    conn = { shop: shopifyDomain(env.SHOPIFY_STORE_DOMAIN), token: env.SHOPIFY_ADMIN_TOKEN, via: 'env_token', connectedAt: iso() };
  }
  const drafts = new Map<string, ShopifyDraft>();
  const proposals = new Map<string, ThemeProposalInternal>();
  /** Existing text of each draft's resource (facts check for hand edits). */
  const draftSources = new Map<string, string[]>();
  let applying = false;
  const snapshots = deps.themeSnapshotDir ? createThemeSnapshotStore(deps.themeSnapshotDir) : undefined;
  const requestedScopes = () => (env.SHOPIFY_SCOPES ? env.SHOPIFY_SCOPES.split(',').map((s) => s.trim()).filter(Boolean) : [...SHOPIFY_REQUIRED_SCOPES, ...SHOPIFY_OPTIONAL_SCOPES]);
  const appUrl = () => (env.SHOPIFY_APP_URL ?? env.APP_BASE_URL)?.replace(/\/$/, '');
  const redirectUrl = () => (appUrl() ? `${appUrl()}/api/shopify/oauth/callback` : undefined);
  const oauthConfigured = () => !!(env.SHOPIFY_API_KEY && env.SHOPIFY_API_SECRET && appUrl()) && !oauthSetupProblem();

  /**
   * What stops "Connect with Shopify" from working, in words an admin can act on (names only — never values), or
   * undefined when the server side of OAuth is complete. The Shopify Dev Dashboard side (the allowed redirection URL)
   * can only be checked by Shopify, so the exact URL to register is part of the message.
   */
  function oauthSetupProblem(): string | undefined {
    const missing = [!env.SHOPIFY_API_KEY && 'SHOPIFY_API_KEY (the app\u2019s Client ID)', !env.SHOPIFY_API_SECRET && 'SHOPIFY_API_SECRET (the app\u2019s Client secret)', !appUrl() && 'APP_BASE_URL (the public address of Sentinel, e.g. https://apps.deodap.info/seo-tool)'].filter(Boolean);
    const register = redirectUrl() ? ` In the Shopify Dev Dashboard → your app → Configuration, the Allowed redirection URL must be exactly ${redirectUrl()}.` : '';
    if (missing.length) {
      return `Connect with Shopify is not set up on the server: set ${missing.join(', ')} in the API server environment and restart the API.${register}${deps.useEnvToken ? ' (Alternative for the primary website: SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN from a custom app.)' : ''}`;
    }
    const u = appUrl()!;
    if (env.NODE_ENV === 'production' && !/^https:\/\//i.test(u)) return `Shopify only redirects to https addresses: ${env.SHOPIFY_APP_URL ? 'SHOPIFY_APP_URL' : 'APP_BASE_URL'} must start with https:// (now ${new URL(u).protocol}).`;
    const miss = missingScopes(SHOPIFY_REQUIRED_SCOPES, requestedScopes());
    if (miss.length) return `SHOPIFY_SCOPES leaves out ${miss.join(', ')}, which the SEO editor needs — remove SHOPIFY_SCOPES (the defaults are correct) or add them, then restart the API.`;
    return undefined;
  }

  function client(): AdminClient {
    if (!conn) throw new ApiError(409, 'SHOPIFY_NOT_CONNECTED', 'Shopify is not connected. Connect the store in Settings → Shopify.');
    if (conn.expiresAt && conn.expiresAt <= Date.now()) throw new ApiError(409, 'SHOPIFY_TOKEN_EXPIRED', 'The Shopify access token has expired. Connect the store again.');
    return createAdminClient({ shop: conn.shop, token: conn.token, apiVersion: env.SHOPIFY_API_VERSION, fetchImpl, sleep: deps.sleep, secrets: [env.SHOPIFY_API_SECRET ?? ''].filter((s) => s.length >= 4) });
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
    const t = (await ctx.repos.config.get()).thresholds as unknown as Partial<Limits>;
    return { titleMinChars: t.titleMinChars ?? 30, titleMaxChars: t.titleMaxChars ?? 60, metaMinChars: t.metaMinChars ?? 70, metaMaxChars: t.metaMaxChars ?? 160 };
  }

  async function status(): Promise<ShopifyStatus> {
    await loadScopes();
    const problems: string[] = [];
    if (!conn) {
      const setup = oauthSetupProblem();
      if (setup) problems.push(setup);
    }
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
      oauthConfigured: oauthConfigured(), redirectUrl: redirectUrl(), connectedAt: conn?.connectedAt, connectedBy: conn?.connectedBy, problems, tokenNote: TOKEN_NOTE,
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

  async function buildDraft(actor: Actor, res: ShopifyResource, url: string | undefined, existing?: ShopifyDraft): Promise<ShopifyDraft> {
    const base = await siteBase();
    const pageUrl = url ?? (base ? `${base}${res.path}` : undefined);
    const found = pageUrl ? await deps.latestRow(pageUrl).catch(() => undefined) : undefined;
    const pageH1s = found?.row.h1 ?? [];
    const basis = found ? 'crawl' : 'none';
    const dctx = { res, shopName: conn?.shopName, siteHost: base ? hostOf(base) : '', row: found?.row, pageH1s, h1Basis: basis as 'crawl' | 'none', observedAt: found?.at, limits: await limits() };
    const h1 = detectH1Sources(res, pageH1s, basis, found?.at);
    const fields = buildFields(dctx);
    const altOk = hasScope('write_files') || hasScope('write_themes');
    for (const f of fields) {
      if (f.key.startsWith('imageAlt:') && !altOk) {
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
      const lv = fieldValue(live, f.key);
      if (sameValue(f.key, f.proposed, lv)) continue;
      changes.push({ key: f.key, label: f.label, live: lv, proposed: f.proposed, conflict: !sameValue(f.key, f.current, lv), mutation: f.mutation });
    }
    return { live, changes, problems };
  }

  async function preview(ids: string[]): Promise<ShopifyApplyPreview> {
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
      return { drafts: out, total, conflicts, confirmPhrase: `APPLY ${total} CHANGE${total === 1 ? '' : 'S'}` };
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
    for (const f of d.fields.filter((x) => x.include && !x.validation.ok)) fields.push({ key: f.key, label: f.label, status: 'skipped', before: fieldValue(live, f.key), message: f.validation.errors.join(' ') });
    for (const ch of plan.changes.filter((x) => x.conflict)) fields.push({ key: ch.key, label: ch.label, status: 'conflict', before: ch.live, message: 'Changed in Shopify after this draft was made — refresh the draft and review it again.' });
    const todo = plan.changes.filter((x) => !x.conflict);
    const changes = Object.fromEntries(todo.map((x) => [x.key, x.proposed]));
    const ran = new Set<string>();
    for (const op of writeOps(live, changes)) {
      try {
        await op.run(c);
        op.keys.forEach((k) => ran.add(k));
      } catch (e) {
        for (const k of op.keys) { const ch = todo.find((x) => x.key === k)!; fields.push({ key: k, label: ch.label, status: 'failed', before: ch.live, message: (e as Error).message }); }
        if (e instanceof ShopifyApiError && e.info.status === 401) throw e;
      }
    }
    let after: ShopifyResource | undefined;
    if (ran.size) after = await fetchById(c, d.kind, d.resourceId).catch(() => undefined);
    for (const ch of todo.filter((x) => ran.has(x.key))) {
      const back = after ? fieldValue(after, ch.key) : undefined;
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
        if (r?.status === 'verified' || r?.status === 'applied_unverified') { f.current = fieldValue(after, f.key); f.proposed = f.current; f.include = false; f.source = 'unchanged'; f.reason = ''; }
      }
    }
    d.updatedAt = iso();
    await audit(ctx, actor, 'shopify.apply', 'shopify', d.id, `Applied ${verifiedKeys.length} verified change(s) to ${d.kind} “${d.resourceTitle}” (${failed} failed/conflict) in ${conn!.shop}`);
    return d;
  }

  const service = {
    ownerKey,
    status: async (actor: Actor) => { await need(ctx, actor, 'integrations.view'); return status(); },

    async startOAuth(actor: Actor, shopInput: string): Promise<{ authorizeUrl: string }> {
      await need(ctx, actor, 'integrations.manage');
      if (!oauthConfigured()) throw new ApiError(409, 'SHOPIFY_OAUTH_NOT_CONFIGURED', oauthSetupProblem() ?? 'OAuth is not configured.');
      const shop = normalizeShop(shopInput);
      if (!shop) throw badRequest('Enter the store’s .myshopify.com domain (Shopify admin → Settings → Domains), e.g. deodap.myshopify.com — not the storefront domain.');
      const st = states.issue({ shop, actorId: actor.id, actorName: actor.name, owner: ownerKey });
      await audit(ctx, actor, 'shopify.oauth_start', 'shopify', shop, `Started Shopify connection for ${shop}`);
      return { authorizeUrl: authorizeUrl({ shop, apiKey: env.SHOPIFY_API_KEY!, scopes: requestedScopes(), redirectUri: redirectUrl()!, state: st.state }) };
    },

    /** Completes OAuth for the workspace that issued the state. Returns where to send the browser. */
    async completeOAuth(shop: string, code: string, actorId: string, actorName: string): Promise<void> {
      const grant = await exchangeCode(fetchImpl, { shop, apiKey: env.SHOPIFY_API_KEY!, apiSecret: env.SHOPIFY_API_SECRET!, code });
      const miss = missingScopes(SHOPIFY_REQUIRED_SCOPES, grant.scopes);
      if (miss.length) throw new OAuthError(`Shopify granted the app without ${miss.join(', ')}. Approve all requested scopes.`, 'MISSING_SCOPES');
      conn = { shop, token: grant.accessToken, via: 'oauth', scopes: grant.scopes, connectedAt: iso(), connectedBy: actorName, expiresAt: grant.expiresAt };
      await loadScopes();
      try {
        const d = await client().request<{ shop: { name: string } }>('query SentinelShop { shop { name } }');
        conn.shopName = d.shop.name;
      } catch { /* name is cosmetic */ }
      await audit(ctx, { id: actorId, name: actorName, role: 'admin', teamIds: [], permissions: [], demo: false }, 'shopify.connect', 'shopify', shop, `Connected Shopify store ${shop} (OAuth; scopes ${grant.scopes.join(', ')})`);
      ctx.log.info({ shop, via: 'oauth', scopes: grant.scopes }, 'shopify connected');
    },

    async disconnect(actor: Actor): Promise<ShopifyStatus> {
      await need(ctx, actor, 'integrations.manage');
      const shop = conn?.shop;
      conn = undefined;
      drafts.clear();
      draftSources.clear();
      proposals.clear();
      if (shop) await audit(ctx, actor, 'shopify.disconnect', 'shopify', shop, `Disconnected Shopify store ${shop} (token dropped from memory; uninstall the app in Shopify to revoke it)`);
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
          const v = validateField(key, f.proposed, { res, siteHost: base ? hostOf(base) : '', limits: L, current: f.current, sources, source: f.source });
          if (key.startsWith('imageAlt:') && !(hasScope('write_files') || hasScope('write_themes'))) { v.ok = false; v.errors.push('Needs the write_files (or write_themes) access scope.'); }
          f.validation = v;
          if (ch.include === undefined) f.include = f.proposed !== f.current;
        }
        if (ch.include !== undefined) f.include = !!ch.include;
      }
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
      return preview(ids);
    },

    async backup(actor: Actor, ids: string[]): Promise<{ filename: string; mimeType: string; content: string }> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      const list = ids.map(getDraft);
      const resources = await call(async (c) => {
        const out = [];
        for (const d of list) {
          const live = await fetchById(c, d.kind, d.resourceId);
          out.push({ draftId: d.id, kind: d.kind, id: d.resourceId, handle: d.handle, exists: !!live, values: live ? Object.fromEntries(d.fields.map((f) => [f.key, fieldValue(live, f.key)])) : {} });
        }
        return out;
      });
      await audit(ctx, actor, 'shopify.backup', 'shopify', list.map((d) => d.id).join(','), `Downloaded original values of ${list.length} resource(s)`);
      const stamp = iso().replace(/[:.]/g, '-');
      return { filename: `shopify-originals-${stamp}.json`, mimeType: 'application/json; charset=utf-8', content: JSON.stringify({ shop: conn!.shop, takenAt: iso(), note: 'Values in Shopify at download time, before applying the drafts.', resources }, null, 2) };
    },

    async apply(actor: Actor, ids: string[], confirm: string): Promise<ShopifyApplyBatchResult> {
      await need(ctx, actor, 'shopify.edit');
      await requireEditable();
      if (applying) throw conflict('Another batch is being applied. Wait for it to finish.');
      applying = true;
      try {
        const pv = await preview(ids);
        if (typeof confirm !== 'string' || confirm.trim() !== pv.confirmPhrase) throw new ApiError(400, 'CONFIRMATION_REQUIRED', `Nothing was written. Review the preview and type “${pv.confirmPhrase}” to apply.`);
        if (pv.total === 0) throw badRequest('There are no changes to apply (all are unchanged, invalid or in conflict).');
        const c = client();
        const out: ShopifyDraft[] = [];
        let stopped: string | undefined;
        for (const id of ids) {
          const d = getDraft(id);
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
        createdBy: actor.name, createdAt: iso(), status: 'proposed', confirmPhrase: `APPLY TO ${theme.name}`, original: file.content, proposed: content,
      };
      proposals.set(p.id, p);
      if (proposals.size > 30) proposals.delete(proposals.keys().next().value as string);
      await audit(ctx, actor, 'shopify.theme_propose', 'shopify', p.id, `Proposed a change to ${filename} in theme “${theme.name}” (${theme.role}): +${diff.added} −${diff.removed} lines`);
      return publicProposal(p);
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
      return call(async (c) => {
        const theme = await getTheme(c, p.themeId);
        if (theme.role === 'MAIN') {
          p.status = 'failed';
          p.result = { at: iso(), by: actor.name, message: 'Refused: the theme is now the live theme. Apply changes to an unpublished copy.', verified: false };
          throw new ApiError(409, 'LIVE_THEME', p.result.message);
        }
        const now = await readThemeFile(c, p.themeId, p.filename);
        if ((p.originalChecksum && now.checksumMd5 !== p.originalChecksum) || (!p.originalChecksum && now.content !== p.original)) {
          p.status = 'conflict';
          p.result = { at: iso(), by: actor.name, message: 'The file changed in Shopify after this proposal was made. Nothing was written — make a new proposal from the current file.', verified: false };
          return publicProposal(p);
        }
        try {
          await writeThemeFile(c, theme, p.filename, p.proposed);
        } catch (e) {
          p.status = 'failed';
          p.result = { at: iso(), by: actor.name, message: (e as Error).message, verified: false };
          return publicProposal(p);
        }
        const back = await readThemeFile(c, p.themeId, p.filename).catch(() => undefined);
        const verified = !!back && (back.content === p.proposed || back.checksumMd5 === md5(p.proposed));
        p.status = 'applied';
        p.result = { at: iso(), by: actor.name, verified, message: verified ? `Written to “${theme.name}” (not published). Preview the theme in Shopify, then publish it yourself.` : 'Written, but reading the file back returned different content.' };
        await audit(ctx, actor, 'shopify.theme_apply', 'shopify', p.id, `Wrote ${p.filename} in unpublished theme “${theme.name}” (verified: ${verified}); theme not published`);
        return publicProposal(p);
      });
    },

    async proposalBackup(actor: Actor, id: string): Promise<{ filename: string; mimeType: string; content: string }> {
      await need(ctx, actor, 'shopify.theme');
      const p = proposals.get(id);
      if (!p) throw notFound(`Theme proposal ${id}`);
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
  const { original: _o, proposed: _p, ...rest } = p;
  return rest;
}

/**
 * GET /api/shopify/oauth/callback — public (Shopify redirects the browser here). Verifies the HMAC with the app secret,
 * the single-use state, the shop domain and the timestamp before exchanging the code. Always answers with a redirect
 * to the app (never with the token); the reason for a failure is a short code in the query string.
 */
export async function handleOAuthCallback(req: Request, env: Ctx['env']): Promise<string> {
  const appBase = (env.SHOPIFY_APP_URL ?? env.APP_BASE_URL ?? '').replace(/\/$/, '');
  const back = (q: string) => `${appBase}/settings/shopify?${q}`;
  const q = req.query as Record<string, string | string[] | undefined>;
  const fail = (code: string) => back(`shopify=error&reason=${encodeURIComponent(code)}`);
  if (!env.SHOPIFY_API_SECRET || !env.SHOPIFY_API_KEY) return fail('not_configured');
  if (!verifyQueryHmac(q, env.SHOPIFY_API_SECRET)) return fail('bad_hmac');
  const shop = typeof q.shop === 'string' ? normalizeShop(q.shop) : undefined;
  if (!shop || shop !== q.shop) return fail('bad_shop');
  const ts = Number(q.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > CALLBACK_MAX_AGE_S) return fail('expired');
  const st = states.consume(typeof q.state === 'string' ? q.state : undefined);
  if (!st) return fail('bad_state');
  if (st.shop !== shop) return fail('shop_mismatch');
  if (typeof q.code !== 'string' || !q.code) return fail('no_code');
  const svc = owners.get(st.owner);
  if (!svc) return fail('workspace_gone');
  try {
    await svc.completeOAuth(shop, q.code, st.actorId, st.actorName);
  } catch (e) {
    return fail(e instanceof OAuthError ? e.code.toLowerCase() : 'exchange_failed');
  }
  return back('shopify=connected');
}

/** Test helper: issue a state as if /oauth/start had been called (no network). */
export const __oauthStates = states;
