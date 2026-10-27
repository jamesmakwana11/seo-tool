import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRAWLER_USER_AGENT, normalizeGa4PropertyId, normalizeGscProperty } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { GOOGLE_TOKEN_URL } from '../../src/connectors/googleAuth';
import { crawlerUserAgent } from '../../src/connectors/connectors';
import { ga4Tiers, gscSearch } from '../../src/sync';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { expectNoSecrets, json, mockFetch, serviceAccountJson, text, type Responder } from './helpers';

/**
 * Site crawler without CRAWLER_USER_AGENT, and the GSC property / GA4 property ID saved from the Integrations screen:
 * validated, used by the real connection test and by the data syncs, never "connected" without a passed test, and
 * honest about a missing service-account key. Network is mocked (no Google request leaves the machine).
 */
const SA_EMAIL = 'sentinel@deodap-seo.iam.gserviceaccount.com';
const BASE = { NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'g'.repeat(40), LOG_LEVEL: 'silent' };
const sites: FixtureSite[] = [];
afterEach(async () => { for (const s of sites.splice(0)) await s.close(); });

async function make(env: Record<string, string>, responder: Responder) {
  const fetchImpl = mockFetch(responder);
  const c: Container = await createContainer({ env: loadEnv({ ...BASE, ...env }), fetchImpl });
  return { c, fetchImpl, reg: c.ctx.integrations };
}

const tokenOk = () => json(200, { access_token: 'ya29.TEST-ACCESS-TOKEN', expires_in: 3600, token_type: 'Bearer' });

describe('Site crawler without CRAWLER_USER_AGENT', () => {
  it('uses the built-in User-Agent and does not report it as missing', async () => {
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: undefined })).toBe(DEFAULT_CRAWLER_USER_AGENT);
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: '  ' })).toBe(DEFAULT_CRAWLER_USER_AGENT);
    expect(crawlerUserAgent({ CRAWLER_USER_AGENT: 'MyBot/2.0' })).toBe('MyBot/2.0');

    const { reg, fetchImpl } = await make({ CRAWLER_BASE_URL: 'https://shop.example', CRAWLER_ALLOW_LIVE: 'true' }, () => text(200, 'User-agent: *\nDisallow: /cart\n'));
    let s = await reg.status('crawler');
    expect(s.state).toBe('not_configured'); // configured, not yet tested — never "credentials missing"
    expect(s.stateDetail).not.toMatch(/Missing/);
    expect(s.optionalVars).toEqual(['CRAWLER_USER_AGENT']);
    s = await reg.test('crawler');
    expect(s.state).toBe('connected');
    expect(s.lastTestResult).toMatch(/built-in default/);
    expect(fetchImpl.calls[0].url).toBe('https://shop.example/robots.txt');
    expect(fetchImpl.calls[0].headers['user-agent']).toBe(DEFAULT_CRAWLER_USER_AGENT);
  });

  it('still reports the genuinely required settings', async () => {
    const { reg } = await make({ CRAWLER_BASE_URL: 'https://shop.example' }, () => text(200, ''));
    const s = await reg.status('crawler');
    expect(s.state).toBe('credentials_missing');
    expect(s.stateDetail).toMatch(/CRAWLER_ALLOW_LIVE/);
    expect(s.stateDetail).not.toMatch(/CRAWLER_USER_AGENT/);
  });

  it('a real crawl sends the default User-Agent (rate limits, robots and host rules unchanged)', async () => {
    const site = await startFixtureSite({ slowMs: 10 });
    sites.push(site);
    const c = await createContainer({ env: loadEnv({ ...BASE, CRAWLER_BASE_URL: site.origin, CRAWLER_ENGINE: 'node', CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0' }) });
    const run = await c.services.crawls.startManual({ id: 'sys', name: 'System', role: 'admin', teamIds: [], permissions: ['crawls.run'], demo: false } as never, 'full', { startUrl: site.url, maxPages: 5, maxDepth: null, timeoutMs: 10000, concurrency: 1 });
    await c.services.crawls.idle();
    expect((await c.repos.crawls.get(run.id))!.status).toBe('completed');
    expect(site.requests.length).toBeGreaterThan(1);
    // Every page / robots / sitemap request identifies as Sentinel; the only other agents are the existing bot-access
    // probes (Googlebot, Bingbot, AI crawlers), which deliberately use those engines' own User-Agents.
    const own = site.requests.filter((r) => r.ua === DEFAULT_CRAWLER_USER_AGENT);
    expect(own.some((r) => r.path === '/robots.txt')).toBe(true);
    expect(own.filter((r) => r.path.startsWith('/products/') || r.path.startsWith('/collections/')).length).toBeGreaterThan(0);
    for (const r of site.requests) expect(r.ua === DEFAULT_CRAWLER_USER_AGENT || /Googlebot|bingbot|GPTBot|PerplexityBot|CCBot/.test(r.ua), r.ua).toBe(true);
  });
});

describe('property formats', () => {
  it('Search Console: Domain and URL-prefix properties', () => {
    expect(normalizeGscProperty('sc-domain:DeoDap.in')).toEqual({ ok: true, value: 'sc-domain:deodap.in' });
    expect(normalizeGscProperty('https://www.deodap.in')).toEqual({ ok: true, value: 'https://www.deodap.in/' });
    expect(normalizeGscProperty('https://deodap.in/blogs/')).toEqual({ ok: true, value: 'https://deodap.in/blogs/' });
    const bare = normalizeGscProperty('deodap.in');
    expect(bare.ok).toBe(false);
    expect(!bare.ok && bare.error).toMatch(/sc-domain:deodap\.in.*https:\/\/deodap\.in\//);
    for (const bad of ['', 'sc-domain:', 'sc-domain:not a domain', 'ftp://deodap.in/', 'https://deodap.in/?x=1', 'https://user:pw@deodap.in/']) expect(normalizeGscProperty(bad).ok, bad).toBe(false);
  });

  it('GA4: numeric property ID only (Measurement IDs refused)', () => {
    expect(normalizeGa4PropertyId('123456789')).toEqual({ ok: true, value: '123456789' });
    expect(normalizeGa4PropertyId('properties/987654321')).toEqual({ ok: true, value: '987654321' });
    const mid = normalizeGa4PropertyId('G-ABC123XYZ');
    expect(!mid.ok && mid.error).toMatch(/Measurement ID/);
    for (const bad of ['', 'UA-1234-1', 'abc', '12']) expect(normalizeGa4PropertyId(bad).ok, bad).toBe(false);
  });
});

describe('Google Search Console: property saved on the Integrations screen', () => {
  const sites = (entries: { siteUrl: string; permissionLevel: string }[]): Responder => (url) => (url === GOOGLE_TOKEN_URL ? tokenOk() : url === 'https://www.googleapis.com/webmasters/v3/sites' ? json(200, { siteEntry: entries }) : json(200, { rows: [] }));

  it('is validated, saved, used by the real connection test and by the data sync', async () => {
    const { c, reg, fetchImpl } = await make({ GSC_SERVICE_ACCOUNT_JSON: serviceAccountJson(SA_EMAIL) }, sites([{ siteUrl: 'sc-domain:deodap.in', permissionLevel: 'siteOwner' }]));
    let s = await reg.status('gsc');
    expect(s.state).toBe('credentials_missing');
    expect(s.stateDetail).toMatch(/property field/);
    expect(s.property).toMatchObject({ envVar: 'GSC_PROPERTY', source: 'none' });

    await expect(reg.updateSettings('gsc', { property: 'deodap.in' })).rejects.toThrow(/sc-domain:deodap\.in/);
    s = await reg.updateSettings('gsc', { property: 'sc-domain:DEODAP.in' });
    expect(s.settings.property).toBe('sc-domain:deodap.in');
    expect(s.property).toMatchObject({ value: 'sc-domain:deodap.in', source: 'saved' });
    expect(s.state).toBe('not_configured'); // saved, but never claimed connected before a passed test
    expect(await reg.isConnected('gsc')).toBe(false);

    s = await reg.test('gsc');
    expect(s.state, s.stateDetail).toBe('connected');
    expect(s.lastTestResult).toMatch(/sc-domain:deodap\.in accessible with Owner/);
    expect(fetchImpl.calls.some((x) => x.url === GOOGLE_TOKEN_URL)).toBe(true);

    // The sync queries exactly the saved property.
    fetchImpl.calls.length = 0;
    const r = await gscSearch(c.ctx, { fetchImpl });
    expect(r.ran).toBe(true);
    const q = fetchImpl.calls.filter((x) => x.url.includes('/searchAnalytics/query'));
    expect(q.length).toBeGreaterThan(0);
    for (const x of q) expect(x.url).toBe(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent('sc-domain:deodap.in')}/searchAnalytics/query`);
  });

  it('a changed property is not "connected" until it passes its own test; no access is reported plainly', async () => {
    const { reg } = await make({ GSC_SERVICE_ACCOUNT_JSON: serviceAccountJson(SA_EMAIL) }, sites([{ siteUrl: 'sc-domain:deodap.in', permissionLevel: 'siteOwner' }]));
    await reg.updateSettings('gsc', { property: 'sc-domain:deodap.in' });
    expect((await reg.test('gsc')).state).toBe('connected');
    let s = await reg.updateSettings('gsc', { property: 'https://grabnix.in/' });
    expect(s.state).toBe('not_configured');
    expect(s.stateDetail).toMatch(/property changed/);
    expect(await reg.isConnected('gsc')).toBe(false);
    s = await reg.test('gsc');
    expect(s.state).toBe('connection_failed');
    expect(s.stateDetail).toMatch(new RegExp(`https://grabnix\\.in/ is not visible.*add ${SA_EMAIL.replace(/\./g, '\\.')} as an Owner`));
  });

  it('the property alone is not enough: without the service-account key nothing is called and the card says so', async () => {
    const { reg, fetchImpl } = await make({}, sites([]));
    await reg.updateSettings('gsc', { property: 'sc-domain:deodap.in' });
    const s = await reg.test('gsc');
    expect(s.state).toBe('credentials_missing');
    expect(s.stateDetail).toMatch(/GSC_SERVICE_ACCOUNT_JSON/);
    expect(s.stateDetail).toMatch(/service-account key/);
    expect(fetchImpl.calls).toEqual([]);
    expect(await reg.isConnected('gsc')).toBe(false);
  });

  it('a saved property replaces GSC_PROPERTY for this website; clearing it falls back to the env var', async () => {
    const { reg } = await make({ GSC_SERVICE_ACCOUNT_JSON: serviceAccountJson(SA_EMAIL), GSC_PROPERTY: 'https://deodap.in/' }, sites([{ siteUrl: 'https://deodap.in/', permissionLevel: 'siteOwner' }]));
    expect((await reg.status('gsc')).property).toMatchObject({ value: 'https://deodap.in/', source: 'env' });
    expect((await reg.updateSettings('gsc', { property: 'sc-domain:deodap.in' })).property).toMatchObject({ source: 'saved' });
    expect((await reg.updateSettings('gsc', { property: '' })).property).toMatchObject({ value: 'https://deodap.in/', source: 'env' });
  });
});

describe('Google Analytics 4: property ID saved on the Integrations screen', () => {
  it('is validated, saved and used by the connection test (Data API) and by the sync', async () => {
    let answer = (): Response => json(403, { error: { code: 403, message: 'User does not have sufficient permissions for this property.', status: 'PERMISSION_DENIED' } });
    const { c, reg, fetchImpl } = await make({ GA4_SERVICE_ACCOUNT_JSON: serviceAccountJson(SA_EMAIL) }, (url) => (url === GOOGLE_TOKEN_URL ? tokenOk() : answer()));
    await expect(reg.updateSettings('ga4', { propertyId: 'G-ABC123XYZ' })).rejects.toThrow(/Measurement ID/);
    let s = await reg.updateSettings('ga4', { propertyId: 'properties/123456789' });
    expect(s.settings.propertyId).toBe('123456789');

    // No access → plain instruction, not connected.
    s = await reg.test('ga4');
    expect(s.state).toBe('connection_failed');
    expect(s.stateDetail).toMatch(new RegExp(`add ${SA_EMAIL.replace(/\./g, '\\.')} as Viewer`));
    const call = fetchImpl.calls.find((x) => x.url.includes('analyticsdata'))!;
    expect(call.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport');
    expect(call.init?.method).toBe('POST');

    // API not enabled → says which API to enable.
    answer = () => json(403, { error: { code: 403, message: 'Google Analytics Data API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED' } });
    expect((await reg.test('ga4')).stateDetail).toMatch(/Data API is not enabled/);

    // Access granted → connected, and the sync reports on the saved property.
    answer = () => json(200, { rowCount: 0, rows: [] });
    s = await reg.test('ga4');
    expect(s.state, s.stateDetail).toBe('connected');
    fetchImpl.calls.length = 0;
    const r = await ga4Tiers(c.ctx, { fetchImpl });
    expect(r.ran).toBe(true);
    expect(fetchImpl.calls.filter((x) => x.url.includes('analyticsdata')).every((x) => x.url === 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport')).toBe(true);
    expectNoSecrets(JSON.stringify(await reg.list()));
  });

  it('missing key: clearly reported, nothing called', async () => {
    const { reg, fetchImpl } = await make({}, () => json(200, {}));
    const s = await reg.updateSettings('ga4', { propertyId: '123456789' });
    expect(s.state).toBe('credentials_missing');
    expect(s.stateDetail).toMatch(/GA4_SERVICE_ACCOUNT_JSON/);
    expect((await reg.test('ga4')).state).toBe('credentials_missing');
    expect(fetchImpl.calls).toEqual([]);
  });

  it('secrets still cannot be saved as settings', async () => {
    const { reg } = await make({}, () => json(200, {}));
    await expect(reg.updateSettings('ga4', { private_key: 'x' })).rejects.toThrow(/Secrets cannot be stored/);
  });
});
