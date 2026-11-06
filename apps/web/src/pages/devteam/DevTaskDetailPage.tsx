import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Bell, ExternalLink, Pencil, Send, Trash2 } from 'lucide-react';
import { DEV_TASK_KIND_LABELS } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth, useUser } from '@/auth/AuthContext';
import { Async, Button, Field, KV, PageHeader, Panel, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { DueText, PriorityBadge, StatusActions, TaskFormDialog, TaskStatusBadge, taskInvalidate } from '@/components/devteam/parts';
import { ReminderDialog } from './DevTeamPage';
import { fmtDateTime, fmtRelative } from '@/lib/format';

/** One Development Team task: status, details, comments and history. */
export default function DevTaskDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const me = useUser();
  const manager = can('devteam.manage');
  const nav = useNavigate();
  const q = useApiQuery(['dev-team', 'task', id], () => api.getDevTask(id));
  const members = useApiQuery(['dev-team', 'members'], () => api.listDevTeamMembers(), { enabled: manager });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [remind, setRemind] = useState(false);
  const [comment, setComment] = useState('');
  const post = useApiMutation(() => api.commentDevTask(id, comment.trim()), { success: 'Comment added', invalidate: taskInvalidate, onSuccess: () => setComment('') });
  const del = useApiMutation(() => api.deleteDevTask(id), { success: `${id} deleted`, invalidate: taskInvalidate, onSuccess: () => nav('/dev-team/tasks') });
  return (
    <div>
      <Link to={manager ? '/dev-team/tasks' : '/dev-team/my-tasks'} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-signal"><ArrowLeft className="h-4 w-4" /> {manager ? 'Tasks' : 'My tasks'}</Link>
      <Async q={q} rows={8}>
        {(t) => {
          const assignee = members.data?.find((m) => m.id === t.assigneeId);
          const mayChangeStatus = manager || t.assigneeId === me.id;
          return (
            <div className="space-y-5">
              <PageHeader
                title={t.title}
                meta={<div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted">{t.id}</span><TaskStatusBadge s={t.displayStatus} /><PriorityBadge p={t.priority} /><span className="text-xs text-muted">{DEV_TASK_KIND_LABELS[t.kind]}</span></div>}
                actions={manager ? (
                  <div className="flex flex-wrap gap-2">
                    <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>
                    {assignee && t.status !== 'completed' && <Button icon={<Bell className="h-4 w-4" />} onClick={() => setRemind(true)}>Send reminder</Button>}
                    <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(true)}>Delete</Button>
                  </div>
                ) : undefined}
              />
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
                <div className="space-y-5 xl:col-span-2">
                  <Panel title="Details">
                    <div className="space-y-4">
                      {t.description ? <p className="whitespace-pre-wrap text-sm text-ink">{t.description}</p> : <p className="text-sm text-muted">No description.</p>}
                      {mayChangeStatus && <StatusActions t={t} size="md" />}
                    </div>
                  </Panel>
                  <Panel title="Comments" subtitle={`${t.comments.length}`}>
                    <div className="space-y-4">
                      {t.comments.length ? (
                        <ul className="space-y-3">
                          {t.comments.map((c) => (
                            <li key={c.id} className="rounded-ctl border border-line px-3 py-2">
                              <div className="text-xs text-muted"><span className="font-medium text-ink">{c.authorName}</span> · <time dateTime={c.at} title={`${fmtDateTime(c.at)} IST`}>{fmtRelative(c.at)}</time></div>
                              <p className="mt-1 whitespace-pre-wrap text-sm">{c.text}</p>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="text-sm text-muted">No comments yet.</p>}
                      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) post.mutate(); }}>
                        <Field label="Add a comment" htmlFor="c-text"><Textarea id="c-text" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="Progress, a question, or what was changed" /></Field>
                        <Button type="submit" size="sm" icon={<Send className="h-3.5 w-3.5" />} disabled={!comment.trim()} loading={post.isPending}>Comment</Button>
                      </form>
                    </div>
                  </Panel>
                </div>
                <div className="space-y-5">
                  <Panel title="About">
                    <KV cols={1} items={[
                      { k: 'Assigned to', v: t.assigneeName ?? <span className="text-muted">Unassigned</span> },
                      { k: 'Due', v: <DueText t={t} /> },
                      ...(t.websiteName ? [{ k: 'Website', v: t.websiteName }] : []),
                      ...(t.issueId ? [{ k: 'SEO issue', v: <Link to={`/issues/${t.issueId}`} className="text-signal hover:underline">{t.issueId}{t.issueTitle ? ` — ${t.issueTitle}` : ''}</Link> }] : []),
                      ...(t.url ? [{ k: 'Page', v: <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-signal hover:underline">{t.url}<ExternalLink className="h-3 w-3 shrink-0" /></a> }] : []),
                      { k: 'Created', v: `${fmtDateTime(t.createdAt)} IST by ${t.createdByName}` },
                      ...(t.startedAt ? [{ k: 'Started', v: `${fmtDateTime(t.startedAt)} IST` }] : []),
                      ...(t.completedAt ? [{ k: 'Completed', v: `${fmtDateTime(t.completedAt)} IST` }] : []),
                    ]} />
                  </Panel>
                  <Panel title="History">
                    <ol className="space-y-2 text-sm">
                      {[...t.history].reverse().map((h, i) => (
                        <li key={i} className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" aria-hidden /><span><span className="text-ink">{h.message}</span><span className="block text-xs text-muted">{h.actorName} · {fmtRelative(h.at)}</span></span></li>
                      ))}
                    </ol>
                  </Panel>
                </div>
              </div>
              {manager && <TaskFormDialog open={editing} onClose={() => setEditing(false)} task={t} members={members.data ?? []} />}
              <ReminderDialog member={remind && assignee ? assignee : null} task={t} onClose={() => setRemind(false)} />
              <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} onConfirm={() => del.mutate()} loading={del.isPending} danger confirmLabel="Delete task" title={`Delete ${t.id}?`} body="The task, its comments and history are removed. This cannot be undone." />
            </div>
          );
        }}
      </Async>
    </div>
  );
}
