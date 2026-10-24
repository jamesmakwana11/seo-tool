import type {
  ActivityEvent, AiComplianceFlag, AiVisibilityPrompt, AiVisibilityTrendPoint, AllocationEvent, AuditLogEntry, Backlink,
  BrandMention, ContentBrief, ContentScore, CrawlRun, CrawlSchedule, CrawledUrl, CtrRewrite, CustomRule, CwvTemplateMetric,
  DeliveryAttempt, DisavowCandidate, Employee, Exclusion, HealthPoint, Issue, IssueGroup, KeywordGap, LinkProspect,
  Notification, OpportunityItem, PermissionMatrix, ReferringDomainTrendPoint, SentinelConfig, SitemapDiff, StrikingDistanceQuery,
  Task, TaskStatus, TeamId, TopicCluster, VerificationAttempt, PageTemplate, PageTier, SystemErrorEntry, DataSource,
} from '../types';
import { defaultConfig, DEFAULT_PERMISSIONS, TEAMS } from '../config';
import { rng, pad, addDays, addHours, dayStr, type Rng } from './rng';
import { buildCatalog, type Catalog } from './catalog';
import { buildIssue, issueSpecs, resetIssueCounter } from './issues';
import { evaluateEscalations, proposeTemplateGroups, unallocatedPastThreshold } from '../rules/escalation';
import { slaDueAt } from '../rules/sla';
import { computeHealthScore } from '../rules/healthScore';
import { taskPriorityFromSeverity } from '../rules/priority';
import { generateFixCard, heuristicCtrScore } from '../fixcards/generate';
import { EXAMPLE_RULES } from '../analysis/customRules';
import { CHECKS_BY_ID } from '../checks/library';

export interface PageText {
  url: string;
  template: PageTemplate;
  tier: PageTier;
  collectionHandle?: string;
  text: string;
  publishedAt?: string;
}

export interface SeedData {
  generatedAt: string;
  config: SentinelConfig;
  permissions: PermissionMatrix;
  employees: Employee[];
  passwords: Record<string, string>; // email → password (DEMO credentials only)
  catalog: Catalog;
  siteSize: number;
  issues: Issue[];
  groups: IssueGroup[];
  exclusions: Exclusion[];
  tasks: Task[];
  crawls: CrawlRun[];
  crawlUrls: Record<string, CrawledUrl[]>;
  sitemapDiffs: Record<string, SitemapDiff>;
  schedules: CrawlSchedule[];
  verifications: VerificationAttempt[];
  healthHistory: HealthPoint[];
  cwv: CwvTemplateMetric[];
  indexation: { date: string; indexed: number; excluded: number; crawledNotIndexed: number; source: DataSource }[];
  visibility: { date: string; clicks: number; impressions: number; avgPosition: number; source: DataSource }[];
  aiTrend: AiVisibilityTrendPoint[];
  aiPrompts: AiVisibilityPrompt[];
  backlinks: Backlink[];
  refTrend: ReferringDomainTrendPoint[];
  prospects: LinkProspect[];
  mentions: BrandMention[];
  disavow: DisavowCandidate[];
  competitors: { domain: string; name: string; visibility: number[]; cwv: string; referringDomains: number; contentVelocity: number; source: DataSource }[];
  localHealth: { napConsistency: { directory: string; consistent: boolean; detail: string }[]; gbp: { rating: number; reviews: number; reviewVelocity30d: number; completeness: number } };
  keywordGaps: KeywordGap[];
  striking: StrikingDistanceQuery[];
  ctrRewrites: CtrRewrite[];
  briefs: ContentBrief[];
  clusters: TopicCluster[];
  opportunities: OpportunityItem[];
  rules: CustomRule[];
  aiFlags: AiComplianceFlag[];
  contentScores: ContentScore[];
  pageTexts: PageText[];
  notifications: Notification[];
  deliveries: DeliveryAttempt[];
  audit: AuditLogEntry[];
  criticalAlerts: { id: string; type: string; title: string; at: string; issueId?: string }[];
  errors: SystemErrorEntry[];
}

export const DEMO_PASSWORD = 'Sentinel@Demo1';

const EMP: Omit<Employee, 'createdAt' | 'source'>[] = [
  { id: 'emp-aarav', name: 'Aarav Mehta', email: 'aarav.admin@demo.deodap.local', role: 'admin', teamIds: ['seo'], title: 'SEO Operations Admin', status: 'active', capacityHoursPerWeek: 20 },
  { id: 'emp-ritesh', name: 'Ritesh Patel', email: 'ritesh.seo@demo.deodap.local', role: 'seo_specialist', teamIds: ['seo'], title: 'SEO Lead', status: 'active', isSeoLead: true, capacityHoursPerWeek: 35 },
  { id: 'emp-neha', name: 'Neha Shah', email: 'neha.seo@demo.deodap.local', role: 'seo_specialist', teamIds: ['seo'], title: 'Technical SEO Specialist', status: 'active', capacityHoursPerWeek: 40 },
  { id: 'emp-karan', name: 'Karan Joshi', email: 'karan.seo@demo.deodap.local', role: 'seo_specialist', teamIds: ['seo'], title: 'SEO Specialist (Off-page)', status: 'active', capacityHoursPerWeek: 40 },
  { id: 'emp-pooja', name: 'Pooja Desai', email: 'pooja.content@demo.deodap.local', role: 'seo_specialist', teamIds: ['content'], title: 'Content Lead', status: 'active', capacityHoursPerWeek: 35 },
  { id: 'emp-sneha', name: 'Sneha Iyer', email: 'sneha.content@demo.deodap.local', role: 'seo_specialist', teamIds: ['content'], title: 'SEO Content Writer', status: 'active', capacityHoursPerWeek: 40 },
  { id: 'emp-rahul', name: 'Rahul Verma', email: 'rahul.content@demo.deodap.local', role: 'seo_specialist', teamIds: ['content'], title: 'Product Content Writer', status: 'active', capacityHoursPerWeek: 40 },
  { id: 'emp-vikram', name: 'Vikram Rao', email: 'vikram.dev@demo.deodap.local', role: 'developer', teamIds: ['development'], title: 'Shopify Theme Lead', status: 'active', capacityHoursPerWeek: 35 },
  { id: 'emp-ankit', name: 'Ankit Sharma', email: 'ankit.dev@demo.deodap.local', role: 'developer', teamIds: ['development'], title: 'Shopify Developer', status: 'active', capacityHoursPerWeek: 40 },
  { id: 'emp-priya', name: 'Priya Nair', email: 'priya.dev@demo.deodap.local', role: 'developer', teamIds: ['development'], title: 'Frontend Developer', status: 'active', capacityHoursPerWeek: 40 },
  { id: 'emp-manish', name: 'Manish Gupta', email: 'manish.dev@demo.deodap.local', role: 'developer', teamIds: ['development'], title: 'Performance Engineer', status: 'active', capacityHoursPerWeek: 32 },
  { id: 'emp-divya', name: 'Divya Kapoor', email: 'divya.dev@demo.deodap.local', role: 'developer', teamIds: ['development'], title: 'Junior Developer', status: 'invited', capacityHoursPerWeek: 40 },
  { id: 'emp-old', name: 'Sameer Khan', email: 'sameer.content@demo.deodap.local', role: 'seo_specialist', teamIds: ['content'], title: 'Former Content Writer', status: 'suspended', capacityHoursPerWeek: 0 },
];

/** Preview users per role (prompt §4.3 development role preview). */
export const PREVIEW_USER_BY_ROLE = { admin: 'emp-aarav', seo_specialist: 'emp-ritesh', developer: 'emp-ankit' } as const;

export function createSeed(now = new Date(), seed = 20260812): SeedData {
  const r = rng(seed);
  resetIssueCounter();
  const cfg = defaultConfig(addDays(now, -20));
  const employees: Employee[] = EMP.map((e, i) => ({ ...e, createdAt: addDays(now, -200 + i * 7).toISOString(), lastActiveAt: e.status === 'active' ? addHours(now, -r.int(1, 30)).toISOString() : undefined, source: 'demo' }));
  for (const t of Object.values(TEAMS)) t.leadId = t.id === 'seo' ? 'emp-ritesh' : t.id === 'content' ? 'emp-pooja' : 'emp-vikram';
  const empName = (id: string) => (id === 'system' ? 'Sentinel (system)' : employees.find((e) => e.id === id)?.name ?? id);
  const members = (team: TeamId) => employees.filter((e) => e.teamIds.includes(team) && e.status === 'active' && e.role !== 'admin');
  const passwords = Object.fromEntries(employees.map((e) => [e.email, DEMO_PASSWORD]));

  const catalog = buildCatalog(r, now);
  const siteSize = 4812; // DEMO indexable URL count (catalog holds a representative sample)

  // ------------------------------------------------------------- issues
  const specs = issueSpecs(catalog, r, now);
  const issues: Issue[] = [];
  const specByIssue = new Map<string, (typeof specs)[number]>();
  for (const sp of specs) {
    if (!sp.pages.length && !sp.extraUrls?.length) continue;
    const iss = buildIssue(sp, cfg, now, r);
    issues.push(iss);
    specByIssue.set(iss.id, sp);
  }
  const audit: AuditLogEntry[] = [];
  let auditN = 0;
  const log = (at: Date | string, actorId: string, action: string, entityType: AuditLogEntry['entityType'], entityId: string, summary: string, extra: Partial<AuditLogEntry> = {}) => {
    audit.push({ id: `AUD-${pad(++auditN, 5)}`, at: typeof at === 'string' ? at : at.toISOString(), actorId, actorName: empName(actorId), action, entityType, entityId, summary, ...extra });
  };
  for (const i of issues) log(i.detectedAt, 'system', 'issue.detected', 'issue', i.id, `${i.severity.toUpperCase()} — ${i.title}`);

  // Template grouping (PDF §3.3)
  const groups: IssueGroup[] = [];
  for (const g of proposeTemplateGroups(issues, cfg)) {
    const children = issues.filter((i) => g.issueIds.includes(i.id));
    const at = new Date(Math.max(...children.map((c) => +new Date(c.detectedAt))));
    const parentId = `ISS-${pad(issues.length + groups.length + 1)}`;
    const groupId = `GRP-${pad(groups.length + 1, 3)}`;
    const urls = [...new Set(children.flatMap((c) => c.affectedUrls))];
    const tierBreakdown = { 1: 0, 2: 0, 3: 0 } as Record<PageTier, number>;
    for (const c of children) for (const t of [1, 2, 3] as PageTier[]) tierBreakdown[t] += c.tierBreakdown[t];
    const check = CHECKS_BY_ID[g.checkId];
    const parent: Issue = {
      ...children[0], id: parentId, title: `Template-level: ${check.name} — ${g.template} template (${urls.length} pages)`,
      summary: `${children.length} related Medium issues ("${check.name}") on the ${g.template} template grouped into one Critical template-level issue. ${children.map((c) => c.title).join('; ')}.`,
      severity: 'critical', issueClass: 'critical', severityRationale: g.reason, isTemplateGroup: true, childIssueIds: g.issueIds, groupId,
      affectedUrls: urls, affectedCount: urls.length, tierBreakdown, highestTier: tierBreakdown[1] ? 1 : tierBreakdown[2] ? 2 : 3,
      detectedAt: at.toISOString(), slaDueAt: slaDueAt('critical', at, cfg).toISOString(), businessImpact: 'Template bugs multiply — one fix resolves every child page.',
      severityHistory: [{ at: at.toISOString(), from: 'medium', to: 'critical', reason: g.reason, rule: 'template_grouping' }],
      evidence: children.flatMap((c) => c.evidence).slice(0, 4), allocation: [], status: 'NEW',
    };
    for (const c of children) {
      c.groupId = groupId;
      c.supersededById = parentId;
      c.status = 'SUPERSEDED';
    }
    issues.push(parent);
    groups.push({ id: groupId, checkId: g.checkId, template: g.template, issueIds: g.issueIds, severity: 'critical', reason: g.reason, createdAt: at.toISOString() });
    log(at, 'system', 'issue.grouped', 'issue', parentId, `Grouped ${children.length} issues into template-level Critical ${parentId}`);
  }

  // Escalations (PDF §3.3): tier promotion demo + SLA breaches
  const kwMap = issues.find((i) => i.checkId === 'ONP-KEYWORD-MAP');
  const prevTier: Record<string, PageTier> = kwMap ? { [kwMap.id]: 2 } : {};
  for (const a of evaluateEscalations(issues, now, cfg, prevTier)) {
    const iss = issues.find((i) => i.id === a.issueId)!;
    const at = a.rule === 'sla_breach' ? new Date(iss.slaDueAt) : addHours(now, -6);
    iss.severity = a.to;
    iss.issueClass = a.to;
    iss.severityHistory.push({ at: at.toISOString(), from: a.from, to: a.to, reason: a.reason, rule: a.rule });
    iss.slaDueAt = slaDueAt('critical', at, cfg).toISOString();
    iss.severityRationale = `${iss.severityRationale} → escalated: ${a.reason}`;
    log(at, 'system', 'issue.escalated', 'issue', iss.id, `Escalated ${a.from} → ${a.to}: ${a.reason}`);
  }

  // ------------------------------------------------------------- allocation + tasks
  const tasks: Task[] = [];
  const verifications: VerificationAttempt[] = [];
  let taskN = 0;
  let allocN = 0;
  const statusForIssue: Record<string, TaskStatus> = {
    ASSIGNED: 'ASSIGNED', IN_PROGRESS: 'IN_PROGRESS', FIXED: 'FIXED', VERIFIED: 'VERIFIED', CLOSED: 'CLOSED',
  };

  const makeTask = (iss: Issue, team: TeamId, byId: string, at: Date, status: TaskStatus, automatic = false): Task => {
    const id = `TSK-${pad(++taskN)}`;
    const fc = generateFixCard(iss, cfg, { now: at });
    const pool = members(team);
    const assignee = status === 'NEW' || status === 'TRIAGED' || (automatic && status === 'ASSIGNED') ? undefined : pool[(taskN * 7) % pool.length];
    const activity: ActivityEvent[] = [];
    let ev = 0;
    const act = (type: ActivityEvent['type'], actor: string, when: Date, message: string, meta?: Record<string, unknown>) =>
      activity.push({ id: `${id}-a${++ev}`, type, actorId: actor, actorName: empName(actor), at: when.toISOString(), message, meta });
    act('created', byId, at, `Task created from Fix Card ${iss.id} — allocated to ${TEAMS[team].name}${automatic ? ' (auto-created: Critical unallocated >24h, PDF §12.4)' : ''}.`);
    if (assignee) act('assigned', byId === 'system' ? 'emp-ritesh' : byId, addHours(at, 1), `Assigned to ${assignee.name}.`);
    const order: TaskStatus[] = ['ASSIGNED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'FIXED', 'VERIFIED', 'CLOSED'];
    const reached = order.indexOf(status === 'BLOCKED' ? 'IN_PROGRESS' : status);
    const step = (h: number) => addHours(at, h);
    if (reached >= 1) act('status_changed', assignee!.id, step(3), 'ASSIGNED → IN PROGRESS');
    if (reached >= 2) act('review_submitted', assignee!.id, step(20), 'Submitted for review with after-evidence.');
    if (reached >= 3) act('review_approved', 'emp-ritesh', step(24), 'Review approved → FIXED. Awaiting automated re-verification.');
    const verif: VerificationAttempt[] = [];
    if (reached >= 4) {
      const vAt = step(30);
      const v: VerificationAttempt = { id: `VER-${pad(verifications.length + verif.length + 1)}`, taskId: id, issueId: iss.id, at: vAt.toISOString(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'passed', checkedUrls: iss.affectedCount, failingUrls: 0, details: `Re-crawled ${iss.affectedCount} URLs: 0 failing. (DEMO simulated verification)`, source: 'demo' };
      verif.push(v);
      act('verification_run', 'system', vAt, 'Automated re-verification passed (0 failing URLs).', { outcome: 'passed' });
    }
    if (reached >= 5) act('status_changed', 'system', step(31), 'VERIFIED → CLOSED');
    if (status === 'FIXED') {
      const vAt = step(28);
      verif.push({ id: `VER-${pad(verifications.length + verif.length + 1)}`, taskId: id, issueId: iss.id, at: vAt.toISOString(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: 'Queued for the next smart crawl — re-verification has not run yet.', source: 'demo' });
    }
    const progress = { ASSIGNED: 0, IN_PROGRESS: r.int(20, 70), BLOCKED: r.int(20, 50), READY_FOR_REVIEW: 100, FIXED: 100, VERIFIED: 100, CLOSED: 100, NEW: 0, TRIAGED: 0, CANCELLED: 0 }[status];
    const t: Task = {
      id, title: `Fix: ${iss.title}`, description: `${fc.whatsWrong}\n\nWhy it matters: ${fc.whyItMatters}`, issueId: iss.id, module: iss.module,
      severity: iss.severity, priority: taskPriorityFromSeverity(iss.severity), priorityScore: fc.priorityScore, pageTier: iss.highestTier,
      affectedUrls: iss.affectedUrls.slice(0, 50), status, team, recommendedTeam: iss.recommendedTeam, assigneeId: assignee?.id,
      recommendedOwnerId: pool[0]?.id, creatorId: byId, creatorName: empName(byId), createdAt: at.toISOString(),
      updatedAt: (activity.at(-1) ? new Date(activity.at(-1)!.at) : at).toISOString(), dueAt: iss.slaDueAt, progress,
      estimatedHours: fc.effortHours, actualHours: reached >= 1 ? Math.round(fc.effortHours * r.float(0.3, 1.2) * 10) / 10 : 0,
      acceptanceCriteria: fc.acceptanceCriteria, comments: [], blockers: [], evidence: [], verification: verif, activity,
      assignmentHistory: [{ at: at.toISOString(), byId, byName: empName(byId), toTeam: team, toAssigneeId: assignee?.id }],
      relatedIssueIds: iss.childIssueIds ?? [], reopenCount: 0, source: 'demo',
    };
    if (reached >= 2) {
      t.evidence.push(
        { id: `${id}-e1`, phase: 'before', kind: 'text', label: 'Before', content: fc.evidence[0]?.content ?? 'See issue evidence', addedById: assignee!.id, addedByName: assignee!.name, at: step(4).toISOString() },
        { id: `${id}-e2`, phase: 'after', kind: 'text', label: 'After', content: 'Change applied in theme/admin; sample URL re-checked manually.', addedById: assignee!.id, addedByName: assignee!.name, at: step(20).toISOString() },
      );
    }
    verifications.push(...verif);
    return t;
  };

  const alloc = (iss: Issue, team: TeamId, byId: string, at: Date, automatic = false, reason?: string) => {
    const ev: AllocationEvent = { id: `ALC-${pad(++allocN)}`, issueId: iss.id, allocatedById: byId, allocatedByName: empName(byId), toTeam: team, fromTeam: iss.allocatedTeam, at: at.toISOString(), automatic, reason, bulkGroupId: iss.isTemplateGroup ? iss.groupId : undefined };
    iss.allocation.push(ev);
    iss.allocatedTeam = team;
    log(at, byId, 'issue.allocate', 'issue', iss.id, `Allocated by ${empName(byId)} → ${TEAMS[team].name}${automatic ? ' (automatic, unallocated Critical >24h)' : ''}`);
  };

  for (const iss of issues) {
    const sp = specByIssue.get(iss.id);
    if (!sp?.allocateTo || iss.status === 'SUPERSEDED') continue;
    const at = addHours(new Date(iss.detectedAt), r.int(1, 6));
    alloc(iss, sp.allocateTo, sp.allocatedBy ?? 'emp-ritesh', at, sp.allocatedBy === 'system', sp.allocateTo !== iss.recommendedTeam ? 'Override: needs theme access' : undefined);
    const st = statusForIssue[iss.status] ?? 'ASSIGNED';
    const task = makeTask(iss, sp.allocateTo, sp.allocatedBy ?? 'emp-ritesh', at, st);
    iss.taskId = task.id;
    tasks.push(task);
  }

  // Reallocation demo (allocation trail with previous/new team)
  const h1 = issues.find((i) => i.checkId === 'ONP-H1' && i.taskId);
  if (h1) {
    const t = tasks.find((x) => x.id === h1.taskId)!;
    const at = addHours(new Date(h1.allocation[0].at), 2);
    const first = h1.allocation[0];
    first.toTeam = 'content';
    first.allocatedById = 'emp-neha';
    first.allocatedByName = empName('emp-neha');
    first.reason = undefined;
    h1.allocation.push({ id: `ALC-${pad(++allocN)}`, issueId: h1.id, allocatedById: 'emp-ritesh', allocatedByName: empName('emp-ritesh'), fromTeam: 'content', toTeam: 'development', at: at.toISOString(), automatic: false, reason: 'Fix lives in header.liquid — needs theme access' });
    h1.allocatedTeam = 'development';
    t.assignmentHistory = [
      { at: first.at, byId: 'emp-neha', byName: empName('emp-neha'), toTeam: 'content' },
      { at: at.toISOString(), byId: 'emp-ritesh', byName: empName('emp-ritesh'), fromTeam: 'content', toTeam: 'development', toAssigneeId: t.assigneeId, reason: 'Fix lives in header.liquid — needs theme access' },
    ];
    t.activity.push({ id: `${t.id}-re`, type: 'reallocated', actorId: 'emp-ritesh', actorName: empName('emp-ritesh'), at: at.toISOString(), message: 'Reallocated 1into2 Content Team → 1into2 Development Team: Fix lives in header.liquid — needs theme access' });
    log(at, 'emp-ritesh', 'issue.reallocate', 'issue', h1.id, 'Reallocated Content → Development (both teams notified)');
  }

  // Unallocated Criticals >24h → auto-task to engine-suggested team (PDF §12.4)
  for (const u of unallocatedPastThreshold(issues, now, cfg)) {
    const iss = issues.find((i) => i.id === u.id)!;
    const at = addHours(now, -r.int(1, 4));
    alloc(iss, iss.recommendedTeam, 'system', at, true);
    iss.status = 'ASSIGNED';
    const task = makeTask(iss, iss.recommendedTeam, 'system', at, 'ASSIGNED', true);
    iss.taskId = task.id;
    tasks.push(task);
  }

  // Enrich specific tasks: blocker, comments, review queue, rejected review, reopen
  const byCheck = (c: string) => tasks.find((t) => issues.find((i) => i.id === t.issueId)?.checkId === c);
  const cwvTask = byCheck('PERF-CRUX');
  if (cwvTask) {
    cwvTask.status = 'BLOCKED';
    cwvTask.blockers.push({ id: `${cwvTask.id}-b1`, description: 'Need approval from marketing to remove the announcement-bar app that causes CLS + late LCP.', dependsOn: 'Marketing sign-off', raisedById: cwvTask.assigneeId!, raisedByName: empName(cwvTask.assigneeId!), raisedAt: addHours(now, -20).toISOString() });
    cwvTask.activity.push({ id: `${cwvTask.id}-blk`, type: 'blocker_added', actorId: cwvTask.assigneeId!, actorName: empName(cwvTask.assigneeId!), at: addHours(now, -20).toISOString(), message: 'Marked BLOCKED: Need approval from marketing to remove the announcement-bar app.' });
  }
  const altTask = byCheck('ONP-IMAGES');
  if (altTask) {
    altTask.status = 'READY_FOR_REVIEW';
    altTask.progress = 100;
    altTask.evidence.push(
      { id: `${altTask.id}-e1`, phase: 'before', kind: 'text', label: 'ALT audit before', content: '64 images · 51 empty ALT', addedById: altTask.assigneeId!, addedByName: empName(altTask.assigneeId!), at: addHours(now, -30).toISOString() },
      { id: `${altTask.id}-e2`, phase: 'after', kind: 'text', label: 'ALT audit after', content: '64 images · 0 empty ALT · pattern "{product} – {attribute} – DeoDap" applied', addedById: altTask.assigneeId!, addedByName: empName(altTask.assigneeId!), at: addHours(now, -3).toISOString() },
    );
    altTask.activity.push({ id: `${altTask.id}-rv`, type: 'review_submitted', actorId: altTask.assigneeId!, actorName: empName(altTask.assigneeId!), at: addHours(now, -3).toISOString(), message: 'Submitted for review.' });
  }
  const metaTask = byCheck('ONP-META');
  if (metaTask) {
    metaTask.activity.push({ id: `${metaTask.id}-rj`, type: 'review_rejected', actorId: 'emp-pooja', actorName: empName('emp-pooja'), at: addHours(now, -26).toISOString(), message: 'Changes requested: 18 descriptions exceed 160 characters.' });
    metaTask.comments.push({ id: `${metaTask.id}-c1`, authorId: 'emp-pooja', authorName: empName('emp-pooja'), body: '18 of the new descriptions are over 160 chars — please trim and resubmit.', at: addHours(now, -26).toISOString() });
  }
  const renderTask = byCheck('PERF-RENDER-BLOCKING');
  if (renderTask) {
    renderTask.comments.push(
      { id: `${renderTask.id}-c1`, authorId: 'emp-ritesh', authorName: empName('emp-ritesh'), body: 'Marketing wants to keep the wishlist feature — can we defer the loader instead of removing the app?', at: addHours(now, -30).toISOString() },
      { id: `${renderTask.id}-c2`, authorId: renderTask.assigneeId!, authorName: empName(renderTask.assigneeId!), body: 'Yes — moving the app embed to load on interaction. Testing on a duplicate theme first.', at: addHours(now, -28).toISOString() },
    );
  }
  const closedTask = byCheck('TECH-REDIRECTS');
  if (closedTask) closedTask.reopenCount = 0;
  const aic6 = byCheck('AIC-06');
  if (aic6) {
    // regression demo: verified earlier, reopened once in the past then re-verified
    aic6.reopenCount = 1;
    aic6.activity.splice(1, 0, { id: `${aic6.id}-reo`, type: 'reopened', actorId: 'system', actorName: 'Sentinel (system)', at: addDays(now, -6).toISOString(), message: 'Regression: AggregateRating reappeared on 3 products after a theme update — reopened.' });
  }

  // Manual tasks from opportunities + general
  const manual = (title: string, team: TeamId, creator: string, status: TaskStatus, days: number, desc: string): Task => {
    const id = `TSK-${pad(++taskN)}`;
    const at = addDays(now, -days);
    const assignee = members(team)[(taskN * 3) % members(team).length];
    return {
      id, title, description: desc, priority: 'P3', affectedUrls: [], status, team, assigneeId: status === 'NEW' ? undefined : assignee.id,
      creatorId: creator, creatorName: empName(creator), createdAt: at.toISOString(), updatedAt: at.toISOString(), dueAt: addDays(at, 14).toISOString(),
      progress: status === 'IN_PROGRESS' ? 40 : 0, estimatedHours: 6, actualHours: status === 'IN_PROGRESS' ? 2.5 : 0, acceptanceCriteria: ['Brief approved by Content Lead', 'Published and interlinked'],
      comments: [], blockers: [], evidence: [], verification: [],
      activity: [{ id: `${id}-a1`, type: 'created', actorId: creator, actorName: empName(creator), at: at.toISOString(), message: 'Created from Opportunities board.' }],
      assignmentHistory: [{ at: at.toISOString(), byId: creator, byName: empName(creator), toTeam: team, toAssigneeId: assignee.id }],
      relatedIssueIds: [], reopenCount: 0, source: 'demo',
    };
  };
  tasks.push(manual('Write buying guide: How to choose a wholesale water bottle supplier', 'content', 'emp-ritesh', 'IN_PROGRESS', 5, 'From content brief BRF-002 (search-intent mismatch).'));
  tasks.push(manual('Diwali gifting landing page refresh (60-day seasonal prompt)', 'content', 'emp-pooja', 'ASSIGNED', 2, 'Seasonal planner: Diwali is within the 60-day window; refresh Festive & Gifts collections.'));
  tasks.push(manual('Outreach: reclaim 3 unlinked brand mentions', 'seo', 'emp-karan', 'NEW', 1, 'From brand-mention monitor.'));
  const cancelled = manual('Disavow review for Q3 spam domains', 'seo', 'emp-karan', 'CANCELLED', 15, 'Superseded by weekly disavow candidate review.');
  cancelled.cancelReason = 'Duplicate of the weekly disavow review workflow.';
  tasks.push(cancelled);
  // overdue task
  const overdue = tasks.find((t) => t.status === 'ASSIGNED' && t.severity === 'medium');
  if (overdue) overdue.dueAt = addHours(now, -10).toISOString();

  // Not an issue + exclusion
  const exclusions: Exclusion[] = [];
  const nai = issues.find((i) => i.status === 'NOT_AN_ISSUE');
  if (nai) {
    nai.notAnIssue = { byId: 'emp-neha', byName: empName('emp-neha'), at: addDays(now, -13).toISOString(), reason: 'Track-order is an account utility page — intentionally noindexed.', excluded: true };
    exclusions.push({ id: 'EXC-001', checkId: 'TECH-NOINDEX', urlPattern: '/pages/track-order', reason: nai.notAnIssue.reason, createdById: 'emp-neha', createdByName: empName('emp-neha'), createdAt: nai.notAnIssue.at });
    log(nai.notAnIssue.at, 'emp-neha', 'issue.not_an_issue', 'issue', nai.id, `Marked Not an issue: ${nai.notAnIssue.reason}`);
  }
  for (const p of cfg.intentionalNoindex) exclusions.push({ id: `EXC-${pad(exclusions.length + 1, 3)}`, checkId: 'TECH-NOINDEX', urlPattern: p, reason: 'Configured intentional noindex (Settings)', createdById: 'emp-ritesh', createdByName: empName('emp-ritesh'), createdAt: addDays(now, -30).toISOString() });

  // ------------------------------------------------------------- health
  const health = computeHealthScore(issues, siteSize, cfg, now);
  // DEMO history walks BACKWARDS from today's computed score so the series is continuous.
  const healthHistory: HealthPoint[] = [];
  let sc = health.score;
  const mods: Record<string, number> = Object.fromEntries(health.modules.map((m) => [m.module, m.score]));
  for (let d = 0; d < 90; d++) {
    const date = dayStr(addDays(now, -d));
    healthHistory.unshift({ date, score: Math.round(sc * 10) / 10, modules: Object.fromEntries(Object.entries(mods).map(([k, v]) => [k, Math.round(v * 10) / 10])), source: 'demo' });
    sc = Math.min(98, Math.max(40, sc - 0.1 + r.float(-0.7, 0.6)));
    for (const k of Object.keys(mods)) mods[k] = Math.min(99, Math.max(30, mods[k] - 0.11 + r.float(-0.9, 0.8)));
  }

  // ------------------------------------------------------------- crawls
  const crawls: CrawlRun[] = [];
  const crawlUrls: Record<string, CrawledUrl[]> = {};
  const sitemapDiffs: Record<string, SitemapDiff> = {};
  let crawlN = 0;
  for (let d = 29; d >= 0; d--) {
    const day = addDays(now, -d);
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 0, 0)); // 05:30 IST
    if (start > now) continue;
    const isSunday = new Date(start.getTime() + 5.5 * 3600000).getUTCDay() === 0;
    const failed = d === 12;
    const make = (type: CrawlRun['type'], planned: number): CrawlRun => {
      const id = `CRL-${pad(++crawlN)}`;
      const crawled = failed ? Math.round(planned * 0.31) : planned - r.int(0, 6);
      return {
        id, type, status: failed ? 'failed' : 'completed', trigger: 'schedule', startedAt: start.toISOString(),
        finishedAt: addHours(start, type === 'full' ? 3.2 : 0.8).toISOString(), urlsPlanned: planned, urlsCrawled: crawled,
        urlsFailed: planned - crawled, jsRenderedSample: type === 'full' ? cfg.crawl.jsRenderSampleSize : 40,
        newIssues: r.int(0, 6), resolvedIssues: r.int(0, 5), recurringIssues: r.int(5, 20), durationMs: (type === 'full' ? 3.2 : 0.8) * 3600000,
        error: failed ? 'Run aborted after 429 responses from origin (rate limit) — partial results discarded. (DEMO)' : undefined,
        scope: type === 'full'
          ? [{ label: 'All indexable URLs', count: planned }]
          : [{ label: 'Homepage', count: 1 }, { label: 'Collections', count: catalog.collections.length }, { label: 'Top products by revenue/traffic', count: cfg.crawl.smartTopProducts }, { label: 'Changed in last 48h (sitemap lastmod + webhooks)', count: r.int(20, 90) }, { label: "Re-verify yesterday's issue URLs", count: r.int(60, 160) }],
        source: 'demo',
      };
    };
    if (isSunday) crawls.push(make('full', siteSize));
    crawls.push(make('smart', 1 + catalog.collections.length + cfg.crawl.smartTopProducts + r.int(80, 220)));
  }
  const latest = [...crawls].reverse().find((c) => c.status === 'completed' && c.type === 'smart')!;
  const sample = r.shuffle(catalog.pages).slice(0, 220);
  crawlUrls[latest.id] = sample.map((p, i): CrawledUrl => {
    const fourOhFour = issues.find((x) => x.checkId === 'TECH-4XX')?.affectedUrls.includes(p.url);
    return { url: p.url, status: fourOhFour ? 404 : i % 47 === 0 ? 301 : 200, reason: p.template === 'home' ? 'homepage' : p.template === 'collection' ? 'collection' : i % 5 === 0 ? 'changed_48h' : i % 7 === 0 ? 'reverify' : 'top_product', responseMs: r.int(180, 2400), changed: i % 5 === 0 };
  });
  crawlUrls[latest.id].push({ url: 'https://deodap.in/products/gone-item-1', status: null, reason: 'reverify', error: 'Timeout after 15000ms' });
  sitemapDiffs[latest.id] = {
    crawlRunId: latest.id,
    added: catalog.products.slice(0, 9).map((p) => p.url),
    removed: catalog.products.slice(40, 45).map((p) => p.url),
    lastmodChanged: catalog.products.slice(60, 72).map((p) => ({ url: p.url, from: addDays(now, -9).toISOString().slice(0, 10), to: dayStr(now) })),
    inSitemapNotCrawled: issues.find((i) => i.checkId === 'TECH-ORPHAN')?.affectedUrls ?? [],
    crawledNotInSitemap: ['https://deodap.in/collections/kitchen-tools/steel', 'https://deodap.in/collections/home-decor?sort_by=price-ascending'],
    invalidEntries: (issues.find((i) => i.checkId === 'TECH-SITEMAP')?.affectedUrls ?? []).slice(0, 10).map((u, i) => ({ url: u, problem: i < 8 ? 'Returns 404' : 'Carries noindex' })),
    source: 'demo',
  };
  const schedules: CrawlSchedule[] = [
    { id: 'SCH-FULL', type: 'full', cron: cfg.crawl.fullCrawlCron, description: 'Weekly full crawl — all indexable URLs, JS rendering on a sample (PDF §2.1)', enabled: true, timezone: 'Asia/Kolkata', nextRunAt: nextWeekday(now, 0, 20.5).toISOString(), lastRunId: crawls.filter((c) => c.type === 'full').at(-1)?.id },
    { id: 'SCH-SMART', type: 'smart', cron: cfg.crawl.smartCrawlCron, description: 'Daily smart crawl — home, collections, top 500 products, changed-48h, re-verify (PDF §2.1)', enabled: true, timezone: 'Asia/Kolkata', nextRunAt: nextDailyUtc(now, 0).toISOString(), lastRunId: latest.id },
  ];

  // ------------------------------------------------------------- performance & visibility
  const cwvRow = (template: CwvTemplateMetric['template'], device: 'mobile' | 'desktop', lcp: number, inp: number, cls: number, psi: number, psiAvg: number, tp: number, tpPrev: number): CwvTemplateMetric => ({
    template, device, lcpMs: lcp, inpMs: inp, cls,
    status: lcp > cfg.thresholds.lcpPoorMs || inp > cfg.thresholds.inpPoorMs || cls > cfg.thresholds.clsPoor ? 'poor' : lcp > cfg.thresholds.lcpMs || inp > cfg.thresholds.inpMs || cls > cfg.thresholds.cls ? 'needs_improvement' : 'good',
    psiScore: psi, psi7dAvg: psiAvg, thirdPartyKb: tp, thirdPartyKbWeekAgo: tpPrev, source: 'demo',
  });
  const cwv: CwvTemplateMetric[] = [
    cwvRow('origin', 'mobile', 3100, 220, 0.07, 58, 64, 690, 610), cwvRow('origin', 'desktop', 1900, 120, 0.04, 82, 84, 690, 610),
    cwvRow('home', 'mobile', 2900, 190, 0.06, 61, 73, 640, 600), cwvRow('home', 'desktop', 1700, 110, 0.03, 85, 86, 640, 600),
    cwvRow('collection', 'mobile', 2700, 210, 0.09, 63, 65, 655, 620), cwvRow('collection', 'desktop', 1800, 130, 0.05, 83, 83, 655, 620),
    cwvRow('product', 'mobile', 4600, 240, 0.08, 49, 55, 722, 612), cwvRow('product', 'desktop', 2300, 150, 0.06, 74, 77, 722, 612),
  ];
  const indexation = Array.from({ length: 30 }, (_, i) => {
    const d = addDays(now, -29 + i);
    return { date: dayStr(d), indexed: 4380 + i * 4 + r.int(-15, 15) - (i > 25 ? 22 : 0), excluded: 1650 - i * 3 + r.int(-20, 20), crawledNotIndexed: 410 + r.int(-12, 18) + (i > 25 ? 28 : 0), source: 'demo' as const };
  });
  const visibility = Array.from({ length: 30 }, (_, i) => {
    const d = addDays(now, -29 + i);
    const impressions = 21000 + i * 120 + r.int(-1500, 1500);
    return { date: dayStr(d), impressions, clicks: Math.round(impressions * r.float(0.045, 0.055)), avgPosition: Math.round((18.5 - i * 0.05 + r.float(-0.6, 0.6)) * 10) / 10, source: 'demo' as const };
  });
  const comps = cfg.competitors;
  const aiTrend: AiVisibilityTrendPoint[] = Array.from({ length: 12 }, (_, i) => ({
    week: dayStr(addDays(now, -7 * (11 - i))),
    mentionShare: { DeoDap: Math.round((26 + i * 0.8 + r.float(-3, 3) - (i === 11 ? 6 : 0)) * 10) / 10, [comps[0].name]: Math.round(r.float(30, 38) * 10) / 10, [comps[1].name]: Math.round(r.float(18, 26) * 10) / 10, [comps[2].name]: Math.round(r.float(8, 14) * 10) / 10 },
    source: 'demo',
  }));
  const promptSeeds = ['best wholesale supplier for kitchen products India', 'dropshipping sites with no MOQ', 'where to buy household items in bulk India', 'wholesale toys supplier online India', 'cheap wholesale gifts for Diwali', 'best dropshipping supplier for Shopify India', 'wholesale water bottles supplier', 'bulk return gifts for weddings India', 'wholesale mobile accessories India', 'online wholesale market India no minimum order'];
  const engines = ['chatgpt', 'gemini', 'perplexity', 'copilot', 'google_aio'] as const;
  const aiPrompts: AiVisibilityPrompt[] = Array.from({ length: cfg.thresholds.aiPromptPanelSize }, (_, i) => ({
    id: `PRM-${pad(i + 1, 3)}`, prompt: i < promptSeeds.length ? promptSeeds[i] : `${r.pick(['best', 'cheap', 'reliable', 'top'])} wholesale ${r.pick(['kitchen', 'home decor', 'toys', 'stationery', 'cleaning', 'bathroom', 'gift', 'gadget'])} ${r.pick(['supplier', 'website', 'marketplace', 'seller'])} ${r.pick(['India', 'online', 'for resellers', 'with COD'])}`,
    category: r.pick(['kitchen', 'home', 'toys', 'gifts', 'dropshipping', 'general']),
    results: engines.map((e) => { const m = r.chance(0.3); return { engine: e, mentioned: m, cited: m && r.chance(0.5), competitorsMentioned: comps.filter(() => r.chance(0.4)).map((c) => c.name), sampledAt: addDays(now, -r.int(0, 6)).toISOString() }; }),
    source: 'demo',
  }));

  // ------------------------------------------------------------- off-page
  const domains = ['news-site.example', 'blog.example', 'directory.example', 'reseller-forum.example', 'kitchen-review.example', 'shopify-tips.example', 'startup-india.example', 'gift-ideas.example', 'deals-hub.example', 'home-guide.example'];
  const spam = ['xn--spam1.example', 'linkfarm-77.example', 'casino-links.example', 'cheap-seo-123.example', 'ru-spam.example', 'pbn-network.example'];
  const backlinks: Backlink[] = [];
  for (let i = 0; i < 70; i++) {
    const isSpam = i % 9 === 0;
    const dom = isSpam ? r.pick(spam) : r.pick(domains);
    const status: Backlink['status'] = i < 3 ? 'lost' : i < 18 ? 'new' : 'live';
    backlinks.push({
      id: `BL-${pad(i + 1)}`, sourceUrl: `https://${dom}/post-${i + 1}`, sourceDomain: dom, targetUrl: r.pick([catalog.home.url, ...catalog.collections.slice(0, 8).map((c) => c.url)]),
      anchor: isSpam ? 'wholesale products india' : r.pick(['DeoDap', 'deodap.in', 'wholesale kitchen products', 'this supplier', 'DeoDap wholesale', 'click here']),
      domainRating: isSpam ? r.int(1, 9) : i < 3 ? [58, 44, 41][i] : r.int(12, 72), firstSeen: addDays(now, -r.int(0, 120)).toISOString(), lostAt: status === 'lost' ? addDays(now, -2).toISOString() : undefined,
      status, toxicScore: isSpam ? r.int(70, 98) : r.int(0, 25), toxicSignals: isSpam ? ['Link-farm pattern', 'Foreign-language spam', 'Exact-match commercial anchor'] : [], anchorType: isSpam ? 'exact_match' : 'branded', source: 'demo',
    });
  }
  const refTrend: ReferringDomainTrendPoint[] = Array.from({ length: 30 }, (_, i) => ({
    date: dayStr(addDays(now, -29 + i)), values: { DeoDap: 812 + i * 2 + r.int(-3, 3), [comps[0].name]: 1430 + i * 3, [comps[1].name]: 960 + i, [comps[2].name]: 530 + i }, source: 'demo',
  }));
  const prospects: LinkProspect[] = ['indian-retail-news.example', 'small-business-india.example', 'ecommerce-weekly.example', 'reseller-guide.example', 'festive-shopping.example', 'home-kitchen-mag.example', 'toy-trade.example', 'd2c-founders.example'].map((d, i) => {
    const dr = r.int(30, 75); const rel = Math.round(r.float(0.4, 0.95) * 100) / 100;
    const lp: LinkProspect = { id: `LP-${pad(i + 1, 3)}`, domain: d, domainRating: dr, relevance: rel, linksToCompetitors: comps.slice(0, r.int(2, 3)).map((c) => c.name), pitchAngle: r.pick(['Wholesale price index data story', 'No-MOQ supplier guide for new resellers', 'Diwali bulk-gifting trend data', 'Expert quote on dropshipping in India']), priority: Math.round(dr * rel), status: i === 0 ? 'outreach' : 'new', source: 'demo' };
    return lp;
  }).sort((a, b) => b.priority - a.priority);
  const mentions: BrandMention[] = Array.from({ length: 9 }, (_, i) => ({ id: `BM-${pad(i + 1, 3)}`, url: `https://${r.pick(domains)}/article-${i + 10}`, domain: r.pick(domains), snippet: r.pick(['…sourced our stock from DeoDap, which has no minimum order…', '…suppliers like DeoDap make it easy to start…', '…DeoDap offers COD on wholesale orders…']), foundAt: addDays(now, -r.int(0, 20)).toISOString(), linked: false, status: i < 2 ? 'outreach' : 'new', source: 'demo' }));
  const disavow: DisavowCandidate[] = spam.map((d, i) => ({ id: `DV-${pad(i + 1, 3)}`, domain: d, toxicScore: r.int(72, 98), signals: ['Link-farm pattern', 'Exact-match commercial anchors', i % 2 ? 'Foreign-language spam' : 'Thin PBN content'], firstSeen: addDays(now, -r.int(1, 25)).toISOString(), approval: i === 0 ? 'approved' : 'pending', decidedById: i === 0 ? 'emp-ritesh' : undefined, decidedAt: i === 0 ? addDays(now, -3).toISOString() : undefined, source: 'demo' }));
  const competitors = comps.map((c, i) => ({ domain: c.domain, name: c.name, visibility: Array.from({ length: 8 }, (_, w) => Math.round(30 + i * -6 + w * r.float(-0.5, 1.2))), cwv: ['needs_improvement', 'good', 'poor'][i], referringDomains: [1490, 990, 560][i], contentVelocity: [14, 9, 4][i], source: 'demo' as DataSource }));
  competitors.unshift({ domain: 'deodap.in', name: 'DeoDap', visibility: Array.from({ length: 8 }, (_, w) => Math.round(22 + w * 0.7)), cwv: 'needs_improvement', referringDomains: 870, contentVelocity: 6, source: 'demo' });
  const localHealth = {
    napConsistency: [
      { directory: 'Google Business Profile', consistent: true, detail: 'Matches canonical NAP' },
      { directory: 'Directory A (DEMO)', consistent: false, detail: 'Old warehouse address' },
      { directory: 'Directory B (DEMO)', consistent: false, detail: 'Old phone number' },
      { directory: 'Directory C (DEMO)', consistent: false, detail: 'Business name variant "Deo Dap"' },
      { directory: 'Directory D (DEMO)', consistent: true, detail: 'Matches' },
    ],
    gbp: { rating: 4.2, reviews: 1843, reviewVelocity30d: 37, completeness: 82 },
  };

  // ------------------------------------------------------------- opportunities
  const gapKws = ['wholesale steel bottles india', 'kitchen gadgets wholesale', 'return gifts bulk india', 'diwali decoration wholesale', 'dropshipping toys india', 'bulk stationery supplier', 'cleaning products wholesale', 'mobile stand wholesale', 'baby products wholesale india', 'garden tools wholesale', 'travel organizer bulk', 'rakhi gifts wholesale', 'home decor wholesale market', 'how to start dropshipping in india', 'best wholesale website india', 'kitchen storage containers bulk', 'led lights wholesale diwali', 'personal care products wholesale', 'school supplies bulk india', 'party supplies wholesale holi'];
  const keywordGaps: KeywordGap[] = gapKws.map((k, i) => ({
    id: `KG-${pad(i + 1, 3)}`, keyword: k, volume: r.int(320, 14800), difficulty: r.int(8, 64), intent: k.startsWith('how') || k.startsWith('best') ? 'informational' : i % 3 === 0 ? 'commercial' : 'transactional',
    competitorsRanking: comps.slice(0, r.int(2, 3)).map((c) => ({ domain: c.domain, position: r.int(1, 10) })), deodapPosition: r.chance(0.4) ? r.int(11, 60) : undefined,
    relevantCategory: r.pick(catalog.collections.slice(0, 15)).title, quickWin: false, status: i < 2 ? 'brief_created' : i === 2 ? 'approved' : 'new', source: 'demo',
  }));
  for (const g of keywordGaps) g.quickWin = (g.difficulty ?? 100) < 25;
  const striking: StrikingDistanceQuery[] = Array.from({ length: 15 }, (_, i) => {
    const p = r.pick([...catalog.collections.slice(0, 20), ...catalog.products.slice(0, 50)]);
    const impressions = r.int(400, 9000);
    const pos = Math.round(r.float(5, 20) * 10) / 10;
    const clicks = Math.round(impressions * r.float(0.004, 0.03));
    const sd: StrikingDistanceQuery = { id: `SD-${pad(i + 1, 3)}`, query: `${p.title.toLowerCase()} ${r.pick(['wholesale', 'online', 'price', 'bulk', 'india'])}`, url: p.url, position: pos, impressions, clicks, ctr: Math.round((clicks / impressions) * 1000) / 10, source: 'demo' };
    return sd;
  }).sort((a, b) => b.impressions - a.impressions);
  const bottle = catalog.products.find((p) => p.collectionHandle === 'water-bottles')!;
  const ctrRewrites: CtrRewrite[] = [bottle, ...catalog.collections.slice(0, 3)].map((p, i) => {
    const kw = i === 0 ? 'wholesale water bottles' : p.title.toLowerCase();
    const titles = [`${cap(kw)} – No MOQ, Wholesale Price | DeoDap`, `Buy ${p.title} in Bulk – COD Available | DeoDap`, `${p.title} at Wholesale Rates – Fast Shipping | DeoDap`];
    return {
      id: `CTR-${pad(i + 1, 3)}`, query: kw, url: p.url, position: Math.round(r.float(2, 5) * 10) / 10, ctr: Math.round(r.float(1.5, 3.2) * 10) / 10, benchmarkCtr: [9.8, 7.2, 5.1, 4.2][i],
      currentTitle: `${p.title} | DeoDap`, currentMeta: 'Buy online at best price.',
      variants: titles.map((t, j) => ({ label: `Variant ${'ABC'[j]}`, title: t, meta: `Shop ${p.title} with No MOQ, wholesale pricing, COD and fast shipping across India.`, score: heuristicCtrScore(t, kw, 'title'), scoreBasis: 'Heuristic estimate — not a measured CTR' })),
      source: 'demo',
    };
  });
  const briefs: ContentBrief[] = [
    { id: 'BRF-001', title: 'Wholesale steel bottles in India: buyer guide', targetKeyword: 'wholesale steel bottles india', cluster: 'Water Bottles', intent: 'commercial', suggestedUrl: '/blogs/news/wholesale-steel-bottles-india-guide', pageType: 'buying_guide', origin: 'keyword_gap', originRef: 'KG-001', status: 'approved', updatedAt: addDays(now, -2).toISOString(),
      outline: ['Why resellers stock steel bottles', 'Single-wall vs insulated: what sells', 'Capacity guide (500ml–1.5L)', 'Bulk pricing and No-MOQ ordering', 'FAQ'], entities: ['stainless steel 304', 'insulation', 'BPA', 'capacity', 'GST invoice'], faqs: [{ q: 'What is the MOQ for steel bottles?', a: 'DeoDap has no MOQ.' }, { q: 'Are bottles food-grade?' }], internalLinks: [{ from: '/collections/water-bottles', anchor: 'wholesale water bottles' }], source: 'demo' },
    { id: 'BRF-002', title: 'How to choose a water bottle supplier', targetKeyword: 'how to choose water bottle supplier', cluster: 'Water Bottles', intent: 'informational', suggestedUrl: '/blogs/news/choose-water-bottle-supplier', pageType: 'blog', origin: 'intent_mismatch', status: 'in_production', updatedAt: addDays(now, -5).toISOString(),
      outline: ['Questions to ask a supplier', 'Material and safety documentation', 'Sampling before bulk orders', 'Shipping and COD'], entities: ['supplier', 'sample order', 'certificate'], faqs: [{ q: 'Should I order samples first?' }], internalLinks: [{ from: '/collections/water-bottles', anchor: 'water bottle range' }], source: 'demo' },
    { id: 'BRF-003', title: 'Return gifts in bulk for weddings', targetKeyword: 'return gifts bulk india', cluster: 'Festive & Gifts', intent: 'transactional', suggestedUrl: '/collections/wedding-return-gifts', pageType: 'collection', origin: 'seasonal', status: 'draft', updatedAt: addDays(now, -1).toISOString(),
      outline: ['Intro: wedding season return gifts', 'Gifts under ₹99 / ₹199', 'Customisation & packaging', 'FAQ'], entities: ['return gifts', 'wedding season', 'bulk packing'], faqs: [{ q: 'Can I order 500 pieces?' }], internalLinks: [{ from: '/collections/festive-gifts', anchor: 'festive gifts' }], source: 'demo' },
    { id: 'BRF-004', title: 'Is DeoDap safe for dropshipping? (PAA gap)', targetKeyword: 'is deodap safe', cluster: 'Dropshipping', intent: 'navigational', suggestedUrl: '/pages/faq#trust', pageType: 'faq', origin: 'paa_gap', status: 'draft', updatedAt: addDays(now, -1).toISOString(),
      outline: ['Direct answer (40–60 words)', 'Payment & COD', 'Returns', 'Contact & address'], entities: ['DeoDap', 'COD', 'returns policy'], faqs: [{ q: 'Is DeoDap a real company?' }], internalLinks: [], source: 'demo' },
    { id: 'BRF-005', title: 'Wholesale Price Index: 500 kitchen products (citation asset)', targetKeyword: 'wholesale kitchen products price', cluster: 'Kitchen', intent: 'informational', suggestedUrl: '/blogs/news/wholesale-price-index-kitchen', pageType: 'buying_guide', origin: 'citation_gap', status: 'draft', updatedAt: addDays(now, -3).toISOString(),
      outline: ['Methodology', 'Median wholesale price by sub-category', 'Price trend vs last quarter', 'Download table'], entities: ['price index', 'median price', 'kitchen tools'], faqs: [], internalLinks: [{ from: '/collections/kitchen-tools', anchor: 'kitchen tools wholesale' }], source: 'demo' },
  ];
  const clusterNames = ['Water Bottles', 'Kitchen', 'Dropshipping', 'Festive & Gifts', 'Toys', 'Home Decor'];
  const clusters: TopicCluster[] = clusterNames.map((n, i) => {
    const pagesIn = catalog.blogs.slice(i * 3, i * 3 + 4).map((b, j) => ({ url: b.url, linksToPillar: j % 3 !== 2, linkedFromPillar: j % 2 === 0 }));
    const integ = Math.round((pagesIn.filter((p) => p.linksToPillar && p.linkedFromPillar).length / Math.max(1, pagesIn.length)) * 100);
    return { id: `CL-${pad(i + 1, 3)}`, name: n, pillarUrl: i === 5 ? undefined : catalog.collections[i * 3]?.url, pillarStatus: i === 5 ? 'missing' : i === 2 ? 'thin' : 'live', pages: pagesIn, completeness: [72, 64, 48, 55, 40, 22][i], interlinkIntegrity: integ, trafficTrend: Array.from({ length: 8 }, (_, w) => ({ week: dayStr(addDays(now, -7 * (7 - w))), clicks: Math.round(400 + i * 90 + w * r.float(-20, 40)) })), missingSubtopics: [['cleaning bottles', 'capacity guide'], ['knife care'], ['GST for resellers', 'shipping costs'], ['corporate gifting'], ['toy safety standards'], ['pillar page', 'decor trends']][i], source: 'demo' };
  });
  const oppBase: Omit<OpportunityItem, 'id' | 'createdAt' | 'status' | 'source'>[] = [
    ...striking.slice(0, 5).map((s) => ({ kind: 'striking_distance' as const, title: `"${s.query}" at position ${s.position}`, detail: `${s.impressions.toLocaleString('en-IN')} impressions, ${s.ctr}% CTR — quick win`, url: s.url, value: s.impressions })),
    ...ctrRewrites.slice(0, 3).map((c) => ({ kind: 'ctr_rewrite' as const, title: `Rewrite title/meta for "${c.query}"`, detail: `CTR ${c.ctr}% vs benchmark ${c.benchmarkCtr}% at position ${c.position}`, url: c.url, value: 900 })),
    ...briefs.map((b) => ({ kind: 'content_brief' as const, title: `Content brief: ${b.title}`, detail: `${b.intent} · ${b.pageType} · ${b.targetKeyword}`, url: b.suggestedUrl, value: 700 })),
    ...prospects.slice(0, 4).map((p) => ({ kind: 'link_prospect' as const, title: `Link prospect: ${p.domain} (DR ${p.domainRating})`, detail: `Links to ${p.linksToCompetitors.join(', ')} — pitch: ${p.pitchAngle}`, value: p.priority * 10 })),
    ...mentions.slice(0, 3).map((m) => ({ kind: 'brand_mention' as const, title: `Unlinked mention on ${m.domain}`, detail: m.snippet, url: m.url, value: 400 })),
    { kind: 'paa_gap', title: 'PAA: "Is DeoDap safe?" not answered on site', detail: 'Auto-generated brief BRF-004', value: 650 },
    { kind: 'snippet_target', title: 'Snippet target: "what is no moq wholesale" (pos 4)', detail: 'Suggest a 45-word definition paragraph under a question H2', value: 600 },
    { kind: 'seasonal', title: 'Diwali gifting — 60-day prompt', detail: 'Refresh Festive & Gifts and Home Decor collections; new Diwali landing page', value: 1200 },
    { kind: 'digital_pr', title: 'Data story: Diwali bulk-gifting price trends', detail: 'Use DeoDap order data (aggregated) for a press-worthy index', value: 800 },
    { kind: 'citation_gap', title: 'No citation-worthy original data published', detail: 'Wholesale Price Index brief BRF-005', value: 750 },
  ];
  const opportunities: OpportunityItem[] = oppBase.map((o, i) => ({ ...o, id: `OPP-${pad(i + 1, 3)}`, status: 'open', createdAt: addDays(now, -r.int(0, 6)).toISOString(), source: 'demo' }));

  // ------------------------------------------------------------- AI compliance & content
  const rules: CustomRule[] = EXAMPLE_RULES.map((er, i) => ({ ...er, id: `RULE-${pad(i + 1, 3)}`, createdById: 'emp-pooja', createdAt: addDays(now, -40 + i).toISOString(), updatedAt: addDays(now, -10 + i).toISOString(), source: 'demo' }));
  const pageTexts = buildPageTexts(catalog, r, now);
  const aiFlags: AiComplianceFlag[] = issues.filter((i) => i.module === 'ai_compliance' && !i.isTemplateGroup).map((i, n) => ({
    id: `AIF-${pad(n + 1, 3)}`, issueId: i.id, checkId: i.checkId, ruleName: CHECKS_BY_ID[i.checkId].name, url: i.affectedUrls[0], template: i.template ?? 'product',
    passage: i.evidence.find((e) => e.kind === 'text_passage')?.content ?? i.summary, explanation: `${CHECKS_BY_ID[i.checkId].detects} Policy: ${CHECKS_BY_ID[i.checkId].policy}.`,
    severity: i.severity, rewrite: rewriteFor(i.checkId), qaHold: i.checkId === 'AIC-07', qaHoldStatus: i.checkId === 'AIC-07' ? 'held' : undefined, detectedAt: i.detectedAt, source: 'demo',
  }));
  aiFlags.push({ id: `AIF-${pad(aiFlags.length + 1, 3)}`, checkId: 'RULE-001', ruleName: rules[0].name, url: catalog.collections[4].url, template: 'collection', passage: '…the lowest price in India on every kitchen tool…', explanation: 'Custom rule: unsupported lowest-price claim.', severity: 'medium', rewrite: '…wholesale pricing on every kitchen tool, with no minimum order…', qaHold: false, detectedAt: addHours(now, -5).toISOString(), source: 'demo' });
  const contentScores: ContentScore[] = [...catalog.collections.slice(0, 25), ...catalog.products.slice(0, 35), ...catalog.blogs.slice(0, 10)].map((p) => {
    const comp = { uniqueness: r.int(20, 100), depth: r.int(15, 100), readability: r.int(40, 95), media: r.int(10, 100), freshness: r.int(10, 100) };
    const score = Math.round(comp.uniqueness * 0.3 + comp.depth * 0.3 + comp.readability * 0.15 + comp.media * 0.15 + comp.freshness * 0.1);
    const wc = r.int(40, 1400);
    return { url: p.url, template: p.template, tier: p.tier, score, components: comp, wordCount: wc, serpAvgWords: r.int(600, 1800), lastUpdated: p.lastModified, explanation: `Uniqueness ${comp.uniqueness}×0.30 + depth ${comp.depth}×0.30 + readability ${comp.readability}×0.15 + media ${comp.media}×0.15 + freshness ${comp.freshness}×0.10`, source: 'demo' };
  });

  // ------------------------------------------------------------- notifications, deliveries, alerts
  const criticals = issues.filter((i) => i.severity === 'critical' && !i.supersededById && ['NEW', 'ASSIGNED', 'IN_PROGRESS'].includes(i.status));
  const alertTypeFor = (c: string) => ({ 'TECH-NOINDEX': 'tier1_noindex', 'PERF-CRUX': 'cwv_poor_template', 'TECH-5XX': 'sitewide_5xx', 'TECH-ROBOTS': 'robots_change', 'TECH-HTTPS': 'ssl_failure', 'TECH-INDEX-COVERAGE': 'index_collapse', 'OFF-TOXIC': 'toxic_link_spike' } as Record<string, string>)[c];
  const criticalAlerts = issues.filter((i) => alertTypeFor(i.checkId) && i.severity === 'critical').map((i, n) => ({ id: `ALR-${pad(n + 1, 3)}`, type: alertTypeFor(i.checkId)!, title: i.title, at: i.detectedAt, issueId: i.id }));
  const deliveries: DeliveryAttempt[] = [];
  let dN = 0;
  for (const a of criticalAlerts) for (const ch of ['slack', 'whatsapp'] as const) deliveries.push({ id: `DLV-${pad(++dN)}`, channel: ch, kind: 'realtime_alert', subject: a.title, at: a.at, outcome: 'skipped_not_configured', retryable: false, error: `${ch === 'slack' ? 'SLACK_WEBHOOK_URL' : 'WHATSAPP_API_TOKEN'} not configured — alert recorded in-app only.`, issueId: a.issueId });
  for (let d = 6; d >= 0; d--) for (const ch of ['email', 'whatsapp', 'slack'] as const) deliveries.push({ id: `DLV-${pad(++dN)}`, channel: ch, kind: 'daily_digest', subject: `Daily SEO digest — ${dayStr(addDays(now, -d))}`, at: addHours(new Date(Date.UTC(addDays(now, -d).getUTCFullYear(), addDays(now, -d).getUTCMonth(), addDays(now, -d).getUTCDate())), 2.5).toISOString(), outcome: 'skipped_not_configured', retryable: false, error: 'Delivery adapter not configured (DEMO)' });

  const notifications: Notification[] = [];
  let nN = 0;
  for (const e of employees.filter((x) => x.status === 'active')) {
    const mine = tasks.filter((t) => t.assigneeId === e.id);
    for (const t of mine.slice(0, 4)) notifications.push({ id: `NTF-${pad(++nN)}`, recipientId: e.id, type: 'assignment', title: `Assigned: ${t.title}`, body: `${TEAMS[t.team].name} · due ${new Date(t.dueAt).toLocaleDateString('en-IN')}`, link: `/tasks/${t.id}`, createdAt: t.createdAt, severity: t.severity, readAt: nN % 3 === 0 ? now.toISOString() : undefined });
    if (e.teamIds.some((t) => t === 'seo' || t === 'development')) for (const a of criticalAlerts.slice(0, 3)) notifications.push({ id: `NTF-${pad(++nN)}`, recipientId: e.id, type: 'alert', title: `Critical alert: ${a.title}`, body: 'Real-time alert (bypasses digest). External channels not configured — in-app only.', link: `/issues/${a.issueId}`, createdAt: a.at, severity: 'critical' });
    notifications.push({ id: `NTF-${pad(++nN)}`, recipientId: e.id, type: 'digest', title: `Daily digest ready — ${dayStr(now)}`, body: `Health ${health.score} · ${criticals.length} open Criticals`, link: '/reports/daily', createdAt: addHours(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), 2.5).toISOString() });
  }
  notifications.push({ id: `NTF-${pad(++nN)}`, recipientId: 'emp-ritesh', type: 'escalation', title: 'Unallocated Critical auto-assigned after 24h', body: 'Sentinel created tasks for Criticals left unallocated >24h (PDF §12.4).', link: '/issues?team=unallocated', createdAt: addHours(now, -3).toISOString(), severity: 'critical' });
  notifications.push({ id: `NTF-${pad(++nN)}`, recipientId: 'emp-ritesh', type: 'review', title: 'Review requested: ALT text on Tier 1 products', body: 'Submitted with before/after evidence.', link: `/tasks/${altTask?.id}`, createdAt: addHours(now, -3).toISOString() });

  // audit for tasks
  for (const t of tasks) for (const a of t.activity) if (a.type !== 'created') log(a.at, a.actorId, `task.${a.type}`, 'task', t.id, a.message);
  for (const v of verifications) log(v.at, 'system', 'verification.run', 'verification', v.id, `${v.outcome.toUpperCase()} — ${v.details}`);
  log(addDays(now, -20), 'emp-ritesh', 'config.update', 'config', 'thresholds', 'Initial threshold configuration loaded from PDF defaults');
  log(addDays(now, -3), 'emp-ritesh', 'disavow.approve', 'disavow', 'DV-001', `Approved disavow candidate ${spam[0]}`);
  audit.sort((a, b) => a.at.localeCompare(b.at));

  const errors: SystemErrorEntry[] = [
    { id: 'ERR-001', at: addDays(now, -12).toISOString(), level: 'error', component: 'crawler', message: 'Smart crawl aborted: origin returned 429 to crawler user agent (DEMO)' },
    { id: 'ERR-002', at: addHours(now, -26).toISOString(), level: 'warn', component: 'notifications', message: 'Daily digest not delivered: no email/WhatsApp/Slack adapter configured' },
    { id: 'ERR-003', at: addHours(now, -5).toISOString(), level: 'warn', component: 'connectors', message: 'GSC connector not configured — index coverage, CTR and decay checks unavailable for live data' },
  ];

  return {
    generatedAt: now.toISOString(), config: cfg, permissions: structuredClone(DEFAULT_PERMISSIONS), employees, passwords, catalog, siteSize,
    issues, groups, exclusions, tasks, crawls, crawlUrls, sitemapDiffs, schedules, verifications, healthHistory, cwv, indexation, visibility,
    aiTrend, aiPrompts, backlinks, refTrend, prospects, mentions, disavow, competitors, localHealth, keywordGaps, striking, ctrRewrites,
    briefs, clusters, opportunities, rules, aiFlags, contentScores, pageTexts, notifications, deliveries, audit, criticalAlerts, errors,
  };
}

function rewriteFor(checkId: string): string | undefined {
  switch (checkId) {
    case 'AIC-01': return 'Write each bottle page around its own facts: capacity, insulation hours, lid type, pack size and wholesale price slab — no shared opener.';
    case 'AIC-02': return 'This 3-in-1 vegetable chopper has 3 stainless-steel blades (fine, medium, slicer), a 900ml container and a non-slip base. Resellers buy it in packs of 6 or 12 — no minimum order.';
    case 'AIC-03': return 'IPX4 splash-resistant: safe against rain and splashes, not for submersion.';
    case 'AIC-07': return 'Made from PP plastic. [Add BPA-free claim only after the supplier test certificate is attached to the product metafield.]';
    case 'AIC-09': return 'Stock up on toys your customers love — building blocks, RC cars and puzzles at wholesale prices with no minimum order.';
    case 'AIC-12': return 'Key features: …  (remove "As of 2023" and literal ** markup)';
    default: return undefined;
  }
}

function buildPageTexts(cat: Catalog, r: Rng, now: Date): PageText[] {
  const out: PageText[] = [];
  const good = (name: string) => `${name} with durable build and clear specifications. Pack sizes of 6 and 12 available for resellers. No MOQ — order a single piece at wholesale price. COD available across India and fast shipping from our warehouse. Dimensions, material and care instructions are listed in the specification table below.`;
  const boiler = (name: string) => `In today's fast-paced world, every home deserves the best. The ${name} will elevate your kitchen experience. Whether you're a student or a professional, this product is perfect for you. In conclusion, buy the ${name} today.`;
  const variants = [
    (n: string) => good(n),
    (n: string) => boiler(n),
    (n: string) => `${n} – **Key Features:** As of 2023, this is the most popular choice. Get the lowest price in India.`,
    (n: string) => `${n}. 100% BPA-free and child-safe for toddlers. Diwali offer: special discount on bulk orders!`,
    (n: string) => `${n} wholesale toys wholesale toys best wholesale toys online wholesale toys india buy wholesale toys.`,
  ];
  [...cat.products.slice(0, 120), ...cat.collections, ...cat.blogs].forEach((p, i) => {
    const v = variants[i % variants.length];
    out.push({ url: p.url, template: p.template, tier: p.tier, collectionHandle: p.collectionHandle, text: v(p.title), publishedAt: addDays(now, -r.int(0, 29)).toISOString() });
  });
  return out;
}

function nextDailyUtc(now: Date, hourUtc: number) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
  return d > now ? d : addDays(d, 1);
}
function nextWeekday(now: Date, istDay: number, hourUtcPrevDay: number) {
  // Sunday 02:00 IST = Saturday 20:30 UTC
  for (let i = 0; i < 8; i++) {
    const d = addDays(now, i);
    const cand = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(hourUtcPrevDay), (hourUtcPrevDay % 1) * 60));
    const ist = new Date(cand.getTime() + 5.5 * 3600000);
    if (ist.getUTCDay() === istDay && cand > now) return cand;
  }
  return addDays(now, 7);
}
const cap = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
