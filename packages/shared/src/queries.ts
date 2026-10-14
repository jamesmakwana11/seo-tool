/**
 * Pure read-model functions over Sentinel state. Used by the Phase 1 mock adapter and
 * the Phase 2 backend services (which feed them repository data). No I/O here.
 */
import type {
  AuditModule, DailyDigest, DeliveryAttempt, Employee, HealthPoint, Issue, MonthlyReport, Paged, ReportMeta,
  SearchResult, SentinelConfig, Severity, Task, TeamId, WeeklyReport, AuditLogEntry, CwvTemplateMetric,
  AiVisibilityTrendPoint, StrikingDistanceQuery, CtrRewrite, ContentBrief, AiComplianceFlag, LinkProspect,
  OpportunityItem, CrawlRun, AiVisibilityPrompt, Backlink, VerificationAttempt, DataSource, FestivalEntry, CheckDefinition,
} from './types';
import { siteHasAuditData } from './websites';
import type { IssueFilter, DashboardData, ModuleData } from './api';
import { SEVERITY_ORDER } from './rules/severity';
import { isIssueOpen } from './rules/escalation';
import { slaState } from './rules/sla';
import { computeHealthScore } from './rules/healthScore';
import { CHECKS, MODULE_LABELS } from './checks/library';
import { TEAMS } from './config';
import { generateFixCard } from './fixcards/generate';
import { comparePriority } from './rules/priority';

export interface SentinelView {
  config: SentinelConfig;
  siteSize: number;
  issues: Issue[];
  tasks: Task[];
  employees: Employee[];
  verifications: VerificationAttempt[];
  crawls: CrawlRun[];
  healthHistory: HealthPoint[];
  cwv: CwvTemplateMetric[];
  indexation: DashboardData['indexation'];
  visibility: DashboardData['visibility'];
  aiTrend: AiVisibilityTrendPoint[];
  aiPrompts: AiVisibilityPrompt[];
  backlinks: Backlink[];
  prospects: LinkProspect[];
  striking: StrikingDistanceQuery[];
  ctrRewrites: CtrRewrite[];
  briefs: ContentBrief[];
  aiFlags: AiComplianceFlag[];
  opportunities: OpportunityItem[];
  deliveries: DeliveryAttempt[];
  criticalAlerts: { id: string; type: string; title: string; at: string; issueId?: string }[];
  audit: AuditLogEntry[];
  competitors: { domain: string; name: string; visibility: number[]; cwv: string; referringDomains: number; contentVelocity: number; source: DataSource }[];
  /** Which external sources are live. Missing/false ⇒ figures shown are DEMO or unavailable. */
  liveSources: Partial<Record<'gsc' | 'ga4' | 'crux' | 'backlinks' | 'ai_engines' | 'crawler' | 'shopify' | 'gbp', boolean>>;
}

export function paginate<T>(items: T[], page = 1, pageSize = 25): Paged<T> {
  const p = Math.max(1, page);
  const ps = Math.min(200, Math.max(1, pageSize));
  return { items: items.slice((p - 1) * ps, p * ps), total: items.length, page: p, pageSize: ps };
}

// ------------------------------------------------------------------ issues

export function filterIssues(issues: Issue[], f: IssueFilter, now = new Date()): Paged<Issue> {
  let list = issues.filter((i) => (f.includeSuperseded ? true : i.status !== 'SUPERSEDED'));
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((i) => i.id.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || i.checkId.toLowerCase().includes(q) || i.affectedUrls.some((u) => u.toLowerCase().includes(q)));
  }
  if (f.severity?.length) list = list.filter((i) => f.severity!.includes(i.severity));
  if (f.module?.length) list = list.filter((i) => f.module!.includes(i.module));
  if (f.status?.length) list = list.filter((i) => f.status!.includes(i.status));
  if (f.team?.length) list = list.filter((i) => (i.allocatedTeam ? f.team!.includes(i.allocatedTeam) : f.team!.includes('unallocated')));
  if (f.allocatorId) list = list.filter((i) => i.allocation.some((a) => a.allocatedById === f.allocatorId));
  if (f.template?.length) list = list.filter((i) => i.template && f.template!.includes(i.template));
  if (f.tier?.length) list = list.filter((i) => f.tier!.includes(i.highestTier));
  if (f.delta?.length) list = list.filter((i) => f.delta!.includes(i.delta));
  if (f.checkId) list = list.filter((i) => i.checkId === f.checkId);
  const dir = f.dir === 'asc' ? 1 : -1;
  const sort = f.sort ?? 'severity';
  const prio = new Map<string, number>();
  if (sort === 'priority') for (const i of list) prio.set(i.id, cachedPriority(i));
  list = [...list].sort((a, b) => {
    switch (sort) {
      case 'severity': {
        const d = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        return (d !== 0 ? d : a.highestTier - b.highestTier) * (f.dir === 'desc' ? -1 : 1);
      }
      case 'detected': return (+new Date(a.detectedAt) - +new Date(b.detectedAt)) * dir;
      case 'sla': return (+new Date(a.slaDueAt) - +new Date(b.slaDueAt)) * (f.dir === 'desc' ? -1 : 1);
      case 'affected': return (a.affectedCount - b.affectedCount) * dir;
      case 'priority': return comparePriority({ priorityScore: prio.get(a.id)!, tier: a.highestTier }, { priorityScore: prio.get(b.id)!, tier: b.highestTier }) * (f.dir === 'asc' ? -1 : 1);
    }
  });
  void now;
  return paginate(list, f.page, f.pageSize);
}

const prioCache = new WeakMap<Issue, number>();
let prioCfg: SentinelConfig | undefined;
export function setPriorityConfig(cfg: SentinelConfig) {
  prioCfg = cfg;
}
function cachedPriority(i: Issue): number {
  if (!prioCfg) return 0;
  let v = prioCache.get(i);
  if (v === undefined) {
    v = generateFixCard(i, prioCfg).priorityScore;
    prioCache.set(i, v);
  }
  return v;
}

/** Open (not yet fixed/verified) SEO issues allocated to each team. */
export function openLoadByIssues(issues: Issue[]): Record<TeamId, number> {
  const out = { seo: 0, content: 0, development: 0 } as Record<TeamId, number>;
  for (const i of issues) if (i.allocatedTeam && !i.supersededById && ['ASSIGNED', 'IN_PROGRESS'].includes(i.status)) out[i.allocatedTeam] += 1;
  return out;
}

// ------------------------------------------------------------------ dashboard & modules

function sourceNotes(v: SentinelView): string[] {
  const notes: string[] = [];
  const names: Record<string, string> = { gsc: 'Google Search Console', ga4: 'GA4', crux: 'PageSpeed/CrUX', backlinks: 'Ahrefs/Semrush', ai_engines: 'AI engine APIs', crawler: 'Site crawler', shopify: 'Shopify Admin', gbp: 'Google Business Profile' };
  const demo = v.issues.some((i) => i.source === 'demo');
  for (const [k, label] of Object.entries(names)) if (!v.liveSources[k as keyof SentinelView['liveSources']]) notes.push(`${label} not connected — ${demo ? 'related figures are DEMO sample data' : 'no data for this website yet'}.`);
  return notes;
}

export function buildDashboard(v: SentinelView, now: Date): DashboardData {
  const health = computeHealthScore(v.issues, v.siteSize, v.config, now, v.liveSources.crawler ? 'live' : 'demo');
  const modules: AuditModule[] = ['technical', 'performance', 'content', 'onpage', 'offpage', 'aeo', 'geo', 'ai_compliance'];
  const open = v.issues.filter((i) => isIssueOpen(i.status) && i.issueClass !== 'opportunity');
  const issueCounts = modules.map((m) => ({
    module: m,
    critical: open.filter((i) => i.module === m && i.severity === 'critical').length,
    medium: open.filter((i) => i.module === m && i.severity === 'medium').length,
    low: open.filter((i) => i.module === m && i.severity === 'low').length,
  }));
  const dayAgo = now.getTime() - 26 * 3600000;
  const todaysChanges: DashboardData['todaysChanges'] = [];
  for (const i of v.issues) {
    if (i.status === 'SUPERSEDED') continue;
    const recent = new Date(i.detectedAt).getTime() >= dayAgo;
    if (recent && (i.delta === 'new' || i.delta === 'recurring' || i.delta === 'worsening')) todaysChanges.push({ kind: i.delta === 'new' ? 'new' : i.delta === 'worsening' ? 'worsening' : 'recurring', issueId: i.id, title: i.title, severity: i.severity, module: i.module });
  }
  for (const vv of v.verifications) if (vv.outcome === 'passed' && new Date(vv.at).getTime() >= dayAgo) {
    const i = v.issues.find((x) => x.id === vv.issueId);
    if (i) todaysChanges.push({ kind: 'resolved', issueId: i.id, title: i.title, severity: i.severity, module: i.module });
  }
  todaysChanges.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const watch: DashboardData['slaWatchlist'] = [];
  for (const i of open) {
    if (i.status === 'FIXED') continue;
    const s = slaState(i.slaDueAt, now, v.config);
    if (s.breached || s.atRisk) watch.push({ kind: 'issue', id: i.id, title: i.title, severity: i.severity, dueAt: i.slaDueAt, breached: s.breached });
  }
  watch.sort((a, b) => +new Date(a.dueAt) - +new Date(b.dueAt));
  const crawlTrend = [...v.crawls].filter((c) => c.type === 'smart').slice(-30).map((c) => ({ date: (c.startedAt ?? '').slice(0, 10), crawled: c.urlsCrawled, failed: c.urlsFailed, newIssues: c.newIssues, resolvedIssues: c.resolvedIssues, source: c.source }));
  return {
    health, healthTrend: v.healthHistory.slice(-30), issueCounts, cwv: v.cwv, indexation: v.indexation, crawlTrend, visibility: v.visibility,
    aiMentions: v.aiTrend, todaysChanges: todaysChanges.slice(0, 25),
    criticalAlerts: v.criticalAlerts.map((a) => ({ ...a, delivered: v.deliveries.filter((d) => d.kind === 'realtime_alert' && d.issueId === a.issueId) })).sort((a, b) => b.at.localeCompare(a.at)),
    slaWatchlist: watch.slice(0, 20), openLoad: openLoadByIssues(v.issues), lastCrawl: [...v.crawls].reverse().find((c) => c.status === 'completed'),
    hasAuditData: siteHasAuditData(v),
    dataNotes: sourceNotes(v),
  };
}

const UNAVAILABLE_WITHOUT: Partial<Record<string, string>> = {
  gsc: 'Google Search Console', ga4: 'GA4', crux: 'CrUX', psi: 'PageSpeed Insights', backlinks: 'Ahrefs/Semrush', gbp: 'Google Business Profile', ai_engines: 'AI engine APIs', llm: 'LLM provider', google_docs_feed: 'Google documentation feed', renderer: 'headless renderer', shopify: 'Shopify Admin API',
};

export function buildModuleData(v: SentinelView, module: AuditModule, now: Date, demoMode: boolean): ModuleData {
  const issues = v.issues.filter((i) => i.module === module && i.status !== 'SUPERSEDED');
  const checks = CHECKS.filter((c) => c.module === module).map((c) => {
    const mine = issues.filter((i) => i.checkId === c.id && isIssueOpen(i.status));
    const needs = c.dataSources.filter((d) => d !== 'crawler' && !(v.liveSources as Record<string, boolean>)[d === 'psi' ? 'crux' : d === 'llm' || d === 'google_docs_feed' || d === 'renderer' ? 'none' : d]);
    const unavailable = !demoMode && needs.length > 0 && !c.crawlerEvaluable;
    const lastStatus: ModuleData['checks'][number]['lastStatus'] = unavailable ? 'unavailable' : mine.some((i) => i.severity === 'critical') ? 'fail' : mine.length ? 'warn' : c.issueClass === 'opportunity' || c.issueClass === 'metric' || c.issueClass === 'report' ? 'not_run' : 'pass';
    return { ...c, lastStatus, openIssues: mine.length, unavailableReason: needs.length ? `Needs: ${needs.map((n) => UNAVAILABLE_WITHOUT[n] ?? n).join(', ')}` : undefined };
  });
  const scoreMod = module === 'content' || module === 'ai_compliance' ? 'content_ai' : module;
  const h = computeHealthScore(v.issues, v.siteSize, v.config, now);
  void MODULE_LABELS;
  return { module, score: h.modules.find((m) => m.module === scoreMod)?.score, checks, issues, dataNotes: demoMode ? ['DEMO data: check results are sample findings, not a live crawl.'] : sourceNotes(v) };
}

// ------------------------------------------------------------------ reports

function reportMeta(kind: ReportMeta['kind'], start: Date, end: Date, v: SentinelView, now: Date, deliveries: DeliveryAttempt[]): ReportMeta {
  const src = (k: keyof SentinelView['liveSources'], name: string) => ({ name, state: v.liveSources[k] ? ('live' as const) : ('demo' as const) });
  const sources = [src('crawler', 'Site crawler'), src('gsc', 'Google Search Console'), src('ga4', 'GA4'), src('crux', 'PageSpeed/CrUX'), src('backlinks', 'Ahrefs/Semrush'), src('ai_engines', 'AI engines'), src('shopify', 'Shopify')];
  return {
    id: `${kind.toUpperCase()}-${end.toISOString().slice(0, 10)}`, kind, periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10), generatedAt: now.toISOString(),
    sources, dataNotes: sources.filter((s) => s.state !== 'live').map((s) => `${s.name}: not connected — section uses DEMO sample data or is unavailable.`),
    deliveries,
  };
}

export function buildDailyDigest(v: SentinelView, now: Date): DailyDigest {
  const start = new Date(now.getTime() - 24 * 3600000);
  const recent = (iso: string) => new Date(iso) >= start;
  const live = v.issues.filter((i) => i.status !== 'SUPERSEDED' && i.status !== 'NOT_AN_ISSUE');
  const health = computeHealthScore(v.issues, v.siteSize, v.config, now);
  const trend7d = [...v.healthHistory.slice(-7, -1), { date: now.toISOString().slice(0, 10), score: health.score, modules: {}, source: health.source }];
  const newCriticals = live.filter((i) => i.severity === 'critical' && recent(i.detectedAt) && i.issueClass !== 'opportunity').map((i) => ({ issueId: i.id, title: i.title, summary: i.summary.slice(0, 160), recommendedTeam: i.recommendedTeam, allocatedTeam: i.allocatedTeam }));
  const mediums = live.filter((i) => i.severity === 'medium' && recent(i.detectedAt));
  const byMod = new Map<AuditModule, DailyDigest['newMediumsByModule'][number]['items']>();
  for (const i of mediums) byMod.set(i.module, [...(byMod.get(i.module) ?? []), { issueId: i.id, title: i.title, recommendedTeam: i.recommendedTeam, allocatedTeam: i.allocatedTeam }]);
  const allAlloc = v.issues.flatMap((i) => i.allocation).filter((a) => recent(a.at));
  const unalloc = v.issues.filter((i) => i.status === 'NEW' && !i.allocatedTeam && i.issueClass !== 'opportunity').map((i) => ({ issueId: i.id, title: i.title, severity: i.severity, hours: Math.round((now.getTime() - +new Date(i.detectedAt)) / 360000) / 10 })).filter((x) => x.hours > v.config.escalation.unallocatedCriticalHours);
  const watch: DailyDigest['watchlist'] = [];
  for (const i of live) if (isIssueOpen(i.status) && i.status !== 'FIXED') { const s = slaState(i.slaDueAt, now, v.config); if (s.atRisk) watch.push({ kind: 'issue', id: i.id, title: i.title, dueAt: i.slaDueAt, hoursLeft: Math.round(s.msRemaining / 360000) / 10 }); }
  watch.sort((a, b) => a.hoursLeft - b.hoursLeft);
  const th = v.config.thresholds;
  return {
    meta: reportMeta('daily', start, now, v, now, v.deliveries.filter((d) => d.kind === 'daily_digest' && d.at.slice(0, 10) === now.toISOString().slice(0, 10))),
    health: { score: health.score, trend7d },
    newCriticals,
    newMediumsByModule: [...byMod.entries()].map(([module, items]) => ({ module, items })),
    aiCompliance: v.aiFlags.filter((f) => recent(f.detectedAt)).map((f) => ({ flagId: f.id, url: f.url, rule: f.ruleName, passage: f.passage, rewrite: f.rewrite, issueId: f.issueId })),
    verifiedFixed: v.verifications.filter((x) => x.outcome === 'passed' && recent(x.at)).map((x) => ({ issueId: x.issueId, title: v.issues.find((i) => i.id === x.issueId)?.title ?? x.issueId, verifiedAt: x.at })),
    opportunities: { strikingDistance: v.striking.slice(0, th.digestOpportunitiesStriking), ctrRewrites: v.ctrRewrites.slice(0, th.digestOpportunitiesCtr), brief: v.briefs.find((b) => b.status === 'draft' || b.status === 'approved') },
    allocation: { yesterday: allAlloc, unallocatedPast24h: unalloc.map((u) => ({ ...u, escalatedToSeoLead: true })), openLoad: openLoadByIssues(v.issues) },
    watchlist: watch.slice(0, 15),
  };
}

export function buildWeeklyReport(v: SentinelView, now: Date): WeeklyReport {
  const start = new Date(now.getTime() - 7 * 86400000);
  const inWeek = (iso?: string) => !!iso && new Date(iso) >= start;
  const engines = ['chatgpt', 'gemini', 'perplexity', 'copilot', 'google_aio'];
  const results = v.aiPrompts.flatMap((p) => p.results);
  const byEngine = Object.fromEntries(engines.map((e) => { const r = results.filter((x) => x.engine === e); return [e, r.length ? Math.round((r.filter((x) => x.mentioned).length / r.length) * 100) : 0]; }));
  const sev: Severity[] = ['critical', 'medium', 'low'];
  const slaCompliance = sev.map((s) => {
    const closed = v.issues.filter((i) => i.severity === s && (i.status === 'VERIFIED' || i.status === 'CLOSED'));
    const within = closed.filter((i) => { const vv = v.verifications.find((x) => x.issueId === i.id && x.outcome === 'passed'); return vv && new Date(vv.at) <= new Date(i.slaDueAt); });
    return { severity: s, total: closed.length, withinSla: within.length, pct: closed.length ? Math.round((within.length / closed.length) * 100) : 100 };
  });
  const top = v.issues.filter((i) => isIssueOpen(i.status) && i.status !== 'FIXED' && i.issueClass !== 'opportunity').map((i) => ({ i, p: generateFixCard(i, v.config, { now }).priorityScore }))
    .sort((a, b) => comparePriority({ priorityScore: a.p, tier: a.i.highestTier }, { priorityScore: b.p, tier: b.i.highestTier }))
    .slice(0, v.config.thresholds.weeklyTopPriorities).map(({ i, p }) => ({ issueId: i.id, title: i.title, priorityScore: p, team: i.allocatedTeam ?? i.recommendedTeam }));
  const latestTrend = v.aiTrend.at(-1)?.mentionShare ?? {};
  return {
    meta: reportMeta('weekly', start, now, v, now, v.deliveries.filter((d) => d.kind === 'weekly_report')),
    offPage: {
      newLinks: v.backlinks.filter((b) => b.status === 'new' && inWeek(b.firstSeen)).length, lostLinks: v.backlinks.filter((b) => b.status === 'lost' && inWeek(b.lostAt)).length,
      toxicDomains: new Set(v.backlinks.filter((b) => (b.toxicScore ?? 0) >= 70 && inWeek(b.firstSeen)).map((b) => b.sourceDomain)).size,
      referringDomainsDelta: new Set(v.backlinks.filter((b) => b.status === 'new').map((b) => b.sourceDomain)).size - new Set(v.backlinks.filter((b) => b.status === 'lost').map((b) => b.sourceDomain)).size,
      prospects: v.prospects.slice(0, 10), digitalPr: v.opportunities.filter((o) => o.kind === 'digital_pr' || o.kind === 'seasonal'),
    },
    aiVisibility: { promptsRun: v.aiPrompts.length, mentionRate: results.length ? Math.round((results.filter((r) => r.mentioned).length / results.length) * 100) : 0, byEngine, competitorShare: latestTrend },
    competitorMovement: v.competitors.filter((c) => c.domain !== v.config.site.canonicalHost).map((c) => ({ domain: c.domain, visibilityDelta: (c.visibility.at(-1) ?? 0) - (c.visibility.at(-2) ?? 0), backlinkDelta: 0, cwvStatus: c.cwv, contentVelocity: c.contentVelocity })),
    slaCompliance, topPriorities: top,
  };
}

export function buildMonthlyReport(v: SentinelView, now: Date): MonthlyReport {
  const start = new Date(now.getTime() - 30 * 86400000);
  const inMonth = (iso: string) => new Date(iso) >= start;
  const opened = v.audit.filter((a) => a.action === 'issue.detected' && inMonth(a.at)).length;
  const closed = v.audit.filter((a) => a.action === 'verification.run' && a.summary.startsWith('PASSED') && inMonth(a.at)).length;
  const clicks = v.visibility.reduce((s, x) => s + x.clicks, 0);
  const gscLive = !!v.liveSources.gsc;
  const health = v.healthHistory.filter((h) => new Date(h.date) >= start);
  const crit = v.issues.filter((i) => isIssueOpen(i.status) && i.severity === 'critical' && !i.supersededById);
  const byMod = new Map<string, number>();
  for (const i of crit) byMod.set(i.module, (byMod.get(i.module) ?? 0) + 1);
  const topMod = [...byMod.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    meta: reportMeta('monthly', start, now, v, now, v.deliveries.filter((d) => d.kind === 'monthly_report')),
    organic: {
      // Prev-month / YoY / revenue need ≥2 months (≥13 for YoY) of GSC/GA4 history — null = not available, never invented.
      clicks, clicksPrevMonth: null, clicksYoY: null,
      revenue: null, revenuePrevMonth: null, revenueYoY: null,
    },
    healthTrend: health, issuesOpened: opened, issuesClosed: closed,
    moneyKeywords: v.config.moneyKeywords.map((k) => ({ keyword: k, position: null, prevPosition: null })),
    aiMentionShare: v.aiTrend.at(-1)?.mentionShare ?? {},
    strategicActions: [
      topMod ? `Clear ${topMod[1]} open Critical issue(s) in ${MODULE_LABELS[topMod[0] as AuditModule]} — the largest drag on the Health Score.` : 'Keep Criticals at zero; shift effort to Medium template issues.',
      `Ship the top ${Math.min(3, v.briefs.length)} approved content briefs before the next seasonal window.`,
      'Connect missing data sources (see report notes) so next month\'s report uses live data.',
    ],
    evidenceBasis: `Issue counts generated from ${v.audit.length} audit-log entries (issue.detected / verification.run). ${gscLive ? '' : 'Organic clicks shown are DEMO sample data (GSC not connected); revenue and YoY require GA4 and ≥12 months of history.'}`,
  };
}

/** Plain export formats. */
export function exportReport(kind: 'daily' | 'weekly' | 'monthly', format: 'json' | 'csv' | 'md', report: DailyDigest | WeeklyReport | MonthlyReport): { filename: string; mime: string; content: string } {
  const base = `deodap-sentinel-${kind}-${report.meta.periodEnd}`;
  if (format === 'json') return { filename: `${base}.json`, mime: 'application/json', content: JSON.stringify(report, null, 2) };
  if (format === 'csv') {
    const rows: string[][] = [['section', 'id', 'title', 'detail']];
    if (kind === 'daily') {
      const d = report as DailyDigest;
      d.newCriticals.forEach((c) => rows.push(['new_critical', c.issueId, c.title, c.allocatedTeam ?? 'unallocated']));
      d.newMediumsByModule.forEach((m) => m.items.forEach((i) => rows.push([`new_medium_${m.module}`, i.issueId, i.title, i.allocatedTeam ?? 'unallocated'])));
      d.aiCompliance.forEach((a) => rows.push(['ai_compliance', a.flagId, a.rule, a.url]));
      d.verifiedFixed.forEach((x) => rows.push(['verified_fixed', x.issueId, x.title, x.verifiedAt]));
      d.watchlist.forEach((w) => rows.push(['watchlist', w.id, w.title, `${w.hoursLeft}h left`]));
    } else if (kind === 'weekly') {
      const w = report as WeeklyReport;
      w.topPriorities.forEach((p) => rows.push(['top_priority', p.issueId, p.title, `score ${p.priorityScore} · ${p.team}`]));
      w.slaCompliance.forEach((s) => rows.push(['sla', s.severity, `${s.withinSla}/${s.total}`, `${s.pct}%`]));
    } else {
      const m = report as MonthlyReport;
      m.strategicActions.forEach((a, i) => rows.push(['strategic_action', String(i + 1), a, '']));
      rows.push(['issues', 'opened', String(m.issuesOpened), '']);
      rows.push(['issues', 'closed', String(m.issuesClosed), '']);
    }
    rows.push(['meta', 'data_notes', report.meta.dataNotes.join(' | '), '']);
    return { filename: `${base}.csv`, mime: 'text/csv', content: rows.map((r) => r.map(csvCell).join(',')).join('\n') };
  }
  const lines = [`# DeoDap SEO Sentinel — ${kind} report`, `Period: ${report.meta.periodStart} → ${report.meta.periodEnd}`, `Generated: ${report.meta.generatedAt}`, ''];
  if (report.meta.dataNotes.length) lines.push('> Data notes:', ...report.meta.dataNotes.map((n) => `> - ${n}`), '');
  if (kind === 'daily') {
    const d = report as DailyDigest;
    lines.push(`## SEO Health Score: ${d.health.score}`, '', '## New Criticals', ...(d.newCriticals.length ? d.newCriticals.map((c) => `- ${c.issueId} ${c.title}`) : ['- None 🎯']), '', '## New Mediums');
    d.newMediumsByModule.forEach((m) => lines.push(`### ${MODULE_LABELS[m.module]}`, ...m.items.map((i) => `- ${i.issueId} ${i.title}`)));
    lines.push('', '## Verified fixed', ...d.verifiedFixed.map((x) => `- ${x.issueId} ${x.title}`), '', '## Watchlist', ...d.watchlist.map((w) => `- ${w.id} ${w.title} (${w.hoursLeft}h left)`));
  } else if (kind === 'weekly') {
    const w = report as WeeklyReport;
    lines.push('## Top priorities', ...w.topPriorities.map((p, i) => `${i + 1}. ${p.issueId} ${p.title} — ${TEAMS[p.team].name}`), '', '## SLA compliance', ...w.slaCompliance.map((s) => `- ${s.severity}: ${s.withinSla}/${s.total} (${s.pct}%)`));
  } else {
    const m = report as MonthlyReport;
    lines.push(`Issues opened: ${m.issuesOpened} · closed: ${m.issuesClosed}`, '', '## Recommended strategic actions', ...m.strategicActions.map((a, i) => `${i + 1}. ${a}`), '', `_${m.evidenceBasis}_`);
  }
  return { filename: `${base}.md`, mime: 'text/markdown', content: lines.join('\n') };
}
function csvCell(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ------------------------------------------------------------------ seasonal planner & search

export function seasonalPlan(festivals: FestivalEntry[], collections: { title: string; url: string }[], leadDays: number, now: Date) {
  return festivals.map((f) => {
    const daysUntil = Math.ceil((new Date(`${f.date}T00:00:00+05:30`).getTime() - now.getTime()) / 86400000);
    const matches = collections.filter((c) => f.categories.some((cat) => c.title.toLowerCase().includes(cat.split(' ')[0]))).map((c) => c.url).slice(0, 5);
    return { ...f, daysUntil, inWindow: daysUntil >= 0 && daysUntil <= leadDays, collectionsToRefresh: matches };
  }).sort((a, b) => a.daysUntil - b.daysUntil);
}

export const SCREEN_INDEX: { title: string; href: string; keywords: string }[] = [
  { title: 'Dashboard', href: '/', keywords: 'home overview' }, { title: 'SEO Health Score', href: '/health', keywords: 'score trend modules' },
  { title: 'Issues board', href: '/issues', keywords: 'findings problems' }, { title: 'Template-level issues', href: '/issues/groups', keywords: 'groups bulk' },
  { title: 'Exclusions & false positives', href: '/issues/exclusions', keywords: 'not an issue' }, { title: 'All websites', href: '/websites/overview', keywords: 'sites portfolio overview' },
  { title: 'Websites', href: '/websites', keywords: 'add website domain manage' }, { title: 'Crawl Center', href: '/crawls', keywords: 'crawler schedule run' },
  { title: 'Verification results', href: '/verification', keywords: 're-verify recrawl' }, { title: 'Technical SEO', href: '/modules/technical', keywords: 'robots noindex canonical' },
  { title: 'Performance & Core Web Vitals', href: '/modules/performance', keywords: 'cwv lcp inp cls psi' }, { title: 'Content audit', href: '/modules/content', keywords: 'quality decay' },
  { title: 'On-page SEO', href: '/modules/onpage', keywords: 'title meta h1' }, { title: 'Off-page SEO', href: '/modules/offpage', keywords: 'backlinks toxic' },
  { title: 'AEO', href: '/modules/aeo', keywords: 'answer engine faq' }, { title: 'GEO', href: '/modules/geo', keywords: 'generative eeat' },
  { title: 'AI content compliance', href: '/modules/ai-compliance', keywords: 'ai qa gate' }, { title: 'AI visibility', href: '/modules/ai-visibility', keywords: 'chatgpt gemini perplexity mentions' },
  { title: 'Custom rule builder', href: '/ai-compliance/rules', keywords: 'rules regex llm' }, { title: 'Opportunities', href: '/opportunities', keywords: 'quick wins' },
  { title: 'Keyword research', href: '/opportunities/keywords', keywords: 'striking distance ctr' }, { title: 'Competitor keyword gaps', href: '/opportunities/gaps', keywords: 'gap' },
  { title: 'Content briefs', href: '/opportunities/briefs', keywords: 'brief editor' }, { title: 'Topic clusters', href: '/opportunities/clusters', keywords: 'pillar' },
  { title: 'Seasonal planner', href: '/opportunities/seasonal', keywords: 'diwali festival' }, { title: 'Competitor analysis', href: '/competitors', keywords: 'competitors' },
  { title: 'Link building & digital PR', href: '/opportunities/link-building', keywords: 'prospects outreach' }, { title: 'Brand mentions', href: '/opportunities/mentions', keywords: 'unlinked' },
  { title: 'Daily digest', href: '/reports/daily', keywords: 'report' }, { title: 'Weekly report', href: '/reports/weekly', keywords: 'rollup' },
  { title: 'Monthly executive report', href: '/reports/monthly', keywords: 'exec' }, { title: 'Report history', href: '/reports/history', keywords: 'export' },
  { title: 'Employees', href: '/team/employees', keywords: 'users people' }, { title: 'Roles & permissions', href: '/team/roles', keywords: 'rbac' },
  { title: 'Allocation history', href: '/team/allocations', keywords: 'reallocation trail' }, { title: 'Integrations', href: '/settings/integrations', keywords: 'connectors api keys' },
  { title: 'Thresholds & scoring', href: '/settings/thresholds', keywords: 'sla config tiers' }, { title: 'Crawl configuration', href: '/settings/crawl', keywords: 'crawler settings' },
  { title: 'Notifications & alerts', href: '/settings/notifications', keywords: 'alerts channels slack whatsapp' }, { title: 'Audit log', href: '/audit', keywords: 'history log' },
  { title: 'System health', href: '/system', keywords: 'errors status' }, { title: 'API diagnostics', href: '/diagnostics', keywords: 'developer api' },
];

export function globalSearch(v: Pick<SentinelView, 'issues' | 'employees' | 'briefs'>, q: string, pages: { url: string; title: string; template: string; tier: number }[] = []): SearchResult[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const out: SearchResult[] = [];
  for (const sc of SCREEN_INDEX) if (sc.title.toLowerCase().includes(s) || sc.keywords.includes(s)) out.push({ kind: 'screen', id: sc.href, title: sc.title, subtitle: 'Screen', href: sc.href });
  for (const i of v.issues) if (i.status !== 'SUPERSEDED' && (i.id.toLowerCase() === s || i.title.toLowerCase().includes(s) || i.checkId.toLowerCase().includes(s))) out.push({ kind: 'issue', id: i.id, title: i.title, subtitle: `${i.id} · ${i.severity}`, href: `/issues/${i.id}` });
  for (const e of v.employees) if (e.name.toLowerCase().includes(s) || e.email.toLowerCase().includes(s)) out.push({ kind: 'employee', id: e.id, title: e.name, subtitle: e.title, href: `/team/employees?focus=${e.id}` });
  for (const c of CHECKS as CheckDefinition[]) if (c.name.toLowerCase().includes(s) || c.id.toLowerCase() === s) out.push({ kind: 'check', id: c.id, title: c.name, subtitle: `${c.id} · PDF p${c.pdfRef.page}`, href: `/issues?checkId=${c.id}` });
  for (const b of v.briefs) if (b.title.toLowerCase().includes(s) || b.targetKeyword.includes(s)) out.push({ kind: 'brief', id: b.id, title: b.title, subtitle: b.targetKeyword, href: `/opportunities/briefs/${b.id}` });
  for (const p of pages) if (p.url.toLowerCase().includes(s) || p.title.toLowerCase().includes(s)) out.push({ kind: 'page', id: p.url, title: p.title, subtitle: `${p.template} · Tier ${p.tier}`, href: `/issues?q=${encodeURIComponent(p.url)}` });
  return out.slice(0, 40);
}
