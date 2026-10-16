/**
 * Streaming analysis of a Go crawl (two passes over pages.ndjson.gz, bounded memory).
 *
 * Pass 1 — index: every page record is read once; a compact lite copy of each page is kept (see convert.ts), together
 *   with crawl-wide facts that need every page: internal inlinks (count + sample per target), which review texts repeat
 *   across pages, and — when the Rust text core is unavailable — template boilerplate.
 * Text core — text.json from the Rust process: duplicate title / meta / H1 groups, template boilerplate, unique words,
 *   exact duplicate copy, verified near-duplicate clusters (Jaccard of 4-word shingles; as written and H1-masked).
 * Pass 2 — batches: full pages are read again in batches; page-level analyzers run per batch with the crawl-wide view
 *   (GlobalView) answering every cross-page question, and their findings are merged per check (merge.ts). Page result
 *   rows are written to the file-backed result store as they are produced.
 * Whole-crawl analyzers — run once over the lite pages: status codes, redirects, sitemap, orphans, depth, host, HTTPS,
 *   robots, crawl budget, render-blocking / third-party scripts, homepage checklist, entity, E-E-A-T, duplicate content
 *   and the duplicate-cluster AI checks (AIC-01, AIC-08).
 *
 * Peak memory is the lite index (≈1–2 KB per page) + one batch of full pages + the merged findings, instead of every
 * full page at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CrawlCoverageReport, CrawledUrl, PageTemplate, PageTier } from '@sentinel/shared';
import { wordCount } from '@sentinel/shared';
import type { Finding, PreviousCrawlState } from '../services/ports';
import { ANALYZERS, NOT_EVALUATED, snapshotFromPages } from '../analysis/analyzers';
import { isIntentionalNoindex, isNoindex, isSelfCanonical, prepare, type AnalyzerResult, type GlobalView, type Prepared, type StatusInfo } from '../analysis/context';
import { duplicateGroups, UTILITY_PAGE } from '../analysis/technical';
import { reviewBodies } from '../analysis/contentAi';
import { hasType } from '../analysis/schema';
import { buildSitemapDiff, pageRows } from '../crawler/engine';
import type { LinkStatus, ParsedPage, SiteContext } from '../crawler/types';
import { isCollectionTagPage, normalizeUrl, pathOf, sameUrl, scopedProductCanonical, urlKey } from '../crawler/url';
import { FileResultStore } from '../results/store';
import { gzWriter, readNdjsonGz, type ReadStats } from './files';
import { auditLimitsFrom } from '@sentinel/shared';
import { SNAPSHOT_TEXT_CHARS, snapFromPage, snapFromRow } from '../changes/snapshot';
import { enrichLite, Interner, litePage, toParsedPage, type GoPage, type PageRecord, type UrlRecord } from './convert';
import { FindingMerger } from './merge';

/** Checks that compare pages across the whole crawl or read only site-level data: run once over the lite index. */
export const WHOLE_CRAWL_CHECKS = new Set([
  'TECH-ROBOTS', 'TECH-SITEMAP', 'TECH-ORPHAN', 'TECH-CRAWL-DEPTH', 'TECH-CRAWL-BUDGET', 'TECH-4XX', 'TECH-5XX', 'TECH-REDIRECTS', 'TECH-DISCONTINUED',
  'TECH-SHOPIFY-DUP-PATHS', 'TECH-DUPLICATE', 'TECH-HOST', 'TECH-HTTPS', 'TECH-PAGINATION', 'PERF-RENDER-BLOCKING', 'PERF-THIRD-PARTY', 'ONP-TPL-HOME',
  'AEO-ENTITY', 'AEO-AI-CRAWLERS', 'GEO-EEAT', 'AIC-01', 'AIC-08',
]);

const TEMPLATE_ORDER: PageTemplate[] = ['home', 'collection', 'product', 'blog_article', 'blog_index', 'page', 'search', 'other'];
const CONTENT_TEMPLATES = ['product', 'collection', 'blog_article', 'page'];
const LIST_LIMIT = 500;

interface TextJson {
  version: number;
  pages: number;
  unique: { ids: number[]; words: number[] };
  boilerplate: Record<string, string[]>;
  groups: Record<'titleExact' | 'titleBrand' | 'metaExact' | 'metaRaw' | 'h1Single' | 'h1First', number[][]>;
  exactContent: number[][];
  near: Record<'asWritten' | 'h1Masked' | 'descMasked', Record<string, number[][]>>;
  evidence: { a: number; b: number; jaccard: number; variant: string }[];
  stats: Record<string, unknown>;
}

export interface AnalyzeInput {
  workDir: string;
  resultsDir: string;
  ctx: SiteContext;
  tierOf: (url: string) => PageTier;
  textCore: { ok: boolean; error?: string };
  /** Write pages' main text to texts.ndjson.gz: true = every page (custom rules are enabled), a number = at most that many. */
  collectTexts?: boolean | number;
  /** Only build page rows (cancelled / failed crawls are never analysed). */
  rowsOnly?: boolean;
  /** Write the Change Monitor snapshot (default true). */
  snapshot?: boolean;
  batchSize?: number;
  onPhase?: (phase: 'analysing' | 'saving') => void;
  /** Called between batches (memory sampling, progress). */
  onBatch?: (pagesDone: number) => void;
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export interface AnalyzeOutput {
  findings: Finding[];
  evaluatedChecks: string[];
  evaluatedTemplates: Record<string, PageTemplate[]>;
  notEvaluated: Record<string, string>;
  sitemapDiff?: ReturnType<typeof buildSitemapDiff>;
  snapshot?: PreviousCrawlState;
  store: FileResultStore;
  coverage: CrawlCoverageReport;
  textsFile?: string;
  /** Compact per-URL snapshot for the Change Monitor (gzip NDJSON of SnapRec). */
  snapshotFile?: string;
  textsCount: number;
  pages: number;
  timings: Record<string, number>;
  readProblems: string[];
}

// ------------------------------------------------------------------------------------------------ helpers

/** 53-bit string hash (two FNV-1a passes) — keys for crawl-wide counts without keeping every text in memory. */
export function hash53(s: string): number {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a * 2 ** 21 + (b & 0x1fffff);
}

export const isOkPage = (p: ParsedPage) => !p.skippedByRobots && !p.budgetSample && !p.paginated && !p.scopedSample && p.status === 200 && p.chain.length === 0 && !!p.html;
const isContentPage = (p: ParsedPage, ctx: SiteContext) => isOkPage(p) && p.template !== 'search' && isSelfCanonical(p) && !isIntentionalNoindex(p.url, ctx);

function restrict(groups: string[][] | undefined, keep: (u: string) => boolean, min = 2): string[][] {
  const out: string[][] = [];
  for (const g of groups ?? []) {
    const k = g.filter(keep);
    if (k.length >= min) out.push(k);
  }
  return out;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// ------------------------------------------------------------------------------------------------ main

export async function analyzeGoCrawl(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const { workDir, ctx, tierOf } = input;
  const timings: Record<string, number> = {};
  const readProblems: string[] = [];
  const t0 = Date.now();
  const pagesFile = path.join(workDir, 'pages.ndjson.gz');
  const I = new Interner();
  // Live heap per phase (diagnostics). With --expose-gc (stress runs) a collection first makes it the live size.
  const heap = () => { (globalThis as { gc?: () => void }).gc?.(); return Math.round(process.memoryUsage().heapUsed / 1048576); };
  input.onPhase?.('analysing');

  // ---------------------------------------------------------------- text core results (written before analysis starts)
  let text: TextJson | undefined;
  let textProblem = input.textCore.ok ? undefined : `the Rust text core did not run (${input.textCore.error || 'not available'})`;
  if (input.textCore.ok && !input.rowsOnly) {
    try {
      text = JSON.parse(fs.readFileSync(path.join(workDir, 'text.json'), 'utf8')) as TextJson;
      if (text.version !== 1) { textProblem = `text.json version ${text.version} is not supported`; text = undefined; }
    } catch (e) {
      textProblem = `text.json could not be read: ${(e as Error).message}`;
    }
  }
  const rustBoiler = new Map<PageTemplate, Set<string>>();
  if (text) for (const [t, list] of Object.entries(text.boilerplate)) rustBoiler.set(t as PageTemplate, new Set(list));
  // Pages whose own text / links are kept as evidence for duplicate clusters: a few per cluster (text), and every member
  // of the doorway check's clusters (links) — those are content pages, collections and articles, never the catalogue.
  const enrichTextIds = new Set<number>();
  const doorwayIds = new Set<number>();
  if (text) {
    for (const [v, t] of [['asWritten', '0.9'], ['descMasked', '0.8'], ['h1Masked', '0.75']] as const) {
      for (const c of text.near[v]?.[t] ?? []) for (const id of c.slice(0, 12)) enrichTextIds.add(id);
    }
    for (const c of text.near.h1Masked?.['0.75'] ?? []) for (const id of c) doorwayIds.add(id);
  }
  const DOORWAY_TEMPLATES = new Set<PageTemplate>(['page', 'collection', 'blog_article', 'other']);
  const ABOUT = /\/pages\/(about|about-us|our-story|who-we-are)/i;
  const uniqueTextKept = new Map<string, string>();
  const rawBlocksKept = new Map<string, string[]>(); // fallback (no text core): about pages, unique text worked out later
  const uniqueOf = (p: ParsedPage, boiler: Set<string> | undefined) => p.html!.ownBlocks.filter((b) => !boiler || !boiler.has(b)).join('\n');

  // ---------------------------------------------------------------- pass 1: lite index + crawl-wide counts
  const lite: GoPage[] = [];
  const idxByUrl = new Map<string, number>();
  const idxById = new Map<number, number>();
  const inl = new Map<string, { n: number; s: string[] }>();
  const normCache = new Map<string, string>();
  const norm = (u: string) => {
    let v = normCache.get(u);
    if (v === undefined) { v = normalizeUrl(u); if (normCache.size < 300_000) normCache.set(u, v); }
    return v;
  };
  const reviews = new Map<number, string | { n: number; urls: string[]; text: string }>();
  const fbBlocks = new Map<PageTemplate, Map<number, { n: number; text?: string }>>();
  const fbOk = new Map<PageTemplate, number>();
  const needFallbackBoiler = !text;
  let doorwayLinks = 0;
  const s1: ReadStats = { lines: 0, badLines: 0 };
  if (!input.rowsOnly) {
    for await (const rec of readNdjsonGz<PageRecord>(pagesFile, s1)) {
      const p = toParsedPage(rec, tierOf);
      p.url = I.str(p.url);
      const ok = isOkPage(p);
      if (ok) {
        const self = urlKey(p.url);
        const seen = new Set<string>();
        for (const raw of p.html!.internalLinks) {
          const l0 = norm(raw);
          const sc = scopedProductCanonical(l0);
          for (const l of sc ? [l0, norm(sc)] : [l0]) {
            if (seen.has(l)) continue;
            seen.add(l);
            if (urlKey(l) === self) continue;
            const e = inl.get(l);
            if (e) { e.n++; if (e.s.length < 10) e.s.push(p.url); } else inl.set(l, { n: 1, s: [p.url] });
          }
        }
        if (needFallbackBoiler) {
          let m = fbBlocks.get(p.template);
          if (!m) { m = new Map(); fbBlocks.set(p.template, m); }
          fbOk.set(p.template, (fbOk.get(p.template) ?? 0) + 1);
          for (const b of new Set(p.html!.ownBlocks)) {
            const h = hash53(b);
            const e = m.get(h);
            if (e) { e.n++; e.text ??= b; } else m.set(h, { n: 1 });
          }
          if (ABOUT.test(pathOf(p.url))) rawBlocksKept.set(p.url, p.html!.ownBlocks.slice(0, 200));
        }
        if (isContentPage(p, ctx) && (hasType(p, 'Review', 'AggregateRating') || p.html!.reviews.hasVisible)) {
          for (const b of new Set(reviewBodies(p))) {
            const h = hash53(b);
            const e = reviews.get(h);
            if (e === undefined) reviews.set(h, p.url);
            else if (typeof e === 'string') { if (e !== p.url) reviews.set(h, { n: 2, urls: [e, p.url], text: b }); }
            else { e.n++; if (e.urls.length < 20) e.urls.push(p.url); }
          }
        }
      }
      const i = lite.length;
      const lp = p.template === 'home' ? p : litePage(p, I);
      // Clusters never mix templates: product clusters (often the whole catalogue) are not doorway candidates.
      const links = p.html !== undefined && doorwayIds.has(rec.id) && DOORWAY_TEMPLATES.has(p.template) && doorwayLinks < 5000;
      if (p.html && (links || enrichTextIds.has(rec.id))) {
        if (links) doorwayLinks++;
        if (lp !== p) enrichLite(lp, p, links);
        if (ok) uniqueTextKept.set(p.url, uniqueOf(p, rustBoiler.get(p.template)).slice(0, 4000));
      }
      lite.push(lp);
      if (!idxByUrl.has(p.url)) idxByUrl.set(p.url, i);
      idxById.set(rec.id, i);
      if ((i & 1023) === 1023) { input.onBatch?.(0); await tick(); }
    }
    if (s1.truncated) readProblems.push(`page results file ended early (${s1.truncated}); ${s1.lines} page records were read`);
    if (s1.badLines) readProblems.push(`${s1.badLines} unreadable page record(s) skipped`);
    for (const [k, v] of reviews) if (typeof v === 'string') reviews.delete(k);
    normCache.clear();
  }
  timings.indexMs = Date.now() - t0;
  timings.heapAfterIndexMB = heap();

  // ---------------------------------------------------------------- crawl-wide view
  const t1 = Date.now();
  const urlOfId = (id: number) => { const i = idxById.get(id); return i === undefined ? undefined : lite[i].url; };
  const toUrls = (groups: number[][] | undefined) => (groups ?? []).map((g) => g.map(urlOfId).filter((u): u is string => !!u)).filter((g) => g.length > 1);
  const rustWords = new Map<string, number>();
  if (text) for (let k = 0; k < text.unique.ids.length; k++) { const u = urlOfId(text.unique.ids[k]); if (u) rustWords.set(u, text.unique.words[k]); }

  // Template boilerplate: text core, else the Node fallback counted in pass 1 (same rule: ≥ 50% and ≥ 3 pages).
  const boilerplate = rustBoiler;
  if (!text && !input.rowsOnly) {
    for (const [t, m] of fbBlocks) {
      const n = fbOk.get(t) ?? 0;
      if (n < 3) continue;
      const min = Math.max(3, Math.ceil(n * 0.5));
      boilerplate.set(t, new Set([...m.values()].filter((e) => e.n >= min && e.text !== undefined).map((e) => e.text!)));
    }
  }
  fbBlocks.clear();
  const fallbackWords = new Map<string, number>();
  for (const [u, blocks] of rawBlocksKept) {
    const i = idxByUrl.get(u);
    const b = boilerplate.get(i === undefined ? 'page' : lite[i].template);
    const t = blocks.filter((x) => !b || !b.has(x)).join('\n');
    uniqueTextKept.set(u, t.slice(0, 4000));
    fallbackWords.set(u, wordCount(t));
  }
  rawBlocksKept.clear();

  // Inlinks by normalised URL, and by URL key (trailing-slash-insensitive) as the fallback — same as prepare().
  const inlByKey = new Map<string, { n: number; s: string[] }>();
  for (const [k, v] of inl) { const kk = urlKey(k); if (!inlByKey.has(kk)) inlByKey.set(kk, v); }
  const inlOf = (u: string) => inl.get(normalizeUrl(u)) ?? inlByKey.get(urlKey(u));

  // Page lists are released explicitly once used (they hold the lite pages, which are dropped before the batches).
  let content: GoPage[] = lite.filter((p) => isContentPage(p, ctx));
  const metaSet = new Set(content.filter((p) => !isNoindex(p).noindex).map((p) => p.url));
  const words = (u: string) => rustWords.get(u);
  const groupMap = (groups: string[][]) => { const m = new Map<string, string[]>(); for (const g of groups) for (const u of g) m.set(u, g); return m; };

  let titleDups: Map<string, string[]>;
  let metaDups: Map<string, string[]>;
  let h1Dups: Map<string, string[]>;
  let metaPages: GoPage[] = content.filter((p) => metaSet.has(p.url));
  if (text) {
    titleDups = groupMap(restrict(toUrls(text.groups.titleExact), (u) => metaSet.has(u)));
    metaDups = groupMap(restrict(toUrls(text.groups.metaExact), (u) => metaSet.has(u)));
    h1Dups = groupMap(restrict(toUrls(text.groups.h1Single), (u) => metaSet.has(u)));
  } else {
    titleDups = groupMap(duplicateGroups(metaPages, (p) => p.html!.title?.toLowerCase().trim() || undefined));
    metaDups = groupMap(duplicateGroups(metaPages, (p) => p.html!.metaDescription?.toLowerCase().trim() || undefined));
    h1Dups = groupMap(duplicateGroups(metaPages.filter((p) => p.template !== 'home'), (p) => (p.html!.h1s.length === 1 ? p.html!.h1s[0].toLowerCase() : undefined)));
  }
  const nearCache = new Map<string, string[][]>();
  const near = text
    ? (variant: 'asWritten' | 'h1Masked' | 'descMasked', t: number) => {
      const k = `${variant}:${t}`;
      let v = nearCache.get(k);
      if (!v) { v = toUrls(text!.near[variant]?.[String(t)]); nearCache.set(k, v); }
      return v;
    }
    : undefined;
  const qualityCands = new Set(content.filter((p) => CONTENT_TEMPLATES.includes(p.template) && !UTILITY_PAGE.test(pathOf(p.url)) && (words(p.url) ?? 0) >= 30).map((p) => p.url));
  const qualityDupUrls = near ? new Set(restrict(near('asWritten', 0.85), (u) => qualityCands.has(u)).flat()) : undefined;
  qualityCands.clear();
  let collectionDescDup: Map<string, string> | undefined;
  if (text) {
    const cols = new Set(content.filter((p) => p.template === 'collection' && !isCollectionTagPage(p.url) && !/\/collections\/?$/.test(pathOf(p.url)) && (words(p.url) ?? 0) >= 10).map((p) => p.url));
    collectionDescDup = new Map();
    for (const g of restrict(toUrls(text.exactContent), (u) => cols.has(u))) for (const u of g) collectionDescDup.set(u, g.find((x) => x !== u)!);
  }
  const dupGroups = text ? { title: toUrls(text.groups.titleBrand), meta: toUrls(text.groups.metaRaw), h1: toUrls(text.groups.h1First) } : undefined;
  content = [];
  metaPages = [];
  const reviewShare = (b: string) => {
    const e = reviews.get(hash53(b));
    return e && typeof e !== 'string' ? { pages: e.n, urls: e.urls } : undefined;
  };
  timings.textCoreReadMs = Date.now() - t1;
  timings.heapAfterTextCoreMB = heap();

  // ---------------------------------------------------------------- whole-crawl analyzers over the lite index
  const t2 = Date.now();
  const findings: Finding[] = [];
  const evaluatedChecks: string[] = [];
  const evaluatedTemplates: Record<string, PageTemplate[]> = {};
  const notEvaluated: Record<string, string> = {};
  const analyzerMs: Record<string, number> = {};
  let sitemapInvalid: { url: string; problem: string }[] = [];
  let snapshot: PreviousCrawlState | undefined;
  let sitemapDiff: ReturnType<typeof buildSitemapDiff> | undefined;
  const coverage = coverageBase();
  let budgetSamples: ParsedPage[] = [];
  if (!input.rowsOnly) await (async () => {
    const viewWithoutStatus: GlobalView = {
      inlinkCount: (u) => inlOf(u)?.n ?? 0, inlinkSamples: (u) => inlOf(u)?.s ?? [], boilerplate, titleDups, metaDups, h1Dups, dupGroups, qualityDupUrls, reviewShare,
      collectionDescDup, near: near as GlobalView['near'], nearUnavailable: textProblem,
      uniqueWordsOf: (u) => rustWords.get(u) ?? fallbackWords.get(u), uniqueTextOf: (u) => uniqueTextKept.get(u),
    };
    const base = prepare(lite, ctx, viewWithoutStatus);
    // A collection-scoped product path that was not fetched answers like its product page (Shopify serves both).
    const liteStatus = (u: string) => base.statusOf(u) ?? ((sc) => (sc ? base.statusOf(sc) : undefined))(scopedProductCanonical(u));
    const litePrep: Prepared = { ...base, statusOf: liteStatus, global: { ...viewWithoutStatus, statusOf: liteStatus, budgetSamples: base.budgetSamples } };
    budgetSamples = base.budgetSamples;
    for (const a of ANALYZERS) {
      if (!WHOLE_CRAWL_CHECKS.has(a.checkId)) continue;
      const ta = Date.now();
      let r: AnalyzerResult;
      try {
        r = a.run(litePrep);
      } catch (e) {
        notEvaluated[a.checkId] = `analyzer error: ${(e as Error).message}`;
        continue;
      } finally {
        analyzerMs[a.checkId] = Date.now() - ta;
      }
      if (a.checkId === 'TECH-SITEMAP') sitemapInvalid = (r as AnalyzerResult & { invalid?: { url: string; problem: string }[] }).invalid ?? [];
      if (!r.evaluated) { notEvaluated[a.checkId] = r.reason ?? 'not evaluable in this run'; continue; }
      evaluatedChecks.push(a.checkId);
      if (r.templates) evaluatedTemplates[a.checkId] = r.templates;
      for (const f of r.findings) { f.urls = [...new Set(f.urls)]; findings.push(f); }
    }
    snapshot = snapshotFromPages(lite, ctx, litePrep);
    sitemapDiff = buildSitemapDiff(lite, ctx, sitemapInvalid);
    fillCoverage(coverage, litePrep, lite, sitemapDiff, ctx, inlOf, titleDups, metaDups, (u) => { const i = idxByUrl.get(u); return i === undefined ? undefined : lite[i]; });
    if (text) {
      const exact = restrict(toUrls(text.exactContent), (u) => metaSet.has(u));
      coverage.duplicates.exactContent = { count: exact.length, groups: exact.slice(0, 200).map((g) => g.slice(0, 50)) };
      const nearGroups = restrict(near!('asWritten', 0.9), (u) => metaSet.has(u));
      coverage.duplicates.nearContent = { count: nearGroups.length, groups: nearGroups.slice(0, 200).map((g) => g.slice(0, 50)), threshold: 0.9 };
    } else coverage.note = `Exact and near-duplicate content were not compared: ${textProblem}.`;
  })();
  timings.wholeCrawlMs = Date.now() - t2;
  timings.heapAfterWholeCrawlMB = heap();

  // ---------------------------------------------------------------- release the lite index: batches only need statuses
  const status = compactStatus(lite, ctx, I);
  lite.length = 0;
  idxById.clear();
  idxByUrl.clear();
  nearCache.clear();
  rustWords.clear();
  uniqueTextKept.clear();
  I.dropValues();
  text = undefined;
  const G: GlobalView = {
    statusOf: status,
    inlinkCount: (u) => inlOf(u)?.n ?? 0,
    inlinkSamples: (u) => inlOf(u)?.s ?? [],
    boilerplate, titleDups, metaDups, h1Dups, qualityDupUrls, reviewShare, collectionDescDup, budgetSamples,
    nearUnavailable: textProblem,
  };
  timings.heapAfterReleaseMB = heap();

  // ---------------------------------------------------------------- pass 2: page checks in batches + page rows
  const t3 = Date.now();
  const store = new FileResultStore(input.resultsDir, auditLimitsFrom(ctx.thresholds));
  const merger = new FindingMerger();
  const batchAnalyzers = ANALYZERS.filter((a) => !WHOLE_CRAWL_CHECKS.has(a.checkId));
  const texts = input.collectTexts && !input.rowsOnly ? gzWriter(path.join(input.resultsDir, 'texts.ndjson.gz')) : undefined;
  // Change Monitor: one compact record per URL, written as the rows are made (never the whole crawl in memory).
  const snapshotFile = input.snapshot === false ? undefined : path.join(input.resultsDir, 'snapshot.ndjson.gz');
  const snaps = snapshotFile ? gzWriter(snapshotFile) : undefined;
  const textLimit = input.collectTexts === true ? Number.POSITIVE_INFINITY : typeof input.collectTexts === 'number' ? input.collectTexts : 0;
  let textsCount = 0;
  const lookup = (l: string) => {
    const s = G.statusOf!(l);
    return s ? { status: s.finalStatus ?? s.status, known: true } : { status: null, known: false };
  };
  const batchSize = input.batchSize ?? 250;
  let batch: GoPage[] = [];
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    const pages = batch;
    batch = [];
    let prep: Prepared | undefined;
    if (!input.rowsOnly) {
      prep = prepare(pages, ctx, G);
      for (const a of batchAnalyzers) {
        const ta = Date.now();
        try {
          merger.run(a.checkId, () => a.run(prep!));
        } catch (e) {
          merger.evaluated.set(a.checkId, { evaluated: false, templates: new Set(), hadTemplates: false, reason: `analyzer error: ${(e as Error).message}` });
        }
        analyzerMs[a.checkId] = (analyzerMs[a.checkId] ?? 0) + Date.now() - ta;
      }
    }
    const rows = pageRows(pages, ctx, input.rowsOnly ? undefined : lookup);
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      const row = rows[k];
      row.crawlState = p.skippedByRobots ? 'robots' : 'fetched';
      if (p.foundVia?.length) row.foundVia = p.foundVia;
      if (p.foundOn) row.foundOn = p.foundOn;
      row.template = p.template;
      if (!input.rowsOnly) row.inlinks = G.inlinkCount(p.url);
      if (p.html) {
        row.headings = p.html.headings.slice(0, 40).map((h) => ({ level: h.level, text: h.text.slice(0, 200) }));
        row.wordCount = p.html.wordCount;
        if (prep && isOkPage(p)) row.uniqueWords = prep.uniqueWords(p);
      }
      store.add(row);
      if (snaps) await snaps.write(snapFromPage(p, row, SNAPSHOT_TEXT_CHARS));
      if (texts && textsCount < textLimit && p.status === 200 && p.html?.mainText) {
        await texts.write({ url: p.url, template: p.template, text: p.html.mainText.slice(0, 50_000) });
        textsCount++;
      }
    }
    done += pages.length;
    input.onBatch?.(done);
    await tick();
  };
  const s2: ReadStats = { lines: 0, badLines: 0 };
  for await (const rec of readNdjsonGz<PageRecord>(pagesFile, s2)) {
    const p = toParsedPage(rec, tierOf);
    p.url = I.str(p.url);
    batch.push(p);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  if (input.rowsOnly) {
    if (s2.truncated) readProblems.push(`page results file ended early (${s2.truncated}); ${s2.lines} page records were read`);
    if (s2.badLines) readProblems.push(`${s2.badLines} unreadable page record(s) skipped`);
  }
  await texts?.close();
  timings.batchAnalysisMs = Date.now() - t3;
  timings.heapAfterBatchesMB = heap();

  // ---------------------------------------------------------------- URLs that were found but not fetched
  const t4 = Date.now();
  const s3: ReadStats = { lines: 0, badLines: 0 };
  for await (const u of readNdjsonGz<UrlRecord>(path.join(workDir, 'urls.ndjson.gz'), s3)) {
    for (const v of u.foundVia ?? []) coverage.foundVia[v] = (coverage.foundVia[v] ?? 0) + 1;
    if (u.inSitemap && u.state !== 'fetched') {
      coverage.sitemapNotCrawled.count++;
      if (coverage.sitemapNotCrawled.urls.length < LIST_LIMIT) coverage.sitemapNotCrawled.urls.push({ url: u.url, state: u.state, reason: u.reason || u.trap || undefined });
    }
    if (u.state === 'fetched' || u.state === 'robots') continue;
    const state: NonNullable<CrawledUrl['crawlState']> = u.state === 'excluded' || u.state === 'depth_limit' || u.state === 'page_limit' ? u.state : 'not_processed';
    if (state === 'not_processed') {
      coverage.notProcessed.count++;
      if (coverage.notProcessed.urls.length < LIST_LIMIT) coverage.notProcessed.urls.push({ url: u.url, state: u.state });
    }
    const row: CrawledUrl = {
      url: u.url, status: null, reason: (u.foundVia ?? []).length === 1 && u.foundVia![0] === 'sitemap' ? 'sitemap' : 'full', crawlState: state,
      exclusionReason: u.reason || (u.trap ? `crawl_trap: ${u.trap}` : undefined), foundVia: u.foundVia ?? undefined, foundOn: u.foundOn || undefined,
      template: u.template, inlinks: input.rowsOnly ? u.inlinks : G.inlinkCount(u.url) || u.inlinks, depth: u.depth, inSitemap: ctx.sitemap ? u.inSitemap : undefined,
      indexabilityReason: state === 'excluded' ? `Not crawled: ${u.reason ?? 'excluded'}` : state === 'depth_limit' ? 'Not crawled: beyond the depth limit' : state === 'page_limit' ? 'Not crawled: the page limit was reached' : 'Not crawled: the crawl stopped before this URL',
    };
    for (const k of Object.keys(row) as (keyof CrawledUrl)[]) if (row[k] === undefined) delete row[k];
    store.add(row);
    if (snaps) await snaps.write(snapFromRow(row));
  }
  await snaps?.close();
  if (s3.missing) readProblems.push('the URL coverage file is missing (the crawler stopped before writing it)');
  else if (s3.truncated) readProblems.push(`the URL coverage file ended early (${s3.truncated})`);
  store.seal();
  timings.coverageRowsMs = Date.now() - t4;

  if (input.rowsOnly) {
    coverage.note = 'This crawl was not analysed (cancelled or failed); duplicate and orphan reports need a finished crawl.';
    return { findings: [], evaluatedChecks: [], evaluatedTemplates: {}, notEvaluated: {}, store, coverage, snapshotFile, textsCount: 0, pages: s2.lines, timings, readProblems };
  }

  // ---------------------------------------------------------------- merge the page checks of every batch
  for (const a of ANALYZERS) {
    if (WHOLE_CRAWL_CHECKS.has(a.checkId)) continue;
    const e = merger.evaluated.get(a.checkId);
    if (!e || !e.evaluated) { notEvaluated[a.checkId] = e?.reason ?? 'no page in this crawl qualified for the check'; continue; }
    evaluatedChecks.push(a.checkId);
    if (e.hadTemplates) evaluatedTemplates[a.checkId] = [...e.templates].sort((x, y) => TEMPLATE_ORDER.indexOf(x) - TEMPLATE_ORDER.indexOf(y));
  }
  for (const f of merger.findings()) { f.urls = [...new Set(f.urls)]; findings.push(f); }
  for (const [k, v] of Object.entries(NOT_EVALUATED)) notEvaluated[k] ??= v;
  input.onPhase?.('saving');
  timings.analysisTotalMs = Date.now() - t0;
  const slow = Object.entries(analyzerMs).filter(([, ms]) => ms >= 500).sort((a, b) => b[1] - a[1]);
  input.log?.info({ pages: s2.lines, timings, slowAnalyzers: Object.fromEntries(slow) }, 'go crawl analysis finished');
  return {
    findings, evaluatedChecks, evaluatedTemplates, notEvaluated, sitemapDiff, snapshot, store, coverage,
    textsFile: texts ? path.join(input.resultsDir, 'texts.ndjson.gz') : undefined, snapshotFile, textsCount, pages: s2.lines, timings, readProblems,
  };
}

function coverageBase(): CrawlCoverageReport {
  return {
    available: true, counts: {}, excludedBy: {}, foundVia: {}, listLimit: LIST_LIMIT, sitemapNotCrawled: { count: 0, urls: [] },
    linkedNotInSitemap: { count: 0, urls: [] }, orphanCandidates: { count: 0, urls: [], evaluated: false }, failed: { count: 0, urls: [] }, redirects: { count: 0, urls: [] },
    variantGroups: { count: 0, groups: [] },
    duplicates: { titles: { count: 0, groups: [] }, metaDescriptions: { count: 0, groups: [] }, exactContent: { count: 0, groups: [] }, nearContent: { count: 0, groups: [], threshold: 0.9 } },
    notProcessed: { count: 0, urls: [] },
  };
}

/** The coverage report parts that need the page index (lists capped, counts exact). */
function fillCoverage(
  coverage: CrawlCoverageReport, prep: Prepared, lite: ParsedPage[], sitemapDiff: ReturnType<typeof buildSitemapDiff>, ctx: SiteContext,
  inlOf: (u: string) => { n: number } | undefined, titleDups: Map<string, string[]>, metaDups: Map<string, string[]>, pageOf: (u: string) => ParsedPage | undefined,
) {
  if (sitemapDiff) coverage.linkedNotInSitemap = { count: sitemapDiff.crawledNotInSitemap.length, urls: sitemapDiff.crawledNotInSitemap.slice(0, LIST_LIMIT) };
  const graphComplete = ctx.crawlType === 'full' && !ctx.bfsTruncated;
  const orphans = prep.indexable.filter((p) => p.template !== 'home' && p.inSitemap && (inlOf(p.url)?.n ?? 0) === 0).map((p) => p.url);
  coverage.orphanCandidates = {
    count: orphans.length, urls: orphans.slice(0, LIST_LIMIT), evaluated: graphComplete,
    note: graphComplete ? 'Indexable sitemap pages that no crawled page links to.' : 'The crawl did not follow every link (partial, smart or depth-limited), so a page without inlinks may simply be linked from a page that was not fetched.',
  };
  for (const p of prep.requested) {
    const st = p.chain.length ? p.finalStatus : p.status;
    if (p.status === null || (st !== null && st >= 400)) {
      coverage.failed.count++;
      if (coverage.failed.urls.length < LIST_LIMIT) coverage.failed.urls.push({ url: p.url, status: st, error: p.error });
    }
    if (p.chain.length) {
      coverage.redirects.count++;
      if (coverage.redirects.urls.length < LIST_LIMIT) coverage.redirects.urls.push({ url: p.url, status: p.status, finalUrl: p.finalUrl, hops: p.chain.length });
    }
  }
  const byFinal = new Map<string, string[]>();
  for (const p of prep.requested) if (p.chain.length && p.finalStatus !== null) { const k = normalizeUrl(p.finalUrl); const l = byFinal.get(k); if (l) l.push(p.url); else byFinal.set(k, [p.url]); }
  const byCanon = new Map<string, string[]>();
  for (const p of prep.ok) { const c = p.html!.canonicals[0]; if (c && !sameUrl(c, p.url)) { const k = normalizeUrl(c); const l = byCanon.get(k); if (l) l.push(p.url); else byCanon.set(k, [p.url]); } }
  const variants: CrawlCoverageReport['variantGroups']['groups'] = [];
  for (const [target, urls] of byFinal) if (urls.length > 1) variants.push({ target, urls: urls.slice(0, 50), kind: 'redirect' });
  for (const [target, urls] of byCanon) if (urls.length > 1) variants.push({ target, urls: urls.slice(0, 50), kind: 'canonical' });
  variants.sort((a, b) => b.urls.length - a.urls.length);
  coverage.variantGroups = { count: variants.length, groups: variants.slice(0, 200) };
  const groupsOf = (m: Map<string, string[]>, value: (u: string) => string) => {
    const seen = new Set<string[]>();
    const out: { value: string; urls: string[] }[] = [];
    for (const g of m.values()) if (!seen.has(g)) { seen.add(g); out.push({ value: value(g[0]), urls: g.slice(0, 50) }); }
    out.sort((a, b) => b.urls.length - a.urls.length);
    return { count: out.length, groups: out.slice(0, 200) };
  };
  coverage.duplicates.titles = groupsOf(titleDups, (u) => pageOf(u)?.html?.title ?? '');
  coverage.duplicates.metaDescriptions = groupsOf(metaDups, (u) => pageOf(u)?.html?.metaDescription ?? '');
  void lite;
}

/**
 * Status of every crawled URL and checked link target, as a compact lookup (no page objects): what page checks in a
 * batch need to judge links and canonicals to pages in other batches. Same order of lookups as prepare().
 */
function compactStatus(lite: ParsedPage[], ctx: SiteContext, I: Interner): (url: string) => StatusInfo | undefined {
  const derivedOf = new Map<string, ParsedPage>();
  for (const p of lite) if (p.derivedFrom && !derivedOf.has(p.derivedFrom)) derivedOf.set(p.derivedFrom, p);
  const byNorm = new Map<string, StatusInfo>();
  const byKey = new Map<string, StatusInfo>();
  for (const p of lite) {
    if (p.skippedByRobots) continue;
    const target = p.chain.length ? derivedOf.get(p.url) : p;
    const s: StatusInfo = {
      url: p.url, status: p.status, finalStatus: p.finalStatus, finalUrl: p.finalUrl, chain: p.chain, redirectLoop: p.redirectLoop, error: p.error,
      noindex: target ? isNoindex(target).noindex : undefined,
    };
    byNorm.set(I.str(normalizeUrl(p.url)), s);
    byKey.set(I.str(urlKey(p.url)), s);
  }
  const ltKey = new Map<string, StatusInfo>();
  const ltOf = (l: LinkStatus): StatusInfo => ({ url: l.url, status: l.status, finalStatus: l.finalStatus, finalUrl: l.finalUrl, chain: l.chain, redirectLoop: l.redirectLoop, error: l.error });
  for (const l of ctx.linkTargets.values()) { const k = urlKey(l.url); if (!ltKey.has(k)) ltKey.set(k, ltOf(l)); }
  const cache = new Map<string, StatusInfo | null>();
  const find = (url: string): StatusInfo | undefined => {
    const k = normalizeUrl(url);
    const hit = byNorm.get(k) ?? byKey.get(urlKey(url));
    if (hit) return hit;
    const l = ctx.linkTargets.get(k);
    return l ? ltOf(l) : ltKey.get(urlKey(url));
  };
  return (url: string) => {
    const c = cache.get(url);
    if (c !== undefined) return c ?? undefined;
    let s = find(url);
    if (!s) { const sc = scopedProductCanonical(url); if (sc) s = find(sc); }
    if (cache.size > 150_000) cache.clear();
    cache.set(url, s ?? null);
    return s;
  };
}
