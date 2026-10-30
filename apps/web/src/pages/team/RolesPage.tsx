import { useEffect, useMemo, useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { ALL_PERMISSIONS, DEFAULT_PERMISSIONS, ROLE_LABELS, type Permission, type PermissionMatrix, type Role } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { ROLES, ROLE_HELP } from '@/components/team/roles';

/** Legacy task permissions are kept in stored matrices for compatibility but are not shown — task management was removed. */
const SHOWN = ALL_PERMISSIONS.filter((p) => !p.startsWith('tasks.'));
const GROUP_ORDER = ['dashboard', 'websites', 'issues', 'fixcards', 'crawls', 'modules', 'opportunities', 'reports', 'rules', 'qa_gate', 'disavow', 'employees', 'roles', 'integrations', 'shopify', 'settings', 'notifications', 'audit', 'system', 'diagnostics'];
const GROUP_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', issues: 'Issues', fixcards: 'Fix Cards', websites: 'Websites', crawls: 'Crawls', modules: 'Audit modules', opportunities: 'Opportunities', reports: 'Reports',
  rules: 'AI compliance rules', qa_gate: 'QA gate', disavow: 'Disavow', employees: 'Employees', roles: 'Roles', integrations: 'Integrations', settings: 'Settings',
  notifications: 'Notifications', audit: 'Audit log', system: 'System health', diagnostics: 'Diagnostics', shopify: 'Shopify',
};
const PERM_HELP: Partial<Record<Permission, string>> = {
  'fixcards.approve_proposal': 'Record approval of a proposed live-site change (never applied by Sentinel)',
  'issues.allocate': 'Allocate issues (API and automatic rules) and reopen closed ones',
  'issues.update_status': 'Start work / mark fixed (developers: own team only)',
  'issues.verify': 'Trigger system re-verification of fixed issues',
  'websites.manage': 'Add and edit websites',
  'roles.manage': 'Edit this matrix',
  'employees.manage': 'Invite and edit employees',
  'shopify.edit': 'SEO editor: draft and apply content changes in Shopify (after confirmation)',
  'shopify.theme': 'Prepare theme file changes and write them to unpublished themes (never publishes)',
};

const sortMatrix = (m: PermissionMatrix): PermissionMatrix => Object.fromEntries(ROLES.map((r) => [r, ALL_PERMISSIONS.filter((p) => m[r]?.includes(p))])) as PermissionMatrix;
const same = (a: PermissionMatrix, b: PermissionMatrix) => ROLES.every((r) => { const x = sortMatrix(a)[r]; const y = sortMatrix(b)[r]; return x.length === y.length && x.every((p, i) => p === y[i]); });

export default function RolesPage() {
  const q = useApiQuery(['permissions'], () => api.getPermissionMatrix());
  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        description="What each role may do (prompt §4.3). Roles are permission sets; the 1into2 teams (SEO, Content, Development) are allocation groups managed on the Employees screen."
      />
      <div className="mb-4"><Notice tone="signal" title="Enforced by the backend">The API checks this matrix on every request. Hiding buttons in the interface is only a convenience — removing a permission here is what actually blocks the action.</Notice></div>
      <Async q={q} rows={12}>{(m) => <Matrix server={m} />}</Async>
    </div>
  );
}

function Matrix({ server }: { server: PermissionMatrix }) {
  const { refresh } = useAuth();
  const [draft, setDraft] = useState<PermissionMatrix>(() => sortMatrix(server));
  const [confirmDefaults, setConfirmDefaults] = useState(false);
  useEffect(() => { setDraft(sortMatrix(server)); }, [server]);
  const dirty = !same(draft, server);
  const changes = useMemo(() => ROLES.reduce((n, r) => n + SHOWN.filter((p) => draft[r].includes(p) !== server[r].includes(p)).length, 0), [draft, server]);
  const groups = useMemo(() => {
    const prefixes = [...GROUP_ORDER, ...new Set(SHOWN.map((p) => p.split('.')[0]).filter((g) => !GROUP_ORDER.includes(g)))];
    return prefixes.map((g) => [g, SHOWN.filter((p) => p.split('.')[0] === g)] as const).filter(([, list]) => list.length);
  }, []);
  const save = useApiMutation(() => api.updatePermissionMatrix(sortMatrix(draft)), {
    success: 'Permissions saved — they apply on the next request',
    invalidate: [['permissions'], ['employees'], ['audit']],
    onSuccess: () => { void refresh(); },
  });
  // Super Admin always has every permission (the server enforces it too).
  const locked = (r: Role, _p: Permission) => r === 'super_admin';
  const toggle = (r: Role, p: Permission) => {
    if (locked(r, p)) return;
    setDraft((d) => ({ ...d, [r]: d[r].includes(p) ? d[r].filter((x) => x !== p) : ALL_PERMISSIONS.filter((x) => x === p || d[r].includes(x)) }));
  };

  return (
    <>
      <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface/95 px-3 py-2 backdrop-blur">
        <span className="text-sm text-muted" aria-live="polite">{dirty ? <><Badge tone="med">Unsaved</Badge> {changes} change{changes === 1 ? '' : 's'}</> : 'No unsaved changes'}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!dirty || save.isPending} onClick={() => setDraft(sortMatrix(server))}>Reset</Button>
          <Button size="sm" disabled={same(draft, DEFAULT_PERMISSIONS) || save.isPending} onClick={() => setConfirmDefaults(true)}>Restore defaults</Button>
          <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        </div>
      </div>
      <Panel bodyClassName="p-0">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <caption className="sr-only">Permission matrix — permissions by role</caption>
            <thead>
              <tr className="border-b border-line bg-raised/70 text-left">
                <th scope="col" className="px-3 py-2 text-xs font-medium text-muted">Permission</th>
                {ROLES.map((r) => <th key={r} scope="col" title={ROLE_HELP[r]} className="w-28 px-3 py-2 text-center text-xs font-medium text-muted">{ROLE_LABELS[r]}<div className="font-normal tabular-nums text-faint">{draft[r].filter((p) => !p.startsWith('tasks.')).length}/{SHOWN.length}</div></th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, perms]) => (
                <GroupRows key={g} label={GROUP_LABELS[g] ?? g} perms={perms} draft={draft} server={server} locked={locked} toggle={toggle} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <ConfirmDialog
        open={confirmDefaults}
        onClose={() => setConfirmDefaults(false)}
        title="Restore default permissions?"
        body="Loads the default matrix into the editor. Nothing changes until you choose Save changes."
        confirmLabel="Load defaults"
        onConfirm={() => { setDraft(sortMatrix(DEFAULT_PERMISSIONS)); setConfirmDefaults(false); }}
      />
    </>
  );
}

function GroupRows({ label, perms, draft, server, locked, toggle }: { label: string; perms: Permission[]; draft: PermissionMatrix; server: PermissionMatrix; locked: (r: Role, p: Permission) => boolean; toggle: (r: Role, p: Permission) => void }) {
  return (
    <>
      <tr className="border-b border-line bg-canvas/40"><th scope="rowgroup" colSpan={4} className="px-3 py-1.5 text-left text-xs font-semibold text-ink">{label}</th></tr>
      {perms.map((p) => (
        <tr key={p} className="border-b border-line last:border-0">
          <th scope="row" className="px-3 py-2 text-left font-normal">
            <span className="font-mono text-xs text-ink">{p}</span>
            {PERM_HELP[p] && <span className="block text-xs text-muted">{PERM_HELP[p]}</span>}
          </th>
          {ROLES.map((r) => {
            const on = draft[r].includes(p);
            const changed = on !== server[r].includes(p);
            const lock = locked(r, p);
            return (
              <td key={r} className={`px-3 py-2 text-center ${changed ? 'bg-med-tint/60' : ''}`}>
                <label className="inline-flex items-center justify-center gap-1" title={lock ? 'Admin must keep roles.manage so the matrix can still be edited' : undefined}>
                  <input type="checkbox" className="h-4 w-4 accent-[#7650D8]" checked={on} disabled={lock} onChange={() => toggle(r, p)} aria-label={`${ROLE_LABELS[r]}: ${p}${lock ? ' (locked)' : ''}`} />
                  {lock && <Lock className="h-3 w-3 text-faint" aria-hidden />}
                </label>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
