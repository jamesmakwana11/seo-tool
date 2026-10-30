import { useEffect, useState } from 'react';
import { Pencil, UserPlus } from 'lucide-react';
import { ROLE_LABELS, TEAMS, TEAM_IDS, type AccountStatus, type Employee, type EmployeeInput, type Role, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { Async, Badge, Button, Checkbox, EmptyState, Field, IconButton, Input, Notice, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { RoleBadge, SourceBadge, TeamBadge } from '@/components/domain/badges';
import { ROLES, ROLE_HELP } from '@/components/team/roles';
import { fmtDate, fmtRelative } from '@/lib/format';

const KEYS = ['q', 'role', 'team', 'status', 'focus'] as const;
const STATUSES: { value: AccountStatus; label: string }[] = [{ value: 'active', label: 'Active' }, { value: 'invited', label: 'Invited' }, { value: 'suspended', label: 'Suspended' }];

export default function EmployeesPage() {
  const { can } = useAuth();
  const f = useUrlFilters(KEYS);
  const q = useApiQuery(['employees'], () => api.listEmployees());
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const manage = can('employees.manage');
  const focus = f.get('focus');

  useEffect(() => {
    if (!focus || !q.data) return;
    const t = setTimeout(() => document.querySelector('.emp-focus-row')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    return () => clearTimeout(t);
  }, [focus, q.data]);

  const columns: Column<Employee>[] = [
    { key: 'name', header: 'Name', sort: (a, b) => a.name.localeCompare(b.name), cell: (e) => (
      <div className="min-w-[160px]">
        <div className="flex items-center gap-1.5 font-medium">{e.name}{e.isSeoLead && <Badge tone="signal">SEO lead</Badge>}</div>
        <div className="text-xs text-muted">{e.email}</div>
      </div>
    ) },
    { key: 'role', header: 'Role (permissions)', cell: (e) => <RoleBadge role={e.role} />, sort: (a, b) => a.role.localeCompare(b.role) },
    { key: 'teams', header: 'Teams (allocation)', cell: (e) => <div className="flex flex-wrap gap-1">{e.teamIds.map((t) => <TeamBadge key={t} team={t} short />)}</div> },
    { key: 'title', header: 'Title', cell: (e) => <span className="text-sm">{e.title}</span>, hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (e) => <Badge tone={e.status === 'active' ? 'ok' : e.status === 'invited' ? 'med' : 'crit'}>{STATUSES.find((s) => s.value === e.status)?.label}</Badge>, sort: (a, b) => a.status.localeCompare(b.status) },
    { key: 'cap', header: 'Capacity', cell: (e) => <span className="text-xs tabular-nums">{e.capacityHoursPerWeek}h/week</span>, sort: (a, b) => a.capacityHoursPerWeek - b.capacityHoursPerWeek, hideOnMobile: true },
    { key: 'last', header: 'Last active', cell: (e) => <span className="whitespace-nowrap text-xs text-muted" title={e.lastActiveAt ? fmtDate(e.lastActiveAt) : undefined}>{e.lastActiveAt ? fmtRelative(e.lastActiveAt) : 'Never'}</span>, sort: (a, b) => (a.lastActiveAt ?? '').localeCompare(b.lastActiveAt ?? ''), hideOnMobile: true },
    { key: 'src', header: 'Source', cell: (e) => <SourceBadge source={e.source} />, hideOnMobile: true },
    ...(manage ? [{ key: 'edit', header: <span className="sr-only">Actions</span>, cell: (e: Employee) => <IconButton label={`Edit ${e.name}`} onClick={(ev) => { ev.stopPropagation(); setEditing(e); }}><Pencil className="h-4 w-4" /></IconButton> }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Employees"
        description="Who can sign in and what they work on. A role controls permissions (what someone can do); teams are allocation groups (which allocated issues they work on). One person can be in several teams."
        actions={manage && <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setEditing('new')}>Invite employee</Button>}
      />
      {!manage && <div className="mb-4"><Notice>You can view the directory. Only Admins (employees.manage) can invite or edit employees.</Notice></div>}
      <Async q={q} rows={8}>
        {(list) => {
          const s = f.get('q').toLowerCase();
          const rows = list
            .filter((e) => (!s || e.name.toLowerCase().includes(s) || e.email.toLowerCase().includes(s) || e.title.toLowerCase().includes(s))
              && (!f.get('role') || e.role === f.get('role'))
              && (!f.get('team') || e.teamIds.includes(f.get('team') as TeamId))
              && (!f.get('status') || e.status === f.get('status')))
            .sort((a, b) => (a.id === focus ? -1 : b.id === focus ? 1 : 0));
          const focused = focus ? list.find((e) => e.id === focus) : undefined;
          return (
            <div className="space-y-4">
              {focus && !focused && <Notice tone="med">Employee {focus} was not found.</Notice>}
              <Panel bodyClassName="flex flex-wrap items-center gap-3 p-3">
                <Input aria-label="Search employees" placeholder="Search name, email or title" value={f.get('q')} onChange={(e) => f.set('q', e.target.value)} className="max-w-xs" />
                <FilterSelect label="Role" value={f.get('role')} onChange={(v) => f.set('role', v)} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
                <FilterSelect label="Team" value={f.get('team')} onChange={(v) => f.set('team', v)} options={TEAM_IDS.map((t) => ({ value: t, label: TEAMS[t].name }))} />
                <FilterSelect label="Status" value={f.get('status')} onChange={(v) => f.set('status', v)} options={STATUSES} />
                <ClearFilters show={f.active} onClear={f.clear} />
              </Panel>
              <DataTable
                caption="Employees"
                rows={rows}
                rowKey={(e) => e.id}
                columns={columns}
                rowClassName={(e) => (e.id === focus ? 'emp-focus-row bg-signal-tint/60 outline outline-2 -outline-offset-2 outline-signal/50' : e.status === 'suspended' ? 'opacity-60' : undefined)}
                onRowClick={manage ? (e) => setEditing(e) : undefined}
                empty={<EmptyState title="No employees match" description="Clear the filters or invite someone new." />}
              />
            </div>
          );
        }}
      </Async>
      {editing && <EmployeeDialog employee={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

interface Form { name: string; email: string; role: Role | ''; teamIds: TeamId[]; title: string; status: AccountStatus; cap: string; isSeoLead: boolean }

function validate(f: Form) {
  const e: Partial<Record<keyof Form, string>> = {};
  if (f.name.trim().length < 2) e.name = 'Enter the full name (at least 2 characters).';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.';
  if (!f.role) e.role = 'Choose a role.';
  if (!f.teamIds.length) e.teamIds = 'Assign at least one team.';
  if (!f.title.trim()) e.title = 'Enter a job title.';
  const cap = Number(f.cap);
  if (!Number.isFinite(cap) || cap < 1 || cap > 80) e.cap = 'Weekly capacity must be between 1 and 80 hours.';
  return e;
}

function EmployeeDialog({ employee, onClose }: { employee?: Employee; onClose: () => void }) {
  const me = useUser();
  const isSelf = employee?.id === me.id;
  const [f, setF] = useState<Form>(() => employee
    ? { name: employee.name, email: employee.email, role: employee.role, teamIds: employee.teamIds, title: employee.title, status: employee.status, cap: String(employee.capacityHoursPerWeek), isSeoLead: !!employee.isSeoLead }
    : { name: '', email: '', role: '', teamIds: [], title: '', status: 'invited', cap: '40', isSeoLead: false });
  const [touched, setTouched] = useState(false);
  const errs = validate(f);
  const err = (k: keyof Form) => (touched ? errs[k] : undefined);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const input: EmployeeInput = { name: f.name.trim(), email: f.email.trim(), role: f.role as Role, teamIds: f.teamIds, title: f.title.trim(), status: f.status, capacityHoursPerWeek: Number(f.cap), isSeoLead: f.isSeoLead };
  const m = useApiMutation(() => (employee ? api.updateEmployee(employee.id, input) : api.createEmployee(input)), {
    success: (e) => (employee ? `${e.name} updated` : `${e.name} invited as ${ROLE_LABELS[e.role]}`),
    invalidate: [['employees'], ['workload'], ['audit']],
    onSuccess: onClose,
  });
  const submit = () => { setTouched(true); if (!Object.keys(errs).length) m.mutate(); };
  return (
    <Dialog open onClose={onClose} title={employee ? `Edit ${employee.name}` : 'Invite employee'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={submit}>{employee ? 'Save employee' : 'Invite employee'}</Button></>}>
      <form className="grid grid-cols-1 gap-4 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Full name" required htmlFor="em-name" error={err('name')}>
          <Input id="em-name" data-autofocus value={f.name} onChange={(e) => set('name', e.target.value)} aria-invalid={!!err('name')} />
        </Field>
        <Field label="Email" required htmlFor="em-email" error={err('email')}>
          <Input id="em-email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} aria-invalid={!!err('email')} />
        </Field>
        <Field label="Job title" required htmlFor="em-title" error={err('title')}>
          <Input id="em-title" value={f.title} onChange={(e) => set('title', e.target.value)} aria-invalid={!!err('title')} placeholder="e.g. Shopify developer" />
        </Field>
        <Field label="Role — what they can do" required htmlFor="em-role" error={err('role')} hint={f.role ? ROLE_HELP[f.role] : 'Roles control permissions.'}>
          <Select id="em-role" value={f.role} onChange={(e) => set('role', e.target.value as Role)} disabled={isSelf} title={isSelf ? 'You cannot change your own role' : undefined} aria-invalid={!!err('role')}>
            <option value="">Choose a role</option>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </Select>
        </Field>
        <fieldset className="md:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Teams — which queues they work from <span className="text-crit-ink" aria-hidden>*</span></legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {TEAM_IDS.map((t) => (
              <Checkbox key={t} label={TEAMS[t].name} description={TEAMS[t].description} checked={f.teamIds.includes(t)} onChange={(on) => set('teamIds', on ? [...f.teamIds, t] : f.teamIds.filter((x) => x !== t))} />
            ))}
          </div>
          <p className={`mt-1 text-xs ${err('teamIds') ? 'text-crit-ink' : 'text-muted'}`} role={err('teamIds') ? 'alert' : undefined}>{err('teamIds') ?? 'Teams are allocation groups, not roles — a developer can sit in the Content team, for example.'}</p>
        </fieldset>
        <Field label="Account status" htmlFor="em-status" hint={isSelf ? 'You cannot deactivate your own account.' : 'Suspended accounts cannot sign in and are not offered as assignees.'}>
          <Select id="em-status" value={f.status} onChange={(e) => set('status', e.target.value as AccountStatus)} disabled={isSelf}>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="Weekly capacity (hours)" required htmlFor="em-cap" error={err('cap')} hint="Used for the workload utilisation bar.">
          <Input id="em-cap" type="number" min={1} max={80} value={f.cap} onChange={(e) => set('cap', e.target.value)} aria-invalid={!!err('cap')} />
        </Field>
        <div className="md:col-span-2">
          <Checkbox label="SEO lead" description="Receives review requests and escalations for the SEO team." checked={f.isSeoLead} onChange={(v) => set('isSeoLead', v)} />
        </div>
        {!employee && <div className="md:col-span-2"><Notice>The invite email carries a one-time set-password link (valid 72 hours). It is sent only when an email channel is configured in Settings → Notifications.</Notice></div>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
