/**
 * Lighthouse lab audits and rendered checks — real Lighthouse with a real Chromium against the local fixture store
 * (skipped when the package or a browser is not installed on the machine running the tests).
 */
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LighthouseRun, LighthouseStatus } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { findChrome, lighthouseVersion } from '../../src/lighthouse/service';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';

const ADMIN = { email: 'lh.admin@example.test', password: 'Lighthouse-Test-Pass-91!' };
const HAVE = !!lighthouseVersion() && !!findChrome();

async function setup(env: Record<string, string> = {}) {
  const site = await startFixtureSite();
  const container = await createContainer({
    env: loadEnv({
      NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'q'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: site.origin,
      ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, LIGHTHOUSE_CHROME_FLAGS: '--no-sandbox', ...env,
    }),
  });
  const agent = supertest(createApp(container));
  const login = await agent.post('/api/auth/login').send(ADMIN);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  return { site, container, get: (p: string) => agent.get(p).set(auth), post: (p: string, b: object) => agent.post(p).set(auth).send(b) };
}

describe('Lighthouse service', () => {
  let h: Awaited<ReturnType<typeof setup>>;
  let site: FixtureSite;
  beforeAll(async () => { h = await setup(); site = h.site; });
  afterAll(async () => { await site.close(); });

  it('reports what is installed and what is missing, honestly', async () => {
    const st = (await h.get('/api/lighthouse/status')).body as LighthouseStatus;
    expect(st.available).toBe(HAVE);
    if (!HAVE) expect(st.problems.length).toBeGreaterThan(0);
    else expect(st.lighthouseVersion).toMatch(/^\d+\./);
  });

  it('refuses URLs of other websites and private addresses', async () => {
    if (!HAVE) return;
    const other = await h.post('/api/lighthouse/runs', { url: 'https://example.com/', formFactors: ['mobile'] });
    expect(other.status).toBe(400);
    const meta = await h.post('/api/lighthouse/runs', { url: 'http://169.254.169.254/latest/meta-data', formFactors: ['mobile'] });
    expect(meta.status).toBe(400);
  });

  it.skipIf(!HAVE)('runs real mobile and desktop audits and a rendered check, one at a time', async () => {
    const res = await h.post('/api/lighthouse/runs', { url: `${site.origin}/products/vegetable-chopper`, formFactors: ['mobile', 'desktop'], render: true });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect((res.body as LighthouseRun[]).map((r) => r.formFactor ?? r.kind)).toEqual(['mobile', 'desktop', 'render']);
    await h.container.services.lighthouse.idle();
    const runs = (await h.get('/api/lighthouse/runs')).body as LighthouseRun[];
    const mobile = runs.find((r) => r.formFactor === 'mobile')!;
    const desktop = runs.find((r) => r.formFactor === 'desktop')!;
    const render = runs.find((r) => r.kind === 'render')!;
    expect(mobile.status, mobile.error).toBe('completed');
    expect(mobile.result!.formFactor).toBe('mobile');
    expect(desktop.result!.formFactor).toBe('desktop');
    for (const r of [mobile, desktop]) {
      expect(r.result!.scores.performance).toBeGreaterThanOrEqual(0);
      expect(r.result!.scores.seo).toBeGreaterThanOrEqual(0);
      expect(r.result!.metrics.lcp?.value).toBeGreaterThan(0);
    }
    expect(render.status, render.error).toBe('completed');
    expect(render.render!.fields.find((f) => f.field === 'Title')!.differs).toBe(false);
  }, 240_000);
});

describe('Lighthouse unavailable', () => {
  it('refuses to queue runs with the reason when switched off', async () => {
    const x: { site?: FixtureSite; container?: Container } = {};
    const h = await setup({ LIGHTHOUSE_ENABLED: 'false' });
    x.site = h.site;
    const st = (await h.get('/api/lighthouse/status')).body as LighthouseStatus;
    expect(st.available).toBe(false);
    expect(st.problems.join(' ')).toMatch(/LIGHTHOUSE_ENABLED=false/);
    const r = await h.post('/api/lighthouse/runs', { url: `${h.site.origin}/`, formFactors: ['mobile'] });
    expect(r.status).toBe(409);
    await x.site.close();
  });
});
