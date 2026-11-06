/**
 * Google integrations end to end through the HTTP API against an in-memory Google (no network): the OAuth client
 * entered in the app (secret stored encrypted, never returned), Connect / Reconnect / Test / Disconnect of Google
 * accounts with single-use state, per-website GA4 and Search Console mapping, GA4 and Search Console reports with
 * comparison windows and stored history, URL inspection, expired access, PageSpeed Insights key and Core Web Vitals
 * (mobile + desktop, Good / Needs improvement / Poor, history, daily run), the existing data syncs using the account,
 * and who may do what.
 */
import pino from 'pino';
import supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CwvReport, Ga4Report, GoogleStatus, GscReport, IntegrationStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { runSync } from '../../src/sync';
import { parsePsi } from '../../src/google/psi';
import { windows } from '../../src/google/reports';
import { FIXTURE, failingFetch } from '../api/helpers';
import { ACCOUNT, CLIENT_ID, CLIENT_SECRET, createMockGoogle, GA4_PROPERTY, GSC_PROPERTY, PSI_KEY, REFRESH } from './mockGoogle';

const APP = 'https://sentinel.example';
const REDIRECT = `${APP}/api/google/oauth/callback`;
const SITE_ADMIN = { email: 'site.admin@example.com', password: '24681357' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const google = createMockGoogle({ redirectUri: REDIRECT });
  const lines: string[] = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => { lines.push(s); } });
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'true', SESSION_SECRET: 'google-test-secret-value-at-least-32-chars', LOG_LEVEL: 'debug', APP_BASE_URL: APP,
    SITE_ADMIN_EMAIL: SITE_ADMIN.email, SITE_ADMIN_INITIAL_PASSWORD: SITE_ADMIN.password,
  });
  const c = await createContainer({ env, log, fetchImpl: google.wrap(failingFetch) });
  const agent = supertest(createApp(c));
  const tokenOf = async (email: string, password = FIXTURE.password) => (await agent.post('/api/auth/login').send({ email, password })).body.token as string;
  const as = (tok: string) => ({
    get: (p: string) => agent.get(p).set({ Authorization: `Bearer ${tok}` }),
    post: (p: string, b: unknown = {}) => agent.post(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    put: (p: string, b: unknown = {}) => agent.put(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    del: (p: string) => agent.delete(p).set({ Authorization: `Bearer ${tok}` }),
  });
  return {
    c, google, lines, agent,
    superAdmin: as(await tokenOf(FIXTURE.admin)), admin: as(await tokenOf(SITE_ADMIN.email, SITE_ADMIN.password)), dev: as(await tokenOf(FIXTURE.developer)),
  };
}
type H = Awaited<ReturnType<typeof setup>>;

async function saveClient(h: H) {
  const r = await h.admin.put('/api/google/oauth-client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as GoogleStatus;
}
/** Starts sign-in and plays Google's redirect back with `code`. Returns the redirect target. */
async function connect(h: H, code = 'good-code', accountId?: string) {
  const start = await h.admin.post('/api/google/oauth/start', accountId ? { accountId } : {});
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
  const cb = await h.agent.get(`/api/google/oauth/callback?state=${state}&code=${code}&scope=x`);
  expect(cb.status).toBe(302);
  return { location: cb.headers.location as string, authorizeUrl: new URL(start.body.authorizeUrl), state };
}
const accountId = `acct:${ACCOUNT.sub}`;
const everything = (h: H) => JSON.stringify(h.lines) + JSON.stringify(h.c.repos.audit);

describe('Google OAuth client and accounts', () => {
  let h: H;
  beforeAll(async () => { h = await setup(); });

  it('saves the OAuth client from the app (secret encrypted, never returned) and shows the redirect URI to register', async () => {
    let st = (await h.admin.get('/api/google/status')).body as GoogleStatus;
    expect(st).toMatchObject({ canStore: true, oauth: { configured: false, secretSet: false, redirectUri: REDIRECT, appUrlSource: 'env' } });
    expect((await h.admin.put('/api/google/oauth-client', { clientId: 'not-a-client-id', clientSecret: CLIENT_SECRET })).status).toBe(400);
    expect((await h.admin.put('/api/google/oauth-client', { clientId: CLIENT_ID })).body.error?.message).toMatch(/Client secret/);
    st = await saveClient(h);
    expect(st.oauth).toMatchObject({ configured: true, clientId: CLIENT_ID, secretSet: true, source: 'saved', redirectUri: REDIRECT });
    expect(JSON.stringify(st)).not.toContain(CLIENT_SECRET);
    const doc = await h.c.repos.googleConnections.get('client');
    expect(JSON.stringify(doc)).not.toContain(CLIENT_SECRET);
    expect(doc?.sealed.clientSecret).toBeTruthy();
    // Saving again without the secret keeps it.
    expect((await h.admin.put('/api/google/oauth-client', { clientId: CLIENT_ID, clientSecret: '' })).body.oauth.secretSet).toBe(true);
  });

  it('connects a Google account with offline access and a single-use state; the refresh token is stored encrypted only', async () => {
    const { location, authorizeUrl, state } = await connect(h);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT, access_type: 'offline', prompt: 'consent', response_type: 'code' });
    expect(authorizeUrl.searchParams.get('scope')).toContain('analytics.readonly');
    expect(authorizeUrl.searchParams.get('scope')).toContain('webmasters.readonly');
    expect(location).toMatch(/^https:\/\/sentinel\.example\/settings\/integrations\?google=connected&account=seo\.owner%40deodap\.test/);
    // The state works once.
    expect((await h.agent.get(`/api/google/oauth/callback?state=${state}&code=good-code`)).headers.location).toMatch(/google=error&reason=bad_state/);
    expect((await h.agent.get('/api/google/oauth/callback?state=forged&code=good-code')).headers.location).toMatch(/reason=bad_state/);

    const st = (await h.admin.get('/api/google/status')).body as GoogleStatus;
    expect(st.accounts).toHaveLength(1);
    expect(st.accounts[0]).toMatchObject({ id: accountId, email: ACCOUNT.email, state: 'connected', products: ['ga4', 'gsc'] });
    const doc = await h.c.repos.googleConnections.get(accountId);
    expect(JSON.stringify(doc)).not.toContain(REFRESH);
    expect(JSON.stringify(st)).not.toContain(REFRESH);
    expect(everything(h)).not.toContain(REFRESH);
    expect(everything(h)).not.toContain(CLIENT_SECRET);
  });

  it('refuses a grant without Analytics or Search Console access, and Google’s “denied”', async () => {
    expect((await connect(h, 'no-scopes')).location).toMatch(/reason=missing_scopes/);
    const start = await h.admin.post('/api/google/oauth/start', {});
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    expect((await h.agent.get(`/api/google/oauth/callback?state=${state}&error=access_denied`)).headers.location).toMatch(/reason=denied/);
  });

  it('tests the account by listing the properties it can read', async () => {
    const r = await h.admin.post(`/api/google/accounts/${encodeURIComponent(accountId)}/test`);
    expect(r.body).toMatchObject({ ok: true });
    expect(r.body.message).toMatch(/Analytics: 2 properties visible; Search Console: 2 properties visible/);
    const props = (await h.admin.get(`/api/google/accounts/${encodeURIComponent(accountId)}/ga4-properties`)).body;
    expect(props[0]).toMatchObject({ propertyId: GA4_PROPERTY, displayName: 'DeoDap Web', accountName: 'DeoDap' });
    const sites = (await h.admin.get(`/api/google/accounts/${encodeURIComponent(accountId)}/gsc-sites`)).body;
    expect(sites).toEqual(expect.arrayContaining([expect.objectContaining({ siteUrl: GSC_PROPERTY, usable: true }), expect.objectContaining({ usable: false })]));
  });
});

describe('website mapping, reports and expiry', () => {
  let h: H;
  beforeAll(async () => { h = await setup(); await saveClient(h); await connect(h); });

  it('maps the website to a GA4 property and a Search Console property, tests them, and the integrations list follows', async () => {
    expect((await h.admin.put('/api/google/mapping/ga4', { accountId, property: '987654000' })).status).toBe(400); // not one of the account's properties
    expect((await h.admin.put('/api/google/mapping/ga4', { accountId, property: 'G-ABC123' })).body.error?.message).toMatch(/Measurement ID/);
    const ga = await h.admin.put('/api/google/mapping/ga4', { accountId, property: `properties/${GA4_PROPERTY}` });
    expect(ga.status, JSON.stringify(ga.body)).toBe(200);
    expect(ga.body.mapping).toMatchObject({ via: 'oauth', property: GA4_PROPERTY, propertyName: 'DeoDap Web (DeoDap)', state: 'connected', accountEmail: ACCOUNT.email });
    const gs = await h.admin.put('/api/google/mapping/gsc', { accountId, property: GSC_PROPERTY });
    expect(gs.body.mapping).toMatchObject({ via: 'oauth', property: GSC_PROPERTY, state: 'connected' });
    expect((await h.admin.put('/api/google/mapping/gsc', { accountId, property: 'https://other.test/' })).status).toBe(400);

    const list = (await h.superAdmin.get('/api/integrations')).body as IntegrationStatus[];
    expect(list.find((i) => i.id === 'gsc')).toMatchObject({ state: 'connected' });
    expect(list.find((i) => i.id === 'ga4')).toMatchObject({ state: 'connected', property: { value: GA4_PROPERTY } });
    // Re-test through the generic Test connection button works too.
    expect((await h.superAdmin.post('/api/integrations/gsc/test')).body.state).toBe('connected');
  });

  it('GA4 report: totals vs the previous period, daily trend, channels, sources, pages; cached; daily history stored', async () => {
    const r = await h.admin.get('/api/insights/ga4?range=28&compare=previous');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rep = r.body as Ga4Report;
    expect(rep).toMatchObject({ propertyId: GA4_PROPERTY, propertyName: 'DeoDap Web (DeoDap)', accountEmail: ACCOUNT.email, conversionMetric: 'keyEvents', cached: false });
    expect(rep.totals).toMatchObject({ activeUsers: 1000, sessions: 1500, engagementRate: 0.6, conversions: 42 });
    expect(rep.previous.activeUsers).toBe(800);
    expect(rep.daily).toHaveLength(28);
    expect(rep.channels.map((x) => x.name)).toEqual(['Organic Search', 'Direct', 'Paid Search']);
    expect(rep.sources[0].name).toBe('google / organic');
    expect(rep.pages[0].path).toBe('/');
    expect((await h.admin.get('/api/insights/ga4?range=28&compare=previous')).body.cached).toBe(true);
    expect((await h.admin.get('/api/insights/ga4?range=28&force=true')).body.cached).toBe(false);
    expect((await h.admin.get('/api/insights/ga4?range=30')).status).toBe(400);
    const yoy = (await h.admin.get('/api/insights/ga4?range=7&compare=year')).body as Ga4Report;
    expect(Date.parse(yoy.range.start) - Date.parse(yoy.compareRange.start)).toBe(364 * 86_400_000);
    const hist = (await h.admin.get('/api/insights/history?days=90')).body;
    expect(hist.length).toBeGreaterThanOrEqual(28);
    expect(hist.at(-1).ga4).toMatchObject({ sessions: expect.any(Number) });
  });

  it('Search Console report: clicks, impressions, CTR, position vs previous; queries, pages, countries, devices; sitemaps; URL inspection', async () => {
    const rep = (await h.admin.get('/api/insights/gsc?range=28')).body as GscReport;
    expect(rep.property).toBe(GSC_PROPERTY);
    expect(rep.totals).toMatchObject({ clicks: 500, impressions: 20000, ctr: 0.025, position: 12.3 });
    expect(rep.daily).toHaveLength(28);
    expect(rep.queries[0]).toMatchObject({ key: 'vegetable chopper', clicks: 100 });
    expect(rep.countries.map((x) => x.key)).toEqual(['ind', 'usa']);
    expect(rep.devices.map((x) => x.key)).toEqual(['MOBILE', 'DESKTOP', 'TABLET']);
    expect(rep.sitemaps[0]).toMatchObject({ path: 'https://deodap.test/sitemap.xml', errors: 1, contents: [{ type: 'web', submitted: 1200, indexed: 0 }] });
    // Search Console lags: the window ends two days ago (IST).
    expect(windows(h.c.clock(), 28, 'previous', 2).cur.end).toBe(rep.range.end);
    const ins = await h.admin.post('/api/insights/gsc/inspect', { url: 'https://deodap.test/products/vegetable-chopper' });
    expect(ins.body).toMatchObject({ verdict: 'PASS', coverageState: 'Submitted and indexed', crawledAs: 'MOBILE', mobileUsability: 'PASS' });
    expect((await h.admin.get('/api/insights/history?days=90')).body.filter((p: { gsc?: unknown }) => p.gsc)).toHaveLength(28);
  });

  it('refreshes an expired access token by itself, and asks to reconnect when Google revokes the account; Reconnect fixes it', async () => {
    h.google.expireAccessTokens();
    expect((await h.admin.get('/api/insights/gsc?range=7&force=true')).status).toBe(200);
    h.google.revokeRefresh();
    h.google.expireAccessTokens();
    const r = await h.admin.get('/api/insights/ga4?range=7&force=true');
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('GOOGLE_RECONNECT');
    let st = (await h.admin.get('/api/google/status')).body as GoogleStatus;
    expect(st.accounts[0].state).toBe('expired');
    expect(st.ga4.state).toBe('expired');
    expect((await h.superAdmin.get('/api/integrations')).body.find((i: IntegrationStatus) => i.id === 'ga4').state).toBe('connection_failed');

    h.google.restoreRefresh();
    const re = await connect(h, 'good-code', accountId);
    expect(re.authorizeUrl.searchParams.get('login_hint')).toBe(ACCOUNT.email);
    expect(re.location).toMatch(/google=connected/);
    st = (await h.admin.get('/api/google/status')).body as GoogleStatus;
    expect(st.accounts[0].state).toBe('connected');
    expect((await h.admin.get('/api/insights/ga4?range=7&force=true')).status).toBe(200);
  });

  it('rate limits are retried, then reported plainly', async () => {
    h.google.faults.push({ match: 'searchAnalytics/query', status: 429, times: 1 });
    expect((await h.admin.get('/api/insights/gsc?range=90&force=true')).status).toBe(200);
    h.google.faults.push({ match: 'batchRunReports', status: 429, times: 5 });
    const r = await h.admin.get('/api/insights/ga4?range=90&force=true');
    expect(r.status).toBe(429);
    expect(r.body.error?.message).toMatch(/rate limit or daily quota/);
    h.google.faults.splice(0);
  });

  it('the existing GA4 / Search Console data syncs use the mapped account', async () => {
    const before = h.google.requests.length;
    const res = await runSync(h.c.ctx, 'gsc', { fetchImpl: h.c.fetchImpl });
    expect(res, JSON.stringify(res)).toMatchObject({ ran: true, ok: true });
    const used = h.google.requests.slice(before).filter((x) => x.url.includes('searchAnalytics/query'));
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((x) => x.auth === 'Bearer [token]')).toBe(true);
  });

  it('disconnecting the account revokes it at Google and leaves the website’s mapping asking for another account', async () => {
    const r = await h.admin.del(`/api/google/accounts/${encodeURIComponent(accountId)}`);
    expect(r.status).toBe(200);
    expect(h.google.revokedTokens).toContain(REFRESH);
    const st = r.body as GoogleStatus;
    expect(st.accounts).toHaveLength(0);
    expect(st.ga4).toMatchObject({ via: 'oauth', state: 'failed' });
    expect((await h.admin.get('/api/insights/ga4')).status).toBe(409);
    expect((await h.admin.del('/api/google/mapping/ga4')).body).toMatchObject({ via: 'none', state: 'not_mapped' });
  });
});

describe('PageSpeed Insights and Core Web Vitals', () => {
  let h: H;
  beforeAll(async () => { h = await setup(); });

  it('parses lab and field data with Google’s thresholds (INP from field data, TBT in the lab)', () => {
    const p = parsePsi({
      loadingExperience: { id: 'https://x.test/', overall_category: 'SLOW', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4100, category: 'SLOW' }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 9, category: 'FAST' }, INTERACTION_TO_NEXT_PAINT: { percentile: 300, category: 'AVERAGE' } } },
      lighthouseResult: { categories: { performance: { score: 0.48 } }, audits: { 'largest-contentful-paint': { numericValue: 2400 }, 'cumulative-layout-shift': { numericValue: 0.26 }, 'total-blocking-time': { numericValue: 650 }, 'server-response-time': { numericValue: 1900 } } },
    });
    expect(p.performanceScore).toBe(48);
    expect(p.lab).toMatchObject({ LCP: { value: 2400, rating: 'good' }, CLS: { value: 0.26, rating: 'poor' }, TBT: { rating: 'poor' }, TTFB: { rating: 'poor' } });
    expect(p.lab.INP).toBeUndefined();
    expect(p.field).toMatchObject({ scope: 'url', overall: 'poor', metrics: { LCP: { value: 4100, rating: 'poor' }, CLS: { value: 0.09, rating: 'good' }, INP: { value: 300, rating: 'needs_improvement' } } });
  });

  it('refuses a key Google rejects, saves a working key encrypted after a real run, and never returns it', async () => {
    const bad = await h.admin.put('/api/google/psi-key', { apiKey: 'AIzaSyWRONG-key-000000000000000000000' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toMatch(/not saved: .*API key is not valid/);
    expect((await h.admin.get('/api/google/status')).body.psi.keySource).toBe('none');
    const ok = await h.admin.put('/api/google/psi-key', { apiKey: PSI_KEY });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.psi).toMatchObject({ connected: true, keySource: 'saved', lastTestOk: true });
    expect(JSON.stringify(ok.body)).not.toContain(PSI_KEY);
    expect(JSON.stringify(await h.c.repos.googleConnections.get('psi'))).not.toContain(PSI_KEY);
    expect(everything(h)).not.toContain(PSI_KEY);
    expect((await h.superAdmin.get('/api/integrations')).body.find((i: IntegrationStatus) => i.id === 'psi_crux').state).toBe('connected');
  });

  it('runs mobile and desktop tests in the background and reports LCP, INP, CLS, FCP, TTFB with ratings and history', async () => {
    expect((await h.admin.put('/api/google/cwv/settings', { urls: ['https://elsewhere.test/'], autoDaily: true })).status).toBe(400);
    const base = (await h.c.repos.config.get()).site.baseUrl.replace(/\/$/, '');
    const set = await h.admin.put('/api/google/cwv/settings', { urls: ['/', '/products/broken-page'], autoDaily: true });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.urls).toEqual([`${base}/`, `${base}/products/broken-page`]);
    const start = await h.admin.post('/api/insights/cwv/run');
    expect(start.body).toMatchObject({ started: true, tests: 4 });
    let rep: CwvReport;
    for (let i = 0; ; i++) { rep = (await h.admin.get('/api/insights/cwv')).body; if (!rep.running) break; if (i > 100) throw new Error('timeout'); await sleep(20); }
    const home = (s: string) => rep.latest.find((x) => x.url === `${base}/` && x.strategy === s)!;
    expect(home('mobile')).toMatchObject({ ok: true, performanceScore: 62, lab: { LCP: { rating: 'poor' }, CLS: { rating: 'needs_improvement' } }, field: { scope: 'url', overall: 'needs_improvement', metrics: { INP: { value: 180, rating: 'good' }, CLS: { value: 0.3, rating: 'poor' }, TTFB: { rating: 'needs_improvement' } } } });
    expect(home('desktop')).toMatchObject({ ok: true, performanceScore: 91, field: { overall: 'good' } });
    const broken = rep.latest.filter((x) => x.url.endsWith('broken-page'));
    expect(broken).toHaveLength(2);
    expect(broken[0]).toMatchObject({ ok: false });
    expect(broken[0].error).toMatch(/could not load/);
    expect(rep.history.length).toBeGreaterThanOrEqual(5); // the key test run + 4
  });

  it('the daily run happens once per day, and a rate limit is recorded with the reason', async () => {
    const before = (await h.c.repos.cwvRuns.list()).length;
    await h.c.services.google.cwvTick();
    const after = (await h.c.repos.cwvRuns.list()).length;
    expect(after - before).toBe(4);
    await h.c.services.google.cwvTick();
    expect((await h.c.repos.cwvRuns.list()).length).toBe(after);
    h.google.faults.push({ match: 'runPagespeed', status: 429, times: 20 });
    await h.c.services.google.runCwv('manual', ['mobile']);
    const last = (await h.admin.get('/api/insights/cwv')).body.latest.find((x: { strategy: string; url: string }) => x.strategy === 'mobile' && x.url.endsWith('/'));
    expect(last).toMatchObject({ ok: false });
    expect(last.error).toMatch(/rate limit/);
    h.google.faults.splice(0);
  });
});

describe('who may manage Google and see reports', () => {
  it('Admin and Super Admin manage connections; Developers see neither connections nor reports', async () => {
    const h = await setup();
    expect((await h.admin.get('/api/google/status')).status).toBe(200);
    expect((await h.superAdmin.get('/api/google/status')).status).toBe(200);
    expect((await h.dev.get('/api/google/status')).status).toBe(403);
    expect((await h.dev.put('/api/google/oauth-client', { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).status).toBe(403);
    expect((await h.dev.get('/api/insights/cwv')).status).toBe(403);
    expect((await h.admin.get('/api/insights/cwv')).status).toBe(200);
    // Without the OAuth client, Connect explains what is missing.
    const start = await h.admin.post('/api/google/oauth/start', {});
    expect(start.status).toBe(409);
    expect(start.body.error?.message).toMatch(/Client ID/);
  });
});
