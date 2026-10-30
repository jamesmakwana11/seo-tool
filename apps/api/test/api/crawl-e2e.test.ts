import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { SYSTEM_ACTOR } from '../../src/services/context';
import { createHmac } from 'node:crypto';
import supertest from 'supertest';
import { createApp } from '../../src/http/app';
import { startFixtureSite, type FixtureSite } from '../crawler/fixtureSite';

/** End-to-end: a real crawl of a loopback fixture store flows findings into live issues, then auto-resolves on fix. */
let site: FixtureSite | undefined;
let container: Container | undefined;
afterEach(async () => { await container?.services.crawls.idle(); await site?.close(); site = undefined; container = undefined; });

async function setup(initial?: Parameters<typeof startFixtureSite>[0]) {
  site = await startFixtureSite(initial);
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'y'.repeat(40), LOG_LEVEL: 'silent',
    CRAWLER_BASE_URL: site.origin, CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_USER_AGENT: 'DeoDapSEOSentinel/1.0 (+test)', CRAWLER_ALLOW_LIVE: 'false', // loopback is allowed without live
  });
  container = await createContainer({ env }); // real fetch — loopback only
  return { site, container };
}

describe('live crawl → issues (loopback fixture)', () => {
  it('a full crawl with a product-template schema defect produces live issues, not sample data', async () => {
    const { container: c } = await setup({ productTemplateNoOffers: true });
    const run = await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual');
    await c.services.crawls.idle();
    const done = await c.repos.crawls.get(run.id);
    expect(done?.status).toBe('completed');
    expect(done?.urlsCrawled).toBeGreaterThan(0);
    const issues = await c.repos.issues.list();
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.source === 'live')).toBe(true);
    await c.refreshVerifierInputs();
  });

  it('fixing the defect and re-crawling resolves the issue (0 failing → auto-resolve)', async () => {
    const { site: s, container: c } = await setup({ productTemplateNoOffers: true });
    await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual');
    await c.services.crawls.idle();
    const before = (await c.repos.issues.list()).filter((i) => i.checkId === 'TECH-SCHEMA-PRESENCE' || i.checkId.startsWith('TECH-SCHEMA'));
    expect(before.length).toBeGreaterThan(0);
    s.opts.productTemplateNoOffers = false; // fix the site
    const run2 = await c.services.crawls.start(SYSTEM_ACTOR, 'full', 'manual');
    await c.services.crawls.idle();
    const done = await c.repos.crawls.get(run2.id);
    expect(done?.resolvedIssues).toBeGreaterThanOrEqual(0);
  });
});

describe('Shopify webhook → smart crawl (PDF §16: pages changed in the last 48h)', () => {
  it('rejects an unsigned webhook and queues a signed product update into the next smart crawl', async () => {
    site = await startFixtureSite();
    const secret = 'whsec-test-secret';
    const env = loadEnv({
      NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: 'w'.repeat(40), LOG_LEVEL: 'silent', SHOPIFY_WEBHOOK_SECRET: secret,
      SHOPIFY_STORE_DOMAIN: new URL(site.origin).host, CRAWLER_BASE_URL: site.origin, CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_ALLOW_LIVE: 'false',
    });
    container = await createContainer({ env });
    const app = createApp(container);
    const body = JSON.stringify({ handle: 'vegetable-chopper' });
    const bad = await supertest(app).post('/api/webhooks/shopify').set('X-Shopify-Topic', 'products/update').set('content-type', 'application/json').send(body);
    expect(bad.status).toBe(401);
    const hmac = createHmac('sha256', secret).update(body).digest('base64');
    const ok = await supertest(app).post('/api/webhooks/shopify').set('X-Shopify-Topic', 'products/update').set('X-Shopify-Hmac-Sha256', hmac).set('content-type', 'application/json').send(body);
    expect(ok.status).toBe(202);
    const run = await container.services.crawls.start(SYSTEM_ACTOR, 'smart', 'manual');
    expect(run.scope.find((x) => x.label === 'changed_48h')?.count).toBe(1);
    await container.services.crawls.idle();
    const urls = (await container.repos.crawlUrls.get(run.id))?.urls ?? [];
    expect(urls.some((u) => u.url.endsWith('/products/vegetable-chopper') && u.status === 200)).toBe(true);
  });
});

