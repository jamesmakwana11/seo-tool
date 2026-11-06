/**
 * PageSpeed Insights API v5 (runPagespeed): one Lighthouse lab run plus the Chrome UX Report field data Google returns
 * with it, for one URL and strategy (mobile / desktop). Parsed into Core Web Vitals with Good / Needs improvement / Poor.
 *
 *   GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=mobile|desktop&category=PERFORMANCE&key=…
 */
import { rateCwv, worstRating, type CwvMetric, type CwvRating, type CwvRun, type CwvStrategy, type CwvValue } from '@sentinel/shared';
import { is2xx } from '../connectors/http';
import { googleFailure, type GoogleHttp } from './http';

export const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

interface PsiMetric { percentile?: number; category?: string }
interface PsiExperience { id?: string; overall_category?: string; origin_fallback?: boolean; metrics?: Record<string, PsiMetric> }
interface PsiBody {
  loadingExperience?: PsiExperience;
  originLoadingExperience?: PsiExperience;
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number }>;
    runtimeError?: { code?: string; message?: string };
  };
}

const FIELD_KEYS: Record<CwvMetric, string[]> = {
  LCP: ['LARGEST_CONTENTFUL_PAINT_MS'],
  INP: ['INTERACTION_TO_NEXT_PAINT', 'EXPERIMENTAL_INTERACTION_TO_NEXT_PAINT'],
  CLS: ['CUMULATIVE_LAYOUT_SHIFT_SCORE'],
  FCP: ['FIRST_CONTENTFUL_PAINT_MS'],
  TTFB: ['EXPERIMENTAL_TIME_TO_FIRST_BYTE', 'TIME_TO_FIRST_BYTE'],
};
const LAB_AUDITS: Partial<Record<CwvMetric | 'TBT', string>> = {
  LCP: 'largest-contentful-paint', CLS: 'cumulative-layout-shift', FCP: 'first-contentful-paint', TTFB: 'server-response-time', TBT: 'total-blocking-time',
};

const categoryRating = (c?: string): CwvRating | undefined => (c === 'FAST' ? 'good' : c === 'AVERAGE' ? 'needs_improvement' : c === 'SLOW' ? 'poor' : undefined);

function field(exp: PsiExperience | undefined): CwvRun['field'] | undefined {
  if (!exp?.metrics || !Object.keys(exp.metrics).length) return undefined;
  const metrics: Partial<Record<CwvMetric, CwvValue>> = {};
  for (const [m, keys] of Object.entries(FIELD_KEYS) as [CwvMetric, string[]][]) {
    const raw = keys.map((k) => exp.metrics![k]).find((x) => typeof x?.percentile === 'number');
    if (!raw) continue;
    // CrUX reports CLS ×100 as an integer percentile.
    const value = m === 'CLS' ? raw.percentile! / 100 : raw.percentile!;
    metrics[m] = { value, rating: categoryRating(raw.category) ?? rateCwv(m, value) };
  }
  if (!Object.keys(metrics).length) return undefined;
  return { scope: exp.origin_fallback ? 'origin' : 'url', metrics, overall: categoryRating(exp.overall_category) ?? worstRating([metrics.LCP?.rating, metrics.INP?.rating, metrics.CLS?.rating]) };
}

/** Parses a runPagespeed body (exported for tests). */
export function parsePsi(body: PsiBody): Pick<CwvRun, 'performanceScore' | 'lab' | 'field'> & { runtimeError?: string } {
  const lh = body.lighthouseResult;
  const lab: CwvRun['lab'] = {};
  for (const [m, audit] of Object.entries(LAB_AUDITS) as [CwvMetric | 'TBT', string][]) {
    const v = lh?.audits?.[audit]?.numericValue;
    if (typeof v === 'number' && Number.isFinite(v)) lab[m] = { value: m === 'CLS' ? Math.round(v * 1000) / 1000 : Math.round(v), rating: rateCwv(m, v) };
  }
  const score = lh?.categories?.performance?.score;
  // The URL's own field data when Chrome has enough of it; otherwise the whole origin's.
  const own = body.loadingExperience && !body.loadingExperience.origin_fallback ? field(body.loadingExperience) : undefined;
  const origin = own ? undefined : field(body.originLoadingExperience ?? (body.loadingExperience?.origin_fallback ? body.loadingExperience : undefined));
  return {
    ...(typeof score === 'number' ? { performanceScore: Math.round(score * 100) } : {}),
    lab,
    ...(own ? { field: { ...own, scope: 'url' as const } } : origin ? { field: { ...origin, scope: 'origin' as const } } : {}),
    ...(lh?.runtimeError?.code && lh.runtimeError.code !== 'NO_ERROR' ? { runtimeError: `${lh.runtimeError.code}: ${lh.runtimeError.message ?? ''}`.trim() } : {}),
  };
}

/** Runs PSI once; throws GoogleError (rate limit, invalid key, API disabled, unreachable page…). */
export async function runPsi(http: GoogleHttp, apiKey: string, url: string, strategy: CwvStrategy): Promise<ReturnType<typeof parsePsi>> {
  const q = new URLSearchParams({ url, strategy, category: 'PERFORMANCE', key: apiKey });
  const endpoint = `${PSI_ENDPOINT}?${q.toString()}`;
  // A Lighthouse run takes 10–40 s on Google's side.
  const r = await http.call(endpoint, { headers: { accept: 'application/json' } }, { timeoutMs: 90_000, retries: 1 });
  if (!is2xx(r)) {
    const e = googleFailure(`PageSpeed Insights (${strategy}, ${url})`, PSI_ENDPOINT, r, [apiKey]);
    if (r.kind === 'response' && r.status === 500 && /lighthouse|FAILED_DOCUMENT_REQUEST|ERRORED_DOCUMENT_REQUEST|NO_FCP/i.test(r.text)) {
      e.message = `PageSpeed Insights could not load ${url} (${strategy}): Google’s Lighthouse run failed — the page may block Google’s test agent, time out or return an error.`;
    }
    throw e;
  }
  return parsePsi(r.json as PsiBody);
}
