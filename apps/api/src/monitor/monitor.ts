/**
 * Persistent incremental monitoring: between crawls, find what changed on the website from cheap signals and check only
 * those pages — never the whole site.
 *
 * Signals (each run):
 *  - sitemap files with conditional requests (If-None-Match / If-Modified-Since): a 304 means nothing to parse; a changed
 *    file is diffed against the stored entries → new URLs, changed lastmod, removed URLs;
 *  - Shopify Admin API updated_at (ported from the Shopify Optimizer): products / collections changed since the last run;
 *  - Shopify webhooks already recorded on the page inventory (lastModified after the last run);
 *  - re-checks of pages that answered an error last time (to report them resolved).
 * Each target is requested once with its stored validators (304 = unchanged, not parsed), on this website's host only,
 * allowed by robots.txt, through the crawler's HTTP client (SSRF guard, throttle, retries / back-off). The SEO
 * fingerprint (status, title, meta description, canonical, robots, H1) is compared with the last observation — or the
 * latest crawl's row — and each difference is stored once as an event with a stable id (no duplicates).
 */
import crypto from 'node:crypto';
import type { MonitorEvent, MonitorRunSummary, MonitorStatus } from '@sentinel/shared';
import { parseHtml } from '../crawler/parse';
import { isAllowed, parseRobots } from '../crawler/robots';
import { parseSitemapXml } from '../crawler/sitemap';
import { hostOf, isSameSite } from '../crawler/url';
import type { Collector } from '../crawler/engine';
import type { MonitorPageDoc, MonitorStateDoc } from '../repositories/types';
import type { Ctx } from '../services/context';
import { need, type Actor } from '../services/context';

export interface MonitorDeps {
  collector: Collector;
  userAgent: string;
  latestRow: (url: string) => Promise<{ row: { status?: number | null; finalStatus?: number | null; title?: string; metaDescription?: string; canonical?: string; metaRobots?: string; h1?: string[] } } | undefined>;
  shopifyChangedSince?: (since: string) => Promise<{ urls: string[]; capped: boolean; problem?: string }>;
  crawlRunning: () => Promise<boolean>;
  maxChecks: number;
  intervalMinutes: number;
}

const FIELDS = ['status', 'title', 'metaDescription', 'canonical', 'robots', 'h1'] as const;
type Fields = Partial<Record<(typeof FIELDS)[number], string>>;
const MAX_SITEMAP_FILES = 200;
const MAX_EVENTS = 1000;
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const norm = (u: string) => u.replace(/#.*$/, '');
const isError = (status: number | null | undefined) => status === null || status === undefined || status >= 400;

export function createMonitorService(ctx: Ctx, deps: MonitorDeps) {
  const r = ctx.repos;
  const http = deps.collector.http;
  let running: Promise<MonitorRunSummary> | undefined;

  async function blocked(): Promise<string | undefined> {
    const ready = ctx.engine.readiness();
    if (!ready.ready) return ready.reason;
    if ((await r.metrics.get()).source === 'demo') return 'This website holds the DEMO dataset.';
    return undefined;
  }

  /** GET with stored validators. 304 → notModified (no body). */
  async function conditional(url: string, v: { etag?: string; lastModified?: string }, accept: string) {
    const headers: Record<string, string> = { accept };
    if (v.etag) headers['if-none-match'] = v.etag;
    if (v.lastModified) headers['if-modified-since'] = v.lastModified;
    const res = await http.request(url, { headers, anyContentType: accept.includes('xml'), gunzip: /\.gz$/i.test(url) });
    return { res, notModified: res.finalStatus === 304, validators: { etag: res.headers['etag'] ?? v.etag, lastModified: res.headers['last-modified'] ?? v.lastModified } };
  }

  function fieldsOf(status: number | null, html?: string, url?: string, host?: string): Fields {
    const f: Fields = { status: status === null ? 'no response' : String(status) };
    if (html && url && host) {
      const p = parseHtml(html, url, host);
      f.title = (p.title ?? '').trim();
      f.metaDescription = (p.metaDescription ?? '').trim();
      f.canonical = p.canonicals[0] ?? '';
      f.robots = (p.metaRobots ?? '').toLowerCase();
      f.h1 = (p.h1s[0] ?? '').trim();
    }
    return f;
  }
  const fp = (f: Fields) => hash(FIELDS.map((k) => `${k}=${f[k] ?? ''}`).join('\n'));

  async function addEvent(events: MonitorEvent[], e: Omit<MonitorEvent, 'id' | 'at'>, key: string) {
    const id = `MON-${hash(key)}`;
    if (await r.monitorEvents.get(id)) return; // the same change was already recorded
    const ev: MonitorEvent = { id, at: ctx.clock().toISOString(), ...e };
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
    for (const f of Object.values(maps)) for (const [u, lm] of Object.entries(f.entries)) if (lm !== '\u0000index') out.set(u, lm);
    return out;
  };

  async function run(): Promise<MonitorRunSummary> {
    const t0 = Date.now();
    const now = ctx.clock().toISOString();
    const s: MonitorRunSummary = { at: now, ms: 0, sitemapsNotModified: 0, sitemapsFetched: 0, signals: { newInSitemap: 0, lastmodChanged: 0, removed: 0, shopify: 0, webhook: 0, recheck: 0 }, checked: 0, notModified: 0, deferred: 0, events: 0, notes: [] };
    const state: MonitorStateDoc = (await r.monitorState.get('state')) ?? { id: 'state', sitemaps: {} };
    const baseline = !state.lastRunAt;
    const base = ctx.engine.readiness().baseUrl!;
    const origin = new URL(base).origin;
    const host = new URL(base).host;

    // robots.txt: one request — the rules for the targets, and the sitemap locations.
    const rob = await http.request(`${origin}/robots.txt`, { headers: { accept: 'text/plain,*/*;q=0.5' } });
    const robots = parseRobots(rob.finalStatus === 200 ? rob.body ?? '' : '');
    const roots = robots.sitemaps.filter((u) => isSameSite(u, host)).slice(0, 10);
    const sitemaps = await readSitemaps(origin, roots.length ? roots : [`${origin}/sitemap.xml`], state, s);
    const before = pageEntries(state.sitemaps);
    const after = pageEntries(sitemaps);

    const targets = new Map<string, MonitorEvent['source']>();
    const add = (u: string, src: MonitorEvent['source']) => { const k = norm(u); if (!targets.has(k) && isSameSite(k, host)) targets.set(k, src); };
    const newInSitemap = new Set<string>();
    const events: MonitorEvent[] = [];

    // Re-checks first (errors seen last time), then new / changed sitemap URLs, Shopify, webhooks.
    for (const p of await r.monitorPages.list()) if (isError(p.status)) { add(p.url, 'recheck'); s.signals.recheck++; }
    if (!baseline) {
      for (const [u, lm] of after) {
        if (!before.has(u)) { add(u, 'sitemap'); newInSitemap.add(u); s.signals.newInSitemap++; }
        else if (lm && before.get(u) !== lm) { add(u, 'sitemap'); s.signals.lastmodChanged++; }
      }
      for (const u of before.keys()) {
        if (after.has(u) || Object.keys(sitemaps).length === 0) continue;
        s.signals.removed++;
        await addEvent(events, { url: u, kind: 'removed', source: 'sitemap' }, `removed|${u}|${state.lastRunAt}`);
      }
    }
    if (deps.shopifyChangedSince && state.lastShopifyCheck) {
      const sh = await deps.shopifyChangedSince(state.lastShopifyCheck);
      if (sh.problem) s.notes.push(`Shopify changes not read: ${sh.problem}`);
      if (sh.capped) s.notes.push('More than 100 Shopify products or collections changed: the newest 100 of each are checked; the next crawl covers the rest.');
      for (const u of sh.urls) { add(u, 'shopify'); s.signals.shopify++; }
    }
    if (state.lastRunAt) {
      for (const p of await r.sitePages.list()) if (p.lastModified && p.lastModified > state.lastRunAt) { add(p.url, 'webhook'); s.signals.webhook++; }
    }

    const list = [...targets].filter(([u]) => {
      try { const x = new URL(u); return isAllowed(robots, deps.userAgent, `${x.pathname}${x.search}`).allowed; } catch { return false; }
    });
    s.deferred = Math.max(0, list.length - deps.maxChecks);
    for (const [url, source] of list.slice(0, deps.maxChecks)) {
      const prev = await r.monitorPages.get(url);
      const { res, notModified, validators } = await conditional(url, prev ?? {}, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
      s.checked++;
      if (notModified && prev) {
        s.notModified++;
        await r.monitorPages.upsert({ ...prev, checkedAt: now });
        continue;
      }
      const status = res.finalStatus ?? null;
      const html = status === 200 && /html/i.test(res.contentType ?? '') ? res.body : undefined;
      const fields = fieldsOf(status, html, res.finalUrl ?? url, host);
      let before: Fields | undefined = prev?.fields;
      if (!before) {
        const row = (await deps.latestRow(url))?.row;
        if (row) {
          const st = row.finalStatus ?? row.status ?? null;
          before = { status: st === null ? 'no response' : String(st), title: (row.title ?? '').trim(), metaDescription: (row.metaDescription ?? '').trim(), canonical: row.canonical ?? '', robots: (row.metaRobots ?? '').toLowerCase(), h1: (row.h1?.[0] ?? '').trim() };
        }
      }
      const wasError = before ? isError(before.status === 'no response' ? null : Number(before.status)) : false;
      if (isError(status)) {
        if (!wasError) await addEvent(events, { url, kind: 'error', field: 'status', before: before?.status, after: fields.status, status, source }, `error|${url}|${fields.status}|${prev?.checkedAt ?? 'first'}`);
      } else if (wasError) {
        await addEvent(events, { url, kind: 'resolved', field: 'status', before: before?.status, after: fields.status, status, source }, `resolved|${url}|${now}`);
      }
      if (!before && newInSitemap.has(url)) await addEvent(events, { url, kind: 'new_page', status, after: fields.title, source }, `new|${url}`);
      if (before && html) {
        for (const k of FIELDS) {
          if (k === 'status' || before[k] === undefined || fields[k] === undefined || before[k] === fields[k]) continue;
          await addEvent(events, { url, kind: 'seo_change', field: k, before: before[k], after: fields[k], status, source }, `seo|${url}|${k}|${fields[k]}|${before[k]}`);
        }
      }
      const doc: MonitorPageDoc = { id: url, url, ...validators, status, fields: html || !prev ? fields : { ...prev.fields, status: fields.status }, fingerprint: '', checkedAt: now };
      doc.fingerprint = fp(doc.fields);
      await r.monitorPages.upsert(doc);
    }

    // Keep the event log bounded (oldest dropped).
    const all = await r.monitorEvents.list();
    if (all.length > MAX_EVENTS) for (const e of all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - MAX_EVENTS)) await r.monitorEvents.delete(e.id);

    s.events = events.length;
    s.baseline = baseline || undefined;
    if (baseline) s.notes.push('First run: the sitemap and current state were recorded as the baseline; changes are reported from the next run.');
    s.ms = Date.now() - t0;
    await r.monitorState.upsert({ id: 'state', sitemaps, lastRunAt: now, lastShopifyCheck: deps.shopifyChangedSince ? now : state.lastShopifyCheck, lastRun: s });
    ctx.log.info({ checked: s.checked, notModified: s.notModified, events: s.events, ms: s.ms }, 'incremental monitoring run');
    return s;
  }

  async function status(): Promise<MonitorStatus> {
    const why = await blocked();
    const state = await r.monitorState.get('state');
    const events = (await r.monitorEvents.list()).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 100);
    const openErrors = (await r.monitorPages.list()).filter((p) => isError(p.status)).length;
    return { available: !why, reason: why, running: !!running, intervalMinutes: deps.intervalMinutes, lastRun: state?.lastRun, openErrors, events };
  }

  return {
    /** One run at a time per website; skipped while a crawl runs (the crawl covers it). */
    async runNow(): Promise<MonitorRunSummary | { skipped: string }> {
      const why = await blocked();
      if (why) return { skipped: why };
      if (running) return running;
      if (await deps.crawlRunning()) return { skipped: 'a crawl of this website is running' };
      running = run().finally(() => { running = undefined; });
      return running;
    },
    /** Scheduler: run when the interval has passed since the last run. */
    async tick(): Promise<void> {
      if (deps.intervalMinutes <= 0) return;
      const last = (await r.monitorState.get('state'))?.lastRunAt;
      if (last && ctx.clock().getTime() - new Date(last).getTime() < deps.intervalMinutes * 60_000) return;
      await this.runNow();
    },
    async get(actor: Actor) { await need(ctx, actor, 'crawls.view'); return status(); },
    async run(actor: Actor) { await need(ctx, actor, 'crawls.run'); await this.runNow(); return status(); },
  };
}
export type MonitorService = ReturnType<typeof createMonitorService>;
