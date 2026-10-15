import { mapPool, type HttpClient } from './http';
import type { SitemapEntry, SitemapFile, SitemapInfo } from './types';

export interface ParsedSitemapXml {
  kind: 'urlset' | 'sitemapindex' | 'invalid';
  urls: { loc: string; lastmod?: string }[];
  children: string[];
  error?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text content of an XML element: CDATA unwrapped, entities decoded, trimmed. */
function xmlText(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1].trim();
  return raw
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

/** First direct `<tag>` (or `<prefix:tag>` with the document's own prefix) inside a block. */
function childText(block: string, tag: string, prefix: string): string | undefined {
  const re = new RegExp(`<${prefix ? `(?:${prefix}:)?` : ''}${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${prefix ? `(?:${prefix}:)?` : ''}${tag}\\s*>`, 'i');
  const m = re.exec(block);
  return m ? xmlText(m[1]) || undefined : undefined;
}

/**
 * Sitemap XML parser (sitemaps.org protocol). A light scanner rather than a DOM: a 50,000-URL / 50 MB sitemap is read
 * without building a document tree, so it stays fast and small even when the crawl already holds many pages in memory.
 * `<loc>` of nested extensions (image:loc, video:loc…) is not mistaken for the page URL.
 */
export function parseSitemapXml(xml: string): ParsedSitemapXml {
  const text = xml.replace(/^﻿/, '').trim();
  if (!text.startsWith('<')) return { kind: 'invalid', urls: [], children: [], error: 'not XML' };
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  const root = /<(?:([\w.-]+):)?(sitemapindex|urlset)[\s>/]/i.exec(body);
  if (!root) return { kind: 'invalid', urls: [], children: [], error: 'no <urlset> or <sitemapindex> root element' };
  const prefix = root[1] ?? '';
  const p = prefix ? `(?:${prefix}:)?` : '';
  if (root[2].toLowerCase() === 'sitemapindex') {
    const children: string[] = [];
    const re = new RegExp(`<${p}sitemap(?:\\s[^>]*)?>([\\s\\S]*?)</${p}sitemap\\s*>`, 'gi');
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const loc = childText(m[1], 'loc', prefix);
      if (loc) children.push(loc);
    }
    return { kind: 'sitemapindex', urls: [], children };
  }
  const urls: { loc: string; lastmod?: string }[] = [];
  const re = new RegExp(`<${p}url(?:\\s[^>]*)?>([\\s\\S]*?)</${p}url\\s*>`, 'gi');
  for (let m = re.exec(body); m; m = re.exec(body)) {
    // Drop nested extension blocks (<image:image><image:loc>…) so only the page's own <loc> is read.
    const own = m[1].replace(/<([\w.-]+):(image|video|news)\b[\s\S]*?<\/\1:\2\s*>/gi, '');
    const loc = childText(own, 'loc', prefix);
    if (!loc) continue;
    const lastmod = childText(own, 'lastmod', prefix);
    urls.push(lastmod ? { loc, lastmod } : { loc });
  }
  return { kind: 'urlset', urls, children: [] };
}

export interface SitemapFetchOptions {
  /** Most sitemap files read (index files included). Default 1,000 (an index may list up to 50,000). */
  maxFiles?: number;
  /** Files fetched in parallel. Default 4. */
  concurrency?: number;
  /** Largest sitemap file read, after decompression. Default 50 MB (the sitemaps.org limit). */
  maxBodyBytes?: number;
  signal?: AbortSignal;
}

/** Fetch sitemap(s), following sitemap index children (breadth-first) up to `maxFiles`. Reads .xml.gz files too. */
export async function fetchSitemaps(http: HttpClient, rootUrls: string[], o: SitemapFetchOptions = {}): Promise<SitemapInfo> {
  const maxFiles = o.maxFiles ?? 1000;
  const maxBody = o.maxBodyBytes ?? 50 * 1024 * 1024;
  const files: SitemapFile[] = [];
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  let level = [...new Set(rootUrls)];
  while (level.length && files.length < maxFiles && !o.signal?.aborted) {
    const todo = level.filter((u) => !seen.has(u) && (seen.add(u), true)).slice(0, maxFiles - files.length);
    const results = await mapPool(todo, Math.max(1, o.concurrency ?? 4), async (url) => {
      const r = await http.request(url, { headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' }, anyContentType: true, gunzip: true, maxBodyBytes: maxBody });
      return { url, r };
    }, o.signal);
    const next: string[] = [];
    for (const res of results) {
      if (!res) continue;
      const { url, r } = res;
      if (r.finalStatus !== 200 || r.body === undefined) {
        files.push({ url, status: r.finalStatus ?? r.status, kind: 'unreachable', count: 0, error: r.error ?? `HTTP ${r.finalStatus ?? r.status}`, ...(r.truncated ? { truncated: true } : {}) });
        continue;
      }
      const parsed = parseSitemapXml(r.body);
      const cut = r.truncated ? { truncated: true, error: `larger than ${Math.round(maxBody / 1048576)} MB: only the first ${Math.round(maxBody / 1048576)} MB were read` } : {};
      if (parsed.kind === 'invalid') {
        files.push({ url, status: r.finalStatus, kind: 'invalid', count: 0, error: parsed.error, ...(r.truncated ? { truncated: true } : {}) });
        continue;
      }
      if (parsed.kind === 'sitemapindex') {
        files.push({ url, status: r.finalStatus, kind: 'sitemapindex', count: parsed.children.length, ...cut });
        for (const c of parsed.children) next.push(c);
        continue;
      }
      files.push({ url, status: r.finalStatus, kind: 'urlset', count: parsed.urls.length, ...cut });
      for (const u of parsed.urls) entries.push(u.lastmod ? { url: u.loc, lastmod: u.lastmod, file: url } : { url: u.loc, file: url });
    }
    level = next;
  }
  return { rootUrls, files, entries };
}
