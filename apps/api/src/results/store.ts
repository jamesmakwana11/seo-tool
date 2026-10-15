/**
 * Crawl page results with server-side search, filters, sorting and paging.
 *
 * Two implementations behind one interface:
 *  - MemoryResultStore: rows held in memory (built-in Node crawler, small runs, DEMO data);
 *  - FileResultStore: rows written once to `rows.ndjson` in the run's results directory, with only compact columns
 *    (typed arrays + URL and title strings) in memory; a page of rows is read back by byte offset. A 50,000-page crawl
 *    keeps a few MB in memory instead of every row.
 * Issues seen in the run are attached to rows when they are read (setIssues).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CrawlPageProblem, CrawlPagesQuery, CrawlPagesResponse, CrawlPageStatusGroup, CrawledUrl, CrawledUrlIssue, Severity } from '@sentinel/shared';

export interface CrawlResultStore {
  readonly kind: 'memory' | 'file';
  count(): number;
  query(q: CrawlPagesQuery): Promise<CrawlPagesResponse>;
  /** Every row (with issues) — callers must only use it for small runs or streaming exports. */
  forEach(fn: (row: CrawledUrl) => void | Promise<void>): Promise<void>;
  /** Every row, pulled one at a time (streaming exports: the reader's pace sets the read pace). */
  iterate(): AsyncIterable<CrawledUrl>;
  /** Rows when there are at most `max`, else undefined. */
  allIfSmall(max: number): Promise<CrawledUrl[] | undefined>;
  setIssues(map: Map<string, CrawledUrlIssue[]>, keyOf: (u: string) => string): void;
  /** URLs that answered (status not null) — used to decide which issues may auto-resolve. */
  answeredUrls(): Set<string>;
  dispose(): Promise<void>;
}

const STATUS_GROUPS: CrawlPageStatusGroup[] = ['2xx', '3xx', '4xx', '5xx', 'none', 'robots', 'not_fetched'];
const PROBLEMS: CrawlPageProblem[] = ['issues', 'broken', 'no-title', 'dup-title', 'no-meta', 'dup-meta', 'h1', 'alt', 'noindex'];
const STATES = ['fetched', 'robots', 'excluded', 'depth_limit', 'page_limit', 'not_processed'] as const;
const SOURCES = ['start', 'link', 'sitemap', 'pagination', 'redirect', 'seed'] as const;
const SEV_RANK: Record<Severity, number> = { critical: 3, medium: 2, low: 1 };

export const effStatus = (u: CrawledUrl): number | null | undefined => (u.redirects ? u.status : u.finalStatus ?? u.status);

export function statusGroupOf(u: CrawledUrl): CrawlPageStatusGroup {
  if (u.skippedByRobots || u.crawlState === 'robots') return 'robots';
  if (u.crawlState && u.crawlState !== 'fetched') return 'not_fetched';
  const s = effStatus(u);
  if (s === null || s === undefined) return 'none';
  return s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : '2xx';
}

const isHtmlRow = (u: CrawledUrl) => u.title !== undefined || u.h1 !== undefined;

/** Problem bits that depend on the row alone (duplicates and issues are added once all rows are known). */
function ownProblems(u: CrawledUrl): number {
  let b = 0;
  if (u.brokenLinks?.length) b |= 1 << PROBLEMS.indexOf('broken');
  if (isHtmlRow(u) && !u.title?.trim()) b |= 1 << PROBLEMS.indexOf('no-title');
  if (isHtmlRow(u) && !u.metaDescription?.trim()) b |= 1 << PROBLEMS.indexOf('no-meta');
  if (isHtmlRow(u) && (u.h1?.length ?? 0) !== 1) b |= 1 << PROBLEMS.indexOf('h1');
  if ((u.imagesMissingAlt ?? 0) > 0) b |= 1 << PROBLEMS.indexOf('alt');
  if (u.indexable === false) b |= 1 << PROBLEMS.indexOf('noindex');
  return b;
}

/** Compact, sortable columns for every row. */
class Columns {
  url: string[] = [];
  title: string[] = [];
  status = new Int16Array(1024);
  group = new Uint8Array(1024);
  indexable = new Int8Array(1024);
  problems = new Uint16Array(1024);
  state = new Uint8Array(1024);
  sources = new Uint8Array(1024);
  template: string[] = [];
  depth = new Int16Array(1024);
  response = new Int32Array(1024);
  links = new Int32Array(1024);
  inlinks = new Int32Array(1024);
  issues = new Int32Array(1024);
  severity = new Uint8Array(1024);
  n = 0;

  private grow() {
    const g = <T extends Int16Array | Uint8Array | Int8Array | Uint16Array | Int32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(a.length * 2);
      b.set(a);
      return b;
    };
    this.status = g(this.status); this.group = g(this.group); this.indexable = g(this.indexable); this.problems = g(this.problems);
    this.state = g(this.state); this.sources = g(this.sources); this.depth = g(this.depth); this.response = g(this.response);
    this.links = g(this.links); this.inlinks = g(this.inlinks); this.issues = g(this.issues); this.severity = g(this.severity);
  }

  add(u: CrawledUrl): number {
    if (this.n >= this.status.length) this.grow();
    const i = this.n++;
    this.url.push(u.url);
    this.title.push(u.title ?? '');
    const s = effStatus(u);
    this.status[i] = s === null || s === undefined ? -1 : s;
    this.group[i] = STATUS_GROUPS.indexOf(statusGroupOf(u));
    this.indexable[i] = u.indexable === undefined ? -1 : u.indexable ? 1 : 0;
    this.problems[i] = ownProblems(u);
    this.state[i] = u.crawlState ? STATES.indexOf(u.crawlState) + 1 : 1;
    let src = 0;
    for (const v of u.foundVia ?? []) {
      const k = SOURCES.indexOf(v as (typeof SOURCES)[number]);
      if (k >= 0) src |= 1 << k;
    }
    this.sources[i] = src;
    this.template.push(u.template ?? '');
    this.depth[i] = u.depth ?? (u.reason === 'sitemap' ? 999 : 998);
    this.response[i] = u.responseMs ?? -1;
    this.links[i] = u.internalLinks ?? -1;
    this.inlinks[i] = u.inlinks ?? -1;
    return i;
  }

  /** Duplicate titles / meta descriptions across 200 HTML rows (same rule as the Pages screen). */
  finishDuplicates(metaOf: (i: number) => string | undefined) {
    const titles = new Map<string, number>();
    const metas = new Map<string, number>();
    const tk: (string | undefined)[] = new Array(this.n);
    const mk: (string | undefined)[] = new Array(this.n);
    for (let i = 0; i < this.n; i++) {
      if (this.status[i] !== 200) continue;
      const t = this.title[i].trim().toLowerCase();
      if (t) { tk[i] = t; titles.set(t, (titles.get(t) ?? 0) + 1); }
      const m = metaOf(i)?.trim().toLowerCase();
      if (m) { mk[i] = m; metas.set(m, (metas.get(m) ?? 0) + 1); }
    }
    const dt = 1 << PROBLEMS.indexOf('dup-title');
    const dm = 1 << PROBLEMS.indexOf('dup-meta');
    for (let i = 0; i < this.n; i++) {
      if (tk[i] && (titles.get(tk[i]!) ?? 0) > 1) this.problems[i] |= dt;
      if (mk[i] && (metas.get(mk[i]!) ?? 0) > 1) this.problems[i] |= dm;
    }
  }

  facets(): CrawlPagesResponse['facets'] {
    const f: CrawlPagesResponse['facets'] = { status: {}, problem: {}, crawlState: {}, source: {}, template: {}, indexable: {} };
    const inc = (o: Record<string, number>, k: string) => { o[k] = (o[k] ?? 0) + 1; };
    for (let i = 0; i < this.n; i++) {
      inc(f.status, STATUS_GROUPS[this.group[i]]);
      for (let b = 0; b < PROBLEMS.length; b++) if (this.problems[i] & (1 << b)) inc(f.problem, PROBLEMS[b]);
      inc(f.crawlState, STATES[this.state[i] - 1] ?? 'fetched');
      for (let b = 0; b < SOURCES.length; b++) if (this.sources[i] & (1 << b)) inc(f.source, SOURCES[b]);
      if (this.template[i]) inc(f.template, this.template[i]);
      if (this.indexable[i] >= 0) inc(f.indexable, this.indexable[i] ? 'yes' : 'no');
    }
    return f;
  }

  select(q: CrawlPagesQuery): number[] {
    const needle = q.q?.trim().toLowerCase();
    const st = q.status ? STATUS_GROUPS.indexOf(q.status) : -1;
    const pb = q.problem ? 1 << PROBLEMS.indexOf(q.problem) : 0;
    const cs = q.crawlState ? STATES.indexOf(q.crawlState) + 1 : 0;
    const src = q.source ? 1 << SOURCES.indexOf(q.source as (typeof SOURCES)[number]) : 0;
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (st >= 0 && this.group[i] !== st) continue;
      if (q.indexable && this.indexable[i] !== (q.indexable === 'yes' ? 1 : 0)) continue;
      if (pb && !(this.problems[i] & pb)) continue;
      if (cs && this.state[i] !== cs) continue;
      if (src && !(this.sources[i] & src)) continue;
      if (q.template && this.template[i] !== q.template) continue;
      if (needle && !this.url[i].toLowerCase().includes(needle) && !this.title[i].toLowerCase().includes(needle)) continue;
      out.push(i);
    }
    const dir = q.dir === 'desc' ? -1 : 1;
    const by = q.sort;
    if (by) {
      const key: (i: number) => number | string =
        by === 'url' ? (i) => this.url[i] : by === 'title' ? (i) => this.title[i].toLowerCase() : by === 'status' ? (i) => (this.status[i] < 0 ? 999 : this.status[i])
          : by === 'depth' ? (i) => this.depth[i] : by === 'indexable' ? (i) => this.indexable[i] : by === 'issues' ? (i) => this.issues[i] * 10 + this.severity[i]
            : by === 'links' ? (i) => this.problems[i] & 1 ? 1e6 + this.links[i] : this.links[i] : by === 'inlinks' ? (i) => this.inlinks[i] : (i) => this.response[i];
      out.sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return (x < y ? -1 : x > y ? 1 : a - b) * dir;
      });
    }
    return out;
  }

  /** Problem names of row i (shown on the row: duplicates are only known over the whole crawl). */
  flagsOf(i: number): string[] {
    const out: string[] = [];
    for (let b = 0; b < PROBLEMS.length; b++) if (this.problems[i] & (1 << b)) out.push(PROBLEMS[b]);
    return out;
  }

  setIssues(map: Map<string, CrawledUrlIssue[]>, keyOf: (u: string) => string) {
    const ib = 1 << PROBLEMS.indexOf('issues');
    for (let i = 0; i < this.n; i++) {
      const list = map.get(keyOf(this.url[i]));
      this.issues[i] = list?.length ?? 0;
      this.severity[i] = list?.length ? Math.max(...list.map((x) => SEV_RANK[x.severity] ?? 0)) : 0;
      if (list?.length) this.problems[i] |= ib; else this.problems[i] &= ~ib;
    }
  }
}

const RANK_SEV: Record<number, Severity | undefined> = { 3: 'critical', 2: 'medium', 1: 'low' };
const SEV_ORDER: Record<Severity, number> = { critical: 0, medium: 1, low: 2 };

function withIssues(u: CrawledUrl, issues: Map<string, CrawledUrlIssue[]> | undefined, keyOf: (u: string) => string): CrawledUrl {
  const list = issues?.get(keyOf(u.url));
  if (!list?.length) return u.issues ? { ...u, issueCount: u.issues.length } : u;
  const sorted = [...list].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  return { ...u, issues: sorted, issueCount: sorted.length, topSeverity: sorted[0].severity };
}

function clampQuery(q: CrawlPagesQuery, total: number) {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(q.limit ?? 50)) || 50));
  const offset = Math.max(0, Math.min(Math.floor(Number(q.offset ?? 0)) || 0, Math.max(0, total)));
  return { limit, offset };
}

export class MemoryResultStore implements CrawlResultStore {
  readonly kind = 'memory' as const;
  private cols = new Columns();
  private issues?: Map<string, CrawledUrlIssue[]>;
  private keyOf: (u: string) => string = (u) => u;
  constructor(private rows: CrawledUrl[]) {
    for (const r of rows) this.cols.add(r);
    this.cols.finishDuplicates((i) => rows[i].metaDescription);
  }
  count() { return this.rows.length; }
  async query(q: CrawlPagesQuery): Promise<CrawlPagesResponse> {
    const idx = this.cols.select(q);
    const { limit, offset } = clampQuery(q, idx.length);
    return { total: idx.length, offset, limit, rows: idx.slice(offset, offset + limit).map((i) => ({ ...withIssues(this.rows[i], this.issues, this.keyOf), flags: this.cols.flagsOf(i) })), facets: this.cols.facets() };
  }
  async forEach(fn: (row: CrawledUrl) => void | Promise<void>) { for (const r of this.rows) await fn(withIssues(r, this.issues, this.keyOf)); }
  async *iterate() { for (const r of this.rows) yield withIssues(r, this.issues, this.keyOf); }
  async allIfSmall(max: number) { return this.rows.length <= max ? this.rows.map((r) => withIssues(r, this.issues, this.keyOf)) : undefined; }
  setIssues(map: Map<string, CrawledUrlIssue[]>, keyOf: (u: string) => string) { this.issues = map; this.keyOf = keyOf; this.cols.setIssues(map, keyOf); }
  answeredUrls() { return new Set(this.rows.filter((u) => u.status !== null).map((u) => u.url)); }
  async dispose() { /* nothing on disk */ }
}

/** Writes rows to disk as they are produced, then serves them by offset. */
export class FileResultStore implements CrawlResultStore {
  readonly kind = 'file' as const;
  private cols = new Columns();
  private offsets: number[] = [];
  private lengths: number[] = [];
  private metas: (string | undefined)[] = [];
  private answered = new Set<string>();
  private pos = 0;
  private fd: number | undefined;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private issues?: Map<string, CrawledUrlIssue[]>;
  private keyOf: (u: string) => string = (u) => u;
  readonly file: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'rows.ndjson');
    this.fd = fs.openSync(this.file, 'w');
  }

  add(u: CrawledUrl) {
    const b = Buffer.from(`${JSON.stringify(u)}\n`, 'utf8');
    this.offsets.push(this.pos);
    this.lengths.push(b.length);
    this.pos += b.length;
    this.pending.push(b);
    this.pendingBytes += b.length;
    if (this.pendingBytes > 1 << 20) this.flush();
    this.cols.add(u);
    this.metas.push(u.metaDescription && u.status !== null ? u.metaDescription.slice(0, 400) : undefined);
    if (u.status !== null && u.status !== undefined) this.answered.add(u.url);
  }

  private flush() {
    if (this.fd === undefined || !this.pending.length) return;
    fs.writeSync(this.fd, Buffer.concat(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Done writing: duplicates computed, file closed for writing. */
  seal() {
    this.flush();
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
    this.cols.finishDuplicates((i) => this.metas[i]);
    this.metas = [];
  }

  count() { return this.cols.n; }

  private async read(indices: number[]): Promise<CrawledUrl[]> {
    if (!indices.length) return [];
    const fh = await fsp.open(this.file, 'r');
    try {
      const out: CrawledUrl[] = [];
      for (const i of indices) {
        const buf = Buffer.allocUnsafe(this.lengths[i]);
        await fh.read(buf, 0, buf.length, this.offsets[i]);
        out.push({ ...withIssues(JSON.parse(buf.toString('utf8')) as CrawledUrl, this.issues, this.keyOf), flags: this.cols.flagsOf(i) });
      }
      return out;
    } finally {
      await fh.close();
    }
  }

  async query(q: CrawlPagesQuery): Promise<CrawlPagesResponse> {
    const idx = this.cols.select(q);
    const { limit, offset } = clampQuery(q, idx.length);
    return { total: idx.length, offset, limit, rows: await this.read(idx.slice(offset, offset + limit)), facets: this.cols.facets() };
  }

  async forEach(fn: (row: CrawledUrl) => void | Promise<void>) {
    for await (const row of this.iterate()) await fn(row);
  }

  async *iterate(): AsyncGenerator<CrawledUrl> {
    const stream = fs.createReadStream(this.file, { encoding: 'utf8', highWaterMark: 1 << 18 });
    let rest = '';
    try {
      for await (const chunk of stream) {
        const parts = (rest + chunk).split('\n');
        rest = parts.pop() ?? '';
        for (const line of parts) if (line) yield withIssues(JSON.parse(line) as CrawledUrl, this.issues, this.keyOf);
      }
      if (rest.trim()) yield withIssues(JSON.parse(rest) as CrawledUrl, this.issues, this.keyOf);
    } finally {
      stream.destroy();
    }
  }

  async allIfSmall(max: number) {
    if (this.cols.n > max) return undefined;
    const rows: CrawledUrl[] = [];
    await this.forEach((r) => { rows.push(r); });
    return rows;
  }

  setIssues(map: Map<string, CrawledUrlIssue[]>, keyOf: (u: string) => string) { this.issues = map; this.keyOf = keyOf; this.cols.setIssues(map, keyOf); }
  answeredUrls() { return this.answered; }
  async dispose() {
    if (this.fd !== undefined) { try { fs.closeSync(this.fd); } catch { /* closed */ } this.fd = undefined; }
    await fsp.rm(this.dir, { recursive: true, force: true });
  }
}

export { RANK_SEV };
