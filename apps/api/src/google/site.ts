/**
 * Google for one website: which Google account + GA4 property and which account + Search Console property it uses,
 * connection tests, GA4 / Search Console reports (cached briefly; daily totals kept as history) and Core Web Vitals
 * (PageSpeed Insights runs, mobile and desktop, kept as history; a daily automatic run at 01:30 IST).
 *
 * The mapping is stored in this website's integration settings (GA4: propertyId + googleAccountId, Search Console:
 * property + googleAccountId), so the existing GA4 / Search Console data syncs use the same property and account.
 */
import {
  CWV_MAX_URLS, INTEGRATION_CATALOG, normalizeGa4PropertyId, normalizeGscProperty,
  type CwvReport, type CwvRun, type CwvSiteSettings, type CwvStrategy, type Ga4Report, type GoogleAccount, type GoogleHistoryPoint, type GoogleProduct,
  type GoogleSiteMapping, type GoogleStatus, type GoogleTestResult, type GscInspection, type GscReport, type IntegrationId, type IntegrationState,
  type IntegrationStatus, type ReportCompare, type ReportRange,
} from '@sentinel/shared';
import { ApiError, badRequest, conflict } from '../lib/errors';
import type { StoredIntegrationTest } from '../connectors/registry';
import { audit, can, need, SYSTEM_ACTOR, type Actor, type Ctx } from '../services/context';
import { GA4_DATA, GSC_INSPECT, type GoogleCore } from './core';
import { GoogleError } from './http';
import { fetchGa4, fetchGsc, ymdIst } from './reports';

const KEY: Record<GoogleProduct, 'propertyId' | 'property'> = { ga4: 'propertyId', gsc: 'property' };
const LABEL: Record<GoogleProduct, string> = { ga4: 'Google Analytics 4', gsc: 'Google Search Console' };
const CACHE_MS = 15 * 60_000;
const HISTORY_RUN_CAP = 3000;
const HISTORY_DAYS = 400;

export interface GoogleSiteDeps {
  core: GoogleCore;
  /** Every website (for "used by" on accounts). */
  websites?: () => { id: string; name: string; settings: () => Promise<Partial<Record<GoogleProduct, Record<string, string | number | boolean>>>> }[];
}

/** A GoogleError as an API error the screen can show (status chosen so the UI can offer the right action). */
export function apiErrorOf(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (!(e instanceof GoogleError)) return new ApiError(502, 'GOOGLE_ERROR', (e as Error).message);
  const status = e.code === 'rate_limited' ? 429 : e.code === 'expired' || e.code === 'not_connected' || e.code === 'not_configured' ? 409 : e.code === 'permission' ? 403 : e.code === 'not_found' ? 404 : 502;
  const code = e.code === 'expired' ? 'GOOGLE_RECONNECT' : `GOOGLE_${e.code.toUpperCase()}`;
  return new ApiError(status, code, e.message);
}

export function createGoogleSiteService(ctx: Ctx, d: GoogleSiteDeps) {
  const { core } = d;
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();
  const cache = new Map<string, { at: number; value: unknown }>();
  let cwvRunning = false;

  async function site() {
    const cfg = await r.config.get();
    return { id: ctx.scope ?? 'primary', name: cfg.site.brand || new URL(cfg.site.baseUrl).host, url: cfg.site.baseUrl.replace(/\/$/, '') };
  }
  async function settingsOf(id: IntegrationId) { return (await r.integrationSettings.get(id))?.settings ?? {}; }
  async function saveSettings(id: IntegrationId, patch: Record<string, string | number | boolean | undefined>) {
    const prev = await settingsOf(id);
    const next: Record<string, string | number | boolean> = { ...prev };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') delete next[k]; else next[k] = v; }
    await r.integrationSettings.upsert({ id, settings: next });
  }
  const fingerprint = (accountId: string, property: string) => `oauth:${accountId}:${property}`;

  // ------------------------------------------------------------------------------------------- mappings
  async function mapping(product: GoogleProduct, accounts?: Omit<GoogleAccount, 'usedBy'>[]): Promise<GoogleSiteMapping> {
    const s = await settingsOf(product);
    const accountId = String(s.googleAccountId ?? '') || undefined;
    const property = String(s[KEY[product]] ?? '') || undefined;
    const propertyName = String(s.propertyName ?? '') || undefined;
    if (!accountId) {
      const envJson = product === 'gsc' ? ctx.env.GSC_SERVICE_ACCOUNT_JSON : ctx.env.GA4_SERVICE_ACCOUNT_JSON;
      if (envJson) {
        const st = await ctx.integrations.status(product);
        const ok = st.state === 'connected' || st.state === 'partial' || st.state === 'sync_failed';
        return {
          product, via: 'service_account', property: st.property?.value, state: ok ? 'connected' : st.lastTestAt ? 'failed' : 'not_tested',
          stateDetail: `Using the server’s service account (environment variable). ${st.stateDetail} Connect a Google account here to use reports.`, lastTestAt: st.lastTestAt, lastTestResult: st.lastTestResult,
        };
      }
      return { product, via: 'none', state: 'not_mapped', stateDetail: `No ${product === 'ga4' ? 'GA4 property' : 'Search Console property'} chosen for this website yet.` };
    }
    const list = accounts ?? await core.listAccounts();
    const acct = list.find((a) => a.id === accountId);
    const base = { product, via: 'oauth' as const, accountId, accountEmail: acct?.email, property, propertyName };
    if (!acct) return { ...base, state: 'failed', stateDetail: 'The Google account this website used is no longer connected. Connect it again or choose another account.' };
    if (acct.state === 'expired') return { ...base, state: 'expired', stateDetail: acct.stateDetail ?? 'Google access expired — reconnect the account.' };
    const t = (await r.integrationTests.get(product)) as StoredIntegrationTest | undefined;
    const test = t && t.testedWith === fingerprint(accountId, property ?? '') ? t : undefined;
    if (!test) return { ...base, state: 'not_tested', stateDetail: 'Chosen but not tested yet — run Test connection.' };
    return {
      ...base,
      state: test.rateLimited ? 'rate_limited' : test.ok ? 'connected' : 'failed',
      stateDetail: test.ok ? (test.lastSyncError ? `Connected; the last data sync failed: ${test.lastSyncError}` : `Connected through ${acct.email}.`) : test.result,
      lastTestAt: test.at, lastTestOk: test.ok, lastTestResult: test.result, lastSyncAt: test.lastSuccessfulSyncAt,
    };
  }

  /** Account + property of a website's product, or a clear error when it cannot be used. */
  async function requireMapping(product: GoogleProduct) {
    const m = await mapping(product);
    if (m.via !== 'oauth' || !m.accountId || !m.property) {
      throw new ApiError(409, 'NOT_CONNECTED', `${LABEL[product]} is not connected for this website. ${m.via === 'service_account' ? 'It uses the server’s service account, which feeds the data syncs only — connect a Google account under Settings → Integrations → Google to see reports.' : 'Connect a Google account and choose the property under Settings → Integrations → Google.'}`);
    }
    if (m.state === 'expired') throw new ApiError(409, 'GOOGLE_RECONNECT', m.stateDetail);
    if (m.state === 'failed' && !m.accountEmail) throw new ApiError(409, 'NOT_CONNECTED', m.stateDetail);
    return { accountId: m.accountId, property: m.property, mapping: m };
  }

  async function testMapping(actor: Actor, product: GoogleProduct): Promise<GoogleTestResult> {
    const s = await settingsOf(product);
    const accountId = String(s.googleAccountId ?? '');
    const property = String(s[KEY[product]] ?? '');
    if (!accountId || !property) throw badRequest(`Choose a Google account and ${product === 'ga4' ? 'GA4 property' : 'Search Console property'} first.`);
    let res: GoogleTestResult;
    try {
      if (product === 'ga4') {
        const j = await core.api<{ rowCount?: number }>(accountId, 'Google Analytics 4', `${GA4_DATA}/properties/${encodeURIComponent(property)}:runReport`, {
          method: 'POST', body: JSON.stringify({ dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }], metrics: [{ name: 'sessions' }], limit: 1 }),
        });
        res = { ok: true, message: `GA4 property ${property} is readable${typeof j.rowCount === 'number' ? ` (${j.rowCount} row${j.rowCount === 1 ? '' : 's'} for the last 7 days)` : ''}.` };
      } else {
        const sites = await core.listGscSites(accountId);
        const want = property.toLowerCase();
        const hit = sites.find((x) => x.siteUrl.toLowerCase() === want);
        if (!hit) res = { ok: false, message: `The Google account cannot see the Search Console property ${property} (${sites.length} listed). Add the account as a user of the property in Search Console, or choose another property.` };
        else if (!hit.usable) res = { ok: false, message: `The property ${property} is listed but unverified for this account, so Google returns no data. Verify ownership in Search Console.` };
        else res = { ok: true, message: `Search Console property ${hit.siteUrl} is readable (${hit.permissionLevel === 'siteOwner' ? 'Owner' : hit.permissionLevel === 'siteFullUser' ? 'Full user' : hit.permissionLevel === 'siteRestrictedUser' ? 'Restricted user' : hit.permissionLevel}).` };
      }
    } catch (e) {
      const ge = e instanceof GoogleError ? e : new GoogleError('network', (e as Error).message);
      res = { ok: false, message: ge.message, ...(ge.code === 'rate_limited' ? { rateLimited: true } : {}), ...(ge.code === 'expired' ? { expired: true } : {}) };
    }
    const prev = (await r.integrationTests.get(product)) as StoredIntegrationTest | undefined;
    const fp = fingerprint(accountId, property);
    const doc: StoredIntegrationTest = {
      id: product, at: iso(), ok: res.ok, result: res.message, rateLimited: res.rateLimited ? true : undefined, testedWith: fp,
      lastSuccessfulSyncAt: prev?.testedWith === fp ? prev.lastSuccessfulSyncAt : undefined, lastSyncError: prev?.testedWith === fp ? prev.lastSyncError : undefined,
    };
    await r.integrationTests.upsert(doc);
    await audit(ctx, actor, `google.${product}_test`, 'integration', product, `Tested ${LABEL[product]} (${property}): ${res.ok ? 'OK' : 'failed'}`);
    return res;
  }

  async function setMapping(actor: Actor, product: GoogleProduct, input: { accountId?: unknown; property?: unknown }) {
    await need(ctx, actor, 'google.manage');
    const accountId = String(input.accountId ?? '').trim();
    const raw = String(input.property ?? '').trim();
    const acct = (await core.listAccounts()).find((a) => a.id === accountId);
    if (!acct) throw badRequest('Choose a connected Google account.');
    if (!acct.products.includes(product)) throw badRequest(`${acct.email} did not grant ${product === 'ga4' ? 'Google Analytics' : 'Search Console'} access. Reconnect it and allow that access.`);
    const checked = product === 'ga4' ? normalizeGa4PropertyId(raw) : normalizeGscProperty(raw);
    if (!checked.ok) throw badRequest(checked.error, { fields: { property: checked.error } });
    let propertyName: string | undefined;
    try {
      if (product === 'ga4') {
        const props = await core.listGa4Properties(accountId);
        const p = props.find((x) => x.propertyId === checked.value);
        if (!p) throw badRequest(`${acct.email} has no access to GA4 property ${checked.value}. Choose one of the account’s properties.`);
        propertyName = `${p.displayName}${p.accountName ? ` (${p.accountName})` : ''}`;
      } else {
        const sites = await core.listGscSites(accountId);
        if (!sites.some((x) => x.siteUrl.toLowerCase() === checked.value.toLowerCase())) throw badRequest(`${acct.email} cannot see the Search Console property ${checked.value}. Choose one of the account’s properties.`);
      }
    } catch (e) { throw apiErrorOf(e); }
    await saveSettings(product, { googleAccountId: accountId, [KEY[product]]: checked.value, propertyName });
    cache.clear();
    await audit(ctx, actor, `google.${product}_map`, 'integration', product, `This website now uses ${LABEL[product]} property ${checked.value}${propertyName ? ` “${propertyName}”` : ''} through ${acct.email}`);
    const test = await testMapping(actor, product);
    return { mapping: await mapping(product), test };
  }

  async function clearMapping(actor: Actor, product: GoogleProduct) {
    await need(ctx, actor, 'google.manage');
    await saveSettings(product, { googleAccountId: undefined, [KEY[product]]: undefined, propertyName: undefined });
    cache.clear();
    await audit(ctx, actor, `google.${product}_unmap`, 'integration', product, `Disconnected ${LABEL[product]} from this website`);
    return mapping(product);
  }

  // ------------------------------------------------------------------------------------------- Core Web Vitals
  async function cwvSettings(): Promise<CwvSiteSettings> {
    const s = await settingsOf('psi_crux');
    const urls = String(s.cwvUrls ?? '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, CWV_MAX_URLS);
    return { urls, autoDaily: s.cwvAuto !== false };
  }
  async function cwvTargets(): Promise<string[]> {
    const s = await cwvSettings();
    return s.urls.length ? s.urls : [`${(await site()).url}/`];
  }
  async function saveCwvSettings(actor: Actor, input: { urls?: unknown; autoDaily?: unknown }) {
    await need(ctx, actor, 'google.manage');
    const home = new URL((await site()).url);
    const bare = (h: string) => h.toLowerCase().replace(/^www\./, '');
    const list = Array.isArray(input.urls) ? input.urls.map((x) => String(x).trim()).filter(Boolean) : [];
    if (list.length > CWV_MAX_URLS) throw badRequest(`Choose at most ${CWV_MAX_URLS} pages.`);
    const urls: string[] = [];
    for (const raw of list) {
      let u: URL;
      try { u = new URL(raw.startsWith('/') ? `${home.origin}${raw}` : raw); } catch { throw badRequest(`“${raw}” is not a valid address.`); }
      if (!/^https?:$/.test(u.protocol) || bare(u.hostname) !== bare(home.hostname)) throw badRequest(`“${raw}” is not a page of ${home.hostname}.`);
      u.hash = '';
      if (!urls.includes(u.toString())) urls.push(u.toString());
    }
    await saveSettings('psi_crux', { cwvUrls: urls.join('\n'), cwvAuto: input.autoDaily === false ? false : true });
    await audit(ctx, actor, 'google.cwv_settings', 'integration', 'psi_crux', `Core Web Vitals pages: ${urls.length ? urls.join(', ') : 'homepage'}; daily run ${input.autoDaily === false ? 'off' : 'on'}`);
    return cwvSettings();
  }

  async function storeRun(run: Omit<CwvRun, 'id'>) {
    const saved: CwvRun = { ...run, id: await r.cwvRuns.nextId('CWV', 6) };
    await r.cwvRuns.insert(saved);
    return saved;
  }
  async function prune() {
    const cutoff = new Date(ctx.clock().getTime() - HISTORY_DAYS * 86_400_000).toISOString();
    const all = (await r.cwvRuns.list()).sort((a, b) => a.at.localeCompare(b.at));
    const drop = all.filter((x, i) => x.at < cutoff || i < all.length - HISTORY_RUN_CAP);
    for (const x of drop) await r.cwvRuns.delete(x.id);
  }

  /** Runs every target page on mobile and desktop (bounded server-wide); records failures as runs with the reason. */
  async function runCwv(trigger: CwvRun['trigger'], strategies: CwvStrategy[] = ['mobile', 'desktop']): Promise<{ ok: number; failed: number }> {
    const key = await core.psiKey();
    if (!key) throw new ApiError(409, 'NOT_CONNECTED', 'PageSpeed Insights is not connected: enter an API key under Settings → Integrations → Google.');
    const urls = await cwvTargets();
    let ok = 0;
    let failed = 0;
    let lastError: string | undefined;
    await Promise.all(urls.flatMap((url) => strategies.map(async (strategy) => {
      try {
        const p = await core.psi(key, url, strategy);
        await storeRun({ url, strategy, at: iso(), trigger, ok: !p.runtimeError, ...(p.runtimeError ? { error: p.runtimeError } : {}), performanceScore: p.performanceScore, lab: p.lab, ...(p.field ? { field: p.field } : {}) });
        ok++;
      } catch (e) {
        const msg = (e as Error).message;
        lastError = msg;
        await storeRun({ url, strategy, at: iso(), trigger, ok: false, error: msg, lab: {} });
        failed++;
      }
    })));
    if (failed && !ok && lastError) await core.recordPsiTest(false, lastError);
    else if (ok) await core.recordPsiTest(true, `PageSpeed Insights ran ${ok} test${ok === 1 ? '' : 's'} for ${(await site()).name}${failed ? ` (${failed} failed)` : ''}.`);
    await prune();
    return { ok, failed };
  }

  async function startCwv(actor: Actor, trigger: CwvRun['trigger'] = 'manual') {
    if (cwvRunning) throw conflict('Core Web Vitals tests are already running for this website.');
    if (!(await core.psiKey())) throw new ApiError(409, 'NOT_CONNECTED', 'PageSpeed Insights is not connected: enter an API key under Settings → Integrations → Google.');
    const targets = await cwvTargets();
    cwvRunning = true;
    void runCwv(trigger).then(
      (res) => audit(ctx, actor, 'google.cwv_run', 'integration', 'psi_crux', `Core Web Vitals: ${res.ok} test(s) recorded${res.failed ? `, ${res.failed} failed` : ''}`),
      (e: Error) => ctx.log.warn({ err: e.message }, 'Core Web Vitals run failed'),
    ).finally(() => { cwvRunning = false; });
    return { started: true, tests: targets.length * 2 };
  }

  async function cwvReport(): Promise<CwvReport> {
    const psi = await core.psiStatus();
    const all = (await r.cwvRuns.list()).sort((a, b) => a.at.localeCompare(b.at));
    const latest = new Map<string, CwvRun>();
    for (const run of all) latest.set(`${run.url}|${run.strategy}`, run);
    const since = new Date(ctx.clock().getTime() - 180 * 86_400_000).toISOString();
    return {
      connected: psi.keySource !== 'none', ...(psi.keySource === 'none' ? { problem: 'PageSpeed Insights is not connected: an Admin enters an API key under Settings → Integrations → Google.' } : psi.problem ? { problem: psi.problem } : {}),
      settings: await cwvSettings(), latest: [...latest.values()], history: all.filter((x) => x.at >= since).slice(-2000), running: cwvRunning,
    };
  }

  /** Daily automatic run (scheduler, 01:30 IST): once per day, when a key is set and the daily run is on. */
  async function cwvTick() {
    if (!(await core.psiKey()) || !(await cwvSettings()).autoDaily || cwvRunning) return;
    const today = ymdIst(ctx.clock());
    const ranToday = (await r.cwvRuns.list()).some((x) => x.trigger === 'schedule' && ymdIst(new Date(x.at)) === today);
    if (ranToday) return;
    cwvRunning = true;
    try { await runCwv('schedule'); } finally { cwvRunning = false; }
  }

  // ------------------------------------------------------------------------------------------- reports
  async function cached<T>(key: string, force: boolean, fn: () => Promise<T>): Promise<T & { cached: boolean }> {
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) return { ...(hit.value as T), cached: true };
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 50) cache.delete(cache.keys().next().value as string);
    return { ...value, cached: false };
  }
  const checkRange = (v: unknown): ReportRange => { const x = Number(v ?? 28); if (x !== 7 && x !== 28 && x !== 90) throw badRequest('range must be 7, 28 or 90 days.'); return x; };
  const checkCompare = (v: unknown): ReportCompare => (v === 'year' ? 'year' : 'previous');

  async function history(points: { date: string; ga4?: GoogleHistoryPoint['ga4']; gsc?: GoogleHistoryPoint['gsc'] }[]) {
    for (const p of points) {
      const prev = await r.googleHistory.get(p.date);
      await r.googleHistory.upsert({ ...(prev ?? { id: p.date, date: p.date }), ...(p.ga4 ? { ga4: p.ga4 } : {}), ...(p.gsc ? { gsc: p.gsc } : {}) });
    }
  }

  async function ga4Report(actor: Actor, q: { range?: unknown; compare?: unknown; force?: unknown }): Promise<Ga4Report> {
    await need(ctx, actor, 'analytics.view');
    const range = checkRange(q.range);
    const compare = checkCompare(q.compare);
    const m = await requireMapping('ga4');
    try {
      return await cached(`ga4:${m.accountId}:${m.property}:${range}:${compare}`, q.force === true || q.force === 'true', async () => {
        const rep = await fetchGa4(core, m.accountId, m.property, ctx.clock(), range, compare);
        await history(rep.daily.map((x) => ({ date: x.date, ga4: { activeUsers: x.activeUsers, sessions: x.sessions, conversions: x.conversions } })));
        return { ...rep, propertyName: m.mapping.propertyName, accountEmail: m.mapping.accountEmail, fetchedAt: iso() };
      });
    } catch (e) { throw apiErrorOf(e); }
  }

  async function gscReport(actor: Actor, q: { range?: unknown; compare?: unknown; force?: unknown }): Promise<GscReport> {
    await need(ctx, actor, 'analytics.view');
    const range = checkRange(q.range);
    const compare = checkCompare(q.compare);
    const m = await requireMapping('gsc');
    try {
      return await cached(`gsc:${m.accountId}:${m.property}:${range}:${compare}`, q.force === true || q.force === 'true', async () => {
        const rep = await fetchGsc(core, m.accountId, m.property, ctx.clock(), range, compare);
        await history(rep.daily.map((x) => ({ date: x.date, gsc: { clicks: x.clicks, impressions: x.impressions, ctr: x.ctr, position: x.position } })));
        return { ...rep, accountEmail: m.mapping.accountEmail, fetchedAt: iso() };
      });
    } catch (e) { throw apiErrorOf(e); }
  }

  async function inspectUrl(actor: Actor, rawUrl: unknown): Promise<GscInspection> {
    await need(ctx, actor, 'analytics.view');
    const m = await requireMapping('gsc');
    let url: URL;
    try { url = new URL(String(rawUrl ?? '').trim()); } catch { throw badRequest('Enter the full address of a page of this website.'); }
    type Res = { inspectionResult?: { inspectionResultLink?: string; indexStatusResult?: Record<string, string>; mobileUsabilityResult?: { verdict?: string }; richResultsResult?: { verdict?: string } } };
    try {
      const j = await core.api<Res>(m.accountId, 'Search Console URL inspection', GSC_INSPECT, { method: 'POST', body: JSON.stringify({ inspectionUrl: url.toString(), siteUrl: m.property }) });
      const s = j.inspectionResult?.indexStatusResult ?? {};
      await audit(ctx, actor, 'google.gsc_inspect', 'integration', 'gsc', `Inspected ${url.toString()} in Search Console`);
      return {
        url: url.toString(), inspectedAt: iso(), verdict: s.verdict, coverageState: s.coverageState, indexingState: s.indexingState, robotsTxtState: s.robotsTxtState,
        pageFetchState: s.pageFetchState, lastCrawlTime: s.lastCrawlTime, googleCanonical: s.googleCanonical, userCanonical: s.userCanonical, crawledAs: s.crawledAs,
        mobileUsability: j.inspectionResult?.mobileUsabilityResult?.verdict, richResults: j.inspectionResult?.richResultsResult?.verdict, link: j.inspectionResult?.inspectionResultLink,
      };
    } catch (e) { throw apiErrorOf(e); }
  }

  async function historyPoints(actor: Actor, days: unknown): Promise<GoogleHistoryPoint[]> {
    await need(ctx, actor, 'analytics.view');
    const n = Math.min(480, Math.max(7, Number(days ?? 90) || 90));
    const since = new Date(ctx.clock().getTime() - n * 86_400_000).toISOString().slice(0, 10);
    return (await r.googleHistory.list()).filter((x) => x.date >= since).sort((a, b) => a.date.localeCompare(b.date)).map(({ id: _id, ...p }) => p);
  }

  // ------------------------------------------------------------------------------------------- status
  async function status(actor: Actor, origin?: string): Promise<GoogleStatus> {
    await need(ctx, actor, 'google.manage');
    const accounts = await core.listAccounts();
    const usedBy = new Map<string, GoogleAccount['usedBy']>();
    const me = await site();
    const sites = d.websites?.() ?? [];
    const all = sites.length ? sites : [{ id: me.id, name: me.name, settings: async () => ({ ga4: await settingsOf('ga4'), gsc: await settingsOf('gsc') }) }];
    for (const w of all) {
      const s = await w.settings();
      for (const p of ['ga4', 'gsc'] as GoogleProduct[]) {
        const acct = String(s[p]?.googleAccountId ?? '');
        if (acct) usedBy.set(acct, [...(usedBy.get(acct) ?? []), { websiteId: w.id, websiteName: w.name, product: p, property: String(s[p]?.[KEY[p]] ?? '') }]);
      }
    }
    const runs = (await r.cwvRuns.list()).sort((a, b) => a.at.localeCompare(b.at));
    const last = runs.at(-1);
    return {
      canStore: core.canStore(), ...(core.canStore() ? {} : { storeProblem: 'Credentials cannot be stored: the API server has no SESSION_SECRET (or CREDENTIALS_ENCRYPTION_KEY, 32+ characters). Set one once on the server.' }),
      persistent: core.persistent(),
      oauth: await core.clientStatus(origin),
      accounts: accounts.map((a) => ({ ...a, usedBy: usedBy.get(a.id) ?? [] })),
      psi: await core.psiStatus(),
      website: me,
      ga4: await mapping('ga4', accounts),
      gsc: await mapping('gsc', accounts),
      cwv: { ...(await cwvSettings()), lastRunAt: last?.at, lastRunOk: last?.ok },
    };
  }

  // ------------------------------------------------------------------------------------------- integration registry hooks
  const stateOf = (m: GoogleSiteMapping): IntegrationState => (m.state === 'connected' ? (m.lastTestOk && (/sync failed/.test(m.stateDetail)) ? 'sync_failed' : 'connected') : m.state === 'rate_limited' ? 'rate_limited' : m.state === 'not_tested' ? 'not_configured' : 'connection_failed');

  /** Status of GSC / GA4 / PSI on the generic integrations list when it is managed here (undefined = registry's own rules). */
  async function overrideStatus(id: IntegrationId): Promise<Partial<IntegrationStatus> | undefined> {
    if (id === 'ga4' || id === 'gsc') {
      // Only websites mapped through a Google account (checked first: mapping() of a service-account website asks the registry).
      if (!String((await settingsOf(id)).googleAccountId ?? '')) return undefined;
      const m = await mapping(id);
      const t = (await r.integrationTests.get(id)) as StoredIntegrationTest | undefined;
      return {
        state: stateOf(m), stateDetail: `${m.stateDetail} (Google account sign-in — managed under Integrations → Google.)`,
        property: { key: KEY[id], envVar: id === 'gsc' ? 'GSC_PROPERTY' : 'GA4_PROPERTY_ID', value: m.property, source: 'saved' },
        lastTestAt: m.lastTestAt, lastTestResult: m.lastTestResult, lastSuccessfulSyncAt: t?.lastSuccessfulSyncAt, lastSyncError: t?.lastSyncError,
      };
    }
    if (id === 'psi_crux') {
      const p = await core.psiStatus();
      if (p.keySource !== 'saved') return undefined;
      return {
        state: p.lastTestOk === false ? 'connection_failed' : p.lastTestAt ? 'connected' : 'not_configured',
        stateDetail: p.problem ?? (p.lastTestOk === false ? `Last test failed: ${p.lastTestResult}` : 'API key entered under Integrations → Google (stored encrypted).'),
        lastTestAt: p.lastTestAt, lastTestResult: p.lastTestResult,
      };
    }
    return undefined;
  }
  async function overrideTest(id: IntegrationId): Promise<boolean> {
    if ((id === 'ga4' || id === 'gsc') && String((await settingsOf(id)).googleAccountId ?? '')) { await testMapping(SYSTEM_ACTOR, id); return true; }
    if (id === 'psi_crux' && (await core.psiStatus()).keySource === 'saved') { await testPsi(SYSTEM_ACTOR); return true; }
    return false;
  }

  async function testPsi(actor: Actor): Promise<GoogleTestResult> {
    const key = await core.psiKey();
    if (!key) throw new ApiError(409, 'NOT_CONNECTED', 'Enter a PageSpeed Insights API key first.');
    const url = `${(await site()).url}/`;
    try {
      const p = await core.psi(key, url, 'mobile');
      await storeRun({ url, strategy: 'mobile', at: iso(), trigger: 'test', ok: !p.runtimeError, ...(p.runtimeError ? { error: p.runtimeError } : {}), performanceScore: p.performanceScore, lab: p.lab, ...(p.field ? { field: p.field } : {}) });
      const message = `PageSpeed Insights works: ${url} (mobile)${typeof p.performanceScore === 'number' ? ` — performance score ${p.performanceScore}` : ''}.`;
      await core.recordPsiTest(true, message);
      await audit(ctx, actor, 'google.psi_test', 'integration', 'psi_crux', 'Tested PageSpeed Insights: OK');
      return { ok: true, message };
    } catch (e) {
      const ge = e instanceof GoogleError ? e : new GoogleError('network', (e as Error).message);
      await core.recordPsiTest(false, ge.message);
      await audit(ctx, actor, 'google.psi_test', 'integration', 'psi_crux', 'Tested PageSpeed Insights: failed');
      return { ok: false, message: ge.message, ...(ge.code === 'rate_limited' ? { rateLimited: true } : {}) };
    }
  }

  return {
    status, mapping, setMapping, clearMapping, testMapping,
    listGa4Properties: async (actor: Actor, accountId: string) => { await need(ctx, actor, 'google.manage'); try { return await core.listGa4Properties(accountId); } catch (e) { throw apiErrorOf(e); } },
    listGscSites: async (actor: Actor, accountId: string) => { await need(ctx, actor, 'google.manage'); try { return await core.listGscSites(accountId); } catch (e) { throw apiErrorOf(e); } },
    async saveClient(actor: Actor, input: Record<string, unknown>, origin?: string) { await need(ctx, actor, 'google.manage'); await core.saveClient(actor, input); return status(actor, origin); },
    async removeClient(actor: Actor) { await need(ctx, actor, 'google.manage'); await core.removeClient(actor); return status(actor); },
    async startOAuth(actor: Actor, input: { origin?: string; accountId?: string }) { await need(ctx, actor, 'google.manage'); return core.startOAuth(actor, { websiteId: (await site()).id, origin: input.origin, accountId: input.accountId }); },
    async testAccount(actor: Actor, id: string) { await need(ctx, actor, 'google.manage'); try { return await core.testAccount(actor, id); } catch (e) { throw apiErrorOf(e); } },
    async disconnectAccount(actor: Actor, id: string) { await need(ctx, actor, 'google.manage'); try { await core.disconnectAccount(actor, id); } catch (e) { throw apiErrorOf(e); } cache.clear(); return status(actor); },
    async savePsiKey(actor: Actor, key: unknown) {
      await need(ctx, actor, 'google.manage');
      const res = await core.savePsiKey(actor, key, `${(await site()).url}/`);
      await storeRun({ url: res.testUrl, strategy: 'mobile', at: iso(), trigger: 'test', ok: !res.run.runtimeError, performanceScore: res.run.performanceScore, lab: res.run.lab, ...(res.run.field ? { field: res.run.field } : {}) });
      return status(actor);
    },
    async removePsiKey(actor: Actor) { await need(ctx, actor, 'google.manage'); await core.removePsiKey(actor); return status(actor); },
    async testPsi(actor: Actor) { await need(ctx, actor, 'google.manage'); return testPsi(actor); },
    async testProduct(actor: Actor, product: GoogleProduct) { await need(ctx, actor, 'google.manage'); return testMapping(actor, product); },
    saveCwvSettings,
    async startCwv(actor: Actor) { if (!(await can(ctx, actor, 'google.manage'))) await need(ctx, actor, 'analytics.view'); return startCwv(actor); },
    async cwvReport(actor: Actor) { await need(ctx, actor, 'analytics.view'); return cwvReport(); },
    cwvTick, runCwv,
    ga4Report, gscReport, inspectUrl, historyPoints,
    overrideStatus, overrideTest,
    /** OAuth access token for the existing GA4 / Search Console data syncs (undefined = not mapped through an account). */
    async syncToken(product: GoogleProduct): Promise<string | undefined> {
      const s = await settingsOf(product);
      const acct = String(s.googleAccountId ?? '');
      if (!acct) return undefined;
      return core.accessToken(acct);
    },
    psiKey: () => core.psiKey(),
    catalogName: (id: IntegrationId) => INTEGRATION_CATALOG.find((x) => x.id === id)?.name ?? id,
  };
}
export type GoogleSiteService = ReturnType<typeof createGoogleSiteService>;
