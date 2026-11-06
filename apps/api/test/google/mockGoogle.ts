/**
 * In-memory Google APIs for tests (no network), with the request and response shapes of the real services:
 * OAuth token endpoint (authorization_code + refresh_token), OpenID userinfo, token revocation, Analytics Admin
 * (accountSummaries), Analytics Data (runReport, batchRunReports), Search Console (sites, searchAnalytics/query,
 * sitemaps, URL inspection) and PageSpeed Insights (runPagespeed).
 */
export const CLIENT_ID = '123456789012-abcdefgh12345678.apps.googleusercontent.com';
export const CLIENT_SECRET = 'GOCSPX-test-client-secret-value';
export const PSI_KEY = 'AIzaSyTEST-psi-key-0123456789abcdefgh';
export const REFRESH = '1//test-refresh-token-GOOD-value';
export const ACCOUNT = { sub: '1100220033', email: 'seo.owner@deodap.test', name: 'SEO Owner' };
export const GA4_PROPERTY = '123456789';
export const GSC_PROPERTY = 'sc-domain:deodap.test';
const SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly';

export interface MockGoogleRequest { method: string; url: string; auth?: string; body?: string }

export function createMockGoogle(o: { redirectUri?: string } = {}) {
  const requests: MockGoogleRequest[] = [];
  /** Queued failures for the next matching calls: { match: substring of URL, status, body?, times? }. */
  const faults: { match: string; status: number; body?: unknown; times?: number; headers?: Record<string, string> }[] = [];
  const access = new Set<string>();
  let n = 0;
  let refreshRevoked = false;
  const revokedTokens: string[] = [];

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const gErr = (status: number, message: string, reason = 'forbidden', statusText = 'PERMISSION_DENIED') => json({ error: { code: status, message, status: statusText, errors: [{ reason, message }] } }, status);
  const newAccess = () => { const t = `ya29.test-access-${++n}`; access.add(t); return t; };
  const authOk = (h?: string) => !!h && access.has(h.replace(/^Bearer\s+/i, ''));

  function days(start: string, end: string): string[] {
    const out: string[] = [];
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  function ga4Report(req: { dateRanges: { startDate: string; endDate: string; name?: string }[]; dimensions?: { name: string }[]; metrics: { name: string }[] }) {
    const dim = req.dimensions?.[0]?.name;
    const mv = (vals: number[]) => vals.map((v) => ({ value: String(v) }));
    const metricRow = (scale: number) => req.metrics.map((m) => ({
      activeUsers: 1000 * scale, newUsers: 700 * scale, sessions: 1500 * scale, engagedSessions: 900 * scale, engagementRate: 0.6, averageSessionDuration: 95.5, screenPageViews: 4200 * scale, keyEvents: 42 * scale, conversions: 42 * scale,
    } as Record<string, number>)[m.name] ?? 0);
    if (!dim) return { rows: req.dateRanges.map((d, i) => ({ dimensionValues: [{ value: d.name ?? `date_range_${i}` }], metricValues: mv(metricRow(i === 0 ? 1 : 0.8)) })) };
    if (dim === 'date') {
      const ds = days(req.dateRanges[0].startDate, req.dateRanges[0].endDate);
      return { rows: ds.map((d, i) => ({ dimensionValues: [{ value: d.replace(/-/g, '') }], metricValues: mv(req.metrics.map((m) => (m.name === 'activeUsers' ? 30 + i : m.name === 'sessions' ? 50 + i : 2))) })) };
    }
    const names: Record<string, string[]> = {
      sessionDefaultChannelGroup: ['Organic Search', 'Direct', 'Paid Search'], sessionSourceMedium: ['google / organic', '(direct) / (none)', 'google / cpc'], pagePath: ['/', '/products/vegetable-chopper', '/collections/kitchen'],
    };
    return { rows: (names[dim] ?? ['x']).map((v, i) => ({ dimensionValues: [{ value: v }], metricValues: mv(req.metrics.map((m) => (m.name === 'engagementRate' ? 0.5 : (3 - i) * 100))) })) };
  }

  function gscRows(body: { startDate: string; endDate: string; dimensions?: string[]; rowLimit?: number }) {
    const dim = body.dimensions?.[0];
    const row = (key: string | undefined, clicks: number, impressions: number, position: number) => ({ ...(key ? { keys: [key] } : {}), clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
    if (!dim) return [row(undefined, Date.parse(body.endDate) > Date.parse('2026-01-01') ? 500 : 400, 20000, 12.3)];
    if (dim === 'date') return days(body.startDate, body.endDate).map((d, i) => row(d, 10 + i, 600 + i * 10, 12));
    const keys: Record<string, string[]> = { query: ['vegetable chopper', 'deodap', 'kitchen tools'], page: ['https://deodap.test/', 'https://deodap.test/products/vegetable-chopper'], country: ['ind', 'usa'], device: ['MOBILE', 'DESKTOP', 'TABLET'] };
    return (keys[dim] ?? []).map((k, i) => row(k, 100 - i * 10, 2000 - i * 100, 5 + i));
  }

  function psiBody(url: string, strategy: string) {
    const mobile = strategy === 'mobile';
    return {
      id: url,
      loadingExperience: url.endsWith('/') ? {
        id: url, overall_category: mobile ? 'AVERAGE' : 'FAST',
        metrics: {
          LARGEST_CONTENTFUL_PAINT_MS: { percentile: mobile ? 3100 : 1900, category: mobile ? 'AVERAGE' : 'FAST' },
          INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' },
          CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: mobile ? 30 : 5, category: mobile ? 'SLOW' : 'FAST' },
          FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500, category: 'FAST' },
          EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 900, category: 'AVERAGE' },
        },
      } : { id: url, origin_fallback: true },
      originLoadingExperience: { id: new URL(url).origin, overall_category: 'AVERAGE', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2800, category: 'AVERAGE' }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 8, category: 'FAST' }, INTERACTION_TO_NEXT_PAINT: { percentile: 250, category: 'AVERAGE' } } },
      lighthouseResult: {
        categories: { performance: { score: mobile ? 0.62 : 0.91 } },
        audits: {
          'largest-contentful-paint': { numericValue: mobile ? 4500 : 1800 }, 'cumulative-layout-shift': { numericValue: mobile ? 0.18 : 0.02 },
          'first-contentful-paint': { numericValue: mobile ? 2100 : 900 }, 'server-response-time': { numericValue: 650 }, 'total-blocking-time': { numericValue: mobile ? 420 : 90 },
        },
      },
    };
  }

  async function handle(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? headers.Authorization;
    const body = typeof init.body === 'string' ? init.body : undefined;
    requests.push({ method, url: input.replace(/key=[^&]+/, 'key=[key]'), auth: auth ? 'Bearer [token]' : undefined, body: body && /refresh_token=|client_secret=|code=/.test(body) ? '[form]' : body });
    const f = faults.find((x) => input.includes(x.match));
    if (f) {
      if (!f.times || --f.times <= 0) faults.splice(faults.indexOf(f), 1);
      return json(f.body ?? { error: { code: f.status, message: 'mock fault', status: f.status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL' } }, f.status, f.headers ?? (f.status === 429 ? { 'retry-after': '0' } : {}));
    }

    // ---- OAuth
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const p = new URLSearchParams(body ?? '');
      if (p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET) return json({ error: 'invalid_client', error_description: 'Unauthorized' }, 401);
      if (p.get('grant_type') === 'authorization_code') {
        if (o.redirectUri && p.get('redirect_uri') !== o.redirectUri) return json({ error: 'redirect_uri_mismatch' }, 400);
        const code = p.get('code');
        if (code === 'good-code') return json({ access_token: newAccess(), refresh_token: REFRESH, expires_in: 3599, scope: SCOPES, token_type: 'Bearer', id_token: 'x.y.z' });
        if (code === 'no-scopes') return json({ access_token: newAccess(), refresh_token: REFRESH, expires_in: 3599, scope: 'openid https://www.googleapis.com/auth/userinfo.email' });
        return json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (p.get('refresh_token') !== REFRESH || refreshRevoked) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        return json({ access_token: newAccess(), expires_in: 3599, scope: SCOPES, token_type: 'Bearer' });
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke') { revokedTokens.push(new URLSearchParams(body ?? '').get('token') ?? ''); return json({}); }
    if (url.host === 'openidconnect.googleapis.com') return authOk(auth) ? json({ ...ACCOUNT, picture: 'https://lh3.example/p.png', email_verified: true }) : json({ error: 'invalid_token' }, 401);

    // ---- PageSpeed Insights (API key)
    if (url.pathname.startsWith('/pagespeedonline/v5/runPagespeed')) {
      if (url.searchParams.get('key') !== PSI_KEY) return json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
      const target = url.searchParams.get('url') ?? '';
      if (target.includes('broken')) return json({ error: { code: 500, message: 'Lighthouse returned error: FAILED_DOCUMENT_REQUEST', status: 'INTERNAL' } }, 500);
      return json(psiBody(target, url.searchParams.get('strategy') ?? 'mobile'));
    }

    // ---- everything below needs a valid bearer token
    if (!authOk(auth)) return gErr(401, 'Request had invalid authentication credentials.', 'authError', 'UNAUTHENTICATED');

    if (url.host === 'analyticsadmin.googleapis.com' && url.pathname === '/v1beta/accountSummaries') {
      return json({ accountSummaries: [{ account: 'accounts/555', displayName: 'DeoDap', propertySummaries: [{ property: `properties/${GA4_PROPERTY}`, displayName: 'DeoDap Web', propertyType: 'PROPERTY_TYPE_ORDINARY' }, { property: 'properties/987654321', displayName: 'Old site' }] }] });
    }
    if (url.host === 'analyticsdata.googleapis.com') {
      const m = /\/v1beta\/properties\/(\d+):(runReport|batchRunReports)$/.exec(url.pathname);
      if (!m) return gErr(404, 'not found', 'notFound', 'NOT_FOUND');
      if (m[1] !== GA4_PROPERTY) return gErr(403, 'User does not have sufficient permissions for this property.');
      const req = JSON.parse(body ?? '{}');
      if (m[2] === 'runReport') return json({ rowCount: 7, rows: [] });
      return json({ kind: 'analyticsData#batchRunReports', reports: (req.requests as Parameters<typeof ga4Report>[0][]).map(ga4Report) });
    }
    if (url.host === 'www.googleapis.com' && url.pathname === '/webmasters/v3/sites') {
      return json({ siteEntry: [{ siteUrl: GSC_PROPERTY, permissionLevel: 'siteOwner' }, { siteUrl: 'https://unverified.test/', permissionLevel: 'siteUnverifiedUser' }] });
    }
    const gsc = /^\/webmasters\/v3\/sites\/([^/]+)\/(searchAnalytics\/query|sitemaps)$/.exec(url.pathname);
    if (url.host === 'www.googleapis.com' && gsc) {
      if (decodeURIComponent(gsc[1]) !== GSC_PROPERTY) return gErr(403, `User does not have sufficient permission for site '${decodeURIComponent(gsc[1])}'.`);
      if (gsc[2] === 'sitemaps') return json({ sitemap: [{ path: 'https://deodap.test/sitemap.xml', lastSubmitted: '2026-10-01T00:00:00Z', lastDownloaded: '2026-11-01T00:00:00Z', isPending: false, isSitemapsIndex: true, warnings: '0', errors: '1', contents: [{ type: 'web', submitted: '1200', indexed: '0' }] }] });
      return json({ rows: gscRows(JSON.parse(body ?? '{}')), responseAggregationType: 'byProperty' });
    }
    if (url.host === 'searchconsole.googleapis.com' && url.pathname === '/v1/urlInspection/index:inspect') {
      const req = JSON.parse(body ?? '{}');
      return json({ inspectionResult: { inspectionResultLink: 'https://search.google.com/search-console/inspect?x', indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED', pageFetchState: 'SUCCESSFUL', lastCrawlTime: '2026-11-01T10:00:00Z', googleCanonical: req.inspectionUrl, userCanonical: req.inspectionUrl, crawledAs: 'MOBILE' }, mobileUsabilityResult: { verdict: 'PASS' } } });
    }
    return gErr(404, `unknown mock route ${method} ${url.pathname}`, 'notFound', 'NOT_FOUND');
  }

  return {
    requests, faults, revokedTokens,
    /** Google revokes the stored refresh token (password change, access removed). */
    revokeRefresh() { refreshRevoked = true; },
    restoreRefresh() { refreshRevoked = false; },
    /** Every access token handed out so far stops working (forces a refresh). */
    expireAccessTokens() { access.clear(); },
    /** Wraps another fetch: Google hosts go to this mock, the rest to `next`. */
    wrap(next: (url: string, init?: RequestInit) => Promise<Response>) {
      return (input: string, init?: RequestInit) => (/^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|google\.com)\//.test(String(input)) ? handle(String(input), init) : next(input, init));
    },
    handle,
  };
}
