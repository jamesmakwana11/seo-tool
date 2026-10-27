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
import { fixTime, loc, type FixLocation, type FixTime } from './fixGuide';

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
  /** Rounds in which the image was answered "rate limited" (it is tried again up to IMAGE_AUDIT_RATE_LIMIT_ROUNDS). */
  rateLimitedRounds?: number;
  // ---- from the crawled HTML (no request)
  /** Pages showing it (an image reused on several pages is normal), and the first of them — all of them: GET …/occurrences. */
  pageCount: number;
  pages: string[];
  /** Pages that show it MORE THAN ONCE (the "repeated" problem), and the most copies on one page. */
  repeatedPages?: number;
  maxPerPage?: number;
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
  /** Images with a final result: checked + unverified. Progress = finished / total; 100 % only when nothing is pending or deferred. */
  finished: number;
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
  /** Length of one checking round (ms). */
  budgetMs: number;
  heavyKb: number;
  /** Checking rounds run so far (one Go checker process each; the next round takes the images still pending). */
  rounds: number;
  /** Times the audit was resumed (by a user, or automatically after a server restart). */
  resumes?: number;
  /** Last stored progress: where (database = survives a restart; memory = lost on a restart) and when. */
  checkpoint?: { at: string; storage: 'database' | 'memory'; finished: number };
  /** Waiting before it can run: another audit on this server, or a pause for rate-limited images. */
  waiting?: string;
  /** Not finished and can be resumed: images still pending or deferred. */
  resumable?: boolean;
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

/** Every page showing one image, with each <img> instance on it (read from the crawl's image references). */
export interface ImageOccurrence {
  page: string;
  count: number;
  instances: { position: number; alt: string | null; width?: string; height?: string; loading?: string; inMain: boolean; location?: string }[];
}
export interface ImageOccurrencesResponse {
  url: string;
  /** false when the crawl's image references are no longer on the server (then nothing could be identified). */
  available: boolean;
  reason?: string;
  /** Pages showing the image / pages showing it more than once / total <img> instances. */
  pages: number;
  repeatedPages: number;
  references: number;
  total: number;
  offset: number;
  limit: number;
  rows: ImageOccurrence[];
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
  limits: { maxImages: number; budgetMinutes: number; concurrency: number; probeKb: number; maxHours: number };
  /** Where audit progress is stored: database = an audit continues after a server restart; memory = lost on a restart. */
  storage: 'database' | 'memory';
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

/** Where an image problem is fixed, how long it takes per image and how to verify it (Shopify; the web app localizes). */
export function imageIssueFix(id: ImageIssueId): { where: FixLocation[]; time: FixTime; verify: string } | undefined {
  const media = loc('shopify-admin', 'Products → {product} → Media → the image');
  const theme = (p: string) => loc('theme-code', `Online Store → Themes → … → Edit code → ${p}`);
  const reaudit = 'Run a crawl, then start a new Image Audit (answers already checked are reused) — the image no longer shows this problem.';
  const t = (a: number, b: number, basis: string) => fixTime(a, b, basis);
  const map: Partial<Record<ImageIssueId, { where: FixLocation[]; time: FixTime; verify?: string }>> = {
    broken: { where: [media, loc('shopify-admin', 'Content → Files (re-upload) / the section or description that references it')], time: t(5, 15, 'per image: re-upload or replace the reference') },
    failed: { where: [loc('app', 'The image host / CDN named in the URL'), media], time: t(10, 30, 'per image: check the host, then re-upload if it keeps failing'), verify: 'Re-run the Image Audit later; a temporary failure answers 2xx, a permanent one must be re-uploaded.' },
    'alt-missing': { where: [media, theme('the section rendering the image (alt="{{ image.alt | escape }}")')], time: t(2, 5, 'per image: write ALT text') },
    'alt-empty': { where: [media], time: t(2, 5, 'per image: describe it, or keep alt="" if it is purely decorative') },
    'no-dimensions': { where: [theme('the section / snippet rendering <img> (use image_tag or add width and height)')], time: t(15, 30, 'one theme change fixes every image rendered by that section') },
    'not-lazy': { where: [theme('the section rendering below-the-fold images (loading="lazy")')], time: t(15, 30, 'one theme change for the section') },
    heavy: { where: [media, loc('app', 'Image compression app, or re-export the file under the size limit')], time: t(5, 10, 'per image: compress and re-upload') },
    'legacy-format': { where: [theme('use the image_url filter (Shopify serves WebP / AVIF automatically)')], time: t(15, 45, 'one theme change for hard-coded image URLs') },
    oversized: { where: [theme('add srcset / sizes or a width parameter (image_url: width: …)')], time: t(15, 45, 'one theme change for the section') },
    redirect: { where: [loc('shopify-admin', 'The description / section that references the old image URL')], time: t(5, 10, 'per reference: use the final URL') },
    duplicate: { where: [theme('use one image URL (drop extra query strings)'), loc('shopify-admin', 'Content → Files')], time: t(10, 20, 'per file: point every reference at one URL') },
    repeated: { where: [theme('the section or gallery that outputs the image twice')], time: t(10, 20, 'remove the duplicate block') },
    unverified: { where: [loc('site-settings', 'robots.txt or the rate limit that blocked the check (only if the image must be checked)')], time: t(5, 15, 'decide whether it needs checking; resume the audit later if it was rate limited'), verify: 'Resume the Image Audit — it checks only the images not answered yet.' },
  };
  const f = map[id];
  return f ? { where: f.where, time: f.time, verify: f.verify ?? reaudit } : undefined;
}
