/**
 * DeoDap SEO Sentinel — core domain types.
 *
 * These are business-domain / API-contract types only. They are NOT database
 * models: per the master build prompt §3, no persistence schema exists until the
 * database phase is explicitly authorised.
 */

// ---------------------------------------------------------------------------
// Provenance — every record says where its data came from (prompt §1.3, §5.16)
// ---------------------------------------------------------------------------

/**
 * - `sample`      deterministic sample data seeded for development (always labelled sample in UI)
 * - `simulated` produced by a simulated run (e.g. a mock crawl in frontend dev mode)
 * - `live`      produced by a real crawler run or a connected external API
 * - `manual`    entered by a person
 */
export type DataSource = 'sample' | 'simulated' | 'live' | 'manual';

export type ISODate = string;

// ---------------------------------------------------------------------------
// Severity, tiers, modules  (PDF §3, §14, Appendix A)
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'medium' | 'low';
export type IssueClass = Severity | 'opportunity';
export type PageTier = 1 | 2 | 3;

export type PageTemplate =
  | 'home'
  | 'collection'
  | 'product'
  | 'blog_article'
  | 'blog_index'
  | 'page'
  | 'search'
  | 'other';

/** Audit modules (PDF §4–§10). `performance` is PDF §4.4, scored separately per §14. */
export type AuditModule =
  | 'technical'
  | 'performance'
  | 'content'
  | 'onpage'
  | 'offpage'
  | 'aeo'
  | 'geo'
  | 'ai_compliance';

/** Score buckets of the SEO Health Score (PDF §14). */
export type ScoreModule = 'technical' | 'onpage' | 'content_ai' | 'performance' | 'offpage' | 'aeo' | 'geo';

// ---------------------------------------------------------------------------
// Teams, roles, users  (PDF §11.1a + prompt §4.3)
// ---------------------------------------------------------------------------

/** Assignment teams (PDF §11.1a). Distinct from user roles. */
export type TeamId = 'seo' | 'content' | 'development';

/** User roles (prompt §4.3). Distinct from assignment teams. */
export type Role = 'super_admin' | 'admin' | 'seo_specialist' | 'developer';

export type AccountStatus = 'active' | 'invited' | 'suspended';

export interface Team {
  id: TeamId;
  name: string; // "1into2 SEO Team" etc.
  shortName: string;
  leadId?: string;
  description: string;
}

export interface Employee {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamIds: TeamId[];
  title: string;
  status: AccountStatus;
  isSeoLead?: boolean;
  capacityHoursPerWeek: number;
  createdAt: ISODate;
  lastActiveAt?: ISODate;
  source: DataSource;
}

export type Permission =
  | 'dashboard.view'
  | 'issues.view'
  | 'issues.allocate'
  | 'issues.update_status'
  | 'issues.verify'
  | 'websites.manage'
  | 'issues.mark_not_issue'
  | 'issues.manage_exclusions'
  | 'fixcards.approve_proposal'
  | 'tasks.view_all'
  | 'tasks.view_team'
  | 'tasks.create'
  | 'tasks.assign'
  | 'tasks.update_own'
  | 'tasks.review'
  | 'tasks.cancel'
  | 'tasks.verify_trigger'
  | 'crawls.view'
  | 'crawls.run'
  | 'crawls.configure'
  | 'modules.view'
  | 'opportunities.view'
  | 'opportunities.manage'
  | 'reports.view'
  | 'reports.export'
  | 'rules.view'
  | 'rules.manage'
  | 'qa_gate.approve'
  | 'disavow.approve'
  | 'employees.view'
  | 'employees.manage'
  | 'roles.manage'
  | 'integrations.view'
  | 'integrations.manage'
  | 'settings.view'
  | 'settings.manage'
  | 'notifications.configure'
  | 'audit.view'
  | 'system.view'
  | 'diagnostics.view'
  | 'shopify.edit'
  | 'shopify.theme';

export type PermissionMatrix = Record<Role, Permission[]>;

// ---------------------------------------------------------------------------
// Websites (multi-site): every SEO record belongs to exactly one website workspace.
// ---------------------------------------------------------------------------

export type WebsitePlatform = 'shopify' | 'woocommerce' | 'magento' | 'bigcommerce' | 'wordpress' | 'custom';

export interface Website {
  id: string;
  name: string;
  /** Canonical home URL, e.g. https://deodap.in/ */
  url: string;
  /** Normalised host used for duplicate detection (lower-case, no "www."). */
  domain: string;
  platform: WebsitePlatform;
  sitemapUrl?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  createdByName: string;
  /** 'sample' = the bundled sample workspace; 'manual' = added by a person (starts with no data). */
  source: DataSource;
}

export interface WebsiteInput {
  name: string;
  url: string;
  platform: WebsitePlatform;
  sitemapUrl?: string;
}

/** Website plus what is actually known about it — nothing here is inferred for a site that has never been crawled. */
export interface WebsiteSummary extends Website {
  hasAuditData: boolean;
  lastCrawlAt?: ISODate;
  lastCrawlSource?: DataSource;
  healthScore?: number;
  openIssues: { critical: number; medium: number; low: number };
  integrationsConnected: number;
  integrationsTotal: number;
}

/** Issue-level work actions (the issue itself carries the workflow — there is no separate task layer). */
export type IssueAction = 'start' | 'mark_fixed';

// ---------------------------------------------------------------------------
// Site inventory  (PDF §3.1 tiers computed nightly)
// ---------------------------------------------------------------------------

export interface SitePage {
  id: string;
  url: string;
  path: string;
  template: PageTemplate;
  title: string;
  tier: PageTier;
  tierReason: string;
  revenue90d?: number; // INR, from GA4/Shopify when connected
  organicSessions90d?: number;
  impressions28d?: number;
  clicks28d?: number;
  indexable: boolean;
  collectionHandle?: string;
  lastModified?: ISODate;
  source: DataSource;
}

// ---------------------------------------------------------------------------
// Check library  (PDF §4–§10)
// ---------------------------------------------------------------------------

export type CheckCadence = 'daily' | 'weekly' | 'monthly' | 'on_publish' | 'continuous';

export type DataSourceId =
  | 'crawler'
  | 'renderer'
  | 'gsc'
  | 'ga4'
  | 'psi'
  | 'crux'
  | 'backlinks' // Ahrefs or Semrush
  | 'shopify'
  | 'gbp'
  | 'ai_engines'
  | 'llm'
  | 'google_docs_feed';

export interface CheckDefinition {
  id: string; // e.g. TECH-ROBOTS
  module: AuditModule;
  group: string; // e.g. "4.1 Crawlability & Indexability"
  name: string;
  detects: string; // PDF "What it detects" (paraphrased faithfully)
  defaultSeverityText: string; // PDF "Default severity" column verbatim intent
  issueClass: IssueClass | 'metric' | 'report';
  cadence: CheckCadence;
  pdfRef: { page: number; section: string };
  dataSources: DataSourceId[];
  ownerTeam: TeamId; // engine owner suggestion (PDF §11.1a)
  policy?: string; // Module 7: Google policy protected
  /** Whether the backend analysis engine can evaluate this check from crawl data alone. */
  crawlerEvaluable: boolean;
}

// ---------------------------------------------------------------------------
// Issues & Fix Cards  (PDF §3, §11, §12.3)
// ---------------------------------------------------------------------------

/** Issue status per PDF §12.3 (+ governance outcomes). */
export type IssueStatus =
  | 'NEW'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'FIXED'
  | 'VERIFIED'
  | 'CLOSED'
  | 'NOT_AN_ISSUE'
  | 'SUPERSEDED';

/** Day-over-day delta classification (PDF §2.1, prompt §5.2). */
export type DeltaState = 'new' | 'recurring' | 'worsening' | 'unchanged' | 'improving' | 'resolved';

export interface Evidence {
  id: string;
  kind: 'http_response' | 'html_snippet' | 'jsonld' | 'screenshot' | 'field_data' | 'metric' | 'text_passage' | 'diff' | 'note' | 'link';
  label: string;
  url?: string;
  content?: string;
  data?: Record<string, unknown>;
  capturedAt: ISODate;
  source: DataSource;
}

export interface AllocationEvent {
  id: string;
  issueId: string;
  allocatedById: string; // employee id, or 'system'
  allocatedByName: string;
  fromTeam?: TeamId;
  toTeam: TeamId;
  at: ISODate;
  reason?: string;
  automatic: boolean; // true when the 24h unallocated-critical rule fired (PDF §12.4)
  bulkGroupId?: string;
}

export interface SeverityChange {
  at: ISODate;
  from: Severity;
  to: Severity;
  reason: string;
  rule: 'tier_promotion' | 'sla_breach' | 'template_grouping' | 'manual' | 'reclassification';
}

export interface Issue {
  id: string; // ISS-0001
  checkId: string;
  module: AuditModule;
  title: string;
  summary: string;
  severity: Severity;
  severityRationale: string;
  issueClass: IssueClass;
  status: IssueStatus;
  delta: DeltaState;
  template?: PageTemplate;
  affectedUrls: string[];
  affectedCount: number;
  highestTier: PageTier;
  tierBreakdown: Record<PageTier, number>;
  businessImpact: string;
  detectedAt: ISODate;
  firstSeenAt: ISODate;
  lastSeenAt: ISODate;
  slaDueAt: ISODate;
  occurrences: number; // historical recurrence count
  groupId?: string; // parent template-level group
  isTemplateGroup?: boolean;
  childIssueIds?: string[];
  supersededById?: string;
  allocatedTeam?: TeamId;
  recommendedTeam: TeamId;
  allocation: AllocationEvent[];
  taskId?: string;
  severityHistory: SeverityChange[];
  evidence: Evidence[];
  notAnIssue?: { byId: string; byName: string; at: ISODate; reason: string; excluded: boolean };
  acknowledgedBy?: { id: string; name: string; at: ISODate };
  crawlRunId?: string;
  /** Stable identity across crawl runs when an analyzer emits several findings per check × template (e.g. one per blocked AI bot). */
  findingKey?: string;
  source: DataSource;
  /** In issue lists only (never stored): time to fix, where, first step. */
  fix?: IssueFixSummary;
}

export interface FixStep {
  order: number;
  text: string;
  code?: { language: string; snippet: string };
  adminPath?: string; // Shopify Admin navigation
}

export interface DraftVariant {
  label: string;
  title?: string;
  meta?: string;
  body?: string;
  score?: number; // relative CTR score 0–100 (heuristic, labelled as estimate)
  scoreBasis?: string;
}

/** Short fix information shown with an issue in lists (not stored: computed from its Fix Card when listed). */
export interface IssueFixSummary {
  time: import('./fixGuide').FixTime;
  where: import('./fixGuide').FixLocation[];
  firstStep: string;
  playbookId: string;
}

export interface FixCard {
  issueId: string;
  severity: Severity;
  title: string;
  whatsWrong: string;
  whyItMatters: string;
  affectedUrls: string[];
  affectedCount: number;
  tierSummary: string;
  evidence: Evidence[];
  rootCause: { text: string; confidence: number; basis: string } | null;
  steps: FixStep[];
  alternatives: string[];
  shopifyContext?: string;
  ownerSuggestion: TeamId;
  ownerReason: string;
  effortHours: number;
  expectedImpact: 'high' | 'medium' | 'low';
  impactScore: number; // 1–5
  confidence: number; // 0–1
  priorityScore: number;
  slaDueAt: ISODate;
  verifyBy: string;
  acceptanceCriteria: string[];
  recurrence: { occurrences: number; processRecommendation?: string };
  drafts?: DraftVariant[];
  faqDrafts?: { q: string; a: string }[];
  outline?: string[];
  targetEntities?: string[];
  requiresHumanApproval: boolean; // PDF §17 — proposals only
  playbookId: string;
  generatedAt: ISODate;
  completeness: { complete: boolean; missing: string[] };
  /** Where the change is made (Shopify admin, theme code, app, Search Console, SEO Sentinel …), for this website's platform. */
  where?: import('./fixGuide').FixLocation[];
  /** Realistic time to fix, as a range, with how it was estimated. */
  timeEstimate?: import('./fixGuide').FixTime;
  /** Set when the website is not on Shopify: how to read the Shopify-worded steps. */
  platformNote?: string;
}

export interface IssueGroup {
  id: string;
  checkId: string;
  template: PageTemplate;
  issueIds: string[];
  severity: Severity;
  reason: string;
  createdAt: ISODate;
}

export interface Exclusion {
  id: string;
  checkId?: string;
  urlPattern: string;
  reason: string;
  createdById: string;
  createdByName: string;
  createdAt: ISODate;
}

// ---------------------------------------------------------------------------
// Tasks  (prompt §6, PDF §12.4)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'NEW'
  | 'TRIAGED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'READY_FOR_REVIEW'
  | 'FIXED'
  | 'VERIFIED'
  | 'CLOSED'
  | 'CANCELLED';

export type TaskPriority = 'P1' | 'P2' | 'P3';

export type ActivityType =
  | 'created'
  | 'status_changed'
  | 'assigned'
  | 'reallocated'
  | 'progress_updated'
  | 'comment'
  | 'blocker_added'
  | 'blocker_resolved'
  | 'evidence_added'
  | 'review_submitted'
  | 'review_approved'
  | 'review_rejected'
  | 'verification_run'
  | 'reopened'
  | 'sla_escalated'
  | 'effort_logged'
  | 'external_sync';

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  actorId: string;
  actorName: string;
  at: ISODate;
  message: string;
  meta?: Record<string, unknown>;
}

export interface TaskComment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  at: ISODate;
}

export interface Blocker {
  id: string;
  description: string;
  dependsOn?: string; // task id or free text reference
  raisedById: string;
  raisedByName: string;
  raisedAt: ISODate;
  resolvedAt?: ISODate;
  resolution?: string;
}

export interface TaskEvidence {
  id: string;
  phase: 'before' | 'after';
  kind: 'text' | 'url' | 'http_response' | 'screenshot_link' | 'code';
  label: string;
  content: string;
  addedById: string;
  addedByName: string;
  at: ISODate;
}

export type VerificationOutcome = 'passed' | 'failed' | 'pending_data' | 'error';

export interface VerificationAttempt {
  id: string;
  taskId?: string;
  issueId: string;
  at: ISODate;
  triggeredBy: 'system' | string;
  method: 'automated_recrawl' | 'connector_check' | 'manual_attestation';
  outcome: VerificationOutcome;
  checkedUrls: number;
  failingUrls: number;
  details: string;
  source: DataSource;
}

export interface Task {
  id: string; // TSK-0001
  title: string;
  description: string;
  issueId?: string;
  opportunityId?: string;
  module?: AuditModule;
  severity?: Severity;
  priority: TaskPriority;
  priorityScore?: number;
  pageTier?: PageTier;
  affectedUrls: string[];
  status: TaskStatus;
  team: TeamId;
  recommendedTeam?: TeamId;
  assigneeId?: string;
  recommendedOwnerId?: string;
  creatorId: string;
  creatorName: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  dueAt: ISODate;
  progress: number; // 0–100
  estimatedHours?: number;
  actualHours: number;
  acceptanceCriteria: string[];
  comments: TaskComment[];
  blockers: Blocker[];
  evidence: TaskEvidence[];
  verification: VerificationAttempt[];
  activity: ActivityEvent[];
  assignmentHistory: AllocationLikeAssignment[];
  relatedIssueIds: string[];
  reopenCount: number;
  cancelReason?: string;
  externalTaskOpsId?: string; // DeoDap Task Ops reference when synced
  source: DataSource;
}

export interface AllocationLikeAssignment {
  at: ISODate;
  byId: string;
  byName: string;
  fromTeam?: TeamId;
  toTeam: TeamId;
  fromAssigneeId?: string;
  toAssigneeId?: string;
  reason?: string;
}

export type TaskView =
  | 'mine'
  | 'team'
  | 'all'
  | 'overdue'
  | 'sla_watch'
  | 'review'
  | 'verification'
  | 'completed'
  | 'reopened'
  | 'blocked';

export interface SlaState {
  dueAt: ISODate;
  msRemaining: number;
  breached: boolean;
  atRisk: boolean; // inside watch window
  label: string;
}

// ---------------------------------------------------------------------------
// Crawls  (PDF §2.1)
// ---------------------------------------------------------------------------

/** sync: incremental — only new, changed or removed URLs since the previous crawl, merged into its results. */
export type CrawlType = 'full' | 'smart' | 'reverify' | 'sync';
export type CrawlStatus = 'scheduled' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CrawlRun {
  id: string;
  type: CrawlType;
  status: CrawlStatus;
  trigger: 'schedule' | 'manual' | 'webhook' | 'verification';
  startedAt?: ISODate;
  finishedAt?: ISODate;
  scheduledFor?: ISODate;
  urlsPlanned: number;
  urlsCrawled: number;
  urlsFailed: number;
  jsRenderedSample: number;
  newIssues: number;
  resolvedIssues: number;
  recurringIssues: number;
  durationMs?: number;
  error?: string;
  scope: { label: string; count: number }[];
  /** Incremental sync runs: the crawl whose results it updates, and why each URL was fetched. */
  sync?: { baseRunId: string; fetched: number; reasons: Record<string, number>; merged?: number; deferred?: number };
  source: DataSource;
  /** Settings of a live crawl started from the Crawl Center (absent for smart / re-verify / sample runs). */
  options?: CrawlOptions;
  /** Same-site page URLs found so far (start URL, sitemap entries, internal links), within the crawl's scope. */
  urlsDiscovered?: number;
  /** Pages fetched with a final 2xx/3xx response. */
  urlsSucceeded?: number;
  /** Who cancelled the run (status 'cancelled'). */
  cancelledBy?: string;
  /** How the crawl paced itself: current gap between requests, robots.txt Crawl-delay, retries and slow-downs. */
  politeness?: { delayMs: number; crawlDelayMs?: number; retries: number; slowDowns: number };
  /** The address the crawl actually used after following redirects (e.g. http://example.com → https://www.example.com/). */
  resolvedStartUrl?: string;
  /** The address that was entered, when it redirected. */
  resolvedFrom?: string;
  /** What a running crawl is doing now. */
  phase?: CrawlPhase;
  /** Which crawler ran: the Go production crawler, or the built-in Node crawler (re-verification, tests). */
  engine?: 'go' | 'node';
  /** How the crawl ended — distinct from `status` (lifecycle). Only 'completed' means every eligible URL was fetched. */
  outcome?: CrawlOutcomeState;
  outcomeReason?: string;
  /** Live and final URL accounting (see CrawlCoverageCounts). */
  coverage?: CrawlCoverageCounts;
  /** Memory of every process working on the crawl (MB): API (Node.js), Go crawler, Rust text core. */
  memory?: CrawlMemory;
  /** Milliseconds per phase (robots, sitemaps, crawl, checks, text analysis, analysis, saving). */
  timings?: Record<string, number>;
  /** Page rows stored for this run (the Pages table pages through them on the server). */
  urlCount?: number;
  /** Smart crawl: what was prioritised and what was not audited. */
  /** Smart Crawl: page budget of this run, URLs prioritised by evidence, and eligible URLs left pending (not fetched, not audited). */
  smart?: { budget: number; prioritized: number; notAudited: number; basis: string[] };
  /** Last diagnostics from the crawler (rate limiting, stalls, unavailable sitemap, text core problems). */
  warnings?: { code: string; message: string; at: ISODate }[];
  /** Duplicate-content analysis (Rust text core) ran for this crawl. */
  textCore?: { ok: boolean; error?: string };
  /**
   * Set when a server restart interrupted this crawl and it was started again automatically with the same settings
   * (from the beginning: page-level checkpoints are not kept). attempts = restarts so far.
   */
  resume?: { attempts: number; lastAt: ISODate; firstStartedAt?: ISODate; pagesBeforeRestart: number };
  /** Started as part of a multi-website batch (see CrawlBatch). */
  batchId?: string;
  /**
   * Queued and waiting for the server (not stored): place in the server-wide queue (1 = next), how many crawls wait,
   * and why it has not started yet (all slots in use, or not enough memory for another crawl).
   */
  queue?: { position: number; waiting: number; reason?: string };
}

export type CrawlPhase =
  | 'waiting' | 'preflight' | 'robots' | 'sitemaps' | 'crawling' | 'crawling_sitemap_only' | 'samples' | 'checks' | 'finalizing' | 'text_analysis' | 'analysing' | 'saving';

export type CrawlOutcomeState = 'completed' | 'partial' | 'cancelled' | 'failed' | 'resource_stopped';

export interface CrawlCoverageCounts {
  /** Unique same-site URLs found (links, sitemaps, pagination, redirects, the start URL). */
  discovered: number;
  /** Eligible, waiting for a worker. */
  queued: number;
  /** Found only in the sitemap, waiting for link discovery to finish. */
  waiting: number;
  /** Being fetched now. */
  active: number;
  /** Fetched (any outcome). */
  processed: number;
  /** Final answer below 400. */
  succeeded: number;
  /** 4xx / 5xx / no response. */
  failed: number;
  /** Not fetched: disallowed by robots.txt. */
  robots: number;
  /** Not fetched: beyond the depth limit you set. */
  depthLimited: number;
  /** Not fetched: the page limit you set was reached. */
  pageLimited: number;
  /** Out of scope by rule (sort/filter parameters, cart/account paths, non-HTML files, crawl traps, your exclusions). */
  excluded: number;
  excludedBy: Record<string, number>;
  /** Eligible but not fetched because the crawl was cancelled or stopped for resources. */
  notProcessed: number;
  sitemapUrls: number;
  pagesPerMin: number;
  politeness?: {
    delayMs: number; floorMs?: number; crawlDelayMs?: number; slowDowns: number; retries: number; rateLimited?: number; waitedMs?: number; avgLatencyMs?: number;
    /** 503 answers from the site (rate limiting / overload). */
    unavailable503?: number;
    /** 429 + 503 answers in total (a burst counts once in slowDowns). */
    limitedAnswers?: number;
    /** Times the site's Retry-After was honoured as a pause before the next request. */
    retryAfterPauses?: number;
  };
  /** Requests answered so far (pages, samples and checks; every host). */
  requests?: number;
  requestsPerMin?: number;
  /** When the last request was answered — a stall shows here first. */
  lastRequestAt?: string;
  /** Post-crawl checks (link targets, images, scripts, host variants, TLS, samples) per group. */
  checks?: CrawlCheckProgress;
  /** Phase reported by the crawler with this progress. */
  phase?: string;
}

/**
 * Post-crawl checks of one crawl. Per group: total = targets found; done = checked (failed = checked and answered
 * ≥ 400 or not at all); deferred = not checked because of a cap or the time budget — never reported as broken;
 * a group is finished when done + deferred = total. excluded (robots.txt, your exclusions, filter / sort variants
 * beyond the sample) and reused (already answered by the page crawl, no extra request) are outside total.
 */
export interface CrawlCheckGroup {
  total: number; done: number; failed?: number; deferred?: number; excluded?: number; reused?: number;
  /** deferred (and total) were counted up to a bound: show them as "at least". */
  deferredAtLeast?: boolean;
}
export interface CrawlCheckProgress { total: number; done: number; deferred?: number; groups: Record<string, CrawlCheckGroup> }

export interface CrawlMemory {
  nodeRssMB: number;
  nodeHeapMB: number;
  goRssMB?: number;
  textCoreRssMB?: number;
  totalMB: number;
  peakTotalMB: number;
  budgetMB?: number;
}

/** Live-crawl settings chosen in the Crawl Center. Validated server-side (see CRAWL_LIMITS). */
export interface CrawlOptions {
  startUrl: string;
  /** Pages to fetch at most; null = every page the site has (no limit). */
  maxPages: number | null;
  /** Link depth from the start URL (0 = start URL only); null = no depth limit. Sitemap URLs are always included. */
  maxDepth: number | null;
  timeoutMs: number;
  concurrency: number;
  /** Gap between requests for this crawl (ms). Optional: the server default applies when absent. */
  requestDelayMs?: number;
  /** URL paths never crawled, e.g. /blogs/{any}/tagged/{any} written with "*" for {any}; "*" matches any run of characters. */
  excludePatterns?: string[];
}

/** One issue seen on a crawled page in this run (issue tracker record + its Fix Card). */
export interface CrawledUrlIssue {
  id: string;
  checkId: string;
  title: string;
  severity: Severity;
  summary: string;
}

export interface RepeatedImage {
  src: string;
  count: number;
  instances: { position: number; alt: string | null; location?: string; inMain: boolean; loading?: string }[];
}

export interface CrawledUrl {
  url: string;
  status: number | null;
  reason: 'homepage' | 'collection' | 'top_product' | 'changed_48h' | 'reverify' | 'full' | 'sitemap' | 'sync';
  responseMs?: number;
  error?: string;
  changed?: boolean;
  // ---- page details (live crawls; absent on sample / older runs)
  finalUrl?: string;
  finalStatus?: number | null;
  redirects?: number;
  /** Set when this row is the destination of another URL's redirect. */
  redirectedFrom?: string;
  contentType?: string;
  depth?: number;
  bytes?: number;
  skippedByRobots?: boolean;
  title?: string;
  metaDescription?: string;
  h1?: string[];
  h2Count?: number;
  canonical?: string;
  metaRobots?: string;
  xRobotsTag?: string;
  indexable?: boolean;
  indexabilityReason?: string;
  internalLinks?: number;
  /** Internal links on this page whose target answered ≥ 400 or not at all (first 20). */
  brokenLinks?: string[];
  /** Each broken internal link of the page: destination, the status it answered (null = no response) and the error type. */
  brokenLinkDetails?: { url: string; status: number | null; error: string }[];
  /** Images shown more than once on this page: address, how many times, and every instance (position, ALT, where). */
  repeatedImages?: RepeatedImage[];
  images?: number;
  imagesMissingAlt?: number;
  /** Sources of the first images without ALT text (≤ 5, each ≤ 200 characters). */
  imagesMissingAltSrc?: string[];
  /** Links to other websites on the page. */
  externalLinks?: number;
  /** Internal links marked rel="nofollow". */
  nofollowLinks?: number;
  /** Set only when the page has more than one <title> / meta description / canonical tag. */
  titleCount?: number;
  metaDescriptionCount?: number;
  canonicalCount?: number;
  inSitemap?: boolean;
  issues?: CrawledUrlIssue[];
  // ---- coverage (Go crawler)
  /** fetched | robots | excluded | depth_limit | page_limit | not_processed — why a URL has (no) page data. */
  crawlState?: 'fetched' | 'robots' | 'excluded' | 'depth_limit' | 'page_limit' | 'not_processed';
  /** Why an excluded URL was not crawled (sort_filter_search_parameter, crawl_trap, excluded_by_settings …). */
  exclusionReason?: string;
  /** How the URL was found: start, link, sitemap, pagination, redirect, seed. */
  foundVia?: string[];
  /** The first page that linked to it. */
  foundOn?: string;
  template?: string;
  /** Internal links pointing at this URL (seen in this crawl). */
  inlinks?: number;
  headings?: { level: number; text: string }[];
  wordCount?: number;
  uniqueWords?: number;
  issueCount?: number;
  topSeverity?: Severity;
  /** Page audit score 0–100 (Pages API rows; absent = not scored). */
  auditScore?: number;
  /** Ids of the page-audit checks this page fails or should improve (Pages API rows and exports). */
  auditTodo?: string[];
  /** Page problems worked out over the whole crawl (dup-title, dup-meta, broken, …) — set on rows read from the Pages API. */
  flags?: string[];
  /** Set when the page was fetched again after an SEO fix (values and score are from that fetch, not the crawl). */
  recheckedAt?: string;
  /** The crawl's score before the fix (rows with `recheckedAt`). */
  scoreBeforeRecheck?: number | null;
}

export interface SitemapDiff {
  crawlRunId: string;
  added: string[];
  removed: string[];
  lastmodChanged: { url: string; from?: string; to?: string }[];
  inSitemapNotCrawled: string[]; // orphan candidates
  crawledNotInSitemap: string[];
  invalidEntries: { url: string; problem: string }[];
  source: DataSource;
}

export interface CrawlSchedule {
  id: string;
  type: CrawlType;
  cron: string;
  description: string;
  enabled: boolean;
  timezone: 'Asia/Kolkata';
  nextRunAt?: ISODate;
  lastRunId?: string;
}

// ---------------------------------------------------------------------------
// Health score  (PDF §14)
// ---------------------------------------------------------------------------

export interface ModuleScore {
  module: ScoreModule;
  label: string;
  weight: number;
  score: number;
  contribution: number;
  openIssues: { critical: number; medium: number; low: number };
  penalty: number;
}

export interface HealthScore {
  at: ISODate;
  score: number;
  modules: ModuleScore[];
  siteSize: number;
  source: DataSource;
}

export interface HealthPoint {
  date: string; // YYYY-MM-DD
  score: number;
  modules: Partial<Record<ScoreModule, number>>;
  source: DataSource;
}

// ---------------------------------------------------------------------------
// Integrations  (PDF §15, prompt §5.16)
// ---------------------------------------------------------------------------

export type IntegrationId =
  | 'crawler'
  | 'gsc'
  | 'ga4'
  | 'psi_crux'
  | 'backlinks'
  | 'shopify'
  | 'gbp'
  | 'openai'
  | 'gemini'
  | 'perplexity'
  | 'email'
  | 'whatsapp'
  | 'slack'
  | 'task_ops';

export type IntegrationState =
  | 'not_configured'
  | 'credentials_missing'
  | 'connection_failed'
  | 'connected'
  | 'partial'
  | 'rate_limited'
  | 'sync_failed';

export interface IntegrationStatus {
  id: IntegrationId;
  name: string;
  category: 'crawler' | 'search' | 'analytics' | 'performance' | 'backlinks' | 'commerce' | 'local' | 'ai' | 'notification' | 'tasks';
  usedFor: string;
  accessNeeded: string; // PDF §15 "Access needed"
  costNote?: string;
  state: IntegrationState;
  stateDetail: string;
  envVars: string[];
  /** Env vars that are not required (e.g. CRAWLER_USER_AGENT has a built-in default). */
  optionalVars?: string[];
  configuredVars: string[]; // names only — never values
  /** GSC / GA4: the property used for requests, where it comes from (saved on this screen, or the server env). */
  property?: { key: string; envVar: string; value?: string; source: 'saved' | 'env' | 'none' };
  lastTestAt?: ISODate;
  lastTestResult?: string;
  lastSuccessfulSyncAt?: ISODate;
  lastSyncError?: string;
  dependentFeatures: string[];
  settings: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Notifications, alerts, deliveries  (PDF §12.1, §12.2)
// ---------------------------------------------------------------------------

export type Channel = 'in_app' | 'email' | 'whatsapp' | 'slack';

export type AlertType =
  | 'sitewide_5xx'
  | 'robots_change'
  | 'tier1_noindex'
  | 'ssl_failure'
  | 'index_collapse'
  | 'toxic_link_spike'
  | 'cwv_poor_template';

export interface Notification {
  id: string;
  recipientId: string;
  type: 'alert' | 'assignment' | 'sla' | 'review' | 'verification' | 'mention' | 'digest' | 'escalation' | 'system';
  title: string;
  body: string;
  link?: string;
  createdAt: ISODate;
  readAt?: ISODate;
  severity?: Severity;
}

export interface DeliveryAttempt {
  id: string;
  channel: Exclude<Channel, 'in_app'>;
  kind: 'realtime_alert' | 'daily_digest' | 'weekly_report' | 'monthly_report' | 'allocation' | 'escalation' | 'task_sync';
  subject: string;
  at: ISODate;
  outcome: 'delivered' | 'failed' | 'skipped_not_configured' | 'retrying';
  retryable: boolean;
  error?: string;
  providerMessageId?: string;
  issueId?: string;
  taskId?: string;
}

export interface AlertRule {
  type: AlertType;
  label: string;
  enabled: boolean;
  channels: Channel[];
  recipients: TeamId[]; // dev + SEO channel by default (PDF §12.2)
}

// ---------------------------------------------------------------------------
// Config  (PDF §17 threshold configuration file)
// ---------------------------------------------------------------------------

export interface SentinelConfig {
  /** platform: the website's platform (Manage websites); Fix Card locations follow it. Absent = Shopify. */
  site: { baseUrl: string; canonicalHost: string; brand: string; timezone: 'Asia/Kolkata'; platform?: WebsitePlatform };
  tiers: {
    tier1TopCollections: number; // 20
    tier1TopProducts: number; // 200
    tier1Basis: 'revenue_or_sessions';
    tier1LookbackDays: number; // 90
  };
  sla: { criticalSameDay: boolean; mediumDays: number; lowDays: number; watchWindowHours: number };
  escalation: {
    mediumBreachEscalates: boolean;
    tier1PromotionEscalates: boolean;
    templateGroupThreshold: number; // 3
    unallocatedCriticalHours: number; // 24
  };
  scoring: {
    weights: Record<ScoreModule, number>;
    severityWeights: Record<Severity, number>;
    tierMultipliers: Record<PageTier, number>;
    normalizationK: number;
  };
  priority: { impactScale: [number, number]; minEffortHours: number };
  thresholds: Record<string, number>;
  crawl: {
    smartTopProducts: number; // 500
    changedWithinHours: number; // 48
    fullCrawlCron: string;
    smartCrawlCron: string;
    jsRenderSampleSize: number;
    userAgent: string;
    maxConcurrency: number;
    requestTimeoutMs: number;
    respectRobots: boolean;
    renderViewportWidth: number; // 390
  };
  reporting: { dailyDigestTime: string; weeklyDay: 'monday'; monthlyDay: number; channels: Channel[] };
  automation: { autoRedirectDeletedProducts: boolean; autoApplySchemaUpdates: boolean };
  alerts: AlertRule[];
  competitors: { name: string; domain: string }[];
  moneyKeywords: string[];
  intentionalNoindex: string[];
  aiCrawlerPolicy: Record<string, 'allow' | 'block_intentional'>;
  festivals: FestivalEntry[];
  updatedAt: ISODate;
  updatedBy: string;
}

export interface FestivalEntry {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD (approximate dates must be confirmed by the team)
  dateConfirmed: boolean;
  categories: string[];
  kind: 'festival' | 'season';
}

// ---------------------------------------------------------------------------
// Opportunities  (PDF §6.3, §7, §8, §13)
// ---------------------------------------------------------------------------

export type SearchIntent = 'informational' | 'commercial' | 'transactional' | 'navigational';

export interface KeywordGap {
  id: string;
  keyword: string;
  volume?: number;
  difficulty?: number;
  intent: SearchIntent;
  competitorsRanking: { domain: string; position: number }[];
  deodapPosition?: number;
  relevantCategory?: string;
  quickWin: boolean;
  status: 'new' | 'approved' | 'rejected' | 'brief_created' | 'task_created';
  source: DataSource;
}

export interface StrikingDistanceQuery {
  id: string;
  query: string;
  url: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  source: DataSource;
}

export interface CtrRewrite {
  id: string;
  query: string;
  url: string;
  position: number;
  ctr: number;
  benchmarkCtr: number;
  currentTitle: string;
  currentMeta: string;
  variants: DraftVariant[];
  source: DataSource;
}

export interface ContentBrief {
  id: string;
  title: string;
  targetKeyword: string;
  cluster: string;
  intent: SearchIntent;
  suggestedUrl: string;
  pageType: 'collection' | 'blog' | 'buying_guide' | 'landing_page' | 'faq';
  outline: string[];
  entities: string[];
  faqs: { q: string; a?: string }[];
  internalLinks: { from: string; anchor: string }[];
  origin: 'keyword_gap' | 'paa_gap' | 'seasonal' | 'citation_gap' | 'manual' | 'intent_mismatch';
  originRef?: string;
  status: 'draft' | 'approved' | 'in_production' | 'published';
  updatedAt: ISODate;
  taskId?: string;
  source: DataSource;
}

export interface TopicCluster {
  id: string;
  name: string;
  pillarUrl?: string;
  pillarStatus: 'live' | 'missing' | 'thin';
  pages: { url: string; linksToPillar: boolean; linkedFromPillar: boolean }[];
  completeness: number; // %
  interlinkIntegrity: number; // %
  trafficTrend: { week: string; clicks: number }[];
  missingSubtopics: string[];
  source: DataSource;
}

export interface OpportunityItem {
  id: string;
  kind: 'striking_distance' | 'ctr_rewrite' | 'content_brief' | 'keyword_gap' | 'link_prospect' | 'brand_mention' | 'paa_gap' | 'snippet_target' | 'seasonal' | 'digital_pr' | 'citation_gap';
  title: string;
  detail: string;
  url?: string;
  value: number; // ranking value used for ordering
  status: 'open' | 'task_created' | 'dismissed';
  taskId?: string;
  createdAt: ISODate;
  source: DataSource;
}

// ---------------------------------------------------------------------------
// Off-page, AEO/GEO, AI visibility, CWV
// ---------------------------------------------------------------------------

export interface Backlink {
  id: string;
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string;
  anchor: string;
  domainRating: number;
  firstSeen: ISODate;
  lostAt?: ISODate;
  status: 'new' | 'live' | 'lost';
  toxicScore?: number;
  toxicSignals?: string[];
  anchorType: 'branded' | 'exact_match' | 'partial' | 'url' | 'generic';
  source: DataSource;
}

export interface ReferringDomainTrendPoint {
  date: string;
  values: Record<string, number>; // domain -> referring domains
  source: DataSource;
}

export interface LinkProspect {
  id: string;
  domain: string;
  domainRating: number;
  relevance: number; // 0–1
  linksToCompetitors: string[];
  pitchAngle: string;
  priority: number;
  status: 'new' | 'outreach' | 'won' | 'rejected';
  source: DataSource;
}

export interface BrandMention {
  id: string;
  url: string;
  domain: string;
  snippet: string;
  foundAt: ISODate;
  linked: boolean;
  status: 'new' | 'outreach' | 'reclaimed' | 'ignored';
  source: DataSource;
}

export interface DisavowCandidate {
  id: string;
  domain: string;
  toxicScore: number;
  signals: string[];
  firstSeen: ISODate;
  approval: 'pending' | 'approved' | 'rejected';
  decidedById?: string;
  decidedAt?: ISODate;
  source: DataSource;
}

export interface CwvTemplateMetric {
  template: PageTemplate | 'origin';
  device: 'mobile' | 'desktop';
  lcpMs: number;
  inpMs: number;
  cls: number;
  status: 'good' | 'needs_improvement' | 'poor';
  psiScore?: number;
  psi7dAvg?: number;
  thirdPartyKb?: number;
  thirdPartyKbWeekAgo?: number;
  source: DataSource;
}

export interface AiVisibilityPrompt {
  id: string;
  prompt: string;
  category: string;
  results: { engine: 'chatgpt' | 'gemini' | 'perplexity' | 'copilot' | 'google_aio'; mentioned: boolean; cited: boolean; competitorsMentioned: string[]; sampledAt: ISODate }[];
  source: DataSource;
}

export interface AiVisibilityTrendPoint {
  week: string;
  mentionShare: Record<string, number>; // brand/competitor -> share %
  source: DataSource;
}

// ---------------------------------------------------------------------------
// AI-content compliance + custom rules  (PDF §10)
// ---------------------------------------------------------------------------

export type RuleMethod = 'regex' | 'phrase_list' | 'threshold' | 'llm_judged';

export interface CustomRule {
  id: string;
  name: string;
  description: string;
  method: RuleMethod;
  pattern?: string; // regex
  flags?: string;
  phrases?: string[];
  phraseMode?: 'banned' | 'required';
  threshold?: { metric: 'word_count' | 'keyword_density' | 'duplication_pct' | 'ai_likelihood'; operator: '<' | '>' | '<=' | '>='; value: number; keyword?: string };
  llmInstruction?: string;
  scope: {
    templates: PageTemplate[];
    collections: string[];
    tiers: PageTier[];
    newlyPublishedOnly: boolean;
    fullSite: boolean;
  };
  severity: Severity;
  defaultTeam: TeamId;
  action: 'flag' | 'flag_and_rewrite' | 'block_qa_gate';
  schedule: 'daily' | 'on_publish' | 'weekly';
  enabled: boolean;
  lastDryRun?: DryRunResult;
  createdById: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  source: DataSource;
}

export interface DryRunResult {
  ruleId?: string;
  ranAt: ISODate;
  pagesScanned: number;
  pagesFlagged: number;
  windowDays: number;
  samples: { url: string; passage: string; reason: string }[];
  evaluated: boolean; // false when e.g. LLM provider not configured
  note?: string;
  source: DataSource;
}

export interface AiComplianceFlag {
  id: string;
  issueId?: string;
  checkId: string; // AIC-01..12 or custom rule id
  ruleName: string;
  url: string;
  template: PageTemplate;
  passage: string;
  explanation: string;
  severity: Severity;
  rewrite?: string;
  qaHold: boolean;
  qaHoldStatus?: 'held' | 'approved' | 'rejected';
  qaDecision?: { byId: string; byName: string; at: ISODate; note: string };
  detectedAt: ISODate;
  source: DataSource;
}

export interface ContentScore {
  url: string;
  template: PageTemplate;
  tier: PageTier;
  score: number;
  components: { uniqueness: number; depth: number; readability: number; media: number; freshness: number };
  wordCount: number;
  serpAvgWords?: number;
  lastUpdated?: ISODate;
  explanation: string;
  source: DataSource;
}

// ---------------------------------------------------------------------------
// Reports  (PDF §12.1, §12.5)
// ---------------------------------------------------------------------------

export interface ReportMeta {
  id: string;
  kind: 'daily' | 'weekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
  generatedAt: ISODate;
  sources: { name: string; state: 'live' | 'sample' | 'missing' }[];
  dataNotes: string[];
  deliveries: DeliveryAttempt[];
}

export interface DailyDigest {
  meta: ReportMeta;
  health: { score: number; trend7d: HealthPoint[] };
  newCriticals: { issueId: string; title: string; summary: string; recommendedTeam: TeamId; allocatedTeam?: TeamId }[];
  newMediumsByModule: { module: AuditModule; items: { issueId: string; title: string; recommendedTeam: TeamId; allocatedTeam?: TeamId }[] }[];
  aiCompliance: { flagId: string; url: string; rule: string; passage: string; rewrite?: string; issueId?: string }[];
  verifiedFixed: { issueId: string; title: string; verifiedAt: ISODate }[];
  opportunities: { strikingDistance: StrikingDistanceQuery[]; ctrRewrites: CtrRewrite[]; brief?: ContentBrief };
  allocation: {
    yesterday: AllocationEvent[];
    unallocatedPast24h: { issueId: string; title: string; severity: Severity; hours: number; escalatedToSeoLead: boolean }[];
    openLoad: Record<TeamId, number>;
  };
  watchlist: { kind: 'issue' | 'task'; id: string; title: string; dueAt: ISODate; hoursLeft: number }[];
}

export interface WeeklyReport {
  meta: ReportMeta;
  offPage: { newLinks: number; lostLinks: number; toxicDomains: number; referringDomainsDelta: number; prospects: LinkProspect[]; digitalPr: OpportunityItem[] };
  aiVisibility: { promptsRun: number; mentionRate: number; byEngine: Record<string, number>; competitorShare: Record<string, number> };
  competitorMovement: { domain: string; visibilityDelta: number; backlinkDelta: number; cwvStatus: string; contentVelocity: number }[];
  slaCompliance: { severity: Severity; total: number; withinSla: number; pct: number }[];
  topPriorities: { issueId: string; title: string; priorityScore: number; team: TeamId }[];
}

export interface MonthlyReport {
  meta: ReportMeta;
  organic: { clicks: number | null; clicksPrevMonth: number | null; clicksYoY: number | null; revenue: number | null; revenuePrevMonth: number | null; revenueYoY: number | null };
  healthTrend: HealthPoint[];
  issuesOpened: number;
  issuesClosed: number;
  moneyKeywords: { keyword: string; position: number | null; prevPosition: number | null }[];
  aiMentionShare: Record<string, number>;
  strategicActions: string[];
  evidenceBasis: string; // "generated from audit log entries …"
}

// ---------------------------------------------------------------------------
// Audit log, system health
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  id: string;
  at: ISODate;
  actorId: string;
  actorName: string;
  action: string; // e.g. issue.allocate
  entityType: 'issue' | 'task' | 'crawl' | 'config' | 'employee' | 'rule' | 'integration' | 'report' | 'alert' | 'verification' | 'auth' | 'disavow' | 'qa_gate' | 'exclusion' | 'brief' | 'opportunity' | 'system' | 'shopify';
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

export interface SystemComponentHealth {
  id: string;
  name: string;
  subsystem: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'platform';
  status: 'operational' | 'degraded' | 'down' | 'not_configured';
  detail: string;
  lastCheckedAt: ISODate;
}

export interface SystemErrorEntry {
  id: string;
  at: ISODate;
  level: 'error' | 'warn';
  component: string;
  message: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  kind: 'issue' | 'page' | 'employee' | 'check' | 'brief' | 'screen';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
