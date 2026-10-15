import type {
  AiComplianceFlag, AiVisibilityPrompt, AiVisibilityTrendPoint, AlertRule, AuditLogEntry, AuditModule, Backlink,
  BrandMention, CheckDefinition, ContentBrief, ContentScore, CrawlOptions, CrawlRun, CrawlSchedule, CrawlType, CrawledUrl,
  CtrRewrite, CustomRule, CwvTemplateMetric, DailyDigest, DeliveryAttempt, DisavowCandidate, DryRunResult, Employee,
  Exclusion, FixCard, HealthPoint, HealthScore, IntegrationId, IntegrationStatus, Issue, IssueGroup, IssueStatus,
  KeywordGap, LinkProspect, MonthlyReport, Notification, OpportunityItem, PageTemplate, Paged, PermissionMatrix,
  ReferringDomainTrendPoint, ReportMeta, Role, SearchResult, SentinelConfig, Severity, SitemapDiff, StrikingDistanceQuery,
  SystemComponentHealth, SystemErrorEntry, TeamId, TopicCluster, VerificationAttempt,
  WeeklyReport, AccountStatus, DataSource, FestivalEntry, IssueAction, Website, WebsiteInput, WebsiteSummary,
} from './types';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamIds: TeamId[];
  isSeoLead?: boolean;
  permissions: string[];
  /** true when this session is a development/demo role preview (prompt §4.3) */
  demo: boolean;
  /** true when the server has the DEMO seed loaded (sample data, temporary in-memory storage). */
  serverDemoData?: boolean;
}

export interface AuthResult {
  token: string;
  user: SessionUser;
  expiresAt: string;
}

export interface IssueFilter {
  q?: string;
  severity?: Severity[];
  module?: AuditModule[];
  status?: IssueStatus[];
  team?: (TeamId | 'unallocated')[];
  allocatorId?: string;
  template?: PageTemplate[];
  tier?: (1 | 2 | 3)[];
  delta?: string[];
  checkId?: string;
  includeSuperseded?: boolean;
  sort?: 'severity' | 'detected' | 'sla' | 'priority' | 'affected';
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface IssueDetail {
  issue: Issue;
  fixCard: FixCard;
  group?: IssueGroup;
  children?: Issue[];
  verification: VerificationAttempt[];
  audit: AuditLogEntry[];
}

export interface DashboardData {
  health: HealthScore;
  healthTrend: HealthPoint[];
  issueCounts: { module: AuditModule; critical: number; medium: number; low: number }[];
  cwv: CwvTemplateMetric[];
  indexation: { date: string; indexed: number; excluded: number; crawledNotIndexed: number; source: DataSource }[];
  crawlTrend: { date: string; crawled: number; failed: number; newIssues: number; resolvedIssues: number; source: DataSource }[];
  visibility: { date: string; clicks: number; impressions: number; avgPosition: number; source: DataSource }[];
  aiMentions: AiVisibilityTrendPoint[];
  todaysChanges: { kind: 'new' | 'resolved' | 'worsening' | 'recurring'; issueId: string; title: string; severity: Severity; module: AuditModule }[];
  criticalAlerts: { id: string; type: string; title: string; at: string; issueId?: string; delivered: DeliveryAttempt[] }[];
  slaWatchlist: { kind: 'issue'; id: string; title: string; severity?: Severity; dueAt: string; breached: boolean }[];
  openLoad: Record<TeamId, number>;
  lastCrawl?: CrawlRun;
  /** false for a website that has never produced findings or a completed real crawl — the UI shows an empty state, never a score. */
  hasAuditData: boolean;
  dataNotes: string[];
}

export interface ModuleData {
  module: AuditModule;
  score?: number;
  checks: (CheckDefinition & { lastStatus: 'pass' | 'fail' | 'warn' | 'not_run' | 'unavailable'; openIssues: number; unavailableReason?: string })[];
  issues: Issue[];
  dataNotes: string[];
}

export interface CrawlerStatus {
  /** Live crawling may start for this website. */
  ready: boolean;
  /** Why not, in plain words (when ready is false). */
  reason?: string;
  /** The website URL crawls are restricted to. */
  siteUrl: string;
  /** Optional server-wide page cap (CRAWLER_MAX_PAGES); null = no cap, every page can be crawled. */
  maxPagesCap: number | null;
  /** Crawl jobs and results live in server memory only. */
  temporaryStorage: boolean;
  schedulerEnabled: boolean;
  respectsRobots: boolean;
  /** Minimum gap between requests to the site (ms). */
  requestDelayMs: number;
  /** Largest response body read per page (bytes). */
  maxBodyBytes: number;
}

export interface CrawlDetail {
  run: CrawlRun;
  urls: CrawledUrl[];
  sitemapDiff?: SitemapDiff;
  verification: VerificationAttempt[];
}

export interface EmployeeInput {
  name: string;
  email: string;
  role: Role;
  teamIds: TeamId[];
  title: string;
  status?: AccountStatus;
  capacityHoursPerWeek?: number;
  isSeoLead?: boolean;
}

/** Integrations that have a data-sync job (PDF §15): GA4 → page value & tiers, GSC → visibility & striking distance, CrUX → CWV. */
export const SYNCABLE_INTEGRATIONS = ['ga4', 'gsc', 'psi_crux'] as const;
export type SyncableIntegrationId = (typeof SYNCABLE_INTEGRATIONS)[number];

/** Outcome of a data sync. `ran: false` = not connected (nothing was requested); `ok: false` = the provider call failed. */
export type IntegrationSyncResult =
  | { id: string; ran: false; reason: string }
  | { id: string; ran: true; ok: true; summary: string; details?: Record<string, unknown> }
  | { id: string; ran: true; ok: false; error: string };

export interface ApiDiagnostics {
  mode: 'mock' | 'http';
  baseUrl?: string;
  endpoints: { method: string; path: string; permission?: string; description: string }[];
  recent: { at: string; method: string; path: string; status: number; ms: number; requestId?: string }[];
  version: string;
}

/**
 * The single API contract. Implemented by:
 *  - apps/web mock adapter (Phase 1, in-browser, DEMO data, not persisted)
 *  - apps/web http client → apps/api (Phase 2, in-memory repositories)
 */
export interface SentinelApi {
  // auth
  login(email: string, password: string): Promise<AuthResult>;
  previewAs(role: Role): Promise<AuthResult>;
  logout(): Promise<void>;
  me(): Promise<SessionUser>;
  /** `sent` = the email provider accepted the message; `emailConfigured` = this server can send email at all. */
  requestPasswordReset(email: string): Promise<{ sent: boolean; emailConfigured: boolean; devResetToken?: string; note: string }>;
  resetPassword(token: string, newPassword: string): Promise<{ ok: true }>;
  updateProfile(input: { name?: string; title?: string; currentPassword?: string; newPassword?: string }): Promise<SessionUser>;

  // dashboard & health
  getDashboard(): Promise<DashboardData>;
  getHealthHistory(days: number): Promise<HealthPoint[]>;
  getHealthScore(): Promise<HealthScore>;

  // checks & modules
  listChecks(): Promise<CheckDefinition[]>;
  getModule(module: AuditModule): Promise<ModuleData>;
  getCwv(): Promise<CwvTemplateMetric[]>;
  getContentScores(): Promise<ContentScore[]>;

  // issues
  listIssues(f: IssueFilter): Promise<Paged<Issue>>;
  getIssue(id: string): Promise<IssueDetail>;
  allocateIssue(id: string, team: TeamId, reason?: string): Promise<IssueDetail>;
  bulkAllocate(groupId: string, team: TeamId, reason?: string): Promise<IssueDetail>;
  acknowledgeIssue(id: string): Promise<IssueDetail>;
  markNotAnIssue(id: string, reason: string, addExclusion: boolean): Promise<IssueDetail>;
  reopenIssue(id: string, reason: string): Promise<IssueDetail>;
  approveProposal(id: string, note: string): Promise<IssueDetail>;
  listIssueGroups(): Promise<(IssueGroup & { parent: Issue })[]>;
  listExclusions(): Promise<Exclusion[]>;
  removeExclusion(id: string): Promise<void>;

  /** Issue workflow: start work / mark fixed. Fixed is never Verified — only verifyIssue (a system re-check) can verify. */
  updateIssueStatus(id: string, action: IssueAction, note?: string): Promise<IssueDetail>;
  /** System re-check of a FIXED issue: passes → VERIFIED; still failing → IN_PROGRESS; no data → stays FIXED (pending). */
  verifyIssue(id: string): Promise<{ detail: IssueDetail; attempt: VerificationAttempt }>;

  // websites (website-scoped calls carry the selected websiteId; these list/manage the workspaces themselves)
  listWebsites(): Promise<WebsiteSummary[]>;
  createWebsite(input: WebsiteInput): Promise<Website>;
  updateWebsite(id: string, input: WebsiteInput): Promise<Website>;

  // crawls
  listCrawls(): Promise<CrawlRun[]>;
  getCrawl(id: string): Promise<CrawlDetail>;
  /** Starts a crawl. `options` (live crawl from the Crawl Center) is required for type 'full' started by a person. */
  startCrawl(type: CrawlType, options?: CrawlOptions): Promise<CrawlRun>;
  cancelCrawl(id: string): Promise<CrawlRun>;
  /** Whether this website can be crawled live right now, and the limits that apply. */
  getCrawlerStatus(): Promise<CrawlerStatus>;
  /** Current results of a run as a downloadable file (in-memory results only). */
  exportCrawl(id: string, format: 'csv' | 'json'): Promise<{ filename: string; mimeType: string; content: string }>;
  listSchedules(): Promise<CrawlSchedule[]>;
  updateSchedule(id: string, input: { cron?: string; enabled?: boolean }): Promise<CrawlSchedule>;
  listVerifications(): Promise<VerificationAttempt[]>;

  // opportunities
  listOpportunities(): Promise<OpportunityItem[]>;
  dismissOpportunity(id: string): Promise<OpportunityItem>;
  listKeywordGaps(): Promise<{ items: KeywordGap[]; available: boolean; note?: string }>;
  updateKeywordGap(id: string, status: KeywordGap['status']): Promise<KeywordGap>;
  listStrikingDistance(): Promise<StrikingDistanceQuery[]>;
  listCtrRewrites(): Promise<CtrRewrite[]>;
  listBriefs(): Promise<ContentBrief[]>;
  getBrief(id: string): Promise<ContentBrief>;
  saveBrief(brief: ContentBrief): Promise<ContentBrief>;
  generateBriefFromGap(gapId: string): Promise<ContentBrief>;
  listClusters(): Promise<TopicCluster[]>;
  getSeasonalPlan(): Promise<{ festivals: (FestivalEntry & { daysUntil: number; inWindow: boolean; collectionsToRefresh: string[] })[]; leadDays: number }>;

  // off-page / competitors
  listBacklinks(): Promise<{ items: Backlink[]; trend: ReferringDomainTrendPoint[]; available: boolean; note?: string }>;
  listLinkProspects(): Promise<LinkProspect[]>;
  listBrandMentions(): Promise<BrandMention[]>;
  updateBrandMention(id: string, status: BrandMention['status']): Promise<BrandMention>;
  listDisavowCandidates(): Promise<DisavowCandidate[]>;
  decideDisavow(id: string, decision: 'approved' | 'rejected'): Promise<DisavowCandidate>;
  getCompetitors(): Promise<{ domain: string; name: string; visibility: number[]; cwv: string; referringDomains: number; contentVelocity: number; source: DataSource }[]>;
  getLocalHealth(): Promise<{ napConsistency: { directory: string; consistent: boolean; detail: string }[]; gbp: { rating: number; reviews: number; reviewVelocity30d: number; completeness: number } | null; available: boolean; note?: string }>;

  // AI visibility, AEO/GEO
  getAiVisibility(): Promise<{ prompts: AiVisibilityPrompt[]; trend: AiVisibilityTrendPoint[]; available: boolean; note?: string }>;

  // AI compliance
  listAiFlags(): Promise<AiComplianceFlag[]>;
  decideQaHold(flagId: string, decision: 'approved' | 'rejected', note: string): Promise<AiComplianceFlag>;
  listRules(): Promise<CustomRule[]>;
  saveRule(rule: Omit<CustomRule, 'id' | 'createdAt' | 'updatedAt' | 'createdById' | 'source'> & { id?: string }): Promise<CustomRule>;
  deleteRule(id: string): Promise<void>;
  dryRunRule(rule: Omit<CustomRule, 'id' | 'createdAt' | 'updatedAt' | 'createdById' | 'source'> & { id?: string }): Promise<DryRunResult>;
  setRuleEnabled(id: string, enabled: boolean): Promise<CustomRule>;

  // reports
  getDailyDigest(date?: string): Promise<DailyDigest>;
  getWeeklyReport(): Promise<WeeklyReport>;
  getMonthlyReport(): Promise<MonthlyReport>;
  listReportHistory(): Promise<ReportMeta[]>;
  exportReport(kind: 'daily' | 'weekly' | 'monthly', format: 'json' | 'csv' | 'md'): Promise<{ filename: string; mime: string; content: string }>;
  sendReport(kind: 'daily' | 'weekly' | 'monthly'): Promise<DeliveryAttempt[]>;

  // notifications
  listNotifications(): Promise<Notification[]>;
  markNotificationRead(id: string | 'all'): Promise<void>;
  listDeliveries(): Promise<DeliveryAttempt[]>;
  updateAlertRules(rules: AlertRule[]): Promise<AlertRule[]>;

  // people
  listEmployees(): Promise<Employee[]>;
  createEmployee(input: EmployeeInput): Promise<Employee>;
  updateEmployee(id: string, input: Partial<EmployeeInput>): Promise<Employee>;
  getPermissionMatrix(): Promise<PermissionMatrix>;
  updatePermissionMatrix(m: PermissionMatrix): Promise<PermissionMatrix>;
  listAllocationHistory(): Promise<(import('./types').AllocationEvent & { issueTitle: string })[]>;

  // config & integrations
  getConfig(): Promise<SentinelConfig>;
  updateConfig(patch: Partial<SentinelConfig>): Promise<SentinelConfig>;
  listIntegrations(): Promise<IntegrationStatus[]>;
  updateIntegration(id: IntegrationId, settings: Record<string, string | number | boolean>): Promise<IntegrationStatus>;
  testIntegration(id: IntegrationId): Promise<IntegrationStatus>;
  /** Pull data now for a connected, syncable integration (ga4, gsc, psi_crux). */
  syncIntegration(id: SyncableIntegrationId): Promise<IntegrationSyncResult>;

  // audit, system, search, diagnostics
  listAuditLog(f: { q?: string; entityType?: string; actorId?: string; page?: number; pageSize?: number }): Promise<Paged<AuditLogEntry>>;
  getSystemHealth(): Promise<{ components: SystemComponentHealth[]; errors: SystemErrorEntry[]; storage: { kind: 'in_memory' | 'browser_memory'; persistent: false; note: string } }>;
  search(q: string): Promise<SearchResult[]>;
  getDiagnostics(): Promise<ApiDiagnostics>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
