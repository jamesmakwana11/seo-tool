import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  DEV_TASK_KIND_LABELS, DEV_TASK_PRIORITIES, DEV_TASK_PRIORITY_LABELS, type DevTaskDisplayStatus, type DevTaskFilter, type DevTaskKind, type DevTaskPriority, type DevTaskView,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { Async, Button, EmptyState, PageHeader, Panel, Tabs } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { DueText, PriorityBadge, StatusActions, TaskFormDialog, TaskStatusBadge } from '@/components/devteam/parts';
import { fmtRelative } from '@/lib/format';

type StatusTab = 'open' | DevTaskDisplayStatus | 'all';
const KEYS = ['status', 'assignee', 'priority', 'kind', 'site', 'q'] as const;
const TABS: { value: StatusTab; label: string }[] = [
  { value: 'open', label: 'Open' }, { value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In progress' }, { value: 'overdue', label: 'Overdue' }, { value: 'completed', label: 'Completed' }, { value: 'all', label: 'All' },
];

/** All Development Team tasks (Admin) — or, with `mine`, the signed-in member's own tasks. */
export function TaskList({ mine }: { mine?: boolean }) {
  const { can } = useAuth();
  const me = useUser();
  const manager = can('devteam.manage');
  const f = useUrlFilters(KEYS);
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const status = (f.get('status') || 'open') as StatusTab;
  const filter: DevTaskFilter = { status: status === 'all' ? 'all' : status, assigneeId: mine ? me.id : f.get('assignee') || undefined, priority: (f.get('priority') || undefined) as DevTaskPriority | undefined, kind: (f.get('kind') || undefined) as DevTaskKind | undefined, websiteId: f.get('site') || undefined };
  // Counts per tab come from the unfiltered-by-status list.
  const all = useApiQuery(['dev-team', 'tasks', mine ? 'mine' : 'all', filter.assigneeId ?? '', filter.priority ?? '', filter.kind ?? '', filter.websiteId ?? ''], () => api.listDevTasks({ ...filter, status: 'all' }));
  const members = useApiQuery(['dev-team', 'members'], () => api.listDevTeamMembers(), { enabled: manager && !mine });
  const sites = useApiQuery(['dev-team', 'websites'], () => api.listDevTeamWebsites(), { enabled: !mine });
  const count = (t: StatusTab, list: DevTaskView[]) => list.filter((x) => (t === 'all' ? true : t === 'open' ? x.status !== 'completed' : x.displayStatus === t)).length;
  const columns: Column<DevTaskView>[] = [
    { key: 'task', header: 'Task', sort: (a, b) => a.id.localeCompare(b.id), cell: (t) => (
      <div className="min-w-[220px]">
        <div className="font-medium text-ink">{t.title}</div>
        <div className="text-xs text-muted"><span className="font-mono">{t.id}</span> · {DEV_TASK_KIND_LABELS[t.kind]}{t.websiteName ? ` · ${t.websiteName}` : ''}{t.comments.length ? ` · ${t.comments.length} comment${t.comments.length === 1 ? '' : 's'}` : ''}</div>
      </div>
    ) },
    { key: 'status', header: 'Status', cell: (t) => <TaskStatusBadge s={t.displayStatus} />, sort: (a, b) => a.displayStatus.localeCompare(b.displayStatus) },
    { key: 'priority', header: 'Priority', cell: (t) => <PriorityBadge p={t.priority} />, sort: (a, b) => DEV_TASK_PRIORITIES.indexOf(a.priority) - DEV_TASK_PRIORITIES.indexOf(b.priority) },
    { key: 'due', header: 'Due', cell: (t) => <span className="whitespace-nowrap text-xs"><DueText t={t} /></span>, sort: (a, b) => a.dueDate.localeCompare(b.dueDate) },
    ...(!mine ? [{ key: 'who', header: 'Assigned to', cell: (t: DevTaskView) => <span className="text-sm">{t.assigneeName ?? <span className="text-muted">Unassigned</span>}</span>, sort: (a: DevTaskView, b: DevTaskView) => (a.assigneeName ?? '').localeCompare(b.assigneeName ?? '') }] : []),
    { key: 'updated', header: 'Updated', hideOnMobile: true, cell: (t) => <span className="text-xs text-muted">{fmtRelative(t.updatedAt)}</span>, sort: (a, b) => a.updatedAt.localeCompare(b.updatedAt) },
    ...((mine || !manager) ? [{ key: 'act', header: <span className="sr-only">Status</span>, cell: (t: DevTaskView) => <div onClick={(e) => e.stopPropagation()}><StatusActions t={t} /></div> }] : []),
  ];
  return (
    <div>
      <PageHeader
        title={mine ? 'My tasks' : 'Tasks'}
        description={mine ? 'Tasks assigned to you. Start a task when you begin and mark it completed when it is done — the Admin is notified.' : 'SEO issues and development work assigned to the team, across every website.'}
        actions={manager && !mine ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New task</Button> : undefined}
      />
      <Async q={all} rows={8}>
        {(list) => {
          const rows = list.filter((x) => (status === 'all' ? true : status === 'open' ? x.status !== 'completed' : x.displayStatus === status))
            .filter((x) => !f.get('q') || `${x.id} ${x.title} ${x.description}`.toLowerCase().includes(f.get('q').toLowerCase()));
          return (
            <div className="space-y-4">
              <Tabs<StatusTab> value={status} onChange={(v) => f.set('status', v === 'open' ? '' : v)} items={TABS.map((t) => ({ ...t, count: count(t.value, list) }))} />
              <Panel bodyClassName="p-0">
                <DataTable
                  rows={rows} columns={columns} rowKey={(t) => t.id} onRowClick={(t) => nav(`/dev-team/tasks/${t.id}`)} search={(t) => `${t.id} ${t.title} ${t.description} ${t.url ?? ''}`}
                  searchPlaceholder="Search tasks" rowClassName={(t) => (t.overdue ? 'bg-crit-tint/30' : undefined)}
                  toolbar={!mine ? (
                    <div className="flex flex-wrap items-center gap-3">
                      {manager && <FilterSelect label="Assigned to" value={f.get('assignee')} onChange={(v) => f.set('assignee', v)} options={[{ value: 'unassigned', label: 'Unassigned' }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.name }))]} />}
                      <FilterSelect label="Priority" value={f.get('priority')} onChange={(v) => f.set('priority', v)} options={DEV_TASK_PRIORITIES.map((p) => ({ value: p, label: DEV_TASK_PRIORITY_LABELS[p] }))} />
                      <FilterSelect label="Type" value={f.get('kind')} onChange={(v) => f.set('kind', v)} options={(Object.keys(DEV_TASK_KIND_LABELS) as DevTaskKind[]).map((k) => ({ value: k, label: DEV_TASK_KIND_LABELS[k] }))} />
                      {(sites.data?.length ?? 0) > 1 && <FilterSelect label="Website" value={f.get('site')} onChange={(v) => f.set('site', v)} options={(sites.data ?? []).map((w) => ({ value: w.id, label: w.name }))} />}
                      <ClearFilters show={f.active} onClear={f.clear} />
                    </div>
                  ) : undefined}
                  empty={<EmptyState title={mine ? 'No tasks for you here' : 'No tasks match'} description={mine ? 'Tasks the Admin assigns to you appear here, and you get a notification for each.' : status === 'open' ? 'Create a task to assign work to the team.' : 'Try another status or clear the filters.'} />}
                />
              </Panel>
            </div>
          );
        }}
      </Async>
      {manager && !mine && <TaskFormDialog open={creating} onClose={() => setCreating(false)} members={members.data ?? []} onSaved={(t) => nav(`/dev-team/tasks/${t.id}`)} />}
    </div>
  );
}

export default function DevTasksPage() { return <TaskList />; }
