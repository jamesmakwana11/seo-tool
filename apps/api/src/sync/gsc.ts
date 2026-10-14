/**
 * Search Console → visibility trend, page impressions/clicks, striking-distance queries (PDF §6.3, §15).
 *
 * Requests (Search Console API, webmasters/v3, service-account bearer token, scope webmasters.readonly):
 *   POST https://www.googleapis.com/webmasters/v3/sites/{urlencoded GSC_PROPERTY}/searchAnalytics/query
 *     1. { startDate, endDate, dimensions: ["date"], type: "web", rowLimit: 1000 }                 → metrics.visibility
 *     2. { startDate, endDate, dimensions: ["page"], type: "web", rowLimit: 25000, startRow }      → sitePages impressions28d/clicks28d
 *     3. { startDate, endDate, dimensions: ["query","page"], type: "web", rowLimit: 25000, startRow } → metrics.striking
 * The window is the latest 28 days for which Search Console returned daily data (it lags ~2–3 days).
 *
 * NOT synced: index coverage (indexed / excluded / crawled-not-indexed counts). The public Search Console API does not
 * expose Page-indexing report totals (only per-URL inspection), so `metrics.indexation` is left untouched — never faked.
 */
import { createHash } from 'node:crypto';
import type { StrikingDistanceQuery } from '@sentinel/shared';
import type { MetricsDoc } from '../repositories/types';
import type { Ctx } from '../services/context';
import { recomputeTiers } from './ga4';
import {
  addDays, googleToken, GSC_SCOPE, guardedSync, livePagesByPath, normalizePath, num, postJson, seriesIsDemo, siteOrigin, SyncError, upsertLivePage, ymd,
  type SyncDeps, type SyncResult,
} from './common';

const WINDOW_DAYS = 28;
const ROW_LIMIT = 25_000;
const MAX_PAGES = 4;
/** Striking-distance list cap (sorted by impressions) — the PDF calls it "the daily quick-win list". */
const STRIKING_CAP = 500;

interface GscRow { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }

export async function gscSearch(ctx: Ctx, deps: SyncDeps = {}): Promise<SyncResult> {
  return guardedSync(ctx, 'gsc', deps, async () => {
    const label = 'Google Search Console';
    const property = (ctx.env.GSC_PROPERTY ?? '').trim();
    if (!property) throw new SyncError(`${label}: GSC_PROPERTY is not set`);
    const token = await googleToken(ctx, deps, label, ctx.env.GSC_SERVICE_ACCOUNT_JSON, GSC_SCOPE);
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
    const auth = { authorization: `Bearer ${token}` };
    const query = async (body: Record<string, unknown>): Promise<GscRow[]> => {
      const { json } = await postJson(deps, label, url, { type: 'web', ...body }, auth);
      const rows = (json as { rows?: GscRow[] } | undefined)?.rows;
      return Array.isArray(rows) ? rows : [];
    };
    const paged = async (body: Record<string, unknown>): Promise<{ rows: GscRow[]; complete: boolean }> => {
      const all: GscRow[] = [];
      for (let i = 0; i < MAX_PAGES; i++) {
        const rows = await query({ ...body, rowLimit: ROW_LIMIT, startRow: i * ROW_LIMIT });
        all.push(...rows);
        if (rows.length < ROW_LIMIT) return { rows: all, complete: true };
      }
      return { rows: all, complete: false };
    };

    // ---- 1. daily visibility (request a little more than 28 days to absorb the reporting lag; keep the latest 28)
    const today = ctx.clock();
    const daily = (await query({ startDate: ymd(addDays(today, -(WINDOW_DAYS + 4))), endDate: ymd(addDays(today, -1)), dimensions: ['date'], rowLimit: 1000 }))
      .filter((r) => typeof r.keys?.[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.keys[0]))
      .sort((a, b) => a.keys![0].localeCompare(b.keys![0]))
      .slice(-WINDOW_DAYS);
    const points = daily.map((r) => ({
      date: r.keys![0], clicks: Math.round(num(r.clicks)), impressions: Math.round(num(r.impressions)), avgPosition: Math.round(num(r.position) * 10) / 10, source: 'live' as const,
    }));
    const endDate = points.length ? points[points.length - 1].date : ymd(addDays(today, -1));
    const startDate = points.length ? ymd(addDays(new Date(`${endDate}T00:00:00Z`), -(WINDOW_DAYS - 1))) : ymd(addDays(today, -WINDOW_DAYS));

    // ---- 2. page-level impressions / clicks
    const origin = await siteOrigin(ctx);
    const siteHost = new URL(origin).host;
    const pageRes = await paged({ startDate, endDate, dimensions: ['page'] });
    const perPath = new Map<string, { impressions: number; clicks: number }>();
    let offSite = 0;
    for (const r of pageRes.rows) {
      const path = normalizePath(r.keys?.[0] ?? '', siteHost);
      if (!path) { offSite++; continue; }
      const cur = perPath.get(path) ?? { impressions: 0, clicks: 0 };
      cur.impressions += num(r.impressions);
      cur.clicks += num(r.clicks);
      perPath.set(path, cur);
    }
    const byPath = await livePagesByPath(ctx);
    let updated = 0;
    let created = 0;
    for (const [path, v] of perPath) {
      const had = byPath.has(path);
      created += await upsertLivePage(ctx, byPath, origin, path, { impressions28d: Math.round(v.impressions), clicks28d: Math.round(v.clicks) }, 'Search Console (last 28 days)');
      if (had) updated++;
    }
    let zeroed = 0;
    if (pageRes.complete) {
      for (const [path, pages] of byPath) {
        if (perPath.has(path)) continue;
        for (const p of pages) {
          if (p.impressions28d === 0 && p.clicks28d === 0) continue;
          await ctx.repos.sitePages.update({ ...p, impressions28d: 0, clicks28d: 0 });
          zeroed++;
        }
      }
    }

    // ---- 3. striking-distance queries (PDF §6.3: "Queries ranking positions 5–20 with meaningful impressions")
    const cfg = await ctx.repos.config.get();
    const minPos = cfg.thresholds.strikingMinPosition ?? 5;
    const maxPos = cfg.thresholds.strikingMaxPosition ?? 20;
    const minImpr = cfg.thresholds.strikingMinImpressions ?? 100;
    const qp = await paged({ startDate, endDate, dimensions: ['query', 'page'] });
    const striking: StrikingDistanceQuery[] = qp.rows
      .filter((r) => typeof r.keys?.[0] === 'string' && typeof r.keys?.[1] === 'string')
      .filter((r) => num(r.position) >= minPos && num(r.position) <= maxPos && num(r.impressions) >= minImpr)
      .sort((a, b) => num(b.impressions) - num(a.impressions))
      .slice(0, STRIKING_CAP)
      .map((r) => {
        const [q, page] = r.keys as [string, string];
        return {
          id: `SD-${createHash('sha1').update(`${q}\u0000${page}`).digest('hex').slice(0, 12)}`,
          query: q, url: page,
          position: Math.round(num(r.position) * 10) / 10,
          impressions: Math.round(num(r.impressions)),
          clicks: Math.round(num(r.clicks)),
          ctr: Math.round(num(r.ctr) * 1000) / 10, // Search Console returns a fraction; the app displays percent
          source: 'live',
        };
      });

    // ---- write metrics (DEMO series are replaced wholesale, never mixed with live points)
    const m: MetricsDoc = await ctx.repos.metrics.get();
    const visDemo = seriesIsDemo(m, m.visibility);
    if (visDemo) m.visibility = points;
    else {
      const byDate = new Map(m.visibility.map((p) => [p.date, p]));
      for (const p of points) byDate.set(p.date, p);
      m.visibility = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    }
    const strikingDemo = seriesIsDemo(m, m.striking);
    m.striking = striking; // a current snapshot: always replaced
    await ctx.repos.metrics.set(m);

    const tiers = await recomputeTiers(ctx);
    const clicks = points.reduce((a, p) => a + p.clicks, 0);
    const impressions = points.reduce((a, p) => a + p.impressions, 0);
    const summary =
      `Search Console sync (${property}, ${startDate}…${endDate}): ${points.length} daily points (${clicks} clicks, ${impressions} impressions)${visDemo ? ' replaced the DEMO visibility series' : ''}; ` +
      `${perPath.size} pages with impressions (${updated} updated, ${created} created, ${zeroed} set to zero${pageRes.complete ? '' : '; page report truncated — unseen pages left unchanged'}${offSite ? `, ${offSite} off-site URLs ignored` : ''}); ` +
      `${striking.length} striking-distance queries (positions ${minPos}–${maxPos}, ≥${minImpr} impressions)${strikingDemo ? ' replaced the DEMO list' : ''}${qp.complete ? '' : ' from a truncated query report'}. ` +
      `Index coverage is not available from the Search Console API — indexation series unchanged. Tiers recomputed: Tier 1 ${tiers.counts[1]}, Tier 2 ${tiers.counts[2]}, Tier 3 ${tiers.counts[3]}.`;
    return {
      summary,
      details: {
        property, startDate, endDate, visibilityPoints: points.length, replacedDemoVisibility: visDemo, pagesWithImpressions: perPath.size, updated, created, zeroed,
        striking: striking.length, replacedDemoStriking: strikingDemo, indexation: 'not available from the Search Console API — left unchanged', tiers: tiers.counts,
      },
    };
  });
}
