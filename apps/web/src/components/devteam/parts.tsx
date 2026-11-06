import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Play, RotateCcw } from 'lucide-react';
import {
  DEV_TASK_KIND_LABELS, DEV_TASK_PRIORITIES, DEV_TASK_PRIORITY_LABELS, DEV_TASK_STATUS_LABELS,
  type DevTaskDisplayStatus, type DevTaskInput, type DevTaskKind, type DevTaskPriority, type DevTaskStatus, type DevTaskView, type DevTeamMember,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { Badge, Button, Field, Input, Notice, Select, Textarea, type Tone } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { fmtDate } from '@/lib/format';

const STATUS_TONE: Record<DevTaskDisplayStatus, Tone> = { pending: 'neutral', in_progress: 'signal', completed: 'ok', overdue: 'crit' };
const PRIORITY_TONE: Record<DevTaskPriority, Tone> = { urgent: 'crit', high: 'med', medium: 'low', low: 'neutral' };

export function TaskStatusBadge({ s }: { s: DevTaskDisplayStatus }) { return <Badge tone={STATUS_TONE[s]}>{DEV_TASK_STATUS_LABELS[s]}</Badge>; }
export function PriorityBadge({ p }: { p: DevTaskPriority }) { return <Badge tone={PRIORITY_TONE[p]}>{DEV_TASK_PRIORITY_LABELS[p]}</Badge>; }

/** “Due 12 Nov · in 3 days” / “2 days overdue”. */
export function DueText({ t }: { t: DevTaskView }) {
  const rel = t.status === 'completed' ? '' : t.overdue ? ` · ${Math.abs(t.daysLeft)} day${Math.abs(t.daysLeft) === 1 ? '' : 's'} overdue` : t.daysLeft === 0 ? ' · due today' : t.daysLeft === 1 ? ' · due tomorrow' : ` · in ${t.daysLeft} days`;
  return <span className={t.overdue ? 'text-crit-ink' : 'text-muted'}>{fmtDate(t.dueDate)}{rel}</span>;
}

export const taskInvalidate = [['dev-team'], ['notifications']];

/** Start / complete / reopen buttons for whoever may change the status. */
export function StatusActions({ t, size = 'sm' }: { t: DevTaskView; size?: 'sm' | 'md' }) {
  const m = useApiMutation((status: DevTaskStatus) => api.updateDevTask(t.id, { status }), { success: (r) => `${r.id}: ${DEV_TASK_STATUS_LABELS[r.displayStatus]}`, invalidate: taskInvalidate });
  return (
    <div className="flex flex-wrap gap-1.5">
      {t.status === 'pending' && <Button size={size} icon={<Play className="h-3.5 w-3.5" />} loading={m.isPending} onClick={() => m.mutate('in_progress')}>Start</Button>}
      {t.status !== 'completed' && <Button size={size} variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} loading={m.isPending} onClick={() => m.mutate('completed')}>Mark completed</Button>}
      {t.status === 'completed' && <Button size={size} variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={m.isPending} onClick={() => m.mutate('pending')}>Reopen</Button>}
    </div>
  );
}

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

/** Create or edit a task (Admin). Prefilled from an SEO issue when `preset` is given. */
export function TaskFormDialog({ open, onClose, task, preset, members, onSaved }: {
  open: boolean; onClose: () => void; task?: DevTaskView; preset?: Partial<DevTaskInput>; members: DevTeamMember[]; onSaved?: (t: DevTaskView) => void;
}) {
  const sites = useApiQuery(['dev-team', 'websites'], () => api.listDevTeamWebsites(), { enabled: open });
  const blank = (): DevTaskInput => ({ title: '', description: '', kind: 'development', priority: 'medium', dueDate: inDays(7), assigneeId: '', websiteId: '', url: '', ...preset });
  const [v, setV] = useState<DevTaskInput>(blank);
  useEffect(() => {
    if (!open) return;
    setV(task ? { title: task.title, description: task.description, kind: task.kind, priority: task.priority, dueDate: task.dueDate, assigneeId: task.assigneeId ?? '', websiteId: task.websiteId ?? '', url: task.url ?? '', issueId: task.issueId } : blank());
  }, [open, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<DevTaskInput>) => setV((x) => ({ ...x, ...p }));
  const body = { ...v, title: v.title.trim(), url: v.url?.trim() || undefined, websiteId: v.websiteId || undefined, issueId: v.issueId || undefined };
  const save = useApiMutation(() => (task ? api.updateDevTask(task.id, { ...body, assigneeId: v.assigneeId ?? '' }) : api.createDevTask({ ...body, assigneeId: v.assigneeId || undefined })), {
    success: (r) => (task ? `${r.id} saved` : `${r.id} created${r.assigneeName ? ` and assigned to ${r.assigneeName}` : ''}`), invalidate: taskInvalidate,
    onSuccess: (r) => { onSaved?.(r); onClose(); }, silentError: true,
  });
  const titleErr = v.title.trim().length > 0 && v.title.trim().length < 3 ? 'At least 3 characters.' : undefined;
  const active = members.filter((m) => m.status !== 'suspended');
  return (
    <Dialog open={open} onClose={onClose} title={task ? `Edit ${task.id}` : 'New task'} size="lg"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={v.title.trim().length < 3 || !v.dueDate} onClick={() => save.mutate()}>{task ? 'Save' : 'Create task'}</Button></>}>
      <form className="grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="sm:col-span-2"><Field label="Title" htmlFor="t-title" required error={titleErr}><Input id="t-title" data-autofocus value={v.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} placeholder="e.g. Fix duplicate H1 on product template" /></Field></div>
        <div className="sm:col-span-2"><Field label="Description" htmlFor="t-desc"><Textarea id="t-desc" rows={4} value={v.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} placeholder="What needs to be done, where, and how to check it." /></Field></div>
        <Field label="Type" htmlFor="t-kind"><Select id="t-kind" value={v.kind} onChange={(e) => set({ kind: e.target.value as DevTaskKind })} className="w-full">{(Object.keys(DEV_TASK_KIND_LABELS) as DevTaskKind[]).map((k) => <option key={k} value={k}>{DEV_TASK_KIND_LABELS[k]}</option>)}</Select></Field>
        <Field label="Priority" htmlFor="t-prio"><Select id="t-prio" value={v.priority} onChange={(e) => set({ priority: e.target.value as DevTaskPriority })} className="w-full">{DEV_TASK_PRIORITIES.map((p) => <option key={p} value={p}>{DEV_TASK_PRIORITY_LABELS[p]}</option>)}</Select></Field>
        <Field label="Assign to" htmlFor="t-assignee"><Select id="t-assignee" value={v.assigneeId ?? ''} onChange={(e) => set({ assigneeId: e.target.value })} className="w-full"><option value="">Unassigned</option>{active.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status === 'invited' ? ' (invited)' : ''}</option>)}</Select></Field>
        <Field label="Due date" htmlFor="t-due" required><Input id="t-due" type="date" min={task ? undefined : today()} value={v.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></Field>
        <Field label="Website" htmlFor="t-site"><Select id="t-site" value={v.websiteId ?? ''} onChange={(e) => set({ websiteId: e.target.value })} className="w-full"><option value="">Any / not specific</option>{(sites.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
        <Field label="Page address (optional)" htmlFor="t-url"><Input id="t-url" value={v.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" /></Field>
        {v.issueId && <div className="sm:col-span-2"><Notice>Linked to SEO issue <Link className="font-medium text-signal hover:underline" to={`/issues/${v.issueId}`}>{v.issueId}</Link>.</Notice></div>}
        {save.error && <div className="sm:col-span-2"><Notice tone="crit" title="Not saved">{errorMessage(save.error)}</Notice></div>}
      </form>
    </Dialog>
  );
}
