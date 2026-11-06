import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import type { TeamReminder, TeamReminderKind } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { Async, Badge, Button, Field, PageHeader, Panel, Select, Textarea, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterSelect } from '@/components/ui/filters';
import { fmtDateTime, fmtRelative } from '@/lib/format';

const KIND: Record<TeamReminderKind, { label: string; tone: Tone }> = {
  manual: { label: 'Sent by hand', tone: 'signal' }, due_soon: { label: 'Due soon (automatic)', tone: 'med' }, overdue: { label: 'Overdue (automatic)', tone: 'crit' }, assignment: { label: 'Assignment', tone: 'neutral' },
};

/** Development team → Reminders: send a reminder to one member or the whole team, and every reminder sent so far. */
export default function RemindersPage() {
  const q = useApiQuery(['dev-team', 'reminders'], () => api.listTeamReminders());
  const members = useApiQuery(['dev-team', 'members'], () => api.listDevTeamMembers());
  const tasks = useApiQuery(['dev-team', 'tasks', 'open-for-reminders'], () => api.listDevTasks({ status: 'open' }));
  const [to, setTo] = useState('all');
  const [taskId, setTaskId] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState('');
  const send = useApiMutation(() => api.sendTeamReminder({ to, message: text.trim(), taskId: taskId || undefined }), {
    success: (r) => `Reminder sent to ${r.recipientNames.length > 1 ? `${r.recipientNames.length} members` : r.recipientNames[0]}`, invalidate: [['dev-team'], ['notifications']], onSuccess: () => { setText(''); setTaskId(''); },
  });
  const active = (members.data ?? []).filter((m) => m.status !== 'suspended');
  const columns: Column<TeamReminder>[] = [
    { key: 'at', header: 'When', sort: (a, b) => a.at.localeCompare(b.at), cell: (r) => <span className="whitespace-nowrap text-xs" title={`${fmtDateTime(r.at)} IST`}>{fmtRelative(r.at)}</span> },
    { key: 'kind', header: 'Kind', cell: (r) => <Badge tone={KIND[r.kind].tone}>{KIND[r.kind].label}</Badge> },
    { key: 'to', header: 'To', cell: (r) => <span className="text-sm">{r.recipientNames.length > 3 ? `${r.recipientNames.length} members` : r.recipientNames.join(', ')}</span> },
    { key: 'msg', header: 'Message', cell: (r) => <div className="max-w-[28rem]"><p className="text-sm">{r.message}</p>{r.taskId && <Link to={`/dev-team/tasks/${r.taskId}`} className="text-xs text-signal hover:underline">{r.taskId}{r.taskTitle ? ` — ${r.taskTitle}` : ''}</Link>}</div> },
    { key: 'by', header: 'From', hideOnMobile: true, cell: (r) => <span className="text-xs text-muted">{r.sentByName}</span> },
  ];
  return (
    <div>
      <PageHeader title="Reminders" description="Members get an in-app notification for each reminder. Sentinel also reminds the assignee automatically a day before a task is due and every day while it is overdue." />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Send a reminder">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (text.trim().length >= 3) send.mutate(); }}>
            <Field label="To" htmlFor="r-to"><Select id="r-to" value={to} onChange={(e) => setTo(e.target.value)} className="w-full"><option value="all">The whole team ({active.length})</option>{active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
            <Field label="About a task (optional)" htmlFor="r-task"><Select id="r-task" value={taskId} onChange={(e) => setTaskId(e.target.value)} className="w-full"><option value="">No specific task</option>{(tasks.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.id} — {t.title}</option>)}</Select></Field>
            <Field label="Message" htmlFor="r-msg" required><Textarea id="r-msg" rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="e.g. Please update the status of your open tasks before Friday's review." /></Field>
            <Button type="submit" variant="primary" icon={<Bell className="h-4 w-4" />} disabled={text.trim().length < 3} loading={send.isPending}>Send reminder</Button>
          </form>
        </Panel>
        <div className="xl:col-span-2">
          <Async q={q} rows={8}>
            {(list) => (
              <Panel title="History" subtitle={`${list.length} reminder${list.length === 1 ? '' : 's'}`} bodyClassName="p-0">
                <DataTable rows={list.filter((r) => !kind || r.kind === kind)} columns={columns} rowKey={(r) => r.id} search={(r) => `${r.message} ${r.recipientNames.join(' ')} ${r.taskTitle ?? ''}`} searchPlaceholder="Search reminders"
                  toolbar={<FilterSelect label="Kind" value={kind} onChange={setKind} options={(Object.keys(KIND) as TeamReminderKind[]).map((k) => ({ value: k, label: KIND[k].label }))} />}
                  empty={<p className="px-4 py-6 text-center text-sm text-muted">No reminders yet.</p>} />
              </Panel>
            )}
          </Async>
        </div>
      </div>
    </div>
  );
}
