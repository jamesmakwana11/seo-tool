import { describe, expect, it } from 'vitest';
import { DEMO, makeHarness } from './helpers';

/** Multi-website workspaces: each website's data is isolated; the X-Website-Id header selects the workspace. */
describe('websites', () => {
  it('adds a website (validated, duplicate domains refused) that starts empty and never mixes data', async () => {
    const h = await makeHarness();
    const tok = await h.token(DEMO.seoLead);
    const seo = h.as(tok);
    const site = (id: string) => ({ get: (p: string) => h.agent.get(p).set({ Authorization: `Bearer ${tok}`, 'X-Website-Id': id }), patch: (p: string, b: unknown) => h.agent.patch(p).set({ Authorization: `Bearer ${tok}`, 'X-Website-Id': id }).send(b as object) });

    const list0 = (await seo.get('/api/websites')).body as { id: string; domain: string; hasAuditData: boolean }[];
    expect(list0).toHaveLength(1);
    expect(list0[0]).toMatchObject({ id: 'site-deodap', domain: 'deodap.in', hasAuditData: true });

    expect((await seo.post('/api/websites', { name: 'x', url: 'nope', platform: 'shopify' })).status).toBe(400);
    const dup = await seo.post('/api/websites', { name: 'Again', url: 'https://www.deodap.in/', platform: 'shopify' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_DOMAIN');

    const created = await seo.post('/api/websites', { name: 'Second Store', url: 'second.example.com', platform: 'woocommerce' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const list = (await seo.get('/api/websites')).body as { id: string; hasAuditData: boolean; healthScore?: number; integrationsConnected: number }[];
    expect(list.find((w) => w.id === id)).toMatchObject({ hasAuditData: false, integrationsConnected: 0 });
    expect(list.find((w) => w.id === id)!.healthScore).toBeUndefined();

    // The new workspace is empty; the DEMO workspace is untouched.
    expect((await site(id).get('/api/issues')).body.total).toBe(0);
    expect((await site(id).get('/api/crawls')).body).toHaveLength(0);
    expect((await site(id).get('/api/dashboard')).body.hasAuditData).toBe(false);
    expect((await site('site-deodap').get('/api/issues')).body.total).toBeGreaterThan(0);
    expect((await site(id).get('/api/issues/ISS-0001')).status).toBe(404);

    // Settings are per website.
    const cfg = (await site(id).get('/api/config')).body;
    expect(cfg.site.canonicalHost).toBe('second.example.com');
    await site(id).patch('/api/config', { thresholds: { ...cfg.thresholds, titleMaxChars: 55 } });
    expect((await site('site-deodap').get('/api/config')).body.thresholds.titleMaxChars).not.toBe(55);

    // Unknown website ids are refused, not served another site's data.
    const missing = await site('site-missing').get('/api/issues');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('WEBSITE_NOT_FOUND');
  });

  it('developers cannot add websites', async () => {
    const h = await makeHarness();
    const dev = h.as(await h.token(DEMO.developer));
    expect((await dev.post('/api/websites', { name: 'Nope', url: 'nope.example.com', platform: 'custom' })).status).toBe(403);
  });
});
