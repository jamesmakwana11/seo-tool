/**
 * Where to fix an issue and how long it takes — shared by Fix Cards (Issues), the page audit (All pages / page report)
 * and the Image Audit, so every finding says what to change, where, how to verify it and a realistic time.
 *
 * Steps are written for Shopify (the playbooks name Shopify admin paths and Online Store 2.0 theme files). For a website
 * set to another platform under Manage websites, every location is shown with that platform's equivalent.
 */
import type { WebsitePlatform } from './types';

export type FixLocationKind = 'shopify-admin' | 'theme-code' | 'app' | 'site-settings' | 'search-console' | 'seo-tool' | 'content' | 'outreach';

export interface FixLocation {
  kind: FixLocationKind;
  /** Short name of the place, e.g. "Shopify admin". */
  label: string;
  /** Exact navigation path or file, e.g. "Products → {product} → Search engine listing". */
  path?: string;
}

export interface FixTime {
  minMinutes: number;
  maxMinutes: number;
  /** e.g. "5–15 min", "1–2 h", "30 min–1.5 h". */
  label: string;
  /** How the estimate was made (per page × pages, a template change, …). */
  basis: string;
}

export const FIX_LOCATION_LABELS: Record<FixLocationKind, string> = {
  'shopify-admin': 'Shopify admin',
  'theme-code': 'Theme code',
  app: 'App settings',
  'site-settings': 'Website settings',
  'search-console': 'Google Search Console',
  'seo-tool': 'SEO Sentinel',
  content: 'Content / copy',
  outreach: 'Outreach (off-site)',
};

/** The same place on other platforms (only kinds that differ from Shopify). */
const PLATFORM_EQUIVALENT: Partial<Record<WebsitePlatform, Partial<Record<FixLocationKind, { label: string; path: string }>>>> = {
  woocommerce: {
    'shopify-admin': { label: 'WordPress admin', path: 'Products / Pages / Posts → edit the item (title, description and the SEO box of Yoast or Rank Math); Settings → Permalinks; Redirection plugin for 301s' },
    'theme-code': { label: 'Theme files', path: 'Appearance → Theme File Editor (use a child theme) or the theme files over SFTP' },
    app: { label: 'Plugin settings', path: 'Plugins → the plugin named in the evidence → Settings' },
    'site-settings': { label: 'WordPress settings', path: 'Settings → General / Reading (search engine visibility) / Permalinks' },
  },
  wordpress: {
    'shopify-admin': { label: 'WordPress admin', path: 'Pages / Posts → edit the item (title, content and the SEO box of Yoast or Rank Math); Redirection plugin for 301s' },
    'theme-code': { label: 'Theme files', path: 'Appearance → Theme File Editor (use a child theme) or the theme files over SFTP' },
    app: { label: 'Plugin settings', path: 'Plugins → the plugin named in the evidence → Settings' },
    'site-settings': { label: 'WordPress settings', path: 'Settings → General / Reading / Permalinks' },
  },
  magento: {
    'shopify-admin': { label: 'Magento admin', path: 'Catalog → Products / Categories → Search Engine Optimization; Content → Pages; Marketing → URL Rewrites for 301s' },
    'theme-code': { label: 'Theme templates', path: 'app/design/frontend/<Vendor>/<theme> (deploy through your normal release process)' },
    app: { label: 'Extension settings', path: 'Stores → Configuration → the extension named in the evidence' },
    'site-settings': { label: 'Magento configuration', path: 'Stores → Configuration → General → Web / Catalog → Search Engine Optimization' },
  },
  bigcommerce: {
    'shopify-admin': { label: 'BigCommerce control panel', path: 'Products / Storefront → Web Pages → edit the item (SEO section); Server Settings → 301 Redirects' },
    'theme-code': { label: 'Theme files', path: 'Storefront → My Themes → Advanced → Edit Theme Files' },
    app: { label: 'App settings', path: 'Apps → My Apps → the app named in the evidence' },
    'site-settings': { label: 'Store settings', path: 'Settings → Store profile / Website' },
  },
  custom: {
    'shopify-admin': { label: 'Your CMS / admin', path: 'Where this page’s title, description, content and redirects are edited in your system' },
    'theme-code': { label: 'Page templates', path: 'The template / layout files in your website’s codebase' },
    app: { label: 'Plugin / service settings', path: 'The plugin or third-party service named in the evidence' },
    'site-settings': { label: 'Server / site configuration', path: 'Web server or framework configuration (robots.txt, redirects, headers)' },
  },
};

export const loc = (kind: FixLocationKind, path?: string): FixLocation => ({ kind, label: FIX_LOCATION_LABELS[kind], ...(path ? { path } : {}) });

/** A location as it applies to the website's platform (Shopify paths are kept for Shopify, translated otherwise). */
export function localizeLocation(l: FixLocation, platform: WebsitePlatform = 'shopify'): FixLocation {
  if (platform === 'shopify') return l;
  const eq = PLATFORM_EQUIVALENT[platform]?.[l.kind];
  return eq ? { kind: l.kind, label: eq.label, path: eq.path } : l;
}

export function platformNote(platform: WebsitePlatform = 'shopify', platformLabel?: string): string | undefined {
  if (platform === 'shopify') return undefined;
  return `This website is set to ${platformLabel ?? platform}. The steps name Shopify screens; "Where to fix" shows the ${platformLabel ?? platform} equivalent for each. Change the platform under Manage websites if it is wrong.`;
}

// ------------------------------------------------------------------ time

function nice(m: number): number {
  if (m < 10) return Math.max(1, Math.round(m));
  if (m <= 15) return Math.round(m / 5) * 5;
  if (m <= 60) return Math.round(m / 15) * 15;
  if (m <= 240) return Math.round(m / 30) * 30;
  if (m <= 960) return Math.round(m / 60) * 60;
  return Math.round(m / 480) * 480; // whole working days (8 h)
}
const fmtH = (m: number) => { const h = m / 60; return Number.isInteger(h) ? String(h) : h.toFixed(1); };
function label(min: number, max: number): string {
  if (max >= 2400) return `${Math.round(min / 480)}–${Math.round(max / 480)} working days`;
  if (max < 60) return `${min}–${max} min`;
  if (min >= 60) return `${fmtH(min)}–${fmtH(max)} h`;
  return `${min} min–${fmtH(max)} h`;
}

/** A time range from minutes (rounded to sensible steps; max always above min). */
export function fixTime(minMinutes: number, maxMinutes: number, basis: string): FixTime {
  const min = nice(Math.max(1, minMinutes));
  let max = nice(Math.max(minMinutes + 1, maxMinutes));
  if (max <= min) max = nice(min * 1.5 + 5);
  return { minMinutes: min, maxMinutes: max, label: label(min, max), basis };
}

/** From an effort estimate in hours (one-off or template-level change): about 60–140 % of it. */
export function fixTimeFromHours(hours: number, basis: string): FixTime {
  return fixTime(hours * 60 * 0.6, hours * 60 * 1.4, basis);
}

/** Work repeated per page / image / link: a little setup plus minutes per item. */
export function fixTimePerItem(perItem: [number, number], count: number, item: string, setupMinutes = 5): FixTime {
  const n = Math.max(1, count);
  return fixTime(setupMinutes + perItem[0] * n, setupMinutes + perItem[1] * n,
    `${perItem[0]}–${perItem[1]} min per ${item} × ${n.toLocaleString('en-US')} ${item}${n === 1 ? '' : 's'}${n > 25 ? ' — a bulk edit (CSV import / bulk editor) or one template change is usually faster' : ''}`);
}
