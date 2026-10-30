/**
 * CrUX → Core Web Vitals field data (PDF §4.4 "CrUX field data: LCP >2.5s, INP >200ms, CLS >0.1 at origin and
 * per-template (home, collection, product)", §15 "PageSpeed Insights + CrUX API — API key").
 *
 * Requests (Chrome UX Report API v1, API key):
 *   POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key={GOOGLE_API_KEY}
 *     { origin: "<site origin>", formFactor: "PHONE", metrics: [largest_contentful_paint, interaction_to_next_paint, cumulative_layout_shift] }
 *     { url: "<representative URL>", formFactor: "PHONE", metrics: [...] }   for home, the top collection and the top product
 * p75 values map to CwvTemplateMetric (device "mobile"). HTTP 404 = CrUX has insufficient field data for that
 * origin/URL: recorded as such, no values written. CwvTemplateMetric requires all three numbers, so a record missing one
 * of the metrics is also reported as insufficient for that template rather than filled in.
 */
import type { CwvTemplateMetric, PageTemplate, SitePage } from '@sentinel/shared';
import { defaultFetch, failureResult, httpRequest, is2xx } from '../connectors/http';
import type { Ctx } from '../services/context';
import type { Finding } from '../services/ports';
import { guardedSync, num, seriesIsSample, siteOrigin, SyncError, type SyncDeps, type SyncResult } from './common';

const ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const METRICS = ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'] as const;

export interface CwvThresholds { lcpMs: number; inpMs: number; cls: number; lcpPoorMs: number; inpPoorMs: number; clsPoor: number }
export const DEFAULT_CWV_THRESHOLDS: CwvThresholds = { lcpMs: 2500, inpMs: 200, cls: 0.1, lcpPoorMs: 4000, inpPoorMs: 500, clsPoor: 0.25 };

/** Google CWV boundaries: good ≤ threshold, poor > poor threshold, otherwise needs improvement. Worst metric wins. */
export function classifyCwv(v: { lcpMs: number; inpMs: number; cls: number }, t: CwvThresholds = DEFAULT_CWV_THRESHOLDS): CwvTemplateMetric['status'] {
  if (v.lcpMs > t.lcpPoorMs || v.inpMs > t.inpPoorMs || v.cls > t.clsPoor) return 'poor';
  if (v.lcpMs > t.lcpMs || v.inpMs > t.inpMs || v.cls > t.cls) return 'needs_improvement';
  return 'good';
}

type Target = { template: CwvTemplateMetric['template']; kind: 'origin' | 'url'; target: string };
type Outcome =
  | { template: Target['template']; target: string; kind: 'data'; metric: CwvTemplateMetric }
  | { template: Target['template']; target: string; kind: 'insufficient'; detail: string }
  | { template: Target['template']; target: string; kind: 'skipped'; detail: string };

/** Highest-value live page of a template: tier, then revenue, then organic sessions, then impressions. */
function topPage(pages: SitePage[], template: PageTemplate): SitePage | undefined {
  return pages
    .filter((p) => p.source !== 'sample' && p.template === template && p.indexable)
    .sort((a, b) => a.tier - b.tier || (b.revenue90d ?? 0) - (a.revenue90d ?? 0) || (b.organicSessions90d ?? 0) - (a.organicSessions90d ?? 0) || (b.impressions28d ?? 0) - (a.impressions28d ?? 0) || a.path.localeCompare(b.path))[0];
}

export async function cruxCwv(ctx: Ctx, deps: SyncDeps = {}): Promise<SyncResult> {
  return guardedSync(ctx, 'psi_crux', deps, async () => {
    const label = 'Chrome UX Report API';
    const key = ctx.env.GOOGLE_API_KEY;
    if (!key) throw new SyncError(`${label}: GOOGLE_API_KEY is not set`);
    const fetchImpl = deps.fetchImpl ?? defaultFetch;
    const cfg = await ctx.repos.config.get();
    const th: CwvThresholds = { ...DEFAULT_CWV_THRESHOLDS, ...pick(cfg.thresholds) };
    const origin = await siteOrigin(ctx);
    const pages = await ctx.repos.sitePages.list();

    const targets: Target[] = [{ template: 'origin', kind: 'origin', target: origin }, { template: 'home', kind: 'url', target: `${origin}/` }];
    const outcomes: Outcome[] = [];
    for (const t of ['collection', 'product'] as const) {
      const p = topPage(pages, t);
      if (p) targets.push({ template: t, kind: 'url', target: p.url });
      else outcomes.push({ template: t, target: '', kind: 'skipped', detail: `no live ${t} page in the inventory yet (run a crawl or the GA4/GSC sync first)` });
    }

    const url = `${ENDPOINT}?key=${encodeURIComponent(key)}`;
    for (const t of targets) {
      const body = { [t.kind]: t.target, formFactor: 'PHONE', metrics: [...METRICS] };
      const r = await httpRequest(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 30_000);
      if (r.kind === 'response' && r.status === 404) {
        outcomes.push({ template: t.template, target: t.target, kind: 'insufficient', detail: 'CrUX has insufficient field data (HTTP 404, chrome ux report data not found)' });
        continue;
      }
      if (!is2xx(r)) {
        if (r.kind === 'response' && r.status === 400 && /api key not valid|API_KEY_INVALID/i.test(r.text)) throw new SyncError(`${label}: credentials rejected (HTTP 400) — API key not valid.`);
        throw new SyncError(failureResult(`${label} (${t.template})`, ENDPOINT, r).result);
      }
      const metrics = (r.json as { record?: { metrics?: Record<string, { percentiles?: { p75?: unknown } }> } } | undefined)?.record?.metrics ?? {};
      const p75 = (name: string) => {
        const v = metrics[name]?.percentiles?.p75;
        return v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
      };
      const lcp = p75('largest_contentful_paint');
      const inp = p75('interaction_to_next_paint');
      const cls = p75('cumulative_layout_shift');
      const missing = [lcp === undefined && 'LCP', inp === undefined && 'INP', cls === undefined && 'CLS'].filter(Boolean);
      if (missing.length) {
        outcomes.push({ template: t.template, target: t.target, kind: 'insufficient', detail: `CrUX record has no p75 for ${missing.join(', ')} — not enough field data` });
        continue;
      }
      const v = { lcpMs: Math.round(num(lcp)), inpMs: Math.round(num(inp)), cls: Math.round(num(cls) * 1000) / 1000 };
      outcomes.push({ template: t.template, target: t.target, kind: 'data', metric: { template: t.template, device: 'mobile', ...v, status: classifyCwv(v, th), source: 'live' } });
    }

    // ---- write metrics.cwv: sample series replaced wholesale; otherwise the mobile entries for every attempted template are
    //      replaced (or removed when CrUX now has insufficient data), other live entries (e.g. desktop) kept.
    const m = await ctx.repos.metrics.get();
    const sample = seriesIsSample(m, m.cwv);
    const attempted = new Set(outcomes.filter((o) => o.kind !== 'skipped').map((o) => o.template));
    const prev = sample ? [] : m.cwv;
    const kept = prev.filter((c) => !(c.device === 'mobile' && attempted.has(c.template)));
    const fresh = outcomes.flatMap((o) => {
      if (o.kind !== 'data') return [];
      const old = prev.find((c) => c.device === 'mobile' && c.template === o.template);
      // Keep lab (PSI) fields from the previous live entry; CrUX supplies only the field-data numbers.
      return [{ ...(old ? { psiScore: old.psiScore, psi7dAvg: old.psi7dAvg, thirdPartyKb: old.thirdPartyKb, thirdPartyKbWeekAgo: old.thirdPartyKbWeekAgo } : {}), ...o.metric }];
    });
    m.cwv = [...kept, ...fresh];
    await ctx.repos.metrics.set(m);

    // ---- PERF-CRUX issues (PDF §4.4: Critical if "Poor" on any template, Medium if "Needs improvement"). Only templates with
    //      field data count as evaluated, so a template that dropped to "insufficient data" is never auto-resolved.
    let issueStats: { newIssues: number; resolvedIssues: number; recurringIssues: number } | undefined;
    if (deps.ingest) {
      const withData = outcomes.filter((o): o is Extract<Outcome, { kind: 'data' }> => o.kind === 'data');
      const findings: Finding[] = withData.filter((o) => o.metric.status !== 'good').map((o) => ({
        checkId: 'PERF-CRUX',
        template: o.template === 'origin' ? undefined : o.template,
        title: `Core Web Vitals ${o.metric.status === 'poor' ? 'Poor' : 'Need improvement'} on ${o.template === 'origin' ? 'the whole origin' : `the ${o.template} template`} (mobile field data)`,
        summary: `CrUX p75 on phones: LCP ${o.metric.lcpMs} ms, INP ${o.metric.inpMs} ms, CLS ${o.metric.cls} (good ≤ ${th.lcpMs} ms / ${th.inpMs} ms / ${th.cls}).`,
        urls: [o.target],
        severityContext: { cwvStatus: o.metric.status, templateWide: true },
        evidence: [{ kind: 'field_data', label: `CrUX p75 (PHONE) for ${o.target}`, url: o.target, data: { lcpMs: o.metric.lcpMs, inpMs: o.metric.inpMs, cls: o.metric.cls, status: o.metric.status, thresholds: th } }],
      }));
      issueStats = await deps.ingest(`SYNC-CRUX-${ctx.clock().toISOString().slice(0, 10)}`, {
        findings, evaluatedChecks: withData.length ? ['PERF-CRUX'] : [],
        evaluatedTemplates: { 'PERF-CRUX': withData.map((o) => o.template).filter((t): t is PageTemplate => t !== 'origin') },
        urls: withData.map((o) => ({ url: o.target, status: 200, reason: 'reverify' as const })), pageTexts: [],
      });
    }

    const fmt = (o: Outcome) =>
      o.kind === 'data' ? `${o.template}: ${o.metric.status} (LCP ${o.metric.lcpMs}ms, INP ${o.metric.inpMs}ms, CLS ${o.metric.cls})` : `${o.template}: ${o.kind === 'insufficient' ? 'insufficient field data' : 'skipped'} — ${o.detail}`;
    const summary = `CrUX sync (PHONE, ${origin}): ${outcomes.map(fmt).join('; ')}.${sample ? ' Replaced the sample Core Web Vitals series.' : ''}${issueStats ? ` PERF-CRUX issues: ${issueStats.newIssues} new, ${issueStats.resolvedIssues} resolved, ${issueStats.recurringIssues} recurring.` : ''}`;
    return {
      summary,
      details: {
        origin, replacedSample: sample, issues: issueStats,
        results: outcomes.map((o) => (o.kind === 'data' ? { template: o.template, target: o.target, status: o.metric.status, lcpMs: o.metric.lcpMs, inpMs: o.metric.inpMs, cls: o.metric.cls } : { template: o.template, target: o.target || undefined, [o.kind]: true, detail: o.detail })),
      },
    };
  });
}

function pick(t: Record<string, number>): Partial<CwvThresholds> {
  const out: Partial<CwvThresholds> = {};
  for (const k of Object.keys(DEFAULT_CWV_THRESHOLDS) as (keyof CwvThresholds)[]) if (typeof t[k] === 'number') out[k] = t[k];
  return out;
}
