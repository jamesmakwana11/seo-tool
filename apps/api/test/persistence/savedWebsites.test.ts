import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WebsiteSummary } from '@sentinel/shared';
import { ADMIN, DB_URL, freshDatabase, sql, startServerProcess, type ServerProcess } from './helpers';

/**
 * The real API process in production mode with PostgreSQL: DeoDap, Grabnix, Oblivion and Natation are always in the
 * website list (default SEED_WEBSITES), a website added by a person stays, and nothing is lost, duplicated or reset by
 * signing out and in or by restarts. No request is made to any of these websites.
 */
describe.skipIf(!DB_URL)('saved websites across sign-out and restarts (production, PostgreSQL)', () => {
  const dbs: { drop: () => Promise<void> }[] = [];
  afterAll(async () => { for (const d of dbs) await d.drop().catch(() => undefined); });

  it('keeps DeoDap and the three added websites, plus any added later, after sign-out and restarts', async () => {
    const d = await freshDatabase();
    dbs.push(d);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-sites-'));
    const env = {
      NODE_ENV: 'production', DATABASE_URL: d.url, DATABASE_SSL: 'disable', SESSION_SECRET: 'v'.repeat(40), ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
      CRAWLER_BASE_URL: 'https://deodap.in', SCHEDULER_ENABLED: 'false', LOG_LEVEL: 'warn', TRUST_PROXY: '0',
      CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'),
    };
    const port = 49800 + Math.floor(Math.random() * 150);
    let srv: ServerProcess = await startServerProcess(env, port);
    try {
      const login = async () => ((await (await srv.api('/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })).json()) as { token: string }).token;
      const list = async (t: string) => ((await (await srv.api('/websites', {}, t)).json()) as WebsiteSummary[]).map((w) => `${w.name}|${w.domain}|${w.platform}`);
      let tok = await login();
      const first = await list(tok);
      expect(first).toEqual(['DeoDap|deodap.in|shopify', 'Grabnix|grabnix.in|shopify', 'Oblivion|oblivion.co.in|shopify', 'Natation|natation.in|shopify']);

      // A website added by a person, and an edit to a seeded one (it is never overwritten by the seed list).
      const added = await srv.api('/websites', { method: 'POST', body: JSON.stringify({ name: 'Kitchen Store', url: 'https://kitchen.example/', platform: 'woocommerce' }) }, tok);
      expect(added.status).toBe(201);
      const sites = (await (await srv.api('/websites', {}, tok)).json()) as WebsiteSummary[];
      const grab = sites.find((w) => w.domain === 'grabnix.in')!;
      const edited = await srv.api(`/websites/${grab.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Grabnix India', url: grab.url, platform: 'shopify' }) }, tok);
      expect(edited.status).toBe(200);
      const expected = ['DeoDap|deodap.in|shopify', 'Grabnix India|grabnix.in|shopify', 'Oblivion|oblivion.co.in|shopify', 'Natation|natation.in|shopify', 'Kitchen Store|kitchen.example|woocommerce'];
      expect(await list(tok)).toEqual(expected);

      // Sign out and in again.
      expect((await srv.api('/auth/logout', { method: 'POST' }, tok)).status).toBeLessThan(300);
      tok = await login();
      expect(await list(tok)).toEqual(expected);

      // Restart twice (redeploy): same websites, same ids, no duplicates.
      const ids = sites.map((w) => w.id);
      for (let i = 0; i < 2; i++) {
        expect(await srv.stop('SIGTERM')).toBe(0);
        srv = await startServerProcess(env, port);
        tok = await login();
        expect(await list(tok)).toEqual(expected);
        const again = (await (await srv.api('/websites', {}, tok)).json()) as WebsiteSummary[];
        expect(again.map((w) => w.id).slice(0, ids.length)).toEqual(ids);
      }
      expect(Number((await sql(d.url, 'SELECT count(*) AS n FROM sentinel_websites')).rows[0].n)).toBe(5);
      // Each website keeps its own settings: the selected website's name and platform are used in its recommendations.
      const cfg = (await (await srv.api('/config', { headers: { 'x-website-id': grab.id } }, tok)).json()) as { site: { brand: string; canonicalHost: string; platform: string } };
      expect(cfg.site).toMatchObject({ brand: 'Grabnix India', canonicalHost: 'grabnix.in', platform: 'shopify' });
    } finally {
      await srv.stop('SIGTERM');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
