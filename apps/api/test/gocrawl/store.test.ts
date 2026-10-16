/** Server-side paging, search, filters, sorting and facets of crawl page rows (memory and file-backed stores agree). */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_AUDIT_TODO, auditPage, queryCrawlRows, type CrawledUrl } from '@sentinel/shared';
import { FileResultStore, MemoryResultStore } from '../../src/results/store';
import { tmpWork } from './goHelpers';

function rows(n: number): CrawledUrl[] {
  const out: CrawledUrl[] = [];
  for (let i = 0; i < n; i++) {
    const status = i % 50 === 0 ? 404 : i % 33 === 0 ? 301 : 200;
    out.push({
      url: `https://shop.example/products/p-${String(i).padStart(5, '0')}`, status, reason: 'full', responseMs: (i * 37) % 900, depth: i % 7,
      title: i % 10 === 0 ? 'Same title | Shop' : `Product ${i} | Shop`, metaDescription: i % 3 === 0 ? undefined : `About product ${i}`, h1: [`Product ${i}`],
      indexable: status === 200, internalLinks: 10 + (i % 5), imagesMissingAlt: i % 4 === 0 ? 1 : 0, crawlState: 'fetched', foundVia: i % 2 ? ['link'] : ['sitemap'], template: 'product', inlinks: i % 9,
    });
  }
  out.push({ url: 'https://shop.example/collections/a?sort_by=price', status: null, reason: 'full', crawlState: 'excluded', exclusionReason: 'sort_filter_search_parameter', template: 'collection' });
  return out;
}

describe('crawl result stores', () => {
  const data = rows(3000);
  const mem = new MemoryResultStore(data);
  const dir = path.join(tmpWork(), 'results');
  const file = new FileResultStore(dir);
  for (const r of data) file.add(r);
  file.seal();

  it('page, filter, search, sort and count the same way in memory and on disk', async () => {
    const queries = [
      { offset: 0, limit: 25 },
      { offset: 2990, limit: 50 },
      { status: '4xx' as const, limit: 500 },
      { problem: 'dup-title' as const, sort: 'url' as const, dir: 'desc' as const },
      { problem: 'no-meta' as const, sort: 'response' as const },
      { q: 'p-0012', limit: 100 },
      { crawlState: 'excluded' as const },
      { source: 'sitemap', sort: 'inlinks' as const, dir: 'desc' as const, limit: 10 },
      { indexable: 'no' as const, sort: 'status' as const },
    ];
    for (const q of queries) {
      const a = await mem.query(q);
      const b = await file.query(q);
      expect(b.total, JSON.stringify(q)).toBe(a.total);
      expect(b.rows.map((r) => r.url), JSON.stringify(q)).toEqual(a.rows.map((r) => r.url));
    }
    const all = await file.query({ limit: 25 });
    expect(all.total).toBe(3001);
    expect(all.facets.status['4xx']).toBe(60);
    expect(all.facets.crawlState.excluded).toBe(1);
    // Every 10th row shares one title; only rows answering 200 are compared.
    const dups = (await mem.query({ problem: 'dup-title' })).total;
    expect(dups).toBeGreaterThan(200);
    expect(all.facets.problem['dup-title']).toBe(dups);
    expect((await file.query({ status: '4xx' })).rows.every((r) => r.status === 404)).toBe(true);
    expect((await file.query({ limit: 100000 })).limit).toBe(500);
  });

  it('attaches issues when rows are read, and streams every row for export', async () => {
    const key = (u: string) => u;
    file.setIssues(new Map([[data[5].url, [{ id: 'ISS-1', checkId: 'ONP-META', title: 'x', severity: 'critical', summary: '' }]]]), key);
    const hit = (await file.query({ problem: 'issues' })).rows;
    expect(hit.map((r) => r.url)).toEqual([data[5].url]);
    expect(hit[0].topSeverity).toBe('critical');
    let n = 0;
    for await (const r of file.iterate()) { n++; void r; }
    expect(n).toBe(3001);
    expect(file.answeredUrls().size).toBe(3000);
  });

  it('removes its files when disposed', async () => {
    expect(fs.existsSync(path.join(dir, 'rows.ndjson'))).toBe(true);
    await file.dispose();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('audit scores and to-do checks agree in memory, on disk and with the shared page audit', async () => {
    const file = new FileResultStore(path.join(tmpWork(), 'audit-results'));
    for (const r of data) file.add(r);
    file.seal();
    const ref = queryCrawlRows(data, { limit: 1 });
    const a = await mem.query({ limit: 1 });
    const b = await file.query({ limit: 1 });
    expect(a.facets.score).toEqual(ref.facets.score);
    expect(b.facets.score).toEqual(ref.facets.score);
    expect(b.facets.check).toEqual(ref.facets.check);
    expect(Object.keys(b.facets.check ?? {}).length).toBeGreaterThan(4);
    for (const t of PAGE_AUDIT_TODO) {
      const q = { check: t.id, limit: 500, sort: 'url' as const };
      const x = await file.query(q);
      expect(x.total, t.id).toBe(ref.facets.check?.[t.id] ?? 0);
      expect(x.rows.map((r) => r.url), t.id).toEqual((await mem.query(q)).rows.map((r) => r.url));
    }
    for (const band of ['poor', 'fair', 'good', 'none'] as const) expect((await file.query({ score: band })).total, band).toBe(ref.facets.score?.[band] ?? 0);
    // The score on each row is the score of its full audit (duplicate flags included).
    const page = await file.query({ sort: 'score', dir: 'asc', limit: 200 });
    for (const r of page.rows) expect(r.auditScore ?? null, r.url).toBe(auditPage(r).score);
    const scores = page.rows.map((r) => r.auditScore ?? 1000);
    expect(scores).toEqual([...scores].sort((x, y) => x - y));
    expect(page.auditLimits?.titleMaxChars).toBe(60);
    expect(page.scoreSummary).toEqual(ref.scoreSummary);
    expect((await mem.query({ limit: 1 })).scoreSummary).toEqual(ref.scoreSummary);
    // Exports stream rows with the same crawl-wide fields as the page list.
    let k = 0;
    const listed = await file.query({ limit: 500 });
    for await (const r of file.iterate()) {
      if (k >= 500) break;
      expect({ s: r.auditScore, t: r.auditTodo, f: r.flags }, r.url).toEqual({ s: listed.rows[k].auditScore, t: listed.rows[k].auditTodo, f: listed.rows[k].flags });
      k++;
    }
    // Same-title pages: every 10th row shares "Same title | Shop" (only rows answering 200 count).
    const sameTitle = data.filter((r) => r.title === 'Same title | Shop' && r.status === 200).map((r) => r.url);
    for (const st of [file, mem]) {
      const d = await st.duplicatesOf(sameTitle[0]);
      expect(d.title.total).toBe(sameTitle.length - 1);
      expect(d.title.urls).toEqual(sameTitle.slice(1, 11));
      const one = await st.duplicatesOf(data[1].url);
      expect(one.title.total).toBe(0);
    }
    await file.dispose();
  });
});
