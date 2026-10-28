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
import type { LighthouseFormFactor, LighthouseRun, LighthouseStatus } from './lighthouse';
import type {
  ShopifyApplyBatchResult, ShopifyApplyPreview, ShopifyDraft, ShopifyResolveResult, ShopifyResourceKind, ShopifyResourceList, ShopifyStatus,
  ShopifyTheme, ShopifyThemeFile, ShopifyThemeProposal,
} from './shopify';
import type {
  AssetChange, CaptureJob, CaptureStatus, CaptureViewport, ChangeDetail, ChangeListQuery, ChangeListResponse, ChangeMonitorStatus, ChangeRunSummary, PageCapture,
  PageComparison, TextDiffView, ThemeDiffResponse, ThemeSnapshotMeta,
} from './changes';

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
  /** When the session ends on its own; absent = it lasts until the user signs out. */
  expiresAt?: string;
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
  /** Issues last seen (created, updated or re-opened) by this crawl run. */
  crawlRunId?: string;
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
  checks: (CheckDefinition & { lastStatus: 'pass' | 'fail' | 'warn' | 'not_run' | 'unavailable' | 'not_built' | 'awaiting_crawl'; openIssues: number; unavailableReason?: string })[];
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
  /** Pages one Smart Crawl may fetch (at most SMART_CRAWL_PAGE_BUDGET = 1,000). */
  smartPageBudget?: number;
  /** Crawl jobs and results live in server memory only. */
  temporaryStorage: boolean;
  schedulerEnabled: boolean;
  respectsRobots: boolean;
  /** Minimum gap between requests to the site (ms). */
  requestDelayMs: number;
  /** Largest response body read per page (bytes). */
  maxBodyBytes: number;
  /** Which crawler runs live crawls and whether its native parts are installed. */
  engine?: {
    /** 'go' = Go crawler + Rust text core; 'node' = built-in Node.js crawler (fallback / re-verification). */
    active: 'go' | 'node';
    goCrawler: { available: boolean; version?: string; problem?: string };
    textCore: { available: boolean; version?: string; problem?: string };
    /** Memory budget for all crawl processes together (MB) and where it came from. */
    memoryBudgetMB?: number;
    memoryBasis?: string;
    note?: string;
  };
}

export interface CrawlDetail {
  run: CrawlRun;
  /** Page rows — included only for small runs (≤ CRAWL_DETAIL_ROW_LIMIT). Large runs: use getCrawlPages (server paging). */
  urls: CrawledUrl[];
  /** Total page rows of the run. */
  urlCount?: number;
  /** true when `urls` was left out because the run is large. */
  urlsPaged?: boolean;
  sitemapDiff?: SitemapDiff;
  verification: VerificationAttempt[];
}

/** Rows included inline in CrawlDetail; larger runs are paged on the server. */
export const CRAWL_DETAIL_ROW_LIMIT = 2000;

export type CrawlPageStatusGroup = '2xx' | '3xx' | '4xx' | '5xx' | 'none' | 'robots' | 'not_fetched';
export type CrawlPageProblem = 'issues' | 'broken' | 'no-title' | 'dup-title' | 'no-meta' | 'dup-meta' | 'h1' | 'alt' | 'noindex' | 'dup-h1';

export interface CrawlPagesQuery {
  offset?: number;
  limit?: number;
  /** Text search in URL and title. */
  q?: string;
  status?: CrawlPageStatusGroup;
  indexable?: 'yes' | 'no';
  problem?: CrawlPageProblem;
  crawlState?: NonNullable<CrawledUrl['crawlState']>;
  source?: string;
  template?: string;
  /** Page audit score band: poor < 50, fair 50–79, good ≥ 80, none = not scored (not an HTML page / not fetched). */
  score?: 'poor' | 'fair' | 'good' | 'none';
  /** Pages failing / warning on one page-audit check (PAGE_AUDIT_TODO id). */
  check?: string;
  sort?: 'url' | 'status' | 'depth' | 'indexable' | 'issues' | 'links' | 'response' | 'title' | 'inlinks' | 'score';
  dir?: 'asc' | 'desc';
}

export interface CrawlPagesResponse {
  total: number;
  offset: number;
  limit: number;
  rows: CrawledUrl[];
  /** Counts over the whole run (not the filtered set): statuses, problems, crawl states, sources, templates. */
  facets: { status: Record<string, number>; problem: Record<string, number>; crawlState: Record<string, number>; source: Record<string, number>; template: Record<string, number>; indexable: Record<string, number>; score?: Record<string, number>; check?: Record<string, number> };
  /** Limits the page audit scores were computed with (the page report uses the same). */
  auditLimits?: import('./pageAudit').PageAuditLimits;
  /** Average page audit score of the whole crawl and per template (not affected by filters). */
  scoreSummary?: import('./pageAudit').PageScoreSummary;
}

/** URL coverage of one crawl: what was found, crawled, failed, excluded and what the sitemap and link graph disagree on. */
export interface CrawlCoverageReport {
  available: boolean;
  note?: string;
  counts: Record<string, number>;
  excludedBy: Record<string, number>;
  foundVia: Record<string, number>;
  /** Lists are capped (see `listLimit`); counts are exact. */
  listLimit: number;
  sitemapNotCrawled: { count: number; urls: { url: string; state: string; reason?: string; status?: number | null }[] };
  linkedNotInSitemap: { count: number; urls: string[] };
  orphanCandidates: { count: number; urls: string[]; evaluated: boolean; note?: string };
  failed: { count: number; urls: { url: string; status: number | null; error?: string }[] };
  redirects: { count: number; urls: { url: string; status: number | null; finalUrl?: string; hops: number }[] };
  /** Several URLs ending on the same final URL, or declaring the same canonical. */
  variantGroups: { count: number; groups: { target: string; urls: string[]; kind: 'redirect' | 'canonical' }[] };
  duplicates: {
    titles: { count: number; groups: { value: string; urls: string[] }[] };
    metaDescriptions: { count: number; groups: { value: string; urls: string[] }[] };
    exactContent: { count: number; groups: string[][] };
    /** Candidates confirmed by exact Jaccard ≥ 0.9 of 4-word shingles; they are evidence for review, not a verdict. */
    nearContent: { count: number; groups: string[][]; threshold: number };
  };
  notProcessed: { count: number; urls: { url: string; state: string }[] };
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
  exportCrawl(id: string, format: 'csv' | 'json'): Promise<{ filename: string; mimeType: string; content: string | Blob }>;
  /** One page of a run's page rows (server-side search, filters, sort and paging). */
  getCrawlPages(id: string, query: CrawlPagesQuery): Promise<CrawlPagesResponse>;
  /** One page of a crawl ("latest" = newest finished crawl) with its SEO audit and recommendations. */
  getCrawlPage(id: string, url: string): Promise<import('./pageAudit').CrawlPageReport>;
  /** URL coverage report of a run. */
  getCrawlCoverage(id: string): Promise<CrawlCoverageReport>;
  /** Whether Lighthouse / rendered checks can run on this server (package, browser, memory). */
  getLighthouseStatus(): Promise<LighthouseStatus>;
  /** Queue Lighthouse audits (mobile, desktop or both) and/or a rendered-vs-raw HTML check of one URL of this website. */
  startLighthouse(input: { url: string; formFactors: LighthouseFormFactor[]; render?: boolean }): Promise<LighthouseRun[]>;
  listLighthouseRuns(): Promise<LighthouseRun[]>;

  // Shopify connection + SEO editor (the access token never reaches the browser)
  getShopifyStatus(): Promise<ShopifyStatus>;
  /** Starts OAuth: returns the Shopify authorize URL to open (state is single-use and expires in 10 minutes). */
  startShopifyOAuth(shop: string): Promise<{ authorizeUrl: string }>;
  disconnectShopify(): Promise<ShopifyStatus>;
  /** Save the Shopify app's Client ID, Client secret (stored encrypted on the server; empty = keep) and app URL. */
  saveShopifyAppCredentials(input: { clientId: string; clientSecret?: string; appUrl?: string }): Promise<ShopifyStatus>;
  removeShopifyAppCredentials(): Promise<ShopifyStatus>;
  /** Incremental monitoring of the selected website: last run and recent changes. */
  getMonitor(): Promise<MonitorStatus>;
  /** Run an incremental check now (targeted requests only). */
  runMonitor(): Promise<MonitorStatus>;
  resolveShopifyUrl(url: string): Promise<ShopifyResolveResult>;
  listShopifyResources(input: { kind: ShopifyResourceKind; q?: string; after?: string }): Promise<ShopifyResourceList>;
  /** Builds a draft for one resource (from a crawled URL, or kind + id) with suggested changes. Nothing is written to Shopify. */
  createShopifyDraft(input: { url?: string; kind?: ShopifyResourceKind; id?: string }): Promise<ShopifyDraft>;
  listShopifyDrafts(): Promise<ShopifyDraft[]>;
  getShopifyDraft(id: string): Promise<ShopifyDraft>;
  /** Manual edits: set proposed values and which fields are included. */
  updateShopifyDraft(id: string, input: { fields: Record<string, { proposed?: string; include?: boolean }> }): Promise<ShopifyDraft>;
  deleteShopifyDraft(id: string): Promise<{ ok: true }>;
  /** Rebuilds a draft from the values in Shopify now (after a conflict). */
  refreshShopifyDraft(id: string): Promise<ShopifyDraft>;
  /** Reads the live values again and lists exactly what will be written, with conflicts and the confirmation phrase. */
  previewShopifyApply(ids: string[]): Promise<ShopifyApplyPreview>;
  /** Download of the original (live) values of the drafts' fields, taken now. */
  downloadShopifyBackup(ids: string[]): Promise<{ filename: string; mimeType: string; content: string | Blob }>;
  /** Writes the included changes after explicit confirmation, verifies each by reading it back, then re-audits the page. */
  applyShopifyDrafts(ids: string[], confirm: string): Promise<ShopifyApplyBatchResult>;
  /** Fetches the storefront page again and checks the applied values are visible. */
  reauditShopifyDraft(id: string): Promise<ShopifyDraft>;
  listShopifyThemes(): Promise<ShopifyTheme[]>;
  getShopifyThemeFile(themeId: string, filename: string): Promise<ShopifyThemeFile>;
  /** H1 rendered by the theme: proposes the change in the theme file that contains it (diff + backup, confirmed separately). */
  proposeShopifyH1Theme(draftId: string, input: { text: string; filename?: string; themeId?: string }): Promise<ShopifyThemeProposal>;
  proposeShopifyThemeChange(input: { themeId: string; filename: string; content: string; reason: string }): Promise<ShopifyThemeProposal>;
  listShopifyThemeProposals(): Promise<ShopifyThemeProposal[]>;
  applyShopifyThemeProposal(id: string, confirm: string): Promise<ShopifyThemeProposal>;
  downloadShopifyThemeBackup(id: string): Promise<{ filename: string; mimeType: string; content: string | Blob }>;
  /** Read-only theme source snapshots through the authorised connection, and their line diffs. */
  createThemeSnapshot(themeId: string): Promise<ThemeSnapshotMeta>;
  listThemeSnapshots(): Promise<ThemeSnapshotMeta[]>;
  diffThemeSnapshots(from: string, to: string, file?: string): Promise<ThemeDiffResponse>;

  // Change Monitor (crawl vs baseline) and page comparisons (screenshots, rendered DOM, CSS / JS)
  getChangeStatus(): Promise<ChangeMonitorStatus>;
  /** `id` = crawl id, snapshot id or "latest". */
  getChangeSummary(id: string): Promise<ChangeRunSummary>;
  listChanges(id: string, query: ChangeListQuery): Promise<ChangeListResponse>;
  getChange(id: string, url: string): Promise<ChangeDetail>;
  /** This URL in the latest crawl that was compared with the baseline (null = never compared). */
  getUrlChange(url: string): Promise<{ change: import('./changes').ChangeRecord | null }>;
  // ---- Image Audit (separate from crawling; started explicitly)
  getImageAuditStatus(): Promise<import('./imageAudit').ImageAuditStatusResponse>;
  startImageAudit(runId: string): Promise<import('./imageAudit').ImageAuditJob>;
  getImageAudit(id: string): Promise<import('./imageAudit').ImageAuditJob>;
  cancelImageAudit(id: string): Promise<import('./imageAudit').ImageAuditJob>;
  resumeImageAudit(id: string): Promise<import('./imageAudit').ImageAuditJob>;
  getImageOccurrences(id: string, url: string, q?: { repeated?: boolean; offset?: number; limit?: number }): Promise<import('./imageAudit').ImageOccurrencesResponse>;
  // Multi-website crawl batches (up to MAX_BATCH_WEBSITES websites; one crawl job per website).
  listCrawlBatches(): Promise<import('./batches').CrawlBatch[]>;
  startCrawlBatch(input: import('./batches').CrawlBatchInput): Promise<import('./batches').CrawlBatch>;
  getCrawlBatch(id: string): Promise<import('./batches').CrawlBatch>;
  cancelCrawlBatch(id: string): Promise<import('./batches').CrawlBatch>;
  cancelCrawlBatchJob(id: string, websiteId: string): Promise<import('./batches').CrawlBatch>;
  listImageAudit(id: string, query: import('./imageAudit').ImageAuditQuery): Promise<import('./imageAudit').ImageAuditListResponse>;
  exportImageAudit(id: string, format: 'csv' | 'json', query: import('./imageAudit').ImageAuditQuery): Promise<{ filename: string; mimeType: string; content: string | Blob }>;
  /** Open issues on a page of URLs (keys: normalised URLs). */
  getChangeIssues(urls: string[]): Promise<Record<string, ChangeDetail['issues']>>;
  exportChanges(id: string, format: 'csv' | 'json', query: ChangeListQuery): Promise<{ filename: string; mimeType: string; content: string | Blob }>;
  getCaptureStatus(): Promise<CaptureStatus>;
  requestCaptures(input: { urls: string[]; viewports: CaptureViewport[] }): Promise<CaptureJob>;
  getCaptureJob(id: string): Promise<CaptureJob>;
  setCaptureWatch(urls: string[]): Promise<string[]>;
  listCapturePages(): Promise<{ url: string; lastAt: string; captures: number }[]>;
  listCaptures(url: string): Promise<PageCapture[]>;
  /** A capture's screenshot or pixel-difference image (PNG). */
  getCaptureImage(id: string, kind: 'image' | 'diff'): Promise<Blob>;
  downloadCaptureHtml(id: string): Promise<{ filename: string; mimeType: string; content: string | Blob }>;
  compareCaptures(input: { url: string; viewport: CaptureViewport; from?: string; to?: string }): Promise<PageComparison>;
  getCaptureAssetDiff(input: { url: string; from: string; to: string; key: string }): Promise<{ key: string; from?: string; to?: string; diff: TextDiffView; note: string; asset?: AssetChange }>;
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
  getSystemHealth(): Promise<{ components: SystemComponentHealth[]; errors: SystemErrorEntry[]; storage: { kind: 'in_memory' | 'browser_memory' | 'postgres'; persistent: boolean; note: string; error?: string } }>;
  search(q: string): Promise<SearchResult[]>;
  getDiagnostics(): Promise<ApiDiagnostics>;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// ------------------------------------------------------------------ incremental monitoring

/** One change found by incremental monitoring (stable id: the same change is never recorded twice). */
export interface MonitorEvent {
  id: string;
  at: string;
  url: string;
  kind: 'new_page' | 'seo_change' | 'error' | 'resolved' | 'removed';
  field?: 'title' | 'metaDescription' | 'canonical' | 'robots' | 'h1' | 'status';
  before?: string;
  after?: string;
  status?: number | null;
  /** Which signal led to the check. */
  source: 'sitemap' | 'shopify' | 'webhook' | 'recheck';
}

export interface MonitorRunSummary {
  at: string;
  ms: number;
  /** Sitemap files answered 304 Not Modified / downloaded. */
  sitemapsNotModified: number;
  sitemapsFetched: number;
  signals: { newInSitemap: number; lastmodChanged: number; removed: number; shopify: number; webhook: number; recheck: number };
  /** Pages requested; of those answered 304 (unchanged, not parsed). */
  checked: number;
  notModified: number;
  /** Targets left for the next run (per-run cap). */
  deferred: number;
  events: number;
  baseline?: boolean;
  notes: string[];
}

export interface MonitorStatus {
  available: boolean;
  reason?: string;
  running: boolean;
  intervalMinutes: number;
  lastRun?: MonitorRunSummary;
  openErrors: number;
  /** Newest first. */
  events: MonitorEvent[];
}
