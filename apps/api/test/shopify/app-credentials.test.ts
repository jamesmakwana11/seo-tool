import { Writable } from 'node:stream';
import pino from 'pino';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ShopifyStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { createSecretBox } from '../../src/security/secretBox';
import { signQuery } from '../../src/shopify/oauth';
import { API_KEY, API_SECRET, createMockShopify, SHOP, STOREFRONT, TOKEN } from './mockShopify';

/**
 * "Connect with Shopify" with the app credentials entered in Settings → Shopify instead of server environment
 * variables (mock Shopify, no network): validation, the Client secret and the access token stored encrypted and never
 * returned, OAuth (start → authorize URL → callback HMAC with the saved secret → state → token exchange), the
 * /seo-tool sub-path taken from the saved app URL, restore after a restart, and a changed key reported plainly.
 */
const CALLBACK = 'https://apps.deodap.info/seo-tool/api/shopify/oauth/callback';
const APP_URL = 'https://apps.deodap.info/seo-tool';
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const ts = () => String(Math.floor(Date.now() / 1000));

async function boot(opts: { repos?: Container['repos']; secret?: string; env?: Record<string, string> } = {}) {
  const mock = createMockShopify();
  const logs: string[] = [];
  const log = pino({ level: 'debug' }, new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } }));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: opts.secret ?? 'session-secret-for-shopify-credentials-test', LOG_LEVEL: 'debug',
    ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true', ...opts.env,
  });
  const container = await createContainer({ env, fetchImpl: mock.fetchImpl, log: log as never, ...(opts.repos ? { repos: opts.repos } : {}) });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const agent = supertest(app);
  const bodies: string[] = [];
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  const rec = <T extends { text?: string; headers: Record<string, string> }>(r: T) => { bodies.push(r.text ?? '', JSON.stringify(r.headers)); return r; };
  return {
    container, mock, logs, bodies, agent,
    status: async () => rec(await agent.get('/api/shopify/status').set(auth)).body as ShopifyStatus,
    // As forwarded by a proxy that strips /seo-tool (before an app URL is known, a prefixed path cannot be recognised).
    put: async (b: unknown) => rec(await agent.put('/api/shopify/app-credentials').set(auth).send(b as object)),
    del: async () => rec(await agent.delete('/api/shopify/app-credentials').set(auth)),
    post: async (p: string, b: unknown = {}) => rec(await agent.post(p).set(auth).send(b as object)),
    callback: async (q: Record<string, string>, secret = API_SECRET) => rec(await agent.get('/seo-tool/api/shopify/oauth/callback').query({ ...q, hmac: signQuery(q, secret) }).redirects(0)),
  };
}
type Boot = Awaited<ReturnType<typeof boot>>;

async function connect(h: Boot) {
  const start = await h.post('/seo-tool/api/shopify/oauth/start', { shop: 'sentinel-test' });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const u = new URL(start.body.authorizeUrl);
  return { u, state: u.searchParams.get('state')! };
}

describe('Shopify app credentials entered in Sentinel', () => {
  it('saves them (secret encrypted, never returned) and completes OAuth end to end with them', async () => {
    const h = await boot();
    // Nothing configured: the page says what to enter, the button cannot start.
    let st = await h.status();
    expect(st.oauthConfigured).toBe(false);
    expect(st.appCredentials).toMatchObject({ source: 'none', secretSet: false, canStore: true });
    expect(st.problems[0]).toMatch(/enter the Client ID, the Client secret and the app URL/);
    expect((await h.post('/api/shopify/oauth/start', { shop: SHOP })).status).toBe(409);

    // Validation with field messages.
    const bad = await h.put({ clientId: 'short', clientSecret: '', appUrl: `${APP_URL}/api/shopify/oauth/callback` });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.details.fields).sort()).toEqual(['appUrl', 'clientId', 'clientSecret']);
    expect(bad.body.error.details.fields.appUrl).toMatch(/not the callback URL/);

    // Save.
    const saved = await h.put({ clientId: API_KEY, clientSecret: API_SECRET, appUrl: `${APP_URL}/` });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    st = saved.body as ShopifyStatus;
    expect(st).toMatchObject({ oauthConfigured: true, redirectUrl: CALLBACK, problems: [] });
    expect(st.appCredentials).toMatchObject({ source: 'saved', clientId: API_KEY, secretSet: true, appUrl: APP_URL, appUrlSource: 'saved', updatedBy: 'Administrator' });
    // Stored: Client ID plain, secret only as AES-GCM ciphertext.
    const doc = (await h.container.repos.integrationSecrets.get('shopify'))!;
    expect(doc.plain).toEqual({ clientId: API_KEY, appUrl: APP_URL });
    expect(doc.sealed.clientSecret).toMatchObject({ v: 1 });
    expect(JSON.stringify(doc)).not.toContain(API_SECRET);
    expect(JSON.stringify(doc)).not.toContain(Buffer.from(API_SECRET).toString('base64'));

    // Start → Shopify authorize URL with the saved Client ID and the registered callback (the /seo-tool prefix comes
    // from the saved app URL — APP_BASE_URL is not set on this server).
    const { u, state } = await connect(h);
    expect(`${u.origin}${u.pathname}`).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(u.searchParams.get('client_id')).toBe(API_KEY);
    expect(u.searchParams.get('redirect_uri')).toBe(CALLBACK);

    // A callback signed with another secret is refused (and does not use up the state).
    const forged = await h.callback({ code: 'good-code', shop: SHOP, state, timestamp: ts() }, 'not-the-app-secret-0000000000');
    expect(forged.headers.location).toBe(`${APP_URL}/settings/shopify?shopify=error&reason=bad_hmac`);
    // The real callback: HMAC with the saved secret, state, shop, timestamp, code → token exchange → connected.
    const q = { code: 'good-code', shop: SHOP, state, timestamp: ts(), host: 'aG9zdA' };
    const ok = await h.callback(q);
    expect(ok.headers.location).toBe(`${APP_URL}/settings/shopify?shopify=connected`);
    expect((await h.callback(q)).headers.location).toMatch(/reason=bad_state/); // single use
    st = await h.status();
    expect(st).toMatchObject({ connected: true, via: 'oauth', shop: SHOP, shopName: 'DeoDap Test', missingScopes: [] });
    expect(st.capabilities.edit).toBe(true);
    expect(st.tokenNote).toMatch(/stored encrypted/);
    // The token is stored encrypted too.
    const after = (await h.container.repos.integrationSecrets.get('shopify'))!;
    expect(after.sealed.accessToken).toMatchObject({ v: 1 });
    expect(after.meta).toMatchObject({ shop: SHOP });
    expect(JSON.stringify(after)).not.toContain(TOKEN);
    // The SEO editor works through the connection.
    expect((await h.post('/api/shopify/drafts', { url: `${STOREFRONT}/products/vegetable-chopper` })).status).toBe(201);

    // Never in a response, a log line or the audit log.
    const audit = JSON.stringify(await h.container.repos.audit.list());
    for (const v of [API_SECRET, TOKEN]) {
      expect(h.bodies.join('\n'), v).not.toContain(v);
      expect(h.logs.join('\n'), v).not.toContain(v);
      expect(audit, v).not.toContain(v);
    }
    expect(h.logs.join('\n')).not.toContain('good-code');
  });

  it('keeps the saved secret when left empty, refuses a new Client ID without its secret, and can be removed', async () => {
    const h = await boot();
    expect((await h.put({ clientId: API_KEY, clientSecret: API_SECRET, appUrl: APP_URL })).status).toBe(200);
    const kept = await h.put({ clientId: API_KEY, clientSecret: '', appUrl: APP_URL });
    expect(kept.status).toBe(200);
    expect((kept.body as ShopifyStatus).appCredentials?.secretSet).toBe(true);
    const other = await h.put({ clientId: 'abcdef0123456789abcdef0123456789', clientSecret: '', appUrl: APP_URL });
    expect(other.status).toBe(400);
    expect(other.body.error.details.fields.clientSecret).toBeTruthy();
    const removed = await h.del();
    expect((removed.body as ShopifyStatus).appCredentials).toMatchObject({ source: 'none', secretSet: false });
    expect((removed.body as ShopifyStatus).oauthConfigured).toBe(false);
    expect((await h.container.repos.integrationSecrets.get('shopify'))!.sealed.clientSecret).toBeUndefined();
  });

  it('survives a restart (same data), and a changed encryption key is reported instead of failing silently', async () => {
    const a = await boot();
    await a.put({ clientId: API_KEY, clientSecret: API_SECRET, appUrl: APP_URL });
    const { state } = await connect(a);
    await a.callback({ code: 'good-code', shop: SHOP, state, timestamp: ts() });
    expect((await a.status()).connected).toBe(true);

    // Restart with the same key: credentials and the connection are back, no reconnect needed.
    const b = await boot({ repos: a.container.repos });
    const st = await b.status();
    expect(st).toMatchObject({ connected: true, via: 'oauth', shop: SHOP, oauthConfigured: true });
    expect(st.appCredentials).toMatchObject({ source: 'saved', secretSet: true });

    // Restart with another SESSION_SECRET: nothing decrypts, and the page says what to do.
    const c = await boot({ repos: a.container.repos, secret: 'a-different-session-secret-value-0000000' });
    const sc = await c.status();
    expect(sc.connected).toBe(false);
    expect(sc.oauthConfigured).toBe(false);
    expect(sc.problems[0]).toMatch(/Client secret could not be decrypted — SESSION_SECRET changed.*Enter the Client secret again and connect the store again/);
    expect(sc.problems.join(' ')).toMatch(/connection to sentinel-test\.myshopify\.com could not be decrypted.*Connect the store again/);
    // Entering the secret again fixes it.
    expect((await c.put({ clientId: API_KEY, clientSecret: API_SECRET, appUrl: APP_URL })).status).toBe(200);
    const fixed = await c.status();
    expect(fixed.oauthConfigured).toBe(true);
    expect(fixed.problems).toEqual([]);
    const again = await connect(c);
    await c.callback({ code: 'good-code', shop: SHOP, state: again.state, timestamp: ts() });
    expect((await c.status()).connected).toBe(true);
  });

  it('disconnect removes the stored token', async () => {
    const h = await boot();
    await h.put({ clientId: API_KEY, clientSecret: API_SECRET, appUrl: APP_URL });
    const { state } = await connect(h);
    await h.callback({ code: 'good-code', shop: SHOP, state, timestamp: ts() });
    await h.post('/api/shopify/disconnect');
    expect((await h.container.repos.integrationSecrets.get('shopify'))!.sealed.accessToken).toBeUndefined();
    expect((await h.status()).connected).toBe(false);
  });

  it('the env variables still work, and saved credentials take precedence for the website', async () => {
    const h = await boot({ env: { SHOPIFY_API_KEY: 'env-client-id-000000000000', SHOPIFY_API_SECRET: 'env-client-secret-000000000', APP_BASE_URL: APP_URL } });
    expect((await h.status()).appCredentials).toMatchObject({ source: 'env', clientId: 'env-client-id-000000000000', appUrlSource: 'env' });
    await h.put({ clientId: API_KEY, clientSecret: API_SECRET });
    const { u } = await connect(h);
    expect(u.searchParams.get('client_id')).toBe(API_KEY);
  });
});

describe('encryption', () => {
  it('AES-256-GCM, bound to the website and field, key from SESSION_SECRET or CREDENTIALS_ENCRYPTION_KEY', () => {
    const box = createSecretBox({ SESSION_SECRET: 's'.repeat(40) })!;
    expect(box.keySource).toBe('SESSION_SECRET');
    const sealed = box.seal('shpss_example_secret', 'site-a:shopify:clientSecret');
    expect(box.open(sealed, 'site-a:shopify:clientSecret')).toBe('shpss_example_secret');
    expect(() => box.open(sealed, 'site-b:shopify:clientSecret')).toThrow(/could not be decrypted/);
    expect(() => box.open({ ...sealed, data: Buffer.from('x').toString('base64') }, 'site-a:shopify:clientSecret')).toThrow();
    expect(box.seal('same', 'x').iv).not.toBe(box.seal('same', 'x').iv);
    expect(createSecretBox({ CREDENTIALS_ENCRYPTION_KEY: 'k'.repeat(40), SESSION_SECRET: 's'.repeat(40) })!.keySource).toBe('CREDENTIALS_ENCRYPTION_KEY');
    expect(() => createSecretBox({ SESSION_SECRET: 't'.repeat(40) })!.open(sealed, 'site-a:shopify:clientSecret')).toThrow();
    expect(createSecretBox({})).toBeUndefined();
  });
});
