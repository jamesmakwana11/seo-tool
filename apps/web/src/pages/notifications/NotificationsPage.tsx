import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { AlarmClock, AtSign, BellRing, CheckCheck, ClipboardCheck, Eye, FileText, Info, ShieldCheck, TrendingUp, UserPlus, type LucideIcon } from 'lucide-react';
import type { DeliveryAttempt, Notification } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, DemoBadge, EmptyState, Notice, PageHeader, Panel, Stat, Tabs, type Tone } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { FilterSelect } from '@/components/ui/filters';
import { SeverityBadge } from '@/components/domain/badges';
import { fmtDateTime, fmtRelative } from '@/lib/format';

type NType = Notification['type'];
const TYPE: Record<NType, { label: string; icon: LucideIcon }> = {
  alert: { label: 'Critical alert', icon: BellRing },
  assignment: { label: 'Assignment', icon: UserPlus },
  sla: { label: 'SLA', icon: AlarmClock },
  review: { label: 'Review', icon: ClipboardCheck },
  verification: { label: 'Verification', icon: ShieldCheck },
  mention: { label: 'Mention', icon: AtSign },
  digest: { label: 'Digest', icon: FileText },
  escalation: { label: 'Escalation', icon: TrendingUp },
  system: { label: 'System', icon: Info },
};

type Tab = 'inbox' | 'deliveries';

export default function NotificationsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('inbox');
  const canDeliveries = can('reports.view');
  return (
    <div>
      <PageHeader
        title="Notifications"
        description="In-app notifications for you: Critical alerts, assignments, reviews, SLA warnings and digests (PDF §12.1–12.2)."
        meta={<DemoBadge />}
        actions={can('notifications.configure') ? <Link to="/settings/notifications" className="inline-flex h-9 items-center rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark">Alert settings</Link> : undefined}
      />
      {canDeliveries && (
        <Tabs<Tab> className="mb-5" value={tab} onChange={setTab} items={[{ value: 'inbox', label: 'Inbox' }, { value: 'deliveries', label: 'Delivery log' }]} />
      )}
      {tab === 'inbox' || !canDeliveries ? <Inbox /> : <Deliveries />}
    </div>
  );
}

// ------------------------------------------------------------------ inbox

function Inbox() {
  const nav = useNavigate();
  const q = useApiQuery(['notifications'], () => api.listNotifications());
  const [show, setShow] = useState<'all' | 'unread'>('all');
  const [type, setType] = useState('');
  const markAll = useApiMutation(() => api.markNotificationRead('all'), { success: 'All notifications marked read', invalidate: [['notifications']] });
  const markOne = useApiMutation((id: string) => api.markNotificationRead(id), { success: 'Marked read', invalidate: [['notifications']] });
  // Opening a notification marks it read quietly (no toast — the user is navigating away).
  const markOpened = useApiMutation((id: string) => api.markNotificationRead(id), { invalidate: [['notifications']] });

  return (
    <Async q={q} rows={8}>
      {(list) => {
        const unread = list.filter((n) => !n.readAt).length;
        const types = [...new Set(list.map((n) => n.type))];
        const rows = list.filter((n) => (show === 'all' || !n.readAt) && (!type || n.type === type));
        const open = (n: Notification) => {
          if (!n.readAt) markOpened.mutate(n.id);
          if (n.link) nav(n.link);
        };
        return (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Unread" value={unread} tone={unread ? 'signal' : undefined} />
              <Stat label="Critical alerts" value={list.filter((n) => n.type === 'alert').length} tone={list.some((n) => n.type === 'alert' && !n.readAt) ? 'crit' : undefined} />
              <Stat label="Assignments" value={list.filter((n) => n.type === 'assignment').length} />
              <Stat label="Total" value={list.length} />
            </div>
            <Panel
              bodyClassName="p-0"
              title="Inbox"
              actions={<Button size="sm" icon={<CheckCheck className="h-4 w-4" />} disabled={!unread} loading={markAll.isPending} onClick={() => markAll.mutate()}>Mark all read</Button>}
            >
              <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
                <div className="flex gap-1" role="group" aria-label="Show">
                  {(['all', 'unread'] as const).map((s) => (
                    <button key={s} type="button" aria-pressed={show === s} onClick={() => setShow(s)} className={clsx('h-7 rounded-full border px-2.5 text-xs', show === s ? 'border-signal/50 bg-signal-tint text-signal-dark font-medium' : 'border-line-strong bg-surface text-ink-soft hover:border-muted/50')}>
                      {s === 'all' ? `All ${list.length}` : `Unread ${unread}`}
                    </button>
                  ))}
                </div>
                <FilterSelect label="Type" value={type} onChange={setType} options={types.map((t) => ({ value: t, label: TYPE[t].label }))} />
              </div>
              {rows.length ? (
                <ul className="divide-y divide-line">
                  {rows.map((n) => {
                    const Icon = TYPE[n.type].icon;
                    return (
                      <li key={n.id} className={clsx('flex items-start gap-3 px-4 py-3', !n.readAt && 'bg-signal-tint/40')}>
                        <span className={clsx('mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full', n.type === 'alert' || n.severity === 'critical' ? 'bg-crit-tint text-crit-ink' : 'bg-raised text-muted')} aria-hidden>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            {!n.readAt && <span className="h-2 w-2 rounded-full bg-signal" role="img" aria-label="Unread" />}
                            {n.link ? (
                              <button type="button" onClick={() => open(n)} className={clsx('text-left text-sm hover:text-signal hover:underline', !n.readAt ? 'font-semibold text-ink' : 'text-ink')}>{n.title}</button>
                            ) : <span className={clsx('text-sm', !n.readAt ? 'font-semibold' : '')}>{n.title}</span>}
                          </div>
                          <p className="mt-0.5 text-sm text-ink-soft">{n.body}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span>{TYPE[n.type].label}</span>
                            {n.severity && <SeverityBadge severity={n.severity} />}
                            <time dateTime={n.createdAt} title={`${fmtDateTime(n.createdAt)} IST`}>{fmtRelative(n.createdAt)}</time>
                            {n.readAt && <span>· read {fmtRelative(n.readAt)}</span>}
                          </div>
                        </div>
                        {!n.readAt && (
                          <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} disabled={markOne.isPending && markOne.variables === n.id} onClick={() => markOne.mutate(n.id)} aria-label={`Mark "${n.title}" read`}>
                            <span className="hidden sm:inline">Mark read</span>
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState title={show === 'unread' ? 'You’re all caught up' : 'No notifications'} description={show === 'unread' || type ? 'Nothing matches these filters. Switch to All to see read notifications.' : 'Alerts, assignments and review requests for you will appear here.'} />
              )}
            </Panel>
          </div>
        );
      }}
    </Async>
  );
}

// ------------------------------------------------------------------ delivery log

const OUTCOME: Record<DeliveryAttempt['outcome'], { label: string; tone: Tone }> = {
  delivered: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'crit' },
  skipped_not_configured: { label: 'Skipped — not configured', tone: 'neutral' },
  retrying: { label: 'Retrying', tone: 'med' },
};
const CHANNEL: Record<DeliveryAttempt['channel'], string> = { email: 'Email', whatsapp: 'WhatsApp', slack: 'Slack' };
const KIND: Record<DeliveryAttempt['kind'], string> = {
  realtime_alert: 'Real-time alert', daily_digest: 'Daily digest', weekly_report: 'Weekly report', monthly_report: 'Monthly report', allocation: 'Allocation', escalation: 'Escalation', task_sync: 'Task Ops sync',
};

function Deliveries() {
  const { can } = useAuth();
  const q = useApiQuery(['notifications', 'deliveries'], () => api.listDeliveries());
  const [outcome, setOutcome] = useState('');
  const [channel, setChannel] = useState('');
  return (
    <Async q={q} rows={8}>
      {(list) => {
        const skipped = list.filter((d) => d.outcome === 'skipped_not_configured').length;
        const delivered = list.filter((d) => d.outcome === 'delivered').length;
        const rows = list.filter((d) => (!outcome || d.outcome === outcome) && (!channel || d.channel === channel));
        return (
          <div className="space-y-5">
            {skipped > 0 && (
              <Notice tone="demo" title={`${skipped} of ${list.length} external deliveries were skipped — channel not configured`}>
                Email, WhatsApp and Slack need credentials on the API server (for example <span className="font-mono">SMTP_HOST</span>, <span className="font-mono">WHATSAPP_API_TOKEN</span>, <span className="font-mono">SLACK_WEBHOOK_URL</span>). Until then, alerts reach people in-app only.{' '}
                {can('integrations.view') && <Link to="/settings/integrations" className="font-medium underline">Integrations</Link>}
              </Notice>
            )}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Delivered" value={delivered} tone={delivered ? 'ok' : undefined} />
              <Stat label="Skipped — not configured" value={skipped} />
              <Stat label="Failed" value={list.filter((d) => d.outcome === 'failed').length} tone={list.some((d) => d.outcome === 'failed') ? 'crit' : undefined} />
              <Stat label="Retrying" value={list.filter((d) => d.outcome === 'retrying').length} />
            </div>
            <Panel title="Delivery log" subtitle="Every external send attempt, newest first" bodyClassName="p-3">
              <DataTable
                rows={rows}
                rowKey={(d) => d.id}
                search={(d) => `${d.subject} ${d.error ?? ''} ${d.issueId ?? ''}`}
                searchPlaceholder="Search subject or error"
                caption="Delivery attempts"
                initialSort={{ key: 'at', dir: 'desc' }}
                toolbar={
                  <>
                    <FilterSelect label="Outcome" value={outcome} onChange={setOutcome} options={(Object.keys(OUTCOME) as DeliveryAttempt['outcome'][]).map((o) => ({ value: o, label: OUTCOME[o].label }))} />
                    <FilterSelect label="Channel" value={channel} onChange={setChannel} options={(Object.keys(CHANNEL) as DeliveryAttempt['channel'][]).map((c) => ({ value: c, label: CHANNEL[c] }))} />
                  </>
                }
                empty={<EmptyState title={list.length ? 'No deliveries match these filters' : 'No delivery attempts yet'} description={list.length ? 'Clear the filters to see every attempt.' : 'Attempts are logged when alerts, digests or reports are sent.'} />}
                columns={[
                  { key: 'at', header: 'When (IST)', cell: (d) => <span className="whitespace-nowrap text-xs">{fmtDateTime(d.at)}</span>, sort: (a, b) => a.at.localeCompare(b.at) },
                  { key: 'channel', header: 'Channel', cell: (d) => <span className="text-xs">{CHANNEL[d.channel]}</span> },
                  { key: 'kind', header: 'Kind', hideOnMobile: true, cell: (d) => <span className="whitespace-nowrap text-xs">{KIND[d.kind]}</span> },
                  {
                    key: 'subject', header: 'Subject', cell: (d) => (
                      <div className="min-w-[200px]">
                        <div className="text-sm">{d.subject}</div>
                        <div className="flex gap-2 text-xs">
                          {d.issueId && <Link to={`/issues/${d.issueId}`} className="font-mono text-signal hover:underline">{d.issueId}</Link>}
                        </div>
                      </div>
                    ),
                  },
                  { key: 'outcome', header: 'Outcome', cell: (d) => <Badge tone={OUTCOME[d.outcome].tone}>{OUTCOME[d.outcome].label}</Badge> },
                  { key: 'error', header: 'Error / detail', cell: (d) => <span className="block min-w-[180px] text-xs text-muted">{d.error ?? (d.providerMessageId ? `Provider id ${d.providerMessageId}` : '—')}</span> },
                  { key: 'retry', header: 'Retryable', hideOnMobile: true, cell: (d) => <span className="text-xs">{d.retryable ? 'Yes' : 'No'}</span> },
                ]}
              />
            </Panel>
          </div>
        );
      }}
    </Async>
  );
}
