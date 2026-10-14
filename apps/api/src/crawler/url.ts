import type { PageTemplate } from '@sentinel/shared';

/** Resolve `href` against `base`; returns undefined for non-http(s) / unparsable links. Fragment is stripped. */
export function resolveUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  if (!h || /^(javascript|mailto|tel|data|sms|whatsapp):/i.test(h) || h.startsWith('#')) return undefined;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Normalize a URL for identity comparisons: lower-case host, no fragment, default port removed. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Same site: identical host, or www/non-www variants of the same host. */
export function isSameSite(url: string, siteHost: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  const strip = (x: string) => x.replace(/^www\./, '');
  return strip(h) === strip(siteHost.toLowerCase());
}

export function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Template from the URL path (Shopify conventions). */
export function templateOf(url: string): PageTemplate {
  const p = pathOf(url).replace(/\/+$/, '') || '/';
  if (p === '/') return 'home';
  if (/^\/collections\/[^/]+\/products\/[^/]+/.test(p)) return 'product';
  if (/^\/products\/[^/]+/.test(p)) return 'product';
  if (/^\/collections(\/[^/]+)?(\/[^/]+)?$/.test(p)) return 'collection';
  if (/^\/blogs\/[^/]+\/[^/]+/.test(p)) return 'blog_article';
  if (/^\/blogs\/[^/]+$/.test(p)) return 'blog_index';
  if (/^\/pages\/[^/]+/.test(p)) return 'page';
  if (/^\/search/.test(p)) return 'search';
  return 'other';
}

/** Product handle from /products/x or /collections/c/products/x. */
export function productHandle(url: string): string | undefined {
  const m = pathOf(url).match(/\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function collectionHandle(url: string): string | undefined {
  const m = pathOf(url).match(/^\/collections\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** Shopify collection tag page: /collections/{c}/{tag} (not /products/). */
export function isCollectionTagPage(url: string): boolean {
  return /^\/collections\/[^/]+\/(?!products\/)[^/]+\/?$/.test(pathOf(url));
}

const BUDGET_PARAMS = /^(sort_by|sort|order|filter\..*|filter|q|view|variant|page|constraint|pf_.*|_pos|_sid|_ss|utm_.*|ref|srsltid|tag|color|size|price.*)$/i;

/** Parameterised / faceted / tag URLs that waste crawl budget. Returns the reason or undefined. */
export function crawlBudgetReason(url: string): string | undefined {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.keys()];
    const bad = params.filter((k) => BUDGET_PARAMS.test(k));
    if (bad.length) return `query parameter(s): ${bad.join(', ')}`;
    if (params.length) return `query string: ${params.join(', ')}`;
    if (isCollectionTagPage(url)) return 'collection tag page (/collections/x/tag)';
    return undefined;
  } catch {
    return undefined;
  }
}

/** Value of ?page=N (undefined when absent / not numeric). */
export function pageParam(url: string): number | undefined {
  try {
    const v = new URL(url).searchParams.get('page');
    if (v === null || !/^\d+$/.test(v)) return undefined;
    return Number(v);
  } catch {
    return undefined;
  }
}

/** True when the URL is the canonical crawl target itself (not a parameterised duplicate). */
export function hasQuery(url: string): boolean {
  try {
    return new URL(url).search.length > 0;
  } catch {
    return false;
  }
}

export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Compare two URLs ignoring trailing slash differences on the path. */
export function sameUrl(a: string, b: string): boolean {
  const n = (x: string) => {
    try {
      const u = new URL(x);
      u.hash = '';
      let s = u.toString();
      if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
      return s.replace(/\/\?/, '?');
    } catch {
      return x;
    }
  };
  return n(a) === n(b);
}
