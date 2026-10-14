import { describe, it, expect } from 'vitest';
import {
  defaultConfig, classifySeverity, slaDueAt, endOfIstDay, slaState, evaluateEscalations, proposeTemplateGroups,
  unallocatedPastThreshold, priorityScore, comparePriority, computeHealthScore, HEALTH_WEIGHTS, canTransition,
  availableActions, issueStatusForTask, CHECKS, PLAYBOOKS, generateFixCard, createSeed, evaluateRule, validateRule,
  EXAMPLE_RULES, findPatternHits, AI_BOILERPLATE_PATTERNS, AI_ARTIFACT_PATTERNS, YMYL_CLAIM_PATTERNS, keywordDensity,
  nearIdenticalClusters, taskPriorityFromSeverity, hasPermission, DEFAULT_PERMISSIONS, inferRootCause,
  type Issue, type CustomRule,
} from '../src';

const cfg = defaultConfig(new Date('2026-10-01T00:00:00Z'));
const NOW = new Date('2026-10-12T06:00:00Z'); // 11:30 IST

describe('Check library (PDF §4–§10 transcription)', () => {
  it('has unique ids and every row references a PDF page', () => {
    const ids = new Set(CHECKS.map((c) => c.id));
    expect(ids.size).toBe(CHECKS.length);
    for (const c of CHECKS) {
      expect(c.pdfRef.page).toBeGreaterThanOrEqual(4);
      expect(c.pdfRef.page).toBeLessThanOrEqual(15);
    }
  });
  it('contains all 12 built-in AI-compliance checks (PDF §10.1)', () => {
    expect(CHECKS.filter((c) => c.module === 'ai_compliance').map((c) => c.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `AIC-${String(i + 1).padStart(2, '0')}`),
    );
  });
  it('covers every PDF table row count per section', () => {
    const count = (g: string) => CHECKS.filter((c) => c.group.startsWith(g)).length;
    expect(count('4.1')).toBe(7);
    expect(count('4.2')).toBe(6);
    expect(count('4.3')).toBe(5);
    expect(count('4.4')).toBe(5);
    expect(count('4.5')).toBe(4);
    expect(count('4.6')).toBe(4);
    expect(count('5 ')).toBe(8);
    expect(count('6.1')).toBe(7);
    expect(count('6.2')).toBe(3);
    expect(count('6.3')).toBe(4);
    expect(count('7.1')).toBe(5);
    expect(count('7.2')).toBe(4);
    expect(count('8 ')).toBe(8);
    expect(count('9 ')).toBe(7);
  });
  it('has a DeoDap-specific playbook for every Critical/Medium/Low defect check', () => {
    const defects = CHECKS.filter((c) => ['critical', 'medium', 'low'].includes(c.issueClass));
    const pb = new Set(PLAYBOOKS.map((p) => p.checkId));
    const missing = defects.filter((c) => !pb.has(c.id)).map((c) => c.id);
    expect(missing).toEqual([]);
  });
});

describe('Severity classifier — check type × page value (PDF §3)', () => {
  it('noindex: Critical on Tier 1–2, Medium on Tier 3', () => {
    expect(classifySeverity({ checkId: 'TECH-NOINDEX', highestTier: 1 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-NOINDEX', highestTier: 2 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-NOINDEX', highestTier: 3 }, cfg).severity).toBe('medium');
  });
  it('4xx: Critical if Tier 1, backlinks, or 429 to search crawlers; else Medium', () => {
    expect(classifySeverity({ checkId: 'TECH-4XX', highestTier: 1 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-4XX', highestTier: 3, hasBacklinks: true }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-4XX', highestTier: 3, searchCrawlerAffected: true }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-4XX', highestTier: 2 }, cfg).severity).toBe('medium');
  });
  it('index coverage: Critical only above 2% drop', () => {
    expect(classifySeverity({ checkId: 'TECH-INDEX-COVERAGE', highestTier: 1, metric: 2.5 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-INDEX-COVERAGE', highestTier: 1, metric: 1.5 }, cfg).severity).toBe('medium');
  });
  it('crawl budget: Critical above 500 indexed duplicates', () => {
    expect(classifySeverity({ checkId: 'TECH-CRAWL-BUDGET', highestTier: 2, metric: 501 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-CRAWL-BUDGET', highestTier: 2, metric: 500 }, cfg).severity).toBe('medium');
  });
  it('redirect chains: Critical only on Tier 1', () => {
    expect(classifySeverity({ checkId: 'TECH-REDIRECTS', highestTier: 1, metric: 2 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'TECH-REDIRECTS', highestTier: 2, metric: 3 }, cfg).severity).toBe('medium');
  });
  it('CWV: Poor → Critical; Needs improvement → Medium', () => {
    expect(classifySeverity({ checkId: 'PERF-CRUX', highestTier: 1, cwvStatus: 'poor' }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'PERF-CRUX', highestTier: 1, cwvStatus: 'needs_improvement' }, cfg).severity).toBe('medium');
  });
  it('images: Medium Tier 1, Low Tier 3', () => {
    expect(classifySeverity({ checkId: 'PERF-IMAGES', highestTier: 1 }, cfg).severity).toBe('medium');
    expect(classifySeverity({ checkId: 'PERF-IMAGES', highestTier: 3 }, cfg).severity).toBe('low');
  });
  it('render-blocking: Critical if LCP degrades > 0.5s', () => {
    expect(classifySeverity({ checkId: 'PERF-RENDER-BLOCKING', highestTier: 1, metric: 600 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'PERF-RENDER-BLOCKING', highestTier: 1, metric: 400 }, cfg).severity).toBe('medium');
  });
  it('toxic links: Critical above 50 domains/week', () => {
    expect(classifySeverity({ checkId: 'OFF-TOXIC', highestTier: 1, metric: 51 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'OFF-TOXIC', highestTier: 1, metric: 23 }, cfg).severity).toBe('medium');
  });
  it('AI compliance severities per PDF §10.1', () => {
    expect(classifySeverity({ checkId: 'AIC-01', highestTier: 2, metric: 31 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'AIC-02', highestTier: 1 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'AIC-02', highestTier: 2 }, cfg).severity).toBe('medium');
    expect(classifySeverity({ checkId: 'AIC-03', highestTier: 2, isProductClaim: true }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'AIC-03', highestTier: 2, isProductClaim: false }, cfg).severity).toBe('medium');
    expect(classifySeverity({ checkId: 'AIC-07', highestTier: 3 }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'AIC-12', highestTier: 1 }, cfg).severity).toBe('low');
  });
  it('AI crawler: Critical only when unintentionally blocked', () => {
    expect(classifySeverity({ checkId: 'AEO-AI-CRAWLERS', highestTier: 1, unintentional: true }, cfg).severity).toBe('critical');
    expect(classifySeverity({ checkId: 'AEO-AI-CRAWLERS', highestTier: 1, unintentional: false }, cfg).severity).toBe('low');
  });
  it('uses configured thresholds (SEO lead can edit without code, PDF §17)', () => {
    const c2 = defaultConfig();
    c2.thresholds.toxicDomainsPerWeekCritical = 10;
    expect(classifySeverity({ checkId: 'OFF-TOXIC', highestTier: 1, metric: 23 }, c2).severity).toBe('critical');
  });
});

describe('SLA (PDF §3.2)', () => {
  it('Critical = same IST day', () => {
    const due = slaDueAt('critical', NOW, cfg);
    expect(due.toISOString()).toBe('2026-10-12T18:29:59.999Z'); // 23:59:59.999 IST
  });
  it('end of IST day handles UTC-evening detections (next IST date)', () => {
    expect(endOfIstDay(new Date('2026-10-12T20:00:00Z')).toISOString()).toBe('2026-10-13T18:29:59.999Z');
  });
  it('Medium = 7 days, Low = 30 days', () => {
    expect(slaDueAt('medium', NOW, cfg).getTime() - NOW.getTime()).toBe(7 * 86400000);
    expect(slaDueAt('low', NOW, cfg).getTime() - NOW.getTime()).toBe(30 * 86400000);
  });
  it('slaState flags breach and at-risk', () => {
    expect(slaState(new Date(NOW.getTime() - 1000), NOW, cfg).breached).toBe(true);
    expect(slaState(new Date(NOW.getTime() + 3600000), NOW, cfg).atRisk).toBe(true);
    expect(slaState(new Date(NOW.getTime() + 10 * 86400000), NOW, cfg).atRisk).toBe(false);
  });
});

function issue(partial: Partial<Issue>): Issue {
  return {
    id: 'X', checkId: 'TECH-SCHEMA-PRESENCE', module: 'technical', title: 't', summary: 's', severity: 'medium', severityRationale: '',
    issueClass: 'medium', status: 'NEW', delta: 'new', template: 'product', affectedUrls: ['https://deodap.in/products/a'], affectedCount: 1,
    highestTier: 2, tierBreakdown: { 1: 0, 2: 1, 3: 0 }, businessImpact: '', detectedAt: NOW.toISOString(), firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(), slaDueAt: slaDueAt('medium', NOW, cfg).toISOString(), occurrences: 1, recommendedTeam: 'development',
    allocation: [], severityHistory: [], evidence: [{ id: 'e', kind: 'note', label: 'x', content: 'x', capturedAt: NOW.toISOString(), source: 'demo' }], source: 'demo',
    ...partial,
  };
}

describe('Escalation rules (PDF §3.3)', () => {
  it('Medium on a page entering Tier 1 → Critical', () => {
    const a = evaluateEscalations([issue({ id: 'A', highestTier: 1 })], NOW, cfg, { A: 2 });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ rule: 'tier_promotion', to: 'critical', realert: true });
  });
  it('Medium unresolved past SLA → escalates one level and re-alerts', () => {
    const a = evaluateEscalations([issue({ id: 'B', slaDueAt: new Date(NOW.getTime() - 1).toISOString() })], NOW, cfg);
    expect(a[0]).toMatchObject({ rule: 'sla_breach', from: 'medium', to: 'critical', realert: true });
  });
  it('does not escalate resolved, Fixed, or Low issues', () => {
    const past = new Date(NOW.getTime() - 1).toISOString();
    expect(evaluateEscalations([issue({ status: 'CLOSED', slaDueAt: past }), issue({ status: 'FIXED', slaDueAt: past }), issue({ severity: 'low', slaDueAt: past })], NOW, cfg)).toHaveLength(0);
  });
  it('3+ related Medium issues on one template → one template-level group', () => {
    const g = proposeTemplateGroups([issue({ id: '1' }), issue({ id: '2' }), issue({ id: '3' }), issue({ id: '4', template: 'collection' })], cfg);
    expect(g).toHaveLength(1);
    expect(g[0].issueIds).toEqual(['1', '2', '3']);
  });
  it('2 related issues are not grouped', () => {
    expect(proposeTemplateGroups([issue({ id: '1' }), issue({ id: '2' })], cfg)).toHaveLength(0);
  });
  it('Critical unallocated > 24h is flagged; clock restarts at escalation', () => {
    const old = new Date(NOW.getTime() - 30 * 3600000).toISOString();
    const recentEsc = new Date(NOW.getTime() - 2 * 3600000).toISOString();
    const res = unallocatedPastThreshold([
      issue({ id: 'C1', severity: 'critical', detectedAt: old }),
      issue({ id: 'C2', severity: 'critical', detectedAt: old, severityHistory: [{ at: recentEsc, from: 'medium', to: 'critical', reason: '', rule: 'sla_breach' }] }),
      issue({ id: 'C3', severity: 'critical', detectedAt: old, allocatedTeam: 'seo' }),
    ], NOW, cfg);
    expect(res.map((r) => r.id)).toEqual(['C1']);
  });
});

describe('Priority (PDF §11 step 4)', () => {
  it('Impact × Confidence × inverse Effort', () => {
    expect(priorityScore({ impactScore: 5, confidence: 0.8, effortHours: 2, tier: 1 }, cfg)).toBe(20);
    expect(priorityScore({ impactScore: 5, confidence: 0.8, effortHours: 4, tier: 1 }, cfg)).toBe(10);
  });
  it('ties broken by page tier', () => {
    const list = [{ priorityScore: 10, tier: 2 as const }, { priorityScore: 10, tier: 1 as const }].sort(comparePriority);
    expect(list[0].tier).toBe(1);
  });
  it('task priority mapped from severity', () => {
    expect(taskPriorityFromSeverity('critical')).toBe('P1');
    expect(taskPriorityFromSeverity('medium')).toBe('P2');
    expect(taskPriorityFromSeverity('low')).toBe('P3');
  });
});

describe('SEO Health Score (PDF §14)', () => {
  it('weights match the PDF exactly and sum to 1', () => {
    expect(HEALTH_WEIGHTS).toEqual({ technical: 0.3, onpage: 0.2, content_ai: 0.15, performance: 0.1, offpage: 0.1, aeo: 0.08, geo: 0.07 });
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it('100 with no open issues', () => {
    expect(computeHealthScore([], 1000, cfg).score).toBe(100);
  });
  it('Tier 1 issues weigh 5× Tier 2', () => {
    const t1 = computeHealthScore([issue({ highestTier: 1 })], 1000, cfg).modules.find((m) => m.module === 'technical')!;
    const t2 = computeHealthScore([issue({ highestTier: 2 })], 1000, cfg).modules.find((m) => m.module === 'technical')!;
    expect(t1.penalty).toBe(t2.penalty * 5);
    expect(t1.score).toBeLessThan(t2.score);
  });
  it('fixing (verifying) an issue raises the score; closed issues do not count', () => {
    const open = computeHealthScore([issue({ severity: 'critical', highestTier: 1 })], 1000, cfg).score;
    const verified = computeHealthScore([issue({ severity: 'critical', highestTier: 1, status: 'VERIFIED' })], 1000, cfg).score;
    expect(verified).toBeGreaterThan(open);
  });
  it('normalizes by site size', () => {
    const small = computeHealthScore([issue({})], 100, cfg).score;
    const big = computeHealthScore([issue({})], 10000, cfg).score;
    expect(big).toBeGreaterThan(small);
  });
  it('content + ai_compliance share the Content & AI bucket', () => {
    const h = computeHealthScore([issue({ module: 'ai_compliance' }), issue({ module: 'content' })], 1000, cfg);
    expect(h.modules.find((m) => m.module === 'content_ai')!.openIssues.medium).toBe(2);
  });
});

describe('Task workflow (prompt §6)', () => {
  const dev = { kind: 'user' as const, id: 'd', role: 'developer' as const, isAssignee: true };
  const devOther = { kind: 'user' as const, id: 'd2', role: 'developer' as const, isAssignee: false };
  const seo = { kind: 'user' as const, id: 's', role: 'seo_specialist' as const, isAssignee: false };
  it('assignee developer can start, block, and submit for review', () => {
    expect(canTransition('ASSIGNED', 'start', dev).ok).toBe(true);
    expect(canTransition('IN_PROGRESS', 'block', dev, 'waiting on marketing').ok).toBe(true);
    expect(canTransition('IN_PROGRESS', 'submit_review', dev).ok).toBe(true);
  });
  it('non-assignee developer cannot start someone else\'s task', () => {
    expect(canTransition('ASSIGNED', 'start', devOther)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
  it('developer cannot approve their own review', () => {
    const r = canTransition('READY_FOR_REVIEW', 'approve_review', dev);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot review/);
  });
  it('nobody but the system can mark VERIFIED', () => {
    expect(canTransition('FIXED', 'verify_pass', seo)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(canTransition('FIXED', 'verify_pass', { kind: 'user', id: 'a', role: 'admin', isAssignee: false }).ok).toBe(false);
    expect(canTransition('FIXED', 'verify_pass', { kind: 'system' }).ok).toBe(true);
  });
  it('invalid transitions are rejected', () => {
    expect(canTransition('NEW', 'submit_review', seo)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(canTransition('CLOSED', 'start', seo)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });
  it('reasons required for block, reject, cancel, reopen', () => {
    expect(canTransition('IN_PROGRESS', 'block', dev)).toMatchObject({ code: 'NOTE_REQUIRED' });
    expect(canTransition('READY_FOR_REVIEW', 'reject_review', seo)).toMatchObject({ code: 'NOTE_REQUIRED' });
    expect(canTransition('ASSIGNED', 'cancel', seo, 'dup')).toMatchObject({ ok: true });
  });
  it('failed verification returns work to IN_PROGRESS; regression reopens to ASSIGNED', () => {
    expect(canTransition('FIXED', 'verify_fail', { kind: 'system' }).rule?.to).toBe('IN_PROGRESS');
    expect(canTransition('CLOSED', 'reopen_regression', { kind: 'system' }).rule?.to).toBe('ASSIGNED');
  });
  it('maps task statuses to PDF issue statuses', () => {
    expect(issueStatusForTask('BLOCKED')).toBe('IN_PROGRESS');
    expect(issueStatusForTask('READY_FOR_REVIEW')).toBe('IN_PROGRESS');
    expect(issueStatusForTask('FIXED')).toBe('FIXED');
  });
  it('availableActions lists only permitted buttons', () => {
    expect(availableActions('READY_FOR_REVIEW', dev).map((a) => a.action)).toEqual([]);
    expect(availableActions('READY_FOR_REVIEW', seo).map((a) => a.action).sort()).toEqual(['approve_review', 'cancel', 'reject_review']);
  });
});

describe('Permissions', () => {
  it('developer cannot allocate or manage settings; admin can do everything', () => {
    expect(hasPermission(DEFAULT_PERMISSIONS, 'developer', 'issues.allocate')).toBe(false);
    expect(hasPermission(DEFAULT_PERMISSIONS, 'developer', 'settings.manage')).toBe(false);
    expect(hasPermission(DEFAULT_PERMISSIONS, 'seo_specialist', 'issues.allocate')).toBe(true);
    expect(hasPermission(DEFAULT_PERMISSIONS, 'admin', 'roles.manage')).toBe(true);
    expect(hasPermission(DEFAULT_PERMISSIONS, 'seo_specialist', 'roles.manage')).toBe(false);
  });
});

describe('Fix Cards (PDF §11, acceptance: every issue has a complete Fix Card)', () => {
  const seed = createSeed(NOW);
  it('every seeded issue yields a complete Fix Card', () => {
    const incomplete = seed.issues.map((i) => generateFixCard(i, seed.config, { now: NOW })).filter((c) => !c.completeness.complete);
    expect(incomplete.map((c) => `${c.issueId}: ${c.completeness.missing.join(',')}`)).toEqual([]);
  });
  it('root cause inferred for catalog-cleanup 404s (PDF §11 example)', () => {
    const i = seed.issues.find((x) => x.checkId === 'TECH-4XX')!;
    const rc = inferRootCause(i);
    expect(rc?.text).toMatch(/catalog cleanup without redirects/);
    expect(rc!.confidence).toBeGreaterThanOrEqual(0.8);
  });
  it('root cause is null when evidence is insufficient (no guessing)', () => {
    expect(inferRootCause(issue({ checkId: 'TECH-ORPHAN' }))).toBeNull();
  });
  it('content Fix Cards include 3 scored title/meta variants', () => {
    const i = issue({ checkId: 'ONP-TITLE', module: 'onpage' });
    const fc = generateFixCard(i, cfg, { pageName: 'Vegetable Chopper', primaryKeyword: 'vegetable chopper wholesale' });
    expect(fc.drafts).toHaveLength(3);
    expect(fc.drafts!.every((d) => typeof d.score === 'number' && d.scoreBasis)).toBe(true);
  });
  it('recurring issues produce a process recommendation', () => {
    const fc = generateFixCard(issue({ checkId: 'TECH-4XX', occurrences: 4 }), cfg);
    expect(fc.recurrence.processRecommendation).toMatch(/SOP/);
  });
  it('redirect/schema fixes require human approval (PDF §17)', () => {
    expect(generateFixCard(issue({ checkId: 'TECH-DISCONTINUED' }), cfg).requiresHumanApproval).toBe(true);
    expect(generateFixCard(issue({ checkId: 'TECH-SCHEMA-ERRORS' }), cfg).requiresHumanApproval).toBe(true);
  });
});

describe('AI-content heuristics & custom rules (PDF §10)', () => {
  it('detects boilerplate, artifacts and YMYL claims', () => {
    expect(findPatternHits("In today's fast-paced world, buy this.", AI_BOILERPLATE_PATTERNS)).toHaveLength(1);
    expect(findPatternHits('**Key Features:** As of 2023 it is great', AI_ARTIFACT_PATTERNS).length).toBe(2);
    expect(findPatternHits('100% BPA-free and child-safe', YMYL_CLAIM_PATTERNS).length).toBe(2);
  });
  it('keyword density', () => {
    expect(keywordDensity('toys toys toys and more', 'toys')).toBe(60);
  });
  it('near-identical "fill-in-the-blank" clusters (scaled content abuse)', () => {
    const tpl = (n: string) => `Stay hydrated in style with the ${n}. Whether you are a student or a professional the ${n} is perfect for your daily routine and keeps water cold.`;
    const clusters = nearIdenticalClusters([
      { id: 'a', text: tpl('Blue Bottle'), mask: 'Blue Bottle' },
      { id: 'b', text: tpl('Red Flask'), mask: 'Red Flask' },
      { id: 'c', text: 'A completely different description of a garden tool set with steel blades.' },
    ]);
    expect(clusters).toEqual([['a', 'b']]);
  });
  it('supports all PDF §10.2 example rules', () => {
    const base = { id: 'R', createdById: 'x', createdAt: '', updatedAt: '', source: 'demo' as const };
    const [lowest, nomoq, hinglish, festival] = EXAMPLE_RULES.map((r) => ({ ...r, ...base }) as CustomRule);
    const page = (text: string, template: 'product' | 'collection' = 'collection') => ({ url: 'u', template, tier: 1 as const, text });
    expect(evaluateRule(lowest, page('Get the lowest price in India today')).flagged).toBe(true);
    expect(evaluateRule(nomoq, page('Wholesale kitchen tools, fast shipping')).flagged).toBe(true);
    expect(evaluateRule(nomoq, page('Wholesale kitchen tools with No MOQ')).flagged).toBe(false);
    expect(evaluateRule(hinglish, page('anything'))).toMatchObject({ evaluated: false });
    expect(evaluateRule(festival, page('Diwali sale ends soon')).flagged).toBe(true);
  });
  it('validates rule definitions', () => {
    expect(validateRule({ name: 'x', method: 'regex', pattern: '(' })).toEqual(expect.arrayContaining([expect.stringMatching(/at least 3/), expect.stringMatching(/Invalid regex/)]));
    expect(validateRule({ ...EXAMPLE_RULES[0] })).toEqual([]);
    expect(validateRule({ ...EXAMPLE_RULES[0], action: 'block_qa_gate' })).toEqual([expect.stringMatching(/new pages only/)]);
  });
});

describe('DEMO seed integrity', () => {
  const s = createSeed(NOW);
  it('is deterministic', () => {
    const s2 = createSeed(NOW);
    expect(s2.issues.map((i) => i.id + i.severity)).toEqual(s.issues.map((i) => i.id + i.severity));
  });
  it('labels every record as demo', () => {
    expect(s.issues.every((i) => i.source === 'demo')).toBe(true);
    expect(s.tasks.every((t) => t.source === 'demo')).toBe(true);
  });
  it('applies tier rules: top 20 collections, top 200 products (by revenue or sessions)', () => {
    const t1c = s.catalog.collections.filter((c) => c.tier === 1).length;
    expect(t1c).toBeGreaterThanOrEqual(20);
    expect(t1c).toBeLessThanOrEqual(40);
    expect(s.catalog.home.tier).toBe(1);
  });
  it('builds the PDF template-level group (offers missing on product template)', () => {
    expect(s.groups).toHaveLength(1);
    const parent = s.issues.find((i) => i.isTemplateGroup)!;
    expect(parent.severity).toBe('critical');
    expect(s.issues.filter((i) => i.supersededById === parent.id)).toHaveLength(4);
  });
  it('task statuses map consistently to issue statuses', () => {
    for (const t of s.tasks.filter((x) => x.issueId)) {
      const iss = s.issues.find((i) => i.id === t.issueId)!;
      const mapped = issueStatusForTask(t.status);
      if (mapped) expect(iss.status).toBe(mapped);
    }
  });
  it('no seeded task is VERIFIED without a passed verification attempt', () => {
    for (const t of s.tasks.filter((x) => x.status === 'VERIFIED' || x.status === 'CLOSED')) {
      expect(t.verification.some((v) => v.outcome === 'passed')).toBe(true);
    }
  });
});
