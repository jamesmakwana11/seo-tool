import { describe, expect, it } from 'vitest';
import {
  CHECKS, PLAYBOOK_BY_CHECK, auditPage, defaultConfig, fixTime, generateFixCard, imageIssueFix, issueFixSummary, pageCheckFix,
  slaDueAt, type CrawledUrl, type ImageIssueId, type Issue, type SentinelConfig,
} from '../src';

/**
 * Every finding says what to change, where, how long it takes and how to verify it: Fix Cards for every check (no
 * generic steps), page-audit findings and Image Audit problems — worded for the selected website (brand, platform).
 */
const NOW = new Date('2026-10-24T06:00:00Z');
const base = defaultConfig(new Date('2026-10-01T00:00:00Z'));
const site = (brand: string, host: string, platform?: SentinelConfig['site']['platform']): SentinelConfig => ({ ...base, site: { ...base.site, brand, canonicalHost: host, baseUrl: `https://${host}`, ...(platform ? { platform } : {}) } });

function issue(p: Partial<Issue>): Issue {
  return {
    id: 'ISS-1', checkId: 'ONP-META', module: 'onpage', title: 't', summary: 's', severity: 'low', severityRationale: '', issueClass: 'low', status: 'NEW', delta: 'new',
    template: 'product', affectedUrls: ['https://shop.test/products/a'], affectedCount: 1, highestTier: 2, tierBreakdown: { 1: 0, 2: 1, 3: 0 }, businessImpact: '',
    detectedAt: NOW.toISOString(), firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), slaDueAt: slaDueAt('low', NOW, base).toISOString(), occurrences: 1,
    recommendedTeam: 'content', allocation: [], severityHistory: [], evidence: [{ id: 'e', kind: 'note', label: 'x', content: 'x', capturedAt: NOW.toISOString(), source: 'live' }], source: 'live',
    ...p,
  };
}

describe('Fix Cards: specific fix, where, time, verification for every check', () => {
  it('every check in the library has its own playbook (no generic "apply the remediation" steps)', () => {
    const missing = CHECKS.filter((c) => !PLAYBOOK_BY_CHECK[c.id]).map((c) => c.id);
    expect(missing).toEqual([]);
    for (const c of CHECKS) {
      const card = generateFixCard(issue({ checkId: c.id, module: c.module }), base, { now: NOW });
      expect(card.playbookId.startsWith('PB-GENERIC'), c.id).toBe(false);
      expect(card.steps.length, c.id).toBeGreaterThan(0);
      expect(card.steps.some((s) => /appropriate to|Review the evidence and affected URLs for/.test(s.text)), c.id).toBe(false);
      expect(card.where?.length, `${c.id} where`).toBeGreaterThan(0);
      expect(card.where!.some((w) => w.kind !== 'seo-tool'), `${c.id} names a place outside SEO Sentinel`).toBe(true);
      expect(card.timeEstimate!.maxMinutes, c.id).toBeGreaterThan(card.timeEstimate!.minMinutes);
      expect(card.timeEstimate!.label, c.id).toMatch(/\d/);
      expect(card.verifyBy.length, c.id).toBeGreaterThan(10);
      expect(card.completeness.complete, `${c.id}: ${card.completeness.missing.join(',')}`).toBe(true);
    }
  });

  it('a minor metadata fix on one page takes minutes; on many pages it scales and suggests a bulk edit', () => {
    const one = generateFixCard(issue({ checkId: 'ONP-META' }), base, { now: NOW });
    expect(one.timeEstimate!.label).toBe('10–15 min');
    expect(one.timeEstimate!.maxMinutes).toBeLessThanOrEqual(15);
    expect(one.where!.map((w) => w.label)).toContain('Shopify admin');
    const many = generateFixCard(issue({ checkId: 'ONP-META', affectedCount: 120, affectedUrls: Array.from({ length: 120 }, (_, i) => `https://shop.test/products/p${i}`) }), base, { now: NOW });
    expect(many.timeEstimate!.minMinutes).toBeGreaterThanOrEqual(600);
    expect(many.timeEstimate!.basis).toMatch(/120 pages.*bulk edit/);
  });

  it('a template-level or technical fix is estimated in hours, with the theme as the place to change', () => {
    const card = generateFixCard(issue({ checkId: 'TECH-ROBOTS', module: 'technical', severity: 'critical', recommendedTeam: 'development' }), base, { now: NOW });
    expect(card.where!.some((w) => w.kind === 'theme-code' && /robots\.txt\.liquid/.test(w.path ?? ''))).toBe(true);
    expect(card.where!.some((w) => w.kind === 'search-console')).toBe(true);
    const cwv = generateFixCard(issue({ checkId: 'PERF-CRUX', module: 'performance', recommendedTeam: 'development' }), base, { now: NOW });
    expect(cwv.timeEstimate!.label).toMatch(/h$/);
  });

  it('is worded for the selected website: its brand, not DeoDap; no DeoDap selling points for other stores', () => {
    const g = site('Grabnix', 'grabnix.in');
    for (const checkId of ['ONP-META', 'ONP-IMAGES', 'CONT-PLAGIARISM', 'AEO-ENTITY', 'TECH-SCHEMA-PRESENCE', 'ONP-TITLE', 'TECH-THIN', 'AEO-FAQ']) {
      const card = generateFixCard(issue({ checkId }), g, { now: NOW, pageName: 'Steel Bottle' });
      const text = JSON.stringify(card);
      expect(text, checkId).not.toMatch(/DeoDap/);
      expect(text, checkId).not.toMatch(/No MOQ|No-MOQ|wholesale price|COD available/i);
    }
    expect(JSON.stringify(generateFixCard(issue({ checkId: 'ONP-IMAGES' }), g, { now: NOW }))).toMatch(/– Grabnix/);
    // DeoDap keeps its own selling points.
    expect(JSON.stringify(generateFixCard(issue({ checkId: 'ONP-META' }), base, { now: NOW, pageName: 'Steel Bottle' }))).toMatch(/No MOQ/);
  });

  it('follows the website\'s platform: locations become the platform\'s equivalents with a note', () => {
    const woo = generateFixCard(issue({ checkId: 'ONP-META' }), site('Natation', 'natation.in', 'woocommerce'), { now: NOW });
    expect(woo.platformNote).toMatch(/WooCommerce/);
    expect(woo.where!.map((w) => w.label)).toContain('WordPress admin');
    expect(woo.where!.map((w) => w.label)).not.toContain('Shopify admin');
    expect(generateFixCard(issue({ checkId: 'ONP-META' }), base, { now: NOW }).platformNote).toBeUndefined();
  });

  it('issue lists carry the time, where and first step', () => {
    const s = issueFixSummary(issue({ checkId: 'TECH-4XX', affectedCount: 3 }), base);
    expect(s.time.label).toMatch(/min/);
    expect(s.where.length).toBeGreaterThan(0);
    expect(s.firstStep).toMatch(/301/);
  });

  it('time ranges read naturally', () => {
    expect(fixTime(5, 15, '').label).toBe('5–15 min');
    expect(fixTime(60, 120, '').label).toBe('1–2 h');
    expect(fixTime(30, 90, '').label).toBe('30 min–1.5 h');
    expect(fixTime(4800, 9600, '').label).toBe('10–20 working days');
  });
});

describe('page-audit findings and Image Audit problems', () => {
  it('every warning and failure the page audit can raise has where, time and verification', () => {
    const rows: Partial<CrawledUrl>[] = [
      { status: 200, title: '', metaDescription: '', h1: [], wordCount: 20, canonical: undefined, indexable: false, flags: ['dup-title', 'dup-meta'], titleCount: 2, metaDescriptionCount: 2 },
      { status: 200, title: 'x'.repeat(90), metaDescription: 'short', h1: ['A', 'B'], wordCount: 900, canonical: 'https://shop.test/other', responseMs: 9000 },
      { status: 404 }, { status: 301, redirects: 1, finalUrl: 'https://shop.test/b' }, { status: null as unknown as number, error: 'timeout' },
    ];
    const ids = new Set<string>();
    for (const r of rows) for (const c of auditPage({ url: 'https://shop.test/products/a', reason: 'link', template: 'product', ...r } as CrawledUrl).checks) if (c.status === 'warn' || c.status === 'fail') ids.add(c.id);
    expect(ids.size).toBeGreaterThan(8);
    for (const id of ids) {
      const f = pageCheckFix(id, 'product');
      expect(f, id).toBeDefined();
      expect(f!.where.length, id).toBeGreaterThan(0);
      expect(f!.time.maxMinutes, id).toBeGreaterThan(f!.time.minMinutes);
      expect(f!.verify, id).toMatch(/crawl|Image Audit|report/i);
    }
    expect(pageCheckFix('meta-missing', 'collection')!.where[0].path).toMatch(/Collections → \{collection\} → Search engine listing/);
    expect(pageCheckFix('title-missing', 'product')!.time.label).toBe('5–10 min');
  });

  it('every Image Audit problem has where, time and verification', () => {
    const all: ImageIssueId[] = ['broken', 'failed', 'unverified', 'alt-missing', 'alt-empty', 'no-dimensions', 'not-lazy', 'heavy', 'legacy-format', 'oversized', 'redirect', 'duplicate', 'repeated'];
    for (const id of all) {
      const f = imageIssueFix(id);
      expect(f, id).toBeDefined();
      expect(f!.where.length, id).toBeGreaterThan(0);
      expect(f!.time.label, id).toMatch(/min|h/);
    }
    expect(imageIssueFix('alt-missing')!.time.label).toBe('2–5 min');
  });
});
