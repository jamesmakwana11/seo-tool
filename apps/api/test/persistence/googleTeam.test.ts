import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { WEBSITE_HEADER, type CwvReport, type DevInviteResult, type DevTaskView, type GoogleStatus, type Notification, type TeamReminder } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { createLogger } from '../../src/lib/logger';
import { openPersistence } from '../../src/repositories/postgres/persistence';
import { ACCOUNT, CLIENT_ID, CLIENT_SECRET, createMockGoogle, GA4_PROPERTY, GSC_PROPERTY, PSI_KEY, REFRESH } from '../google/mockGoogle';
import { ADMIN, DB_URL, freshDatabase, sql } from './helpers';

/**
 * PostgreSQL: Google connections (OAuth client secret, account refresh tokens, PSI key — encrypted, never plain in a
 * row), website mappings, Core Web Vitals and report history, and the Development Team (members, activation links,
 * tasks, reminders, notifications) survive an API restart — nothing is re-entered, nothing lives only in memory.
 */
const APP = 'https://sentinel.example';
const SECRET = 'db-session-secret-value-for-google-team-test';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined); });

async function boot(url: string, sessionSecret = SECRET) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-google-db-'));
  const google = createMockGoogle({ redirectUri: `${APP}/api/google/oauth/callback` });
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: sessionSecret, LOG_LEVEL: 'silent', APP_BASE_URL: APP,
    ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, CRAWLER_BASE_URL: 'https://deodap.test', CRAWLER_ALLOW_LIVE: 'true',
    CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'), DATABASE_URL: url,
  });
  const persistence = await openPersistence({ url, log: createLogger('silent'), waitMs: 2000 });
  const container = await createContainer({ env, persistence, fetchImpl: google.wrap(async () => { throw new Error('network disabled in tests'); }) });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const agent = supertest(app);
  const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    agent, auth, persistence, container, google,
    async stop() { container.scheduler.stop(); await persistence.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}
const due = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!DB_URL)('PostgreSQL: Google connections and the Development Team survive restarts', () => {
  it('stores secrets encrypted and brings everything back after a restart', async () => {
    const db = await freshDatabase();
    cleanups.push(db.drop);

    // ---- first run: connect Google, map the website, test PSI, build a team with a task and a reminder
    const a = await boot(db.url);
    expect((await a.agent.put('/api/google/oauth-client').set(a.auth).send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })).status).toBe(200);
    const start = await a.agent.post('/api/google/oauth/start').set(a.auth).send({});
    const state = new URL(start.body.authorizeUrl).searchParams.get('state');
    expect((await a.agent.get(`/api/google/oauth/callback?state=${state}&code=good-code`)).headers.location).toMatch(/google=connected/);
    const acct = `acct:${ACCOUNT.sub}`;
    expect((await a.agent.put('/api/google/mapping/ga4').set(a.auth).send({ accountId: acct, property: GA4_PROPERTY })).body.mapping.state).toBe('connected');
    expect((await a.agent.put('/api/google/mapping/gsc').set(a.auth).send({ accountId: acct, property: GSC_PROPERTY })).body.mapping.state).toBe('connected');
    expect((await a.agent.put('/api/google/psi-key').set(a.auth).send({ apiKey: PSI_KEY })).status).toBe(200);
    expect((await a.agent.get('/api/insights/ga4?range=28').set(a.auth)).status).toBe(200);
    // A second website: the team board is shared, Google mappings are per website.
    const site2 = (await a.agent.post('/api/websites').set(a.auth).send({ name: 'Second shop', url: 'https://second-shop.test', platform: 'shopify' })).body;
    const inv = (await a.agent.post('/api/dev-team/members').set(a.auth).send({ name: 'Priya Shah', email: 'priya@example.com', role: 'developer' })).body as DevInviteResult;
    const link = inv.activation.link!;
    const task = (await a.agent.post('/api/dev-team/tasks').set({ ...a.auth, [WEBSITE_HEADER]: site2.id }).send({ title: 'Speed up the product page', kind: 'development', priority: 'high', dueDate: due(5), assigneeId: inv.member.id, websiteId: site2.id })).body as DevTaskView;
    expect(task.websiteName).toBe('Second shop');
    expect((await a.agent.post('/api/dev-team/reminders').set(a.auth).send({ to: inv.member.id, message: 'Kick-off at 11.' })).status).toBe(201);
    await a.persistence.flush();
    await a.stop();

    // ---- nothing secret is stored in plain text
    const rows = JSON.stringify((await sql(db.url, 'SELECT collection, doc FROM sentinel_records')).rows) + JSON.stringify((await sql(db.url, 'SELECT doc FROM sentinel_documents')).rows);
    for (const secret of [CLIENT_SECRET, REFRESH, PSI_KEY, new URL(link).searchParams.get('token')!]) expect(rows).not.toContain(secret);
    const conns = (await sql(db.url, "SELECT website_id, doc FROM sentinel_records WHERE collection = 'googleConnections'")).rows as { website_id: string; doc: { id: string; sealed: Record<string, unknown> } }[];
    expect(conns.map((r) => r.doc.id).sort()).toEqual(['acct:1100220033', 'client', 'psi']);
    expect(conns.find((r) => r.doc.id === 'acct:1100220033')!.doc.sealed.refreshToken).toMatchObject({ v: 1, iv: expect.any(String) });
    const shared = (await sql(db.url, "SELECT DISTINCT website_id, collection FROM sentinel_records WHERE collection IN ('devTasks','teamReminders','teamNotifications')")).rows as { website_id: string }[];
    expect(new Set(shared.map((r) => r.website_id))).toEqual(new Set(['_shared']));

    // ---- second run: everything is back, and works
    const b = await boot(db.url);
    cleanups.push(b.stop);
    const st = (await b.agent.get('/api/google/status').set(b.auth)).body as GoogleStatus;
    expect(st.oauth).toMatchObject({ configured: true, secretSet: true, source: 'saved' });
    expect(st.accounts.map((x) => x.email)).toEqual([ACCOUNT.email]);
    expect(st.ga4).toMatchObject({ via: 'oauth', property: GA4_PROPERTY, state: 'connected' });
    expect(st.gsc).toMatchObject({ via: 'oauth', property: GSC_PROPERTY, state: 'connected' });
    expect(st.psi).toMatchObject({ keySource: 'saved', connected: true });
    // The stored refresh token is decrypted and used (no access token in memory after the restart).
    expect((await b.agent.get('/api/insights/gsc?range=7').set(b.auth)).status).toBe(200);
    expect(b.google.requests.some((r) => r.url === 'https://oauth2.googleapis.com/token')).toBe(true);
    expect(((await b.agent.get('/api/insights/history?days=90').set(b.auth)).body as unknown[]).length).toBeGreaterThanOrEqual(28);
    expect(((await b.agent.get('/api/insights/cwv').set(b.auth)).body as CwvReport).history.length).toBeGreaterThan(0);
    // The second website has its own (empty) Google mapping.
    expect((await b.agent.get('/api/google/status').set({ ...b.auth, [WEBSITE_HEADER]: site2.id })).body.ga4.state).toBe('not_mapped');

    const tasks = (await b.agent.get('/api/dev-team/tasks?status=all').set(b.auth)).body as DevTaskView[];
    expect(tasks.map((t) => [t.id, t.title, t.assigneeId])).toEqual([[task.id, 'Speed up the product page', inv.member.id]]);
    expect(((await b.agent.get('/api/dev-team/reminders').set(b.auth)).body as TeamReminder[]).map((r) => r.kind).sort()).toEqual(['assignment', 'manual']);
    // The activation link from before the restart still works once; the member then sees their notifications.
    expect((await b.agent.post('/api/auth/reset').send({ token: new URL(link).searchParams.get('token'), newPassword: 'Priya-Strong-2026' })).status).toBe(200);
    const pt = (await b.agent.post('/api/auth/login').send({ email: 'priya@example.com', password: 'Priya-Strong-2026' })).body.token;
    const inbox = (await b.agent.get('/api/notifications').set({ Authorization: `Bearer ${pt}` })).body as Notification[];
    expect(inbox.map((n) => n.type).sort()).toEqual(['assignment', 'reminder']);
    // Seen from the other website too (one board for the server).
    expect(((await b.agent.get('/api/dev-team/tasks?status=all').set({ ...b.auth, [WEBSITE_HEADER]: site2.id })).body as DevTaskView[]).length).toBe(1);
  });

  it('reports — instead of using — credentials when the server’s encryption secret changed', async () => {
    const db = await freshDatabase();
    cleanups.push(db.drop);
    const a = await boot(db.url);
    await a.agent.put('/api/google/oauth-client').set(a.auth).send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    await a.agent.put('/api/google/psi-key').set(a.auth).send({ apiKey: PSI_KEY });
    await a.persistence.flush();
    await a.stop();
    const b = await boot(db.url, 'a-different-session-secret-value-after-redeploy');
    cleanups.push(b.stop);
    const st = (await b.agent.get('/api/google/status').set(b.auth)).body as GoogleStatus;
    expect(st.oauth.problem).toMatch(/could not be decrypted/);
    expect(st.oauth.configured).toBe(false);
    expect(st.psi.problem).toMatch(/could not be decrypted/);
  });
});
