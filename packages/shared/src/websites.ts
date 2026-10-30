/**
 * Multi-website support. Every SEO record (issues, Fix Cards, crawls, reports, settings, integration configuration) belongs
 * to exactly one website workspace, addressed by a stable `websiteId`. A website added by a person starts EMPTY: nothing is
 * crawled, scored or connected until that actually happens.
 */
import { ApiError } from './api';
import { defaultConfig } from './config';
import type { SeedData } from './seed/index';
import type { Website, WebsiteInput, WebsitePlatform, WebsiteSummary } from './types';
import { computeHealthScore } from './rules/healthScore';

export const PRIMARY_WEBSITE_ID = 'site-deodap';
export const WEBSITE_HEADER = 'X-Website-Id';

export const WEBSITE_PLATFORMS: { id: WebsitePlatform; label: string }[] = [
  { id: 'shopify', label: 'Shopify' },
  { id: 'woocommerce', label: 'WooCommerce' },
  { id: 'magento', label: 'Magento / Adobe Commerce' },
  { id: 'bigcommerce', label: 'BigCommerce' },
  { id: 'wordpress', label: 'WordPress' },
  { id: 'custom', label: 'Custom / other' },
];

/** Lower-case host without "www." — the identity used for duplicate detection. */
export function normalizeDomain(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function parseUrl(raw: string, field: string): URL {
  const v = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    throw new ApiError(400, 'VALIDATION', `${field} is not a valid URL.`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ApiError(400, 'VALIDATION', `${field} must start with http:// or https://.`);
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new ApiError(400, 'VALIDATION', `${field} needs a full domain, e.g. example.com.`);
  return u;
}

/** Validates and normalises a website form. Throws ApiError(400/409) with a message meant for the form. */
export function validateWebsiteInput(input: WebsiteInput, existing: Website[], exceptId?: string): Pick<Website, 'name' | 'url' | 'domain' | 'platform' | 'sitemapUrl'> {
  const name = (input.name ?? '').trim();
  if (name.length < 2) throw new ApiError(400, 'VALIDATION', 'Website name is required.');
  if (name.length > 80) throw new ApiError(400, 'VALIDATION', 'Website name must be 80 characters or fewer.');
  if (!input.url?.trim()) throw new ApiError(400, 'VALIDATION', 'Website URL is required.');
  const u = parseUrl(input.url, 'Website URL');
  const domain = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!WEBSITE_PLATFORMS.some((p) => p.id === input.platform)) throw new ApiError(400, 'VALIDATION', 'Choose a platform.');
  let sitemapUrl: string | undefined;
  if (input.sitemapUrl?.trim()) {
    const sm = parseUrl(input.sitemapUrl, 'Sitemap URL');
    if (sm.hostname.toLowerCase().replace(/^www\./, '') !== domain) throw new ApiError(400, 'VALIDATION', `Sitemap URL must be on ${domain}.`);
    sitemapUrl = sm.toString();
  }
  const dup = existing.find((w) => w.domain === domain && w.id !== exceptId);
  if (dup) throw new ApiError(409, 'DUPLICATE_DOMAIN', `${domain} is already added as "${dup.name}".`);
  return { name, url: `${u.protocol}//${u.host}/`, domain, platform: input.platform, sitemapUrl };
}

export function fixtureWebsite(now: Date): Website {
  return {
    id: PRIMARY_WEBSITE_ID, name: 'DeoDap', url: 'https://deodap.in/', domain: 'deodap.in', platform: 'shopify', sitemapUrl: 'https://deodap.in/sitemap.xml',
    createdAt: now.toISOString(), updatedAt: now.toISOString(), createdByName: 'Sentinel (test dataset)', source: 'sample',
  };
}

/** Site-scoped collections of a brand-new website: empty, never crawled, nothing connected. */
export type SiteData = Omit<SeedData, 'employees' | 'passwords' | 'permissions'>;

export function createEmptySite(now: Date, w: Website): SiteData {
  const cfg = defaultConfig(now);
  const brand = w.name;
  cfg.site = { ...cfg.site, baseUrl: w.url.replace(/\/$/, ''), canonicalHost: w.domain, brand };
  cfg.competitors = [];
  return {
    generatedAt: now.toISOString(), config: cfg,
    catalog: { pages: [], byUrl: new Map(), home: undefined as never, collections: [], products: [], blogs: [], productCategory: new Map() },
    siteSize: 0, issues: [], groups: [], exclusions: [], tasks: [], crawls: [], crawlUrls: {}, sitemapDiffs: {},
    schedules: [
      { id: 'SCH-FULL', type: 'full', cron: cfg.crawl.fullCrawlCron, description: 'Weekly full crawl — all indexable URLs', enabled: false, timezone: 'Asia/Kolkata' },
      { id: 'SCH-SMART', type: 'smart', cron: cfg.crawl.smartCrawlCron, description: 'Daily smart crawl — home, collections, top products, changed pages, re-verify', enabled: false, timezone: 'Asia/Kolkata' },
    ],
    verifications: [], healthHistory: [], cwv: [], indexation: [], visibility: [], aiTrend: [], aiPrompts: [], backlinks: [], refTrend: [],
    prospects: [], mentions: [], disavow: [], competitors: [], localHealth: { napConsistency: [], gbp: null as never }, keywordGaps: [],
    striking: [], ctrRewrites: [], briefs: [], clusters: [], opportunities: [], rules: [], aiFlags: [], contentScores: [], pageTexts: [],
    notifications: [], deliveries: [], audit: [], criticalAlerts: [], errors: [],
  };
}

/** True only when the workspace has findings or a completed real crawl — never inferred. */
export function siteHasAuditData(d: Pick<SiteData, 'issues' | 'crawls'>): boolean {
  return d.issues.length > 0 || d.crawls.some((c) => c.status === 'completed' && c.source !== 'simulated');
}

export function summarizeWebsite(w: Website, d: SiteData, integrations: { connected: number; total: number }, now: Date): WebsiteSummary {
  const has = siteHasAuditData(d);
  const open = { critical: 0, medium: 0, low: 0 };
  for (const i of d.issues) if (!i.supersededById && !['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE', 'SUPERSEDED'].includes(i.status)) open[i.severity] += 1;
  const last = [...d.crawls].reverse().find((c) => c.status === 'completed');
  return {
    ...w, hasAuditData: has, lastCrawlAt: last?.finishedAt, lastCrawlSource: last?.source,
    healthScore: has ? computeHealthScore(d.issues, d.siteSize, d.config, now).score : undefined,
    openIssues: open, integrationsConnected: integrations.connected, integrationsTotal: integrations.total,
  };
}
