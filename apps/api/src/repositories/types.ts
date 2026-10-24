import type {
  AiComplianceFlag, AiVisibilityPrompt, AiVisibilityTrendPoint, AuditLogEntry, Backlink, BrandMention, ContentBrief, ContentScore,
  CrawlRun, CrawlSchedule, CrawledUrl, CtrRewrite, CustomRule, CwvTemplateMetric, DataSource, DeliveryAttempt, DisavowCandidate,
  Employee, Exclusion, HealthPoint, IntegrationId, Issue, IssueGroup, KeywordGap, LinkProspect, Notification, OpportunityItem,
  PermissionMatrix, ReferringDomainTrendPoint, SentinelConfig, SitePage, SitemapDiff, StrikingDistanceQuery, SystemErrorEntry,
  Task, TopicCluster, VerificationAttempt, PageTemplate, PageTier,
} from '@sentinel/shared';

/**
 * Repository interfaces. Business logic depends ONLY on these — never on a storage implementation.
 * Phase 2 ships an in-memory implementation (data is lost on restart). Phase 3 (database, only after
 * explicit authorization) will provide persistent implementations of the same interfaces.
 */
export interface Repository<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  /** Simple equality filter on top-level fields (translatable to a WHERE clause later). */
  where(filter: Partial<Record<keyof T, unknown>>): Promise<T[]>;
  insert(item: T): Promise<T>;
  /** Replace an existing item; throws if missing. */
  update(item: T): Promise<T>;
  upsert(item: T): Promise<T>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
  nextId(prefix: string, width?: number): Promise<string>;
}

/** Single-document store (configuration, permission matrix, metric series). */
export interface DocumentStore<T> {
  get(): Promise<T>;
  set(value: T): Promise<T>;
}

export interface Credential { id: string /* lower-cased email */; employeeId: string; hash: string; salt: string; updatedAt: string }
export interface ResetToken { id: string /* sha256 of token */; email: string; expiresAt: string; usedAt?: string }
export interface CrawlUrlSet { id: string /* crawl run id */; urls: CrawledUrl[] }
export interface StoredSitemapDiff extends SitemapDiff { id: string }
export interface IntegrationSettingsDoc { id: IntegrationId; settings: Record<string, string | number | boolean> }
export interface IntegrationTestDoc { id: IntegrationId; at: string; ok: boolean; result: string; lastSuccessfulSyncAt?: string; lastSyncError?: string; rateLimited?: boolean }
export interface PageTextDoc { id: string /* url */; url: string; template: PageTemplate; tier: PageTier; collectionHandle?: string; text: string; publishedAt?: string; source: DataSource }
/** Last observed state of a URL — used for delta detection (yesterday vs today) and robots/script diffs. */
export interface PageSnapshot { id: string /* url */; url: string; runId: string; at: string; status: number | null; noindex: boolean; title?: string; canonical?: string; scripts?: string[]; robotsTxt?: string }
/** Last crawl observation (robots.txt, head scripts, indexable URLs…) used as the next run's baseline. */
export interface CrawlStateDoc { id: string /* 'latest' or run id */; runId: string; at: string; state: import('../services/ports').PreviousCrawlState }
/** expiresAt absent = no automatic expiry (signed in until sign-out). */
export interface SessionDoc { id: string /* session id */; employeeId: string; demo: boolean; createdAt: string; expiresAt?: string; revokedAt?: string }

export interface MetricsDoc {
  source: DataSource;
  siteSize: number;
  healthHistory: HealthPoint[];
  cwv: CwvTemplateMetric[];
  indexation: { date: string; indexed: number; excluded: number; crawledNotIndexed: number; source: DataSource }[];
  visibility: { date: string; clicks: number; impressions: number; avgPosition: number; source: DataSource }[];
  aiTrend: AiVisibilityTrendPoint[];
  aiPrompts: AiVisibilityPrompt[];
  backlinks: Backlink[];
  refTrend: ReferringDomainTrendPoint[];
  competitors: { domain: string; name: string; visibility: number[]; cwv: string; referringDomains: number; contentVelocity: number; source: DataSource }[];
  localHealth: { napConsistency: { directory: string; consistent: boolean; detail: string }[]; gbp: { rating: number; reviews: number; reviewVelocity30d: number; completeness: number } | null };
  striking: StrikingDistanceQuery[];
  ctrRewrites: CtrRewrite[];
  clusters: TopicCluster[];
  contentScores: ContentScore[];
  criticalAlerts: { id: string; type: string; title: string; at: string; issueId?: string }[];
  errors: SystemErrorEntry[];
}

export interface Repositories {
  /** Human-readable description of the storage backend, surfaced on System health. */
  readonly storage: { kind: 'in_memory' | 'postgres'; persistent: boolean; note: string };
  employees: Repository<Employee>;
  credentials: Repository<Credential>;
  resetTokens: Repository<ResetToken>;
  sessions: Repository<SessionDoc>;
  issues: Repository<Issue>;
  groups: Repository<IssueGroup>;
  exclusions: Repository<Exclusion>;
  tasks: Repository<Task>;
  verifications: Repository<VerificationAttempt>;
  crawls: Repository<CrawlRun>;
  crawlUrls: Repository<CrawlUrlSet>;
  /** Multi-website crawl batches (kept with the primary website; each job's data stays in its own website). */
  crawlBatches: Repository<import('@sentinel/shared').CrawlBatchRecord>;
  sitemapDiffs: Repository<StoredSitemapDiff>;
  schedules: Repository<CrawlSchedule>;
  snapshots: Repository<PageSnapshot>;
  crawlStates: Repository<CrawlStateDoc>;
  sitePages: Repository<SitePage>;
  pageTexts: Repository<PageTextDoc>;
  notifications: Repository<Notification>;
  deliveries: Repository<DeliveryAttempt>;
  audit: Repository<AuditLogEntry>;
  rules: Repository<CustomRule>;
  aiFlags: Repository<AiComplianceFlag>;
  briefs: Repository<ContentBrief>;
  keywordGaps: Repository<KeywordGap>;
  opportunities: Repository<OpportunityItem>;
  mentions: Repository<BrandMention>;
  prospects: Repository<LinkProspect>;
  disavow: Repository<DisavowCandidate>;
  integrationSettings: Repository<IntegrationSettingsDoc>;
  integrationTests: Repository<IntegrationTestDoc>;
  config: DocumentStore<SentinelConfig>;
  permissions: DocumentStore<PermissionMatrix>;
  metrics: DocumentStore<MetricsDoc>;
}
