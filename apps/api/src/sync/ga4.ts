/**
 * GA4 → page value + page-value tiers (PDF §3.1 "Page value tiers (computed nightly)", §14, §15 "GA4 API — Revenue/traffic
 * for page tiers").
 *
 * Request (GA4 Data API v1beta, service-account bearer token, scope analytics.readonly):
 *   POST https://analyticsdata.googleapis.com/v1beta/properties/{GA4_PROPERTY_ID}:runReport
 *   { dateRanges: [{ startDate: "{tier1LookbackDays}daysAgo", endDate: "yesterday" }],
 *     dimensions: [{ name: "landingPage" }, { name: "sessionDefaultChannelGroup" }],
 *     metrics: [{ name: "sessions" }, { name: "purchaseRevenue" }], limit, offset }
 * One report gives both values per landing page: revenue90d = purchaseRevenue summed over ALL channels (PDF ranks by
 * "revenue"), organicSessions90d = sessions where sessionDefaultChannelGroup == "Organic Search".
 */
import type { PageTier, SentinelConfig, SitePage } from '@sentinel/shared';
import type { Ctx } from '../services/context';
import { GA4_SCOPE, googleToken, guardedSync, livePagesByPath, normalizePath, num, postJson, siteOrigin, SyncError, upsertLivePage, type SyncDeps, type SyncResult } from './common';

const PAGE_SIZE = 100_000;
const MAX_PAGES = 10;

interface Ga4Row { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }

export async function ga4Tiers(ctx: Ctx, deps: SyncDeps = {}): Promise<SyncResult> {
  return guardedSync(ctx, 'ga4', deps, async () => {
    const label = 'Google Analytics 4';
    const cfg = await ctx.repos.config.get();
    const days = cfg.tiers.tier1LookbackDays;
    const pid = (ctx.env.GA4_PROPERTY_ID ?? '').replace(/^properties\//, '').trim();
    if (!pid) throw new SyncError(`${label}: GA4_PROPERTY_ID is not set`);
    const token = await googleToken(ctx, deps, label, ctx.env.GA4_SERVICE_ACCOUNT_JSON, GA4_SCOPE);
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(pid)}:runReport`;

    // ---- fetch (paginated)
    const value = new Map<string, { revenue: number; organic: number }>();
    let offset = 0;
    let rowCount = 0;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { json } = await postJson(deps, label, url, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
        dimensions: [{ name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'purchaseRevenue' }],
        limit: PAGE_SIZE,
        offset,
      }, { authorization: `Bearer ${token}` });
      const body = (json ?? {}) as { rows?: Ga4Row[]; rowCount?: number };
      const rows = Array.isArray(body.rows) ? body.rows : [];
      rowCount = typeof body.rowCount === 'number' ? body.rowCount : rows.length;
      for (const r of rows) {
        const path = normalizePath(r.dimensionValues?.[0]?.value ?? '');
        if (!path) continue;
        const channel = r.dimensionValues?.[1]?.value ?? '';
        const sessions = num(r.metricValues?.[0]?.value);
        const revenue = num(r.metricValues?.[1]?.value);
        const cur = value.get(path) ?? { revenue: 0, organic: 0 };
        cur.revenue += revenue;
        if (channel === 'Organic Search') cur.organic += sessions;
        value.set(path, cur);
      }
      offset += rows.length;
      if (rows.length === 0 || offset >= rowCount) {
        complete = true;
        break;
      }
    }

    // ---- write onto the live page inventory
    const origin = await siteOrigin(ctx);
    const byPath = await livePagesByPath(ctx);
    let updated = 0;
    let created = 0;
    for (const [path, v] of value) {
      if (v.revenue <= 0 && v.organic <= 0) continue;
      const patch = { revenue90d: round2(v.revenue), organicSessions90d: Math.round(v.organic) };
      const had = byPath.has(path);
      created += await upsertLivePage(ctx, byPath, origin, path, patch, `GA4 (last ${days} days)`);
      if (had) updated++;
    }
    // GA4 omits zero rows: when the full report was read, every other live page truly had no revenue/organic sessions.
    let zeroed = 0;
    if (complete) {
      for (const [path, pages] of byPath) {
        const v = value.get(path);
        if (v && (v.revenue > 0 || v.organic > 0)) continue;
        for (const p of pages) {
          if (p.revenue90d === 0 && p.organicSessions90d === 0) continue;
          await ctx.repos.sitePages.update({ ...p, revenue90d: 0, organicSessions90d: 0 });
          zeroed++;
        }
      }
    }

    const tiers = await recomputeTiers(ctx);
    const totals = [...value.values()].reduce((a, v) => ({ revenue: a.revenue + v.revenue, organic: a.organic + v.organic }), { revenue: 0, organic: 0 });
    const summary =
      `GA4 sync (last ${days} days, property ${pid}): ${value.size} landing pages, revenue ${round2(totals.revenue)}, ${Math.round(totals.organic)} organic sessions; ` +
      `${updated} pages updated, ${created} created, ${zeroed} set to zero${complete ? '' : ` (report truncated at ${offset} of ${rowCount} rows — pages not in the read rows were left unchanged)`}. ` +
      `Tiers recomputed: Tier 1 ${tiers.counts[1]}, Tier 2 ${tiers.counts[2]}, Tier 3 ${tiers.counts[3]}.`;
    return { summary, details: { property: pid, lookbackDays: days, landingPages: value.size, rowCount, complete, updated, created, zeroed, tiers: tiers.counts, tierChanges: tiers.changed } };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------- tiers (PDF §3.1)

export interface TierAssignment { tier: PageTier; reason: string }

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * PDF §3.1 page value tiers, verbatim:
 *  - Tier 1 (Money pages): Homepage, top 20 collections, top 200 products by last-90-day revenue or organic sessions.
 *  - Tier 2 (Working pages): All other indexable collections, products with any organic impressions, blog posts with clicks.
 *  - Tier 3 (Long tail): Everything else indexable.
 * Ranking: revenue first; pages without revenue are ranked by organic sessions. A page with neither is not ranked.
 * Pages that are not indexable and fit no Tier 1/2 rule are Tier 3 (there is no lower tier).
 */
export function computeTiers(pages: SitePage[], cfg: Pick<SentinelConfig, 'tiers'>): Map<string, TierAssignment> {
  const { tier1TopCollections: nCol, tier1TopProducts: nProd, tier1LookbackDays: days } = cfg.tiers;
  const out = new Map<string, TierAssignment>();
  const hasValueData = pages.some((p) => p.revenue90d !== undefined || p.organicSessions90d !== undefined);
  const hasSearchData = pages.some((p) => p.impressions28d !== undefined || p.clicks28d !== undefined);
  const valued = (p: SitePage) => (p.revenue90d ?? 0) > 0 || (p.organicSessions90d ?? 0) > 0;
  const rank = (a: SitePage, b: SitePage) =>
    (b.revenue90d ?? 0) - (a.revenue90d ?? 0) || (b.organicSessions90d ?? 0) - (a.organicSessions90d ?? 0) || a.path.localeCompare(b.path);
  const basis = (p: SitePage) =>
    (p.revenue90d ?? 0) > 0
      ? `${inr(p.revenue90d!)} revenue, ${p.organicSessions90d ?? 0} organic sessions in the last ${days} days`
      : `no revenue; ranked by ${p.organicSessions90d ?? 0} organic sessions in the last ${days} days`;

  for (const p of pages) if (p.template === 'home' || p.path === '/') out.set(p.id, { tier: 1, reason: 'Tier 1 — Homepage (always a money page, PDF §3.1).' });

  const top = (template: 'collection' | 'product', n: number, noun: string) => {
    const ranked = pages.filter((p) => p.template === template && !out.has(p.id) && valued(p)).sort(rank);
    ranked.slice(0, n).forEach((p, i) =>
      out.set(p.id, { tier: 1, reason: `Tier 1 — top ${n} ${noun} by last-${days}-day revenue or organic sessions: #${i + 1} (${basis(p)}).` }));
  };
  top('collection', nCol, 'collections');
  top('product', nProd, 'products');

  for (const p of pages) {
    if (out.has(p.id)) continue;
    const notIndexable = p.indexable ? '' : ' Page is not indexable.';
    if (p.template === 'collection' && p.indexable) {
      out.set(p.id, { tier: 2, reason: `Tier 2 — indexable collection outside the top ${nCol} by revenue/organic sessions (PDF §3.1: all other indexable collections).` });
    } else if (p.template === 'product' && (p.impressions28d ?? 0) > 0) {
      out.set(p.id, { tier: 2, reason: `Tier 2 — product with organic impressions (${p.impressions28d} in the last 28 days, Search Console) outside the top ${nProd}.${notIndexable}` });
    } else if (p.template === 'blog_article' && (p.clicks28d ?? 0) > 0) {
      out.set(p.id, { tier: 2, reason: `Tier 2 — blog post with organic clicks (${p.clicks28d} in the last 28 days, Search Console).${notIndexable}` });
    } else {
      const why: string[] = [];
      if (p.template === 'collection') why.push('collection is not indexable');
      if (p.template === 'product') why.push(hasSearchData ? 'no organic impressions in the last 28 days' : 'no Search Console impressions synced yet');
      if (p.template === 'blog_article') why.push(hasSearchData ? 'no organic clicks in the last 28 days' : 'no Search Console clicks synced yet');
      if ((p.template === 'collection' || p.template === 'product') && !hasValueData) why.push('no GA4 revenue/session data synced yet');
      else if ((p.template === 'collection' || p.template === 'product') && valued(p)) why.push(`outside the top ${p.template === 'collection' ? nCol : nProd} by value`);
      out.set(p.id, { tier: 3, reason: `Tier 3 — long tail${why.length ? ` (${why.join('; ')})` : ''}.${notIndexable}` });
    }
  }
  return out;
}

/** Recomputes tiers on the live page inventory (DEMO pages untouched) and persists changes. */
export async function recomputeTiers(ctx: Ctx): Promise<{ counts: Record<PageTier, number>; changed: number }> {
  const cfg = await ctx.repos.config.get();
  const pages = (await ctx.repos.sitePages.list()).filter((p) => p.source !== 'demo');
  const assigned = computeTiers(pages, cfg);
  const counts: Record<PageTier, number> = { 1: 0, 2: 0, 3: 0 };
  let changed = 0;
  for (const p of pages) {
    const a = assigned.get(p.id)!;
    counts[a.tier]++;
    if (a.tier !== p.tier || a.reason !== p.tierReason) {
      if (a.tier !== p.tier) changed++;
      await ctx.repos.sitePages.update({ ...p, tier: a.tier, tierReason: a.reason });
    }
  }
  return { counts, changed };
}
