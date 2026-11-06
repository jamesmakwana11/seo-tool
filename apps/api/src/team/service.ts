/**
 * Development Team (Admin and Super Admin manage it from the app — never through the server or the database):
 *  - members: invited by name + email as app accounts (one-time activation link, 72 hours; only its hash is stored),
 *    roles Developer / SEO Specialist, edit, activate / deactivate, remove from the team;
 *  - the permissions of those two roles (an Admin can grant only permissions it holds itself, never admin rights);
 *  - tasks: SEO issues and development work across every website, with priority, due date and status
 *    (Pending, In progress, Completed; an open task past its due date shows as Overdue);
 *  - in-app notifications on assignment, automatic reminders before the due date and when overdue, manual reminders to
 *    one member or the whole team, with a reminder history.
 * Everything is stored with the shared (server-wide) records: it survives restarts with DATABASE_URL.
 */
import {
  ALL_PERMISSIONS, DEV_TASK_PRIORITIES, DEV_TASK_STATUS_LABELS, ROLE_LABELS, TEAM_MEMBER_ROLES,
  type DevInviteResult, type DevTask, type DevTaskFilter, type DevTaskInput, type DevTaskView, type DevTeamMember,
  type DevTeamMemberInput, type DevTeamOverview, type DevWorkCounts, type Employee, type Notification, type Permission, type Role, type TeamMemberRole,
  type TeamReminder, type TeamReminderInput, type TeamRolePermissions,
} from '@sentinel/shared';
import { emailTransportReady } from '../notifications/adapters';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { hashPassword, randomToken, sha256 } from '../lib/passwords';
import { audit, can, need, type Actor, type Ctx } from '../services/context';

const IST = 330 * 60_000;
const INVITE_HOURS = 72;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Never grantable from the Development Team screen (admin-level rights). */
const NOT_GRANTABLE = new Set<Permission>(['roles.manage', 'employees.manage', 'devteam.manage', 'google.manage', 'integrations.manage', 'settings.manage', 'websites.manage']);

export const todayIst = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
/** End of the due day in IST (23:59:59.999). */
export const dueEnd = (ymd: string) => Date.parse(`${ymd}T23:59:59.999+05:30`);

export interface DevTeamDeps {
  /** Websites a task can belong to (all websites of the server). */
  websites: () => { id: string; name: string }[];
}

export function createDevTeamService(ctx: Ctx, deps: DevTeamDeps) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();
  const now = () => ctx.clock().getTime();

  // ------------------------------------------------------------------------------------------- helpers
  const isMember = (e: Employee) => e.teamIds.includes('development');
  const isManagedRole = (role: Role): role is TeamMemberRole => (TEAM_MEMBER_ROLES as readonly string[]).includes(role);

  function view(t: DevTask, names: Map<string, string>): DevTaskView {
    const overdue = t.status !== 'completed' && now() > dueEnd(t.dueDate);
    const daysLeft = Math.ceil((dueEnd(t.dueDate) - now()) / 86_400_000) - 1;
    return { ...t, overdue, displayStatus: overdue ? 'overdue' : t.status, assigneeName: t.assigneeId ? names.get(t.assigneeId) ?? 'Former member' : undefined, daysLeft };
  }
  async function names() { return new Map((await r.employees.list()).map((e) => [e.id, e.name])); }
  function counts(tasks: DevTaskView[]): DevWorkCounts {
    const c: DevWorkCounts = { open: 0, pending: 0, inProgress: 0, completed: 0, overdue: 0 };
    for (const t of tasks) {
      if (t.status === 'completed') c.completed++; else c.open++;
      if (t.overdue) c.overdue++;
      else if (t.status === 'pending') c.pending++;
      else if (t.status === 'in_progress') c.inProgress++;
    }
    return c;
  }
  async function inviteExpiry(email: string): Promise<string | undefined> {
    const tokens = (await r.resetTokens.where({ email })).filter((t) => !t.usedAt && new Date(t.expiresAt).getTime() > now());
    return tokens.sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0]?.expiresAt;
  }
  async function memberOf(e: Employee, tasks: DevTaskView[]): Promise<DevTeamMember> {
    const mine = tasks.filter((t) => t.assigneeId === e.id);
    return {
      id: e.id, name: e.name, email: e.email, role: e.role, title: e.title, status: e.status, createdAt: e.createdAt, lastActiveAt: e.lastActiveAt,
      invitePending: e.status === 'invited', ...(e.status === 'invited' ? { inviteExpiresAt: await inviteExpiry(e.email) } : {}), work: counts(mine),
    };
  }
  async function allViews(): Promise<DevTaskView[]> {
    const n = await names();
    return (await r.devTasks.list()).map((t) => view(t, n));
  }
  function websitesList() {
    const list = deps.websites();
    return list.length ? list : [{ id: ctx.scope ?? 'primary', name: 'This website' }];
  }

  async function notifyTeam(recipients: string[], n: Omit<Notification, 'id' | 'recipientId' | 'createdAt'>) {
    for (const id of new Set(recipients.filter(Boolean))) {
      await r.teamNotifications.insert({ ...n, id: await r.teamNotifications.nextId('TNF', 6), recipientId: id, createdAt: iso() });
    }
  }
  async function recordReminder(rem: Omit<TeamReminder, 'id' | 'at'>) {
    const saved: TeamReminder = { ...rem, id: await r.teamReminders.nextId('REM', 6), at: iso() };
    await r.teamReminders.insert(saved);
    return saved;
  }
  function event(t: DevTask, actor: { name: string }, message: string) {
    t.history.push({ at: iso(), actorName: actor.name, message });
    if (t.history.length > 200) t.history.splice(0, t.history.length - 200);
    t.updatedAt = iso();
  }

  // ------------------------------------------------------------------------------------------- members
  async function teamMember(id: string): Promise<Employee> {
    const e = await r.employees.get(id);
    if (!e || !isMember(e)) throw notFound('Team member');
    return e;
  }
  function assertManageable(actor: Actor, e: Employee) {
    if (e.id === actor.id) throw conflict('You cannot change your own account here — use your profile.');
    if (!isManagedRole(e.role) && actor.role !== 'super_admin') throw forbidden(`${e.name} is ${ROLE_LABELS[e.role]}: only a Super Admin can change that account (Team → Employees).`);
  }
  function checkMember(input: Partial<DevTeamMemberInput>, partial = false) {
    const fields: Record<string, string> = {};
    if (!partial || input.name !== undefined) { if (!input.name || String(input.name).trim().length < 2) fields.name = 'Enter the member’s name.'; else if (String(input.name).trim().length > 80) fields.name = 'The name is too long (80 characters at most).'; }
    if (!partial || input.email !== undefined) { if (!input.email || !EMAIL_RE.test(String(input.email).trim())) fields.email = 'Enter a valid email address.'; }
    if (!partial || input.role !== undefined) { if (!input.role || !isManagedRole(input.role as Role)) fields.role = 'Choose Developer or SEO Specialist.'; }
    if (input.title !== undefined && String(input.title).length > 80) fields.title = 'The job title is too long (80 characters at most).';
    if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], { fields });
  }

  async function sendActivation(e: Employee, appBase: string | undefined): Promise<DevInviteResult['activation']> {
    // A fresh one-time link; older unused links for this email stop working.
    for (const t of await r.resetTokens.where({ email: e.email })) if (!t.usedAt) await r.resetTokens.delete(t.id);
    const token = randomToken(24);
    const expiresAt = new Date(now() + INVITE_HOURS * 3600_000).toISOString();
    await r.resetTokens.upsert({ id: sha256(token), email: e.email, expiresAt });
    const base = (ctx.env.APP_BASE_URL ?? appBase ?? '').replace(/\/$/, '');
    const link = `${base}/reset-password?token=${encodeURIComponent(token)}&invite=1`;
    if (emailTransportReady(ctx.env) && base) {
      const att = await ctx.delivery.deliver('allocation', ['email'], {
        to: [e.email], subject: 'You have been invited to DeoDap SEO Sentinel',
        text: `Hello ${e.name},\n\nYou have been added to the Development Team in DeoDap SEO Sentinel as ${ROLE_LABELS[e.role]}. Open the link below within ${INVITE_HOURS} hours to choose your password and activate your account.`,
        links: [{ label: 'Activate my account', url: link }],
      });
      if (att.some((a) => a.outcome === 'delivered')) return { emailed: true, expiresAt, note: `An activation email was sent to ${e.email}. The link works once, for ${INVITE_HOURS} hours.` };
    }
    return {
      emailed: false, expiresAt, link,
      note: `This server cannot send email${emailTransportReady(ctx.env) ? ' right now' : ' (SMTP is not configured)'}, so share this one-time activation link with ${e.name} privately. It works once, for ${INVITE_HOURS} hours, and is not shown again.`,
    };
  }

  // ------------------------------------------------------------------------------------------- tasks
  async function taskFor(actor: Actor, id: string): Promise<{ t: DevTask; manager: boolean }> {
    const t = await r.devTasks.get(id);
    if (!t) throw notFound('Task');
    const manager = await can(ctx, actor, 'devteam.manage');
    if (!manager && t.assigneeId !== actor.id) throw forbidden('You can only open tasks assigned to you.');
    return { t, manager };
  }
  async function checkTask(input: Partial<DevTaskInput>, partial: boolean, existing?: DevTask) {
    const fields: Record<string, string> = {};
    const title = input.title !== undefined ? String(input.title).trim() : undefined;
    if (!partial || title !== undefined) { if (!title || title.length < 3) fields.title = 'Enter a task title (3 characters or more).'; else if (title.length > 200) fields.title = 'The title is too long (200 characters at most).'; }
    if (input.description !== undefined && String(input.description).length > 5000) fields.description = 'The description is too long (5,000 characters at most).';
    if (!partial || input.kind !== undefined) if (input.kind !== 'seo_issue' && input.kind !== 'development') fields.kind = 'Choose SEO issue or Development task.';
    if (!partial || input.priority !== undefined) if (!DEV_TASK_PRIORITIES.includes(input.priority as never)) fields.priority = 'Choose a priority.';
    if (!partial || input.dueDate !== undefined) {
      const d = String(input.dueDate ?? '');
      if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) fields.dueDate = 'Choose a due date.';
      else if (d < todayIst(ctx.clock()) && d !== existing?.dueDate) fields.dueDate = 'The due date cannot be in the past.';
      else if (Date.parse(`${d}T00:00:00Z`) - now() > 2 * 366 * 86_400_000) fields.dueDate = 'The due date is more than two years away.';
    }
    if (input.assigneeId) {
      const e = await r.employees.get(input.assigneeId);
      if (!e || !isMember(e) || e.status === 'suspended') fields.assigneeId = 'Assign the task to an active team member.';
    }
    if (input.websiteId && !websitesList().some((w) => w.id === input.websiteId)) fields.websiteId = 'Choose one of the websites.';
    if (input.url) { try { const u = new URL(String(input.url)); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { fields.url = 'Enter a full page address (https://…).'; } }
    if (Object.keys(fields).length) throw badRequest(Object.values(fields)[0], { fields });
  }

  async function assigned(actor: Actor, t: DevTask, previous?: string) {
    if (!t.assigneeId || t.assigneeId === previous) return;
    const who = (await r.employees.get(t.assigneeId))?.name ?? 'member';
    await notifyTeam([t.assigneeId], {
      type: 'assignment', title: `New task: ${t.title}`, body: `${actor.name} assigned you a ${t.priority} priority ${t.kind === 'seo_issue' ? 'SEO issue' : 'development task'}, due ${t.dueDate}.${t.websiteName ? ` Website: ${t.websiteName}.` : ''}`,
      link: `/dev-team/tasks/${t.id}`, taskId: t.id, fromName: actor.name,
    });
    await recordReminder({ kind: 'assignment', sentById: actor.id, sentByName: actor.name, recipientIds: [t.assigneeId], recipientNames: [who], taskId: t.id, taskTitle: t.title, message: `Assigned “${t.title}” (due ${t.dueDate}).` });
  }

  const service = {
    // ----------------------------------------------------------------------------------------- overview & members
    async overview(actor: Actor): Promise<DevTeamOverview> {
      await need(ctx, actor, 'devteam.manage');
      const tasks = await allViews();
      const members = await Promise.all((await r.employees.list()).filter(isMember).map((e) => memberOf(e, tasks)));
      const open = tasks.filter((t) => t.status !== 'completed');
      return {
        members: members.sort((a, b) => a.name.localeCompare(b.name)),
        counts: counts(tasks),
        overdue: open.filter((t) => t.overdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 50),
        dueSoon: open.filter((t) => !t.overdue && dueEnd(t.dueDate) - now() <= 48 * 3600_000).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 50),
        emailConfigured: emailTransportReady(ctx.env),
      };
    },

    async listMembers(actor: Actor): Promise<DevTeamMember[]> {
      await need(ctx, actor, 'devteam.view');
      const tasks = await allViews();
      const manager = await can(ctx, actor, 'devteam.manage');
      const list = await Promise.all((await r.employees.list()).filter(isMember).map((e) => memberOf(e, tasks)));
      // Members without the manage right see names and roles (to know who works on what), not emails.
      return list.sort((a, b) => a.name.localeCompare(b.name)).map((m) => (manager || m.id === actor.id ? m : { ...m, email: '' }));
    },

    async inviteMember(actor: Actor, input: DevTeamMemberInput & { origin?: string }): Promise<DevInviteResult> {
      await need(ctx, actor, 'devteam.manage');
      checkMember(input);
      const email = input.email.trim().toLowerCase();
      const existing = (await r.employees.list()).find((e) => e.email.toLowerCase() === email);
      if (existing) {
        if (isMember(existing)) throw conflict(`${existing.name} is already in the Development Team.`);
        throw conflict(`${email} already has a Sentinel account (${existing.name}, ${ROLE_LABELS[existing.role]}). Ask a Super Admin to add it to the Development Team on the Employees screen.`);
      }
      const e: Employee = {
        id: await r.employees.nextId('emp'), name: input.name.trim(), email, role: input.role, teamIds: input.role === 'seo_specialist' ? ['development', 'seo'] : ['development'],
        title: (input.title ?? '').trim(), status: 'invited', capacityHoursPerWeek: 40, createdAt: iso(), source: 'manual',
      };
      await r.employees.insert(e);
      // A random password nobody knows until the member chooses one with the activation link.
      const { hash, salt } = await hashPassword(randomToken(24));
      await r.credentials.upsert({ id: email, employeeId: e.id, hash, salt, updatedAt: iso() });
      const activation = await sendActivation(e, input.origin);
      await audit(ctx, actor, 'devteam.invite', 'employee', e.id, `Invited ${e.name} to the Development Team as ${ROLE_LABELS[e.role]} — activation ${activation.emailed ? 'emailed' : 'link shown to the inviter'}`);
      return { member: await memberOf(e, await allViews()), activation };
    },

    async resendInvite(actor: Actor, id: string, origin?: string): Promise<DevInviteResult> {
      await need(ctx, actor, 'devteam.manage');
      const e = await teamMember(id);
      assertManageable(actor, e);
      if (e.status !== 'invited') throw conflict(`${e.name} has already activated the account.`);
      const activation = await sendActivation(e, origin);
      await audit(ctx, actor, 'devteam.invite_resend', 'employee', e.id, `Sent a new activation link to ${e.name} (${activation.emailed ? 'emailed' : 'shown to the sender'})`);
      return { member: await memberOf(e, await allViews()), activation };
    },

    async updateMember(actor: Actor, id: string, input: Partial<DevTeamMemberInput>): Promise<DevTeamMember> {
      await need(ctx, actor, 'devteam.manage');
      const e = await teamMember(id);
      assertManageable(actor, e);
      checkMember(input, true);
      const next: Employee = { ...e };
      if (input.name !== undefined) next.name = String(input.name).trim();
      if (input.title !== undefined) next.title = String(input.title).trim();
      if (input.role !== undefined && input.role !== e.role) {
        next.role = input.role;
        next.teamIds = [...new Set([...e.teamIds.filter((t) => t !== 'seo' || input.role === 'seo_specialist'), ...(input.role === 'seo_specialist' ? ['seo' as const] : [])])];
      }
      if (input.email !== undefined && input.email.trim().toLowerCase() !== e.email) {
        const email = input.email.trim().toLowerCase();
        if ((await r.employees.list()).some((x) => x.id !== id && x.email.toLowerCase() === email)) throw conflict('Another account already uses this email.');
        const cred = await r.credentials.get(e.email);
        if (cred) { await r.credentials.delete(e.email); await r.credentials.insert({ ...cred, id: email }); }
        for (const t of await r.resetTokens.where({ email: e.email })) await r.resetTokens.delete(t.id);
        next.email = email;
      }
      await r.employees.update(next);
      await audit(ctx, actor, 'devteam.member_update', 'employee', id, `Updated ${next.name} (${ROLE_LABELS[next.role]})`, { before: { role: e.role, email: e.email }, after: { role: next.role, email: next.email } });
      return memberOf(next, await allViews());
    },

    async setMemberStatus(actor: Actor, id: string, status: unknown): Promise<DevTeamMember> {
      await need(ctx, actor, 'devteam.manage');
      if (status !== 'active' && status !== 'suspended') throw badRequest('status must be active or suspended.');
      const e = await teamMember(id);
      assertManageable(actor, e);
      // An invited member becomes active only by choosing a password with the activation link.
      const everActivated = !!e.lastActiveAt || (await r.resetTokens.where({ email: e.email })).some((t) => !!t.usedAt);
      const next: Employee = { ...e, status: status === 'suspended' ? 'suspended' : e.status === 'active' || everActivated ? 'active' : 'invited' };
      await r.employees.update(next);
      if (next.status === 'suspended') for (const s of await r.sessions.where({ employeeId: id })) if (!s.revokedAt) await r.sessions.update({ ...s, revokedAt: iso() });
      await audit(ctx, actor, status === 'suspended' ? 'devteam.member_deactivate' : 'devteam.member_activate', 'employee', id, `${status === 'suspended' ? 'Deactivated' : 'Activated'} ${e.name}${status === 'suspended' ? ' (signed out everywhere)' : ''}`);
      return memberOf(next, await allViews());
    },

    async removeMember(actor: Actor, id: string): Promise<{ removed: true; unassigned: number }> {
      await need(ctx, actor, 'devteam.manage');
      const e = await teamMember(id);
      assertManageable(actor, e);
      const teamIds = e.teamIds.filter((t) => t !== 'development');
      // A Developer / SEO Specialist removed from the team loses access; the account and its history stay (audit trail).
      await r.employees.update({ ...e, teamIds, status: isManagedRole(e.role) ? 'suspended' : e.status });
      for (const s of await r.sessions.where({ employeeId: id })) if (!s.revokedAt) await r.sessions.update({ ...s, revokedAt: iso() });
      for (const t of await r.resetTokens.where({ email: e.email })) if (!t.usedAt) await r.resetTokens.delete(t.id);
      let unassigned = 0;
      for (const t of await r.devTasks.where({ assigneeId: id })) {
        if (t.status === 'completed') continue;
        const next = { ...t, assigneeId: undefined };
        event(next, actor, `Unassigned: ${e.name} was removed from the team`);
        await r.devTasks.update(next);
        unassigned++;
      }
      await audit(ctx, actor, 'devteam.member_remove', 'employee', id, `Removed ${e.name} from the Development Team (account deactivated; ${unassigned} open task(s) unassigned)`);
      return { removed: true, unassigned };
    },

    // ----------------------------------------------------------------------------------------- role permissions
    async teamRoles(actor: Actor): Promise<TeamRolePermissions[]> {
      await need(ctx, actor, 'devteam.manage');
      const matrix = await r.permissions.get();
      const mine = new Set(actor.permissions);
      const grantable = ALL_PERMISSIONS.filter((p) => mine.has(p) && !NOT_GRANTABLE.has(p) && !p.startsWith('tasks.'));
      return TEAM_MEMBER_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], permissions: matrix[role] ?? [], grantable }));
    },

    async updateTeamRole(actor: Actor, role: string, permissions: unknown): Promise<TeamRolePermissions[]> {
      await need(ctx, actor, 'devteam.manage');
      if (!isManagedRole(role as Role)) throw badRequest('Only the Developer and SEO Specialist roles can be changed here.');
      if (!Array.isArray(permissions) || permissions.some((p) => !ALL_PERMISSIONS.includes(p as Permission))) throw badRequest('Unknown permission in the list.');
      const roles = await service.teamRoles(actor);
      const grantable = new Set(roles[0].grantable);
      const matrix = await r.permissions.get();
      const current = matrix[role as TeamMemberRole] ?? [];
      const asked = new Set(permissions as Permission[]);
      const next = ALL_PERMISSIONS.filter((p) => (grantable.has(p) ? asked.has(p) : current.includes(p)));
      const added = next.filter((p) => !current.includes(p));
      const removed = current.filter((p) => !next.includes(p));
      await r.permissions.set({ ...matrix, [role]: next });
      await audit(ctx, actor, 'devteam.role_permissions', 'config', role, `${ROLE_LABELS[role as Role]} permissions: ${added.length ? `added ${added.join(', ')}` : ''}${added.length && removed.length ? '; ' : ''}${removed.length ? `removed ${removed.join(', ')}` : ''}${!added.length && !removed.length ? 'no change' : ''}`, { before: current, after: next });
      return service.teamRoles(actor);
    },

    // ----------------------------------------------------------------------------------------- tasks
    async listTasks(actor: Actor, f: DevTaskFilter = {}): Promise<DevTaskView[]> {
      await need(ctx, actor, 'devteam.view');
      const manager = await can(ctx, actor, 'devteam.manage');
      let list = await allViews();
      if (!manager) list = list.filter((t) => t.assigneeId === actor.id);
      if (f.assigneeId) list = list.filter((t) => (f.assigneeId === 'unassigned' ? !t.assigneeId : t.assigneeId === f.assigneeId));
      if (f.status && f.status !== 'all') list = list.filter((t) => (f.status === 'open' ? t.status !== 'completed' : t.displayStatus === f.status));
      if (f.priority) list = list.filter((t) => t.priority === f.priority);
      if (f.kind) list = list.filter((t) => t.kind === f.kind);
      if (f.websiteId) list = list.filter((t) => t.websiteId === f.websiteId);
      if (f.q) { const q = f.q.toLowerCase(); list = list.filter((t) => `${t.id} ${t.title} ${t.description} ${t.url ?? ''} ${t.issueId ?? ''}`.toLowerCase().includes(q)); }
      const rank = (t: DevTaskView) => (t.overdue ? 0 : t.status === 'in_progress' ? 1 : t.status === 'pending' ? 2 : 3);
      return list.sort((a, b) => rank(a) - rank(b) || DEV_TASK_PRIORITIES.indexOf(a.priority) - DEV_TASK_PRIORITIES.indexOf(b.priority) || a.dueDate.localeCompare(b.dueDate));
    },

    async getTask(actor: Actor, id: string): Promise<DevTaskView> {
      await need(ctx, actor, 'devteam.view');
      const { t } = await taskFor(actor, id);
      return view(t, await names());
    },

    async createTask(actor: Actor, input: DevTaskInput): Promise<DevTaskView> {
      await need(ctx, actor, 'devteam.manage');
      await checkTask(input, false);
      const sites = websitesList();
      const websiteId = input.websiteId || (input.issueId ? ctx.scope ?? sites[0]?.id : undefined);
      let issueTitle: string | undefined;
      if (input.issueId) {
        const iss = websiteId === (ctx.scope ?? sites[0]?.id) ? await r.issues.get(input.issueId) : undefined;
        if (!iss) throw badRequest(`Issue ${input.issueId} was not found on this website.`, { fields: { issueId: 'Issue not found on the selected website.' } });
        issueTitle = iss.title;
      }
      const t: DevTask = {
        id: await r.devTasks.nextId('DEV', 4), title: input.title.trim(), description: (input.description ?? '').trim(), kind: input.kind, priority: input.priority, status: 'pending',
        dueDate: input.dueDate, ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
        ...(websiteId ? { websiteId, websiteName: sites.find((w) => w.id === websiteId)?.name } : {}),
        ...(input.issueId ? { issueId: input.issueId, issueTitle } : {}), ...(input.url ? { url: String(input.url).trim() } : {}),
        createdById: actor.id, createdByName: actor.name, createdAt: iso(), updatedAt: iso(), comments: [], history: [],
      };
      event(t, actor, 'Created the task');
      await r.devTasks.insert(t);
      await assigned(actor, t);
      await audit(ctx, actor, 'devteam.task_create', 'task', t.id, `Created ${t.id} “${t.title}” (${t.priority}, due ${t.dueDate})${t.assigneeId ? ` for ${(await r.employees.get(t.assigneeId))?.name}` : ''}`);
      return view(t, await names());
    },

    async updateTask(actor: Actor, id: string, patch: Partial<DevTaskInput> & { status?: unknown }): Promise<DevTaskView> {
      await need(ctx, actor, 'devteam.view');
      const { t, manager } = await taskFor(actor, id);
      const editing = Object.keys(patch).filter((k) => k !== 'status' && (patch as Record<string, unknown>)[k] !== undefined);
      if (!manager && editing.length) throw forbidden('You can change the status of your task and comment on it; the Admin edits the rest.');
      const next: DevTask = { ...t, history: [...t.history], comments: [...t.comments] };
      if (editing.length) {
        await checkTask({ ...patch, ...(patch.assigneeId === '' ? { assigneeId: undefined } : {}) }, true, t);
        const n = await names();
        if (patch.title !== undefined && patch.title.trim() !== t.title) { next.title = patch.title.trim(); event(next, actor, 'Renamed the task'); }
        if (patch.description !== undefined) next.description = String(patch.description).trim();
        if (patch.kind !== undefined) next.kind = patch.kind;
        if (patch.priority !== undefined && patch.priority !== t.priority) { next.priority = patch.priority; event(next, actor, `Priority → ${patch.priority}`); }
        if (patch.dueDate !== undefined && patch.dueDate !== t.dueDate) { next.dueDate = patch.dueDate; next.dueSoonRemindedAt = undefined; next.overdueRemindedOn = undefined; event(next, actor, `Due date → ${patch.dueDate}`); }
        if (patch.url !== undefined) next.url = patch.url ? String(patch.url).trim() : undefined;
        if (patch.websiteId !== undefined) { next.websiteId = patch.websiteId || undefined; next.websiteName = websitesList().find((w) => w.id === patch.websiteId)?.name; }
        if (patch.assigneeId !== undefined && (patch.assigneeId || undefined) !== t.assigneeId) {
          next.assigneeId = patch.assigneeId || undefined;
          next.dueSoonRemindedAt = undefined;
          next.overdueRemindedOn = undefined;
          event(next, actor, next.assigneeId ? `Assigned to ${n.get(next.assigneeId)}` : 'Unassigned');
        }
      }
      if (patch.status !== undefined && patch.status !== t.status) {
        if (patch.status !== 'pending' && patch.status !== 'in_progress' && patch.status !== 'completed') throw badRequest('status must be pending, in_progress or completed.');
        next.status = patch.status;
        if (patch.status === 'in_progress' && !next.startedAt) next.startedAt = iso();
        next.completedAt = patch.status === 'completed' ? iso() : undefined;
        event(next, actor, `Status → ${DEV_TASK_STATUS_LABELS[patch.status]}`);
        // The Admin who created the task hears when its assignee finishes it.
        if (patch.status === 'completed' && actor.id !== t.createdById) {
          await notifyTeam([t.createdById], { type: 'review', title: `Completed: ${t.title}`, body: `${actor.name} marked ${t.id} as completed.`, link: `/dev-team/tasks/${t.id}`, taskId: t.id, fromName: actor.name });
        }
      }
      await r.devTasks.update(next);
      await assigned(actor, next, t.assigneeId);
      await audit(ctx, actor, 'devteam.task_update', 'task', id, `Updated ${id}${patch.status !== undefined && patch.status !== t.status ? ` — ${DEV_TASK_STATUS_LABELS[next.status]}` : ''}`);
      return view(next, await names());
    },

    async commentTask(actor: Actor, id: string, text: unknown): Promise<DevTaskView> {
      await need(ctx, actor, 'devteam.view');
      const { t } = await taskFor(actor, id);
      const body = String(text ?? '').trim();
      if (!body) throw badRequest('Write a comment.');
      if (body.length > 2000) throw badRequest('The comment is too long (2,000 characters at most).');
      const next: DevTask = { ...t, comments: [...t.comments, { id: `${t.id}-c${t.comments.length + 1}`, authorId: actor.id, authorName: actor.name, at: iso(), text: body }], updatedAt: iso() };
      await r.devTasks.update(next);
      const others = [t.assigneeId, t.createdById].filter((x): x is string => !!x && x !== actor.id);
      await notifyTeam(others, { type: 'mention', title: `Comment on ${t.title}`, body: `${actor.name}: ${body.slice(0, 160)}${body.length > 160 ? '…' : ''}`, link: `/dev-team/tasks/${t.id}`, taskId: t.id, fromName: actor.name });
      return view(next, await names());
    },

    async deleteTask(actor: Actor, id: string): Promise<{ deleted: true }> {
      await need(ctx, actor, 'devteam.manage');
      const t = await r.devTasks.get(id);
      if (!t) throw notFound('Task');
      await r.devTasks.delete(id);
      await audit(ctx, actor, 'devteam.task_delete', 'task', id, `Deleted ${id} “${t.title}”`);
      return { deleted: true };
    },

    websites: async (actor: Actor) => { await need(ctx, actor, 'devteam.view'); return websitesList(); },

    // ----------------------------------------------------------------------------------------- reminders
    async sendReminder(actor: Actor, input: TeamReminderInput): Promise<TeamReminder> {
      await need(ctx, actor, 'devteam.manage');
      const message = String(input?.message ?? '').trim();
      if (message.length < 3) throw badRequest('Write the reminder (3 characters or more).');
      if (message.length > 1000) throw badRequest('The reminder is too long (1,000 characters at most).');
      const members = (await r.employees.list()).filter((e) => isMember(e) && e.status !== 'suspended');
      let recipients: Employee[];
      if (input.to === 'all') recipients = members.filter((e) => e.id !== actor.id);
      else {
        const one = members.find((e) => e.id === input.to);
        if (!one) throw badRequest('Choose an active team member, or the whole team.');
        recipients = [one];
      }
      if (!recipients.length) throw badRequest('The team has no other active members to remind.');
      let task: DevTask | undefined;
      if (input.taskId) { task = await r.devTasks.get(input.taskId); if (!task) throw badRequest('That task no longer exists.'); }
      await notifyTeam(recipients.map((e) => e.id), {
        type: 'reminder', title: task ? `Reminder: ${task.title}` : `Reminder from ${actor.name}`, body: message,
        link: task ? `/dev-team/tasks/${task.id}` : '/dev-team/my-tasks', ...(task ? { taskId: task.id } : {}), fromName: actor.name,
      });
      const rem = await recordReminder({ kind: 'manual', sentById: actor.id, sentByName: actor.name, recipientIds: recipients.map((e) => e.id), recipientNames: recipients.map((e) => e.name), ...(task ? { taskId: task.id, taskTitle: task.title } : {}), message });
      await audit(ctx, actor, 'devteam.reminder', 'task', task?.id ?? 'team', `Sent a reminder to ${input.to === 'all' ? `the whole team (${recipients.length})` : recipients[0].name}${task ? ` about ${task.id}` : ''}`);
      return rem;
    },

    async listReminders(actor: Actor, limit = 300): Promise<TeamReminder[]> {
      await need(ctx, actor, 'devteam.manage');
      return (await r.teamReminders.list()).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, Math.min(1000, Math.max(1, limit)));
    },

    /** Automatic reminders (scheduler, every 15 minutes): due within 24 hours (once), overdue (once a day). */
    async reminderTick(): Promise<{ dueSoon: number; overdue: number }> {
      const today = todayIst(ctx.clock());
      const n = await names();
      let dueSoon = 0;
      let overdue = 0;
      for (const t of await r.devTasks.list()) {
        if (t.status === 'completed' || !t.assigneeId) continue;
        const end = dueEnd(t.dueDate);
        if (now() > end) {
          if (t.overdueRemindedOn === today) continue;
          const days = Math.max(1, Math.floor((now() - end) / 86_400_000) + 1);
          const first = !t.overdueRemindedOn;
          await notifyTeam([t.assigneeId, ...(first ? [t.createdById] : [])], {
            type: 'reminder', severity: 'critical', title: `Overdue: ${t.title}`, body: `${t.id} was due ${t.dueDate} (${days} day${days === 1 ? '' : 's'} ago) and is still ${DEV_TASK_STATUS_LABELS[t.status].toLowerCase()}. Assigned to ${n.get(t.assigneeId) ?? 'a former member'}.`,
            link: `/dev-team/tasks/${t.id}`, taskId: t.id, fromName: 'Sentinel',
          });
          await recordReminder({ kind: 'overdue', sentByName: 'Sentinel (automatic)', recipientIds: [t.assigneeId], recipientNames: [n.get(t.assigneeId) ?? '—'], taskId: t.id, taskTitle: t.title, message: `Overdue since ${t.dueDate}.` });
          await r.devTasks.update({ ...t, overdueRemindedOn: today });
          overdue++;
        } else if (end - now() <= 24 * 3600_000 && !t.dueSoonRemindedAt) {
          await notifyTeam([t.assigneeId], {
            type: 'reminder', severity: 'medium', title: `Due soon: ${t.title}`, body: `${t.id} is due ${t.dueDate === today ? 'today' : 'tomorrow'} (${t.dueDate}).`, link: `/dev-team/tasks/${t.id}`, taskId: t.id, fromName: 'Sentinel',
          });
          await recordReminder({ kind: 'due_soon', sentByName: 'Sentinel (automatic)', recipientIds: [t.assigneeId], recipientNames: [n.get(t.assigneeId) ?? '—'], taskId: t.id, taskTitle: t.title, message: `Due ${t.dueDate}.` });
          await r.devTasks.update({ ...t, dueSoonRemindedAt: iso() });
          dueSoon++;
        }
      }
      if (dueSoon || overdue) ctx.log.info({ dueSoon, overdue }, 'development team reminders sent');
      return { dueSoon, overdue };
    },
  };
  return service;
}
export type DevTeamService = ReturnType<typeof createDevTeamService>;
