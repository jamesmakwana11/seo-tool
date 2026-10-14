import { load } from 'cheerio';
import type { HttpClient } from './http';
import type { SitemapEntry, SitemapFile, SitemapInfo } from './types';

export interface ParsedSitemapXml {
  kind: 'urlset' | 'sitemapindex' | 'invalid';
  urls: { loc: string; lastmod?: string }[];
  children: string[];
  error?: string;
}

export function parseSitemapXml(xml: string): ParsedSitemapXml {
  const text = xml.trim();
  if (!text.startsWith('<')) return { kind: 'invalid', urls: [], children: [], error: 'not XML' };
  const $ = load(text, { xml: true });
  if ($('sitemapindex').length) {
    const children = $('sitemapindex > sitemap > loc').toArray().map((e) => $(e).text().trim()).filter(Boolean);
    return { kind: 'sitemapindex', urls: [], children };
  }
  if ($('urlset').length) {
    const urls = $('urlset > url')
      .toArray()
      .map((u) => ({ loc: $(u).children('loc').first().text().trim(), lastmod: $(u).children('lastmod').first().text().trim() || undefined }))
      .filter((u) => u.loc);
    return { kind: 'urlset', urls, children: [] };
  }
  return { kind: 'invalid', urls: [], children: [], error: 'no <urlset> or <sitemapindex> root element' };
}

/** Fetch sitemap(s) (follows sitemap index children up to `maxFiles`). */
export async function fetchSitemaps(http: HttpClient, rootUrls: string[], maxFiles = 50): Promise<SitemapInfo> {
  const files: SitemapFile[] = [];
  const entries: SitemapEntry[] = [];
  const queue = [...new Set(rootUrls)];
  const seen = new Set<string>();
  while (queue.length && files.length < maxFiles) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await http.request(url, { headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' } });
    if (r.finalStatus !== 200 || r.body === undefined) {
      files.push({ url, status: r.finalStatus ?? r.status, kind: 'unreachable', count: 0, error: r.error ?? `HTTP ${r.finalStatus ?? r.status}` });
      continue;
    }
    const parsed = parseSitemapXml(r.body);
    if (parsed.kind === 'invalid') {
      files.push({ url, status: r.finalStatus, kind: 'invalid', count: 0, error: parsed.error });
      continue;
    }
    if (parsed.kind === 'sitemapindex') {
      files.push({ url, status: r.finalStatus, kind: 'sitemapindex', count: parsed.children.length });
      for (const c of parsed.children) queue.push(c);
      continue;
    }
    files.push({ url, status: r.finalStatus, kind: 'urlset', count: parsed.urls.length });
    for (const u of parsed.urls) entries.push({ url: u.loc, lastmod: u.lastmod, file: url });
  }
  return { rootUrls, files, entries };
}
