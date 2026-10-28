/**
 * Bulk SEO fixes and the SEO Optimization lists (Titles, Meta descriptions, H1 headings, Image alt text, Tags).
 *
 * A bulk fix is one job per website:
 *  1. scan — the crawl's rows are streamed (never all in memory) and each page's title tag, meta description, H1,
 *     image alt text and broken links are assessed; or the open issues are mapped to the fields they concern;
 *  2. plan — each page with a problem is matched to its Shopify product / collection / page / article and the
 *     editor's suggestions are kept only for fields that need work (good values are left alone). Wording changes are
 *     listed for review (not selected); what cannot be changed through the Admin API is listed with the reason;
 *  3. review — the person excludes pages or fields; nothing is written before they apply;
 *  4. apply — resources one at a time (Shopify rate limits handled by the client), each through the editor's apply:
 *     live values read first (conflicts never written), written, read back, storefront page checked;
 *  5. refresh — fixed pages are fetched again and their page score recorded; an issue is closed only when the
 *     reverifier re-checks all its URLs with 0 failing.
 * Progress is reported and the job can be cancelled between resources.
 */
import {
  assessSeoField, CHECKS_BY_ID, isIssueOpen, SEO_BULK_FIELD_LABELS, SEO_OPTIMIZATION_FIELDS, SEO_PROBLEM_LABELS, seoGuidelinesFrom,
  type CrawledUrl, type CrawlPagesQuery, type FieldAssessment, type Issue, type SeoBulkChange, type SeoBulkField, type SeoBulkIssueCheck, type SeoBulkItem,
  type SeoBulkItemsPage, type SeoBulkJob, type SeoBulkManual, type SeoBulkStartInput, type SeoGuidelines, type SeoOptimizationField,
  type SeoOptimizationPage, type SeoOptimizationQuery, type SeoOptimizationRow, type ShopifyDraft, type ShopifyFieldDraft, type ShopifyFieldValidation,
} from '@sentinel/shared';
import { parseHtml } from '../crawler/parse';
import { hostOf } from '../crawler/url';
import { badRequest, conflict, ApiError } from '../lib/errors';
import { randomToken } from '../lib/passwords';
import { audit, type Actor, type Ctx } from '../services/context';
import type { AdminClient } from './client';
import { suggestTags } from './drafts';
import { listResources, parseStorefrontPath, type ShopifyResource } from './resources';

/** What the bulk fixer needs from the rest of the server (wired in the container). */
export interface SeoOpsDeps {
  rowsOf: (runId?: string) => Promise<{ run: { id: string; startedAt?: string }; total: number; rows: AsyncIterable<CrawledUrl> } | undefined>;
  filteredRows: (runId: string | undefined, q: CrawlPagesQuery, max: number) => Promise<{ run: { id: string }; rows: CrawledUrl[]; total: number } | undefined>;
  recordRecheck: (url: string, fresh: Partial<CrawledUrl>) => Promise<{ before: number | null; after: number | null } | undefined>;
  markChanged: (urls: string[]) => Promise<void>;
  confirmIssueFixed: (actor: Actor, issueId: string, check: { checkedUrls: number; details: string }) => Promise<Issue | undefined>;
}

/** The Shopify service's internals the bulk fixer reuses (one implementation of reading, suggesting and writing). */
export interface BulkHelpers {
  ctx: Ctx;
  requireEditable(): Promise<void>;
  connected(): boolean;
  call<T>(fn: (c: AdminClient) => Promise<T>): Promise<T>;
  client(): AdminClient;
  resolveUrl(url: string): Promise<{ res?: ShopifyResource; problem?: string }>;
  fetchById(c: AdminClient, kind: ShopifyResource['kind'], id: string): Promise<ShopifyResource | undefined>;
  buildDraft(actor: Actor, res: ShopifyResource, url: string | undefined, opts?: { crawlRow?: CrawledUrl }): Promise<ShopifyDraft>;
  validate(d: ShopifyDraft, f: ShopifyFieldDraft, value: string): Promise<ShopifyFieldValidation>;
  applyOne(d: ShopifyDraft, c: AdminClient, actor: Actor): Promise<ShopifyDraft>;
  lock(): boolean;
  unlock(): void;
  siteBase(): Promise<string>;
  latestRow(url: string): Promise<{ row: CrawledUrl } | undefined>;
  fetchPage(url: string): Promise<ReturnType<typeof parseHtml> | undefined>;
  shop(): string | undefined;
}

/** Pages planned per job (a larger site is fixed in several runs; the job says so). */
export const BULK_PAGE_CAP = 2000;
const PLAN_CONCURRENCY = 3;
const APPLY_BATCH = 10;
/** Checks whose findings map to fields the editor can write. */
const CHECK_FIELDS: Record<string, SeoBulkField[]> = { 'ONP-TITLE': ['seoTitle'], 'ONP-META': ['seoDescription'], 'ONP-H1': ['h1'], 'ONP-IMAGES': ['imageAlt'], 'TECH-BROKEN-INTERNAL': ['links'] };
const ALL_FIELDS: SeoBulkField[] = ['seoTitle', 'seoDescription', 'h1', 'imageAlt', 'links', 'title', 'tags'];

const norm = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const urlKey = (u: string) => { try { const x = new URL(u); x.hash = ''; let s = x.toString(); if (x.pathname !== '/' && s.endsWith('/') && !x.search) s = s.slice(0, -1); return s.toLowerCase(); } catch { return u.toLowerCase(); } };
const isPage = (r: CrawledUrl) => (r.crawlState ?? 'fetched') === 'fetched' && (r.redirects ? r.finalStatus : r.status) === 200 && (r.title !== undefined || r.h1 !== undefined);
const problemText = (a: FieldAssessment) => a.problems.filter((p) => p.severity !== 'note').map((p) => SEO_PROBLEM_LABELS[p.code]);

/** Why a crawled URL cannot be fixed through the Admin API (undefined = it can). */
export function manualReasonFor(url: string): string | undefined {
  let path = '/';
  let search = '';
  try { const u = new URL(url); path = u.pathname; search = u.search; } catch { return 'Not a valid URL.'; }
  if (path === '/' || path === '') return 'Homepage: its title and meta description are set in Shopify (Online Store → Preferences) and its H1 / images in the theme — the Admin API cannot change them.';
  if (/[?&]page=\d+/.test(search) || /[?&](filter|sort_by)/.test(search)) return 'Paginated or filtered URL: it shows the collection’s values — fix the collection itself.';
  if (!parseStorefrontPath(url)) return 'Not a product, collection, page or article (a theme, search, cart or app page) — fix it in the theme or the app.';
  return undefined;
}

/** Crawl-level assessment of one field of one page (what the storefront shows). */
export function assessRow(field: SeoBulkField, r: CrawledUrl, g: SeoGuidelines): FieldAssessment | undefined {
  const flags = new Set(r.flags ?? []);
  const pageType = r.template ?? undefined;
  switch (field) {
    case 'seoTitle': return assessSeoField('seoTitle', r.title ?? '', { guidelines: g, pageType, duplicate: flags.has('dup-title') });
    case 'seoDescription': return assessSeoField('seoDescription', r.metaDescription ?? '', { guidelines: g, pageType, duplicate: flags.has('dup-meta'), title: r.title });
    case 'h1': return assessSeoField('h1', r.h1?.[0] ?? '', { guidelines: g, pageType, h1Count: r.h1?.length ?? 0, duplicate: flags.has('dup-h1') });
    case 'imageAlt': {
      const missing = r.imagesMissingAlt ?? 0;
      return missing > 0
        ? { verdict: 'fix', length: missing, problems: [{ code: 'missing', severity: 'fix', message: `${missing} of ${r.images ?? missing} image(s) without alt text.` }] }
        : { verdict: 'good', length: 0, problems: [] };
    }
    case 'links': {
      const n = r.brokenLinks?.length ?? 0;
      return n ? { verdict: 'fix', length: n, problems: [{ code: 'missing', severity: 'fix', message: `${n} internal link(s) to pages that do not answer 200.` }] } : { verdict: 'good', length: 0, problems: [] };
    }
    default: return undefined;
  }
}

/** Which bulk field a draft field belongs to. bodyHtml: the H1 demotion (h1) — links are planned separately. */
function bulkFieldOf(key: string): SeoBulkField | undefined {
  if (key === 'seoTitle' || key === 'seoDescription' || key === 'title' || key === 'h1' || key === 'tags') return key;
  if (key.startsWith('imageAlt:')) return 'imageAlt';
  if (key === 'bodyHtml') return 'h1';
  return undefined;
}

interface Candidate { url: string; row?: CrawledUrl; fields: Set<SeoBulkField>; issueIds: Set<string> }

export function createBulkFixer(h: BulkHelpers, deps: SeoOpsDeps | undefined) {
  const { ctx } = h;
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();
  let job: SeoBulkJob | undefined;
  let items: SeoBulkItem[] = [];
  let running: Promise<void> | undefined;

  const guidelines = async () => seoGuidelinesFrom((await r.config.get()).thresholds);
  const touch = (p?: Partial<SeoBulkJob['progress']>) => { if (job) { if (p) job.progress = { ...job.progress, ...p }; job.updatedAt = iso(); } };

  function addManual(m: Omit<SeoBulkManual, 'count' | 'urls'> & { url?: string; count?: number }) {
    if (!job) return;
    const same = job.manual.find((x) => x.reason === m.reason && x.issueId === m.issueId && x.field === m.field && x.detail === m.detail);
    if (same) {
      same.count += m.count ?? 1;
      if (m.url && same.urls.length < 20 && !same.urls.includes(m.url)) same.urls.push(m.url);
      return;
    }
    if (job.manual.length >= 300) return;
    job.manual.push({ reason: m.reason, detail: m.detail, count: m.count ?? 1, urls: m.url ? [m.url] : [], ...(m.issueId ? { issueId: m.issueId } : {}), ...(m.field ? { field: m.field } : {}), ...(m.suggestion ? { suggestion: m.suggestion } : {}) });
  }

  function summarize() {
    if (!job) return;
    const byField: SeoBulkJob['summary']['byField'] = {};
    let changes = 0; let sel = 0; let selPages = 0; let review = 0;
    for (const it of items) {
      const seen = new Set<SeoBulkField>();
      let any = false;
      for (const c of it.changes) {
        changes++;
        const b = (byField[c.field] ??= { pages: 0, changes: 0 });
        b.changes++;
        if (!seen.has(c.field)) { b.pages++; seen.add(c.field); }
        if (c.confidence === 'review') review++;
        if (it.included && c.included) { sel++; any = true; }
      }
      if (any) selPages++;
    }
    job.summary = { pages: items.length, changes, selectedPages: selPages, selectedChanges: sel, reviewChanges: review, byField, manual: job.manual.reduce((n, m) => n + m.count, 0) };
  }

  // ------------------------------------------------------------------------------------------------ scan

  async function collectCandidates(input: SeoBulkStartInput, fields: SeoBulkField[], g: SeoGuidelines): Promise<Candidate[]> {
    const out = new Map<string, Candidate>();
    const want = new Set(fields);
    const add = (url: string, f: SeoBulkField[], row?: CrawledUrl, issueId?: string) => {
      const k = urlKey(url);
      let c = out.get(k);
      if (!c) {
        if (out.size >= BULK_PAGE_CAP) { job!.scan.capped = true; return; }
        c = { url, row, fields: new Set(), issueIds: new Set() };
        out.set(k, c);
      }
      for (const x of f) c.fields.add(x);
      if (row && !c.row) c.row = row;
      if (issueId) c.issueIds.add(issueId);
    };
    if (input.scope === 'issues') {
      const all = (await r.issues.list()).filter((i) => i.source === 'live' && !i.isTemplateGroup && isIssueOpen(i.status) && i.status !== 'SUPERSEDED');
      const chosen = input.issueIds?.length ? all.filter((i) => input.issueIds!.includes(i.id)) : all;
      job!.progress.total = chosen.length;
      for (const i of chosen) {
        job!.scan.pagesScanned++;
        const mapped = (CHECK_FIELDS[i.checkId] ?? []).filter((f) => want.has(f));
        const imagesNotAlt = i.checkId === 'ONP-IMAGES' && !/\balt\b/i.test(`${i.title} ${i.summary}`);
        if (!mapped.length || imagesNotAlt) {
          const check = CHECKS_BY_ID[i.checkId];
          addManual({ reason: manualReasonForCheck(i.checkId), detail: `${i.title}${check ? ` (${check.name})` : ''}`, issueId: i.id, count: i.affectedCount || 1 });
          continue;
        }
        for (const u of i.affectedUrls.slice(0, BULK_PAGE_CAP)) {
          const why = manualReasonFor(u);
          if (why) { addManual({ reason: why, detail: i.title, issueId: i.id, url: u, field: mapped[0] }); continue; }
          add(u, mapped, undefined, i.id);
        }
        touch({ done: job!.scan.pagesScanned });
      }
      // The crawl row of each page (H1s, broken links) — one streamed pass over the latest crawl.
      if (out.size && deps) {
        const src = await deps.rowsOf(input.runId);
        if (src) for await (const row of src.rows) { const c = out.get(urlKey(row.url)); if (c && !c.row) c.row = row; }
      }
      return [...out.values()];
    }
    if (input.scope === 'urls') {
      const urls = [...new Set((input.urls ?? []).map(String))].slice(0, BULK_PAGE_CAP);
      if (!urls.length) throw badRequest('Choose at least one page.');
      const want2 = new Set(urls.map(urlKey));
      if (deps) {
        const src = await deps.rowsOf(input.runId);
        if (src) for await (const row of src.rows) if (want2.has(urlKey(row.url))) add(row.url, fields, row);
      }
      for (const u of urls) {
        const why = manualReasonFor(u);
        if (why) { out.delete(urlKey(u)); addManual({ reason: why, detail: 'Selected page', url: u }); continue; }
        if (!out.has(urlKey(u))) add(u, fields);
      }
      job!.scan.pagesScanned = urls.length;
      return [...out.values()];
    }
    // pages: every page of the crawl (streamed), or only those matching the All-pages filters
    if (!deps) throw new ApiError(409, 'NO_CRAWL', 'Crawl data is not available on this server.');
    const filtered = input.filter ? await deps.filteredRows(input.runId, { ...input.filter, offset: 0 }, BULK_PAGE_CAP) : undefined;
    const src = filtered ? { run: filtered.run, total: filtered.rows.length, rows: (async function* () { yield* filtered.rows; })() } : await deps.rowsOf(input.runId);
    if (!src) throw new ApiError(409, 'NO_CRAWL', 'No finished crawl of this website yet. Run a crawl first — bulk fixes start from its pages.');
    if (filtered && filtered.total > filtered.rows.length) job!.scan.capped = true;
    job!.runId = src.run.id;
    job!.progress.total = src.total;
    for await (const row of src.rows) {
      job!.scan.pagesScanned++;
      if (job!.scan.pagesScanned % 200 === 0) touch({ done: job!.scan.pagesScanned });
      if (job!.cancelRequested) break;
      if (!isPage(row)) continue;
      const bad = fields.filter((f) => { const a = assessRow(f, row, g); return a && a.verdict !== 'good'; });
      if (!bad.length) continue;
      const why = manualReasonFor(row.url);
      if (why) { addManual({ reason: why, detail: bad.map((f) => SEO_BULK_FIELD_LABELS[f]).join(', '), url: row.url }); continue; }
      // Title and tags are not visible in the crawl: judged for pages planned anyway.
      add(row.url, [...bad, ...fields.filter((f) => f === 'title' || f === 'tags')], row);
    }
    return [...out.values()];
  }

  function manualReasonForCheck(checkId: string): string {
    if (/SCHEMA|RICH|^AEO-|ENTITY|ONP-TPL|ONP-BREADCRUMBS|ONP-OG|TECH-CANONICAL|TECH-PAGINATION|TECH-HREFLANG|TECH-JS/.test(checkId)) return 'Theme code or app settings: not something the Admin API can change safely — fix it in the theme (with a reviewed theme change) or the app.';
    if (/^AIC-|YMYL|REVIEW|COMPLIANCE/i.test(checkId) || CHECKS_BY_ID[checkId]?.module === 'ai_compliance') return 'Needs a person: content claims and reviews must be checked against real sources before anything changes.';
    if (/^TECH-(4XX|5XX|REDIRECTS|DISCONTINUED|ROBOTS|SITEMAP|HOST|HTTPS|INDEX|NOINDEX|ORPHAN|CRAWL|DUPLICATE|THIN|MOBILE)/.test(checkId)) return 'Site configuration, redirects or content work: not a field the SEO editor writes.';
    return 'Not supported by bulk fixes: needs a decision by a person.';
  }

  /** Planned link replacements in the content HTML: broken internal links whose target now redirects to a working page. */
  async function planLinks(res: ShopifyResource, row: CrawledUrl, url: string): Promise<{ html?: string; fixed: string[] }> {
    const details = row.brokenLinkDetails ?? (row.brokenLinks ?? []).map((u) => ({ url: u, status: undefined as number | null | undefined }));
    let html = res.bodyHtml;
    const fixed: string[] = [];
    const base = await h.siteBase();
    for (const l of details.slice(0, 30)) {
      let path = l.url;
      try { const u = new URL(l.url); path = u.pathname + u.search; } catch { /* keep */ }
      const inBody = html.includes(`"${l.url}"`) || html.includes(`'${l.url}'`) || html.includes(`"${path}"`) || html.includes(`'${path}'`);
      if (!inBody) { addManual({ reason: 'Broken link outside the page content: it is in the theme or a menu (Online Store → Navigation) — fix it there.', detail: l.url, url, field: 'links' }); continue; }
      const target = await h.latestRow(l.url).catch(() => undefined);
      const t = target?.row;
      const final = t?.redirects && t.finalStatus === 200 && t.finalUrl && base && hostOf(t.finalUrl).replace(/^www\./, '') === hostOf(base).replace(/^www\./, '') ? t.finalUrl : undefined;
      if (!final) { addManual({ reason: 'Broken link in the content with no working replacement known: choose the page it should point to, or remove the link.', detail: `${l.url} answers ${t?.status ?? l.status ?? 'nothing'}`, url, field: 'links' }); continue; }
      let finalPath = final;
      try { const u = new URL(final); finalPath = u.pathname + u.search; } catch { /* keep */ }
      for (const from of [l.url, path]) for (const q of ['"', "'"]) html = html.split(`href=${q}${from}${q}`).join(`href=${q}${finalPath}${q}`);
      fixed.push(`${path} → ${finalPath}`);
    }
    return { html: fixed.length ? html : undefined, fixed };
  }

  async function planOne(actor: Actor, c: Candidate, scope: SeoBulkStartInput['scope']): Promise<void> {
    const found = await h.resolveUrl(c.url).catch((e: Error) => ({ problem: e.message, res: undefined }));
    if (!found.res) { addManual({ reason: 'Not found in Shopify: the URL may redirect, be deleted, or belong to an app.', detail: found.problem ?? '', url: c.url }); return; }
    const res = found.res;
    const d = await h.buildDraft(actor, res, c.url, { crawlRow: c.row });
    const changes: SeoBulkChange[] = [];
    const keys = new Set<string>();
    const h1Src = d.h1.sources[0]?.source;
    for (const f of d.fields) {
      let field = bulkFieldOf(f.key);
      if (!field || !c.fields.has(field)) continue;
      // The H1 printed from the title is the title in Shopify: one change on the title field.
      let key = f.key;
      if (f.key === 'h1' && h1Src === 'title') key = 'title';
      if (f.key === 'h1' && (f.applyVia === 'theme' || !h1Src)) {
        if (f.suggestion && !f.suggestion.keep && f.assessment?.verdict !== 'good') addManual({ reason: 'H1 printed by the theme: change it with a reviewed theme change (SEO editor → H1 → Change in theme).', detail: `“${f.current || '(no H1)'}”`, url: c.url, field: 'h1', suggestion: f.suggestion.value !== f.current ? f.suggestion.value : undefined });
        continue;
      }
      const s = f.key === 'h1' && h1Src === 'title' ? d.fields.find((x) => x.key === 'title')?.suggestion : f.key === 'bodyHtml' ? (f.source === 'suggested' ? { value: f.proposed, reason: f.reason, keep: false, confidence: 'high' as const } : undefined) : f.suggestion;
      if (!s || s.keep) continue; // good value: left unchanged
      if (keys.has(key)) continue;
      if (norm(s.value) === norm(f.key === 'h1' && h1Src === 'title' ? d.fields.find((x) => x.key === 'title')!.current : f.current)) {
        addManual({ reason: 'Needs a person: no safe automatic rewrite.', detail: s.reason, url: c.url, field });
        continue;
      }
      const target = key === f.key ? f : d.fields.find((x) => x.key === key)!;
      const v = await h.validate(d, target, s.value);
      if (!v.ok) { addManual({ reason: `Cannot be written: ${v.errors[0]}`, detail: target.label, url: c.url, field }); continue; }
      if (key === 'title' && f.key === 'h1') field = 'h1';
      keys.add(key);
      changes.push({
        key, field, label: key === 'title' && f.key === 'h1' ? 'H1 heading (the theme prints the title)' : key === 'bodyHtml' ? 'Extra H1 in the content → H2' : target.label, current: target.current, proposed: s.value, reason: s.reason,
        problems: problemText(f.assessment ?? { verdict: 'good', problems: [], length: 0 }), included: s.confidence === 'high', confidence: s.confidence,
      });
    }
    if (c.fields.has('links') && c.row && (c.row.brokenLinks?.length ?? 0) > 0) {
      const body = changes.find((x) => x.key === 'bodyHtml');
      const plan = await planLinks({ ...res, bodyHtml: body?.proposed ?? res.bodyHtml }, c.row, c.url);
      if (plan.html) {
        if (body) { body.proposed = plan.html; body.reason += ` Broken links replaced: ${plan.fixed.join(', ')}.`; body.field = 'links'; }
        else changes.push({ key: 'bodyHtml', field: 'links', label: d.fields.find((x) => x.key === 'bodyHtml')?.label ?? 'Description', current: res.bodyHtml, proposed: plan.html, reason: `Links to redirected pages now point to the final page: ${plan.fixed.join(', ')}.`, problems: ['Broken internal links'], included: true, confidence: 'high' });
      }
    }
    if (!changes.length) return;
    items.push({
      url: c.url, title: res.title, pageType: res.kind, kind: res.kind, resourceId: res.id, included: true, issueIds: [...c.issueIds], changes, status: 'planned',
      ...(c.row?.auditScore !== undefined ? { score: { before: c.row.auditScore } } : {}),
    });
    void scope;
  }

  async function scan(actor: Actor, input: SeoBulkStartInput) {
    const g = await guidelines();
    const fields = job!.fields;
    const cands = await collectCandidates(input, fields, g);
    job!.scan.candidates = cands.length;
    touch({ phase: 'Matching pages to Shopify and preparing suggestions', done: 0, total: cands.length });
    let next = 0;
    const worker = async () => {
      while (next < cands.length && !job!.cancelRequested) {
        const c = cands[next++];
        try {
          await planOne(actor, c, input.scope);
        } catch (e) {
          if ((e as ApiError).status === 401 || /access token/i.test((e as Error).message)) throw e;
          addManual({ reason: 'Could not be prepared: Shopify returned an error.', detail: (e as Error).message, url: c.url });
        }
        job!.progress.done++;
        if (job!.progress.done % 5 === 0) { summarize(); touch(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PLAN_CONCURRENCY, cands.length || 1) }, worker));
    items.sort((a, b) => a.url.localeCompare(b.url));
    summarize();
    if (job!.cancelRequested) { job!.state = 'cancelled'; touch({ phase: 'Cancelled', message: 'Cancelled before anything was written.' }); return; }
    job!.state = 'ready';
    touch({ phase: 'Ready for review', done: cands.length, total: cands.length, message: `${job!.summary.selectedChanges} change(s) selected on ${job!.summary.selectedPages} page(s); ${job!.summary.reviewChanges} need review; ${job!.summary.manual} item(s) need a person.` });
  }

  // ------------------------------------------------------------------------------------------------ apply

  async function recheckPage(it: SeoBulkItem) {
    if (!deps) return;
    const html = await h.fetchPage(it.url).catch(() => undefined);
    if (!html) return;
    const noAlt = html.images.filter((i) => i.alt === null || !i.alt.trim());
    const fresh: Partial<CrawledUrl> = {
      title: html.title, metaDescription: html.metaDescription, h1: html.h1s, h2Count: html.headings.filter((x) => x.level === 2).length,
      images: html.images.length, imagesMissingAlt: noAlt.length, imagesMissingAltSrc: noAlt.length ? noAlt.map((i) => i.src.slice(0, 500)) : undefined,
      titleCount: html.titleCount, metaDescriptionCount: html.metaDescriptionCount,
    };
    const s = await deps.recordRecheck(it.url, fresh).catch(() => undefined);
    if (s) it.score = { before: it.score?.before ?? s.before, after: s.after, checkedAt: iso() };
  }

  async function applyItem(actor: Actor, c: AdminClient, it: SeoBulkItem) {
    const chosen = it.changes.filter((x) => x.included);
    it.status = 'applying';
    const res = await h.fetchById(c, it.kind!, it.resourceId!);
    if (!res) { for (const ch of chosen) ch.result = { status: 'failed', message: `The ${it.kind} no longer exists in Shopify.` }; it.status = 'failed'; return; }
    // The live page decides where the H1 comes from now; the reviewed values decide what is written.
    const d = await h.buildDraft(actor, res, it.url);
    for (const f of d.fields) f.include = false;
    for (const ch of chosen) {
      const f = d.fields.find((x) => x.key === ch.key);
      if (!f) { ch.result = { status: 'skipped', message: 'This field is no longer available on the resource.' }; continue; }
      if (ch.key === 'h1' && f.applyVia === 'theme') { ch.result = { status: 'skipped', message: 'The H1 now comes from the theme — change it in the theme instead.' }; continue; }
      f.current = ch.current; // the value that was reviewed: a different live value is a conflict, never overwritten
      f.proposed = ch.proposed;
      f.validation = await h.validate(d, f, ch.proposed);
      f.include = true;
    }
    if (!d.fields.some((f) => f.include)) { it.status = 'skipped'; return; }
    const out = await h.applyOne(d, c, actor);
    for (const ch of chosen) {
      if (ch.result) continue;
      const fr = out.result?.fields.find((x) => x.key === ch.key);
      ch.result = fr ? { status: fr.status, message: fr.message, after: fr.after } : { status: 'skipped', message: 'Unchanged: Shopify already has this value.' };
    }
    it.storefront = out.result?.reaudit;
    const st = chosen.map((x) => x.result!.status);
    it.status = st.every((x) => x === 'verified' || x === 'skipped') && st.includes('verified') ? 'done' : st.some((x) => x === 'verified' || x === 'applied_unverified') ? 'partial' : st.every((x) => x === 'skipped') ? 'skipped' : 'failed';
    if (st.includes('verified')) await recheckPage(it);
  }

  async function verifyIssues(actor: Actor): Promise<SeoBulkIssueCheck[]> {
    // URLs whose changes were verified, per field.
    const fixed = new Map<SeoBulkField, Set<string>>();
    for (const it of items) for (const ch of it.changes) if (ch.result?.status === 'verified') {
      const s = fixed.get(ch.field) ?? new Set<string>();
      s.add(urlKey(it.url));
      fixed.set(ch.field, s);
    }
    const all = new Set([...fixed.values()].flatMap((s) => [...s]));
    if (!all.size) return [];
    const issueIds = new Set(items.flatMap((i) => i.issueIds));
    const open = (await r.issues.list()).filter((i) => i.source === 'live' && !i.isTemplateGroup && isIssueOpen(i.status) && CHECK_FIELDS[i.checkId]
      && (issueIds.has(i.id) || i.affectedUrls.some((u) => all.has(urlKey(u)))));
    const out: SeoBulkIssueCheck[] = [];
    for (const i of open.slice(0, 100)) {
      if (job!.cancelRequested) break;
      const f = CHECK_FIELDS[i.checkId][0];
      const done = fixed.get(f) ?? new Set();
      const covered = i.affectedUrls.filter((u) => done.has(urlKey(u))).length;
      if (covered < i.affectedUrls.length) {
        out.push({ issueId: i.id, title: i.title, outcome: 'still_failing', details: `Fixed on ${covered} of ${i.affectedUrls.length} affected page(s). The issue stays open; the next crawl re-checks the rest.` });
        continue;
      }
      const can = ctx.reverifier.canVerify(i.checkId);
      if (!can.ok) { out.push({ issueId: i.id, title: i.title, outcome: 'not_verifiable', details: `Not re-checked automatically: ${can.reason}. It stays open until the next crawl.` }); continue; }
      try {
        const v = await ctx.reverifier.verify(i);
        if (v.outcome === 'passed') {
          await deps!.confirmIssueFixed(actor, i.id, { checkedUrls: v.checkedUrls, details: `Bulk SEO fix ${job!.id}: re-checked ${v.checkedUrls} URL(s), 0 failing. ${v.details}` });
          out.push({ issueId: i.id, title: i.title, outcome: 'resolved', details: `Re-checked ${v.checkedUrls} URL(s): 0 failing. Closed as verified.` });
        } else if (v.outcome === 'failed') {
          out.push({ issueId: i.id, title: i.title, outcome: 'still_failing', details: `Re-check: ${v.failingUrls} of ${v.checkedUrls} URL(s) still fail (${v.details}). The storefront may still be cached — the next crawl checks again.` });
        } else {
          out.push({ issueId: i.id, title: i.title, outcome: 'error', details: `Re-check could not decide: ${v.details}` });
        }
      } catch (e) {
        out.push({ issueId: i.id, title: i.title, outcome: 'error', details: `Re-check failed to run: ${(e as Error).message}` });
      }
    }
    return out;
  }

  async function applyAll(actor: Actor) {
    const todo = items.filter((i) => i.included && i.changes.some((c) => c.included));
    touch({ phase: 'Writing to Shopify', done: 0, total: todo.length, message: undefined });
    const c = h.client();
    let stopped: string | undefined;
    for (let b = 0; b < todo.length; b += APPLY_BATCH) {
      for (const it of todo.slice(b, b + APPLY_BATCH)) {
        if (job!.cancelRequested || stopped) {
          for (const ch of it.changes.filter((x) => x.included)) ch.result = { status: 'skipped', message: stopped ? `Not attempted: ${stopped}` : 'Not attempted: cancelled.' };
          it.status = 'skipped';
          continue;
        }
        try {
          await applyItem(actor, c, it);
        } catch (e) {
          const msg = (e as Error).message;
          for (const ch of it.changes.filter((x) => x.included && !x.result)) ch.result = { status: 'failed', message: msg };
          it.status = 'failed';
          // A revoked / invalid token stops the batch: the remaining pages would fail the same way.
          if ((e as ApiError).status === 401 || /401|access token|invalid api key/i.test(msg)) stopped = msg;
        }
        job!.progress.done++;
        touch();
      }
    }
    touch({ phase: 'Re-checking issues', done: 0, total: 0 });
    const issues = job!.cancelRequested ? [] : await verifyIssues(actor);
    const fixedUrls = items.filter((i) => i.changes.some((c) => c.result?.status === 'verified')).map((i) => i.url);
    if (deps && fixedUrls.length) await deps.markChanged(fixedUrls).catch(() => undefined);
    const fl = items.flatMap((i) => i.changes.filter((c) => c.result));
    const count = (s: string) => fl.filter((c) => c.result!.status === s).length;
    job!.result = {
      finishedAt: iso(), verified: count('verified'), unverified: count('applied_unverified'), failed: count('failed'), conflicts: count('conflict'), skipped: count('skipped'),
      pagesRechecked: items.filter((i) => i.score?.after !== undefined).length, issues,
      message: job!.cancelRequested ? 'Cancelled: pages already written stay written (each was read back); the rest were not attempted.' : stopped ? `Stopped: ${stopped}` : 'Finished.',
    };
    job!.state = job!.cancelRequested ? 'cancelled' : 'done';
    touch({ phase: job!.state === 'done' ? 'Finished' : 'Cancelled', done: todo.length, total: todo.length });
    await audit(ctx, actor, 'seo.bulk_fix', 'shopify', job!.id, `Bulk SEO fix: ${job!.result.verified} verified, ${job!.result.unverified} written not verified, ${job!.result.failed} failed, ${job!.result.conflicts} conflicts on ${todo.length} page(s); ${issues.filter((i) => i.outcome === 'resolved').length} issue(s) closed after re-check`);
  }

  function snapshot(): SeoBulkJob | null {
    return job ? JSON.parse(JSON.stringify(job)) as SeoBulkJob : null;
  }

  const busy = () => !!job && (job.state === 'scanning' || job.state === 'applying');

  // ------------------------------------------------------------------------------------------------ optimization lists

  /** Short-lived suggestions per page (a list page asks for at most 50 at a time). */
  const suggestCache = new Map<string, { at: number; d?: ShopifyDraft; problem?: string }>();
  async function draftFor(actor: Actor, url: string, row?: CrawledUrl) {
    const k = urlKey(url);
    const hit = suggestCache.get(k);
    if (hit && ctx.clock().getTime() - hit.at < 5 * 60_000) return hit;
    const found = await h.resolveUrl(url).catch((e: Error) => ({ problem: e.message, res: undefined }));
    const v = found.res ? { at: ctx.clock().getTime(), d: await h.buildDraft(actor, found.res, url, { crawlRow: row }) } : { at: ctx.clock().getTime(), problem: found.problem ?? 'Not found in Shopify.' };
    suggestCache.set(k, v);
    if (suggestCache.size > 500) suggestCache.delete(suggestCache.keys().next().value as string);
    return v;
  }

  function suggestionFromDraft(field: SeoBulkField, d: ShopifyDraft): { s: SeoOptimizationRow['suggestion']; note?: string } {
    const h1Src = d.h1.sources[0]?.source;
    if (field === 'imageAlt') {
      const alts = d.fields.filter((f) => f.key.startsWith('imageAlt:') && f.suggestion && !f.suggestion.keep && f.suggestion.value !== f.current);
      if (!alts.length) return { s: { value: '', reason: 'The images Shopify manages for this page all have alt text — images without alt are placed by the theme or inside the content HTML.', keep: true, confidence: 'high' } };
      return { s: { value: alts.map((f) => f.suggestion!.value).slice(0, 3).join(' | '), reason: `${alts.length} image(s): ${alts[0].suggestion!.reason}`, keep: false, confidence: alts.every((f) => f.suggestion!.confidence === 'high') ? 'high' : 'review' } };
    }
    if (field === 'h1') {
      const f = d.fields.find((x) => x.key === 'h1');
      if (!f) return { s: null, note: 'No H1 information.' };
      if (f.applyVia === 'theme') return { s: f.suggestion ?? null, note: 'Printed by the theme: change it with a theme change (SEO editor).' };
      if (h1Src === 'title') {
        const t = d.fields.find((x) => x.key === 'title');
        if (t?.suggestion && !t.suggestion.keep && t.suggestion.value === t.current) return { s: null, note: `The theme prints the title as the H1. ${t.suggestion.reason}` };
        return { s: t?.suggestion ?? null, note: 'The theme prints the title as the H1.' };
      }
      const body = d.fields.find((x) => x.key === 'bodyHtml');
      if (body?.source === 'suggested' && (f.suggestion?.keep ?? true)) return { s: { value: f.current, reason: body.reason, keep: false, confidence: 'high' } };
      return { s: f.suggestion ?? null };
    }
    const f = d.fields.find((x) => x.key === field);
    // No automatic rewrite possible: say why instead of repeating the current value as a "suggestion".
    if (f?.suggestion && !f.suggestion.keep && f.suggestion.value === f.current) return { s: null, note: f.suggestion.reason };
    return { s: f?.suggestion ?? null };
  }

  async function optimizationList(actor: Actor, field: SeoOptimizationField, q: SeoOptimizationQuery): Promise<SeoOptimizationPage> {
    const meta = SEO_OPTIMIZATION_FIELDS[field];
    if (!meta) throw badRequest('Unknown field.');
    const g = await guidelines();
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 50);
    const offset = Math.max(Number(q.offset) || 0, 0);
    if (field === 'tags') return tagsList(q, g, limit);
    if (!deps) throw new ApiError(409, 'NO_CRAWL', 'Crawl data is not available on this server.');
    const src = await deps.rowsOf(q.runId);
    if (!src) return { field, total: 0, offset, limit, rows: [], counts: {}, guidelines: g, note: 'No finished crawl of this website yet. Run a crawl in the Crawl Center — the lists are built from its pages.' };
    // Open issues per URL for this field's check.
    const check = Object.entries(CHECK_FIELDS).find(([, f]) => f.includes(meta.bulkField))?.[0];
    const issuesByUrl = new Map<string, string[]>();
    if (check) for (const i of await r.issues.list()) {
      if (i.source !== 'live' || i.checkId !== check || !isIssueOpen(i.status) || i.isTemplateGroup) continue;
      for (const u of i.affectedUrls) { const k = urlKey(u); issuesByUrl.set(k, [...(issuesByUrl.get(k) ?? []), i.id]); }
    }
    const counts: Record<string, number> = {};
    const window: { row: CrawledUrl; a: FieldAssessment; issueIds: string[] }[] = [];
    let total = 0;
    const text = (q.q ?? '').trim().toLowerCase();
    for await (const row of src.rows) {
      if (!isPage(row)) continue;
      if (q.template && row.template !== q.template) continue;
      const a = assessRow(meta.bulkField, row, g)!;
      const ids = issuesByUrl.get(urlKey(row.url)) ?? [];
      counts.all = (counts.all ?? 0) + 1;
      counts[a.verdict === 'good' ? 'good' : 'needs_work'] = (counts[a.verdict === 'good' ? 'good' : 'needs_work'] ?? 0) + 1;
      for (const p of a.problems) counts[p.code] = (counts[p.code] ?? 0) + 1;
      if (q.problem) {
        if (q.problem === 'needs_work' ? a.verdict === 'good' : q.problem === 'good' ? a.verdict !== 'good' : !a.problems.some((p) => p.code === q.problem)) continue;
      }
      if (q.issue === 'open' && !ids.length) continue;
      if (q.issue === 'none' && ids.length) continue;
      if (text && !row.url.toLowerCase().includes(text) && !(row.title ?? '').toLowerCase().includes(text)) continue;
      if (total >= offset && window.length < limit) window.push({ row, a, issueIds: ids });
      total++;
    }
    const rows: SeoOptimizationRow[] = [];
    const canSuggest = h.connected();
    for (const w of window) {
      const why = manualReasonFor(w.row.url);
      const current = meta.bulkField === 'seoTitle' ? w.row.title ?? '' : meta.bulkField === 'seoDescription' ? w.row.metaDescription ?? '' : meta.bulkField === 'h1' ? (w.row.h1 ?? []).join(' | ') : `${w.row.imagesMissingAlt ?? 0} of ${w.row.images ?? 0} image(s) without alt text`;
      const row: SeoOptimizationRow = {
        url: w.row.url, title: w.row.title ?? '', pageType: w.row.template ?? 'other', current, assessment: w.a, issueIds: w.issueIds, editable: !why, ...(why ? { manualReason: why } : {}),
        ...(meta.bulkField === 'imageAlt' && w.row.imagesMissingAltSrc?.length ? { detail: w.row.imagesMissingAltSrc.slice(0, 3).join('\n') } : {}),
        ...(meta.bulkField === 'h1' && (w.row.h1?.length ?? 0) > 1 ? { detail: `${w.row.h1!.length} H1s on the page` } : {}),
      };
      if (why) row.suggestion = null;
      else if (!canSuggest) { row.suggestion = null; row.suggestionNote = 'Connect Shopify (Settings → Shopify) for suggestions built from the page’s content.'; }
      else if (w.a.verdict === 'good') row.suggestion = { value: current, reason: 'Already good — keep it.', keep: true, confidence: 'high' };
      rows.push(row);
    }
    // Suggestions from the page's Shopify content, a few at a time.
    const need = rows.filter((x) => x.suggestion === undefined);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(4, need.length) }, async () => {
      while (i < need.length) {
        const row = need[i++];
        try {
          const v = await draftFor(actor, row.url, window.find((w) => w.row.url === row.url)?.row);
          if (!v.d) { row.suggestion = null; row.suggestionNote = v.problem; continue; }
          const s = suggestionFromDraft(meta.bulkField, v.d);
          row.suggestion = s.s;
          if (s.note) row.suggestionNote = s.note;
        } catch (e) {
          row.suggestion = null;
          row.suggestionNote = `Shopify could not be read: ${(e as Error).message}`;
        }
      }
    }));
    return { field, runId: src.run.id, total, offset, limit, rows, counts, guidelines: g };
  }

  async function tagsList(q: SeoOptimizationQuery, g: SeoGuidelines, limit: number): Promise<SeoOptimizationPage> {
    if (!h.connected()) return { field: 'tags', total: 0, offset: 0, limit, rows: [], counts: {}, guidelines: g, note: 'Tags live in Shopify: connect Shopify (Settings → Shopify) to list them.' };
    await h.requireEditable();
    const page = await h.call((c) => listResources(c, 'product', q.q, q.cursor));
    const base = await h.siteBase();
    const counts: Record<string, number> = {};
    const rows: SeoOptimizationRow[] = [];
    for (const res of page.items) {
      const tags = res.tags ?? [];
      const a = assessSeoField('tags', tags.join(','), { guidelines: g });
      counts.all = (counts.all ?? 0) + 1;
      counts[a.verdict === 'good' ? 'good' : 'needs_work'] = (counts[a.verdict === 'good' ? 'good' : 'needs_work'] ?? 0) + 1;
      for (const p of a.problems) counts[p.code] = (counts[p.code] ?? 0) + 1;
      if (q.problem && (q.problem === 'needs_work' ? a.verdict === 'good' : q.problem === 'good' ? a.verdict !== 'good' : !a.problems.some((p) => p.code === q.problem))) continue;
      rows.push({ url: `${base}${res.path}`, title: res.title, pageType: 'product', current: tags.join(', '), assessment: a, issueIds: [], editable: true, suggestion: suggestTags(tags, a) });
    }
    return { field: 'tags', total: rows.length, offset: 0, limit: page.items.length, rows: rows.slice(0, limit * 2), counts, guidelines: g, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), note: 'Products in Shopify, 50 per page, most recently changed first.' };
  }

  // ------------------------------------------------------------------------------------------------ API

  return {
    async start(actor: Actor, raw: Partial<SeoBulkStartInput>): Promise<SeoBulkJob> {
      await h.requireEditable();
      if (busy()) throw new ApiError(409, 'BULK_JOB_RUNNING', `A bulk fix of this website is already ${job!.state === 'scanning' ? 'preparing' : 'writing'} (${job!.id}). Wait for it or cancel it.`, { jobId: job!.id });
      if (job?.state === 'ready' && raw.scope === undefined) throw badRequest('scope is required.');
      const scope = raw.scope;
      if (scope !== 'pages' && scope !== 'issues' && scope !== 'urls') throw badRequest('scope must be pages, issues or urls.');
      const fields = (Array.isArray(raw.fields) && raw.fields.length ? raw.fields.filter((f): f is SeoBulkField => ALL_FIELDS.includes(f as SeoBulkField)) : ALL_FIELDS.filter((f) => f !== 'title' && f !== 'tags'));
      if (!fields.length) throw badRequest('Choose at least one field.');
      const at = iso();
      job = {
        id: `SBF-${randomToken(6)}`, scope, fields, createdBy: actor.name, createdAt: at, updatedAt: at, state: 'scanning',
        progress: { phase: scope === 'issues' ? 'Reading open issues' : 'Reading the crawl’s pages', done: 0, total: 0 },
        scan: { pagesScanned: 0, candidates: 0, capped: false, cap: BULK_PAGE_CAP },
        summary: { pages: 0, changes: 0, selectedPages: 0, selectedChanges: 0, reviewChanges: 0, byField: {}, manual: 0 }, manual: [],
        ...(raw.runId ? { runId: String(raw.runId) } : {}),
      };
      items = [];
      const filter = raw.filter && typeof raw.filter === 'object' ? (Object.fromEntries(Object.entries(raw.filter).filter(([k, v]) => ['q', 'status', 'indexable', 'problem', 'crawlState', 'source', 'template', 'score', 'check'].includes(k) && typeof v === 'string' && v)) as CrawlPagesQuery) : undefined;
      const input: SeoBulkStartInput = { scope, fields, ...(filter && Object.keys(filter).length ? { filter } : {}), ...(raw.runId ? { runId: String(raw.runId) } : {}), ...(Array.isArray(raw.issueIds) ? { issueIds: raw.issueIds.map(String) } : {}), ...(Array.isArray(raw.urls) ? { urls: raw.urls.map(String) } : {}) };
      const mine = job;
      running = scan(actor, input).catch((e: Error) => {
        if (job !== mine) return;
        mine.state = 'failed';
        mine.error = e.message;
        touch({ phase: 'Failed', message: e.message });
      }).finally(() => { running = undefined; });
      await audit(ctx, actor, 'seo.bulk_scan', 'shopify', job.id, `Bulk SEO fix prepared from ${scope} (${fields.join(', ')})`);
      return snapshot()!;
    },

    status(): SeoBulkJob | null { return snapshot(); },

    items(q: { offset?: unknown; limit?: unknown; field?: unknown; filter?: unknown }): SeoBulkItemsPage {
      const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
      const offset = Math.max(Number(q.offset) || 0, 0);
      const field = typeof q.field === 'string' && q.field ? q.field : undefined;
      const filter = typeof q.filter === 'string' ? q.filter : 'all';
      const list = items.filter((it) => (!field || it.changes.some((c) => c.field === field))
        && (filter === 'all' || (filter === 'selected' && it.included && it.changes.some((c) => c.included)) || (filter === 'review' && it.changes.some((c) => c.confidence === 'review'))
          || (filter === 'failed' && (it.status === 'failed' || it.status === 'partial')) || (filter === 'done' && it.status === 'done')));
      return { total: list.length, offset, limit, items: JSON.parse(JSON.stringify(list.slice(offset, offset + limit))) as SeoBulkItem[] };
    },

    /** Include / exclude a page (url) or one of its changes (url + key), or everything (all). Only before applying. */
    select(input: { jobId?: unknown; url?: unknown; key?: unknown; included?: unknown; all?: unknown }): SeoBulkJob {
      if (!job || job.id !== input.jobId) throw conflict('This bulk fix is no longer the current one. Prepare it again.', 'BULK_JOB_GONE');
      if (job.state !== 'ready') throw conflict(`Changes can only be selected before applying (the job is ${job.state}).`, 'BULK_JOB_STATE');
      const on = !!input.included;
      if (input.all) { for (const it of items) { it.included = on; for (const c of it.changes) if (on ? c.confidence === 'high' : true) c.included = on; } }
      else {
        const it = items.find((x) => x.url === input.url);
        if (!it) throw badRequest('Unknown page.');
        if (typeof input.key === 'string') {
          const c = it.changes.find((x) => x.key === input.key);
          if (!c) throw badRequest('Unknown change.');
          c.included = on;
          if (on) it.included = true;
        } else it.included = on;
      }
      summarize();
      touch();
      return snapshot()!;
    },

    async apply(actor: Actor, jobId: unknown): Promise<SeoBulkJob> {
      await h.requireEditable();
      if (!job || job.id !== jobId) throw conflict('This bulk fix is no longer the current one. Prepare it again.', 'BULK_JOB_GONE');
      if (job.state === 'applying' || job.state === 'done') return snapshot()!; // second click / retry: same job, no second write
      if (job.state !== 'ready') throw conflict(`The bulk fix is ${job.state}, so it cannot be applied.`, 'BULK_JOB_STATE');
      if (!items.some((i) => i.included && i.changes.some((c) => c.included))) throw badRequest('Nothing is selected to apply.');
      if (!h.lock()) throw conflict('Another batch is being applied to Shopify. Wait for it to finish.');
      job.state = 'applying';
      job.cancelRequested = false;
      touch();
      const mine = job;
      running = applyAll(actor).catch((e: Error) => {
        mine.state = 'failed';
        mine.error = e.message;
        touch({ phase: 'Failed', message: e.message });
      }).finally(() => { h.unlock(); running = undefined; });
      return snapshot()!;
    },

    cancel(jobId: unknown): SeoBulkJob {
      if (!job || job.id !== jobId) throw conflict('This bulk fix is no longer the current one.', 'BULK_JOB_GONE');
      if (job.state === 'ready') { job.state = 'cancelled'; touch({ phase: 'Cancelled', message: 'Nothing was written.' }); }
      else if (busy()) { job.cancelRequested = true; touch({ message: 'Cancelling after the current page…' }); }
      return snapshot()!;
    },

    /** Tests / shutdown: wait for the running phase. */
    async idle() { await running?.catch(() => undefined); },

    optimizationList,
  };
}
export type BulkFixer = ReturnType<typeof createBulkFixer>;
