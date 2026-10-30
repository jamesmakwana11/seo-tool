/**
 * Website sync (Sync Now / Auto Sync every 12 hours): after the first Full or Smart crawl, keep its results current by
 * crawling only what changed — never the whole site again.
 *
 * What a sync looks at (each a cheap signal; together they find new, changed and removed URLs):
 *  - the sitemaps, with conditional requests (If-None-Match / If-Modified-Since — a 304 means nothing to parse):
 *    URLs not in the stored crawl are new; a changed <lastmod> (against the last sync, or the crawl's date on the first
 *    sync) marks a changed page; URLs that left the sitemap are re-checked (removed / redirected);
 *  - Shopify products and collections updated since the last sync (Admin API updated_at), and Shopify webhooks
 *    already recorded on the page inventory;
 *  - a rotating content check: a bounded number of stored pages per sync (least recently checked first, plus the
 *    homepage) requested with their ETag / Last-Modified; a 304 or the same SEO fingerprint (status, title, meta
 *    description, canonical, robots, H1, image / main-content link counts) means unchanged. Their internal links not in the stored
 *    crawl are new URLs too;
 *  - pages that answered an error last time, and URLs a previous sync found but could not crawl yet.
 * Each URL is counted once (first reason wins), on this website's host only and allowed by robots.txt, and at most
 * MAX_SYNC_URLS are crawled per sync (the rest wait for the next one). The incremental crawl ('sync') fetches only
 * those URLs, merges them into the latest crawl's results and updates the issues of the fetched pages; everything else
 * stays as it was.
 */
import crypto from 'node:crypto';
import type { CrawledUrl, CrawlRun, MonitorEvent, MonitorRunSummary, MonitorStatus, SyncReason, SyncSummary } from '@sentinel/shared';
import { parseHtml } from '../crawler/parse';
import { isAllowed, parseRobots } from '../crawler/robots';
import { parseSitemapXml } from '../crawler/sitemap';
import { hostOf, isSameSite } from '../crawler/url';
import type { Collector } from '../crawler/engine';
import type { MonitorPageDoc, MonitorStateDoc } from '../repositories/types';
import type { Ctx } from '../services/context';
import { audit, need, SYSTEM_ACTOR, type Actor } from '../services/context';
import { ApiError, conflict } from '../lib/errors';

export interface MonitorDeps {
  collector: Collector;
  userAgent: string;
  latestRow: (url: string) => Promise<{ row: { status?: number | null; finalStatus?: number | null; title?: string; metaDescription?: string; canonical?: string; metaRobots?: string; h1?: string[] } } | undefined>;
  shopifyChangedSince?: (since: string) => Promise<{ urls: string[]; capped: boolean; problem?: string }>;
  crawlRunning: () => Promise<boolean>;
  /** The crawl a sync builds on (newest completed full / smart / sync), its rows (streamed), and the sync crawl. */
  latestCompleteRun?: () => Promise<CrawlRun | undefined>;
  rowsOf?: (runId: string) => Promise<{ rows: AsyncIterable<CrawledUrl>; total: number } | undefined>;
  startSync?: (actor: Actor, input: { urls: string[]; baseRunId: string; reasons: Record<string, number>; deferred?: number; trigger: CrawlRun['trigger'] }) => Promise<CrawlRun>;
  /** Pages content-checked per sync (rotation). */
  maxChecks: number;
  /** Auto Sync interval (minutes; 0 = Auto Sync off on this server). */
  intervalMinutes: number;
  /** URLs crawled per sync at most. */
  maxSyncUrls?: number;
  /** false = the in-process scheduler is off (SCHEDULER_ENABLED), so Auto Sync cannot fire. */
  schedulerEnabled?: boolean;
}

/** `contentLinks`: distinct internal links in the main content — header, nav and footer links are left out, so a menu
 * change (a new collection in the nav) does not mark every page of the site as changed. */
const FIELDS = ['status', 'title', 'metaDescription', 'canonical', 'robots', 'h1', 'images', 'contentLinks'] as const;
const EVENT_FIELDS = new Set(['title', 'metaDescription', 'canonical', 'robots', 'h1']);
type Fields = Partial<Record<(typeof FIELDS)[number], string>>;
const MAX_SITEMAP_FILES = 200;
const MAX_EVENTS = 1000;
const MAX_NEW_LINKS = 200;
const HISTORY = 20;
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const norm = (u: string) => u.replace(/#.*$/, '');
/** URL identity: no fragment, no trailing slash (except the root). */
const keyOf = (u: string) => { const x = norm(u); try { const p = new URL(x); return p.pathname !== '/' && x.endsWith('/') && !p.search ? x.slice(0, -1) : x; } catch { return x; } };
const isError = (status: number | null | undefined) => status === null || status === undefined || status >= 400;
const effStatus = (r: CrawledUrl) => (r.redirects ? r.status : r.finalStatus ?? r.status);
/** Paths that are pages (not files, feeds or app endpoints). */
const PAGE_PATH = /^\/(?!cdn\/|apps\/|cart|checkout|account|search|services\/|wpm|\.well-known)[^.?#]*(?:\.html?)?$/i;

export function createMonitorService(ctx: Ctx, deps: MonitorDeps) {
  const r = ctx.repos;
  const http = deps.collector.http;
  const maxSync = deps.maxSyncUrls ?? 2000;
  let running: Promise<SyncSummary> | undefined;
  const iso = () => ctx.clock().toISOString();

  async function blocked(): Promise<string | undefined> {
    const ready = ctx.engine.readiness();
    if (!ready.ready) return ready.reason;
    return undefined;
  }
  const loadState = async (): Promise<MonitorStateDoc> => (await r.monitorState.get('state')) ?? { id: 'state', sitemaps: {} };
  const saveState = (s: MonitorStateDoc) => r.monitorState.upsert(s);

  /** GET with stored validators. 304 → notModified (no body). */
  async function conditional(url: string, v: { etag?: string; lastModified?: string }, accept: string) {
    const headers: Record<string, string> = { accept };
    if (v.etag) headers['if-none-match'] = v.etag;
    if (v.lastModified) headers['if-modified-since'] = v.lastModified;
    const res = await http.request(url, { headers, anyContentType: accept.includes('xml'), gunzip: /\.gz$/i.test(url) });
    return { res, notModified: res.finalStatus === 304, validators: { etag: res.headers['etag'] ?? v.etag, lastModified: res.headers['last-modified'] ?? v.lastModified } };
  }

  /** SEO fingerprint fields of a fetched page (the same fields are taken from a stored crawl row). */
  function fieldsOf(status: number | null, html?: string, url?: string, host?: string): { fields: Fields; links: string[] } {
    const f: Fields = { status: status === null ? 'no response' : String(status) };
    let links: string[] = [];
    if (html && url && host) {
      const p = parseHtml(html, url, host);
      f.title = (p.title ?? '').trim();
      f.metaDescription = (p.metaDescription ?? '').trim();
      f.canonical = p.canonicals[0] ?? '';
      f.robots = (p.metaRobots ?? '').toLowerCase();
      f.h1 = (p.h1s[0] ?? '').trim();
      f.images = `${p.images.length}/${p.images.filter((i) => i.alt === null || !i.alt.trim()).length}`;
      f.contentLinks = String(new Set(p.links.filter((l) => l.internal && l.inMain).map((l) => l.url)).size);
      links = p.internalLinks;
    }
    return { fields: f, links };
  }
  function fieldsOfRow(row: CrawledUrl): Fields {
    const st = effStatus(row) ?? null;
    return {
      status: st === null ? 'no response' : String(st), title: (row.title ?? '').trim(), metaDescription: (row.metaDescription ?? '').trim(), canonical: row.canonical ?? '',
      robots: (row.metaRobots ?? '').toLowerCase(), h1: (row.h1?.[0] ?? '').trim(), images: `${row.images ?? 0}/${row.imagesMissingAlt ?? 0}`,
      // contentLinks: not stored on crawl rows; compared from the second check of a page on.
    };
  }
  /** Fingerprint over the fields both sides have (a field missing on one side does not count as a change). */
  const differs = (a: Fields, b: Fields) => FIELDS.filter((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]);
  const fp = (f: Fields) => hash(FIELDS.map((k) => `${k}=${f[k] ?? ''}`).join('\n'));

  async function addEvent(events: MonitorEvent[], e: Omit<MonitorEvent, 'id' | 'at'>, key: string) {
    const id = `MON-${hash(key)}`;
    if (await r.monitorEvents.get(id)) return; // the same change was already recorded
    const ev: MonitorEvent = { id, at: iso(), ...e };
    await r.monitorEvents.upsert(ev);
    events.push(ev);
  }

  async function readSitemaps(origin: string, roots: string[], state: MonitorStateDoc, s: MonitorRunSummary) {
    const seen = new Set<string>();
    const queue = [...roots];
    const next: MonitorStateDoc['sitemaps'] = {};
    while (queue.length && seen.size < MAX_SITEMAP_FILES) {
      const url = queue.shift()!;
      if (seen.has(url) || !isSameSite(url, hostOf(origin))) continue;
      seen.add(url);
      const prev = state.sitemaps[url];
      const { res, notModified, validators } = await conditional(url, prev ?? {}, 'application/xml,text/xml;q=0.9,*/*;q=0.5');
      if (notModified && prev) {
        s.sitemapsNotModified++;
        next[url] = prev;
        // A 304 index: its children are unchanged too unless they say otherwise — re-ask each child conditionally.
        for (const [child, v] of Object.entries(prev.entries)) if (v === '\u0000index') queue.push(child);
        continue;
      }
      if (res.finalStatus !== 200 || !res.body) { if (prev) next[url] = prev; continue; }
      s.sitemapsFetched++;
      const parsed = parseSitemapXml(res.body);
      const entries: Record<string, string> = {};
      if (parsed.kind === 'sitemapindex') for (const c of parsed.children) { entries[c] = '\u0000index'; queue.push(c); }
      else for (const u of parsed.urls) entries[norm(u.loc)] = u.lastmod ?? '';
      next[url] = { ...validators, entries };
    }
    return next;
  }

  const pageEntries = (maps: MonitorStateDoc['sitemaps']) => {
    const out = new Map<string, string>();
    for (const f of Object.values(maps)) for (const [u, lm] of Object.entries(f.entries)) if (lm !== '\u0000index') out.set(keyOf(u), lm);
    return out;
  };
  const after = (a: string | undefined, b: string | undefined) => { const x = Date.parse(a ?? ''); const y = Date.parse(b ?? ''); return Number.isFinite(x) && Number.isFinite(y) && x > y; };

  /** A sync crawl that has finished since the last look: its results written into the summary. */
  async function finalize(state: MonitorStateDoc): Promise<MonitorStateDoc> {
    const cur = state.current;
    if (!cur || cur.state !== 'crawling' || !cur.crawlRunId) return state;
    const run = await r.crawls.get(cur.crawlRunId);
    if (run && (run.status === 'running' || run.status === 'queued')) return state;
    const done: SyncSummary = { ...cur, finishedAt: run?.finishedAt ?? iso() };
    if (run?.status === 'completed') {
      done.state = 'done';
      done.crawled = run.sync?.fetched ?? run.urlsCrawled;
      done.newIssues = run.newIssues;
      done.resolvedIssues = run.resolvedIssues;
      done.message = `${done.crawled} page(s) crawled and merged into the results (${run.sync?.merged ?? run.urlCount ?? 0} pages in all); ${run.newIssues} new and ${run.resolvedIssues} resolved issue(s).`;
      state.inFlight = [];
    } else {
      done.state = 'failed';
      done.message = `The sync crawl ${run ? run.status : 'is missing'}${run?.error ? `: ${run.error}` : ''}. Its URLs are crawled by the next sync.`;
      state.pending = [...new Set([...(state.inFlight ?? []), ...(state.pending ?? [])])];
      state.inFlight = [];
    }
    state.current = undefined;
    state.history = [done, ...(state.history ?? []).filter((h) => h.at !== done.at)].slice(0, HISTORY);
    await saveState(state);
    return state;
  }

  async function record(state: MonitorStateDoc, s: SyncSummary) {
    if (s.state === 'crawling') state.current = s;
    else { state.current = undefined; state.history = [s, ...(state.history ?? [])].slice(0, HISTORY); }
    await saveState(state);
  }

  async function sync(trigger: SyncSummary['trigger'], actor: Actor): Promise<SyncSummary> {
    const t0 = Date.now();
    const now = iso();
    let state = await finalize(await loadState());
    const s: SyncSummary = { at: now, trigger, ...(actor.system ? {} : { by: actor.name }), state: 'checking', reasons: {}, checked: 0, unchanged: 0, crawled: 0, deferred: 0, sitemapsNotModified: 0, sitemapsFetched: 0, notes: [] };
    const skip = async (why: string) => { s.state = 'skipped'; s.message = why; s.finishedAt = iso(); s.ms = Date.now() - t0; await record(state, s); return s; };
    if (state.current?.state === 'crawling') return skip(`The previous sync is still crawling (${state.current.crawlRunId}).`);
    if (await deps.crawlRunning()) return skip('A crawl of this website is running; the next sync runs after it.');
    const base = deps.latestCompleteRun ? await deps.latestCompleteRun() : undefined;
    if (!base || !deps.rowsOf || !deps.startSync) return skip('No finished crawl of this website yet. Run a Full or Smart crawl once — syncs then keep its results current.');
    s.baseRunId = base.id;
    const since = state.lastSyncAt && state.lastSyncAt > (base.startedAt ?? '') ? state.lastSyncAt : base.startedAt ?? now;
    const summary: MonitorRunSummary = { at: now, ms: 0, sitemapsNotModified: 0, sitemapsFetched: 0, signals: { newInSitemap: 0, lastmodChanged: 0, removed: 0, shopify: 0, webhook: 0, recheck: 0 }, checked: 0, notModified: 0, deferred: 0, events: 0, notes: [] };

    const baseUrl = ctx.engine.readiness().baseUrl!;
    const origin = new URL(baseUrl).origin;
    const host = new URL(baseUrl).host;

    // The stored crawl: which URLs it knows and their fingerprint fields (streamed; a few hundred bytes per URL).
    const known = new Map<string, { url: string; fields?: Fields; inSitemap?: boolean; ok: boolean }>();
    // Eligible URLs the crawl never fetched (its page budget ran out): crawled by syncs after the real changes.
    const notCrawled: string[] = [];
    const src = await deps.rowsOf(base.id);
    if (src) for await (const row of src.rows) {
      const fetchedRow = (row.crawlState ?? 'fetched') === 'fetched' && row.status !== null && row.status !== undefined;
      const ok = fetchedRow && effStatus(row) === 200 && (row.title !== undefined || row.h1 !== undefined);
      // Pages that answered with an error are checked too (status only): one that works again is crawled.
      const fields = ok ? fieldsOfRow(row) : fetchedRow && isError(effStatus(row)) ? { status: fieldsOfRow(row).status } : undefined;
      known.set(keyOf(row.url), { url: row.url, ok, inSitemap: row.inSitemap, ...(fields ? { fields } : {}) });
      if ((row.crawlState === 'page_limit' || row.crawlState === 'not_processed') && notCrawled.length < maxSync) notCrawled.push(row.url);
    }

    // robots.txt: one request — the rules for the targets, and the sitemap locations.
    const rob = await http.request(`${origin}/robots.txt`, { headers: { accept: 'text/plain,*/*;q=0.5' } });
    const robots = parseRobots(rob.finalStatus === 200 ? rob.body ?? '' : '');
    const allowed = (u: string) => { try { const x = new URL(u); return isAllowed(robots, deps.userAgent, `${x.pathname}${x.search}`).allowed; } catch { return false; } };
    const roots = robots.sitemaps.filter((u) => isSameSite(u, host)).slice(0, 10);
    const sitemaps = await readSitemaps(origin, roots.length ? roots : [`${origin}/sitemap.xml`], state, summary);
    s.sitemapsFetched = summary.sitemapsFetched;
    s.sitemapsNotModified = summary.sitemapsNotModified;
    const before = pageEntries(state.sitemaps);
    const now_ = pageEntries(sitemaps);
    const haveSitemap = Object.keys(sitemaps).length > 0;

    const targets = new Map<string, SyncReason>();
    const events: MonitorEvent[] = [];
    const add = (u: string, why: SyncReason) => {
      const k = keyOf(u);
      if (targets.has(k) || !isSameSite(k, host)) return;
      targets.set(k, why);
      s.reasons[why] = (s.reasons[why] ?? 0) + 1;
    };

    for (const u of state.pending ?? []) add(u, 'pending');
    // A page the last check found broken but the stored results still show working: crawl it so the results show the error.
    for (const p of await r.monitorPages.list()) if (isError(p.status) && known.get(keyOf(p.url))?.ok) { add(p.url, 'recheck'); summary.signals.recheck++; }
    for (const [u, lm] of now_) {
      const k = known.get(u);
      if (!k) {
        add(u, 'new_in_sitemap'); summary.signals.newInSitemap++;
        await addEvent(events, { url: u, kind: 'new_page', source: 'sitemap' }, `new|${u}`);
      } else if (lm && (before.has(u) ? before.get(u) !== lm : after(lm, since))) { add(u, 'lastmod'); summary.signals.lastmodChanged++; }
    }
    if (haveSitemap) {
      const gone = new Set<string>();
      for (const u of before.keys()) if (!now_.has(u)) gone.add(u);
      if (!before.size) for (const [k, v] of known) if (v.inSitemap && !now_.has(k)) gone.add(k);
      for (const u of gone) {
        add(known.get(u)?.url ?? u, 'removed'); summary.signals.removed++;
        await addEvent(events, { url: u, kind: 'removed', source: 'sitemap' }, `removed|${u}|${state.lastSyncAt ?? base.id}`);
      }
    }
    if (deps.shopifyChangedSince) {
      const sh = await deps.shopifyChangedSince(state.lastShopifyCheck ?? since).catch((e: Error) => ({ urls: [] as string[], capped: false, problem: e.message }));
      if (sh.problem && !/not connected/i.test(sh.problem)) s.notes.push(`Shopify changes not read: ${sh.problem}`);
      if (sh.capped) s.notes.push('More than 100 Shopify products or collections changed: the newest 100 of each are synced now; the rest are found by the sitemap dates and the next syncs.');
      for (const u of sh.urls) { add(u, 'shopify'); summary.signals.shopify++; }
    }
    for (const p of await r.sitePages.list()) if (p.lastModified && p.lastModified > since) { add(p.url, 'webhook'); summary.signals.webhook++; }

    // Rotating content check: least recently checked stored pages first (never checked = first), plus the homepage.
    const checkedAt = new Map((await r.monitorPages.list()).map((p) => [keyOf(p.url), p.checkedAt]));
    const rotation = [...known.values()].filter((k) => k.fields && !targets.has(keyOf(k.url)))
      .sort((a, b) => (checkedAt.get(keyOf(a.url)) ?? '').localeCompare(checkedAt.get(keyOf(b.url)) ?? ''));
    const home = known.get(keyOf(`${origin}/`));
    const toCheck = [...(home?.ok && !targets.has(keyOf(home.url)) ? [home] : []), ...rotation.filter((k) => k !== home)].slice(0, deps.maxChecks);
    const newLinks = new Set<string>();
    for (const k of toCheck) {
      if (!allowed(k.url)) continue;
      const prev = await r.monitorPages.get(k.url);
      const { res, notModified, validators } = await conditional(k.url, prev ?? {}, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
      s.checked++;
      summary.checked++;
      if (notModified && prev) {
        s.unchanged++; summary.notModified++;
        await r.monitorPages.upsert({ ...prev, checkedAt: now });
        continue;
      }
      const status = res.finalStatus ?? null;
      const html = status === 200 && /html/i.test(res.contentType ?? '') ? res.body : undefined;
      const { fields, links } = fieldsOf(status, html, res.finalUrl ?? k.url, host);
      const was = prev?.fields ?? k.fields ?? {};
      const changed = differs(was, fields);
      if (changed.length) {
        add(k.url, 'content');
        for (const f of changed) {
          if (f === 'status') {
            if (isError(status) && !isError(Number(was.status))) await addEvent(events, { url: k.url, kind: 'error', field: 'status', before: was.status, after: fields.status, status, source: 'content' }, `error|${k.url}|${fields.status}|${prev?.checkedAt ?? 'first'}`);
            else if (!isError(status) && isError(Number(was.status))) await addEvent(events, { url: k.url, kind: 'resolved', field: 'status', before: was.status, after: fields.status, status, source: 'content' }, `resolved|${k.url}|${now}`);
          } else if (EVENT_FIELDS.has(f)) await addEvent(events, { url: k.url, kind: 'seo_change', field: f as MonitorEvent['field'], before: was[f], after: fields[f], status, source: 'content' }, `seo|${k.url}|${f}|${fields[f]}|${was[f]}`);
        }
      } else { s.unchanged++; }
      for (const l of links) {
        const lk = keyOf(l);
        if (newLinks.size >= MAX_NEW_LINKS || known.has(lk) || targets.has(lk) || !isSameSite(lk, host)) continue;
        try { const x = new URL(lk); if (x.search || !PAGE_PATH.test(x.pathname)) continue; } catch { continue; }
        newLinks.add(lk);
      }
      const doc: MonitorPageDoc = { id: k.url, url: k.url, ...validators, status, fields: html || !prev ? fields : { ...prev.fields, status: fields.status }, fingerprint: '', checkedAt: now };
      doc.fingerprint = fp(doc.fields);
      await r.monitorPages.upsert(doc);
    }
    for (const u of newLinks) { add(u, 'new_link'); await addEvent(events, { url: u, kind: 'new_page', source: 'link' }, `new|${u}`); }
    // Then, within this sync's limit, URLs the crawl left unfetched. They are found again next time, so never deferred.
    const changedCount = targets.size;
    for (const u of notCrawled) { if (targets.size >= maxSync) break; add(u, 'not_crawled'); }
    const remaining = notCrawled.length - (targets.size - changedCount);
    if (remaining > 0 || notCrawled.length >= maxSync) s.notes.push('The crawl left more eligible URLs unfetched (page budget): each sync crawls some of them after the new and changed pages.');

    // Keep the event log bounded (oldest dropped).
    const all = await r.monitorEvents.list();
    if (all.length > MAX_EVENTS) for (const e of all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - MAX_EVENTS)) await r.monitorEvents.delete(e.id);

    const list = [...targets.keys()].filter(allowed);
    const crawlNow = list.slice(0, maxSync);
    // Pages about to be crawled: their check record (fields, ETag) is from before the change. Dropped, so the next
    // check compares against the freshly crawled result instead of reporting the same change again.
    for (const u of crawlNow) {
      const row = known.get(keyOf(u));
      for (const id of new Set([u, row?.url].filter((x): x is string => !!x))) await r.monitorPages.delete(id);
    }
    s.deferred = list.filter((u) => targets.get(u) !== 'not_crawled').length - crawlNow.filter((u) => targets.get(u) !== 'not_crawled').length;
    if (s.deferred) s.notes.push(`${s.deferred} more URL(s) found: they are synced next time (at most ${maxSync} per sync).`);
    summary.deferred = s.deferred;
    summary.events = events.length;
    summary.ms = Date.now() - t0;
    state = { ...state, sitemaps, lastRunAt: now, lastSyncAt: now, lastShopifyCheck: deps.shopifyChangedSince ? now : state.lastShopifyCheck, lastRun: summary, pending: list.slice(maxSync).filter((u) => targets.get(u) !== 'not_crawled') };
    if (!crawlNow.length) {
      s.state = 'no_changes';
      s.message = `No new, changed or removed pages found (${s.checked} page(s) checked, ${s.unchanged} unchanged).`;
      s.finishedAt = iso();
      s.ms = Date.now() - t0;
      await record(state, s);
      ctx.log.info({ checked: s.checked, ms: s.ms }, 'website sync: no changes');
      return s;
    }
    try {
      const reasons = Object.fromEntries(Object.entries(s.reasons).filter(([, n]) => n));
      const run = await deps.startSync(actor, { urls: crawlNow.map((k) => known.get(k)?.url ?? k), baseRunId: base.id, reasons, deferred: s.deferred, trigger: trigger === 'auto' ? 'schedule' : 'manual' });
      s.state = 'crawling';
      s.crawlRunId = run.id;
      s.crawled = crawlNow.length;
      const backlog = crawlNow.filter((u) => targets.get(u) === 'not_crawled').length;
      const parts = [crawlNow.length - backlog ? `${crawlNow.length - backlog} new or changed` : '', backlog ? `${backlog} not crawled yet` : ''].filter(Boolean).join(' and ');
      s.message = `Crawling ${parts} page(s) (${run.id}); the other pages keep their stored results.`;
      state.inFlight = crawlNow;
    } catch (e) {
      s.state = 'failed';
      s.message = `The sync crawl could not start: ${(e as Error).message}`;
      s.finishedAt = iso();
      state.pending = list;
    }
    s.ms = Date.now() - t0;
    await record(state, s);
    await audit(ctx, actor, 'site.sync', 'crawl', s.crawlRunId ?? base.id, `Website sync (${trigger}): ${crawlNow.length} URL(s) to crawl — ${Object.entries(s.reasons).map(([k, n]) => `${k} ${n}`).join(', ')}; ${s.checked} checked, ${s.unchanged} unchanged`);
    return s;
  }

  async function settings(state: MonitorStateDoc): Promise<MonitorStatus['sync']> {
    const enabled = deps.intervalMinutes > 0 && state.autoSync !== false;
    const base = deps.latestCompleteRun ? await deps.latestCompleteRun() : undefined;
    const from = [state.lastSyncAt, state.autoSyncSince, base?.finishedAt].filter(Boolean).sort().pop();
    const schedulerOff = deps.schedulerEnabled === false;
    const next = enabled && !schedulerOff && base && from ? new Date(Date.parse(from) + deps.intervalMinutes * 60_000).toISOString() : undefined;
    return {
      autoSync: enabled, intervalHours: Math.round((deps.intervalMinutes / 60) * 10) / 10, ...(schedulerOff ? { schedulerOff: true } : {}), ...(state.lastSyncAt ? { lastSyncAt: state.lastSyncAt } : {}), ...(next ? { nextSyncAt: next } : {}),
      ...(base ? { baseline: { runId: base.id, type: base.type, at: base.finishedAt ?? base.startedAt, pages: base.urlCount ?? base.urlsCrawled } } : {}),
    };
  }

  async function status(): Promise<MonitorStatus> {
    const why = await blocked();
    const state = await finalize(await loadState());
    const events = (await r.monitorEvents.list()).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 100);
    const openErrors = (await r.monitorPages.list()).filter((p) => isError(p.status)).length;
    const history = [...(state.current ? [state.current] : []), ...(state.history ?? [])];
    return {
      available: !why, reason: why, running: !!running || state.current?.state === 'crawling', intervalMinutes: deps.intervalMinutes, sync: await settings(state),
      ...(history[0] ? { lastSync: history[0] } : {}), history, lastRun: state.lastRun, openErrors, events,
    };
  }

  const runNow = async (trigger: SyncSummary['trigger'] = 'manual', actor: Actor = SYSTEM_ACTOR): Promise<SyncSummary | { skipped: string }> => {
    const why = await blocked();
    if (why) return { skipped: why };
    if (running) return running;
    running = sync(trigger, actor).finally(() => { running = undefined; });
    return running;
  };

  return {
    /** One sync at a time per website; skipped while a crawl runs. */
    runNow,
    /** Scheduler (every minute): finishes a sync whose crawl ended, and runs Auto Sync when it is due. */
    async tick(): Promise<void> {
      const state = await finalize(await loadState());
      const st = await settings(state);
      if (!st.autoSync || !st.nextSyncAt || state.current) return;
      if (ctx.clock().getTime() < Date.parse(st.nextSyncAt)) return;
      await runNow('auto');
    },
    async get(actor: Actor) { await need(ctx, actor, 'crawls.view'); return status(); },
    /** Sync Now. */
    async run(actor: Actor) {
      await need(ctx, actor, 'crawls.run');
      const why = await blocked();
      if (why) throw new ApiError(409, 'CRAWLER_NOT_READY', `The website cannot be synced: ${why}`);
      const out = await runNow('manual', actor);
      if ('state' in out && out.state === 'skipped' && /No finished crawl/.test(out.message ?? '')) throw conflict(out.message!, 'NO_BASELINE_CRAWL');
      return status();
    },
    /** Auto Sync on / off. */
    async updateSettings(actor: Actor, input: { autoSync?: unknown }) {
      await need(ctx, actor, 'crawls.configure');
      if (typeof input.autoSync !== 'boolean') throw new ApiError(400, 'VALIDATION', 'autoSync must be true or false.');
      if (input.autoSync && deps.intervalMinutes <= 0) throw conflict('Auto Sync is turned off on this server (MONITOR_INTERVAL_MINUTES=0).', 'AUTO_SYNC_DISABLED');
      const state = await loadState();
      await saveState({ ...state, autoSync: input.autoSync, ...(input.autoSync && state.autoSync === false ? { autoSyncSince: iso() } : {}) });
      await audit(ctx, actor, 'site.auto_sync', 'crawl', 'auto-sync', `Auto Sync ${input.autoSync ? `turned on (every ${Math.round(deps.intervalMinutes / 60)} hours)` : 'turned off'}`);
      return status();
    },
  };
}
export type MonitorService = ReturnType<typeof createMonitorService>;
