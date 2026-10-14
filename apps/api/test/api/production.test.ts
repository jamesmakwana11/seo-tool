import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { makeHarness } from './helpers';

const PROD = { NODE_ENV: 'production', SESSION_SECRET: 'prod-secret-value-at-least-32-chars-long!!', LOG_LEVEL: 'silent' };
const ADMIN = { ADMIN_EMAIL: 'owner@example.com', ADMIN_NAME: 'Site Owner', ADMIN_INITIAL_PASSWORD: 'Initial-Pass-2026' };

describe('production configuration', () => {
  it('refuses to start without an explicit ephemeral-storage acknowledgement', () => {
    expect(() => loadEnv(PROD)).toThrow(/ALLOW_EPHEMERAL_STORAGE/);
  });

  it('refuses the DEMO seed (publicly known passwords) in production and defaults it off', () => {
    expect(() => loadEnv({ ...PROD, ALLOW_EPHEMERAL_STORAGE: 'true', SEED_DEMO_DATA: 'true' })).toThrow(/SEED_DEMO_DATA/);
    const env = loadEnv({ ...PROD, ALLOW_EPHEMERAL_STORAGE: 'true' });
    expect(env.SEED_DEMO_DATA).toBe(false);
    expect(env.ALLOW_DEV_ROLE_PREVIEW).toBe(false);
    expect(env.DEV_EXPOSE_RESET_TOKEN).toBe(false);
  });

  it('requires ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD together', () => {
    expect(() => loadEnv({ ...PROD, ALLOW_EPHEMERAL_STORAGE: 'true', ADMIN_EMAIL: 'a@example.com' })).toThrow(/ADMIN_INITIAL_PASSWORD/);
  });
});

describe('production server', () => {
  const prod = { ...PROD, SEED_DEMO_DATA: 'false', ALLOW_EPHEMERAL_STORAGE: 'true', ALLOW_DEV_ROLE_PREVIEW: 'false', DEV_EXPOSE_RESET_TOKEN: 'false' };

  it('creates the first admin from env on a clean start, with no DEMO accounts', async () => {
    const h = await makeHarness({ ...prod, ...ADMIN });
    expect(await h.container.repos.employees.count()).toBe(1);
    const demo = await h.agent.post('/api/auth/login').send({ email: 'aarav.admin@demo.deodap.local', password: 'Sentinel@Demo1' });
    expect(demo.status).toBe(401);
    const tok = await h.token(ADMIN.ADMIN_EMAIL, ADMIN.ADMIN_INITIAL_PASSWORD);
    const me = await h.as(tok).get('/api/auth/me');
    expect(me.body.role).toBe('admin');
    expect(me.body.name).toBe('Site Owner');
    // Nothing is presented as DEMO data on a live server.
    expect(me.body.serverDemoData).toBe(false);
  });

  it('rejects a weak initial admin password', async () => {
    await expect(makeHarness({ ...prod, ...ADMIN, ADMIN_INITIAL_PASSWORD: 'short' })).rejects.toThrow(/too weak/);
  });

  it('sends security headers and a liveness probe', async () => {
    const h = await makeHarness({ ...prod, ...ADMIN });
    const res = await h.agent.get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('rate-limits sign-in attempts per client', async () => {
    const h = await makeHarness({ ...prod, ...ADMIN, AUTH_RATE_LIMIT: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await h.agent.post('/api/auth/login').send({ email: ADMIN.ADMIN_EMAIL, password: 'wrong-password-1' })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('answers malformed JSON with 400, not a 500', async () => {
    const h = await makeHarness({ ...prod, ...ADMIN });
    const res = await h.agent.post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('serves the built web app with an SPA fallback, and never HTML for a missing asset or API route', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    const h = await makeHarness({ ...prod, ...ADMIN, WEB_DIST_DIR: dir });
    const page = await h.agent.get('/issues/ISS-1').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="root"');
    expect(page.headers['cache-control']).toBe('no-cache');
    const asset = await h.agent.get('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await h.agent.get('/assets/missing-000.js')).status).toBe(404);
    const api = await h.agent.get('/api/does-not-exist').set('Accept', 'text/html');
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('NOT_FOUND');
  });
});
