/**
 * GA4 and Search Console reports for one website, read with the mapped Google account (read-only scopes).
 *
 * GA4 — Analytics Data API, one batchRunReports call (5 reports):
 *   totals (current + comparison window), daily trend, channels, source / medium, top pages.
 * Search Console — Search Analytics API (searchAnalytics/query) for totals, daily, queries, pages, countries, devices,
 *   plus the Sitemaps report (submitted / indexed counts where Google still reports them). Search Console data lags
 *   about two days, so its windows end two days ago.
 */
import type { DateWindow, Ga4Report, Ga4Totals, GscReport, GscRowOut, GscSitemap, GscTotals, ReportCompare, ReportRange } from '@sentinel/shared';
import { GA4_DATA, GSC_API, type GoogleCore } from './core';
import { GoogleError } from './http';

const DAY = 86_400_000;
const IST = 330 * 60_000;
export const ymdIst = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** Report window ending `lagDays` before today (IST) and its comparison window. */
export function windows(now: Date, range: ReportRange, compare: ReportCompare, lagDays: number): { cur: DateWindow; prev: DateWindow } {
  const end = shift(ymdIst(now), -lagDays);
  const start = shift(end, -(range - 1));
  // Year-over-year uses 364 days so weekdays line up.
  const prev = compare === 'year' ? { start: shift(start, -364), end: shift(end, -364) } : { start: shift(start, -range), end: shift(start, -1) };
  return { cur: { start, end }, prev };
}

const n = (v: unknown) => { const x = typeof v === 'number' ? v : Number(v); return Number.isFinite(x) ? x : 0; };
const r1 = (v: number) => Math.round(v * 10) / 10;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

// ------------------------------------------------------------------------------------------------ GA4

interface Ga4Row { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }
interface Ga4Rep { rows?: Ga4Row[] }

const TOTAL_METRICS = ['activeUsers', 'newUsers', 'sessions', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'screenPageViews'] as const;

function ga4Requests(cur: DateWindow, prev: DateWindow, conv: 'keyEvents' | 'conversions') {
  const dr = (w: DateWindow, name?: string) => ({ startDate: w.start, endDate: w.end, ...(name ? { name } : {}) });
  const metric = (name: string) => ({ name });
  const top = (dim: string, metrics: string[], orderBy: string, limit: number) => ({
    dateRanges: [dr(cur)], dimensions: [{ name: dim }], metrics: metrics.map(metric), orderBys: [{ metric: { metricName: orderBy }, desc: true }], limit,
  });
  return [
    { dateRanges: [dr(cur, 'current'), dr(prev, 'previous')], metrics: [...TOTAL_METRICS, conv].map(metric) },
    { dateRanges: [dr(cur)], dimensions: [{ name: 'date' }], metrics: ['activeUsers', 'sessions', conv].map(metric), orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
    top('sessionDefaultChannelGroup', ['sessions', 'activeUsers', 'engagementRate', conv], 'sessions', 20),
    top('sessionSourceMedium', ['sessions', 'activeUsers', 'engagementRate', conv], 'sessions', 25),
    top('pagePath', ['screenPageViews', 'activeUsers', 'engagementRate'], 'screenPageViews', 25),
  ];
}

function totalsFrom(row: Ga4Row | undefined): Ga4Totals {
  const v = (i: number) => n(row?.metricValues?.[i]?.value);
  return {
    activeUsers: v(0), newUsers: v(1), sessions: v(2), engagedSessions: v(3), engagementRate: r4(v(4)), averageSessionDuration: r1(v(5)), screenPageViews: v(6), conversions: r1(v(7)),
  };
}

export async function fetchGa4(core: GoogleCore, accountId: string, propertyId: string, now: Date, range: ReportRange, compare: ReportCompare): Promise<Omit<Ga4Report, 'propertyName' | 'accountEmail' | 'fetchedAt' | 'cached'>> {
  const { cur, prev } = windows(now, range, compare, 1);
  const url = `${GA4_DATA}/properties/${encodeURIComponent(propertyId)}:batchRunReports`;
  let conv: 'keyEvents' | 'conversions' = 'keyEvents';
  let res: { reports?: Ga4Rep[] };
  try {
    res = await core.api(accountId, 'Google Analytics 4', url, { method: 'POST', body: JSON.stringify({ requests: ga4Requests(cur, prev, conv) }) });
  } catch (e) {
    // Older properties / API versions know key events as "conversions".
    if (!(e instanceof GoogleError && e.code === 'bad_request' && /keyEvents/i.test(e.message))) throw e;
    conv = 'conversions';
    res = await core.api(accountId, 'Google Analytics 4', url, { method: 'POST', body: JSON.stringify({ requests: ga4Requests(cur, prev, conv) }) });
  }
  const [tot, daily, channels, sources, pages] = res.reports ?? [];
  const byRange = (name: string) => tot?.rows?.find((r) => r.dimensionValues?.some((d) => d.value === name)) ?? (name === 'current' ? tot?.rows?.[0] : tot?.rows?.[1]);
  const dims = (r: Ga4Row) => r.dimensionValues?.[0]?.value ?? '';
  const mv = (r: Ga4Row, i: number) => n(r.metricValues?.[i]?.value);
  return {
    propertyId, range: cur, compareRange: prev, compare, conversionMetric: conv,
    totals: totalsFrom(byRange('current')), previous: totalsFrom(byRange('previous')),
    daily: (daily?.rows ?? []).map((r) => { const d = dims(r); return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, activeUsers: mv(r, 0), sessions: mv(r, 1), conversions: r1(mv(r, 2)) }; })
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)).sort((a, b) => a.date.localeCompare(b.date)),
    channels: (channels?.rows ?? []).map((r) => ({ name: dims(r) || '(not set)', sessions: mv(r, 0), activeUsers: mv(r, 1), engagementRate: r4(mv(r, 2)), conversions: r1(mv(r, 3)) })),
    sources: (sources?.rows ?? []).map((r) => ({ name: dims(r) || '(not set)', sessions: mv(r, 0), activeUsers: mv(r, 1), engagementRate: r4(mv(r, 2)), conversions: r1(mv(r, 3)) })),
    pages: (pages?.rows ?? []).map((r) => ({ path: dims(r) || '/', views: mv(r, 0), activeUsers: mv(r, 1), engagementRate: r4(mv(r, 2)) })),
  };
}

// ------------------------------------------------------------------------------------------------ Search Console

interface GscRow { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }

const toRow = (r: GscRow): GscRowOut => ({ key: r.keys?.[0] ?? '', clicks: n(r.clicks), impressions: n(r.impressions), ctr: r4(n(r.ctr)), position: r1(n(r.position)) });
const totalsOf = (rows: GscRow[]): GscTotals => {
  const r = rows[0];
  return r ? { clicks: n(r.clicks), impressions: n(r.impressions), ctr: r4(n(r.ctr)), position: r1(n(r.position)) } : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
};

export async function fetchGsc(core: GoogleCore, accountId: string, property: string, now: Date, range: ReportRange, compare: ReportCompare): Promise<Omit<GscReport, 'accountEmail' | 'fetchedAt' | 'cached'>> {
  const { cur, prev } = windows(now, range, compare, 2);
  const url = `${GSC_API}/sites/${encodeURIComponent(property)}/searchAnalytics/query`;
  const q = async (w: DateWindow, body: Record<string, unknown>) => ((await core.api<{ rows?: GscRow[] }>(accountId, 'Google Search Console', url, {
    method: 'POST', body: JSON.stringify({ startDate: w.start, endDate: w.end, type: 'web', dataState: 'final', ...body }),
  })).rows ?? []);
  const [tot, prevTot, daily, queries, pages, countries, devices] = await Promise.all([
    q(cur, {}), q(prev, {}),
    q(cur, { dimensions: ['date'], rowLimit: 400 }),
    q(cur, { dimensions: ['query'], rowLimit: 25 }),
    q(cur, { dimensions: ['page'], rowLimit: 25 }),
    q(cur, { dimensions: ['country'], rowLimit: 15 }),
    q(cur, { dimensions: ['device'], rowLimit: 5 }),
  ]);
  let sitemaps: GscSitemap[] = [];
  let sitemapsError: string | undefined;
  try {
    const j = await core.api<{ sitemap?: { path?: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; isSitemapsIndex?: boolean; warnings?: string; errors?: string; contents?: { type?: string; submitted?: string; indexed?: string }[] }[] }>(
      accountId, 'Google Search Console (sitemaps)', `${GSC_API}/sites/${encodeURIComponent(property)}/sitemaps`,
    );
    sitemaps = (j.sitemap ?? []).filter((s) => s.path).map((s) => ({
      path: s.path!, lastSubmitted: s.lastSubmitted, lastDownloaded: s.lastDownloaded, isPending: s.isPending, isSitemapsIndex: s.isSitemapsIndex,
      warnings: n(s.warnings), errors: n(s.errors),
      contents: (s.contents ?? []).map((c) => ({ type: c.type ?? 'web', submitted: n(c.submitted), ...(c.indexed !== undefined ? { indexed: n(c.indexed) } : {}) })),
    }));
  } catch (e) {
    sitemapsError = (e as Error).message;
  }
  return {
    property, range: cur, compareRange: prev, compare,
    totals: totalsOf(tot), previous: totalsOf(prevTot),
    daily: daily.map((r) => ({ date: r.keys?.[0] ?? '', clicks: n(r.clicks), impressions: n(r.impressions), ctr: r4(n(r.ctr)), position: r1(n(r.position)) }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date)).sort((a, b) => a.date.localeCompare(b.date)),
    queries: queries.map(toRow), pages: pages.map(toRow), countries: countries.map(toRow), devices: devices.map(toRow),
    sitemaps, ...(sitemapsError ? { sitemapsError } : {}),
  };
}
