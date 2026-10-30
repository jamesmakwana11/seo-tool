import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ShopifyStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp, indexHtmlFor, publicBasePath } from '../../src/http/app';
import { signQuery } from '../../src/shopify/oauth';
import { FIXTURE } from '../api/helpers';
import { API_KEY, API_SECRET, createMockShopify, SHOP, STOREFRONT, TOKEN } from './mockShopify';

/**
 * "Connect with Shopify" end to end for the deployment at https://apps.deodap.info/seo-tool (mock Shopify, no network):
 * the button's start endpoint, the authorize redirect with the registered callback URL, the callback reached under the
 * /seo-tool prefix (proxy stripping it or not), HMAC + single-use state + shop checks, scopes, the token exchange, the
 * token kept server-side, the return to the app, and clear errors when the server or app setup is incomplete.
 */
const CALLBACK = 'https://apps.deodap.info/seo-tool/api/shopify/oauth/callback';
const ts = () => String(Math.floor(Date.now() / 1000));

async function setup(env: Record<string, string>, webDist?: string) {
  const mock = createMockShopify();
  const logs: string[] = [];
  const log = pino({ level: 'debug' }, new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } }));
  const container = await createContainer({
    env: loadEnv({ NODE_ENV: 'test', SEED_TEST_FIXTURES: 'true', SESSION_SECRET: 'shopify-subpath-secret-at-least-32-chars!', LOG_LEVEL: 'debug', CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true', ...(webDist ? { WEB_DIST_DIR: webDist } : {}), ...env }),
    fetchImpl: mock.fetchImpl, log: log as never,
  });
  const agent = supertest(createApp(container));
  const bodies: string[] = [];
  const token = (await agent.post('/api/auth/login').send({ email: FIXTURE.admin, password: FIXTURE.password })).body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  const rec = <T extends { text?: string; headers: Record<string, string> }>(r: T) => { bodies.push(r.text ?? '', JSON.stringify(r.headers)); return r; };
  return {
    mock, logs, bodies, agent,
    get: async (p: string) => rec(await agent.get(p).set(auth)),
    post: async (p: string, b: unknown = {}) => rec(await agent.post(p).set(auth).send(b as object)),
    callback: async (p: string, q: Record<string, string>) => rec(await agent.get(p).query({ ...q, hmac: signQuery(q, API_SECRET) }).redirects(0)),
  };
}

describe('Shopify OAuth at https://apps.deodap.info/seo-tool', () => {
  const OAUTH = { SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET, APP_BASE_URL: 'https://apps.deodap.info/seo-tool' };

  it('uses the registered callback URL and completes through the /seo-tool prefix', async () => {
    const h = await setup(OAUTH);
    const st = (await h.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st).toMatchObject({ connected: false, oauthConfigured: true, redirectUrl: CALLBACK });
    expect(st.problems).toEqual([]);

    // The button → POST /api/shopify/oauth/start (also reachable as /seo-tool/api/…) → Shopify authorize URL.
    const start = await h.post('/seo-tool/api/shopify/oauth/start', { shop: 'sentinel-test' });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const u = new URL(start.body.authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(u.searchParams.get('client_id')).toBe(API_KEY);
    expect(u.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(u.searchParams.get('scope')!.split(',')).toEqual(expect.arrayContaining(['read_products', 'write_products', 'read_content', 'write_content']));
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{48}$/);

    // Shopify redirects the browser to the callback with the path as registered (proxy did not strip /seo-tool).
    const q = { code: 'good-code', shop: SHOP, state, timestamp: ts(), host: 'aG9zdA' };
    const back = await h.callback('/seo-tool/api/shopify/oauth/callback', q);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe('https://apps.deodap.info/seo-tool/settings/shopify?shopify=connected');
    const after = (await h.get('/api/shopify/status')).body as ShopifyStatus;
    expect(after).toMatchObject({ connected: true, via: 'oauth', shop: SHOP, missingScopes: [] });
    expect(after.capabilities.edit).toBe(true);
    // The state is single use.
    expect((await h.callback('/seo-tool/api/shopify/oauth/callback', q)).headers.location).toMatch(/reason=bad_state/);
    // The token / secret / code never reach a response or a log line.
    const all = h.bodies.join('\n') + h.logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(API_SECRET);
    expect(h.logs.join('\n')).not.toContain('good-code');
  });

  it('also works when the reverse proxy strips /seo-tool', async () => {
    const h = await setup(OAUTH);
    const start = await h.post('/api/shopify/oauth/start', { shop: SHOP });
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const back = await h.callback('/api/shopify/oauth/callback', { code: 'good-code', shop: SHOP, state, timestamp: ts() });
    expect(back.headers.location).toBe('https://apps.deodap.info/seo-tool/settings/shopify?shopify=connected');
  });

  it('rejects a forged callback (bad HMAC, other shop) and a non-myshopify store domain', async () => {
    const h = await setup(OAUTH);
    expect((await h.post('/api/shopify/oauth/start', { shop: 'deodap.in' })).body.error.message).toMatch(/\.myshopify\.com domain/);
    const start = await h.post('/api/shopify/oauth/start', { shop: SHOP });
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const forged = await h.agent.get('/seo-tool/api/shopify/oauth/callback').query({ code: 'good-code', shop: SHOP, state, timestamp: ts(), hmac: 'a'.repeat(64) }).redirects(0);
    expect(forged.headers.location).toMatch(/reason=bad_hmac/);
    expect((await h.callback('/seo-tool/api/shopify/oauth/callback', { code: 'good-code', shop: 'evil-shop.myshopify.com', state, timestamp: ts() })).headers.location).toMatch(/reason=(bad_state|shop_mismatch)/);
    expect(((await h.get('/api/shopify/status')).body as ShopifyStatus).connected).toBe(false);
  });
});

describe('clear errors instead of a button that does nothing', () => {
  it('missing app credentials: says which settings and the exact callback URL to register', async () => {
    const h = await setup({ APP_BASE_URL: 'https://apps.deodap.info/seo-tool' });
    const st = (await h.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st.oauthConfigured).toBe(false);
    expect(st.problems[0]).toMatch(/enter the Client ID and the Client secret under “Shopify app credentials”/);
    expect(st.problems[0]).toContain(CALLBACK);
    const start = await h.post('/api/shopify/oauth/start', { shop: SHOP });
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('SHOPIFY_OAUTH_NOT_CONFIGURED');
    expect(start.body.error.message).toMatch(/Client ID/);
  });

  it('missing APP_BASE_URL, or SHOPIFY_SCOPES without the required scopes, are reported', async () => {
    const noUrl = await setup({ SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET });
    expect(((await noUrl.get('/api/shopify/status')).body as ShopifyStatus).problems[0]).toMatch(/the app URL/);
    const scopes = await setup({ SHOPIFY_API_KEY: API_KEY, SHOPIFY_API_SECRET: API_SECRET, APP_BASE_URL: 'https://apps.deodap.info/seo-tool', SHOPIFY_SCOPES: 'read_products' });
    const st = (await scopes.get('/api/shopify/status')).body as ShopifyStatus;
    expect(st.oauthConfigured).toBe(false);
    expect(st.problems[0]).toMatch(/SHOPIFY_SCOPES leaves out write_products, read_content, write_content/);
  });
});

describe('the web app under the sub-path', () => {
  it('derives the base path from APP_BASE_URL', () => {
    expect(publicBasePath({ APP_BASE_URL: 'https://apps.deodap.info/seo-tool' })).toBe('/seo-tool');
    expect(publicBasePath({ APP_BASE_URL: 'https://apps.deodap.info/seo-tool/' })).toBe('/seo-tool');
    expect(publicBasePath({ APP_BASE_URL: 'https://sentinel.example' })).toBe('');
    expect(publicBasePath({ APP_BASE_URL: undefined })).toBe('');
    expect(indexHtmlFor('<html><head>\n<base href="/" /><title>x</title></head></html>', '/seo-tool')).toBe('<html><head><base href="/seo-tool/"><meta name="sentinel-base-path" content="/seo-tool">\n<title>x</title></head></html>');
  });

  it('serves index.html with the base path and the assets under /seo-tool', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><base href="/" /><script type="module" src="./assets/app-abc.js"></script></head><body><div id="root"></div></body></html>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
    const h = await setup({ APP_BASE_URL: 'https://apps.deodap.info/seo-tool' }, dir);
    const page = await h.agent.get('/seo-tool/settings/shopify?shopify=connected').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<base href="/seo-tool/">');
    expect(page.text).toContain('<meta name="sentinel-base-path" content="/seo-tool">');
    expect(page.text).not.toContain('<base href="/" />');
    expect((await h.agent.get('/seo-tool/assets/app-abc.js')).status).toBe(200);
    expect((await h.agent.get('/assets/app-abc.js')).status).toBe(200); // proxy that strips the prefix
    expect((await h.agent.get('/seo-tool/healthz')).body).toEqual({ ok: true });
    // At the root nothing changes.
    const root = await setup({ APP_BASE_URL: 'https://sentinel.example' }, dir);
    const rp = await root.agent.get('/settings/shopify').set('Accept', 'text/html');
    expect(rp.text).toContain('<base href="/">');
    expect(rp.text).toContain('<meta name="sentinel-base-path" content="">');
  });
});
