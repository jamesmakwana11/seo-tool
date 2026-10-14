/**
 * Shared plumbing for connector data-sync jobs (PDF §15 data sources → repositories).
 *
 * Every sync:
 *  - runs only when the integration is connected (a stored, successful connection test — see connectors/registry.ts);
 *  - never throws: failures are recorded via `recordSync(id, { ok: false })`, pushed onto `metrics.errors` and returned;
 *  - never returns or logs secrets (every message is passed through `redact()` with the env's secret values);
 *  - writes an audit entry `sync.<id>`.
 */
import { SYNCABLE_INTEGRATIONS, type DataSource, type IntegrationId, type PageTemplate, type SitePage, type SyncableIntegrationId } from '@sentinel/shared';
import { createGoogleAuth, parseServiceAccount, tokenFailure, type GoogleAuth } from '../connectors/googleAuth';
import { defaultFetch, errMsg, failureResult, httpRequest, is2xx, redact, secretValues, type FetchLike, type HttpResult } from '../connectors/http';
import { isLocalhostUrl } from '../connectors/connectors';
import type { MetricsDoc } from '../repositories/types';
import type { CrawlOutcome } from '../services/ports';
import { audit, SYSTEM_ACTOR, type Actor, type Ctx } from '../services/context';
import { templateOfPath } from '../services/crawls';

/** Single source: SYNCABLE_INTEGRATIONS in @sentinel/shared (the web app shows "Sync data now" for the same ids). */
export type SyncId = SyncableIntegrationId;
export const SYNC_IDS: readonly SyncId[] = SYNCABLE_INTEGRATIONS;
export const isSyncId = (id: string): id is SyncId => (SYNC_IDS as readonly string[]).includes(id);

export interface SyncDeps {
  /** Outbound HTTP (default: global fetch). Tests inject a stub. */
  fetchImpl?: FetchLike;
  /** Google OAuth helper (default: a fresh one built on `fetchImpl`). */
  googleAuth?: GoogleAuth;
  /** Who triggered the sync (audit attribution). Default: the system actor. */
  actor?: Actor;
  /**
   * Feeds connector-derived findings into the issue pipeline (same severity, SLA, alerts, auto-resolution as crawl
   * findings). Provided by the container (IssueService.ingestFindings); when absent, syncs only update metrics.
   */
  ingest?: (runId: string, outcome: Pick<CrawlOutcome, 'findings' | 'evaluatedChecks' | 'evaluatedTemplates' | 'urls' | 'pageTexts'>) => Promise<{ newIssues: number; resolvedIssues: number; recurringIssues: number }>;
}

export type SyncResult =
  | { id: SyncId; ran: false; reason: string }
  | { id: SyncId; ran: true; ok: true; summary: string; details: Record<string, unknown> }
  | { id: SyncId; ran: true; ok: false; error: string };

/** Thrown inside a sync body; its message must already be human-readable (it is redacted before use). */
export class SyncError extends Error {}

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const LABELS: Record<SyncId, string> = { ga4: 'Google Analytics 4', gsc: 'Google Search Console', psi_crux: 'Chrome UX Report (CrUX)' };

/** Connection check → body → recordSync / metrics.errors / audit. Never throws. */
export async function guardedSync(
  ctx: Ctx,
  id: SyncId,
  deps: SyncDeps,
  body: () => Promise<{ summary: string; details: Record<string, unknown> }>,
): Promise<SyncResult> {
  const label = LABELS[id];
  const actor = deps.actor ?? SYSTEM_ACTOR;
  const secrets = () => secretValues(ctx.env);
  let connected = false;
  try {
    connected = await ctx.integrations.isConnected(id as IntegrationId);
  } catch {
    connected = false;
  }
  if (!connected) {
    return { id, ran: false, reason: `${label} is not connected — set its credentials on the API server and pass "Test connection" under Settings → Integrations before data can sync.` };
  }

  const started = ctx.clock().getTime();
  try {
    const out = await body();
    const summary = redact(out.summary, secrets());
    await ctx.integrations.recordSync?.(id as IntegrationId, { ok: true });
    await audit(ctx, actor, `sync.${id}`, 'integration', id, summary);
    ctx.log.info({ sync: id, ok: true, ms: ctx.clock().getTime() - started }, 'connector sync complete');
    return { id, ran: true, ok: true, summary, details: out.details };
  } catch (e) {
    const error = redact(`${label} sync failed: ${errMsg(e)}`, secrets());
    try {
      await ctx.integrations.recordSync?.(id as IntegrationId, { ok: false, error });
      const m = await ctx.repos.metrics.get();
      const at = ctx.clock().toISOString();
      m.errors.push({ id: `ERR-sync-${id}-${at}`, at, level: 'error', component: `sync.${id}`, message: error });
      await ctx.repos.metrics.set(m);
      await audit(ctx, actor, `sync.${id}`, 'integration', id, error);
    } catch (inner) {
      ctx.log.error({ sync: id, err: redact(errMsg(inner), secrets()) }, 'could not record sync failure');
    }
    ctx.log.warn({ sync: id, ok: false, ms: ctx.clock().getTime() - started }, 'connector sync failed');
    return { id, ran: true, ok: false, error };
  }
}

// ---------------------------------------------------------------------------------------------- HTTP helpers

export async function googleToken(ctx: Ctx, deps: SyncDeps, label: string, rawJson: string | undefined, scope: string): Promise<string> {
  const sa = parseServiceAccount(rawJson);
  if ('error' in sa) throw new SyncError(`${label}: ${sa.error}`);
  const auth = deps.googleAuth ?? createGoogleAuth({ fetchImpl: deps.fetchImpl ?? defaultFetch, clock: ctx.clock });
  const tok = await auth.serviceAccountToken(sa, scope);
  if (!tok.ok) throw new SyncError(tokenFailure(label, tok).result);
  return tok.accessToken;
}

/** POST JSON and return the parsed body, or throw a SyncError carrying an honest, secret-free message. */
export async function postJson(deps: SyncDeps, label: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown; raw: HttpResult }> {
  const r = await httpRequest(deps.fetchImpl ?? defaultFetch, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }, 30_000);
  if (!is2xx(r)) throw new SyncError(failureResult(label, url, r).result);
  return { status: r.status, json: r.json, raw: r };
}

// ---------------------------------------------------------------------------------------------- site + pages

/** Origin of the audited site: CRAWLER_BASE_URL (non-loopback) → config.site.baseUrl → https://deodap.in. */
export async function siteOrigin(ctx: Ctx): Promise<string> {
  const candidates = [!isLocalhostUrl(ctx.env.CRAWLER_BASE_URL) ? ctx.env.CRAWLER_BASE_URL : undefined, (await ctx.repos.config.get()).site.baseUrl, 'https://deodap.in'];
  for (const c of candidates) {
    if (!c) continue;
    try {
      return new URL(c).origin;
    } catch {
      /* next */
    }
  }
  return 'https://deodap.in';
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

/**
 * Normalises a GA4 landing page / GSC page URL / crawler path to a comparable site path:
 * query + fragment dropped, trailing slash dropped (except "/"), Shopify collection-scoped product URLs
 * (/collections/x/products/y) folded into their canonical /products/y. Returns undefined for off-site URLs
 * and GA4 placeholders such as "(not set)".
 */
export function normalizePath(input: string, siteHost?: string): string | undefined {
  let p = input.trim();
  if (!p || p === '(not set)' || p === '(other)') return undefined;
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      if (siteHost && bareHost(u.host) !== bareHost(siteHost)) return undefined;
      p = u.pathname;
    } catch {
      return undefined;
    }
  }
  p = p.split(/[?#]/)[0];
  if (!p.startsWith('/')) return undefined;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const scoped = /^\/collections\/[^/]+\/products\/([^/]+)$/.exec(p);
  if (scoped) p = `/products/${scoped[1]}`;
  return p || '/';
}

/** Templates for which a sync may create a SitePage that the crawler has not seen yet. */
const CREATABLE: PageTemplate[] = ['home', 'collection', 'product', 'blog_article', 'blog_index', 'page'];

/** Live (non-DEMO) site pages indexed by normalised path. DEMO inventory is never written with live data. */
export async function livePagesByPath(ctx: Ctx): Promise<Map<string, SitePage[]>> {
  const out = new Map<string, SitePage[]>();
  for (const p of await ctx.repos.sitePages.list()) {
    if (p.source === 'demo') continue;
    const key = normalizePath(p.path || p.url);
    if (!key) continue;
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return out;
}

/**
 * Applies `patch` to every live page at `path`; creates a `source: 'live'` page when none exists and the template
 * is a real content template. Returns the number of pages created.
 */
export async function upsertLivePage(ctx: Ctx, byPath: Map<string, SitePage[]>, origin: string, path: string, patch: Partial<SitePage>, createdBy: string): Promise<number> {
  const existing = byPath.get(path);
  if (existing?.length) {
    const next = existing.map((p) => ({ ...p, ...patch }));
    for (const p of next) await ctx.repos.sitePages.update(p);
    byPath.set(path, next);
    return 0;
  }
  const template = templateOfPath(path);
  if (!CREATABLE.includes(template)) return 0;
  const url = `${origin}${path}`;
  const page: SitePage = {
    id: `page:${url}`, url, path, template, title: path, tier: template === 'home' ? 1 : 3,
    tierReason: template === 'home' ? 'Homepage' : `Seen in ${createdBy}; tier not computed yet`,
    // Google reported search/visit data for it; the crawler re-checks real indexability on its next run.
    indexable: true, source: 'live', ...patch,
  };
  await ctx.repos.sitePages.upsert(page);
  byPath.set(path, [page]);
  return 1;
}

// ---------------------------------------------------------------------------------------------- metrics series

/** True when a series still holds DEMO data (doc-level DEMO flag or any DEMO point) — it must be replaced, not merged. */
export function seriesIsDemo(m: MetricsDoc, series: { source: DataSource }[]): boolean {
  return m.source === 'demo' || series.some((p) => p.source === 'demo');
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
