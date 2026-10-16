/**
 * Shopify theme SOURCE differences (read-only) against the in-memory mock Shopify: snapshots through the authorised
 * connection, diffs between snapshots and between themes, permissions, and that nothing is written or published.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ThemeDiffResponse, ThemeSnapshotMeta } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { DEMO } from '../api/helpers';
import { createMockShopify, SHOP, STOREFRONT, TOKEN } from './mockShopify';

async function setup(connected: boolean) {
  const mock = createMockShopify();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-themes-'));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'true', SESSION_SECRET: 'theme-snapshot-test-secret-at-least-32-chars', LOG_LEVEL: 'silent',
    CRAWLER_BASE_URL: STOREFRONT, CRAWLER_ALLOW_LIVE: 'true', CHANGE_SNAPSHOT_DIR: dir, ...(connected ? { SHOPIFY_STORE_DOMAIN: SHOP, SHOPIFY_ADMIN_TOKEN: TOKEN } : {}),
  });
  const container = await createContainer({ env, fetchImpl: mock.fetchImpl });
  const agent = supertest(createApp(container));
  const as = async (email: string) => {
    const tok = (await agent.post('/api/auth/login').send({ email, password: DEMO.password })).body.token as string;
    const a = { Authorization: `Bearer ${tok}` };
    return { get: (p: string) => agent.get(p).set(a), post: (p: string, b: unknown = {}) => agent.post(p).set(a).send(b as object) };
  };
  return { mock, dir, dev: await as(DEMO.developer), seo: await as(DEMO.seoLead) };
}

describe('theme source differences (read-only)', () => {
  it('needs an authorised connection', async () => {
    const h = await setup(false);
    const r = await h.dev.post('/api/shopify/theme-snapshots', { themeId: 'gid://shopify/OnlineStoreTheme/9001' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('authorised connection');
  });

  it('snapshots themes, diffs them over time and against each other, and never writes', async () => {
    const h = await setup(true);
    const live = 'gid://shopify/OnlineStoreTheme/9001';
    const copy = 'gid://shopify/OnlineStoreTheme/9002';
    expect((await h.seo.post('/api/shopify/theme-snapshots', { themeId: live })).status).toBe(403); // shopify.theme only
    const s1 = (await h.dev.post('/api/shopify/theme-snapshots', { themeId: live })).body as ThemeSnapshotMeta;
    expect(s1).toMatchObject({ themeId: live, themeName: 'Dawn (live)', themeRole: 'MAIN', files: 1, skipped: 0 });
    const c1 = (await h.dev.post('/api/shopify/theme-snapshots', { themeId: copy })).body as ThemeSnapshotMeta;
    expect(c1.files).toBe(2);

    // Live vs copy: the copy has an extra layout file.
    const vs = (await h.dev.get(`/api/shopify/theme-snapshots/diff?from=${s1.id}&to=${c1.id}`)).body as ThemeDiffResponse;
    expect(vs.files.map((f) => [f.filename, f.state])).toEqual([['layout/theme.liquid', 'added'], ['sections/main-product.liquid', 'same']]);
    expect(vs.note).toContain('cannot edit or publish');

    // The live theme changes in Shopify; a second snapshot shows the exact lines.
    h.mock.themes[0].files.set('sections/main-product.liquid', '<div>\n  <h1 class="product__title h2">{{ product.title }}</h1>\n  {% render \'price\' %}\n</div>\n');
    const s2 = (await h.dev.post('/api/shopify/theme-snapshots', { themeId: live })).body as ThemeSnapshotMeta;
    const d = (await h.dev.get(`/api/shopify/theme-snapshots/diff?from=${s1.id}&to=${s2.id}&file=sections/main-product.liquid`)).body as ThemeDiffResponse;
    const f = d.files.find((x) => x.filename === 'sections/main-product.liquid')!;
    expect(f.state).toBe('changed');
    expect(f.diff!.lines.filter((l) => l.op === '-').map((l) => l.text)).toEqual(['  <h1 class="product__title">{{ product.title }}</h1>']);
    expect(f.diff!.lines.filter((l) => l.op === '+').map((l) => l.text)).toEqual(['  <h1 class="product__title h2">{{ product.title }}</h1>', "  {% render 'price' %}"]);
    expect(d.note).toContain('Both snapshots are of “Dawn (live)”');

    const list = (await h.dev.get('/api/shopify/theme-snapshots')).body as ThemeSnapshotMeta[];
    expect(list[0].id).toBe(s2.id); // newest first
    expect(list).toHaveLength(3);
    expect((await h.dev.get(`/api/shopify/theme-snapshots/diff?from=THS-nope&to=${s2.id}`)).status).toBe(404);

    // Read-only: no theme write, no publish; the token is not on disk.
    expect(h.mock.mutations()).toEqual([]);
    expect(h.mock.requests.some((r) => /themePublish|themeFilesUpsert|themeUpdate|themeDelete/.test(r.body))).toBe(false);
    const onDisk = fs.readdirSync(h.dir, { recursive: true }).map(String).filter((p) => p.endsWith('.json'));
    for (const p of onDisk) expect(fs.readFileSync(path.join(h.dir, p), 'utf8')).not.toContain(TOKEN);
  });
});
