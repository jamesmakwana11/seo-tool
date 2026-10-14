import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, LogOut } from 'lucide-react';
import { TEAMS } from '@sentinel/shared';
import { api, API_MODE } from '@/api/client';
import { errorMessage, useApiMutation } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { useEmployees } from '@/hooks/lookups';
import { useToast } from '@/components/ui/Toast';
import { Badge, Button, DemoBadge, Field, Input, KV, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { RoleBadge, TeamBadge } from '@/components/domain/badges';
import { PASSWORD_RULE, passwordProblem } from '@/components/misc/password';
import { fmtDateTime } from '@/lib/format';

export default function ProfilePage() {
  const user = useUser();
  return (
    <div>
      <PageHeader title="Profile & account" description="Your name, job title, password and session." meta={<><DemoBadge />{user.demo && <DemoBadge label="Role preview session" title="Signed in through the development role preview — not production authentication." />}</>} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <DetailsForm />
          <PasswordForm />
        </div>
        <div className="space-y-5">
          <AccessPanel />
          <SessionPanel />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ details

function DetailsForm() {
  const user = useUser();
  const { refresh } = useAuth();
  const emp = useEmployees();
  const current = emp.byId.get(user.id);
  // Seed the form once the directory has loaded; afterwards the user's edits win.
  const [draft, setDraft] = useState<{ name?: string; title?: string } | null>(null);
  const name = draft?.name ?? user.name;
  const title = draft?.title ?? current?.title ?? '';
  const [touched, setTouched] = useState(false);
  const m = useApiMutation((v: { name: string; title?: string }) => api.updateProfile(v), {
    success: 'Profile saved',
    invalidate: [['employees'], ['workload']],
    onSuccess: () => { setDraft(null); setTouched(false); void refresh(); },
  });
  const nameErr = name.trim().length < 2 ? 'Enter your name (at least 2 characters).' : undefined;
  const titleErr = title.trim().length > 80 ? 'Keep the title under 80 characters.' : undefined;
  const dirty = name.trim() !== user.name || (current ? title.trim() !== current.title : title.trim() !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameErr || titleErr) return;
    // Only send the title once it is known, so a slow directory load never blanks it.
    m.mutate({ name: name.trim(), title: draft?.title !== undefined || current ? title.trim() : undefined });
  };
  return (
    <Panel title="Your details" subtitle="Shown on allocation trails, issue activity and the audit log">
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Full name" htmlFor="pf-name" required error={touched ? nameErr : undefined}>
          <Input id="pf-name" autoComplete="name" value={name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} aria-invalid={touched && !!nameErr} />
        </Field>
        <Field label="Job title" htmlFor="pf-title" error={touched ? titleErr : undefined} hint={emp.isLoading ? 'Loading current title…' : 'e.g. SEO Specialist, Frontend Developer'}>
          <Input id="pf-title" autoComplete="organization-title" value={title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} aria-invalid={touched && !!titleErr} disabled={emp.isLoading} />
        </Field>
        <Field label="Work email" htmlFor="pf-email" hint="Your sign-in email. An admin can change it from Employees.">
          <Input id="pf-email" value={user.email} disabled readOnly />
        </Field>
        <div className="flex justify-end gap-2">
          {draft && <Button onClick={() => { setDraft(null); setTouched(false); }}>Discard changes</Button>}
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!dirty}>Save profile</Button>
        </div>
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------ password

function PasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [formError, setFormError] = useState<string>();
  const m = useApiMutation((v: { currentPassword: string; newPassword: string }) => api.updateProfile(v), {
    silentError: true,
    onSuccess: () => {
      toast.success('Password changed');
      setCurrent(''); setNext(''); setConfirm(''); setTouched(false); setFormError(undefined);
    },
  });
  const errs = {
    current: !current ? 'Enter your current password.' : undefined,
    next: passwordProblem(next) ?? (next && next === current ? 'Choose a password different from your current one.' : undefined),
    confirm: !confirm ? 'Re-enter the new password.' : confirm !== next ? 'Passwords do not match.' : undefined,
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setFormError(undefined);
    if (errs.current || errs.next || errs.confirm) return;
    m.mutate({ currentPassword: current, newPassword: next }, { onError: (err) => setFormError(errorMessage(err)) });
  };
  return (
    <Panel title="Change password" subtitle={PASSWORD_RULE}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {formError && <Notice tone="crit">{formError}</Notice>}
        {API_MODE === 'mock' && <Notice tone="demo">Mock mode keeps passwords in browser memory only — reloading the page restores the DEMO password.</Notice>}
        <Field label="Current password" htmlFor="pw-current" required error={touched ? errs.current : undefined}>
          <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-invalid={touched && !!errs.current} />
        </Field>
        <Field label="New password" htmlFor="pw-new" required error={touched ? errs.next : undefined} hint={PASSWORD_RULE}>
          <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-invalid={touched && !!errs.next} />
        </Field>
        <Field label="Confirm new password" htmlFor="pw-confirm" required error={touched ? errs.confirm : undefined}>
          <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={touched && !!errs.confirm} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={m.isPending}>Change password</Button>
        </div>
      </form>
    </Panel>
  );
}

// ------------------------------------------------------------------ access (read-only)

function AccessPanel() {
  const user = useUser();
  return (
    <Panel title="Role & teams" subtitle="Read-only — your access is managed by an admin">
      <KV cols={1} items={[
        { k: 'Role', v: <span className="flex flex-wrap items-center gap-2"><RoleBadge role={user.role} />{user.isSeoLead && <Badge tone="signal">SEO lead</Badge>}</span> },
        { k: 'Assignment teams', v: user.teamIds.length ? <span className="flex flex-wrap gap-1.5">{user.teamIds.map((t) => <TeamBadge key={t} team={t} />)}</span> : <span className="text-muted">No team</span> },
        { k: 'What your teams receive', v: user.teamIds.length ? <ul className="list-disc space-y-0.5 pl-5 text-ink-soft">{user.teamIds.map((t) => <li key={t}><strong>{TEAMS[t].name}:</strong> {TEAMS[t].description}</li>)}</ul> : '—' },
        { k: 'Permissions', v: <span className="text-ink-soft">{user.permissions.length} granted by your role</span> },
      ]} />
      <p className="mt-4 text-xs text-muted">Role decides what you can do in Sentinel; teams decide which allocated issues you work on. Ask an admin to change either from Employees or Roles & permissions.</p>
    </Panel>
  );
}

// ------------------------------------------------------------------ session

function SessionPanel() {
  const user = useUser();
  const { logout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await logout();
      nav('/login', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Panel title="Session">
      <KV cols={1} items={[
        { k: 'Signed in as', v: <span>{user.name} · <Mono>{user.email}</Mono></span> },
        { k: 'Session type', v: user.demo ? <span className="flex flex-wrap items-center gap-2"><DemoBadge label="Development role preview" title="Previewing a role with a mock user — not production authentication." /><span className="text-xs text-muted">Mock user, nothing persists.</span></span> : API_MODE === 'mock' ? <span>Mock sign-in <span className="text-xs text-muted">(browser memory only — Phase 1)</span></span> : 'Password sign-in' },
        { k: 'API mode', v: API_MODE === 'mock' ? 'In-browser mock adapter (DEMO data)' : 'API server' },
        { k: 'Viewed at', v: `${fmtDateTime(new Date().toISOString())} IST` },
      ]} />
      <div className="mt-4 flex justify-end">
        <Button variant="danger" icon={<LogOut className="h-4 w-4" />} onClick={() => setConfirm(true)}>Sign out</Button>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Sign out?" body="You will return to the sign-in screen. Unsaved changes on other screens are lost." confirmLabel="Sign out" danger loading={busy} onConfirm={() => void signOut()} />
    </Panel>
  );
}
