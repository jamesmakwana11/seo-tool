/**
 * Shopify connection, SEO editor drafts and theme proposals.
 *
 * The Admin API access token never appears in any of these types: it stays inside the API server's memory.
 */

export type ShopifyResourceKind = 'product' | 'collection' | 'page' | 'article';

/**
 * Access scopes the SEO editor asks for (OAuth) or needs on a custom-app token.
 * A write_* scope includes its read_* scope.
 */
export const SHOPIFY_REQUIRED_SCOPES = ['read_products', 'write_products', 'read_content', 'write_content'] as const;
/** Theme reading / theme proposals, and image alt text (fileUpdate needs write_files or write_themes). */
export const SHOPIFY_OPTIONAL_SCOPES = ['read_themes', 'write_themes', 'write_files'] as const;
export const SHOPIFY_SCOPE_HELP: Record<string, string> = {
  read_products: 'Read products and collections (titles, descriptions, SEO fields, image alt text)',
  write_products: 'Change products and collections (productUpdate, collectionUpdate)',
  read_content: 'Read pages, blogs and articles',
  write_content: 'Change pages and articles (pageUpdate, articleUpdate, SEO metafields)',
  read_themes: 'List themes and read theme files (to find where an H1 comes from)',
  write_themes: 'Write files of an unpublished theme after explicit confirmation (themeFilesUpsert). Never publishes a theme.',
  write_files: 'Change image alt text (fileUpdate). write_themes also allows it.',
};

export interface ShopifyStatus {
  connected: boolean;
  /** How the token was obtained: OAuth on this server, or SHOPIFY_ADMIN_TOKEN from the environment. */
  via: 'oauth' | 'env_token' | null;
  shop?: string;
  shopName?: string;
  apiVersion: string;
  scopes: string[];
  missingScopes: string[];
  /** Optional scopes not granted (theme proposals or image alt text then stay unavailable). */
  missingOptionalScopes: string[];
  requiredScopes: string[];
  optionalScopes: string[];
  /** SHOPIFY_API_KEY + SHOPIFY_API_SECRET + an app URL are set, so “Connect with Shopify” can run. */
  oauthConfigured: boolean;
  /** The callback URL to register in the Shopify app settings. */
  redirectUrl?: string;
  connectedAt?: string;
  connectedBy?: string;
  problems: string[];
  /** Where the token lives and what happens on restart. */
  tokenNote: string;
  capabilities: { edit: boolean; themes: boolean; themeWrite: boolean; imageAlt: boolean };
  /** The Shopify app credentials in use (never the secret itself). */
  appCredentials?: {
    /** saved = entered in Sentinel (secret stored encrypted); env = SHOPIFY_API_KEY / SHOPIFY_API_SECRET. */
    source: 'saved' | 'env' | 'none';
    clientId?: string;
    secretSet: boolean;
    appUrl?: string;
    appUrlSource: 'saved' | 'env' | 'none';
    updatedAt?: string;
    updatedBy?: string;
    /** false when the server has no key to encrypt with (then credentials cannot be saved here). */
    canStore: boolean;
    storeProblem?: string;
    /** false without a database: saved credentials last until the API restarts. */
    persistent: boolean;
  };
}

export interface ShopifyResourceSummary {
  kind: ShopifyResourceKind;
  id: string;
  handle: string;
  title: string;
  /** Storefront path, e.g. /products/vegetable-chopper or /blogs/news/hello. */
  path: string;
  seoTitle: string;
  seoDescription: string;
  updatedAt?: string;
  /** Link to the resource in the Shopify admin. */
  adminUrl?: string;
}

export interface ShopifyResolveResult {
  url: string;
  kind?: ShopifyResourceKind;
  handle?: string;
  blogHandle?: string;
  resource?: ShopifyResourceSummary;
  /** Why no resource matched (not a product/collection/page/article URL, not found, not connected). */
  problem?: string;
}

export interface ShopifyResourceList {
  kind: ShopifyResourceKind;
  items: ShopifyResourceSummary[];
  nextCursor?: string;
}

export interface ShopifyFieldValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ShopifyFieldDraft {
  /** seoTitle | seoDescription | title | h1 | tags | bodyHtml | summaryHtml | imageAlt:<media id> | imageAlt:featured */
  key: string;
  label: string;
  /** The value in Shopify when the draft was made. */
  current: string;
  proposed: string;
  /** Why a change is proposed (from the audit). Empty when nothing is suggested. */
  reason: string;
  source: 'suggested' | 'manual' | 'unchanged';
  /** admin_api: written through the Admin API. theme: the value is rendered by the theme and needs a theme edit. */
  applyVia: 'admin_api' | 'theme';
  /** Which mutation writes it, e.g. productUpdate (seo.title). */
  mutation?: string;
  validation: ShopifyFieldValidation;
  /** Selected for applying. */
  include: boolean;
  /** Extra context shown with the field (image URL, character limits…). */
  hint?: string;
  /** What is wrong with the current value (missing, too long, duplicated…); verdict good = keep it. */
  assessment?: import('./seoAssess').FieldAssessment;
  /** A suggested value built from the page's own content, with why; `keep` when the current value is already good. */
  suggestion?: ShopifyFieldSuggestion;
}

export interface ShopifyFieldSuggestion {
  value: string;
  reason: string;
  keep: boolean;
  /** high: safe to apply in bulk; review: changes wording — a person should look at it first. */
  confidence: 'high' | 'review';
}

export type H1Source = 'title' | 'body' | 'theme' | 'unknown';

export interface H1SourceReport {
  /** H1 texts on the storefront page (from the latest crawl or a fresh fetch). */
  pageH1s: string[];
  basis: 'crawl' | 'storefront' | 'none';
  observedAt?: string;
  sources: { text: string; source: H1Source; applyVia: 'admin_api' | 'theme'; explanation: string }[];
  summary: string;
}

export interface ShopifyFieldResult {
  key: string;
  label: string;
  status: 'verified' | 'applied_unverified' | 'failed' | 'conflict' | 'skipped';
  before: string;
  after?: string;
  message?: string;
}

export interface ShopifyReaudit {
  url: string;
  at: string;
  status: number | null;
  checks: { field: string; expected: string; found: string; ok: boolean }[];
  /** e.g. “Storefront not updated yet (cache) — re-run the check in a few minutes”. */
  note?: string;
  skipped?: string;
}

export interface ShopifyApplyResult {
  at: string;
  by: string;
  fields: ShopifyFieldResult[];
  /** Every applied field read back from Shopify with the new value. */
  verified: boolean;
  reaudit?: ShopifyReaudit;
}

export interface ShopifyDraft {
  id: string;
  kind: ShopifyResourceKind;
  resourceId: string;
  handle: string;
  resourceTitle: string;
  url?: string;
  adminUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  fields: ShopifyFieldDraft[];
  h1: H1SourceReport;
  /** Things the editor cannot change through the API (theme work) and other notes. */
  notes: string[];
  status: 'draft' | 'applied' | 'partial' | 'failed';
  result?: ShopifyApplyResult;
}

export interface ShopifyApplyPreview {
  drafts: {
    id: string;
    resourceTitle: string;
    kind: ShopifyResourceKind;
    changes: { key: string; label: string; live: string; proposed: string; conflict: boolean; mutation?: string }[];
    problems: string[];
  }[];
  /** Number of field changes that will be written. */
  total: number;
  conflicts: number;
  /**
   * One-time token for this review. Applying needs it (no typed phrase): it proves the changes were reviewed, and a
   * second submission with the same token returns the first result instead of writing again.
   */
  previewId: string;
  expiresAt: string;
}

export interface ShopifyApplyBatchResult {
  applied: number;
  failed: number;
  skipped: number;
  drafts: ShopifyDraft[];
}

export interface ShopifyTheme {
  id: string;
  name: string;
  role: string;
  updatedAt?: string;
  /** false for the live (MAIN) theme: Sentinel only writes to unpublished themes. */
  writable: boolean;
}

export interface ShopifyThemeFile {
  themeId: string;
  filename: string;
  checksumMd5: string | null;
  size: number;
  content: string;
}

export interface DiffLine {
  op: ' ' | '+' | '-' | '…';
  text: string;
}

export interface ShopifyThemeProposal {
  id: string;
  themeId: string;
  themeName: string;
  themeRole: string;
  filename: string;
  reason: string;
  /** Checksum of the file when the proposal was made; a different checksum at apply time is a conflict. */
  originalChecksum: string | null;
  originalSize: number;
  diff: DiffLine[];
  added: number;
  removed: number;
  createdBy: string;
  createdAt: string;
  status: 'proposed' | 'applied' | 'failed' | 'conflict';
  confirmPhrase: string;
  /** The theme is the published (live) one: writing changes the storefront at once. Needs the backup and its own phrase. */
  live?: boolean;
  /** When the original file was downloaded (a live-theme write is refused before that). */
  backupTakenAt?: string;
  /** Storefront page to check after writing (H1 changes). */
  pageUrl?: string;
  result?: { at: string; by: string; message: string; verified: boolean; liveCheck?: { url: string; expected: string; found: string[]; ok: boolean; note?: string } };
}

// ------------------------------------------------------------------------------------------ bulk SEO fixes

/** Field groups a bulk fix can change. links = internal links in the description / content HTML. */
export type SeoBulkField = 'seoTitle' | 'seoDescription' | 'title' | 'h1' | 'imageAlt' | 'tags' | 'links';

export const SEO_BULK_FIELD_LABELS: Record<SeoBulkField, string> = {
  seoTitle: 'SEO titles', seoDescription: 'Meta descriptions', title: 'Titles', h1: 'H1 headings', imageAlt: 'Image alt text', tags: 'Tags', links: 'Internal links',
};

export interface SeoBulkStartInput {
  /** pages: every page of a crawl; issues: open issues (all, or `issueIds`); urls: chosen pages. */
  scope: 'pages' | 'issues' | 'urls';
  runId?: string;
  issueIds?: string[];
  urls?: string[];
  fields?: SeoBulkField[];
  /** pages: only the pages matching these All-pages filters (at most the job's page cap). */
  filter?: import('./api').CrawlPagesQuery;
}

export interface SeoBulkChange {
  /** Draft field key (seoTitle, imageAlt:<id>, bodyHtml…). */
  key: string;
  field: SeoBulkField;
  label: string;
  current: string;
  proposed: string;
  reason: string;
  problems: string[];
  included: boolean;
  /** review: wording changes a person should check — not selected until someone selects it. */
  confidence: 'high' | 'review';
  result?: { status: 'verified' | 'applied_unverified' | 'failed' | 'conflict' | 'skipped'; message?: string; after?: string };
}

export interface SeoBulkItem {
  url: string;
  title: string;
  pageType: string;
  kind?: ShopifyResourceKind;
  resourceId?: string;
  included: boolean;
  issueIds: string[];
  changes: SeoBulkChange[];
  status: 'planned' | 'applying' | 'done' | 'partial' | 'failed' | 'skipped';
  /** Page audit score from the crawl, and after the fix (storefront fetched again). */
  score?: { before?: number | null; after?: number | null; checkedAt?: string };
  storefront?: ShopifyReaudit;
}

export interface SeoBulkManual {
  /** What needs a person: one row per reason, with how many pages / which issue. */
  reason: string;
  detail: string;
  count: number;
  urls: string[];
  issueId?: string;
  field?: SeoBulkField | string;
  /** A suggestion when one exists (e.g. a wording change to review, a theme H1). */
  suggestion?: string;
}

export interface SeoBulkIssueCheck {
  issueId: string;
  title: string;
  outcome: 'resolved' | 'still_failing' | 'not_verifiable' | 'error';
  details: string;
}

export interface SeoBulkJob {
  id: string;
  scope: SeoBulkStartInput['scope'];
  fields: SeoBulkField[];
  runId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  state: 'scanning' | 'ready' | 'applying' | 'done' | 'cancelled' | 'failed';
  progress: { phase: string; done: number; total: number; message?: string };
  scan: { pagesScanned: number; candidates: number; capped: boolean; cap: number };
  summary: { pages: number; changes: number; selectedPages: number; selectedChanges: number; reviewChanges: number; byField: Partial<Record<SeoBulkField, { pages: number; changes: number }>>; manual: number };
  manual: SeoBulkManual[];
  result?: {
    finishedAt: string;
    verified: number;
    unverified: number;
    failed: number;
    conflicts: number;
    skipped: number;
    pagesRechecked: number;
    issues: SeoBulkIssueCheck[];
    message: string;
  };
  error?: string;
  cancelRequested?: boolean;
}

export interface SeoBulkItemsPage {
  total: number;
  offset: number;
  limit: number;
  items: SeoBulkItem[];
}

// ------------------------------------------------------------------------------------------ SEO optimization lists

export type SeoOptimizationField = 'titles' | 'meta-descriptions' | 'h1' | 'image-alt' | 'tags';

export const SEO_OPTIMIZATION_FIELDS: Record<SeoOptimizationField, { label: string; bulkField: SeoBulkField; assess: import('./seoAssess').SeoFieldType }> = {
  titles: { label: 'Titles', bulkField: 'seoTitle', assess: 'seoTitle' },
  'meta-descriptions': { label: 'Meta descriptions', bulkField: 'seoDescription', assess: 'seoDescription' },
  h1: { label: 'H1 headings', bulkField: 'h1', assess: 'h1' },
  'image-alt': { label: 'Image alt text', bulkField: 'imageAlt', assess: 'imageAlt' },
  tags: { label: 'Tags', bulkField: 'tags', assess: 'tags' },
};

export interface SeoOptimizationQuery {
  runId?: string;
  template?: string;
  /** A problem code (missing, too_long…), 'needs_work' or 'good'. */
  problem?: string;
  /** open: pages with an open issue for this field; none: without. */
  issue?: 'open' | 'none';
  q?: string;
  offset?: number;
  limit?: number;
  /** Tags only: Shopify page cursor. */
  cursor?: string;
}

export interface SeoOptimizationRow {
  url: string;
  title: string;
  pageType: string;
  /** Current value as the storefront shows it (crawl) — or from Shopify for tags. */
  current: string;
  /** Extra values (several H1s, images without alt…). */
  detail?: string;
  assessment: import('./seoAssess').FieldAssessment;
  issueIds: string[];
  /** Editable through Shopify (products, collections, pages, articles). */
  editable: boolean;
  /** Why it cannot be fixed here (homepage, pagination URL, theme H1…). */
  manualReason?: string;
  suggestion?: { value: string; reason: string; keep: boolean; confidence: 'high' | 'review' } | null;
  /** Why no suggestion (Shopify not connected, resource not found…). */
  suggestionNote?: string;
}

export interface SeoOptimizationPage {
  field: SeoOptimizationField;
  runId?: string;
  total: number;
  offset: number;
  limit: number;
  rows: SeoOptimizationRow[];
  counts: Record<string, number>;
  guidelines: import('./seoAssess').SeoGuidelines;
  nextCursor?: string;
  note?: string;
}
