/**
 * Phase 1 DEVELOPMENT mock adapter.
 *
 * - Runs entirely in the browser. The bundled deodap.in workspace holds deterministic DEMO data (createSeed); websites added
 *   in the UI start empty.
 * - State lives in memory only: a page reload resets everything. Nothing is persisted.
 * - Enforces the same permission matrix and issue-workflow rules as the real backend.
 * - Multi-website: each website has its own isolated state (issues, Fix Cards, crawls, reports, settings, integration
 *   configuration). Employees, passwords and the permission matrix are shared. A website added here starts empty.
 * - Never claims an external action succeeded: crawls are SIMULATED (no HTTP), deliveries are
 *   "skipped — not configured", integrations can't connect from the browser.
 */
import {
  crawlExportFilename, crawlResultsCsv, crawlResultsJson,
  ApiError, CHECKS_BY_ID, DEMO_PASSWORD, INTEGRATION_CATALOG, PREVIEW_USER_BY_ROLE, TEAMS, ROLE_LABELS, buildDailyDigest,
  buildDashboard, buildModuleData, buildMonthlyReport, buildWeeklyReport, canTransition, computeHealthScore,
  createSeed, evaluateRule, exportReport, filterIssues, queryCrawlRows, SMART_CRAWL_PAGE_BUDGET, auditPage, DEFAULT_PAGE_AUDIT_LIMITS, generateFixCard, globalSearch, hasPermission,
  issueStatusForTask, paginate, ruleAppliesTo, seasonalPlan, setPriorityConfig, taskPriorityFromSeverity, validateRule,
  HEALTH_WEIGHTS, DEMO_WEBSITE_ID, SHOPIFY_OPTIONAL_SCOPES, SHOPIFY_REQUIRED_SCOPES, createEmptySite, demoWebsite, summarizeWebsite, validateWebsiteInput,
  type ActivityEvent, type AllocationEvent, type ApiDiagnostics, type AuditLogEntry, type AuthResult, type CrawledUrl, type SiteData, type Website,
  type CustomRule, type DeliveryAttempt, type DryRunResult, type Employee, type EmployeeInput, type IntegrationId,
  type IntegrationStatus, type Issue, type IssueDetail, type Permission, type PermissionMatrix, type Role, type SeedData,
  type SentinelApi, type SentinelConfig, type SentinelView, type SessionUser, type Task, type TeamId,
  type VerificationAttempt, type ContentBrief, type CrawlRun, type Notification, type IssueFilter,
} from '@sentinel/shared';

const SESSION_KEY = 'sentinel.mock.session';
/** Session persistence is a convenience: storage can be unavailable (private windows, sandboxed hosts) — never fail sign-in over it. */
const store = {
  set: (v: string) => { try { sessionStorage.setItem(SESSION_KEY, v); } catch { /* storage unavailable */ } },
  clear: () => { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ } },
};
type SiteState = SiteData & { integrationSettings: Partial<Record<IntegrationId, Record<string, string | number | boolean>>>; integrationTests: Partial<Record<IntegrationId, { at: string; result: string }>> };
type Globals = Pick<SeedData, 'employees' | 'passwords' | 'permissions'> & { resetTokens: Record<string, string> };
type MockState = SiteState & Globals;
const GLOBAL_KEYS = new Set<PropertyKey>(['employees', 'passwords', 'permissions', 'resetTokens']);
/** Website-scoped calls run against the website selected when the call STARTED. */
const WEBSITE_METHODS = new Set(['listWebsites', 'createWebsite', 'updateWebsite', 'login', 'previewAs', 'logout', 'me', 'requestPasswordReset', 'resetPassword', 'updateProfile']);

let counter = 1000;
const nid = (p: string) => `${p}-${++counter}`;
const changesMock = () => new ApiError(409, 'NOT_AVAILABLE_IN_MOCK', 'Mock mode makes no real crawls and runs no browser, so it has no change history or screenshots. Connect the app to the API server.');
const shopifyMock = () => new ApiError(409, 'SHOPIFY_NOT_CONNECTED', 'Mock mode has no Shopify connection: the SEO editor reads and writes Shopify through the API server.');

const MOCK_NO_LIVE_CRAWL = 'This is the in-browser DEMO version: it cannot fetch websites. Start the API server with live crawling enabled (see LOCAL_CRAWLING.md) to crawl a real site.';

export function createMockApi(opts: { latencyMs?: [number, number]; now?: () => Date; websiteId?: () => string } = {}): SentinelApi & { __state: MockState; __recent: ApiDiagnostics['recent']; __sites: Map<string, SiteState> } {
  const now = opts.now ?? (() => new Date());
  const [lo, hi] = opts.latencyMs ?? [120, 320];
  const currentWebsite = opts.websiteId ?? (() => DEMO_WEBSITE_ID);
  const { employees, passwords, permissions, ...demoData } = createSeed(now());
  const globals: Globals = { employees, passwords, permissions, resetTokens: {} };
  const websites: Website[] = [demoWebsite(now())];
  const sites = new Map<string, SiteState>([[DEMO_WEBSITE_ID, { ...demoData, integrationSettings: {}, integrationTests: {} }]]);
  let active = DEMO_WEBSITE_ID;
  const target = (k: PropertyKey) => (GLOBAL_KEYS.has(k) ? globals : sites.get(active)!) as unknown as Record<PropertyKey, unknown>;
  // `s` always points at the active website's state (plus the shared people/permission data).
  const s = new Proxy({} as MockState, {
    get: (_, k) => target(k)[k],
    set: (_, k, v) => { target(k)[k] = v; return true; },
    has: (_, k) => k in target(k),
    ownKeys: () => [...Reflect.ownKeys(sites.get(active)!), ...GLOBAL_KEYS] as (string | symbol)[],
    getOwnPropertyDescriptor: (_, k) => ({ value: target(k)[k], writable: true, enumerable: true, configurable: true }),
  });
  setPriorityConfig(s.config);
  const recent: ApiDiagnostics['recent'] = [];

  // ---------------------------------------------------------------- session
  let sessionUserId: string | null = null;
  let sessionDemo = false;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { userId: string; demo: boolean };
      sessionUserId = p.userId;
      sessionDemo = p.demo;
    }
  } catch {
    /* no session storage */
  }

  const delay = () => new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));
  const clone = <T>(x: T): T => structuredClone(x);

  async function call<T>(name: string, fn: () => T): Promise<T> {
    const t0 = performance.now();
    const site = currentWebsite();
    await delay();
    try {
      if (!WEBSITE_METHODS.has(name)) {
        if (!sites.has(site)) throw new ApiError(404, 'WEBSITE_NOT_FOUND', 'The selected website no longer exists. Choose another website.');
        active = site;
        setPriorityConfig(s.config);
      }
      const out = fn();
      recent.unshift({ at: new Date().toISOString(), method: 'MOCK', path: name, status: 200, ms: Math.round(performance.now() - t0) });
      recent.length = Math.min(recent.length, 50);
      return clone(out);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      recent.unshift({ at: new Date().toISOString(), method: 'MOCK', path: name, status, ms: Math.round(performance.now() - t0) });
      throw e;
    }
  }

  const me = (): Employee => {
    if (!sessionUserId) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const e = s.employees.find((x) => x.id === sessionUserId);
    if (!e || e.status !== 'active') throw new ApiError(401, 'UNAUTHENTICATED', 'Your session is no longer valid.');
    return e;
  };
  const can = (p: Permission) => hasPermission(s.permissions, me().role, p);
  const need = (p: Permission) => {
    if (!can(p)) throw new ApiError(403, 'FORBIDDEN', `Your role (${ROLE_LABELS[me().role]}) does not have permission "${p}".`);
  };
  const sessionUser = (e: Employee, demo: boolean): SessionUser => ({ id: e.id, name: e.name, email: e.email, role: e.role, teamIds: e.teamIds, isSeoLead: e.isSeoLead, permissions: s.permissions[e.role], demo });
  const nameOf = (id: string) => (id === 'system' ? 'Sentinel (system)' : s.employees.find((e) => e.id === id)?.name ?? id);
  const iso = () => now().toISOString();

  const audit = (action: string, entityType: AuditLogEntry['entityType'], entityId: string, summary: string, extra: Partial<AuditLogEntry> = {}) => {
    const actorId = sessionUserId ?? 'system';
    s.audit.push({ id: nid('AUD'), at: iso(), actorId, actorName: nameOf(actorId), action, entityType, entityId, summary, ...extra });
  };
  const notify = (recipientIds: string[], n: Omit<Notification, 'id' | 'recipientId' | 'createdAt'>) => {
    for (const r of new Set(recipientIds)) s.notifications.push({ ...n, id: nid('NTF'), recipientId: r, createdAt: iso() });
  };
  const teamMembers = (t: TeamId) => s.employees.filter((e) => e.teamIds.includes(t) && e.status === 'active').map((e) => e.id);
  const teamLead = (t: TeamId) => TEAMS[t].leadId ?? teamMembers(t)[0];
  const recordDelivery = (d: Omit<DeliveryAttempt, 'id' | 'at' | 'outcome' | 'retryable' | 'error'>) => {
    const envVar = { email: 'SMTP_HOST', whatsapp: 'WHATSAPP_API_TOKEN', slack: 'SLACK_WEBHOOK_URL' }[d.channel];
    const att: DeliveryAttempt = { ...d, id: nid('DLV'), at: iso(), outcome: 'skipped_not_configured', retryable: false, error: `${envVar} not configured — mock mode cannot deliver externally.` };
    s.deliveries.push(att);
    return att;
  };

  const issueById = (id: string) => {
    const i = s.issues.find((x) => x.id === id);
    if (!i) throw new ApiError(404, 'NOT_FOUND', `Issue ${id} not found.`);
    return i;
  };
  const act = (t: Task, type: ActivityEvent['type'], message: string, meta?: Record<string, unknown>, actorId = sessionUserId ?? 'system') => {
    t.activity.push({ id: nid('ACT'), type, actorId, actorName: nameOf(actorId), at: iso(), message, meta });
    t.updatedAt = iso();
  };
  const syncIssueFromTask = (t: Task) => {
    if (!t.issueId) return;
    const st = issueStatusForTask(t.status);
    const iss = s.issues.find((i) => i.id === t.issueId);
    if (iss && st) {
      iss.status = st;
      for (const cid of iss.childIssueIds ?? []) {
        const c = s.issues.find((x) => x.id === cid);
        if (c && (st === 'VERIFIED' || st === 'CLOSED')) c.status = st;
      }
    }
  };

  const view = (): SentinelView => ({ ...sites.get(active)!, ...globals, liveSources: {} });
  const isDemoSite = () => websites.find((w) => w.id === active)?.source === 'demo';

  const issueDetail = (i: Issue): IssueDetail => {
    const task = i.taskId ? s.tasks.find((t) => t.id === i.taskId) : undefined;
    return {
      issue: i,
      fixCard: generateFixCard(i, s.config, { now: now(), pageName: s.catalog.byUrl.get(i.affectedUrls[0])?.title }),
      group: i.groupId ? s.groups.find((g) => g.id === i.groupId) : undefined,
      children: i.childIssueIds?.map((c) => s.issues.find((x) => x.id === c)!).filter(Boolean),
      verification: s.verifications.filter((v) => v.issueId === i.id),
      audit: s.audit.filter((a) => a.entityId === i.id || (task && a.entityId === task.id)).slice(-40),
    };
  };

  const createTaskForIssue = (i: Issue, team: TeamId, automatic = false): Task => {
    const fc = generateFixCard(i, s.config, { now: now() });
    const t: Task = {
      id: nid('TSK'), title: `Fix: ${i.title}`, description: `${fc.whatsWrong}\n\nWhy it matters: ${fc.whyItMatters}`, issueId: i.id, module: i.module, severity: i.severity,
      priority: taskPriorityFromSeverity(i.severity), priorityScore: fc.priorityScore, pageTier: i.highestTier, affectedUrls: i.affectedUrls.slice(0, 50), status: 'ASSIGNED',
      team, recommendedTeam: i.recommendedTeam, creatorId: sessionUserId ?? 'system', creatorName: nameOf(sessionUserId ?? 'system'), createdAt: iso(), updatedAt: iso(),
      dueAt: i.slaDueAt, progress: 0, estimatedHours: fc.effortHours, actualHours: 0, acceptanceCriteria: fc.acceptanceCriteria, comments: [], blockers: [], evidence: [],
      verification: [], activity: [], assignmentHistory: [{ at: iso(), byId: sessionUserId ?? 'system', byName: nameOf(sessionUserId ?? 'system'), toTeam: team }],
      relatedIssueIds: i.childIssueIds ?? [], reopenCount: 0, source: 'simulated',
    };
    act(t, 'created', `Task created from Fix Card ${i.id} via "Fix with ${TEAMS[team].name}"${automatic ? ' (automatic)' : ''}. Priority ${t.priority} (from ${i.severity}); due ${new Date(t.dueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST (SLA).`);
    s.tasks.push(t);
    return t;
  };

  const allocate = (i: Issue, team: TeamId, reason?: string, bulkGroupId?: string): AllocationEvent => {
    const u = me();
    const ev: AllocationEvent = { id: nid('ALC'), issueId: i.id, allocatedById: u.id, allocatedByName: u.name, fromTeam: i.allocatedTeam, toTeam: team, at: iso(), reason, automatic: false, bulkGroupId };
    i.allocation.push(ev);
    const prev = i.allocatedTeam;
    i.allocatedTeam = team;
    if (i.status === 'NEW') i.status = 'ASSIGNED';
    audit(prev ? 'issue.reallocate' : 'issue.allocate', 'issue', i.id, `${prev ? `Reallocated ${TEAMS[prev].name} → ` : 'Allocated → '}${TEAMS[team].name}${reason ? `: ${reason}` : ''}`);
    return ev;
  };

  const allocateWithTask = (i: Issue, team: TeamId, reason?: string, bulkGroupId?: string) => {
    if (['NOT_AN_ISSUE', 'SUPERSEDED', 'CLOSED', 'VERIFIED'].includes(i.status)) throw new ApiError(409, 'CONFLICT', `Issue ${i.id} is ${i.status} and cannot be allocated.`);
    const prevTeam = i.allocatedTeam;
    if (prevTeam === team && i.taskId) throw new ApiError(409, 'CONFLICT', `Already allocated to ${TEAMS[team].name}.`);
    allocate(i, team, reason, bulkGroupId);
    let task = i.taskId ? s.tasks.find((t) => t.id === i.taskId) : undefined;
    if (!task) {
      task = createTaskForIssue(i, team);
      i.taskId = task.id;
      notify([teamLead(team)], { type: 'assignment', title: `New ${i.severity} issue for ${TEAMS[team].name}`, body: i.title, link: `/issues/${i.id}`, severity: i.severity });
    } else {
      const from = task.team;
      task.team = team;
      task.assignmentHistory.push({ at: iso(), byId: me().id, byName: me().name, fromTeam: from, toTeam: team, fromAssigneeId: task.assigneeId, reason });
      task.assigneeId = undefined;
      if (!['NEW', 'TRIAGED', 'ASSIGNED'].includes(task.status)) task.status = 'ASSIGNED';
      act(task, 'reallocated', `Reallocated ${TEAMS[from].name} → ${TEAMS[team].name}${reason ? `: ${reason}` : ''}. Both teams notified.`);
      notify([teamLead(from), teamLead(team)], { type: 'assignment', title: `Reallocated: ${i.title}`, body: `${TEAMS[from].name} → ${TEAMS[team].name}`, link: `/issues/${i.id}`, severity: i.severity });
    }
    return task;
  };

  const integrationStatus = (id: IntegrationId): IntegrationStatus => {
    const base = INTEGRATION_CATALOG.find((x) => x.id === id)!;
    const test = s.integrationTests[id];
    return {
      ...base, state: 'not_configured',
      stateDetail: 'Mock mode: the browser cannot hold credentials or reach external APIs. Configure the environment variables on the API server (Phase 2) and test from there.',
      configuredVars: [], lastTestAt: test?.at, lastTestResult: test?.result, settings: s.integrationSettings[id] ?? {},
    };
  };

  const ensureFestivals = () => s.config.festivals;

  // ---------------------------------------------------------------- API
  const api: SentinelApi = {
    login: (email, password) => call('login', () => {
      const e = s.employees.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      if (!e || s.passwords[e.email] !== password) {
        audit('auth.login_failed', 'auth', email, 'Failed sign-in attempt');
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      }
      if (e.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', `This account is ${e.status}. Ask an admin to activate it.`);
      sessionUserId = e.id;
      sessionDemo = false;
      store.set(JSON.stringify({ userId: e.id, demo: false }));
      e.lastActiveAt = iso();
      audit('auth.login', 'auth', e.id, `${e.name} signed in (mock auth)`);
      return { token: `mock.${e.id}`, user: sessionUser(e, false) } satisfies AuthResult;
    }),
    previewAs: (role) => call('previewAs', () => {
      const e = s.employees.find((x) => x.id === PREVIEW_USER_BY_ROLE[role])!;
      sessionUserId = e.id;
      sessionDemo = true;
      store.set(JSON.stringify({ userId: e.id, demo: true }));
      audit('auth.preview', 'auth', e.id, `DEVELOPMENT role preview as ${ROLE_LABELS[role]} (${e.name})`);
      return { token: `mock.preview.${e.id}`, user: sessionUser(e, true) };
    }),
    logout: () => call('logout', () => {
      sessionUserId = null;
      store.clear();
    }),
    me: () => call('me', () => sessionUser(me(), sessionDemo)),
    requestPasswordReset: (email) => call('requestPasswordReset', () => {
      const e = s.employees.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      if (e) {
        const token = Math.random().toString(36).slice(2, 10);
        s.resetTokens[token] = e.email;
        audit('auth.reset_requested', 'auth', e.id, 'Password reset requested');
        return { sent: false, emailConfigured: false, devResetToken: token, note: 'Mock mode cannot send email. Use the development reset link below (shown only in mock mode).' };
      }
      // Same response for unknown emails — do not reveal which accounts exist.
      return { sent: false, emailConfigured: false, note: 'Mock mode cannot send email, so no reset link was sent.' };
    }),
    resetPassword: (token, pw) => call('resetPassword', () => {
      const email = s.resetTokens[token];
      if (!email) throw new ApiError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired.');
      if (pw.length < 10 || !/[0-9]/.test(pw) || !/[A-Za-z]/.test(pw)) throw new ApiError(400, 'WEAK_PASSWORD', 'Use at least 10 characters including letters and numbers.');
      s.passwords[email] = pw;
      delete s.resetTokens[token];
      audit('auth.reset', 'auth', email, 'Password reset completed');
      return { ok: true as const };
    }),
    updateProfile: (input) => call('updateProfile', () => {
      const e = me();
      if (input.newPassword) {
        if (s.passwords[e.email] !== input.currentPassword) throw new ApiError(400, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
        if (input.newPassword.length < 10 || !/[0-9]/.test(input.newPassword) || !/[A-Za-z]/.test(input.newPassword)) throw new ApiError(400, 'WEAK_PASSWORD', 'Use at least 10 characters including letters and numbers.');
        s.passwords[e.email] = input.newPassword;
      }
      if (input.name !== undefined) {
        if (input.name.trim().length < 2) throw new ApiError(400, 'VALIDATION', 'Name is required.');
        e.name = input.name.trim();
      }
      if (input.title !== undefined) e.title = input.title.trim();
      audit('employee.profile_update', 'employee', e.id, 'Updated own profile');
      return sessionUser(e, sessionDemo);
    }),

    getDashboard: () => call('getDashboard', () => { need('dashboard.view'); return buildDashboard(view(), now()); }),
    getHealthHistory: (days) => call('getHealthHistory', () => { need('dashboard.view'); return s.healthHistory.slice(-days); }),
    getHealthScore: () => call('getHealthScore', () => { need('dashboard.view'); return computeHealthScore(s.issues, s.siteSize, s.config, now()); }),

    listChecks: () => call('listChecks', () => { need('modules.view'); return Object.values(CHECKS_BY_ID); }),
    getModule: (m) => call('getModule', () => { need('modules.view'); return buildModuleData(view(), m, now(), true); }),
    getCwv: () => call('getCwv', () => { need('modules.view'); return s.cwv; }),
    getContentScores: () => call('getContentScores', () => { need('modules.view'); return s.contentScores; }),

    listIssues: (f: IssueFilter) => call('listIssues', () => { need('issues.view'); return filterIssues(s.issues, f, now()); }),
    getIssue: (id) => call('getIssue', () => { need('issues.view'); return issueDetail(issueById(id)); }),
    allocateIssue: (id, team, reason) => call('allocateIssue', () => {
      need('issues.allocate');
      const i = issueById(id);
      if (i.isTemplateGroup) return bulk(i, team, reason);
      allocateWithTask(i, team, reason);
      return issueDetail(i);
    }),
    bulkAllocate: (groupId, team, reason) => call('bulkAllocate', () => {
      need('issues.allocate');
      const parent = s.issues.find((i) => i.groupId === groupId && i.isTemplateGroup);
      if (!parent) throw new ApiError(404, 'NOT_FOUND', `Group ${groupId} not found.`);
      return bulk(parent, team, reason);
    }),
    acknowledgeIssue: (id) => call('acknowledgeIssue', () => {
      need('issues.view');
      const i = issueById(id);
      i.acknowledgedBy = { id: me().id, name: me().name, at: iso() };
      audit('issue.acknowledge', 'issue', id, 'Acknowledged');
      return issueDetail(i);
    }),
    markNotAnIssue: (id, reason, addExclusion) => call('markNotAnIssue', () => {
      need('issues.mark_not_issue');
      if (!reason || reason.trim().length < 5) throw new ApiError(400, 'VALIDATION', 'Give a reason (at least 5 characters) so the classifier can learn the exclusion.');
      const i = issueById(id);
      i.status = 'NOT_AN_ISSUE';
      i.notAnIssue = { byId: me().id, byName: me().name, at: iso(), reason: reason.trim(), excluded: addExclusion };
      if (addExclusion) {
        for (const u of i.affectedUrls.slice(0, 20)) s.exclusions.push({ id: nid('EXC'), checkId: i.checkId, urlPattern: new URL(u).pathname, reason: reason.trim(), createdById: me().id, createdByName: me().name, createdAt: iso() });
      }
      const t = i.taskId ? s.tasks.find((x) => x.id === i.taskId) : undefined;
      if (t && !['VERIFIED', 'CLOSED', 'CANCELLED', 'FIXED'].includes(t.status)) {
        t.status = 'CANCELLED';
        t.cancelReason = `Issue marked Not an issue: ${reason}`;
        act(t, 'status_changed', `Cancelled — issue marked Not an issue: ${reason}`);
      }
      audit('issue.not_an_issue', 'issue', id, `Not an issue: ${reason}${addExclusion ? ' (exclusion added)' : ''}`);
      return issueDetail(i);
    }),
    reopenIssue: (id, reason) => call('reopenIssue', () => {
      need('issues.allocate');
      if (!reason || reason.trim().length < 3) throw new ApiError(400, 'VALIDATION', 'A reason is required to reopen.');
      const i = issueById(id);
      if (!['NOT_AN_ISSUE', 'VERIFIED', 'CLOSED'].includes(i.status)) throw new ApiError(409, 'CONFLICT', 'Only closed, verified or not-an-issue findings can be reopened.');
      const t = i.taskId ? s.tasks.find((x) => x.id === i.taskId) : undefined;
      if (t && (t.status === 'VERIFIED' || t.status === 'CLOSED')) {
        const chk = canTransition(t.status, 'reopen_regression', { kind: 'user', id: me().id, role: me().role, isAssignee: t.assigneeId === me().id }, reason);
        if (!chk.ok) throw new ApiError(chk.code === 'FORBIDDEN' ? 403 : 409, chk.code!, chk.error!);
        t.status = 'ASSIGNED';
        t.reopenCount += 1;
        act(t, 'reopened', `Reopened (regression): ${reason}`);
        i.status = 'ASSIGNED';
      } else {
        i.status = i.allocatedTeam ? 'ASSIGNED' : 'NEW';
        i.notAnIssue = undefined;
      }
      i.occurrences += 1;
      i.delta = 'recurring';
      audit('issue.reopen', 'issue', id, `Reopened: ${reason}`);
      return issueDetail(i);
    }),
    approveProposal: (id, note) => call('approveProposal', () => {
      need('fixcards.approve_proposal');
      const i = issueById(id);
      audit('fixcard.approve_proposal', 'issue', id, `Human approval recorded for proposed change: ${note || '(no note)'} — Sentinel does not apply live-site changes (PDF §17).`);
      return issueDetail(i);
    }),
    listIssueGroups: () => call('listIssueGroups', () => { need('issues.view'); return s.groups.map((g) => ({ ...g, parent: s.issues.find((i) => i.groupId === g.id && i.isTemplateGroup)! })); }),
    listExclusions: () => call('listExclusions', () => { need('issues.view'); return s.exclusions; }),
    removeExclusion: (id) => call('removeExclusion', () => {
      need('issues.manage_exclusions');
      const idx = s.exclusions.findIndex((e) => e.id === id);
      if (idx < 0) throw new ApiError(404, 'NOT_FOUND', 'Exclusion not found.');
      const [ex] = s.exclusions.splice(idx, 1);
      audit('exclusion.remove', 'exclusion', id, `Removed exclusion ${ex.urlPattern}`);
    }),

    updateIssueStatus: (id, action, note) => call('updateIssueStatus', () => {
      need('issues.update_status');
      const i = issueById(id);
      const u = me();
      if (u.role === 'developer' && !(i.allocatedTeam && u.teamIds.includes(i.allocatedTeam))) throw new ApiError(403, 'FORBIDDEN', 'You can only update issues allocated to your team.');
      const t = i.taskId ? s.tasks.find((x) => x.id === i.taskId) : undefined;
      if (!i.allocatedTeam || !t) throw new ApiError(409, 'NOT_ALLOCATED', 'Allocate this issue to a team before updating its status.');
      const from = i.status;
      if (action === 'start') {
        if (i.status !== 'ASSIGNED') throw new ApiError(409, 'CONFLICT', `Only Assigned issues can be started (this one is ${i.status}).`);
        t.status = 'IN_PROGRESS';
        act(t, 'status_changed', `Work started by ${u.name}.`);
      } else if (action === 'mark_fixed') {
        if (!['ASSIGNED', 'IN_PROGRESS'].includes(i.status)) throw new ApiError(409, 'CONFLICT', `Only Assigned or In-progress issues can be marked fixed (this one is ${i.status}).`);
        t.status = 'FIXED';
        t.progress = 100;
        if (note?.trim()) t.evidence.push({ id: nid('EVD'), phase: 'after', kind: 'text', label: 'Fix note', content: note.trim(), addedById: u.id, addedByName: u.name, at: iso() });
        act(t, 'status_changed', `Marked fixed by ${u.name}${note?.trim() ? `: ${note.trim()}` : ''}. Not verified until a system re-check passes.`);
        s.verifications.push(pendingVerification(t));
        notify([teamLead('seo')], { type: 'review', title: `Fixed, awaiting verification: ${i.title}`, body: `${u.name} marked this issue fixed.`, link: `/issues/${i.id}`, severity: i.severity });
      } else {
        throw new ApiError(400, 'VALIDATION', 'Unknown action.');
      }
      syncIssueFromTask(t);
      audit(`issue.${action}`, 'issue', i.id, `${from} → ${i.status}${note?.trim() ? ` (${note.trim()})` : ''}`);
      return issueDetail(i);
    }),
    verifyIssue: (id) => call('verifyIssue', () => {
      need('issues.verify');
      const i = issueById(id);
      const t = i.taskId ? s.tasks.find((x) => x.id === i.taskId) : undefined;
      if (i.status !== 'FIXED' || !t) throw new ApiError(409, 'CONFLICT', 'Re-verification runs on issues marked Fixed.');
      const check = CHECKS_BY_ID[i.checkId];
      let attempt: VerificationAttempt;
      if (!check || !check.crawlerEvaluable) {
        attempt = { id: nid('VER'), taskId: t.id, issueId: i.id, at: iso(), triggeredBy: me().id, method: 'connector_check', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: `"${check?.name ?? i.checkId}" is verified from ${check?.dataSources.join(', ') ?? 'connector'} data, which is not connected in mock mode. Status stays Fixed (pending data) — no false pass.`, source: 'simulated' };
      } else {
        const hasNote = t.evidence.some((e) => e.phase === 'after');
        const failing = hasNote ? 0 : Math.max(1, Math.round(i.affectedCount * 0.25));
        attempt = { id: nid('VER'), taskId: t.id, issueId: i.id, at: iso(), triggeredBy: me().id, method: 'automated_recrawl', outcome: hasNote ? 'passed' : 'failed', checkedUrls: i.affectedCount, failingUrls: failing, details: `SIMULATED re-crawl (mock mode — no HTTP requests made): ${failing} of ${i.affectedCount} URLs still failing. Simulation rule: passes only when a fix note was recorded.`, source: 'simulated' };
      }
      t.verification.push(attempt);
      s.verifications.push(attempt);
      act(t, 'verification_run', `Verification ${attempt.outcome.toUpperCase()}: ${attempt.details}`, { outcome: attempt.outcome }, 'system');
      if (attempt.outcome === 'passed') t.status = 'VERIFIED';
      else if (attempt.outcome === 'failed') {
        t.status = 'IN_PROGRESS';
        if (i.allocatedTeam) notify([teamLead(i.allocatedTeam)], { type: 'verification', title: `Verification failed: ${i.title}`, body: attempt.details, link: `/issues/${i.id}` });
      }
      syncIssueFromTask(t);
      audit('verification.run', 'verification', attempt.id, `${attempt.outcome.toUpperCase()} — ${attempt.details}`);
      return { detail: issueDetail(i), attempt };
    }),

    listWebsites: () => call('listWebsites', () => {
      need('dashboard.view');
      const total = INTEGRATION_CATALOG.filter((i) => i.category !== 'tasks').length;
      return websites.map((w) => summarizeWebsite(w, sites.get(w.id)!, { connected: 0, total }, now()));
    }),
    createWebsite: (input) => call('createWebsite', () => {
      need('websites.manage');
      const v = validateWebsiteInput(input, websites);
      const w: Website = { id: `site-${v.domain.replace(/[^a-z0-9]+/g, '-')}-${++counter}`, ...v, createdAt: iso(), updatedAt: iso(), createdByName: me().name, source: 'manual' };
      websites.push(w);
      sites.set(w.id, { ...createEmptySite(now(), w), integrationSettings: {}, integrationTests: {} });
      const prev = active;
      active = w.id;
      audit('website.create', 'config', w.id, `Added website ${w.name} (${w.domain}) — not crawled yet`);
      active = prev;
      return w;
    }),
    updateWebsite: (id, input) => call('updateWebsite', () => {
      need('websites.manage');
      const w = websites.find((x) => x.id === id);
      if (!w) throw new ApiError(404, 'NOT_FOUND', 'Website not found.');
      const v = validateWebsiteInput(input, websites, id);
      if (w.source === 'demo' && v.domain !== w.domain) throw new ApiError(400, 'VALIDATION', 'The DEMO workspace domain cannot be changed — add a new website instead.');
      Object.assign(w, v, { updatedAt: iso() });
      const st = sites.get(id)!;
      st.config.site = { ...st.config.site, baseUrl: w.url.replace(/\/$/, ''), canonicalHost: w.domain, brand: w.name };
      return w;
    }),

    listCrawls: () => call('listCrawls', () => { need('crawls.view'); return [...s.crawls].reverse(); }),
    getCrawl: (id) => call('getCrawl', () => {
      need('crawls.view');
      const run = s.crawls.find((c) => c.id === id);
      if (!run) throw new ApiError(404, 'NOT_FOUND', `Crawl ${id} not found.`);
      return { run, urls: s.crawlUrls[id] ?? [], sitemapDiff: s.sitemapDiffs[id], verification: s.verifications.filter((v) => v.method === 'automated_recrawl' && run.startedAt && v.at >= run.startedAt && (!run.finishedAt || v.at <= new Date(new Date(run.finishedAt).getTime() + 86400000).toISOString())) };
    }),
    startCrawl: (type, options) => call('startCrawl', () => {
      need('crawls.run');
      if (options) throw new ApiError(409, 'CRAWLER_NOT_READY', MOCK_NO_LIVE_CRAWL);
      if (s.crawls.some((c) => c.status === 'running' || c.status === 'queued')) throw new ApiError(409, 'CONFLICT', 'A crawl is already running. Wait for it to finish.');
      const planned = type === 'full' ? s.siteSize : type === 'reverify' ? s.issues.filter((i) => i.status === 'FIXED').reduce((a, i) => a + i.affectedCount, 0) || 1 : 1 + s.catalog.collections.length + s.config.crawl.smartTopProducts + 120;
      const run: CrawlRun = { id: nid('CRL'), type, status: 'running', trigger: 'manual', startedAt: iso(), urlsPlanned: planned, urlsCrawled: 0, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [{ label: 'SIMULATED run — mock mode makes no HTTP requests', count: planned }], source: 'simulated' };
      s.crawls.push(run);
      audit('crawl.start', 'crawl', run.id, `Started ${type} crawl (SIMULATED)`);
      setTimeout(() => {
        run.status = 'completed';
        run.finishedAt = new Date().toISOString();
        run.urlsCrawled = planned;
        run.durationMs = 6000;
        run.error = 'Simulated completion: no URLs were actually fetched and no findings were produced. Run the real crawler from the API server (Phase 2).';
      }, 6000);
      return run;
    }),
    cancelCrawl: (id) => call('cancelCrawl', () => {
      need('crawls.run');
      const run = s.crawls.find((c) => c.id === id);
      if (!run) throw new ApiError(404, 'NOT_FOUND', `Crawl ${id} not found.`);
      if (run.status !== 'running' && run.status !== 'queued') throw new ApiError(409, 'NOT_RUNNING', `Crawl ${id} is ${run.status}, so it cannot be cancelled.`);
      run.status = 'cancelled';
      run.finishedAt = iso();
      run.error = 'Simulated run cancelled. Mock mode makes no HTTP requests.';
      audit('crawl.cancel', 'crawl', id, `Cancelled ${run.type} crawl (SIMULATED)`);
      return run;
    }),
    getCrawlerStatus: () => call('getCrawlerStatus', () => {
      need('crawls.view');
      return { ready: false, reason: MOCK_NO_LIVE_CRAWL, siteUrl: s.config.site.baseUrl, maxPagesCap: null, smartPageBudget: SMART_CRAWL_PAGE_BUDGET, temporaryStorage: true, schedulerEnabled: false, respectsRobots: true, requestDelayMs: 0, maxBodyBytes: 0 };
    }),
    exportCrawl: (id, format) => call('exportCrawl', () => {
      need('crawls.view');
      const run = s.crawls.find((c) => c.id === id);
      if (!run) throw new ApiError(404, 'NOT_FOUND', `Crawl ${id} not found.`);
      // Rows with their crawl-wide fields (problem flags, audit score, to-do checks), in crawl order.
      const all = s.crawlUrls[id] ?? [];
      const urls: CrawledUrl[] = [];
      for (let o = 0; o < all.length; o += 500) urls.push(...queryCrawlRows(all, { offset: o, limit: 500 }).rows);
      const d = { run, urls, sitemapDiff: s.sitemapDiffs[id], verification: [] };
      return format === 'csv'
        ? { filename: crawlExportFilename(d, 'csv'), mimeType: 'text/csv;charset=utf-8', content: crawlResultsCsv(d) }
        : { filename: crawlExportFilename(d, 'json'), mimeType: 'application/json;charset=utf-8', content: crawlResultsJson(d, iso()) };
    }),
    getCrawlPages: (id, query) => call('getCrawlPages', () => {
      need('crawls.view');
      if (!s.crawls.some((c) => c.id === id)) throw new ApiError(404, 'NOT_FOUND', `Crawl ${id} not found.`);
      return queryCrawlRows(s.crawlUrls[id] ?? [], query);
    }),
    getCrawlPage: (id, url) => call('getCrawlPage', () => {
      need('crawls.view');
      const runs = s.crawls.filter((c) => (id === 'latest' ? (c.status === 'completed' || c.status === 'cancelled') && (s.crawlUrls[c.id]?.length ?? 0) > 0 : c.id === id))
        .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      const run = runs[0];
      if (!run) throw new ApiError(404, 'NOT_FOUND', id === 'latest' ? 'No finished crawl with page results.' : `Crawl ${id} not found.`);
      const key = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
      const res = queryCrawlRows(s.crawlUrls[run.id] ?? [], { limit: 500, q: (() => { try { return new URL(url).pathname; } catch { return url; } })() });
      const row = res.rows.find((r) => key(r.url) === key(url));
      if (!row) throw new ApiError(404, 'NOT_FOUND', `${url} is not in crawl ${run.id}.`);
      const all = s.crawlUrls[run.id] ?? [];
      const same = (pick: (u: CrawledUrl) => string | undefined) => {
        const v = pick(row)?.trim().toLowerCase();
        const urls = v ? all.filter((u) => u.url !== row.url && u.status === 200 && pick(u)?.trim().toLowerCase() === v).map((u) => u.url) : [];
        return { urls: urls.slice(0, 10), total: urls.length };
      };
      return { runId: run.id, crawledAt: run.startedAt, row, audit: auditPage(row, DEFAULT_PAGE_AUDIT_LIMITS), limits: DEFAULT_PAGE_AUDIT_LIMITS, duplicates: { title: same((u) => u.title), meta: same((u) => u.metaDescription) } };
    }),
    getCrawlCoverage: (id) => call('getCrawlCoverage', () => {
      need('crawls.view');
      if (!s.crawls.some((c) => c.id === id)) throw new ApiError(404, 'NOT_FOUND', `Crawl ${id} not found.`);
      return {
        available: false, note: 'Mock mode makes no HTTP requests, so there is no crawl coverage to report. Connect the app to the API server for live crawls.',
        counts: {}, excludedBy: {}, foundVia: {}, listLimit: 0, sitemapNotCrawled: { count: 0, urls: [] }, linkedNotInSitemap: { count: 0, urls: [] },
        orphanCandidates: { count: 0, urls: [], evaluated: false }, failed: { count: 0, urls: [] }, redirects: { count: 0, urls: [] }, variantGroups: { count: 0, groups: [] },
        duplicates: { titles: { count: 0, groups: [] }, metaDescriptions: { count: 0, groups: [] }, exactContent: { count: 0, groups: [] }, nearContent: { count: 0, groups: [], threshold: 0.9 } },
        notProcessed: { count: 0, urls: [] },
      };
    }),
    getLighthouseStatus: () => call('getLighthouseStatus', () => {
      need('crawls.view');
      return { available: false, problems: ['Mock mode has no browser: Lighthouse runs on the API server. Connect the app to the API server.'], memoryNeededMB: 350, queued: 0 };
    }),
    startLighthouse: () => call('startLighthouse', () => {
      need('crawls.run');
      throw new ApiError(409, 'LIGHTHOUSE_UNAVAILABLE', 'Mock mode has no browser: Lighthouse runs on the API server.');
    }),
    listLighthouseRuns: () => call('listLighthouseRuns', () => { need('crawls.view'); return []; }),
    // Shopify: mock mode never talks to a store — every action explains that it needs the API server.
    getShopifyStatus: () => call('getShopifyStatus', () => {
      need('integrations.view');
      return {
        connected: false, via: null, apiVersion: '2026-07', scopes: [], missingScopes: [], missingOptionalScopes: [],
        requiredScopes: [...SHOPIFY_REQUIRED_SCOPES], optionalScopes: [...SHOPIFY_OPTIONAL_SCOPES], oauthConfigured: false,
        problems: ['Mock mode has no Shopify connection: the SEO editor reads and writes Shopify through the API server. Connect the app to the API server.'],
        tokenNote: 'The access token is only ever held by the API server.', capabilities: { edit: false, themes: false, themeWrite: false, imageAlt: false },
      };
    }),
    startShopifyOAuth: () => call('startShopifyOAuth', () => { need('integrations.manage'); throw shopifyMock(); }),
    disconnectShopify: () => call('disconnectShopify', () => { need('integrations.manage'); throw shopifyMock(); }),
    resolveShopifyUrl: () => call('resolveShopifyUrl', () => { need('shopify.edit'); throw shopifyMock(); }),
    listShopifyResources: () => call('listShopifyResources', () => { need('shopify.edit'); throw shopifyMock(); }),
    createShopifyDraft: () => call('createShopifyDraft', () => { need('shopify.edit'); throw shopifyMock(); }),
    listShopifyDrafts: () => call('listShopifyDrafts', () => { need('shopify.edit'); return []; }),
    getShopifyDraft: () => call('getShopifyDraft', () => { need('shopify.edit'); throw new ApiError(404, 'NOT_FOUND', 'Draft not found.'); }),
    updateShopifyDraft: () => call('updateShopifyDraft', () => { need('shopify.edit'); throw shopifyMock(); }),
    deleteShopifyDraft: () => call('deleteShopifyDraft', () => { need('shopify.edit'); throw shopifyMock(); }),
    refreshShopifyDraft: () => call('refreshShopifyDraft', () => { need('shopify.edit'); throw shopifyMock(); }),
    previewShopifyApply: () => call('previewShopifyApply', () => { need('shopify.edit'); throw shopifyMock(); }),
    downloadShopifyBackup: () => call('downloadShopifyBackup', () => { need('shopify.edit'); throw shopifyMock(); }),
    applyShopifyDrafts: () => call('applyShopifyDrafts', () => { need('shopify.edit'); throw shopifyMock(); }),
    reauditShopifyDraft: () => call('reauditShopifyDraft', () => { need('shopify.edit'); throw shopifyMock(); }),
    listShopifyThemes: () => call('listShopifyThemes', () => { need('shopify.theme'); throw shopifyMock(); }),
    getShopifyThemeFile: () => call('getShopifyThemeFile', () => { need('shopify.theme'); throw shopifyMock(); }),
    proposeShopifyThemeChange: () => call('proposeShopifyThemeChange', () => { need('shopify.theme'); throw shopifyMock(); }),
    listShopifyThemeProposals: () => call('listShopifyThemeProposals', () => { need('shopify.theme'); return []; }),
    applyShopifyThemeProposal: () => call('applyShopifyThemeProposal', () => { need('shopify.theme'); throw shopifyMock(); }),
    downloadShopifyThemeBackup: () => call('downloadShopifyThemeBackup', () => { need('shopify.theme'); throw shopifyMock(); }),
    createThemeSnapshot: () => call('createThemeSnapshot', () => { need('shopify.theme'); throw shopifyMock(); }),
    listThemeSnapshots: () => call('listThemeSnapshots', () => { need('shopify.theme'); return []; }),
    diffThemeSnapshots: () => call('diffThemeSnapshots', () => { need('shopify.theme'); throw shopifyMock(); }),
    // Change Monitor + page captures: mock mode makes no crawls and runs no browser, so there is nothing to compare.
    getChangeStatus: () => call('getChangeStatus', () => {
      need('crawls.view');
      return {
        enabled: false, directory: '(mock mode)', persistentHint: 'Mock mode keeps no change history: crawls are simulated. Connect the app to the API server (VITE_API_MODE=http).',
        retention: { keepRuns: 0, maxAgeDays: 0 }, baseline: null, runs: [], diskBytes: 0,
      };
    }),
    getChangeSummary: () => call('getChangeSummary', () => { need('crawls.view'); throw changesMock(); }),
    listChanges: () => call('listChanges', () => { need('crawls.view'); throw changesMock(); }),
    getChange: () => call('getChange', () => { need('crawls.view'); throw changesMock(); }),
    getChangeIssues: () => call('getChangeIssues', () => { need('crawls.view'); return {}; }),
    getUrlChange: () => call('getUrlChange', () => { need('crawls.view'); return { change: null }; }),
    // The Image Audit requests real images from the API server; the browser-only demo never makes up results.
    getImageAuditStatus: () => call('getImageAuditStatus', () => {
      need('crawls.view');
      return { runs: [], jobs: [], available: false, reason: 'The Image Audit runs on the API server and checks real images. This browser-only demo has no crawl to audit.', limits: { maxImages: 50000, budgetMinutes: 30, concurrency: 4, probeKb: 64 } };
    }),
    startImageAudit: () => call('startImageAudit', () => { need('crawls.run'); throw new ApiError(409, 'IMAGE_AUDIT_UNAVAILABLE', 'The Image Audit runs on the API server; it is not available in the browser-only demo.'); }),
    getImageAudit: (id) => call('getImageAudit', () => { throw new ApiError(404, 'NOT_FOUND', `Image Audit ${id} not found.`); }),
    cancelImageAudit: (id) => call('cancelImageAudit', () => { throw new ApiError(404, 'NOT_FOUND', `Image Audit ${id} not found.`); }),
    listImageAudit: (id) => call('listImageAudit', () => { throw new ApiError(404, 'NOT_FOUND', `Image Audit ${id} not found.`); }),
    exportImageAudit: (id) => call('exportImageAudit', () => { throw new ApiError(404, 'NOT_FOUND', `Image Audit ${id} not found.`); }),
    exportChanges: () => call('exportChanges', () => { need('crawls.view'); throw changesMock(); }),
    getCaptureStatus: () => call('getCaptureStatus', () => {
      need('crawls.view');
      return {
        available: false, problems: ['Mock mode runs no browser: screenshots are taken by the API server.'], memoryNeededMB: 300,
        afterCrawl: { enabled: false, changedPages: 0, viewports: [] }, watch: [], jobs: [], limits: { keepPerPage: 0, maxPages: 0, maxHeight: 0, concurrency: 1 },
      };
    }),
    requestCaptures: () => call('requestCaptures', () => { need('crawls.run'); throw changesMock(); }),
    getCaptureJob: () => call('getCaptureJob', () => { need('crawls.view'); throw new ApiError(404, 'NOT_FOUND', 'Capture job not found.'); }),
    setCaptureWatch: () => call('setCaptureWatch', () => { need('crawls.configure'); throw changesMock(); }),
    listCapturePages: () => call('listCapturePages', () => { need('crawls.view'); return []; }),
    listCaptures: () => call('listCaptures', () => { need('crawls.view'); return []; }),
    getCaptureImage: () => call('getCaptureImage', () => { need('crawls.view'); throw changesMock(); }),
    downloadCaptureHtml: () => call('downloadCaptureHtml', () => { need('crawls.view'); throw changesMock(); }),
    compareCaptures: (input) => call('compareCaptures', () => {
      need('crawls.view');
      const reason = 'Mock mode runs no browser: no screenshot exists, and none is made up.';
      return { url: input.url, viewport: input.viewport, from: null, to: null, visual: { available: false, reason }, dom: { available: false, reason, note: '' }, seoFields: [], assets: { available: false, reason, items: [] }, change: null };
    }),
    getCaptureAssetDiff: () => call('getCaptureAssetDiff', () => { need('crawls.view'); throw changesMock(); }),
    listSchedules: () => call('listSchedules', () => { need('crawls.view'); return s.schedules; }),
    updateSchedule: (id, input) => call('updateSchedule', () => {
      need('crawls.configure');
      const sc = s.schedules.find((x) => x.id === id);
      if (!sc) throw new ApiError(404, 'NOT_FOUND', 'Schedule not found.');
      if (input.cron !== undefined) {
        if (!/^(\S+\s+){4}\S+$/.test(input.cron.trim())) throw new ApiError(400, 'VALIDATION', 'Cron must have 5 fields: minute hour day-of-month month day-of-week.');
        sc.cron = input.cron.trim();
      }
      if (input.enabled !== undefined) sc.enabled = input.enabled;
      audit('crawl.schedule_update', 'crawl', id, `Schedule ${sc.type}: ${sc.cron} (${sc.enabled ? 'enabled' : 'disabled'})`);
      return sc;
    }),
    listVerifications: () => call('listVerifications', () => { need('crawls.view'); return [...s.verifications].sort((a, b) => b.at.localeCompare(a.at)); }),

    listOpportunities: () => call('listOpportunities', () => { need('opportunities.view'); return [...s.opportunities].sort((a, b) => b.value - a.value); }),
    dismissOpportunity: (id) => call('dismissOpportunity', () => {
      need('opportunities.manage');
      const o = s.opportunities.find((x) => x.id === id);
      if (!o) throw new ApiError(404, 'NOT_FOUND', 'Opportunity not found.');
      o.status = 'dismissed';
      audit('opportunity.dismiss', 'opportunity', id, `Dismissed ${o.title}`);
      return o;
    }),
    listKeywordGaps: () => call('listKeywordGaps', () => { need('opportunities.view'); return { items: s.keywordGaps, available: isDemoSite(), note: isDemoSite() ? 'DEMO data — keyword gaps require an Ahrefs or Semrush API subscription.' : 'Not available — keyword gaps require an Ahrefs or Semrush API subscription (not connected for this website).' }; }),
    updateKeywordGap: (id, status) => call('updateKeywordGap', () => {
      need('opportunities.manage');
      const g = s.keywordGaps.find((x) => x.id === id);
      if (!g) throw new ApiError(404, 'NOT_FOUND', 'Keyword gap not found.');
      g.status = status;
      audit('opportunity.keyword_gap', 'opportunity', id, `${g.keyword} → ${status}`);
      return g;
    }),
    listStrikingDistance: () => call('listStrikingDistance', () => { need('opportunities.view'); return s.striking; }),
    listCtrRewrites: () => call('listCtrRewrites', () => { need('opportunities.view'); return s.ctrRewrites; }),
    listBriefs: () => call('listBriefs', () => { need('opportunities.view'); return s.briefs; }),
    getBrief: (id) => call('getBrief', () => {
      need('opportunities.view');
      const b = s.briefs.find((x) => x.id === id);
      if (!b) throw new ApiError(404, 'NOT_FOUND', 'Brief not found.');
      return b;
    }),
    saveBrief: (brief: ContentBrief) => call('saveBrief', () => {
      need('opportunities.manage');
      if (!brief.title.trim() || !brief.targetKeyword.trim()) throw new ApiError(400, 'VALIDATION', 'Title and target keyword are required.');
      if (!brief.suggestedUrl.startsWith('/')) throw new ApiError(400, 'VALIDATION', 'Suggested URL must be a site path starting with "/".');
      const idx = s.briefs.findIndex((x) => x.id === brief.id);
      const saved = { ...brief, updatedAt: iso() };
      if (idx >= 0) s.briefs[idx] = saved;
      else s.briefs.push({ ...saved, id: nid('BRF') });
      audit('brief.save', 'brief', saved.id, `Saved brief "${saved.title}" (${saved.status})`);
      return idx >= 0 ? saved : s.briefs.at(-1)!;
    }),
    generateBriefFromGap: (gapId) => call('generateBriefFromGap', () => {
      need('opportunities.manage');
      const g = s.keywordGaps.find((x) => x.id === gapId);
      if (!g) throw new ApiError(404, 'NOT_FOUND', 'Keyword gap not found.');
      if (g.status !== 'approved') throw new ApiError(409, 'NOT_APPROVED', 'Approve the keyword gap before generating a brief (PDF §13: each approved gap generates a brief).');
      const slugged = g.keyword.replace(/[^a-z0-9]+/g, '-');
      const b: ContentBrief = {
        id: nid('BRF'), title: `${g.keyword.replace(/\b\w/g, (m) => m.toUpperCase())}: guide for resellers`, targetKeyword: g.keyword, cluster: g.relevantCategory ?? 'General',
        intent: g.intent, suggestedUrl: g.intent === 'transactional' ? `/collections/${slugged}` : `/blogs/news/${slugged}`, pageType: g.intent === 'transactional' ? 'collection' : g.intent === 'commercial' ? 'buying_guide' : 'blog',
        outline: ['Direct answer / intro (40–60 words)', `What buyers look for in ${g.keyword}`, 'Wholesale pricing, pack sizes and No MOQ', 'How to order (COD, shipping)', 'FAQ'],
        entities: [g.keyword, 'wholesale', 'No MOQ', 'COD', g.relevantCategory ?? ''].filter(Boolean),
        faqs: [{ q: `What is the minimum order for ${g.keyword}?` }, { q: 'Do you ship across India?' }],
        internalLinks: g.relevantCategory ? [{ from: `/collections/${g.relevantCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, anchor: g.keyword }] : [],
        origin: 'keyword_gap', originRef: g.id, status: 'draft', updatedAt: iso(), source: 'simulated',
      };
      s.briefs.push(b);
      g.status = 'brief_created';
      audit('brief.generate', 'brief', b.id, `Generated brief from gap ${g.id} (${g.keyword}) — outline is a template; SERP-based outline requires the backlink/SERP API.`);
      return b;
    }),
    listClusters: () => call('listClusters', () => { need('opportunities.view'); return s.clusters; }),
    getSeasonalPlan: () => call('getSeasonalPlan', () => { need('opportunities.view'); return { festivals: seasonalPlan(ensureFestivals(), s.catalog.collections, s.config.thresholds.festivalLeadDays, now()), leadDays: s.config.thresholds.festivalLeadDays }; }),

    listBacklinks: () => call('listBacklinks', () => { need('modules.view'); return { items: s.backlinks, trend: s.refTrend, available: isDemoSite(), note: isDemoSite() ? 'DEMO data — requires Ahrefs or Semrush API.' : 'Not available — requires the Ahrefs or Semrush API (not connected for this website).' }; }),
    listLinkProspects: () => call('listLinkProspects', () => { need('opportunities.view'); return s.prospects; }),
    listBrandMentions: () => call('listBrandMentions', () => { need('opportunities.view'); return s.mentions; }),
    updateBrandMention: (id, status) => call('updateBrandMention', () => {
      need('opportunities.manage');
      const m = s.mentions.find((x) => x.id === id);
      if (!m) throw new ApiError(404, 'NOT_FOUND', 'Mention not found.');
      m.status = status;
      audit('opportunity.mention', 'opportunity', id, `Brand mention ${m.domain} → ${status}`);
      return m;
    }),
    listDisavowCandidates: () => call('listDisavowCandidates', () => { need('modules.view'); return s.disavow; }),
    decideDisavow: (id, decision) => call('decideDisavow', () => {
      need('disavow.approve');
      const d = s.disavow.find((x) => x.id === id);
      if (!d) throw new ApiError(404, 'NOT_FOUND', 'Candidate not found.');
      if (d.approval !== 'pending') throw new ApiError(409, 'CONFLICT', `Already ${d.approval}.`);
      d.approval = decision;
      d.decidedById = me().id;
      d.decidedAt = iso();
      audit(`disavow.${decision === 'approved' ? 'approve' : 'reject'}`, 'disavow', id, `${decision} ${d.domain} — Sentinel does not submit to Google; upload the approved file in GSC manually.`);
      return d;
    }),
    getCompetitors: () => call('getCompetitors', () => { need('opportunities.view'); return s.competitors; }),
    getLocalHealth: () => call('getLocalHealth', () => { need('modules.view'); return isDemoSite() ? { ...s.localHealth, available: true, note: 'DEMO data — requires Google Business Profile API.' } : { napConsistency: [], gbp: null, available: false, note: 'Not available — requires the Google Business Profile API (not connected for this website).' }; }),
    getAiVisibility: () => call('getAiVisibility', () => { need('modules.view'); return { prompts: s.aiPrompts, trend: s.aiTrend, available: isDemoSite(), note: isDemoSite() ? 'DEMO data — the weekly panel requires OpenAI / Gemini / Perplexity API keys.' : 'Not available — the weekly panel requires OpenAI / Gemini / Perplexity API keys (not configured for this website).' }; }),

    listAiFlags: () => call('listAiFlags', () => { need('modules.view'); return s.aiFlags; }),
    decideQaHold: (flagId, decision, note) => call('decideQaHold', () => {
      need('qa_gate.approve');
      const f = s.aiFlags.find((x) => x.id === flagId);
      if (!f) throw new ApiError(404, 'NOT_FOUND', 'Flag not found.');
      if (!f.qaHold) throw new ApiError(409, 'CONFLICT', 'This flag does not hold the QA gate.');
      if (f.qaHoldStatus !== 'held') throw new ApiError(409, 'CONFLICT', `Already ${f.qaHoldStatus}.`);
      if (note.trim().length < 10) throw new ApiError(400, 'VALIDATION', 'Record what you verified (at least 10 characters) — this is the human sign-off.');
      f.qaHoldStatus = decision;
      f.qaDecision = { byId: me().id, byName: me().name, at: iso(), note: note.trim() };
      audit(`qa_gate.${decision}`, 'qa_gate', flagId, `QA gate ${decision} for ${f.url}: ${note}`);
      return f;
    }),
    listRules: () => call('listRules', () => { need('rules.view'); return s.rules; }),
    saveRule: (input) => call('saveRule', () => {
      need('rules.manage');
      const errs = validateRule(input);
      if (errs.length) throw new ApiError(400, 'VALIDATION', errs.join(' '), errs);
      if (input.id) {
        const r = s.rules.find((x) => x.id === input.id);
        if (!r) throw new ApiError(404, 'NOT_FOUND', 'Rule not found.');
        Object.assign(r, input, { updatedAt: iso() });
        audit('rule.update', 'rule', r.id, `Updated rule "${r.name}"`);
        return r;
      }
      const r: CustomRule = { ...input, id: nid('RULE'), createdById: me().id, createdAt: iso(), updatedAt: iso(), source: 'manual' } as CustomRule;
      s.rules.push(r);
      audit('rule.create', 'rule', r.id, `Created rule "${r.name}"`);
      return r;
    }),
    deleteRule: (id) => call('deleteRule', () => {
      need('rules.manage');
      const idx = s.rules.findIndex((r) => r.id === id);
      if (idx < 0) throw new ApiError(404, 'NOT_FOUND', 'Rule not found.');
      const [r] = s.rules.splice(idx, 1);
      audit('rule.delete', 'rule', id, `Deleted rule "${r.name}"`);
    }),
    dryRunRule: (input) => call('dryRunRule', () => {
      need('rules.manage');
      const errs = validateRule(input);
      if (errs.length) throw new ApiError(400, 'VALIDATION', errs.join(' '), errs);
      const rule = { ...input, id: input.id ?? 'draft', createdById: me().id, createdAt: iso(), updatedAt: iso(), source: 'manual' } as CustomRule;
      const windowDays = s.config.thresholds.dryRunWindowDays;
      const cutoff = now().getTime() - windowDays * 86400000;
      const pages = s.pageTexts.filter((p) => !p.publishedAt || new Date(p.publishedAt).getTime() >= cutoff).filter((p) => ruleAppliesTo({ ...rule, scope: { ...rule.scope, newlyPublishedOnly: false } }, p, now()));
      const samples: DryRunResult['samples'] = [];
      let flagged = 0;
      let evaluated = true;
      let note: string | undefined;
      for (const p of pages) {
        const r = evaluateRule(rule, p);
        if (!r.evaluated) { evaluated = false; note = r.reason; break; }
        if (r.flagged) { flagged++; if (samples.length < 10) samples.push({ url: p.url, passage: r.passage ?? '', reason: r.reason ?? '' }); }
      }
      const res: DryRunResult = { ruleId: input.id, ranAt: iso(), pagesScanned: evaluated ? pages.length : 0, pagesFlagged: flagged, windowDays, samples, evaluated, note: note ?? `Dry run over ${pages.length} DEMO page texts published in the last ${windowDays} days. Nothing was flagged in the digest.`, source: 'simulated' };
      if (input.id) { const r = s.rules.find((x) => x.id === input.id); if (r) r.lastDryRun = res; }
      return res;
    }),
    setRuleEnabled: (id, enabled) => call('setRuleEnabled', () => {
      need('rules.manage');
      const r = s.rules.find((x) => x.id === id);
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Rule not found.');
      if (enabled && r.method === 'llm_judged') throw new ApiError(409, 'PROVIDER_REQUIRED', 'LLM-judged rules cannot be enabled until an LLM provider (OPENAI_API_KEY or GEMINI_API_KEY) is configured on the server.');
      if (enabled && !r.lastDryRun) throw new ApiError(409, 'DRY_RUN_REQUIRED', 'Run a dry run against the last 30 days of pages before enabling (PDF §10.2 test mode).');
      r.enabled = enabled;
      audit(enabled ? 'rule.enable' : 'rule.disable', 'rule', id, `${enabled ? 'Enabled' : 'Disabled'} "${r.name}"`);
      return r;
    }),

    getDailyDigest: () => call('getDailyDigest', () => { need('reports.view'); return buildDailyDigest(view(), now()); }),
    getWeeklyReport: () => call('getWeeklyReport', () => { need('reports.view'); return buildWeeklyReport(view(), now()); }),
    getMonthlyReport: () => call('getMonthlyReport', () => { need('reports.view'); return buildMonthlyReport(view(), now()); }),
    listReportHistory: () => call('listReportHistory', () => {
      need('reports.view');
      const out = [];
      for (let d = 0; d < 14; d++) {
        const day = new Date(now().getTime() - d * 86400000);
        const m = buildDailyDigest(view(), day).meta;
        out.push({ ...m, deliveries: s.deliveries.filter((x) => x.kind === 'daily_digest' && x.at.slice(0, 10) === day.toISOString().slice(0, 10)) });
      }
      out.push(buildWeeklyReport(view(), now()).meta, buildMonthlyReport(view(), now()).meta);
      return out.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
    }),
    exportReport: (kind, format) => call('exportReport', () => {
      need('reports.export');
      const rep = kind === 'daily' ? buildDailyDigest(view(), now()) : kind === 'weekly' ? buildWeeklyReport(view(), now()) : buildMonthlyReport(view(), now());
      audit('report.export', 'report', `${kind}-${format}`, `Exported ${kind} report as ${format}`);
      return exportReport(kind, format, rep);
    }),
    sendReport: (kind) => call('sendReport', () => {
      need('reports.export');
      const subject = `${kind === 'daily' ? 'Daily SEO digest' : kind === 'weekly' ? 'Weekly SEO rollup' : 'Monthly executive SEO report'} — ${now().toISOString().slice(0, 10)}`;
      const k = kind === 'daily' ? 'daily_digest' : kind === 'weekly' ? 'weekly_report' : 'monthly_report';
      const out = s.config.reporting.channels.filter((c) => c !== 'in_app').map((c) => recordDelivery({ channel: c as DeliveryAttempt['channel'], kind: k, subject }));
      audit('report.send', 'report', kind, `Send requested — ${out.length} channel(s) skipped: not configured`);
      return out;
    }),

    listNotifications: () => call('listNotifications', () => s.notifications.filter((n) => n.recipientId === me().id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    markNotificationRead: (id) => call('markNotificationRead', () => {
      for (const n of s.notifications) if (n.recipientId === me().id && (id === 'all' || n.id === id) && !n.readAt) n.readAt = iso();
    }),
    listDeliveries: () => call('listDeliveries', () => { need('reports.view'); return [...s.deliveries].sort((a, b) => b.at.localeCompare(a.at)); }),
    updateAlertRules: (rules) => call('updateAlertRules', () => {
      need('notifications.configure');
      for (const r of rules) if (r.enabled && !r.channels.length) throw new ApiError(400, 'VALIDATION', `"${r.label}" is enabled but has no channels.`);
      s.config.alerts = rules;
      audit('config.alerts', 'config', 'alerts', 'Updated real-time alert routing');
      return s.config.alerts;
    }),

    listEmployees: () => call('listEmployees', () => { need('employees.view'); return s.employees; }),
    createEmployee: (input: EmployeeInput) => call('createEmployee', () => {
      need('employees.manage');
      validateEmployee(input);
      if (s.employees.some((e) => e.email.toLowerCase() === input.email.toLowerCase())) throw new ApiError(409, 'CONFLICT', 'An employee with this email already exists.');
      const e: Employee = { id: nid('emp'), name: input.name.trim(), email: input.email.trim().toLowerCase(), role: input.role, teamIds: input.teamIds, title: input.title.trim(), status: input.status ?? 'invited', capacityHoursPerWeek: input.capacityHoursPerWeek ?? 40, isSeoLead: input.isSeoLead, createdAt: iso(), source: 'manual' };
      s.employees.push(e);
      s.passwords[e.email] = DEMO_PASSWORD;
      audit('employee.create', 'employee', e.id, `Invited ${e.name} as ${ROLE_LABELS[e.role]} (${e.teamIds.map((t) => TEAMS[t].shortName).join(', ')})`);
      return e;
    }),
    updateEmployee: (id, input) => call('updateEmployee', () => {
      need('employees.manage');
      const e = s.employees.find((x) => x.id === id);
      if (!e) throw new ApiError(404, 'NOT_FOUND', 'Employee not found.');
      const merged = { ...e, ...input } as EmployeeInput;
      validateEmployee(merged);
      if (e.id === me().id && input.role && input.role !== 'admin') throw new ApiError(409, 'CONFLICT', 'You cannot remove your own Admin role.');
      if (e.id === me().id && input.status && input.status !== 'active') throw new ApiError(409, 'CONFLICT', 'You cannot deactivate your own account.');
      const before = { role: e.role, teamIds: e.teamIds, status: e.status };
      Object.assign(e, input);
      audit('employee.update', 'employee', id, `Updated ${e.name}`, { before, after: { role: e.role, teamIds: e.teamIds, status: e.status } });
      return e;
    }),
    getPermissionMatrix: () => call('getPermissionMatrix', () => { need('employees.view'); return s.permissions; }),
    updatePermissionMatrix: (m: PermissionMatrix) => call('updatePermissionMatrix', () => {
      need('roles.manage');
      if (!m.admin.includes('roles.manage')) throw new ApiError(409, 'CONFLICT', 'Admin must keep "roles.manage" so the matrix can still be edited.');
      const before = s.permissions;
      s.permissions = m;
      audit('roles.update', 'employee', 'permission-matrix', 'Updated role permission matrix', { before, after: m });
      return s.permissions;
    }),
    listAllocationHistory: () => call('listAllocationHistory', () => { need('issues.view'); return s.issues.flatMap((i) => i.allocation.map((a) => ({ ...a, issueTitle: i.title }))).sort((a, b) => b.at.localeCompare(a.at)); }),

    getConfig: () => call('getConfig', () => { need('settings.view'); return s.config; }),
    updateConfig: (patch: Partial<SentinelConfig>) => call('updateConfig', () => {
      need('settings.manage');
      const touchesAdmin = patch.automation || patch.crawl;
      if (touchesAdmin && me().role !== 'admin' && patch.automation) throw new ApiError(403, 'FORBIDDEN', 'Only Admins can change live-site automation opt-ins.');
      const next = { ...s.config, ...patch };
      const wsum = Object.values(next.scoring.weights).reduce((a, b) => a + b, 0);
      if (Math.abs(wsum - 1) > 0.001) throw new ApiError(400, 'VALIDATION', `Module weights must sum to 100% (currently ${(wsum * 100).toFixed(1)}%).`);
      if (next.sla.mediumDays < 1 || next.sla.lowDays < next.sla.mediumDays) throw new ApiError(400, 'VALIDATION', 'Medium SLA must be ≥1 day and Low SLA must be ≥ Medium SLA.');
      if (next.escalation.templateGroupThreshold < 2) throw new ApiError(400, 'VALIDATION', 'Template grouping threshold must be at least 2.');
      for (const [k, v] of Object.entries(next.thresholds)) if (!Number.isFinite(v) || v < 0) throw new ApiError(400, 'VALIDATION', `Threshold ${k} must be a non-negative number.`);
      const before = s.config;
      s.config = { ...next, updatedAt: iso(), updatedBy: me().name };
      setPriorityConfig(s.config);
      audit('config.update', 'config', 'sentinel-config', `Updated configuration (${Object.keys(patch).join(', ')})`, { before, after: s.config });
      return s.config;
    }),
    listIntegrations: () => call('listIntegrations', () => { need('integrations.view'); return INTEGRATION_CATALOG.map((i) => integrationStatus(i.id)); }),
    updateIntegration: (id, settings) => call('updateIntegration', () => {
      need('integrations.manage');
      for (const k of Object.keys(settings)) if (/token|secret|password|key/i.test(k)) throw new ApiError(400, 'SECRET_IN_SETTINGS', `"${k}" looks like a secret. Secrets are set as environment variables on the API server, never through the UI.`);
      s.integrationSettings[id] = { ...(s.integrationSettings[id] ?? {}), ...settings };
      audit('integration.update', 'integration', id, `Updated non-secret settings for ${id}`);
      return integrationStatus(id);
    }),
    testIntegration: (id) => call('testIntegration', () => {
      need('integrations.manage');
      s.integrationTests[id] = { at: iso(), result: 'Not tested: mock mode runs in the browser and cannot reach external APIs or read server environment variables.' };
      audit('integration.test', 'integration', id, `Connection test requested for ${id} — not possible in mock mode`);
      return integrationStatus(id);
    }),

    syncIntegration: (id) => call('syncIntegration', () => {
      need('integrations.manage');
      audit('integration.sync', 'integration', id, `Data sync requested for ${id} — not possible in mock mode`);
      return { id, ran: false as const, reason: 'Mock mode runs in the browser and cannot reach external APIs. Run the API server (VITE_API_MODE=http) with credentials configured and a passed connection test.' };
    }),

    listAuditLog: (f) => call('listAuditLog', () => {
      need('audit.view');
      let list = [...s.audit].reverse();
      if (f.q) { const q = f.q.toLowerCase(); list = list.filter((a) => a.summary.toLowerCase().includes(q) || a.action.includes(q) || a.entityId.toLowerCase().includes(q)); }
      if (f.entityType) list = list.filter((a) => a.entityType === f.entityType);
      if (f.actorId) list = list.filter((a) => a.actorId === f.actorId);
      return paginate(list, f.page, f.pageSize ?? 50);
    }),
    getSystemHealth: () => call('getSystemHealth', () => {
      need('system.view');
      const at = iso();
      return {
        components: [
          { id: 'crawler', name: 'Crawler & Renderer', subsystem: 'A' as const, status: 'not_configured' as const, detail: 'Mock mode — crawls are simulated; no HTTP requests are made.', lastCheckedAt: at },
          { id: 'connectors', name: 'Data connectors', subsystem: 'B' as const, status: 'not_configured' as const, detail: '0 of 14 integrations connected (mock mode cannot connect).', lastCheckedAt: at },
          { id: 'analysis', name: 'Analysis engine', subsystem: 'C' as const, status: 'degraded' as const, detail: 'Showing DEMO findings; no live analysis in mock mode.', lastCheckedAt: at },
          { id: 'classifier', name: 'Severity classifier', subsystem: 'D' as const, status: 'operational' as const, detail: 'Shared rules engine loaded in browser.', lastCheckedAt: at },
          { id: 'recommendations', name: 'Recommendation engine', subsystem: 'E' as const, status: 'operational' as const, detail: `${Object.keys(CHECKS_BY_ID).length} checks, Fix Card playbook loaded.`, lastCheckedAt: at },
          { id: 'workflow', name: 'Reporting & workflow', subsystem: 'F' as const, status: 'degraded' as const, detail: 'Digest builds in-app; email/WhatsApp/Slack/Task Ops not configured.', lastCheckedAt: at },
          { id: 'storage', name: 'Storage', subsystem: 'platform' as const, status: 'degraded' as const, detail: 'Browser memory only — reload resets all changes. No database (awaiting authorization).', lastCheckedAt: at },
        ],
        errors: s.errors,
        storage: { kind: 'browser_memory' as const, persistent: false as const, note: 'Mock adapter keeps state in browser memory. Reloading the page restores the DEMO seed and removes websites added in this session.' },
      };
    }),
    search: (q) => call('search', () => {
      const res = globalSearch(s, q, s.catalog.pages.slice(0, 600));
      const u = me();
      return res.filter((r) => r.kind !== 'employee' || hasPermission(s.permissions, u.role, 'employees.view'));
    }),
    getDiagnostics: () => call('getDiagnostics', () => {
      need('diagnostics.view');
      return { mode: 'mock' as const, endpoints: MOCK_ENDPOINTS, recent: recent.slice(0, 50), version: '0.1.0-phase1' };
    }),
  };

  function bulk(parent: Issue, team: TeamId, reason?: string): IssueDetail {
    const task = allocateWithTask(parent, team, reason, parent.groupId);
    for (const cid of parent.childIssueIds ?? []) {
      const c = s.issues.find((x) => x.id === cid);
      if (!c) continue;
      c.allocation.push({ id: nid('ALC'), issueId: c.id, allocatedById: me().id, allocatedByName: me().name, fromTeam: c.allocatedTeam, toTeam: team, at: iso(), automatic: false, reason: `Bulk allocation via template-level ${parent.id}`, bulkGroupId: parent.groupId });
      c.allocatedTeam = team;
      c.taskId = task.id;
    }
    audit('issue.bulk_allocate', 'issue', parent.id, `Bulk-allocated ${parent.childIssueIds?.length ?? 0} child issues → ${TEAMS[team].name}`);
    return issueDetail(parent);
  }

  function pendingVerification(t: Task): VerificationAttempt {
    const a: VerificationAttempt = { id: nid('VER'), taskId: t.id, issueId: t.issueId ?? '-', at: iso(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: 'Queued for the next smart crawl (re-verify set).', source: 'simulated' };
    t.verification.push(a);
    return a;
  }

  function validateEmployee(e: EmployeeInput) {
    if (!e.name || e.name.trim().length < 2) throw new ApiError(400, 'VALIDATION', 'Name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email ?? '')) throw new ApiError(400, 'VALIDATION', 'Enter a valid email address.');
    if (!ROLE_LABELS[e.role as Role]) throw new ApiError(400, 'VALIDATION', 'Choose a role.');
    if (!e.teamIds?.length) throw new ApiError(400, 'VALIDATION', 'Assign at least one team.');
  }

  void HEALTH_WEIGHTS;
  return Object.assign(api, { __state: s, __recent: recent, __sites: sites });
}

export const MOCK_ENDPOINTS: ApiDiagnostics['endpoints'] = [
  { method: 'POST', path: '/api/auth/login', description: 'Sign in' },
  { method: 'GET', path: '/api/dashboard', permission: 'dashboard.view', description: 'Dashboard aggregates' },
  { method: 'GET', path: '/api/issues', permission: 'issues.view', description: 'Issues board (filters)' },
  { method: 'POST', path: '/api/issues/:id/allocate', permission: 'issues.allocate', description: 'One-tap team allocation' },
  { method: 'POST', path: '/api/issues/:id/status', permission: 'issues.update_status', description: 'Start work / mark fixed' },
  { method: 'POST', path: '/api/issues/:id/verify', permission: 'issues.verify', description: 'Run re-verification (system decides)' },
  { method: 'GET', path: '/api/websites', permission: 'dashboard.view', description: 'Websites and their summaries' },
  { method: 'POST', path: '/api/crawls', permission: 'crawls.run', description: 'Start a crawl' },
  { method: 'GET', path: '/api/reports/daily', permission: 'reports.view', description: 'Daily digest' },
  { method: 'GET', path: '/api/integrations', permission: 'integrations.view', description: 'Integration states' },
];
