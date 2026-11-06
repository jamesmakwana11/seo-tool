/**
 * Google integrations managed from the Integrations screen (no server configuration for routine setup):
 *  - Google sign-in (OAuth 2.0) for Google Analytics 4 and Google Search Console: the OAuth client's ID and secret are
 *    entered once on the screen (the secret is stored encrypted), then any number of Google accounts can be connected.
 *    Each website is mapped to one account + GA4 property and one account + Search Console property.
 *  - PageSpeed Insights (Core Web Vitals): an API key entered on the screen (stored encrypted).
 * Secrets (client secret, refresh tokens, API key) never leave the API server.
 */

export const GOOGLE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
] as const;
export const GA4_OAUTH_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const GSC_OAUTH_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** Path of the OAuth callback, appended to Sentinel's public address. Register `<app URL>/api/google/oauth/callback`. */
export const GOOGLE_OAUTH_CALLBACK_PATH = '/api/google/oauth/callback';

export type GoogleProduct = 'ga4' | 'gsc';

export interface GoogleOAuthClientStatus {
  /** Client ID and secret are saved (or set in the server environment) and an app URL is known. */
  configured: boolean;
  clientId?: string;
  secretSet: boolean;
  source: 'saved' | 'env' | 'none';
  /** Public address of Sentinel used to build the redirect URI. */
  appUrl?: string;
  appUrlSource: 'saved' | 'env' | 'request' | 'none';
  /** The exact Authorized redirect URI to register on the OAuth client in Google Cloud. */
  redirectUri?: string;
  problem?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export type GoogleAccountState = 'connected' | 'expired' | 'error';

export interface GoogleAccount {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  scopes: string[];
  /** Products this account's grant covers. */
  products: GoogleProduct[];
  state: GoogleAccountState;
  stateDetail?: string;
  connectedAt: string;
  connectedBy?: string;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastTestResult?: string;
  /** Websites mapped to this account (names). */
  usedBy: { websiteId: string; websiteName: string; product: GoogleProduct; property: string }[];
}

export interface PsiStatus {
  connected: boolean;
  keySource: 'saved' | 'env' | 'none';
  connectedAt?: string;
  connectedBy?: string;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastTestResult?: string;
  problem?: string;
}

/** One website's link to a GA4 property or Search Console property. */
export interface GoogleSiteMapping {
  product: GoogleProduct;
  accountId?: string;
  accountEmail?: string;
  /** GA4: numeric property id. GSC: sc-domain:… or URL-prefix property. */
  property?: string;
  propertyName?: string;
  /** Mapped through a Google account (OAuth) or the server's service account (env). */
  via: 'oauth' | 'service_account' | 'none';
  state: 'connected' | 'not_tested' | 'failed' | 'expired' | 'not_mapped' | 'rate_limited';
  stateDetail: string;
  lastTestAt?: string;
  lastTestOk?: boolean;
  lastTestResult?: string;
  lastSyncAt?: string;
}

export interface CwvSiteSettings {
  /** Pages tested (the homepage when empty). At most CWV_MAX_URLS. */
  urls: string[];
  /** Daily automatic test (mobile + desktop) at 01:30 IST. */
  autoDaily: boolean;
}
export const CWV_MAX_URLS = 5;

export interface GoogleStatus {
  /** Whether the server can store secrets (SESSION_SECRET / CREDENTIALS_ENCRYPTION_KEY) and keep them (DATABASE_URL). */
  canStore: boolean;
  storeProblem?: string;
  persistent: boolean;
  oauth: GoogleOAuthClientStatus;
  accounts: GoogleAccount[];
  psi: PsiStatus;
  /** The current website. */
  website: { id: string; name: string; url: string };
  ga4: GoogleSiteMapping;
  gsc: GoogleSiteMapping;
  cwv: CwvSiteSettings & { lastRunAt?: string; lastRunOk?: boolean };
}

export interface Ga4PropertyOption { propertyId: string; displayName: string; accountName: string; accountId: string; propertyType?: string }
export interface GscSiteOption { siteUrl: string; permissionLevel: string; usable: boolean }

export interface GoogleTestResult { ok: boolean; message: string; rateLimited?: boolean; expired?: boolean }

// ------------------------------------------------------------------ reports

export type ReportRange = 7 | 28 | 90;
export type ReportCompare = 'previous' | 'year';
export const REPORT_RANGES: ReportRange[] = [7, 28, 90];

export interface DateWindow { start: string; end: string }

export interface Ga4Totals {
  activeUsers: number;
  newUsers: number;
  sessions: number;
  engagedSessions: number;
  /** 0–1 */
  engagementRate: number;
  /** seconds */
  averageSessionDuration: number;
  screenPageViews: number;
  /** Key events (GA4's conversions). */
  conversions: number;
}
export interface Ga4Report {
  propertyId: string;
  propertyName?: string;
  accountEmail?: string;
  range: DateWindow;
  compareRange: DateWindow;
  compare: ReportCompare;
  totals: Ga4Totals;
  previous: Ga4Totals;
  daily: { date: string; activeUsers: number; sessions: number; conversions: number }[];
  channels: { name: string; sessions: number; activeUsers: number; engagementRate: number; conversions: number }[];
  sources: { name: string; sessions: number; activeUsers: number; engagementRate: number; conversions: number }[];
  pages: { path: string; views: number; activeUsers: number; engagementRate: number }[];
  /** "keyEvents" (current GA4 name) or "conversions" (older properties). */
  conversionMetric: 'keyEvents' | 'conversions';
  fetchedAt: string;
  cached: boolean;
}

export interface GscTotals { clicks: number; impressions: number; /** 0–1 */ ctr: number; position: number }
export interface GscRowOut { key: string; clicks: number; impressions: number; ctr: number; position: number }
export interface GscSitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  warnings: number;
  errors: number;
  contents: { type: string; submitted: number; indexed?: number }[];
}
export interface GscReport {
  property: string;
  accountEmail?: string;
  range: DateWindow;
  compareRange: DateWindow;
  compare: ReportCompare;
  totals: GscTotals;
  previous: GscTotals;
  daily: { date: string; clicks: number; impressions: number; ctr: number; position: number }[];
  queries: GscRowOut[];
  pages: GscRowOut[];
  countries: GscRowOut[];
  devices: GscRowOut[];
  /** Search Console's sitemap report (submitted / indexed counts where Google still reports them). */
  sitemaps: GscSitemap[];
  sitemapsError?: string;
  fetchedAt: string;
  cached: boolean;
}

export interface GscInspection {
  url: string;
  inspectedAt: string;
  verdict?: string;
  coverageState?: string;
  indexingState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  userCanonical?: string;
  crawledAs?: string;
  mobileUsability?: string;
  richResults?: string;
  link?: string;
}

/** Daily totals stored on every report fetch: history beyond what the report window shows. */
export interface GoogleHistoryPoint {
  date: string;
  ga4?: { activeUsers: number; sessions: number; conversions: number };
  gsc?: { clicks: number; impressions: number; ctr: number; position: number };
}

// ------------------------------------------------------------------ Core Web Vitals

export type CwvMetric = 'LCP' | 'INP' | 'CLS' | 'FCP' | 'TTFB';
export const CWV_METRICS: CwvMetric[] = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'];
export type CwvRating = 'good' | 'needs_improvement' | 'poor';
export type CwvStrategy = 'mobile' | 'desktop';

/** Google's thresholds (web.dev/vitals): good ≤ first value, poor > second value. ms except CLS (unitless). */
export const CWV_THRESHOLDS: Record<CwvMetric | 'TBT', [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
  TBT: [200, 600],
};
export const CWV_LABELS: Record<CwvMetric | 'TBT', string> = {
  LCP: 'Largest Contentful Paint',
  INP: 'Interaction to Next Paint',
  CLS: 'Cumulative Layout Shift',
  FCP: 'First Contentful Paint',
  TTFB: 'Time to First Byte',
  TBT: 'Total Blocking Time',
};
export const CWV_RATING_LABELS: Record<CwvRating, string> = { good: 'Good', needs_improvement: 'Needs improvement', poor: 'Poor' };

export function rateCwv(metric: CwvMetric | 'TBT', value: number): CwvRating {
  const [good, poor] = CWV_THRESHOLDS[metric];
  return value <= good ? 'good' : value <= poor ? 'needs_improvement' : 'poor';
}

/** Worst of the given ratings (a page passes only when every vital is good). */
export function worstRating(r: (CwvRating | undefined)[]): CwvRating | undefined {
  const list = r.filter((x): x is CwvRating => !!x);
  if (!list.length) return undefined;
  return list.includes('poor') ? 'poor' : list.includes('needs_improvement') ? 'needs_improvement' : 'good';
}

export interface CwvValue { value: number; rating: CwvRating }
export interface CwvRun {
  id: string;
  url: string;
  strategy: CwvStrategy;
  at: string;
  trigger: 'manual' | 'schedule' | 'test';
  ok: boolean;
  error?: string;
  /** Lighthouse performance score 0–100. */
  performanceScore?: number;
  /** Lab data (this run). INP cannot be measured in the lab: TBT is its lab stand-in. */
  lab: Partial<Record<CwvMetric | 'TBT', CwvValue>>;
  /** Field data (real Chrome users, 28-day p75) for the URL, or the whole origin when the URL has too little traffic. */
  field?: { scope: 'url' | 'origin'; metrics: Partial<Record<CwvMetric, CwvValue>>; overall?: CwvRating };
}

export interface CwvReport {
  connected: boolean;
  problem?: string;
  settings: CwvSiteSettings;
  /** Latest run per URL + strategy. */
  latest: CwvRun[];
  /** Up to 180 days of runs, oldest first. */
  history: CwvRun[];
  running: boolean;
}
