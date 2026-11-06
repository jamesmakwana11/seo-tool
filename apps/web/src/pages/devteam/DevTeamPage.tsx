import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, Copy, MoreHorizontal, Plus, UserPlus } from 'lucide-react';
import {
  ROLE_LABELS, type DevInviteResult, type DevTaskView, type DevTeamMember, type Permission, type TeamMemberRole, type TeamRolePermissions,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Checkbox, EmptyState, Field, IconButton, Input, Notice, PageHeader, Panel, Select, Stat, Tabs, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { DueText, PriorityBadge, TaskFormDialog } from '@/components/devteam/parts';
import { browserOrigin } from '@/components/settings/GoogleSection';
import { fmtDateTime, fmtRelative } from '@/lib/format';

type Tab = 'members' | 'roles';
const inv = [['dev-team'], ['employees'], ['audit']];

/** Development Team: members and their work, overdue and due-soon tasks, and the permissions of team roles. */
export default function DevTeamPage() {
  const [tab, setTab] = useState<Tab>('members');
  const q = useApiQuery(['dev-team', 'overview'], () => api.getDevTeamOverview());
  const [inviting, setInviting] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const nav = useNavigate();
  return (
    <div>
      <PageHeader
        title="Development team"
        description="Invite team members, give them a role, assign SEO issues and development work, and follow up on deadlines. Everything here is stored on the server and works across every website."
        actions={<div className="flex flex-wrap gap-2"><Button icon={<Plus className="h-4 w-4" />} onClick={() => setNewTask(true)}>New task</Button><Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviting(true)}>Invite member</Button></div>}
      />
      <Async q={q} rows={8}>
        {(o) => (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Open tasks" value={o.counts.open} to="/dev-team/tasks?status=open" />
              <Stat label="Pending" value={o.counts.pending} to="/dev-team/tasks?status=pending" />
              <Stat label="In progress" value={o.counts.inProgress} tone={o.counts.inProgress ? 'signal' : undefined} to="/dev-team/tasks?status=in_progress" />
              <Stat label="Overdue" value={o.counts.overdue} tone={o.counts.overdue ? 'crit' : undefined} to="/dev-team/tasks?status=overdue" />
              <Stat label="Completed" value={o.counts.completed} tone={o.counts.completed ? 'ok' : undefined} to="/dev-team/tasks?status=completed" />
            </div>
            {!o.emailConfigured && <Notice tone="med">Email is not configured on this server, so invitations show a one-time activation link for you to share, and reminders arrive as in-app notifications only.</Notice>}
            {(o.overdue.length > 0 || o.dueSoon.length > 0) && (
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <DeadlineList title="Overdue" tasks={o.overdue} empty="Nothing is overdue." onOpen={(t) => nav(`/dev-team/tasks/${t.id}`)} />
                <DeadlineList title="Due in the next 48 hours" tasks={o.dueSoon} empty="Nothing is due in the next two days." onOpen={(t) => nav(`/dev-team/tasks/${t.id}`)} />
              </div>
            )}
            <Tabs<Tab> value={tab} onChange={setTab} items={[{ value: 'members', label: 'Members', count: o.members.length }, { value: 'roles', label: 'Roles & permissions' }]} />
            {tab === 'members' ? <Members members={o.members} onInvite={() => setInviting(true)} /> : <Roles />}
            <InviteDialog open={inviting} onClose={() => setInviting(false)} />
            <TaskFormDialog open={newTask} onClose={() => setNewTask(false)} members={o.members} onSaved={(t) => nav(`/dev-team/tasks/${t.id}`)} />
          </div>
        )}
      </Async>
    </div>
  );
}

function DeadlineList({ title, tasks, empty, onOpen }: { title: string; tasks: DevTaskView[]; empty: string; onOpen: (t: DevTaskView) => void }) {
  return (
    <Panel title={title} bodyClassName="p-0">
      {tasks.length ? (
        <ul className="divide-y divide-line">
          {tasks.slice(0, 8).map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onOpen(t)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-canvas">
                <span className="font-mono text-xs text-muted">{t.id}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{t.title}</span>
                <PriorityBadge p={t.priority} />
                <span className="text-xs"><DueText t={t} /></span>
                <span className="text-xs text-muted">{t.assigneeName ?? 'Unassigned'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="px-4 py-4 text-sm text-muted">{empty}</p>}
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ members

function Members({ members, onInvite }: { members: DevTeamMember[]; onInvite: () => void }) {
  const [editing, setEditing] = useState<DevTeamMember | null>(null);
  const [removing, setRemoving] = useState<DevTeamMember | null>(null);
  const [remind, setRemind] = useState<DevTeamMember | null>(null);
  const [invite, setInvite] = useState<DevInviteResult | null>(null);
  const status = useApiMutation(({ id, s }: { id: string; s: 'active' | 'suspended' }) => api.setDevTeamMemberStatus(id, s), { success: (m) => `${m.name}: ${m.status === 'suspended' ? 'deactivated' : m.status === 'invited' ? 'can sign in after activating' : 'activated'}`, invalidate: inv });
  const resend = useApiMutation((id: string) => api.resendDevTeamInvite(id, browserOrigin()), { success: (r) => (r.activation.emailed ? `New activation email sent to ${r.member.email}` : 'New activation link created'), invalidate: inv, onSuccess: (r) => { if (!r.activation.emailed) setInvite(r); } });
  const remove = useApiMutation((id: string) => api.removeDevTeamMember(id), { success: (r) => `Removed from the team${r.unassigned ? ` — ${r.unassigned} open task(s) unassigned` : ''}`, invalidate: inv, onSuccess: () => setRemoving(null) });
  const columns: Column<DevTeamMember>[] = [
    { key: 'name', header: 'Member', sort: (a, b) => a.name.localeCompare(b.name), cell: (m) => <div className="min-w-[170px]"><div className="font-medium">{m.name}</div><div className="text-xs text-muted">{m.email}</div></div> },
    { key: 'role', header: 'Role', cell: (m) => <div><Badge tone="signal">{ROLE_LABELS[m.role]}</Badge>{m.title && <div className="mt-0.5 text-xs text-muted">{m.title}</div>}</div>, sort: (a, b) => a.role.localeCompare(b.role) },
    { key: 'status', header: 'Account', cell: (m) => <div><Badge tone={m.status === 'active' ? 'ok' : m.status === 'invited' ? 'med' : 'crit'}>{m.status === 'active' ? 'Active' : m.status === 'invited' ? 'Invitation sent' : 'Deactivated'}</Badge>{m.invitePending && <div className="mt-0.5 text-xs text-muted">{m.inviteExpiresAt ? `Link valid until ${fmtDateTime(m.inviteExpiresAt)}` : 'Link expired — resend it'}</div>}</div>, sort: (a, b) => a.status.localeCompare(b.status) },
    { key: 'work', header: 'Work status', cell: (m) => (
      <div className="flex flex-wrap gap-1 text-xs">
        <Link to={`/dev-team/tasks?assignee=${m.id}&status=open`} className="hover:underline"><Badge>{m.work.open} open</Badge></Link>
        {m.work.inProgress > 0 && <Badge tone="signal">{m.work.inProgress} in progress</Badge>}
        {m.work.overdue > 0 && <Badge tone="crit">{m.work.overdue} overdue</Badge>}
        <Badge tone="ok">{m.work.completed} done</Badge>
      </div>
    ), sort: (a, b) => a.work.overdue - b.work.overdue || a.work.open - b.work.open },
    { key: 'last', header: 'Last active', hideOnMobile: true, cell: (m) => <span className="text-xs text-muted">{m.lastActiveAt ? fmtRelative(m.lastActiveAt) : 'Never'}</span>, sort: (a, b) => (a.lastActiveAt ?? '').localeCompare(b.lastActiveAt ?? '') },
    { key: 'act', header: <span className="sr-only">Actions</span>, cell: (m) => (
      <Menu trigger={(open) => <IconButton label={`Actions for ${m.name}`} onClick={open}><MoreHorizontal className="h-4 w-4" /></IconButton>} items={[
        { label: 'Edit', onClick: () => setEditing(m) },
        { label: 'Send reminder', onClick: () => setRemind(m), disabled: m.status === 'suspended' },
        ...(m.invitePending ? [{ label: 'Send a new activation link', onClick: () => resend.mutate(m.id) }] : []),
        m.status === 'suspended' ? { label: 'Activate', onClick: () => status.mutate({ id: m.id, s: 'active' }) } : { label: 'Deactivate', onClick: () => status.mutate({ id: m.id, s: 'suspended' }) },
        { label: 'Remove from team', danger: true, onClick: () => setRemoving(m) },
      ]} />
    ) },
  ];
  return (
    <>
      <Panel bodyClassName="p-0">
        <DataTable rows={members} columns={columns} rowKey={(m) => m.id} search={(m) => `${m.name} ${m.email} ${m.title}`} searchPlaceholder="Search members"
          empty={<EmptyState title="No team members yet" description="Invite developers and SEO specialists by name and email. They activate their account with a one-time link." action={<Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={onInvite}>Invite member</Button>} />} />
      </Panel>
      <EditDialog member={editing} onClose={() => setEditing(null)} />
      <ReminderDialog member={remind} onClose={() => setRemind(null)} />
      <ActivationDialog result={invite} onClose={() => setInvite(null)} />
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing.id)} loading={remove.isPending} danger confirmLabel="Remove"
        title={`Remove ${removing?.name ?? ''} from the team?`} body="Their account is deactivated and they are signed out everywhere; their open tasks become unassigned. Completed work and history are kept." />
    </>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [v, setV] = useState({ name: '', email: '', role: 'developer' as TeamMemberRole, title: '' });
  const [result, setResult] = useState<DevInviteResult | null>(null);
  useEffect(() => { if (open) setV({ name: '', email: '', role: 'developer', title: '' }); }, [open]);
  const toast = useToast();
  const m = useApiMutation(() => api.inviteDevTeamMember({ ...v, name: v.name.trim(), email: v.email.trim(), title: v.title.trim() || undefined, origin: browserOrigin() }), {
    invalidate: inv, silentError: true,
    onSuccess: (r) => { onClose(); if (r.activation.emailed) toast.success(r.activation.note); else setResult(r); },
  });
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim());
  return (
    <>
      <Dialog open={open} onClose={onClose} title="Invite a team member" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={v.name.trim().length < 2 || !emailOk} onClick={() => m.mutate()}>Send invitation</Button></>}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (v.name.trim().length >= 2 && emailOk) m.mutate(); }}>
          <Field label="Name" htmlFor="inv-name" required><Input id="inv-name" data-autofocus value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} /></Field>
          <Field label="Email" htmlFor="inv-email" required error={v.email && !emailOk ? 'Enter a valid email address.' : undefined}><Input id="inv-email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} autoComplete="off" /></Field>
          <Field label="Role" htmlFor="inv-role" hint="What they may do in Sentinel — edit the permissions of each role under Roles & permissions.">
            <Select id="inv-role" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as TeamMemberRole })} className="w-full"><option value="developer">Developer</option><option value="seo_specialist">SEO Specialist</option></Select>
          </Field>
          <Field label="Job title (optional)" htmlFor="inv-title"><Input id="inv-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={80} placeholder="e.g. Shopify developer" /></Field>
          {m.error && <Notice tone="crit" title="Not invited">{errorMessage(m.error)}</Notice>}
        </form>
      </Dialog>
      <ActivationDialog result={result} onClose={() => setResult(null)} />
    </>
  );
}

/** Shows a one-time activation link (only when it could not be emailed). */
function ActivationDialog({ result, onClose }: { result: DevInviteResult | null; onClose: () => void }) {
  const toast = useToast();
  if (!result) return null;
  const link = result.activation.link ?? '';
  return (
    <Dialog open onClose={onClose} title={`Activation link for ${result.member.name}`} size="sm" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">{result.activation.note}</p>
        <div className="flex items-center gap-2 rounded-ctl border border-line bg-canvas px-2.5 py-1.5">
          <span className="min-w-0 flex-1 break-all font-mono text-xs" data-testid="activation-link">{link}</span>
          <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void navigator.clipboard?.writeText(link).then(() => toast.success('Link copied'), () => toast.error('Copy failed — select the link and copy it.'))}>Copy</Button>
        </div>
        <p className="text-xs text-muted">Valid until {fmtDateTime(result.activation.expiresAt)} IST. Send it privately (not in a group chat): anyone with the link can set this account’s password.</p>
      </div>
    </Dialog>
  );
}

function EditDialog({ member, onClose }: { member: DevTeamMember | null; onClose: () => void }) {
  const [v, setV] = useState({ name: '', email: '', role: 'developer' as TeamMemberRole, title: '' });
  useEffect(() => { if (member) setV({ name: member.name, email: member.email, role: (member.role === 'seo_specialist' ? 'seo_specialist' : 'developer'), title: member.title }); }, [member]);
  const managed = member?.role === 'developer' || member?.role === 'seo_specialist';
  const m = useApiMutation(() => api.updateDevTeamMember(member!.id, { name: v.name.trim(), email: v.email.trim(), title: v.title.trim(), ...(managed ? { role: v.role } : {}) }), { success: 'Member saved', invalidate: inv, onSuccess: onClose, silentError: true });
  return (
    <Dialog open={!!member} onClose={onClose} title={`Edit ${member?.name ?? ''}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} disabled={v.name.trim().length < 2} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="ed-name" required><Input id="ed-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} /></Field>
        <Field label="Email" htmlFor="ed-email" hint="Changing it changes the sign-in email."><Input id="ed-email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        {managed ? (
          <Field label="Role" htmlFor="ed-role"><Select id="ed-role" value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as TeamMemberRole })} className="w-full"><option value="developer">Developer</option><option value="seo_specialist">SEO Specialist</option></Select></Field>
        ) : member && <Notice>{member.name} is {ROLE_LABELS[member.role]}; only a Super Admin changes that role.</Notice>}
        <Field label="Job title" htmlFor="ed-title"><Input id="ed-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={80} /></Field>
        {m.error && <Notice tone="crit" title="Not saved">{errorMessage(m.error)}</Notice>}
      </div>
    </Dialog>
  );
}

export function ReminderDialog({ member, onClose, task }: { member: DevTeamMember | 'all' | null; onClose: () => void; task?: DevTaskView }) {
  const [text, setText] = useState('');
  useEffect(() => { if (member) setText(task ? `Please update “${task.title}” — it is due ${task.dueDate}.` : ''); }, [member, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useApiMutation(() => api.sendTeamReminder({ to: member === 'all' ? 'all' : member!.id, message: text.trim(), taskId: task?.id }), { success: (r) => `Reminder sent to ${r.recipientNames.length > 1 ? `${r.recipientNames.length} members` : r.recipientNames[0]}`, invalidate: inv, onSuccess: onClose });
  const who = member === 'all' ? 'the whole team' : member?.name;
  return (
    <Dialog open={!!member} onClose={onClose} title={`Remind ${who ?? ''}`} size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Bell className="h-4 w-4" />} loading={m.isPending} disabled={text.trim().length < 3} onClick={() => m.mutate()}>Send reminder</Button></>}>
      <Field label="Message" htmlFor="rem-text" hint="Arrives as an in-app notification and is kept in the reminder history."><Textarea id="rem-text" data-autofocus rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} /></Field>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ role permissions

const GROUP: Record<string, string> = {
  dashboard: 'Dashboard', issues: 'Issues', websites: 'Websites', fixcards: 'Fix Cards', crawls: 'Crawls', modules: 'Audit modules', opportunities: 'Opportunities', reports: 'Reports',
  rules: 'AI rules', qa_gate: 'QA gate', disavow: 'Disavow', employees: 'Employees', roles: 'Roles', integrations: 'Integrations', settings: 'Settings', notifications: 'Notifications',
  audit: 'Audit log', system: 'System health', diagnostics: 'Diagnostics', shopify: 'Shopify', google: 'Google', analytics: 'Google insights', devteam: 'Development team',
};

function Roles() {
  const { refresh } = useAuth();
  const q = useApiQuery(['dev-team', 'roles'], () => api.getDevTeamRoles());
  return (
    <Async q={q} rows={6}>
      {(roles) => (
        <div className="space-y-5">
          <Notice tone="signal" title="Enforced by the server">You can give these roles only permissions you hold yourself; admin rights (managing people, roles, integrations and settings) stay with Admins and the Super Admin.</Notice>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">{roles.map((r) => <RoleCard key={r.role} r={r} onSaved={() => void refresh()} />)}</div>
        </div>
      )}
    </Async>
  );
}

function RoleCard({ r, onSaved }: { r: TeamRolePermissions; onSaved: () => void }) {
  const [draft, setDraft] = useState<Set<Permission>>(() => new Set(r.permissions));
  useEffect(() => { setDraft(new Set(r.permissions)); }, [r.permissions.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const m = new Map<string, Permission[]>();
    for (const p of r.grantable) { const g = p.split('.')[0]; m.set(g, [...(m.get(g) ?? []), p]); }
    return [...m.entries()];
  }, [r.grantable]);
  const dirty = r.grantable.some((p) => draft.has(p) !== r.permissions.includes(p));
  const save = useApiMutation(() => api.updateDevTeamRole(r.role, [...draft]), { success: `${r.label} permissions saved`, invalidate: [['dev-team'], ['audit']], onSuccess: onSaved });
  const fixed = r.permissions.filter((p) => !r.grantable.includes(p));
  return (
    <Panel title={r.label} subtitle={`${draft.size} permission${draft.size === 1 ? '' : 's'}`} actions={<div className="flex gap-2">{dirty && <Button size="sm" variant="ghost" onClick={() => setDraft(new Set(r.permissions))}>Undo</Button>}<Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></div>}>
      <div className="space-y-3">
        {groups.map(([g, perms]) => (
          <fieldset key={g}>
            <legend className="mb-1 text-xs font-semibold text-muted">{GROUP[g] ?? g}</legend>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {perms.map((p) => <Checkbox key={p} label={<span className="font-mono text-[12.5px]">{p}</span>} checked={draft.has(p)} onChange={(on) => setDraft((d) => { const n = new Set(d); if (on) n.add(p); else n.delete(p); return n; })} />)}
            </div>
          </fieldset>
        ))}
        {fixed.length > 0 && <p className="text-xs text-muted">Also has (changed only by the Super Admin): {fixed.join(', ')}</p>}
      </div>
    </Panel>
  );
}
