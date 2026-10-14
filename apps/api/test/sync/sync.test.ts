import { describe, expect, it } from 'vitest';
import type { SitePage } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import type { FetchLike } from '../../src/connectors/http';
import { classifyCwv, computeTiers, cruxCwv, ga4Tiers, gscSearch, runAllSyncs } from '../../src/sync';
import { json, mockFetch, serviceAccountJson, SECRETS, text } from '../connectors/helpers';
import { DEMO, makeHarness } from '../api/helpers';

/**
 * Connector data syncs (PDF §3.1 tiers, §6.3 striking distance, §4.4 CrUX, §15 data sources).
 * Real code paths throughout: service-account JWT signing + token exchange, registry "connected" gate, repositories.
 * Only the network is stubbed.
 */
const CREDS = {
  GA4_SERVICE_ACCOUNT_JSON: serviceAccountJson(), GA4_PROPERTY_ID: '123456789',
  GSC_SERVICE_ACCOUNT_JSON: serviceAccountJson(), GSC_PROPERTY: 'sc-domain:deodap.in',
  GOOGLE_API_KEY: SECRETS.GOOGLE_API_KEY,
};
const NOW = new Date('2026-10-12T06:00:00.000Z');

async function container(fetchImpl: FetchLike, opts: { demo?: boolean; connected?: ('ga4' | 'gsc' | 'psi_crux')[] } = {}): Promise<Container> {
  const env = loadEnv({ NODE_ENV: 'test', SEED_DEMO_DATA: opts.demo ? 'true' : 'false', SESSION_SECRET: 's'.repeat(40), LOG_LEVEL: 'silent', ...CREDS });
  const c = await createContainer({ env, fetchImpl, clock: () => NOW });
  // A passed connection test is what makes an integration "connected" (registry gate) — record one per integration.
  for (const id of opts.connected ?? ['ga4', 'gsc', 'psi_crux']) {
    await c.repos.integrationTests.upsert({ id, at: NOW.toISOString(), ok: true, result: 'test passed' });
  }
  return c;
}

async function addPage(c: Container, path: string, template: SitePage['template'], extra: Partial<SitePage> = {}) {
  const url = `https://deodap.in${path}`;
  await c.repos.sitePages.upsert({ id: `page:${url}`, url, path, template, title: path, tier: 3, tierReason: 'seed', indexable: true, source: 'live', ...extra });
}

const tokenOk = () => json(200, { access_token: 'ya29.TEST-ACCESS-TOKEN', expires_in: 3600, token_type: 'Bearer' });
const ga4Row = (path: string, channel: string, sessions: number, revenue: number) => ({ dimensionValues: [{ value: path }, { value: channel }], metricValues: [{ value: String(sessions) }, { value: String(revenue) }] });

describe('tier computation (PDF §3.1)', () => {
  const cfg = { tiers: { tier1TopCollections: 1, tier1TopProducts: 2, tier1LookbackDays: 90, tier1Basis: 'revenue_or_sessions' as const } };
  const p = (path: string, template: SitePage['template'], extra: Partial<SitePage> = {}): SitePage =>
    ({ id: path, url: `https://deodap.in${path}`, path, template, title: path, tier: 3, tierReason: '', indexable: true, source: 'live', ...extra });

  it('homepage + top-N collections + top-N products by revenue (sessions as fallback) are Tier 1', () => {
    const pages = [
      p('/', 'home'),
      p('/collections/a', 'collection', { revenue90d: 900 }), p('/collections/b', 'collection', { revenue90d: 100 }),
      p('/products/x', 'product', { revenue90d: 5000 }), p('/products/y', 'product', { organicSessions90d: 700 }), p('/products/z', 'product', { organicSessions90d: 10 }),
    ];
    const t = computeTiers(pages, cfg);
    expect(t.get('/')!.tier).toBe(1);
    expect(t.get('/collections/a')!.tier).toBe(1);
    expect(t.get('/collections/b')!.tier).toBe(2); // other indexable collections → Tier 2
    expect(t.get('/products/x')!.tier).toBe(1);
    expect(t.get('/products/y')!.tier).toBe(1); // no revenue, ranked by organic sessions
    expect(t.get('/products/z')!.tier).toBe(3); // outside top 2, no impressions
    expect(t.get('/products/x')!.reason).toMatch(/top 2 products/);
  });

  it('Tier 2: products with organic impressions and blog posts with clicks; everything else Tier 3', () => {
    const t = computeTiers([
      p('/products/seen', 'product', { impressions28d: 40 }), p('/products/unseen', 'product'),
      p('/blogs/news/clicked', 'blog_article', { clicks28d: 3 }), p('/blogs/news/quiet', 'blog_article', { impressions28d: 90 }),
      p('/pages/about', 'page'),
    ], cfg);
    expect(t.get('/products/seen')!.tier).toBe(2);
    expect(t.get('/products/unseen')!.tier).toBe(3);
    expect(t.get('/blogs/news/clicked')!.tier).toBe(2);
    expect(t.get('/blogs/news/quiet')!.tier).toBe(3);
    expect(t.get('/pages/about')!.tier).toBe(3);
  });
});

describe('GA4 sync → page value and tiers', () => {
  it('signs a service-account JWT, pulls the report, writes value onto live pages and recomputes tiers', async () => {
    const f = mockFetch((url) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) return tokenOk();
      if (url.includes('analyticsdata.googleapis.com')) return json(200, {
        rowCount: 4,
        rows: [
          ga4Row('/products/led-lamp', 'Organic Search', 400, 25000),
          ga4Row('/products/led-lamp?variant=1', 'Paid Search', 50, 3000), // query string folded into the same page
          ga4Row('/collections/diwali/products/rangoli', 'Organic Search', 30, 0), // scoped product URL → canonical /products/rangoli
          ga4Row('(not set)', 'Direct', 999, 999),
        ],
      });
      return text(500, 'unexpected');
    });
    const c = await container(f);
    await addPage(c, '/', 'home');
    await addPage(c, '/products/led-lamp', 'product');
    await addPage(c, '/products/no-traffic', 'product', { revenue90d: 50, organicSessions90d: 5 });

    const res = await ga4Tiers(c.ctx, { fetchImpl: f });
    expect(res.ran && res.ok).toBe(true);

    const report = f.calls.find((x) => x.url.includes(':runReport'))!;
    expect(report.url).toContain('properties/123456789:runReport');
    expect(report.headers.authorization).toBe('Bearer ya29.TEST-ACCESS-TOKEN');
    const body = JSON.parse(report.body!);
    expect(body.dateRanges[0].startDate).toBe('90daysAgo');
    expect(body.dimensions.map((d: { name: string }) => d.name)).toEqual(['landingPage', 'sessionDefaultChannelGroup']);

    const lamp = (await c.repos.sitePages.where({ path: '/products/led-lamp' }))[0];
    expect(lamp.revenue90d).toBe(28000); // revenue over all channels
    expect(lamp.organicSessions90d).toBe(400); // organic only
    expect(lamp.tier).toBe(1);
    const rangoli = (await c.repos.sitePages.where({ path: '/products/rangoli' }))[0];
    expect(rangoli?.source).toBe('live'); // created from GA4
    const quiet = (await c.repos.sitePages.where({ path: '/products/no-traffic' }))[0];
    expect(quiet.revenue90d).toBe(0); // full report read → absent pages truly had nothing
    expect((await c.repos.integrationTests.get('ga4'))?.lastSuccessfulSyncAt).toBe(NOW.toISOString());
  });

  it('never touches DEMO inventory', async () => {
    const f = mockFetch((url) => (url.includes('oauth2') ? tokenOk() : json(200, { rowCount: 1, rows: [ga4Row('/products/x', 'Organic Search', 1, 1)] })));
    const c = await container(f, { demo: true });
    const demoBefore = (await c.repos.sitePages.list()).filter((p) => p.source === 'demo');
    await ga4Tiers(c.ctx, { fetchImpl: f });
    const demoAfter = (await c.repos.sitePages.list()).filter((p) => p.source === 'demo');
    expect(demoAfter).toEqual(demoBefore);
  });
});

describe('Search Console sync', () => {
  const gsc = (url: string, body: { dimensions: string[] }) => {
    if (body.dimensions[0] === 'date') return json(200, { rows: Array.from({ length: 30 }, (_, i) => ({ keys: [`2026-09-${String(i + 1).padStart(2, '0')}`], clicks: 10, impressions: 1000, position: 12.34 })) });
    if (body.dimensions.join() === 'page') return json(200, { rows: [{ keys: ['https://deodap.in/products/led-lamp'], clicks: 30, impressions: 4000 }, { keys: ['https://other.example/x'], clicks: 1, impressions: 1 }] });
    return json(200, { rows: [
      { keys: ['led lamp wholesale', 'https://deodap.in/products/led-lamp'], clicks: 12, impressions: 900, ctr: 0.0133, position: 8.2 },
      { keys: ['deodap', 'https://deodap.in/'], clicks: 500, impressions: 5000, ctr: 0.1, position: 1.1 }, // top-3: not striking distance
      { keys: ['rare query', 'https://deodap.in/products/led-lamp'], clicks: 0, impressions: 3, ctr: 0, position: 9 }, // too few impressions
    ] });
    void url;
  };

  it('replaces the DEMO visibility series and striking list with live data, keeps the latest 28 days', async () => {
    const f = mockFetch((url, init) => (url.includes('oauth2') ? tokenOk() : gsc(url, JSON.parse(String(init?.body)))));
    const c = await container(f, { demo: true });
    const res = await gscSearch(c.ctx, { fetchImpl: f });
    expect(res.ran && res.ok).toBe(true);
    const m = await c.repos.metrics.get();
    expect(m.visibility).toHaveLength(28);
    expect(m.visibility.every((p) => p.source === 'live')).toBe(true); // never mixed with DEMO points
    expect(m.striking).toHaveLength(1);
    expect(m.striking[0]).toMatchObject({ query: 'led lamp wholesale', position: 8.2, impressions: 900, ctr: 1.3, source: 'live' });
    expect(f.calls.some((x) => x.url.includes(encodeURIComponent('sc-domain:deodap.in')))).toBe(true);
  });

  it('does not fabricate index coverage — the indexation series is left untouched', async () => {
    const f = mockFetch((url, init) => (url.includes('oauth2') ? tokenOk() : gsc(url, JSON.parse(String(init?.body)))));
    const c = await container(f);
    const before = (await c.repos.metrics.get()).indexation;
    const res = await gscSearch(c.ctx, { fetchImpl: f });
    expect((await c.repos.metrics.get()).indexation).toEqual(before);
    expect(res.ran && res.ok && res.summary).toMatch(/Index coverage is not available/);
  });

  it('writes 28-day impressions/clicks onto pages and ignores off-site URLs', async () => {
    const f = mockFetch((url, init) => (url.includes('oauth2') ? tokenOk() : gsc(url, JSON.parse(String(init?.body)))));
    const c = await container(f);
    await addPage(c, '/products/led-lamp', 'product');
    await gscSearch(c.ctx, { fetchImpl: f });
    const lamp = (await c.repos.sitePages.where({ path: '/products/led-lamp' }))[0];
    expect(lamp).toMatchObject({ impressions28d: 4000, clicks28d: 30, tier: 2 }); // product with impressions → Tier 2
    expect((await c.repos.sitePages.list()).some((p) => p.url.includes('other.example'))).toBe(false);
  });
});

describe('CrUX sync', () => {
  const record = (lcp: number, inp: number, cls: number) => json(200, { record: { metrics: {
    largest_contentful_paint: { percentiles: { p75: lcp } }, interaction_to_next_paint: { percentiles: { p75: inp } }, cumulative_layout_shift: { percentiles: { p75: String(cls) } },
  } } });

  it('classifies with Google thresholds (worst metric wins)', () => {
    expect(classifyCwv({ lcpMs: 2400, inpMs: 150, cls: 0.05 })).toBe('good');
    expect(classifyCwv({ lcpMs: 3000, inpMs: 150, cls: 0.05 })).toBe('needs_improvement');
    expect(classifyCwv({ lcpMs: 2000, inpMs: 600, cls: 0.05 })).toBe('poor');
  });

  it('writes origin/home/collection/product p75 values; a 404 is recorded as insufficient data, never filled in', async () => {
    const f = mockFetch((_url, init) => {
      const b = JSON.parse(String(init?.body));
      if (b.origin) return record(2300, 180, 0.05);
      if (b.url.endsWith('/')) return record(4300, 120, 0.02);
      if (b.url.includes('/collections/')) return json(404, { error: { code: 404, message: 'chrome ux report data not found' } });
      return record(2600, 210, 0.3);
    });
    const c = await container(f, { demo: true });
    await addPage(c, '/collections/diwali', 'collection', { tier: 1 });
    await addPage(c, '/products/led-lamp', 'product', { tier: 1 });
    const res = await cruxCwv(c.ctx, { fetchImpl: f });
    expect(res.ran && res.ok).toBe(true);
    const cwv = (await c.repos.metrics.get()).cwv;
    expect(cwv.every((x) => x.source === 'live')).toBe(true); // DEMO series replaced, not mixed
    expect(cwv.find((x) => x.template === 'origin')?.status).toBe('good');
    expect(cwv.find((x) => x.template === 'home')?.status).toBe('poor');
    expect(cwv.find((x) => x.template === 'product')?.status).toBe('poor'); // CLS 0.3
    expect(cwv.find((x) => x.template === 'collection')).toBeUndefined();
    expect(res.ran && res.ok && res.summary).toMatch(/collection: insufficient field data/);
    expect(f.calls[0].url).toContain('key=');
  });
});

describe('CrUX → PERF-CRUX issues (PDF §4.4: Critical if Poor on any template)', () => {
  const rec = (lcp: number) => json(200, { record: { metrics: {
    largest_contentful_paint: { percentiles: { p75: lcp } }, interaction_to_next_paint: { percentiles: { p75: 100 } }, cumulative_layout_shift: { percentiles: { p75: '0.02' } },
  } } });

  it('a Poor template raises a Critical issue; Good later resolves it; insufficient data never resolves it', async () => {
    let homeLcp = 4600;
    let homeMissing = false;
    const f = mockFetch((_url, init) => {
      const b = JSON.parse(String(init?.body));
      if (b.origin) return rec(2000);
      if (homeMissing) return json(404, {});
      return rec(homeLcp);
    });
    const c = await container(f, { connected: ['psi_crux'] });
    const ingest = c.services.issues.ingestFindings;

    await cruxCwv(c.ctx, { fetchImpl: f, ingest });
    let issue = (await c.repos.issues.list()).find((i) => i.checkId === 'PERF-CRUX');
    expect(issue).toMatchObject({ severity: 'critical', template: 'home', status: 'NEW', source: 'live' });
    expect(issue!.evidence[0]).toMatchObject({ kind: 'field_data' });
    expect((await c.repos.metrics.get()).criticalAlerts.some((a) => a.type === 'cwv_poor_template')).toBe(true);
    const alertAudit = (await c.repos.audit.list()).find((a) => a.action === 'alert.realtime');
    expect(alertAudit?.summary).toMatch(/Delivery: .*skipped_not_configured/); // honest: no provider configured

    homeMissing = true; // CrUX loses field data → not evidence of a fix
    await cruxCwv(c.ctx, { fetchImpl: f, ingest });
    expect((await c.repos.issues.get(issue!.id))?.status).toBe('NEW');

    homeMissing = false;
    homeLcp = 1800; // fixed
    await cruxCwv(c.ctx, { fetchImpl: f, ingest });
    issue = await c.repos.issues.get(issue!.id);
    expect(issue?.status).toBe('VERIFIED');
    expect((await c.repos.issues.list()).filter((i) => i.checkId === 'PERF-CRUX')).toHaveLength(1);
  });
});

describe('gating, failure handling and secrecy', () => {
  it('does nothing when the integration has not passed a connection test', async () => {
    const f = mockFetch(() => json(200, {}));
    const c = await container(f, { connected: [] });
    const summary = await runAllSyncs(c.ctx, { fetchImpl: f });
    expect(summary.skipped).toBe(3);
    expect(f.calls).toHaveLength(0);
  });

  it('a provider error is recorded (sync_failed + metrics.errors + audit), never thrown, and never leaks the API key', async () => {
    const f = mockFetch(() => json(403, { error: { code: 403, message: `API key ${SECRETS.GOOGLE_API_KEY} has been suspended` } }));
    const c = await container(f, { connected: ['psi_crux'] });
    const res = await cruxCwv(c.ctx, { fetchImpl: f });
    expect(res.ran && !res.ok).toBe(true);
    const status = await c.ctx.integrations.status('psi_crux');
    expect(status.state).toBe('sync_failed');
    const m = await c.repos.metrics.get();
    expect(m.errors.some((e) => e.component === 'sync.psi_crux')).toBe(true);
    const everything = JSON.stringify({ res, status, errors: m.errors, audit: await c.repos.audit.list() });
    expect(everything).not.toContain(SECRETS.GOOGLE_API_KEY);
    // A later successful sync clears the error state.
    const ok = mockFetch(() => json(404, {}));
    await cruxCwv(c.ctx, { fetchImpl: ok });
    expect((await c.ctx.integrations.status('psi_crux')).state).toBe('connected');
  });

  it('POST /api/integrations/:id/sync requires integrations.manage and rejects unknown ids', async () => {
    const h = await makeHarness();
    const dev = h.as(await h.token(DEMO.developer));
    expect((await dev.post('/api/integrations/ga4/sync')).status).toBe(403);
    const admin = h.as(await h.token(DEMO.admin));
    expect((await admin.post('/api/integrations/slack/sync')).status).toBe(400);
    const notConnected = await admin.post('/api/integrations/ga4/sync');
    expect(notConnected.status).toBe(200);
    expect(notConnected.body).toMatchObject({ id: 'ga4', ran: false });
  });
});
