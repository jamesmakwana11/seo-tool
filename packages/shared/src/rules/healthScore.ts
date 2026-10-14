import type { AuditModule, HealthScore, Issue, ModuleScore, PageTier, ScoreModule, SentinelConfig, Severity, DataSource } from '../types';
import { SCORE_MODULE_LABELS } from '../config';
import { isIssueOpen } from './escalation';

export function scoreModuleOf(m: AuditModule): ScoreModule {
  switch (m) {
    case 'content':
    case 'ai_compliance':
      return 'content_ai';
    default:
      return m;
  }
}

export const SCORE_MODULES: ScoreModule[] = ['technical', 'onpage', 'content_ai', 'performance', 'offpage', 'aeo', 'geo'];

/**
 * PDF §14: each module score = 100 − severity-weighted open issues normalized by site size,
 * Tier 1 issues weighted 5×. Composite = Technical 30% · On-Page 20% · Content & AI 15% ·
 * Performance/CWV 10% · Off-Page 10% · AEO 8% · GEO 7%.
 *
 * Normalization (WORKSHOP-configurable): penalty P = Σ severityWeight × tierMultiplier over open
 * issues; score = 100 × (1 − P / (P + K × siteSize)). This keeps scores in 0–100, scales with site
 * size, and makes fixing a Tier-1 Critical move the score visibly (PDF §14 "motivation instrument").
 * Template-group parents are counted; their superseded children are not (no double counting).
 */
export function computeHealthScore(
  issues: Pick<Issue, 'module' | 'severity' | 'status' | 'highestTier' | 'issueClass'>[],
  siteSize: number,
  cfg: SentinelConfig,
  at = new Date(),
  source: DataSource = 'demo',
): HealthScore {
  const { severityWeights, tierMultipliers, normalizationK, weights } = cfg.scoring;
  const acc = new Map<ScoreModule, { p: number; c: Record<Severity, number> }>();
  for (const m of SCORE_MODULES) acc.set(m, { p: 0, c: { critical: 0, medium: 0, low: 0 } });
  for (const i of issues) {
    if (!isIssueOpen(i.status) || i.issueClass === 'opportunity') continue;
    const a = acc.get(scoreModuleOf(i.module))!;
    a.p += severityWeights[i.severity] * tierMultipliers[i.highestTier as PageTier];
    a.c[i.severity] += 1;
  }
  const denomBase = normalizationK * Math.max(1, siteSize);
  const modules: ModuleScore[] = SCORE_MODULES.map((m) => {
    const a = acc.get(m)!;
    const score = round1(100 * (1 - a.p / (a.p + denomBase)));
    return {
      module: m, label: SCORE_MODULE_LABELS[m], weight: weights[m], score,
      contribution: round1(score * weights[m]), openIssues: a.c, penalty: round1(a.p),
    };
  });
  const totalW = SCORE_MODULES.reduce((s, m) => s + weights[m], 0) || 1;
  const score = round1(modules.reduce((s, m) => s + m.score * m.weight, 0) / totalW);
  return { at: at.toISOString(), score, modules, siteSize, source };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
