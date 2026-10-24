import { ArrowRight, Bot } from 'lucide-react';
import { TEAMS, type AllocationEvent } from '@sentinel/shared';
import { fmtDateTime } from '@/lib/format';

/** Who allocated the issue → which team → when (read-only history; allocation happens through the API and automatic rules). */
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
