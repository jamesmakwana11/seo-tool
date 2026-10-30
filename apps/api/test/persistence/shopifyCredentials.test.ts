import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShopifyStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { createLogger } from '../../src/lib/logger';
import { openPersistence } from '../../src/repositories/postgres/persistence';
import { signQuery } from '../../src/shopify/oauth';
import { API_KEY, API_SECRET, createMockShopify, SHOP, STOREFRONT, TOKEN } from '../shopify/mockShopify';
import { ADMIN, DB_URL, freshDatabase, sql } from './helpers';

/**
 * PostgreSQL: the Shopify app credentials and the OAuth token entered / obtained in the app are stored encrypted in the
 * database (no plain secret in any row) and are back after the API restarts — no reconnect, no env variables.
 */
const APP_URL = 'https://apps.deodap.info/seo-tool';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined); });

async function boot(url: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-shopify-db-'));
  const mock = createMockShopify();
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'db-session-secret-value-for-shopify-test', LOG_LEVEL: 'silent',
    ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true',
    CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'), DATABASE_URL: url,
  });
  const persistence = await openPersistence({ url, log: createLogger('silent'), waitMs: 2000 });
  const container = await createContainer({ env, persistence, fetchImpl: mock.fetchImpl });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const agent = supertest(app);
  const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    agent, auth, persistence,
    status: async () => (await agent.get('/api/shopify/status').set(auth)).body as ShopifyStatus,
    stop: async () => { container.scheduler.stop(); await persistence.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

describe.skipIf(!DB_URL)('Shopify credentials in PostgreSQL', () => {
  it('stores the Client secret and the token encrypted, and keeps the connection across a restart', async () => {
    const db = await freshDatabase();
    cleanups.push(db.drop);
    const a = await boot(db.url);
    const saved = await a.agent.put('/api/shopify/app-credentials').set(a.auth).send({ clientId: API_KEY, clientSecret: API_SECRET, appUrl: APP_URL });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const start = await a.agent.post('/seo-tool/api/shopify/oauth/start').set(a.auth).send({ shop: SHOP });
    const state = new URL(start.body.authorizeUrl).searchParams.get('state')!;
    const q = { code: 'good-code', shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) };
    const cb = await a.agent.get('/seo-tool/api/shopify/oauth/callback').query({ ...q, hmac: signQuery(q, API_SECRET) }).redirects(0);
    expect(cb.headers.location).toBe(`${APP_URL}/settings/shopify?shopify=connected`);
    expect((await a.status()).connected).toBe(true);
    await a.persistence.flush();

    // In the database: ciphertext only.
    const rows = (await sql(db.url, `SELECT doc::text AS doc FROM sentinel_records WHERE collection = 'integrationSecrets'`)).rows as { doc: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].doc).toContain('"clientSecret"');
    expect(rows[0].doc).toContain('"accessToken"');
    const everything = (await sql(db.url, `SELECT string_agg(doc::text, ' ') AS all FROM sentinel_records`)).rows[0].all as string;
    expect(everything).not.toContain(API_SECRET);
    expect(everything).not.toContain(TOKEN);
    await a.stop();

    // A new API process with the same database (and the same SESSION_SECRET).
    const b = await boot(db.url);
    cleanups.push(b.stop);
    const st = await b.status();
    expect(st).toMatchObject({ connected: true, via: 'oauth', shop: SHOP, oauthConfigured: true, redirectUrl: `${APP_URL}/api/shopify/oauth/callback` });
    expect(st.appCredentials).toMatchObject({ source: 'saved', clientId: API_KEY, secretSet: true, appUrl: APP_URL, persistent: true });
    expect(st.capabilities.edit).toBe(true);
  });
});
