import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { findChrome } from '../../src/lighthouse/service';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';

/**
 * Visual comparison with a REAL headless Chromium against the loopback fixture store: screenshots, pixel diff, rendered
 * DOM diff, SEO fields and CSS changes — and the honest "unavailable" states.
 */
const HAVE_CHROME = !!findChrome(process.env.LIGHTHOUSE_CHROME_PATH);
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => {
  await container?.services.crawls.idle();
  await container?.services.captures.idle();
  await site?.close();
  site = undefined;
  container = undefined;
});

async function setup(env: Record<string, string> = {}) {
  site = await startFixtureSite();
  container = await createContainer({
    env: loadEnv({
      NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'v'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: site.origin, CRAWLER_REQUEST_DELAY_MS: '0',
      CRAWLER_RETRIES: '0', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-capture-')),
      CHANGE_CAPTURE_MAX_HEIGHT: '2000', ...env,
    }),
  });
  return { site, container };
}

describe('page captures (real Chromium)', () => {
  it.skipIf(!HAVE_CHROME)('first capture has no "previous"; the second shows the visual, DOM, SEO-field and CSS differences', async () => {
    const { site: s, container: c } = await setup();
    const cap = c.services.captures;
    const st = await cap.status(SYSTEM_ACTOR);
    expect(st.available, st.problems.join(' ')).toBe(true);
    const home = `${s.origin}/`;
    const job = await cap.request(SYSTEM_ACTOR, { urls: [home], viewports: ['desktop', 'mobile'] });
    expect(job.status).toBe('queued');
    await cap.idle();
    const j1 = await cap.job(SYSTEM_ACTOR, job.id);
    expect(j1.status, j1.error).toBe('done');
    const list = await cap.list(SYSTEM_ACTOR, home);
    expect(list.map((x) => x.viewport).sort()).toEqual(['desktop', 'mobile']);
    const desk = list.find((x) => x.viewport === 'desktop')!;
    expect(desk).toMatchObject({ ok: true, status: 200, width: 1366, hasImage: true, hasHtml: true, hasDiffImage: false, diff: null });
    expect(list.find((x) => x.viewport === 'mobile')!.width).toBe(390);
    expect(desk.fields?.title).toContain('DeoDap');
    const first = await cap.compare(SYSTEM_ACTOR, { url: home, viewport: 'desktop' });
    expect(first.from).toBeNull();
    expect(first.visual.available).toBe(false);
    expect(first.visual.reason).toContain('never made up');
    expect(first.dom.available).toBe(false);

    // Change the page: new title and a new theme stylesheet version with another background colour.
    s.opts.duplicateTitle = ['/'];
    s.opts.themeVersion = 2;
    await cap.request(SYSTEM_ACTOR, { urls: [home], viewports: ['desktop'] });
    await cap.idle();
    const cmp = await cap.compare(SYSTEM_ACTOR, { url: home, viewport: 'desktop' });
    expect(cmp.from?.id).toBe(desk.id);
    expect(cmp.to?.hasDiffImage).toBe(true);
    expect(cmp.visual.available).toBe(true);
    expect(cmp.visual.ratio).toBeGreaterThan(0.02); // the background colour changed behind the content
    expect(cmp.dom.available).toBe(true);
    expect(cmp.dom.diff!.lines.some((l) => l.op === '+' && l.text.includes('<title>'))).toBe(false); // tags and text are separate lines
    expect(cmp.dom.diff!.lines.some((l) => l.op === '+' && l.text.includes('Wholesale Products Online at Best Price'))).toBe(true);
    expect(cmp.dom.note).toContain('does not prove that the Shopify theme code changed');
    expect(cmp.seoFields.find((f) => f.field === 'Title')).toMatchObject({ changed: true, to: 'Wholesale Products Online at Best Price | DeoDap' });
    const css = cmp.assets.items.find((a) => a.key.endsWith('/cdn/shop/t/1/assets/base.css'));
    expect(css?.state).toBe('changed');
    expect(css?.to?.url).toContain('?v=2');
    const ad = await cap.assetDiff(SYSTEM_ACTOR, { url: home, from: cmp.from!.id, to: cmp.to!.id, key: css!.key });
    expect(ad.diff.added).toBeGreaterThan(0);
    expect(ad.diff.lines.some((l) => l.op === '+' && l.text.includes('background:#e8f4ff'))).toBe(true);

    // Files over HTTP (signed-in only); the rendered HTML is served as text, never as a page on this origin.
    const agent = supertest(createApp(c));
    expect((await agent.get(`/api/changes/captures/${cmp.to!.id}/image`)).status).toBe(401);
    const token = (await agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    const auth = { Authorization: `Bearer ${token}` };
    const img = await agent.get(`/api/changes/captures/${cmp.to!.id}/image`).set(auth).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((img.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    expect((await agent.get(`/api/changes/captures/${cmp.to!.id}/diff`).set(auth)).status).toBe(200);
    expect((await agent.get(`/api/changes/captures/${cmp.from!.id}/diff`).set(auth)).status).toBe(404); // first capture: no diff image
    const html = await agent.get(`/api/changes/captures/${cmp.to!.id}/html`).set(auth);
    expect(html.headers['content-type']).toContain('text/plain');
    expect(html.headers['content-disposition']).toContain('attachment');
    // Only this website's pages.
    expect((await agent.post('/api/changes/captures').set(auth).send({ urls: ['https://example.com/'] })).status).toBe(400);
  }, 120_000);

  it.skipIf(!HAVE_CHROME)('after a crawl, the watched pages and the most important changed pages are captured', async () => {
    const { site: s, container: c } = await setup({ CHANGE_CAPTURE_AFTER_CRAWL: 'true', CHANGE_CAPTURE_CHANGED_PAGES: '2' });
    await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual');
    await c.services.crawls.idle();
    await c.services.captures.idle();
    let pages = await c.services.captures.pages(SYSTEM_ACTOR);
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual(['/']); // no baseline yet: only the watched homepage
    s.opts.longTitle = ['/products/vegetable-chopper'];
    await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual');
    await c.services.crawls.idle();
    await c.services.captures.idle();
    pages = await c.services.captures.pages(SYSTEM_ACTOR);
    expect(pages.map((p) => new URL(p.url).pathname)).toContain('/products/vegetable-chopper');
    const home = (await c.services.captures.list(SYSTEM_ACTOR, `${s.origin}/`)).filter((x) => x.viewport === 'desktop');
    expect(home).toHaveLength(2);
    expect(home[0].trigger).toBe('after_crawl');
    expect(home[0].diff?.previousId).toBe(home[1].id);
  }, 120_000);
});

describe('page captures when no browser is available', () => {
  it('says so instead of pretending', async () => {
    const { site: s, container: c } = await setup({ LIGHTHOUSE_CHROME_PATH: '/nonexistent/chrome' });
    const st = await c.services.captures.status(SYSTEM_ACTOR);
    expect(st.available).toBe(false);
    expect(st.problems.join(' ')).toContain('No Chrome / Chromium');
    await expect(c.services.captures.request(SYSTEM_ACTOR, { urls: [`${s.origin}/`] })).rejects.toThrow(/not available on this server/);
    const cmp = await c.services.captures.compare(SYSTEM_ACTOR, { url: `${s.origin}/` });
    expect(cmp.to).toBeNull();
    expect(cmp.visual).toMatchObject({ available: false });
    expect(cmp.visual.reason).toContain('No desktop screenshot of this page yet');
  });
});
