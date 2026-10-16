/**
 * Ports between the core services and the pluggable subsystems:
 *  - Crawler & analysis engine (PDF subsystems A + C)      → apps/api/src/crawler, apps/api/src/analysis
 *  - Data connectors (PDF subsystem B)                       → apps/api/src/connectors
 *  - Delivery adapters + Task Ops + LLM                      → apps/api/src/notifications, apps/api/src/connectors
 *
 * Core services depend only on these interfaces.
 */
import type { CrawlResultStore } from '../results/store';
import type {
  CrawlCoverageCounts, CrawlCoverageReport, CrawlMemory, CrawlRun, CrawlType, Evidence, IntegrationId, IntegrationStatus, Issue, PageTemplate, PageTier, SitemapDiff, CrawledUrl, Task, DeliveryAttempt,
} from '@sentinel/shared';
import type { SeverityContext } from '@sentinel/shared';

// ---------------------------------------------------------------------------------------------- analysis output

/**
 * One aggregated finding produced by the analysis engine for one check on one template
 * (affected URLs aggregated). The issue service turns findings into issues: delta detection vs. the previous
 * run, severity (check × tier via classifySeverity), SLA, grouping, alerts.
 */
export interface Finding {
  checkId: string;
  template?: PageTemplate;
  /** Stable key so the same problem maps to the same issue across runs (default `${checkId}::${template}`). */
  key?: string;
  title: string;
  summary: string;
  businessImpact?: string;
  urls: string[];
  /** Extra severity inputs (metric, templateWide, hasBacklinks, cwvStatus, unintentional, …). highestTier is computed by the issue service. */
  severityContext?: Partial<SeverityContext>;
  evidence: Omit<Evidence, 'id' | 'capturedAt' | 'source'>[];
}

export interface CrawlOutcome {
  run: CrawlRun;
  urls: CrawledUrl[];
  sitemapDiff?: SitemapDiff;
  findings: Finding[];
  /** Checks that were evaluated in this run (absent check ⇒ not evaluated, so its open issues are NOT auto-resolved). */
  evaluatedChecks: string[];
  /** Per-URL page data for page-text-based checks (custom rules / AI compliance). */
  pageTexts?: { url: string; template: PageTemplate; text: string }[];
  /**
   * (optional, added by the crawler) Templates actually covered per evaluated check. An open issue for a
   * template NOT listed here was not re-checked in this run and must not be auto-resolved.
   * Site-level checks (robots.txt, host, TLS, sitemap) list no templates — the check id alone is enough.
   */
  evaluatedTemplates?: Record<string, PageTemplate[]>;
  /** (optional, added by the crawler) What this run observed — store it and pass it back as `CrawlPlan.previous` next run. */
  snapshot?: PreviousCrawlState;
}

/** What the previous run observed — enables day-over-day diffs (robots.txt, new render-blocking scripts, new noindex). */
export interface PreviousCrawlState {
  robotsTxt?: string;
  /** template → script srcs seen in <head> last run */
  headScriptsByTemplate?: Partial<Record<PageTemplate, string[]>>;
  /** URLs that were indexable (200, no noindex) last run */
  indexableUrls?: string[];
  /** URLs that returned 200 last run (to flag NEW 4xx/5xx) */
  okUrls?: string[];
  /** (optional) sitemap entries last run — enables SitemapDiff added/removed/lastmodChanged. */
  sitemapEntries?: { url: string; lastmod?: string }[];
  /** (optional) average third-party JS KB per page by template last run/week — enables PERF-THIRD-PARTY trend (>15%/week). */
  thirdPartyKbByTemplate?: Partial<Record<PageTemplate, number>>;
}

export interface CrawlPlan {
  type: CrawlType;
  baseUrl: string;
  previous?: PreviousCrawlState;
  /** Explicit URL list (smart / reverify); full crawls discover from the homepage + sitemap. */
  urls?: { url: string; reason: CrawledUrl['reason'] }[];
  maxPages: number;
  tierOf: (url: string) => PageTier;
  /** Live crawl from the Crawl Center: link discovery starts here (must be on the website). */
  startUrl?: string;
  maxDepth?: number;
  timeoutMs?: number;
  concurrency?: number;
  /** Gap between requests for this crawl (ms); robots.txt Crawl-delay and 429 / 503 can raise it. */
  requestDelayMs?: number;
  /** Told when the engine moves from fetching pages to analysing them (large crawls analyse for a while). */
  onPhase?: (phase: NonNullable<CrawlRun['phase']>) => void;
  /** Cancels the crawl; the engine stops sending requests and returns the pages fetched so far. */
  signal?: AbortSignal;
  /** URL paths never crawled ("*" matches any run of characters). */
  excludePatterns?: string[];
  /** Keep every page's main text for custom rules (Go engine: written to a results file, applied in chunks). */
  collectTexts?: boolean;
  /** Run id (names the crawl's work directory). */
  runId?: string;
  /** Live coverage counts, memory of every crawl process, phase and diagnostics (Go engine). */
  onLive?: (live: { coverage?: CrawlCoverageCounts; memory?: CrawlMemory; phase?: CrawlRun['phase']; warning?: { code: string; message: string } }) => void;
}

/** What an engine run returns. The Go engine keeps page rows in a file-backed store instead of `urls`. */
export interface EngineRunResult extends Omit<CrawlOutcome, 'run'> {
  stats: Partial<CrawlRun>;
  cancelled?: boolean;
  memoryStopped?: boolean;
  /** Page rows (Go engine): `urls` is then empty and rows are paged from the store. */
  store?: CrawlResultStore;
  coverageReport?: CrawlCoverageReport;
  /** URLs that answered (for auto-resolution) when `urls` is not used. */
  answeredUrls?: Set<string>;
  /** Every page's main text (gzip NDJSON of {url, template, text}) for custom rules, when collectTexts was set. */
  textsFile?: string;
  /** Change Monitor snapshot of this crawl: a gzip NDJSON file (Go engine) or the records themselves (built-in engine). */
  snapshotFile?: string;
  snapshotRecords?: import('../changes/snapshot').SnapRec[];
  /** The crawl failed; `store` holds what was fetched before the failure. */
  failed?: string;
  /** Called once the crawl service has stored what it needs (removes the crawl's temporary work files). */
  cleanup?: () => Promise<void>;
}

/** Runs a crawl + analysis. Implementations must make REAL HTTP requests and report failures honestly. */
export interface CrawlEngine {
  /** Whether the engine may contact the configured site (CRAWLER_ALLOW_LIVE + base URL). */
  readiness(): { ready: boolean; reason?: string; baseUrl?: string };
  run(plan: CrawlPlan, onProgress?: (crawled: number, failed: number, discovered: number, succeeded: number, politeness?: CrawlRun['politeness']) => void): Promise<EngineRunResult>;
}

/** Re-runs one check against specific URLs to verify a fix. */
export interface Reverifier {
  canVerify(checkId: string): { ok: boolean; reason?: string };
  verify(issue: Issue): Promise<{ outcome: 'passed' | 'failed' | 'error'; checkedUrls: number; failingUrls: number; details: string; evidence?: Finding['evidence'] }>;
}

// ---------------------------------------------------------------------------------------------- connectors

export interface ConnectorTestResult {
  ok: boolean;
  /** Human-readable, secret-free result line. */
  result: string;
  rateLimited?: boolean;
  partial?: boolean;
}

export interface Connector {
  id: IntegrationId;
  /** Env var names this connector needs (all required unless listed in optionalVars). */
  envVars: string[];
  optionalVars?: string[];
  isConfigured(): boolean;
  /** Makes a real, minimal API call. Never throws; never includes secrets in the result. */
  test(): Promise<ConnectorTestResult>;
}

export interface IntegrationRegistry {
  status(id: IntegrationId): Promise<IntegrationStatus>;
  list(): Promise<IntegrationStatus[]>;
  test(id: IntegrationId): Promise<IntegrationStatus>;
  updateSettings(id: IntegrationId, settings: Record<string, string | number | boolean>): Promise<IntegrationStatus>;
  /** true only after a successful connection test */
  isConnected(id: IntegrationId): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------- delivery

export interface OutboundMessage {
  subject: string;
  text: string;
  html?: string;
  /** Deep links for one-tap allocation (rendered as links/buttons where the channel supports it). */
  links?: { label: string; url: string }[];
  /**
   * Explicit email recipients. When set, the email channel sends ONLY to these addresses (never to DIGEST_RECIPIENTS),
   * e.g. a password reset goes to the account owner alone. Other channels ignore it.
   */
  to?: string[];
}

export type SendResult = { ok: true; providerMessageId?: string } | { ok: false; error: string; retryable: boolean };

export interface DeliveryChannelAdapter {
  channel: DeliveryAttempt['channel'];
  envVars: string[];
  /** With a message, answers for that message (e.g. explicit recipients); without one, for the default recipients. */
  isConfigured(msg?: OutboundMessage): boolean;
  send(msg: OutboundMessage): Promise<SendResult>;
}

export interface DeliveryService {
  /** Sends via each channel; returns one persisted DeliveryAttempt per channel. Never reports `delivered` without provider confirmation. */
  deliver(kind: DeliveryAttempt['kind'], channels: DeliveryAttempt['channel'][], msg: OutboundMessage, refs?: { issueId?: string; taskId?: string }): Promise<DeliveryAttempt[]>;
  channelStatus(): { channel: DeliveryAttempt['channel']; configured: boolean; envVars: string[] }[];
}

/** DeoDap Task Ops (PDF §12.4). */
export interface TaskOpsAdapter {
  isConfigured(): boolean;
  upsertTask(task: Task, issue?: Issue): Promise<{ ok: true; externalId: string } | { ok: false; error: string; retryable: boolean }>;
  comment(externalId: string, body: string): Promise<SendResult>;
}

/** LLM used for LLM-judged custom rules, the people-first value test and rewrite drafts. */
export interface LlmAdapter {
  isConfigured(): boolean;
  judge(instruction: string, text: string): Promise<{ ok: true; flagged: boolean; reason: string; passage?: string } | { ok: false; error: string }>;
}
