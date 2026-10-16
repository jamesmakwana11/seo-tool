/**
 * Change Monitor: what changed on the website between two crawls (shared by the API and the web app).
 *
 * A crawl is compared with the BASELINE: the last valid crawl. Only a completed full crawl replaces the baseline; a
 * completed smart crawl refreshes the baseline entries of the URLs it fetched; partial, cancelled and resource-stopped
 * crawls are compared but never change the baseline; failed crawls and re-verifications are ignored.
 */

export type ChangeField =
  | 'status' | 'redirect' | 'title' | 'meta' | 'h1' | 'h2' | 'h3' | 'canonical' | 'indexability'
  | 'content' | 'links' | 'images' | 'structured_data' | 'assets';

export const CHANGE_FIELDS: ChangeField[] = ['status', 'redirect', 'title', 'meta', 'h1', 'h2', 'h3', 'canonical', 'indexability', 'content', 'links', 'images', 'structured_data', 'assets'];

export const CHANGE_FIELD_LABELS: Record<ChangeField, string> = {
  status: 'HTTP status', redirect: 'Redirect', title: 'Title', meta: 'Meta description', h1: 'H1', h2: 'H2', h3: 'H3',
  canonical: 'Canonical', indexability: 'Indexability', content: 'Content', links: 'Internal links', images: 'Images & alt text',
  structured_data: 'Structured data', assets: 'CSS / JS assets',
};

/**
 * new: not in the baseline · removed: answered 404/410 (confirmed) or missing from a complete full crawl (suspected) ·
 * failed: did not answer usefully this time (5xx, 429, timeout) — NOT treated as removed · changed / unchanged ·
 * unchecked: in the baseline but not fetched this time (partial / smart crawl, excluded, limit reached).
 */
export type ChangeKind = 'new' | 'removed' | 'failed' | 'changed' | 'unchanged' | 'unchecked';
export const CHANGE_KINDS: ChangeKind[] = ['changed', 'new', 'removed', 'failed', 'unchecked', 'unchanged'];

export type ChangeConfidence = 'confirmed' | 'suspected';

export interface ChangeFieldDiff {
  field: ChangeField;
  old?: string;
  new?: string;
  added?: string[];
  removed?: string[];
  note?: string;
  confidence: ChangeConfidence;
}

export interface ChangeRecord {
  url: string;
  kind: ChangeKind;
  confidence: ChangeConfidence;
  /** Why the URL was classified this way (evidence in words). */
  evidence: string;
  template?: string;
  /** When this crawl observed the URL (crawl start / finish time) and when the baseline did. */
  observedAt: string;
  baselineObservedAt?: string;
  baselineRunId?: string;
  status?: string;
  baselineStatus?: string;
  fields: ChangeFieldDiff[];
}

export interface ChangeCounts {
  new: number;
  removed: number;
  failed: number;
  changed: number;
  unchanged: number;
  unchecked: number;
  suspected: number;
  byField: Partial<Record<ChangeField, number>>;
}

export type BaselineEffect = 'created' | 'replaced' | 'merged' | 'kept';

export interface ChangeRunSummary {
  runId: string;
  /** Unique key of this crawl's snapshot on disk (run ids restart with the server; this does not). */
  snapshotId: string;
  crawlType: string;
  outcome: string;
  observedAt: string;
  finishedAt?: string;
  urls: number;
  /** null when there was no baseline to compare with (first valid crawl). */
  baseline: { snapshotId: string; runId: string; observedAt: string; crawlType: string; urls: number } | null;
  counts?: ChangeCounts;
  /** What this crawl did to the baseline, and why. */
  baselineEffect: BaselineEffect;
  baselineNote: string;
  /** Notes that limit the comparison (partial crawl, truncated pages, …). */
  notes: string[];
  comparedAt?: string;
  compareMs?: number;
}

export interface ChangeMonitorStatus {
  enabled: boolean;
  /** Where snapshots are kept, and whether that place survives a restart. */
  directory: string;
  persistentHint: string;
  retention: { keepRuns: number; maxAgeDays: number };
  baseline: { snapshotId: string; runId: string; observedAt: string; crawlType: string; urls: number; mergedFrom: string[] } | null;
  runs: ChangeRunSummary[];
  diskBytes: number;
}

export interface ChangeListQuery {
  kind?: ChangeKind | 'all';
  field?: ChangeField;
  confidence?: ChangeConfidence;
  q?: string;
  template?: string;
  page?: number;
  pageSize?: number;
}

export interface ChangeListResponse {
  runId: string;
  snapshotId: string;
  total: number;
  page: number;
  pageSize: number;
  items: ChangeRecord[];
  counts?: ChangeCounts;
}

export interface ChangeDetail extends ChangeRecord {
  /** Open issues on this URL (from the crawl's results), so a change can be read next to the SEO problems it caused. */
  issues: { id: string; checkId: string; title: string; severity: string }[];
}

// ------------------------------------------------------------------------------------------------ captures & comparisons

export type CaptureViewport = 'desktop' | 'mobile';
export const CAPTURE_VIEWPORTS: CaptureViewport[] = ['desktop', 'mobile'];

export interface CaptureAsset { url: string; type: 'css' | 'js'; hash: string; bytes: number }

/** One screenshot + rendered HTML of a page, taken by a real browser at `at`. */
export interface PageCapture {
  id: string;
  url: string;
  viewport: CaptureViewport;
  at: string;
  ok: boolean;
  error?: string;
  status?: number | null;
  finalUrl?: string;
  width?: number;
  /** Captured height (px) and the page's full height: pages taller than the limit are cut. */
  height?: number;
  docHeight?: number;
  cut?: boolean;
  ms?: number;
  fields?: { title?: string; meta?: string; h1?: string[]; canonical?: string; robots?: string };
  assets?: CaptureAsset[];
  /** Pixel comparison with the previous capture of the same page and viewport, made when this one was taken. */
  diff?: { previousId: string; previousAt: string; ratio: number; changedPixels: number; sizeChanged: boolean } | null;
  trigger: 'manual' | 'after_crawl';
  runId?: string;
  hasImage: boolean;
  hasHtml: boolean;
  hasDiffImage: boolean;
}

export interface CaptureJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  trigger: 'manual' | 'after_crawl';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  requestedBy: string;
  items: { url: string; viewport: CaptureViewport; state: 'queued' | 'done' | 'failed'; captureId?: string; error?: string }[];
  error?: string;
  memoryNote?: string;
  /** The crawl whose results chose these pages (after-crawl captures). */
  runId?: string;
}

export interface CaptureStatus {
  available: boolean;
  problems: string[];
  chromePath?: string;
  /** MB a capture job needs free inside the memory budget, and what is free now (undefined = no budget known). */
  memoryNeededMB: number;
  memoryFreeMB?: number;
  afterCrawl: { enabled: boolean; changedPages: number; viewports: CaptureViewport[] };
  watch: string[];
  jobs: CaptureJob[];
  limits: { keepPerPage: number; maxPages: number; maxHeight: number; concurrency: number };
}

export interface DiffLineView { op: ' ' | '+' | '-' | '…'; text: string; a?: number; b?: number }
export interface TextDiffView {
  lines: DiffLineView[];
  added: number;
  removed: number;
  truncated: boolean;
  coarse: boolean;
}

export interface AssetChange {
  /** URL without the version query, so new versions of the same file pair up. */
  key: string;
  type: 'css' | 'js';
  state: 'changed' | 'added' | 'removed' | 'same';
  from?: CaptureAsset;
  to?: CaptureAsset;
}

export interface PageComparison {
  url: string;
  viewport: CaptureViewport;
  from: PageCapture | null;
  to: PageCapture | null;
  /** Why a view is unavailable (never filled with made-up data). */
  visual: { available: boolean; reason?: string; ratio?: number; sizeChanged?: boolean; diffOf?: [string, string] };
  dom: { available: boolean; reason?: string; diff?: TextDiffView; note: string };
  seoFields: { field: string; from?: string; to?: string; changed: boolean }[];
  assets: { available: boolean; reason?: string; items: AssetChange[] };
  /** The Change Monitor record of this URL in the latest compared crawl, when there is one. */
  change?: ChangeRecord | null;
}

export interface ThemeSnapshotMeta {
  id: string;
  themeId: string;
  themeName: string;
  themeRole: string;
  at: string;
  takenBy: string;
  files: number;
  skipped: number;
  bytes: number;
}

export interface ThemeDiffFile {
  filename: string;
  state: 'added' | 'removed' | 'changed' | 'same';
  diff?: TextDiffView;
}

export interface ThemeDiffResponse {
  from: ThemeSnapshotMeta;
  to: ThemeSnapshotMeta;
  files: ThemeDiffFile[];
  note: string;
}
