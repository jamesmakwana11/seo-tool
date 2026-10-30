import {
  ALL_PERMISSIONS, CHECKS_BY_ID, INTEGRATION_CATALOG, ROLE_LABELS, TEAMS, globalSearch, hasPermission, paginate, setPriorityConfig,
  permissionsOf,
  type AlertRule, type ApiDiagnostics, type Employee, type EmployeeInput, type IntegrationId, type PermissionMatrix, type Role,
  type SentinelConfig, type SystemComponentHealth,
} from '@sentinel/shared';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { randomToken, sha256 } from '../lib/passwords';
import { audit, can, need, type Actor, type Ctx } from './context';
import type { AuthService } from './auth';

const CHANNELS = ['in_app', 'email', 'whatsapp', 'slack'];

function validateEmployee(e: Partial<EmployeeInput>) {
  if (!e.name || e.name.trim().length < 2) throw badRequest('Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email ?? '')) throw badRequest('Enter a valid email address.');
  if (!e.role || !ROLE_LABELS[e.role as Role]) throw badRequest('Choose a role.');
  if (!e.teamIds?.length || e.teamIds.some((t) => !TEAMS[t])) throw badRequest('Assign at least one valid team.');
  if (e.capacityHoursPerWeek !== undefined && (!Number.isFinite(e.capacityHoursPerWeek) || e.capacityHoursPerWeek <= 0 || e.capacityHoursPerWeek > 80)) throw badRequest('Capacity must be between 1 and 80 hours per week.');
  if (e.status && !['active', 'invited', 'inactive'].includes(e.status)) throw badRequest('Unknown account status.');
}

export function validateConfig(next: SentinelConfig) {
  const wsum = Object.values(next.scoring.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(wsum - 1) > 0.001) throw badRequest(`Module weights must sum to 100% (currently ${(wsum * 100).toFixed(1)}%).`);
  if (!(next.sla.mediumDays >= 1) || !(next.sla.lowDays >= next.sla.mediumDays)) throw badRequest('Medium SLA must be ≥1 day and Low SLA must be ≥ Medium SLA.');
  if (!(next.escalation.templateGroupThreshold >= 2)) throw badRequest('Template grouping threshold must be at least 2.');
  if (!(next.escalation.unallocatedCriticalHours > 0)) throw badRequest('Unallocated-critical threshold must be greater than 0 hours.');
  for (const [k, v] of Object.entries(next.thresholds)) if (!Number.isFinite(v) || v < 0) throw badRequest(`Threshold ${k} must be a non-negative number.`);
  if (!/^\d{2}:\d{2}$/.test(next.reporting.dailyDigestTime)) throw badRequest('Digest time must be HH:MM (IST).');
  if (!(next.reporting.monthlyDay >= 1 && next.reporting.monthlyDay <= 28)) throw badRequest('Monthly report day must be between 1 and 28.');
  if (next.reporting.channels.some((c) => !CHANNELS.includes(c))) throw badRequest('Unknown report channel.');
  if (!(next.crawl.smartTopProducts >= 1 && next.crawl.smartTopProducts <= 5000)) throw badRequest('Smart crawl top products must be between 1 and 5000.');
  if (!(next.crawl.maxConcurrency >= 1 && next.crawl.maxConcurrency <= 16)) throw badRequest('Crawler concurrency must be between 1 and 16.');
  try { new URL(next.site.baseUrl); } catch { throw badRequest('Site base URL must be a valid URL.'); }
}

export interface DiagnosticsSource { endpoints: ApiDiagnostics['endpoints']; recent: () => ApiDiagnostics['recent'] }

export function createAdminService(ctx: Ctx, auth: AuthService, diag: DiagnosticsSource, extra: { schedulerRunning: () => boolean }) {
  /** Storage row of System health: the database's real state, or the warning that storage is temporary. */
  const storageComponent = (at: string): SystemComponentHealth => {
    const db = ctx.persistence?.status();
    if (!db) return { id: 'storage', name: 'Storage', subsystem: 'platform', status: 'degraded', detail: 'TEMPORARY in-memory storage — websites, crawls and issues are lost when the API restarts. Set DATABASE_URL to keep them in PostgreSQL.', lastCheckedAt: at };
    if (!db.connected) return { id: 'storage', name: 'Storage', subsystem: 'platform', status: 'down', detail: `PostgreSQL (${db.database}) cannot be written: ${db.lastError ?? 'unknown error'} (since ${db.lastErrorAt ?? '?'}). ${db.pending} change(s) are waiting and retried; they are lost if the server restarts before the database is back.`, lastCheckedAt: at };
    return { id: 'storage', name: 'Storage', subsystem: 'platform', status: 'operational', detail: `PostgreSQL (${db.database}): websites, crawls, page results, issues and settings are kept across restarts.${db.pending ? ` ${db.pending} change(s) being written.` : ''}${db.lastFlushAt ? ` Last write ${db.lastFlushAt}.` : ''}`, lastCheckedAt: at };
  };
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();

  return {
    // ---------------------------------------------------------------- config & alerts
    async getConfig(actor: Actor) { await need(ctx, actor, 'settings.view'); return r.config.get(); },
    async updateConfig(actor: Actor, patch: Partial<SentinelConfig>) {
      await need(ctx, actor, 'settings.manage');
      if (!patch || typeof patch !== 'object') throw badRequest('Send a configuration patch object.');
      if (patch.automation && actor.role !== 'super_admin' && actor.role !== 'admin') throw forbidden('Only Admins can change live-site automation opt-ins.');
      const cur = await r.config.get();
      const next: SentinelConfig = { ...cur, ...patch, updatedAt: iso(), updatedBy: actor.name };
      validateConfig(next);
      await r.config.set(next);
      setPriorityConfig(next);
      await audit(ctx, actor, 'config.update', 'config', 'sentinel-config', `Updated configuration (${Object.keys(patch).join(', ')})`, { before: cur, after: next });
      return next;
    },
    async updateAlertRules(actor: Actor, rules: AlertRule[]) {
      await need(ctx, actor, 'notifications.configure');
      if (!Array.isArray(rules)) throw badRequest('Send the list of alert rules.');
      for (const rule of rules) {
        if (rule.enabled && !rule.channels.length) throw badRequest(`"${rule.label}" is enabled but has no channels.`);
        if (rule.channels.some((c) => !CHANNELS.includes(c))) throw badRequest(`"${rule.label}" has an unknown channel.`);
        if (rule.recipients.some((t) => !TEAMS[t])) throw badRequest(`"${rule.label}" has an unknown recipient team.`);
      }
      const cfg = await r.config.get();
      const next = { ...cfg, alerts: rules, updatedAt: iso(), updatedBy: actor.name };
      await r.config.set(next);
      await audit(ctx, actor, 'config.alerts', 'config', 'alerts', 'Updated real-time alert routing', { before: cfg.alerts, after: rules });
      return rules;
    },

    // ---------------------------------------------------------------- people & permissions
    async listEmployees(actor: Actor) {
      if (await can(ctx, actor, 'employees.view')) return r.employees.list();
      // Roles without the Team section (Admin) still need names on the issue board and verification results:
      // a directory of names and roles only — no email, title or capacity.
      await need(ctx, actor, 'issues.view');
      return (await r.employees.list()).map((e) => ({ id: e.id, name: e.name, role: e.role, teamIds: e.teamIds, status: e.status, isSeoLead: e.isSeoLead }) as Employee);
    },
    async createEmployee(actor: Actor, input: EmployeeInput) {
      await need(ctx, actor, 'employees.manage');
      validateEmployee(input);
      const email = input.email.trim().toLowerCase();
      if ((await r.employees.list()).some((e) => e.email.toLowerCase() === email)) throw conflict('An employee with this email already exists.');
      const e: Employee = {
        id: await r.employees.nextId('emp'), name: input.name.trim(), email, role: input.role, teamIds: input.teamIds, title: (input.title ?? '').trim(),
        status: input.status ?? 'invited', capacityHoursPerWeek: input.capacityHoursPerWeek ?? 40, isSeoLead: input.isSeoLead, createdAt: iso(), source: 'manual',
      };
      await r.employees.insert(e);
      await auth.provisionCredential(e.id, email);
      // Invitation = a set-password link (one-time token, 72h). Delivery outcome is recorded honestly.
      const token = randomToken(24);
      await r.resetTokens.upsert({ id: sha256(token), email, expiresAt: new Date(ctx.clock().getTime() + 72 * 3600_000).toISOString() });
      const att = await ctx.delivery.deliver('allocation', ['email'], { subject: 'You have been invited to DeoDap SEO Sentinel', text: `Set your password with this one-time token (valid 72 hours): ${token}` });
      await audit(ctx, actor, 'employee.create', 'employee', e.id, `Invited ${e.name} as ${ROLE_LABELS[e.role]} (${e.teamIds.map((t) => TEAMS[t].shortName).join(', ')}) — invitation email ${att[0]?.outcome ?? 'not sent'}`);
      return e;
    },
    async updateEmployee(actor: Actor, id: string, input: Partial<EmployeeInput>) {
      await need(ctx, actor, 'employees.manage');
      const e = await r.employees.get(id);
      if (!e) throw notFound('Employee');
      const merged = { ...e, ...input } as EmployeeInput;
      validateEmployee(merged);
      if (e.id === actor.id && input.role && input.role !== e.role && (e.role === 'super_admin' || e.role === 'admin')) throw conflict(`You cannot remove your own ${ROLE_LABELS[e.role]} role.`);
      if (e.id === actor.id && input.status && input.status !== 'active') throw conflict('You cannot deactivate your own account.');
      if (input.email && input.email.trim().toLowerCase() !== e.email) {
        const email = input.email.trim().toLowerCase();
        if ((await r.employees.list()).some((x) => x.id !== id && x.email.toLowerCase() === email)) throw conflict('An employee with this email already exists.');
        const cred = await r.credentials.get(e.email);
        if (cred) { await r.credentials.delete(e.email); await r.credentials.insert({ ...cred, id: email }); }
        merged.email = email;
      }
      const before = { role: e.role, teamIds: e.teamIds, status: e.status };
      const next: Employee = { ...e, name: merged.name.trim(), email: merged.email, role: merged.role, teamIds: merged.teamIds, title: (merged.title ?? '').trim(), status: merged.status ?? e.status, capacityHoursPerWeek: merged.capacityHoursPerWeek ?? e.capacityHoursPerWeek, isSeoLead: merged.isSeoLead };
      await r.employees.update(next);
      if (next.status !== 'active') for (const s of await r.sessions.where({ employeeId: id })) if (!s.revokedAt) await r.sessions.update({ ...s, revokedAt: iso() });
      await audit(ctx, actor, 'employee.update', 'employee', id, `Updated ${next.name}`, { before, after: { role: next.role, teamIds: next.teamIds, status: next.status } });
      return next;
    },
    async getPermissionMatrix(actor: Actor) { await need(ctx, actor, 'employees.view'); return r.permissions.get(); },
    async updatePermissionMatrix(actor: Actor, m: PermissionMatrix) {
      await need(ctx, actor, 'roles.manage');
      for (const role of Object.keys(ROLE_LABELS) as Role[]) {
        if (!Array.isArray(m?.[role])) throw badRequest(`Missing permissions for ${ROLE_LABELS[role]}.`);
        const bad = m[role].filter((p) => !ALL_PERMISSIONS.includes(p));
        if (bad.length) throw badRequest(`Unknown permission(s): ${bad.join(', ')}`);
      }
      const before = await r.permissions.get();
      // Super Admin always keeps every permission (so the matrix can always be edited again).
      const next = Object.fromEntries((Object.keys(ROLE_LABELS) as Role[]).map((k) => [k, k === 'super_admin' ? permissionsOf(m, k) : [...new Set(m[k])]])) as PermissionMatrix;
      await r.permissions.set(next);
      await audit(ctx, actor, 'roles.update', 'employee', 'permission-matrix', 'Updated role permission matrix', { before, after: next });
      return next;
    },

    // ---------------------------------------------------------------- integrations
    async listIntegrations(actor: Actor) { await need(ctx, actor, 'integrations.view'); return ctx.integrations.list(); },
    async updateIntegration(actor: Actor, id: IntegrationId, settings: Record<string, string | number | boolean>) {
      await need(ctx, actor, 'integrations.manage');
      if (!INTEGRATION_CATALOG.some((i) => i.id === id)) throw notFound(`Integration ${id}`);
      const res = await ctx.integrations.updateSettings(id, settings ?? {});
      await audit(ctx, actor, 'integration.update', 'integration', id, `Updated non-secret settings for ${id} (${Object.keys(settings ?? {}).join(', ') || 'none'})`);
      return res;
    },
    async testIntegration(actor: Actor, id: IntegrationId) {
      await need(ctx, actor, 'integrations.manage');
      if (!INTEGRATION_CATALOG.some((i) => i.id === id)) throw notFound(`Integration ${id}`);
      const res = await ctx.integrations.test(id);
      await audit(ctx, actor, 'integration.test', 'integration', id, `Connection test for ${id}: ${res.state} — ${res.lastTestResult ?? res.stateDetail}`);
      return res;
    },

    // ---------------------------------------------------------------- notifications, deliveries, audit
    async listNotifications(actor: Actor) {
      return (await r.notifications.where({ recipientId: actor.id })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
    },
    async markRead(actor: Actor, id: string) {
      let n = 0;
      for (const x of await r.notifications.where({ recipientId: actor.id })) {
        if ((id === 'all' || x.id === id) && !x.readAt) { await r.notifications.update({ ...x, readAt: iso() }); n++; }
      }
      if (id !== 'all' && n === 0 && !(await r.notifications.get(id))) throw notFound('Notification');
    },
    async listDeliveries(actor: Actor) { await need(ctx, actor, 'reports.view'); return (await r.deliveries.list()).sort((a, b) => b.at.localeCompare(a.at)); },
    async auditLog(actor: Actor, f: { q?: string; entityType?: string; actorId?: string; page?: number; pageSize?: number }) {
      await need(ctx, actor, 'audit.view');
      let list = (await r.audit.list()).reverse();
      if (f.q) { const q = f.q.toLowerCase(); list = list.filter((a) => a.summary.toLowerCase().includes(q) || a.action.includes(q) || a.entityId.toLowerCase().includes(q)); }
      if (f.entityType) list = list.filter((a) => a.entityType === f.entityType);
      if (f.actorId) list = list.filter((a) => a.actorId === f.actorId);
      return paginate(list, f.page, f.pageSize ?? 50);
    },

    // ---------------------------------------------------------------- system
    async systemHealth(actor: Actor) {
      await need(ctx, actor, 'system.view');
      const at = iso();
      const ints = await ctx.integrations.list();
      const connected = ints.filter((i) => i.state === 'connected').length;
      const failing = ints.filter((i) => i.state === 'sync_failed' || i.state === 'connection_failed');
      const crawlReady = ctx.engine.readiness();
      const crawls = (await r.crawls.list()).filter((c) => c.source === 'live').sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      const last = crawls[0];
      const m = await r.metrics.get();
      const channels = ctx.delivery.channelStatus();
      const components: SystemComponentHealth[] = [
        { id: 'crawler', name: 'Crawler & Renderer', subsystem: 'A', status: !crawlReady.ready ? 'not_configured' : last?.status === 'failed' ? 'degraded' : 'operational', detail: !crawlReady.ready ? `Not ready: ${crawlReady.reason}` : last ? `Last live crawl ${last.id} ${last.status}${last.error ? `: ${last.error}` : ''}. JS rendering (headless) is not implemented — raw HTML only.` : `Ready for ${crawlReady.baseUrl}; no live crawl has run yet. JS rendering (headless) is not implemented — raw HTML only.`, lastCheckedAt: at },
        { id: 'connectors', name: 'Data connectors', subsystem: 'B', status: failing.length ? 'degraded' : connected ? 'operational' : 'not_configured', detail: `${connected} of ${ints.length} integrations connected (verified by a successful connection test)${failing.length ? `; failing: ${failing.map((f) => f.name).join(', ')}` : ''}.`, lastCheckedAt: at },
        { id: 'analysis', name: 'Analysis engine', subsystem: 'C', status: 'operational', detail: `${Object.values(CHECKS_BY_ID).filter((c) => c.crawlerEvaluable).length} crawler-evaluable checks; connector-based checks need their data sources.${m.source === 'sample' ? ' sample findings are loaded alongside any live results.' : ''}`, lastCheckedAt: at },
        { id: 'classifier', name: 'Severity classifier', subsystem: 'D', status: 'operational', detail: 'Shared rules engine (check × page tier), SLA, escalation and template grouping.', lastCheckedAt: at },
        { id: 'recommendations', name: 'Recommendation engine', subsystem: 'E', status: 'operational', detail: `${Object.keys(CHECKS_BY_ID).length} checks with Fix Card playbook. LLM rewrite drafts: ${ctx.llm.isConfigured() ? 'provider configured' : 'no LLM provider configured'}.`, lastCheckedAt: at },
        { id: 'workflow', name: 'Reporting & workflow', subsystem: 'F', status: channels.some((c) => c.configured) ? 'operational' : 'degraded', detail: `Delivery channels configured: ${channels.filter((c) => c.configured).map((c) => c.channel).join(', ') || 'none'}. Scheduler: ${extra.schedulerRunning() ? 'running' : 'off (SCHEDULER_ENABLED=false)'}.`, lastCheckedAt: at },
        storageComponent(at),
      ];
      const db = ctx.persistence?.status();
      return { components, errors: [...m.errors].reverse().slice(0, 100), storage: { kind: r.storage.kind, persistent: r.storage.persistent, note: r.storage.note, ...(db?.lastError ? { error: db.lastError } : {}) } };
    },
    async search(actor: Actor, q: string) {
      const [issues, employees, briefs, pages] = await Promise.all([r.issues.list(), r.employees.list(), r.briefs.list(), r.sitePages.list()]);
      const matrix = await r.permissions.get();
      const res = globalSearch({ issues, employees, briefs }, q ?? '', pages.slice(0, 2000));
      return res.filter((x) => (x.kind !== 'employee' || hasPermission(matrix, actor.role, 'employees.view')) && (x.kind !== 'issue' || hasPermission(matrix, actor.role, 'issues.view')));
    },
    async diagnostics(actor: Actor): Promise<ApiDiagnostics> {
      await need(ctx, actor, 'diagnostics.view');
      return { mode: 'http', baseUrl: '/api', endpoints: diag.endpoints, recent: diag.recent().slice(0, 50), version: '0.2.0-phase2' };
    },
  };
}
export type AdminService = ReturnType<typeof createAdminService>;
