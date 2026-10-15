/**
 * Phase 2 HTTP client — implements the single SentinelApi contract against apps/api.
 * The bearer token is held in localStorage (per browser). Errors are rehydrated into ApiError so the
 * UI's existing error handling (status + code + message) works identically to the mock adapter.
 */
import {
  ApiError,
  type AiComplianceFlag, type AlertRule, type ApiDiagnostics, type AuditLogEntry, type AuditModule, type AuthResult,
  type BrandMention, type CheckDefinition, type ContentBrief, type ContentScore, type CrawlRun, type CrawlerStatus, type CrawlSchedule, type CrawlType,
  type CrawlDetail, type CtrRewrite, type CustomRule, type CwvTemplateMetric, type DailyDigest, type DashboardData,
  type DeliveryAttempt, type DisavowCandidate, type DryRunResult, type Employee, type EmployeeInput, type HealthPoint, type HealthScore,
  type IntegrationId, type IntegrationStatus, type IntegrationSyncResult, type Issue, type IssueDetail, type IssueFilter, type IssueGroup, type KeywordGap,
  type LinkProspect, type ModuleData, type MonthlyReport, type Notification, type OpportunityItem, type Paged, type PermissionMatrix,
  type ReportMeta, type Role, type SearchResult, type SentinelApi, type SentinelConfig, type SessionUser, type StrikingDistanceQuery,
  type SystemComponentHealth, type SystemErrorEntry, type TopicCluster, type Website, type WebsiteSummary, WEBSITE_HEADER,
  type VerificationAttempt, type WeeklyReport, type AllocationEvent,
} from '@sentinel/shared';

const TOKEN_KEY = 'sentinel.http.token';

function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(t: string | null) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function createHttpApi(baseUrl = '/api', websiteId: () => string | undefined = () => undefined): SentinelApi {
  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // Read at call start: a response always belongs to the website that was selected when the request was made.
    const site = websiteId();
    if (site) headers[WEBSITE_HEADER] = site;
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      const init: RequestInit = { method, headers };
      if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
      res = await fetch(`${baseUrl}${path}`, init);
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the API server. Check that it is running.');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
    if (!res.ok) {
      const err = (data && typeof data === 'object' && 'error' in data ? (data as { error: { code: string; message: string; details?: unknown } }).error : undefined);
      throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Request failed (${res.status}).`, err?.details);
    }
    return data as T;
  }
  /** A file response (export): text plus the file name the server suggested. */
  async function download(path: string): Promise<{ filename: string; mimeType: string; content: string }> {
    const headers: Record<string, string> = {};
    const site = websiteId();
    if (site) headers[WEBSITE_HEADER] = site;
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { headers });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the API server. Check that it is running.');
    }
    const content = await res.text();
    if (!res.ok) {
      let err: { code?: string; message?: string } | undefined;
      try { err = (JSON.parse(content) as { error?: { code: string; message: string } }).error; } catch { /* not JSON */ }
      throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `Download failed (${res.status}).`);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'export';
    return { filename, mimeType: res.headers.get('content-type') ?? 'application/octet-stream', content };
  }
  const get = <T>(p: string) => req<T>('GET', p);
  const post = <T>(p: string, b?: unknown) => req<T>('POST', p, b ?? {});
  const patch = <T>(p: string, b?: unknown) => req<T>('PATCH', p, b ?? {});
  const put = <T>(p: string, b?: unknown) => req<T>('PUT', p, b ?? {});
  const del = <T>(p: string) => req<T>('DELETE', p);

  const api: SentinelApi = {
    // auth
    async login(email, password) { const r = await post<AuthResult>('/auth/login', { email, password }); setToken(r.token); return r; },
    async previewAs(role: Role) { const r = await post<AuthResult>('/auth/preview', { role }); setToken(r.token); return r; },
    async logout() { try { await post('/auth/logout'); } finally { setToken(null); } },
    me: () => get<SessionUser>('/auth/me'),
    requestPasswordReset: (email) => post('/auth/request-reset', { email }),
    resetPassword: (token, newPassword) => post('/auth/reset', { token, newPassword }),
    updateProfile: (input) => patch<SessionUser>('/auth/profile', input),

    // dashboard & health
    getDashboard: () => get<DashboardData>('/dashboard'),
    getHealthHistory: (days) => get<HealthPoint[]>(`/health/history${qs({ days })}`),
    getHealthScore: () => get<HealthScore>('/health/score'),

    // checks & modules
    listChecks: () => get<CheckDefinition[]>('/checks'),
    getModule: (m: AuditModule) => get<ModuleData>(`/modules/${m}`),
    getCwv: () => get<CwvTemplateMetric[]>('/cwv'),
    getContentScores: () => get<ContentScore[]>('/content-scores'),

    // issues
    listIssues: (f: IssueFilter) => get<Paged<Issue>>(`/issues${qs({ ...f })}`),
    getIssue: (id) => get<IssueDetail>(`/issues/${id}`),
    allocateIssue: (id, team, reason) => post<IssueDetail>(`/issues/${id}/allocate`, { team, reason }),
    bulkAllocate: (groupId, team, reason) => post<IssueDetail>(`/issues/groups/${groupId}/allocate`, { team, reason }),
    acknowledgeIssue: (id) => post<IssueDetail>(`/issues/${id}/acknowledge`),
    markNotAnIssue: (id, reason, addExclusion) => post<IssueDetail>(`/issues/${id}/not-an-issue`, { reason, addExclusion }),
    reopenIssue: (id, reason) => post<IssueDetail>(`/issues/${id}/reopen`, { reason }),
    approveProposal: (id, note) => post<IssueDetail>(`/issues/${id}/approve-proposal`, { note }),
    listIssueGroups: () => get<(IssueGroup & { parent: Issue })[]>('/issues/groups'),
    listExclusions: () => get('/issues/exclusions'),
    removeExclusion: (id) => del<void>(`/issues/exclusions/${id}`),

    updateIssueStatus: (id, action, note) => post<IssueDetail>(`/issues/${id}/status`, { action, note }),
    verifyIssue: (id) => post<{ detail: IssueDetail; attempt: VerificationAttempt }>(`/issues/${id}/verify`),

    // websites
    listWebsites: () => get<WebsiteSummary[]>('/websites'),
    createWebsite: (input) => post<Website>('/websites', input),
    updateWebsite: (id, input) => patch<Website>(`/websites/${id}`, input),

    // crawls
    listCrawls: () => get<CrawlRun[]>('/crawls'),
    getCrawl: (id) => get<CrawlDetail>(`/crawls/${id}`),
    startCrawl: (type: CrawlType, options) => post<CrawlRun>('/crawls', options ? { type, options } : { type }),
    cancelCrawl: (id) => post<CrawlRun>(`/crawls/${encodeURIComponent(id)}/cancel`),
    getCrawlerStatus: () => get<CrawlerStatus>('/crawls/status'),
    exportCrawl: (id, format) => download(`/crawls/${encodeURIComponent(id)}/export?format=${format}`),
    listSchedules: () => get<CrawlSchedule[]>('/crawls/schedules'),
    updateSchedule: (id, input) => patch<CrawlSchedule>(`/crawls/schedules/${id}`, input),
    listVerifications: () => get<VerificationAttempt[]>('/crawls/verifications'),

    // opportunities
    listOpportunities: () => get<OpportunityItem[]>('/opportunities'),
    dismissOpportunity: (id) => post<OpportunityItem>(`/opportunities/${id}/dismiss`),
    listKeywordGaps: () => get('/keyword-gaps'),
    updateKeywordGap: (id, status) => patch<KeywordGap>(`/keyword-gaps/${id}`, { status }),
    listStrikingDistance: () => get<StrikingDistanceQuery[]>('/striking-distance'),
    listCtrRewrites: () => get<CtrRewrite[]>('/ctr-rewrites'),
    listBriefs: () => get<ContentBrief[]>('/briefs'),
    getBrief: (id) => get<ContentBrief>(`/briefs/${id}`),
    saveBrief: (brief) => post<ContentBrief>('/briefs', brief),
    generateBriefFromGap: (gapId) => post<ContentBrief>(`/briefs/from-gap/${gapId}`),
    listClusters: () => get<TopicCluster[]>('/clusters'),
    getSeasonalPlan: () => get('/seasonal-plan'),

    // off-page / competitors
    listBacklinks: () => get('/backlinks'),
    listLinkProspects: () => get<LinkProspect[]>('/link-prospects'),
    listBrandMentions: () => get<BrandMention[]>('/brand-mentions'),
    updateBrandMention: (id, status) => patch<BrandMention>(`/brand-mentions/${id}`, { status }),
    listDisavowCandidates: () => get<DisavowCandidate[]>('/disavow'),
    decideDisavow: (id, decision) => post<DisavowCandidate>(`/disavow/${id}/decide`, { decision }),
    getCompetitors: () => get('/competitors'),
    getLocalHealth: () => get('/local-health'),

    // AI visibility
    getAiVisibility: () => get('/ai-visibility'),

    // AI compliance
    listAiFlags: () => get<AiComplianceFlag[]>('/ai-flags'),
    decideQaHold: (flagId, decision, note) => post<AiComplianceFlag>(`/ai-flags/${flagId}/decide`, { decision, note }),
    listRules: () => get<CustomRule[]>('/rules'),
    saveRule: (rule) => post<CustomRule>('/rules', rule),
    deleteRule: (id) => del<void>(`/rules/${id}`),
    dryRunRule: (rule) => post<DryRunResult>('/rules/dry-run', rule),
    setRuleEnabled: (id, enabled) => patch<CustomRule>(`/rules/${id}/enabled`, { enabled }),

    // reports
    getDailyDigest: (date) => get<DailyDigest>(`/reports/daily${qs({ date })}`),
    getWeeklyReport: () => get<WeeklyReport>('/reports/weekly'),
    getMonthlyReport: () => get<MonthlyReport>('/reports/monthly'),
    listReportHistory: () => get<ReportMeta[]>('/reports/history'),
    async exportReport(kind, format) {
      const token = getToken();
      const res = await fetch(`${baseUrl}/reports/${kind}/export${qs({ format })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new ApiError(res.status, 'ERROR', `Export failed (${res.status}).`);
      const cd = res.headers.get('Content-Disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `${kind}-report.${format}`;
      return { filename, mime: res.headers.get('Content-Type') ?? 'application/octet-stream', content: await res.text() };
    },
    sendReport: (kind) => post<DeliveryAttempt[]>(`/reports/${kind}/send`),

    // notifications
    listNotifications: () => get<Notification[]>('/notifications'),
    markNotificationRead: (id) => post<void>(`/notifications/${id}/read`),
    listDeliveries: () => get<DeliveryAttempt[]>('/deliveries'),
    updateAlertRules: (rules) => put<AlertRule[]>('/alert-rules', rules),

    // people
    listEmployees: () => get<Employee[]>('/employees'),
    createEmployee: (input: EmployeeInput) => post<Employee>('/employees', input),
    updateEmployee: (id, input) => patch<Employee>(`/employees/${id}`, input),
    getPermissionMatrix: () => get<PermissionMatrix>('/permissions'),
    updatePermissionMatrix: (m) => put<PermissionMatrix>('/permissions', m),
    listAllocationHistory: () => get<(AllocationEvent & { issueTitle: string })[]>('/issues/allocation-history'),

    // config & integrations
    getConfig: () => get<SentinelConfig>('/config'),
    updateConfig: (patchBody) => patch<SentinelConfig>('/config', patchBody),
    listIntegrations: () => get<IntegrationStatus[]>('/integrations'),
    updateIntegration: (id: IntegrationId, settings) => patch<IntegrationStatus>(`/integrations/${id}`, settings),
    testIntegration: (id: IntegrationId) => post<IntegrationStatus>(`/integrations/${id}/test`),
    syncIntegration: (id) => post<IntegrationSyncResult>(`/integrations/${id}/sync`),

    // audit, system, search, diagnostics
    listAuditLog: (f) => get<Paged<AuditLogEntry>>(`/audit${qs({ ...f })}`),
    getSystemHealth: () => get<{ components: SystemComponentHealth[]; errors: SystemErrorEntry[]; storage: { kind: 'in_memory' | 'browser_memory'; persistent: false; note: string } }>('/system/health'),
    search: (q) => get<SearchResult[]>(`/search${qs({ q })}`),
    getDiagnostics: () => get<ApiDiagnostics>('/diagnostics'),
  };
  return api;
}
