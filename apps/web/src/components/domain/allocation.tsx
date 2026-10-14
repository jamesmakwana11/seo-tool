import { useState } from 'react';
import clsx from 'clsx';
import { ArrowRight, Bot, Star } from 'lucide-react';
import { TEAMS, TEAM_IDS, type AllocationEvent, type Issue, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDialog } from '@/components/ui/overlay';
import { fmtDateTime } from '@/lib/format';

/**
 * One-tap allocation (PDF §11.1a): three buttons, the engine-suggested team pre-highlighted.
 * One tap on the suggestion confirms; tapping another team overrides (asks for an optional reason).
 * Template-level groups allocate every child page in one tap.
 */
export function AllocationButtons({ issue, compact, onDone }: { issue: Pick<Issue, 'id' | 'recommendedTeam' | 'allocatedTeam' | 'status' | 'isTemplateGroup' | 'groupId' | 'childIssueIds' | 'title'>; compact?: boolean; onDone?: () => void }) {
  const { can } = useAuth();
  const [pending, setPending] = useState<TeamId | null>(null);
  const m = useApiMutation((v: { team: TeamId; reason?: string }) => (issue.isTemplateGroup && issue.groupId ? api.bulkAllocate(issue.groupId, v.team, v.reason) : api.allocateIssue(issue.id, v.team, v.reason)), {
    success: (r) => `Allocated to ${TEAMS[r.issue.allocatedTeam!].name}${issue.isTemplateGroup ? ` — ${issue.childIssueIds?.length ?? 0} child pages included` : ''}.`,
    invalidate: [['issues'], ['issue'], ['dashboard'], ['digest'], ['allocations'], ['notifications'], ['groups'], ['module']],
    onSuccess: () => { setPending(null); onDone?.(); },
  });
  const closed = ['NOT_AN_ISSUE', 'SUPERSEDED', 'CLOSED', 'VERIFIED'].includes(issue.status);
  const allowed = can('issues.allocate') && !closed;
  const tap = (t: TeamId) => {
    if (t === issue.allocatedTeam) return;
    if (t === issue.recommendedTeam && !issue.allocatedTeam) m.mutate({ team: t });
    else setPending(t);
  };
  return (
    <div>
      <div className={clsx('flex flex-wrap gap-1.5', compact && 'gap-1')} role="group" aria-label={`Allocate ${issue.id}`}>
        {TEAM_IDS.map((t) => {
          const rec = t === issue.recommendedTeam;
          const current = t === issue.allocatedTeam;
          return (
            <button
              key={t}
              type="button"
              disabled={!allowed || current || m.isPending}
              onClick={() => tap(t)}
              title={!can('issues.allocate') ? 'Your role cannot allocate issues' : closed ? `Issue is ${issue.status}` : rec ? 'Engine-suggested team' : undefined}
              className={clsx(
                'inline-flex items-center gap-1 rounded-ctl border font-medium transition-colors disabled:cursor-not-allowed',
                compact ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-[13px]',
                current ? 'border-signal/50 bg-signal-tint text-signal-dark font-medium' : rec ? 'border-signal bg-signal-tint text-signal-dark hover:bg-signal/15 disabled:opacity-60' : 'border-line-strong bg-surface text-ink hover:bg-raised disabled:opacity-50',
              )}
            >
              {rec && !current && <Star className="h-3 w-3 fill-current" aria-label="Suggested" />}
              {compact ? `Fix with ${TEAMS[t].shortName}` : `Fix with ${TEAMS[t].name}`}
              {current && <span className="text-2xs font-normal text-signal/70">· allocated</span>}
            </button>
          );
        })}
      </div>
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? (issue.allocatedTeam ? `Reallocate to ${TEAMS[pending].name}?` : `Override suggestion: ${TEAMS[pending].name}?`) : ''}
        body={pending && (
          <>
            {issue.allocatedTeam ? <>The issue moves from <strong>{TEAMS[issue.allocatedTeam].name}</strong> to <strong>{TEAMS[pending].name}</strong> and both teams are notified.</> : <>The engine suggested <strong>{TEAMS[issue.recommendedTeam].name}</strong>. Your choice is recorded in the allocation trail.</>}
            {issue.isTemplateGroup && <> All {issue.childIssueIds?.length ?? 0} child issues move with it.</>}
          </>
        )}
        confirmLabel={pending ? `Fix with ${TEAMS[pending].name}` : 'Confirm'}
        reason="optional"
        reasonLabel="Reason (optional, shown in the trail)"
        loading={m.isPending}
        onConfirm={(reason) => pending && m.mutate({ team: pending, reason: reason || undefined })}
      />
    </div>
  );
}

export function AllocationTrail({ events }: { events: AllocationEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted">Not allocated yet.</p>;
  return (
    <ol className="space-y-2">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
          {e.automatic ? <Bot className="h-3.5 w-3.5 text-med-ink" aria-label="Automatic" /> : null}
          <span className="font-medium text-ink">{e.allocatedByName}</span>
          <ArrowRight className="h-3 w-3 text-faint" aria-hidden />
          {e.fromTeam && <><span className="text-muted line-through decoration-faint">{TEAMS[e.fromTeam].shortName}</span><ArrowRight className="h-3 w-3 text-faint" aria-hidden /></>}
          <span className="font-medium text-ink">{TEAMS[e.toTeam].name}</span>
          <span className="text-xs text-muted">· {fmtDateTime(e.at)} IST</span>
          {e.automatic && <span className="text-xs text-med-ink">· auto (Critical unallocated &gt;24h)</span>}
          {e.bulkGroupId && <span className="text-xs text-muted">· bulk {e.bulkGroupId}</span>}
          {e.reason && <span className="w-full pl-0 text-xs text-muted">“{e.reason}”</span>}
        </li>
      ))}
    </ol>
  );
}
