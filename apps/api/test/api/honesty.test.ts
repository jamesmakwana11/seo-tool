import { describe, expect, it } from 'vitest';
import { FIXTURE, makeHarness } from './helpers';

/** PDF §17 / prompt honesty invariants: no fabricated connection, delivery, crawl or persistence claims. */
describe('honesty & no-fabrication invariants', () => {
  it('integrations are never "connected" without a successful test; testing with no credentials fails honestly', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const list = (await admin.get('/api/integrations')).body as { id: string; state: string }[];
    expect(list.every((i) => i.state !== 'connected')).toBe(true);
    const test = await admin.post('/api/integrations/gsc/test');
    expect(test.status).toBe(200);
    expect(test.body.state).not.toBe('connected');
  });

  it('settings endpoint refuses secret-looking keys (secrets live only in env)', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const res = await admin.patch('/api/integrations/backlinks', { AHREFS_API_TOKEN: 'secret-value' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SECRET_IN_SETTINGS');
  });

  it('sending a report with no configured channels claims no external delivery', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const res = await admin.post('/api/reports/daily/send');
    expect(res.status).toBe(200);
    for (const d of res.body as { outcome: string }[]) expect(d.outcome).not.toBe('delivered');
  });

  it('starting a crawl is refused when the crawler is not allowed to go live', async () => {
    const h = await makeHarness(); // no CRAWLER_BASE_URL / CRAWLER_ALLOW_LIVE
    const admin = h.as(await h.token(FIXTURE.admin));
    const res = await admin.post('/api/crawls', { type: 'smart' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CRAWLER_NOT_READY');
  });

  it('system health reports in-memory, non-persistent storage and 0 connected integrations', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const res = await admin.get('/api/system/health');
    expect(res.body.storage.kind).toBe('in_memory');
    expect(res.body.storage.persistent).toBe(false);
    const connectors = res.body.components.find((c: { id: string }) => c.id === 'connectors');
    expect(connectors.detail).toMatch(/0 of \d+ integrations connected/);
  });

  it('exported report is served as a downloadable attachment', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const res = await admin.get('/api/reports/weekly/export?format=md');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text).toMatch(/sample|data source|SEO/i);
  });
});
