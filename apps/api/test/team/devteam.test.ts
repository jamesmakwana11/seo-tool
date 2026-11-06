/**
 * Development Team through the HTTP API: invitations with a one-time activation link (hash stored only), activation,
 * edit / deactivate / remove, role permissions limited to what the Admin holds, tasks with priority / due date /
 * status, Overdue, members seeing only their own tasks, in-app notifications (assignment, completion, comments,
 * read / unread), automatic due-soon and overdue reminders (once each), manual reminders and the reminder history.
 */
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DevInviteResult, DevTaskView, DevTeamMember, DevTeamOverview, Notification, TeamReminder, TeamRolePermissions } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { sha256 } from '../../src/lib/passwords';
import { FIXTURE, failingFetch } from '../api/helpers';

const SITE_ADMIN = { email: 'site.admin@example.com', password: '24681357' };
const DAY = 86_400_000;

async function setup() {
  let now = Date.parse('2026-11-10T06:00:00Z'); // 11:30 IST
  const env = loadEnv({
    NODE_ENV: 'test', SEED_TEST_FIXTURES: 'true', SESSION_SECRET: 'devteam-test-secret-value-at-least-32-chars', LOG_LEVEL: 'silent', APP_BASE_URL: 'https://sentinel.example',
    SITE_ADMIN_EMAIL: SITE_ADMIN.email, SITE_ADMIN_INITIAL_PASSWORD: SITE_ADMIN.password,
  });
  const c = await createContainer({ env, fetchImpl: failingFetch, clock: () => new Date(now) });
  const agent = supertest(createApp(c));
  const login = (email: string, password = FIXTURE.password) => agent.post('/api/auth/login').send({ email, password });
  const as = (tok: string) => ({
    get: (p: string) => agent.get(p).set({ Authorization: `Bearer ${tok}` }),
    post: (p: string, b: unknown = {}) => agent.post(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    put: (p: string, b: unknown = {}) => agent.put(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    patch: (p: string, b: unknown = {}) => agent.patch(p).set({ Authorization: `Bearer ${tok}` }).send(b as object),
    del: (p: string) => agent.delete(p).set({ Authorization: `Bearer ${tok}` }),
  });
  const admin = as((await login(SITE_ADMIN.email, SITE_ADMIN.password)).body.token);
  const dev = as((await login(FIXTURE.developer)).body.token);
  const devId = (await dev.get('/api/auth/me')).body.id as string;
  return { c, agent, login, as, admin, dev, devId, advance: (ms: number) => { now += ms; }, today: () => new Date(now + 330 * 60_000).toISOString().slice(0, 10) };
}
const plus = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

describe('Development Team members', () => {
  it('invites a member with a one-time activation link; the member signs in only after choosing a password', async () => {
    const h = await setup();
    const r = await h.admin.post('/api/dev-team/members', { name: 'Priya Shah', email: 'Priya.Shah@Example.com', role: 'developer', title: 'Shopify developer' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const inv = r.body as DevInviteResult;
    expect(inv.member).toMatchObject({ name: 'Priya Shah', email: 'priya.shah@example.com', role: 'developer', status: 'invited', invitePending: true });
    expect(inv.activation.emailed).toBe(false);
    expect(inv.activation.link).toMatch(/^https:\/\/sentinel\.example\/reset-password\?token=[\w-]+&invite=1$/);
    const token = new URL(inv.activation.link!).searchParams.get('token')!;
    // Only the hash is stored; the token is not in the audit log.
    expect(await h.c.repos.resetTokens.get(sha256(token))).toBeTruthy();
    expect(JSON.stringify(await h.c.repos.resetTokens.list())).not.toContain(token);
    expect(JSON.stringify(await h.c.repos.audit.list())).not.toContain(token);
    expect((await h.login('priya.shah@example.com', 'whatever-123')).status).toBe(401);

    expect((await h.agent.post('/api/auth/reset').send({ token, newPassword: 'Priya-Strong-2026' })).status).toBe(200);
    const me = await h.login('priya.shah@example.com', 'Priya-Strong-2026');
    expect(me.status).toBe(200);
    expect(me.body.user.permissions).toContain('devteam.view');
    const list = (await h.admin.get('/api/dev-team/members')).body as DevTeamMember[];
    expect(list.find((m) => m.email === 'priya.shah@example.com')).toMatchObject({ status: 'active', invitePending: false });
    // The link works once.
    expect((await h.agent.post('/api/auth/reset').send({ token, newPassword: 'Another-Pass-2026' })).status).toBe(400);
  });

  it('validates invitations and keeps admin roles out of reach', async () => {
    const h = await setup();
    expect((await h.admin.post('/api/dev-team/members', { name: 'X', email: 'x@example.com', role: 'developer' })).status).toBe(400);
    expect((await h.admin.post('/api/dev-team/members', { name: 'Eve Admin', email: 'eve@example.com', role: 'admin' })).status).toBe(400);
    expect((await h.admin.post('/api/dev-team/members', { name: 'Ankit', email: FIXTURE.developer, role: 'developer' })).status).toBe(409);
    expect((await h.dev.post('/api/dev-team/members', { name: 'Someone', email: 'someone@example.com', role: 'developer' })).status).toBe(403);
    expect((await h.dev.get('/api/dev-team/overview')).status).toBe(403);
    const self = (await h.admin.get('/api/auth/me')).body.id;
    expect((await h.admin.patch(`/api/dev-team/members/${self}`, { name: 'Me' })).status).toBe(404); // the Admin is not a team member
  });

  it('edits, deactivates (signed out at once), reactivates and removes members', async () => {
    const h = await setup();
    const ed = await h.admin.patch(`/api/dev-team/members/${h.devId}`, { role: 'seo_specialist', title: 'SEO engineer' });
    expect(ed.body).toMatchObject({ role: 'seo_specialist', title: 'SEO engineer' });
    const off = await h.admin.post(`/api/dev-team/members/${h.devId}/status`, { status: 'suspended' });
    expect(off.body.status).toBe('suspended');
    expect((await h.dev.get('/api/auth/me')).status).toBe(401);
    expect((await h.admin.post(`/api/dev-team/members/${h.devId}/status`, { status: 'active' })).body.status).toBe('active');
    expect((await h.login(FIXTURE.developer)).status).toBe(200);

    const t = (await h.admin.post('/api/dev-team/tasks', { title: 'Fix canonical tags', kind: 'seo_issue', priority: 'high', dueDate: plus(h.today(), 3), assigneeId: h.devId })).body as DevTaskView;
    const rm = await h.admin.del(`/api/dev-team/members/${h.devId}`);
    expect(rm.body).toEqual({ removed: true, unassigned: 1 });
    expect((await h.admin.get(`/api/dev-team/tasks/${t.id}`)).body.assigneeId).toBeUndefined();
    expect((await h.admin.get('/api/dev-team/members')).body.some((m: DevTeamMember) => m.id === h.devId)).toBe(false);
    expect((await h.login(FIXTURE.developer)).status).toBe(403);
  });

  it('role permissions: an Admin grants only permissions it holds, never admin rights', async () => {
    const h = await setup();
    const roles = (await h.admin.get('/api/dev-team/roles')).body as TeamRolePermissions[];
    expect(roles.map((r) => r.role)).toEqual(['developer', 'seo_specialist']);
    expect(roles[0].grantable).toContain('analytics.view');
    expect(roles[0].grantable).not.toContain('roles.manage');
    expect(roles[0].grantable).not.toContain('audit.view'); // the Admin does not hold it
    const before = roles[0].permissions;
    const r = await h.admin.put('/api/dev-team/roles/developer', { permissions: [...before, 'analytics.view', 'roles.manage', 'audit.view'] });
    const dev = (r.body as TeamRolePermissions[])[0];
    expect(dev.permissions).toContain('analytics.view');
    expect(dev.permissions).not.toContain('roles.manage');
    expect(dev.permissions).not.toContain('audit.view');
    expect((await h.dev.get('/api/insights/cwv')).status).toBe(200);
    expect((await h.admin.put('/api/dev-team/roles/admin', { permissions: [] })).status).toBe(400);
    // Removing a permission the Admin holds works; permissions it cannot grant stay as they were.
    const back = (await h.admin.put('/api/dev-team/roles/developer', { permissions: before })).body[0] as TeamRolePermissions;
    expect(back.permissions).not.toContain('analytics.view');
    expect(back.permissions).toEqual(expect.arrayContaining(before));
  });
});

describe('Development Team tasks, notifications and reminders', () => {
  it('assigns a task, notifies the member, lets them work it, and tells the Admin when it is done', async () => {
    const h = await setup();
    expect((await h.admin.post('/api/dev-team/tasks', { title: 'Hi', kind: 'development', priority: 'high', dueDate: h.today() })).status).toBe(400);
    expect((await h.admin.post('/api/dev-team/tasks', { title: 'Old task', kind: 'development', priority: 'high', dueDate: plus(h.today(), -1) })).status).toBe(400);
    const r = await h.admin.post('/api/dev-team/tasks', { title: 'Compress hero images on collection pages', description: 'LCP is poor on mobile.', kind: 'development', priority: 'urgent', dueDate: plus(h.today(), 2), assigneeId: h.devId, url: 'https://deodap.in/collections/kitchen' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const t = r.body as DevTaskView;
    expect(t).toMatchObject({ status: 'pending', displayStatus: 'pending', overdue: false, assigneeName: expect.any(String), priority: 'urgent' });
    const other = (await h.admin.post('/api/dev-team/tasks', { title: 'Unassigned clean-up', kind: 'development', priority: 'low', dueDate: plus(h.today(), 9) })).body as DevTaskView;

    const inbox = (await h.dev.get('/api/notifications')).body as Notification[];
    const n = inbox.find((x) => x.taskId === t.id)!;
    expect(n).toMatchObject({ type: 'assignment', link: `/dev-team/tasks/${t.id}`, fromName: 'Admin' });
    // Members see their own tasks only, and change status only.
    const mine = (await h.dev.get('/api/dev-team/tasks?status=all')).body as DevTaskView[];
    expect(mine.map((x) => x.id)).toEqual([t.id]);
    expect((await h.dev.get(`/api/dev-team/tasks/${other.id}`)).status).toBe(403);
    expect((await h.dev.patch(`/api/dev-team/tasks/${t.id}`, { title: 'Renamed' })).status).toBe(403);
    expect((await h.dev.patch(`/api/dev-team/tasks/${t.id}`, { status: 'in_progress' })).body).toMatchObject({ status: 'in_progress', startedAt: expect.any(String) });
    expect((await h.dev.post(`/api/dev-team/tasks/${t.id}/comments`, { text: 'Converted to WebP, checking LCP now.' })).body.comments).toHaveLength(1);
    expect((await h.dev.patch(`/api/dev-team/tasks/${t.id}`, { status: 'completed' })).body).toMatchObject({ status: 'completed', displayStatus: 'completed', completedAt: expect.any(String) });
    const adminInbox = (await h.admin.get('/api/notifications')).body as Notification[];
    expect(adminInbox.filter((x) => x.taskId === t.id).map((x) => x.type).sort()).toEqual(['mention', 'review']);

    // Read / unread.
    expect((await h.dev.post(`/api/notifications/${n.id}/read`)).status).toBe(200);
    expect(((await h.dev.get('/api/notifications')).body as Notification[]).find((x) => x.id === n.id)!.readAt).toBeTruthy();
    expect((await h.dev.post(`/api/notifications/${n.id}/unread`)).status).toBe(200);
    expect(((await h.dev.get('/api/notifications')).body as Notification[]).find((x) => x.id === n.id)!.readAt).toBeUndefined();
    const hist = (await h.admin.get(`/api/dev-team/tasks/${t.id}`)).body as DevTaskView;
    expect(hist.history.map((e) => e.message)).toEqual(['Created the task', 'Status → In progress', 'Status → Completed']);
  });

  it('shows Overdue, reminds once before the due date and once a day while overdue', async () => {
    const h = await setup();
    const t = (await h.admin.post('/api/dev-team/tasks', { title: 'Fix 404s from the old blog', kind: 'seo_issue', priority: 'high', dueDate: plus(h.today(), 1), assigneeId: h.devId })).body as DevTaskView;
    let tick = await h.c.services.devTeam.reminderTick();
    expect(tick).toEqual({ dueSoon: 0, overdue: 0 }); // due tomorrow 23:59 IST: more than 24 h away
    h.advance(DAY);
    tick = await h.c.services.devTeam.reminderTick();
    expect(tick).toEqual({ dueSoon: 1, overdue: 0 });
    expect((await h.c.services.devTeam.reminderTick()).dueSoon).toBe(0); // once
    h.advance(DAY);
    expect(await h.c.services.devTeam.reminderTick()).toEqual({ dueSoon: 0, overdue: 1 });
    expect((await h.c.services.devTeam.reminderTick()).overdue).toBe(0); // once a day
    const view = (await h.dev.get(`/api/dev-team/tasks/${t.id}`)).body as DevTaskView;
    expect(view).toMatchObject({ overdue: true, displayStatus: 'overdue', daysLeft: -1 });
    const ov = (await h.admin.get('/api/dev-team/overview')).body as DevTeamOverview;
    expect(ov.counts.overdue).toBe(1);
    expect(ov.overdue[0].id).toBe(t.id);
    expect(ov.members.find((m) => m.id === h.devId)!.work).toMatchObject({ open: 1, overdue: 1 });
    expect(((await h.admin.get('/api/dev-team/tasks?status=overdue')).body as DevTaskView[]).map((x) => x.id)).toEqual([t.id]);
    h.advance(DAY);
    expect((await h.c.services.devTeam.reminderTick()).overdue).toBe(1);
    const devInbox = ((await h.dev.get('/api/notifications')).body as Notification[]).filter((x) => x.taskId === t.id).map((x) => x.title.split(':')[0]);
    expect(devInbox.sort()).toEqual(['Due soon', 'New task', 'Overdue', 'Overdue']);
    // The creator hears about the first overdue reminder only.
    expect(((await h.admin.get('/api/notifications')).body as Notification[]).filter((x) => x.taskId === t.id && x.type === 'reminder')).toHaveLength(1);
    const kinds = ((await h.admin.get('/api/dev-team/reminders')).body as TeamReminder[]).map((r) => r.kind);
    expect(kinds.sort()).toEqual(['assignment', 'due_soon', 'overdue', 'overdue']);
  });

  it('sends manual reminders to one member or the whole team and keeps the history', async () => {
    const h = await setup();
    const members = (await h.admin.get('/api/dev-team/members')).body as DevTeamMember[];
    const active = members.filter((m) => m.status !== 'suspended');
    const all = await h.admin.post('/api/dev-team/reminders', { to: 'all', message: 'Sprint review on Friday — update your tasks.' });
    expect(all.status).toBe(201);
    expect((all.body as TeamReminder).recipientIds.sort()).toEqual(active.map((m) => m.id).sort());
    const one = await h.admin.post('/api/dev-team/reminders', { to: h.devId, message: 'Please look at the robots.txt change.' });
    expect((one.body as TeamReminder).recipientIds).toEqual([h.devId]);
    expect((await h.admin.post('/api/dev-team/reminders', { to: 'nobody', message: 'Hello there' })).status).toBe(400);
    expect((await h.dev.post('/api/dev-team/reminders', { to: 'all', message: 'Hello team' })).status).toBe(403);
    const inbox = ((await h.dev.get('/api/notifications')).body as Notification[]).filter((x) => x.type === 'reminder');
    expect(inbox.map((x) => x.body)).toEqual(['Please look at the robots.txt change.', 'Sprint review on Friday — update your tasks.']);
    const hist = (await h.admin.get('/api/dev-team/reminders')).body as TeamReminder[];
    expect(hist.map((x) => x.kind)).toEqual(['manual', 'manual']);
    expect(hist[0]).toMatchObject({ sentByName: 'Admin', message: 'Please look at the robots.txt change.' });
  });
});
