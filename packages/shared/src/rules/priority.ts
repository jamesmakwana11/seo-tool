import type { PageTier, SentinelConfig, Severity, TaskPriority } from '../types';

export interface PriorityInput {
  impactScore: number; // 1–5: traffic/revenue at risk
  confidence: number; // 0–1
  effortHours: number;
  tier: PageTier;
}

/**
 * PDF §11 step 4: Impact × Confidence × inverse Effort = priority score; ties broken by page tier.
 * Scale: impact 1–5, confidence 0–1, effort in hours (floored at cfg.priority.minEffortHours).
 * Result is multiplied by 10 and rounded to 2 dp for readability.
 */
export function priorityScore(p: PriorityInput, cfg: SentinelConfig): number {
  const [lo, hi] = cfg.priority.impactScale;
  const impact = Math.min(hi, Math.max(lo, p.impactScore));
  const conf = Math.min(1, Math.max(0, p.confidence));
  const effort = Math.max(cfg.priority.minEffortHours, p.effortHours);
  return Math.round(impact * conf * (1 / effort) * 10 * 100) / 100;
}

/** Sort comparator: higher score first; ties broken by better (lower) tier. */
export function comparePriority(a: { priorityScore: number; tier: PageTier }, b: { priorityScore: number; tier: PageTier }): number {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  return a.tier - b.tier;
}

/** Task priority mapped from severity (PDF §11.1a "priority mapped from severity"). */
export function taskPriorityFromSeverity(s: Severity | undefined): TaskPriority {
  return s === 'critical' ? 'P1' : s === 'medium' ? 'P2' : 'P3';
}
