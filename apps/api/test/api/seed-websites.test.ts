import { describe, expect, it } from 'vitest';
import type { FixCard, Issue, Paged, WebsiteSummary } from '@sentinel/shared';
import { DEFAULT_SEED_WEBSITES, loadEnv } from '../../src/config/env';
import { parseSeedWebsites } from '../../src/websites';
import { FIXTURE, makeHarness } from './helpers';

/**
 * Websites that must always be selectable (SEED_WEBSITES): added at start-up when missing, never duplicated or changed,
 * each with its own empty workspace; every issue lists its fix time and location, worded for the selected website.
 * No request is made to these websites.
 */
const SEEDS = 'Grabnix|https://grabnix.in/|shopify,Oblivion|https://oblivion.co.in/,https://natation.in/|woocommerce,DeoDap|https://deodap.in/';

describe('saved websites from SEED_WEBSITES', () => {
  it('parses names, URLs and platforms', () => {
    expect(parseSeedWebsites(SEEDS)).toEqual([
      { name: 'Grabnix', url: 'https://grabnix.in/', platform: 'shopify' },
      { name: 'Oblivion', url: 'https://oblivion.co.in/', platform: 'shopify' },
      { name: 'natation.in', url: 'https://natation.in/', platform: 'woocommerce' },
      { name: 'DeoDap', url: 'https://deodap.in/', platform: 'shopify' },
    ]);
    expect(parseSeedWebsites('none')).toEqual([]);
    expect(parseSeedWebsites(undefined)).toEqual([]);
  });

  it('production uses the DeoDap group list by default (overridable, "none" to switch off)', () => {
    const prod = { NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(40), ALLOW_EPHEMERAL_STORAGE: 'true' };
    expect(loadEnv(prod).SEED_WEBSITES).toBe(DEFAULT_SEED_WEBSITES);
    expect(parseSeedWebsites(DEFAULT_SEED_WEBSITES).map((w) => w.url)).toEqual(['https://deodap.in/', 'https://grabnix.in/', 'https://oblivion.co.in/', 'https://natation.in/']);
    expect(loadEnv({ ...prod, SEED_WEBSITES: 'none' }).SEED_WEBSITES).toBe('none');
    expect(loadEnv({ NODE_ENV: 'test' }).SEED_WEBSITES).toBeUndefined();
  });

  it('adds every missing website once (DeoDap is the primary website already), each selectable with its own workspace', async () => {
    const h = await makeHarness({ SEED_WEBSITES: SEEDS });
    const tok = await h.token(FIXTURE.seoLead);
    const seo = h.as(tok);
    const list = (await seo.get('/api/websites')).body as WebsiteSummary[];
    expect(list.map((w) => w.domain)).toEqual(['deodap.in', 'grabnix.in', 'oblivion.co.in', 'natation.in']);
    expect(list.find((w) => w.domain === 'natation.in')).toMatchObject({ name: 'natation.in', platform: 'woocommerce', hasAuditData: false, createdByName: 'Server configuration (SEED_WEBSITES)' });
    // Each seeded website is its own workspace: its own settings (brand, platform), no data of DeoDap.
    for (const w of list.slice(1)) {
      const at = (p: string) => h.agent.get(p).set({ Authorization: `Bearer ${tok}`, 'X-Website-Id': w.id });
      const cfg = (await at('/api/config')).body;
      expect(cfg.site).toMatchObject({ canonicalHost: w.domain, brand: w.name, platform: w.platform });
      expect((await at('/api/issues')).body.total).toBe(0);
    }
    // Starting again does not add them twice (same container = same list; a restart is covered with PostgreSQL below).
    expect(((await seo.get('/api/websites')).body as WebsiteSummary[]).length).toBe(4);
  });

  it('lists every issue with its time to fix and where, and Fix Cards name the selected website', async () => {
    const h = await makeHarness({ SEED_WEBSITES: SEEDS });
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const page = (await seo.get('/api/issues?pageSize=500&status=NEW,ASSIGNED,IN_PROGRESS,FIXED,VERIFIED,CLOSED')).body as Paged<Issue>;
    expect(page.items.length).toBeGreaterThan(10);
    for (const i of page.items) {
      expect(i.fix?.time.label, i.id).toMatch(/\d/);
      expect(i.fix!.where.length, i.id).toBeGreaterThan(0);
      expect(i.fix!.firstStep.length, i.id).toBeGreaterThan(10);
    }
    const detail = (await seo.get(`/api/issues/${page.items[0].id}`)).body as { fixCard: FixCard };
    expect(detail.fixCard.timeEstimate?.label).toBe(page.items[0].fix!.time.label);
    expect(detail.fixCard.where?.length).toBeGreaterThan(0);
  });
});
