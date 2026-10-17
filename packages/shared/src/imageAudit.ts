/**
 * Image Audit: a separate job a user starts for one finished crawl. The crawl itself never requests images; it records
 * which images each page shows (from the HTML). The audit deduplicates them, checks each unique image once and reports
 * what it found — an image is never "ok" without an actual answer.
 */

/**
 * ok = answered 2xx with image content · broken = 4xx or not an image · failed = 5xx / timeout / network error ·
 * unverified = not checked (robots.txt, rate limited, third-party host) · deferred = not checked in this job (time budget
 * or cancelled) · pending = waiting to be checked while the job runs.
 */
export type ImageCheckState = 'ok' | 'broken' | 'failed' | 'unverified' | 'deferred' | 'pending';
export const IMAGE_STATES: ImageCheckState[] = ['ok', 'broken', 'failed', 'unverified', 'deferred', 'pending'];
export const IMAGE_STATE_LABELS: Record<ImageCheckState, string> = {
  ok: 'Available', broken: 'Broken', failed: 'Failed (inaccessible)', unverified: 'Unverified', deferred: 'Deferred', pending: 'Pending',
};

export type ImageIssueId = 'broken' | 'failed' | 'unverified' | 'alt-missing' | 'alt-empty' | 'no-dimensions' | 'not-lazy' | 'heavy' | 'legacy-format' | 'oversized' | 'redirect' | 'duplicate' | 'repeated';
export const IMAGE_ISSUE_LABELS: Record<ImageIssueId, string> = {
  broken: 'Broken image', failed: 'Could not be loaded', unverified: 'Not verified',
  'alt-missing': 'ALT text missing', 'alt-empty': 'Empty ALT (alt="")', 'no-dimensions': 'No width / height in the HTML', 'not-lazy': 'Below the fold, not lazy-loaded',
  heavy: 'Heavy file', 'legacy-format': 'Legacy format (JPEG / PNG / GIF)', oversized: 'Much larger than displayed', redirect: 'Redirects', duplicate: 'Same file under several URLs', repeated: 'Repeated on the same page',
};

export interface ImageAuditItem {
  url: string;
  state: ImageCheckState;
  /** Why it is broken / failed / unverified / deferred. */
  reason?: string;
  /** The result came from the crawl's own link check or an earlier audit of this crawl (not requested again). */
  reused?: 'crawl' | 'audit';
  status?: number | null;
  finalStatus?: number | null;
  finalUrl?: string;
  redirects?: number;
  contentType?: string;
  format?: string;
  /** Total file size in bytes (from Content-Range / Content-Length; the file is not downloaded). */
  bytes?: number;
  width?: number;
  height?: number;
  checkedAt?: string;
  ms?: number;
  // ---- from the crawled HTML (no request)
  /** Pages showing it, and the first of them. */
  pageCount: number;
  pages: string[];
  /** <img> elements referencing it (several per page possible). */
  refs: number;
  /** References without an alt attribute / with alt="". */
  altMissing: number;
  altEmpty: number;
  /** First non-empty ALT text seen. */
  altText?: string;
  /** References without width or height attributes. */
  noDimensions: number;
  /** References with loading="lazy". */
  lazy: number;
  /** References below the first two images of the main content without loading="lazy". */
  eagerBelowFold: number;
  /** width / height attributes of the first reference that had them (displayed size). */
  htmlWidth?: number;
  htmlHeight?: number;
  inMain: boolean;
  /** Same file (host + path) referenced under other URLs (different query strings). */
  duplicateOf?: string;
  duplicateUrls?: number;
  issues: ImageIssueId[];
  recommendations: string[];
}

export interface ImageAuditCounts {
  total: number;
  pending: number;
  /** ok + broken + failed (an answer was received). */
  checked: number;
  ok: number;
  broken: number;
  failed: number;
  unverified: number;
  deferred: number;
  /** Results taken over from the crawl's link check or an earlier audit (not requested again). */
  reused: number;
  requests?: number;
  rateLimited?: number;
}

export type ImageAuditStatus = 'running' | 'completed' | 'partial' | 'cancelled' | 'failed';

export interface ImageAuditJob {
  id: string;
  runId: string;
  status: ImageAuditStatus;
  startedAt: string;
  finishedAt?: string;
  startedBy: string;
  counts: ImageAuditCounts;
  /** HTML pages of the crawl that were read, image references found, unique image URLs, inline data: images skipped. */
  pages: number;
  references: number;
  images: number;
  inlineImages: number;
  /** Unique images beyond the audit's limit (listed nowhere, counted here). */
  overLimit: number;
  reason?: string;
  error?: string;
  budgetMs: number;
  heavyKb: number;
}

export interface ImageAuditQuery {
  state?: ImageCheckState;
  issue?: ImageIssueId;
  q?: string;
  sort?: 'pages' | 'bytes' | 'url' | 'state';
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

export interface ImageAuditListResponse {
  job: ImageAuditJob;
  total: number;
  offset: number;
  limit: number;
  rows: ImageAuditItem[];
  facets: { state: Partial<Record<ImageCheckState, number>>; issue: Partial<Record<ImageIssueId, number>> };
}

export interface ImageAuditStatusResponse {
  /** Finished crawls of this website whose image references are still on the server (newest first). */
  runs: { runId: string; type: string; startedAt?: string; outcome?: string; pages?: number }[];
  /** The newest audit of each of those crawls. */
  jobs: ImageAuditJob[];
  running?: ImageAuditJob;
  available: boolean;
  reason?: string;
  limits: { maxImages: number; budgetMinutes: number; concurrency: number; probeKb: number };
}

/** CSV columns of an Image Audit export. */
export const IMAGE_AUDIT_CSV: { header: string; value: (i: ImageAuditItem) => unknown }[] = [
  { header: 'image_url', value: (i) => i.url },
  { header: 'state', value: (i) => i.state },
  { header: 'reason', value: (i) => i.reason },
  { header: 'reused', value: (i) => i.reused },
  { header: 'http_status', value: (i) => i.status },
  { header: 'final_status', value: (i) => i.finalStatus },
  { header: 'final_url', value: (i) => i.finalUrl },
  { header: 'redirects', value: (i) => i.redirects },
  { header: 'content_type', value: (i) => i.contentType },
  { header: 'format', value: (i) => i.format },
  { header: 'bytes', value: (i) => i.bytes },
  { header: 'width', value: (i) => i.width },
  { header: 'height', value: (i) => i.height },
  { header: 'html_width', value: (i) => i.htmlWidth },
  { header: 'html_height', value: (i) => i.htmlHeight },
  { header: 'pages', value: (i) => i.pageCount },
  { header: 'references', value: (i) => i.refs },
  { header: 'alt_missing', value: (i) => i.altMissing },
  { header: 'alt_empty', value: (i) => i.altEmpty },
  { header: 'alt_text', value: (i) => i.altText },
  { header: 'no_width_height', value: (i) => i.noDimensions },
  { header: 'lazy', value: (i) => i.lazy },
  { header: 'below_fold_not_lazy', value: (i) => i.eagerBelowFold },
  { header: 'duplicate_urls', value: (i) => i.duplicateUrls },
  { header: 'issues', value: (i) => i.issues.map((x) => IMAGE_ISSUE_LABELS[x]).join(' | ') },
  { header: 'recommendations', value: (i) => i.recommendations.join(' | ') },
  { header: 'example_pages', value: (i) => i.pages.join(' ') },
  { header: 'checked_at', value: (i) => i.checkedAt },
];
