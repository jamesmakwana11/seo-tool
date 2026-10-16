/** A check that never runs must never be shown as "Pass" on the module screens. */
import { describe, expect, it } from 'vitest';
import { buildModuleData, CHECKS, CHECKS_NOT_BUILT, createSeed, type SentinelView } from '@sentinel/shared';
import { ANALYZERS, NOT_EVALUATED } from '../../src/analysis/analyzers';

/** Checks fed by connector syncs instead of crawl analyzers. */
const FROM_SYNCS = new Set(['PERF-CRUX', 'ONP-STRIKING']);

describe('check status honesty', () => {
  const run = new Set(ANALYZERS.map((a) => a.checkId));

  it('every PDF check either runs (crawl analyzer or data sync) or is listed as not built — never both', () => {
    for (const c of CHECKS) {
      const runs = run.has(c.id) || FROM_SYNCS.has(c.id);
      expect(runs !== !!CHECKS_NOT_BUILT[c.id], `${c.id}: runs=${runs}, listed as not built=${!!CHECKS_NOT_BUILT[c.id]}`).toBe(true);
    }
    for (const id of Object.keys(NOT_EVALUATED)) expect(CHECKS_NOT_BUILT[id], id).toBeTruthy();
  });

  it('module screens show never-run checks as "not built" with the reason, and nothing as passing before a crawl', () => {
    const seed = createSeed(new Date('2026-10-16T05:00:00Z'));
    const base = { ...seed, issues: [], siteSize: 100, liveSources: { gsc: true, ga4: true, crux: true, backlinks: true, ai_engines: true, shopify: true, gbp: true, crawler: true } } as unknown as SentinelView;
    const onpage = buildModuleData(base, 'onpage', new Date(), false);
    const km = onpage.checks.find((c) => c.id === 'ONP-KEYWORD-MAP')!;
    expect(km.lastStatus).toBe('not_built');
    expect(km.unavailableReason).toMatch(/keyword map/);
    for (const m of ['technical', 'onpage', 'content', 'offpage', 'aeo', 'geo', 'ai_compliance', 'performance'] as const) {
      for (const c of buildModuleData(base, m, new Date(), false).checks) {
        if (CHECKS_NOT_BUILT[c.id]) expect(c.lastStatus, c.id).toBe('not_built');
      }
    }
    const noCrawl = buildModuleData({ ...base, liveSources: { ...base.liveSources, crawler: false } } as SentinelView, 'onpage', new Date(), false);
    expect(noCrawl.checks.find((c) => c.id === 'ONP-TITLE')!.lastStatus).toBe('awaiting_crawl');
    expect(noCrawl.checks.some((c) => c.lastStatus === 'pass')).toBe(false);
  });
});
