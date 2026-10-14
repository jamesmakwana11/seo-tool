import { Link } from 'react-router-dom';
import { AlertTriangle, CalendarDays } from 'lucide-react';
import type { FestivalEntry } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, DemoBadge, EmptyState, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { SiteUrl } from '@/components/opportunities/shared';
import { fmtDate } from '@/lib/format';

type Festival = FestivalEntry & { daysUntil: number; inWindow: boolean; collectionsToRefresh: string[] };

export default function SeasonalPage() {
  const { can } = useAuth();
  const q = useApiQuery(['opportunities', 'seasonal'], () => api.getSeasonalPlan());
  return (
    <div>
      <PageHeader
        title="Seasonal planner"
        description="India festival and season calendar, surfaced ahead of time so collections are refreshed and landing pages published before demand peaks — Diwali gifting, Rakhi, Holi, monsoon, wedding season, back-to-school (PDF §7.2, §13)."
        meta={<DemoBadge />}
        actions={can('settings.view') ? <Link to="/settings/thresholds" className="inline-flex h-9 items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark"><CalendarDays className="h-4 w-4" /> Edit festival dates</Link> : undefined}
      />
      <Async q={q} rows={10}>
        {(d) => <Body festivals={d.festivals} leadDays={d.leadDays} />}
      </Async>
    </div>
  );
}

function Body({ festivals, leadDays }: { festivals: Festival[]; leadDays: number }) {
  const upcoming = festivals.filter((f) => f.daysUntil >= 0);
  const past = festivals.filter((f) => f.daysUntil < 0);
  const inWindow = upcoming.filter((f) => f.inWindow);
  const unconfirmed = festivals.filter((f) => !f.dateConfirmed).length;
  return (
    <div className="space-y-5">
      <Notice tone="neutral">
        Festival and season dates are configured in <span className="font-medium">Settings → Thresholds</span>, along with the {leadDays}-day lead window. Lunar festivals move every year — dates marked “date to confirm” must be checked by the team before acting on them.
      </Notice>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={`Inside ${leadDays}-day window`} value={inWindow.length} tone={inWindow.length ? 'signal' : undefined} hint="Act now" />
        <Stat label="Upcoming" value={upcoming.length} />
        <Stat label="Dates to confirm" value={unconfirmed} tone={unconfirmed ? 'med' : 'ok'} />
        <Stat label="Next event" value={upcoming[0] ? `${upcoming[0].daysUntil}d` : '—'} hint={upcoming[0]?.name} />
      </div>

      {!upcoming.length ? (
        <Panel><EmptyState title="No upcoming festivals or seasons" description="Add next year's calendar in Settings → Thresholds." /></Panel>
      ) : (
        <Panel title="Timeline" subtitle={`Sorted by days until · highlighted entries are inside the ${leadDays}-day lead window`} bodyClassName="p-0">
          <ol className="divide-y divide-line">
            {upcoming.map((f) => <FestivalRow key={f.id} f={f} leadDays={leadDays} />)}
          </ol>
        </Panel>
      )}

      {past.length > 0 && (
        <Panel title="Recently passed" bodyClassName="p-0">
          <ul className="divide-y divide-line">
            {past.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm text-muted">
                <span className="font-medium text-ink-soft">{f.name}</span>
                <span>{fmtDate(`${f.date}T00:00:00+05:30`)} · {Math.abs(f.daysUntil)} days ago</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function FestivalRow({ f, leadDays }: { f: Festival; leadDays: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(((leadDays - f.daysUntil) / leadDays) * 100)));
  return (
    <li className={`flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start ${f.inWindow ? 'border-l-4 border-l-signal bg-signal-tint/40' : 'border-l-4 border-l-transparent'}`}>
      <div className="w-full shrink-0 lg:w-36">
        <p className="text-2xl font-semibold tabular-nums text-ink">{f.daysUntil}<span className="ml-1 text-sm font-normal text-muted">days</span></p>
        <p className="text-xs text-muted">{fmtDate(`${f.date}T00:00:00+05:30`)}</p>
        {f.inWindow && <div className="mt-1.5"><div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden><div className="h-full bg-signal" style={{ width: `${pct}%` }} /></div><p className="mt-0.5 text-2xs text-signal-dark">{pct}% of lead window used</p></div>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink">{f.name}</span>
          <Badge tone={f.kind === 'festival' ? 'opp' : 'low'}>{f.kind === 'festival' ? 'Festival' : 'Season'}</Badge>
          {f.inWindow && <Badge tone="signal">In {leadDays}-day window</Badge>}
          {!f.dateConfirmed && <Badge tone="med" icon={<AlertTriangle className="h-3 w-3" />} title="Approximate date — confirm in Settings → Thresholds">Date to confirm</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted">Categories: {f.categories.join(', ')}</p>
        <div className="mt-2">
          <p className="text-xs text-muted">Collections to refresh</p>
          {f.collectionsToRefresh.length ? (
            <ul className="mt-0.5 flex flex-col gap-0.5">{f.collectionsToRefresh.map((u) => <li key={u}><SiteUrl url={u} /></li>)}</ul>
          ) : <p className="text-sm text-muted">No matching collection — consider a new landing page.</p>}
        </div>
      </div>
    </li>
  );
}
