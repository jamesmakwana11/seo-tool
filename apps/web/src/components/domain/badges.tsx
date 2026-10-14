import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Clock } from 'lucide-react';
import {
  ISSUE_STATUS_LABELS, MODULE_LABELS, ROLE_LABELS, TEAMS, formatDuration,
  type AuditModule, type DataSource, type DeltaState, type IssueStatus, type PageTier, type Role, type Severity,
  type TaskPriority, type TeamId,
} from '@sentinel/shared';
import { Badge, DemoBadge, type Tone } from '@/components/ui/primitives';

const SEV_TONE: Record<Severity | 'opportunity', Tone> = { critical: 'crit', medium: 'med', low: 'low', opportunity: 'opp' };
const SEV_LABEL: Record<Severity | 'opportunity', string> = { critical: 'Critical', medium: 'Medium', low: 'Low', opportunity: 'Opportunity' };

export function SeverityBadge({ severity }: { severity: Severity | 'opportunity' }) {
  return (
    <Badge tone={SEV_TONE[severity]}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', severity === 'critical' ? 'bg-crit' : severity === 'medium' ? 'bg-med' : severity === 'low' ? 'bg-low' : 'bg-opp')} aria-hidden />
      {SEV_LABEL[severity]}
    </Badge>
  );
}

const ISSUE_TONE: Record<IssueStatus, Tone> = { NEW: 'neutral', ASSIGNED: 'signal', IN_PROGRESS: 'signal', FIXED: 'med', VERIFIED: 'ok', CLOSED: 'ok', NOT_AN_ISSUE: 'neutral', SUPERSEDED: 'neutral' };
export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  return <Badge tone={ISSUE_TONE[status]} title={status === 'FIXED' ? 'Marked fixed — awaiting system re-verification' : undefined}>{ISSUE_STATUS_LABELS[status]}</Badge>;
}

export function TeamBadge({ team, short }: { team?: TeamId; short?: boolean }) {
  if (!team) return <Badge tone="neutral">Unallocated</Badge>;
  return <Badge tone="dark" title={TEAMS[team].name}>{short ? TEAMS[team].shortName : TEAMS[team].name}</Badge>;
}

export function TierBadge({ tier }: { tier: PageTier }) {
  return (
    <span className={clsx('inline-flex items-center rounded-ctl border px-1.5 py-0.5 text-xs font-semibold tabular-nums', tier === 1 ? 'border-signal/50 bg-signal-tint text-signal-dark font-medium' : tier === 2 ? 'border-line-strong bg-surface text-ink' : 'border-line bg-canvas text-muted')} title={`Page-value Tier ${tier} (PDF §3.1)`}>
      T{tier}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={role === 'admin' ? 'opp' : role === 'developer' ? 'low' : 'signal'}>{ROLE_LABELS[role]}</Badge>;
}

export function PriorityBadge({ p }: { p: TaskPriority }) {
  return <Badge tone={p === 'P1' ? 'crit' : p === 'P2' ? 'med' : 'neutral'}>{p}</Badge>;
}

export function ModuleBadge({ module }: { module: AuditModule }) {
  return <span className="text-xs text-muted">{MODULE_LABELS[module]}</span>;
}

const DELTA: Record<DeltaState, { label: string; tone: Tone }> = {
  new: { label: 'New today', tone: 'crit' }, recurring: { label: 'Recurring', tone: 'med' }, worsening: { label: 'Worsening', tone: 'crit' },
  unchanged: { label: 'Unchanged', tone: 'neutral' }, improving: { label: 'Improving', tone: 'ok' }, resolved: { label: 'Resolved', tone: 'ok' },
};
export function DeltaBadge({ delta }: { delta: DeltaState }) {
  return <Badge tone={DELTA[delta].tone}>{DELTA[delta].label}</Badge>;
}

export function SourceBadge({ source }: { source: DataSource }) {
  if (source === 'demo') return <DemoBadge />;
  if (source === 'simulated') return <DemoBadge label="SIMULATED" title="Produced by a simulated run — no real crawl or API call happened." />;
  if (source === 'manual') return <Badge tone="neutral">Manual</Badge>;
  return <Badge tone="ok">Live</Badge>;
}

/** Live SLA countdown (re-renders every 30s). */
export function SlaCountdown({ dueAt, done, compact }: { dueAt: string; done?: boolean; compact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [done]);
  const ms = new Date(dueAt).getTime() - now;
  const breached = !done && ms < 0;
  const atRisk = !done && !breached && ms < 48 * 3600000;
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap text-xs tabular-nums', done ? 'text-muted' : breached ? 'font-semibold text-crit-ink' : atRisk ? 'font-medium text-med-ink' : 'text-ink-soft')} title={`SLA due ${new Date(dueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`}>
      {!compact && <Clock className="h-3 w-3" aria-hidden />}
      {done ? 'Done' : breached ? `SLA breached · ${formatDuration(ms).replace(' overdue', '')} over` : formatDuration(ms)}
    </span>
  );
}
