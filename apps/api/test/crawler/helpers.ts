import { defaultConfig, getCheck, type Issue, type SentinelConfig } from '@sentinel/shared';
import { createCrawlEngine, type CrawlEngineOptions } from '../../src/crawler/engine';
import type { Finding } from '../../src/services/ports';

export const UA = 'DeoDapSEOSentinel/1.0 (+internal audit)';

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export function makeEngine(baseUrl: string | undefined, over: Partial<CrawlEngineOptions> = {}, cfgOver?: (c: SentinelConfig) => void) {
  const config = defaultConfig(new Date('2026-10-12T00:00:00Z'));
  cfgOver?.(config);
  return createCrawlEngine({
    // retries: 0 — these tests check detection; retry behaviour has its own tests (resilience.test.ts).
    baseUrl, allowLive: false, userAgent: UA, timeoutMs: 800, concurrency: 6, respectRobots: true, retries: 0,
    thresholds: config.thresholds, config, log: silentLog, now: () => new Date('2026-10-12T00:00:00Z'), ...over,
  });
}

export const tier2 = () => 2 as const;

export function findingsFor(findings: Finding[], checkId: string, template?: string): Finding[] {
  return findings.filter((f) => f.checkId === checkId && (template === undefined || f.template === template));
}

export function urlsOf(findings: Finding[]): string[] {
  return [...new Set(findings.flatMap((f) => f.urls))];
}

/** Minimal Issue built from a finding (what the issue service would persist). */
export function issueFromFinding(f: Finding, id = 'ISS-0001'): Issue {
  const c = getCheck(f.checkId);
  const now = '2026-10-12T00:00:00.000Z';
  return {
    id, checkId: f.checkId, module: c.module, title: f.title, summary: f.summary, severity: 'medium', severityRationale: '', issueClass: 'medium',
    status: 'FIXED', delta: 'new', template: f.template, affectedUrls: f.urls, affectedCount: f.urls.length, highestTier: 2, tierBreakdown: { 1: 0, 2: f.urls.length, 3: 0 },
    businessImpact: '', detectedAt: now, firstSeenAt: now, lastSeenAt: now, slaDueAt: now, occurrences: 1, recommendedTeam: c.ownerTeam, allocation: [],
    severityHistory: [], evidence: f.evidence.map((e, i) => ({ ...e, id: `ev-${i}`, capturedAt: now, source: 'live' as const })), source: 'live',
  };
}
