import type { Issue, IssueStatus, PageTemplate, PageTier, SentinelConfig, Severity } from '../types';
import { slaDueAt } from './sla';

export const OPEN_ISSUE_STATUSES: IssueStatus[] = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'FIXED'];
export const isIssueOpen = (s: IssueStatus) => OPEN_ISSUE_STATUSES.includes(s);

export interface EscalationAction {
  issueId: string;
  from: Severity;
  to: Severity;
  rule: 'tier_promotion' | 'sla_breach';
  reason: string;
  newSlaDueAt: string;
  realert: boolean;
}

/**
 * PDF §3.3 automatic escalation:
 *  - A Medium issue on a page that enters Tier 1 → Critical.
 *  - Any Medium issue unresolved past its SLA → escalates one level and re-alerts.
 * `previousTier` is the issue's highest tier before tonight's tier recomputation.
 */
export function evaluateEscalations(
  issues: Pick<Issue, 'id' | 'severity' | 'status' | 'highestTier' | 'slaDueAt' | 'isTemplateGroup'>[],
  now: Date,
  cfg: SentinelConfig,
  previousTier: Record<string, PageTier | undefined> = {},
): EscalationAction[] {
  const actions: EscalationAction[] = [];
  for (const iss of issues) {
    if (iss.severity !== 'medium' || !isIssueOpen(iss.status) || iss.status === 'FIXED') continue;
    const prev = previousTier[iss.id];
    if (cfg.escalation.tier1PromotionEscalates && iss.highestTier === 1 && prev !== undefined && prev !== 1) {
      actions.push({
        issueId: iss.id, from: 'medium', to: 'critical', rule: 'tier_promotion',
        reason: `Affected page entered Tier 1 (was Tier ${prev}).`,
        newSlaDueAt: slaDueAt('critical', now, cfg).toISOString(), realert: true,
      });
      continue;
    }
    if (cfg.escalation.mediumBreachEscalates && new Date(iss.slaDueAt).getTime() < now.getTime()) {
      actions.push({
        issueId: iss.id, from: 'medium', to: 'critical', rule: 'sla_breach',
        reason: `Unresolved past its ${cfg.sla.mediumDays}-day Medium SLA — escalated one level and re-alerted.`,
        newSlaDueAt: slaDueAt('critical', now, cfg).toISOString(), realert: true,
      });
    }
  }
  return actions;
}

export interface TemplateGroupProposal {
  checkId: string;
  template: PageTemplate;
  issueIds: string[];
  reason: string;
}

/**
 * PDF §3.3: three or more related Medium issues on one template (e.g. all product
 * pages missing `offers` schema) → grouped into one Critical template-level issue.
 * "Related" = same check on the same template.
 */
export function proposeTemplateGroups(
  issues: Pick<Issue, 'id' | 'checkId' | 'template' | 'severity' | 'status' | 'groupId' | 'isTemplateGroup'>[],
  cfg: SentinelConfig,
): TemplateGroupProposal[] {
  const buckets = new Map<string, string[]>();
  for (const i of issues) {
    if (i.isTemplateGroup || i.groupId || !i.template || i.severity !== 'medium' || !isIssueOpen(i.status)) continue;
    const key = `${i.checkId}::${i.template}`;
    const arr = buckets.get(key) ?? [];
    arr.push(i.id);
    buckets.set(key, arr);
  }
  const out: TemplateGroupProposal[] = [];
  for (const [key, ids] of buckets) {
    if (ids.length >= cfg.escalation.templateGroupThreshold) {
      const [checkId, template] = key.split('::') as [string, PageTemplate];
      out.push({
        checkId, template, issueIds: ids,
        reason: `${ids.length} related Medium issues on the ${template} template (threshold ${cfg.escalation.templateGroupThreshold}) — template bugs multiply.`,
      });
    }
  }
  return out;
}

/** PDF §11.1a / §12.4: Criticals still unallocated past 24h. */
export function unallocatedPastThreshold(
  issues: Pick<Issue, 'id' | 'severity' | 'status' | 'allocatedTeam' | 'detectedAt' | 'severityHistory' | 'isTemplateGroup' | 'supersededById'>[],
  now: Date,
  cfg: SentinelConfig,
  severities: Severity[] = ['critical'],
) {
  const limitMs = cfg.escalation.unallocatedCriticalHours * 3600 * 1000;
  return issues
    .filter((i) => severities.includes(i.severity) && i.status === 'NEW' && !i.allocatedTeam && !i.supersededById)
    .map((i) => {
      // The clock starts when the issue became Critical (detection, or a later escalation).
      const becameCritical = [...(i.severityHistory ?? [])].reverse().find((h) => h.to === 'critical')?.at;
      const since = becameCritical && becameCritical > i.detectedAt ? becameCritical : i.detectedAt;
      return { id: i.id, hours: Math.round(((now.getTime() - new Date(since).getTime()) / 3600000) * 10) / 10 };
    })
    .filter((x) => x.hours * 3600000 > limitMs);
}
