import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { auditPage, type ImageOccurrencesResponse } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { linkErrorType, repeatedImagesOf } from '../../src/crawler/engine';
import { createApp } from '../../src/http/app';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';
import { HAVE_GO } from './goHelpers';

/**
 * Every finding names the exact page, element and related pages (local fixtures only, 127.0.0.1):
 * images repeated on one page with each copy and its HTML location (reuse across pages is not flagged), duplicate
 * titles / H1s with every page sharing them, broken links with destination, status and error type.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const DUP_TITLE = ['/products/led-fairy-lights-10m', '/products/artificial-money-plant', '/products/adhesive-wall-hooks'];
const REPEAT_ON = '/products/vegetable-chopper';
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => {
  await container?.services.imageAudits.idle();
  await container?.services.crawls.idle();
  await site?.close();
  site = undefined;
  container = undefined;
});

const envFor = (base: string, engine: 'go' | 'node') => loadEnv({
  NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'd'.repeat(40), LOG_LEVEL: 'silent', CRAWLER_BASE_URL: base, CRAWLER_ENGINE: engine,
  CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0', CHANGE_SNAPSHOT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'details-')),
  ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
});

describe('helpers', () => {
  it('groups only images repeated on the same page, with every instance in page order', () => {
    const rep = repeatedImagesOf([
      { src: 'https://cdn.test/a.jpg', alt: 'A', inMain: true, index: 0 },
      { src: 'https://cdn.test/b.jpg', alt: null, inMain: true, index: 1 },
      { src: 'https://cdn.test/a.jpg#zoom', alt: '', inMain: false, location: 'footer', index: 2 },
    ]);
    expect(rep).toEqual([{ src: 'https://cdn.test/a.jpg', count: 2, instances: [expect.objectContaining({ position: 1, alt: 'A', inMain: true }), expect.objectContaining({ position: 3, alt: '', inMain: false, location: 'footer' })] }]);
    expect(linkErrorType(404)).toBe('Not found (404)');
    expect(linkErrorType(null)).toMatch(/No response/);
    expect(linkErrorType(503)).toBe('Server error (503)');
  });
});

describe.each(HAVE_GO ? (['go', 'node'] as const) : (['node'] as const))('issue details (%s engine)', (engine) => {
  it('records repeated images, all duplicate pages and broken-link details', async () => {
    site = await startFixtureSite({ repeatedBadge: [REPEAT_ON], duplicateTitle: DUP_TITLE, deletedProducts: ['building-blocks-100'], slowMs: 20 });
    const s = site;
    container = await createContainer({ env: envFor(s.origin, engine) });
    const c = container;
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full');
    await c.services.crawls.idle();
    expect((await c.repos.crawls.get(run.id))!.outcome).toBe('completed');
    const badge = `${s.origin}/cdn/img/secure-badge.webp`;

    // ---- the image repeated on one page: both copies, where each sits, their ALT
    const chopper = await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}${REPEAT_ON}`);
    expect(chopper.row.repeatedImages).toEqual([{
      src: badge, count: 2, instances: [
        expect.objectContaining({ alt: 'Secure checkout', inMain: true, location: 'main › section "trust" › .trust-badge' }),
        expect.objectContaining({ alt: '', inMain: false, location: 'footer › section "footer" › .footer__payment' }),
      ],
    }]);
    expect(chopper.row.repeatedImages![0].instances[0].position).toBeLessThan(chopper.row.repeatedImages![0].instances[1].position);
    expect(chopper.audit.checks.find((x) => x.id === 'images-repeated')).toMatchObject({ status: 'warn', items: [`${badge} — 2×`] });
    // The same badge once on every other page: reused across pages, not a page finding.
    const other = await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}/products/silicone-spatula-set`);
    expect(other.row.repeatedImages ?? []).toEqual([]);
    expect(other.audit.checks.some((x) => x.id === 'images-repeated')).toBe(false);

    // ---- duplicate title: the shared text, every other page and the exact total
    const dup = await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}${DUP_TITLE[0]}`);
    expect(dup.duplicates?.title.text).toBe('Wholesale Products Online at Best Price | DeoDap');
    expect([...dup.duplicates!.title.urls].sort()).toEqual(DUP_TITLE.slice(1).map((p) => `${s.origin}${p}`).sort());
    expect(dup.duplicates!.title.total).toBe(2);
    expect(dup.audit.checks.some((x) => x.id === 'title-duplicate')).toBe(true);
    // The tracked issue lists the group once with every page of it.
    const issues = await c.repos.issues.list();
    const titleIssue = issues.find((i) => i.checkId === 'ONP-TITLE' && i.affectedUrls.some((u) => u.endsWith(DUP_TITLE[0])))!;
    const ev = titleIssue.evidence.filter((e) => e.data?.duplicateOf === 'title');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ text: 'Wholesale Products Online at Best Price | DeoDap', total: 3 });
    expect([...(ev[0].data!.urls as string[])].sort()).toEqual(DUP_TITLE.map((p) => `${s.origin}${p}`).sort());

    // ---- broken links: source page, destination, status and error type
    const toys = await c.services.crawls.page(SYSTEM_ACTOR, run.id, `${s.origin}/collections/toys`);
    expect(toys.row.brokenLinkDetails).toEqual([{ url: `${s.origin}/products/building-blocks-100`, status: 404, error: 'Not found (404)' }]);
    expect(auditPage(toys.row).checks.find((x) => x.id === 'broken-links')?.items).toEqual([`${s.origin}/products/building-blocks-100`]);

    if (engine !== 'go') return;
    // ---- Image Audit: same-page repeats are distinguished from reuse across pages
    const job = await c.services.imageAudits.start(SYSTEM_ACTOR, run.id);
    await c.services.imageAudits.idle();
    const item = (await c.services.imageAudits.list(SYSTEM_ACTOR, job.id, { q: 'secure-badge' })).rows[0];
    expect(item.repeatedPages).toBe(1);
    expect(item.maxPerPage).toBe(2);
    expect(item.issues).toContain('repeated');
    expect(item.refs).toBe(item.pageCount + 1);
    // A banner on every page, once each, is reused, not repeated.
    const banner = (await c.services.imageAudits.list(SYSTEM_ACTOR, job.id, {})).rows.filter((r) => r.pageCount > 1 && r.url !== badge);
    for (const b of banner) expect(b.issues, b.url).not.toContain('repeated');

    const agent = supertest(createApp(c));
    const login = await agent.post('/api/auth/login').send(ADMIN);
    const auth = { Authorization: `Bearer ${login.body.token}` };
    const rep = (await agent.get(`/api/image-audits/${job.id}/occurrences`).query({ url: badge, repeated: '1' }).set(auth).expect(200)).body as ImageOccurrencesResponse;
    expect(rep).toMatchObject({ available: true, pages: item.pageCount, repeatedPages: 1, references: item.refs, total: 1 });
    expect(rep.rows).toEqual([{ page: `${s.origin}${REPEAT_ON}`, count: 2, instances: [
      expect.objectContaining({ alt: 'Secure checkout', location: 'main › section "trust" › .trust-badge', inMain: true }),
      expect.objectContaining({ alt: '', location: 'footer › section "footer" › .footer__payment', inMain: false }),
    ] }]);
    // Every page showing it, paged.
    const all = (await agent.get(`/api/image-audits/${job.id}/occurrences`).query({ url: badge, limit: 5 }).set(auth).expect(200)).body as ImageOccurrencesResponse;
    expect(all.total).toBe(item.pageCount);
    expect(all.rows).toHaveLength(5);
    const rest = (await agent.get(`/api/image-audits/${job.id}/occurrences`).query({ url: badge, offset: 5, limit: 500 }).set(auth).expect(200)).body as ImageOccurrencesResponse;
    const pages = new Set([...all.rows, ...rest.rows].map((r) => r.page));
    expect(pages.size).toBe(item.pageCount);
    await agent.get(`/api/image-audits/${job.id}/occurrences`).query({ url: `${s.origin}/cdn/img/not-on-site.webp` }).set(auth).expect(404);
  });
});
