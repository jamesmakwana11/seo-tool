import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import type { Severity, WeeklyReport } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, DemoBadge, EmptyState, Mono, PageHeader, Panel, ProgressBar, Stat } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { SeverityBadge, SourceBadge, TeamBadge } from '@/components/domain/badges';
import { ReportActions, ReportMetaPanel } from '@/components/reports/ReportParts';
import { fmtDate, fmtNum } from '@/lib/format';

const ENGINE_LABEL: Record<string, string> = { chatgpt: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity', copilot: 'Copilot', google_aio: 'Google AI Overviews' };
const SLA_TARGET: Record<Severity, string> = { critical: 'Same day', medium: '7 days', low: '30 days' };

export default function WeeklyReportPage() {
  const q = useApiQuery(['digest', 'weekly'], () => api.getWeeklyReport());
  return (
    <div>
      <PageHeader
        title="Weekly rollup"
        description="Monday report (PDF §12.5): off-page deep-dive, AI-visibility panel results, competitor movement, SLA compliance and the top 10 priorities for the week."
        meta={<><DemoBadge />{q.data && <span className="text-xs text-muted">Week {fmtDate(q.data.meta.periodStart)} → {fmtDate(q.data.meta.periodEnd)}</span>}</>}
        actions={<ReportActions kind="weekly" />}
      />
      <Async q={q} rows={12}>{(r) => <Body r={r} />}</Async>
    </div>
  );
}

function signed(n: number, digits = 0) {
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function Body({ r }: { r: WeeklyReport }) {
  const engines = Object.entries(r.aiVisibility.byEngine);
  const shares = Object.entries(r.aiVisibility.competitorShare).sort((a, b) => b[1] - a[1]);
  const maxShare = Math.max(1, ...shares.map(([, v]) => v));
  return (
    <div className="space-y-5">
      {/* Top priorities first: it is what the team acts on Monday morning */}
      <Panel title={`Top ${r.topPriorities.length} priorities for the week`} subtitle="Ordered by priority score (impact × tier ÷ effort, PDF §11 step 4). Allocate from the Fix Card." actions={<Link to="/issues?sort=priority" className="text-sm text-signal hover:underline">Issues by priority</Link>} bodyClassName="p-0">
        {r.topPriorities.length ? (
          <ol className="divide-y divide-line">
            {r.topPriorities.map((p, i) => (
              <li key={p.issueId}>
                <Link to={`/issues/${p.issueId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-raised">
                  <span className="w-6 text-right text-sm font-semibold tabular-nums text-muted">{i + 1}</span>
                  <Mono className="text-muted">{p.issueId}</Mono>
                  <span className="min-w-0 flex-1 text-sm font-medium">{p.title}</span>
                  <Badge tone="signal" title="Priority score">score {p.priorityScore.toFixed(1)}</Badge>
                  <TeamBadge team={p.team} short />
                  <ArrowUpRight className="h-4 w-4 text-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ol>
        ) : <EmptyState title="No open issues to prioritise" />}
      </Panel>

      <Panel title="Off-page deep-dive" subtitle="Backlink deltas this week (requires Ahrefs or Semrush API for live data)" actions={<Link to="/modules/offpage/backlinks" className="text-sm text-signal hover:underline">Backlinks</Link>}>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="New links" value={fmtNum(r.offPage.newLinks)} tone="ok" />
            <Stat label="Lost links" value={fmtNum(r.offPage.lostLinks)} tone={r.offPage.lostLinks ? 'med' : undefined} />
            <Stat label="Toxic domains" value={fmtNum(r.offPage.toxicDomains)} tone={r.offPage.toxicDomains ? 'crit' : undefined} hint="toxic score ≥70" />
            <Stat label="Referring-domain delta" value={signed(r.offPage.referringDomainsDelta)} tone={r.offPage.referringDomainsDelta < 0 ? 'crit' : 'ok'} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Link prospects</h3>
            <DataTable
              rows={r.offPage.prospects}
              rowKey={(p) => p.id}
              dense
              pageSize={10}
              caption="Link prospects"
              empty={<p className="p-4 text-sm text-muted">No prospects this week.</p>}
              columns={[
                { key: 'd', header: 'Domain', cell: (p) => <Mono>{p.domain}</Mono> },
                { key: 'dr', header: 'DR', cell: (p) => <span className="tabular-nums">{p.domainRating}</span>, sort: (a, b) => a.domainRating - b.domainRating },
                { key: 'rel', header: 'Relevance', cell: (p) => <span className="tabular-nums">{Math.round(p.relevance * 100)}%</span>, hideOnMobile: true },
                { key: 'comp', header: 'Links to', cell: (p) => <span className="text-xs">{p.linksToCompetitors.join(', ')}</span>, hideOnMobile: true },
                { key: 'pitch', header: 'Pitch angle', cell: (p) => <span className="text-xs">{p.pitchAngle}</span> },
                { key: 'src', header: 'Source', cell: (p) => <SourceBadge source={p.source} />, hideOnMobile: true },
              ]}
            />
          </div>
          {r.offPage.digitalPr.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Digital PR & seasonal angles</h3>
              <ul className="space-y-1.5 text-sm">
                {r.offPage.digitalPr.map((o) => <li key={o.id} className="flex flex-wrap gap-2"><span className="font-medium">{o.title}</span><span className="text-muted">— {o.detail}</span></li>)}
              </ul>
            </div>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="AI-visibility panel" subtitle="Weekly buyer-intent prompt panel run on AI engines (PDF §8)" actions={<Link to="/modules/ai-visibility" className="text-sm text-signal hover:underline">Details</Link>}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Prompts run" value={fmtNum(r.aiVisibility.promptsRun)} />
              <Stat label="DeoDap mention rate" value={`${r.aiVisibility.mentionRate}%`} tone="signal" />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Mention rate by engine</h3>
              <ul className="space-y-2">
                {engines.map(([e, v]) => (
                  <li key={e} className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-2 text-sm">
                    <span>{ENGINE_LABEL[e] ?? e}</span>
                    <ProgressBar value={v} label={`${ENGINE_LABEL[e] ?? e} mention rate ${v}%`} />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Mention share vs competitors</h3>
              <ul className="space-y-1.5">
                {shares.map(([name, v]) => (
                  <li key={name} className="grid grid-cols-[140px_minmax(0,1fr)_48px] items-center gap-2 text-sm">
                    <span className="truncate">{name}</span>
                    <span className="h-2 rounded-full bg-line" aria-hidden><span className="block h-2 rounded-full bg-opp" style={{ width: `${(v / maxShare) * 100}%` }} /></span>
                    <span className="text-right tabular-nums">{v}%</span>
                  </li>
                ))}
                {!shares.length && <li className="text-sm text-muted">No panel results yet — requires OpenAI / Gemini / Perplexity API keys.</li>}
              </ul>
            </div>
          </div>
        </Panel>

        <Panel title="SLA compliance by severity" subtitle="Issues closed this period within SLA (Critical same day · Medium 7d · Low 30d, PDF §3.2)">
          <ul className="space-y-4">
            {r.slaCompliance.map((s) => (
              <li key={s.severity} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <SeverityBadge severity={s.severity} />
                  <span className="text-muted">target {SLA_TARGET[s.severity]}</span>
                  <span className="ml-auto tabular-nums">{s.withinSla} of {s.total} within SLA</span>
                </div>
                {s.total ? <ProgressBar value={s.pct} tone={s.pct >= 90 ? 'ok' : s.pct >= 70 ? 'med' : 'crit'} label={`${s.severity} SLA compliance ${s.pct}%`} /> : <p className="text-xs text-muted">No {s.severity} issues closed this period — nothing to measure.</p>}
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel title="Competitor movement" subtitle="Week-over-week change vs named competitors (placeholders until the kickoff workshop)" actions={<Link to="/competitors" className="text-sm text-signal hover:underline">Competitor view</Link>}>
        <DataTable
          rows={r.competitorMovement}
          rowKey={(c) => c.domain}
          dense
          caption="Competitor movement"
          empty={<p className="p-4 text-sm text-muted">No competitors configured. Add them in Settings → Thresholds.</p>}
          columns={[
            { key: 'd', header: 'Competitor', cell: (c) => <Mono>{c.domain}</Mono> },
            { key: 'v', header: 'Visibility Δ', cell: (c) => <span className={`tabular-nums ${c.visibilityDelta > 0 ? 'text-crit-ink' : c.visibilityDelta < 0 ? 'text-ok-ink' : ''}`}>{signed(c.visibilityDelta, 1)}</span>, sort: (a, b) => a.visibilityDelta - b.visibilityDelta },
            { key: 'b', header: 'Backlink Δ', cell: (c) => <span className="tabular-nums">{signed(c.backlinkDelta)}</span>, hideOnMobile: true },
            { key: 'cwv', header: 'CWV', cell: (c) => <span className="capitalize">{c.cwvStatus.replace('_', ' ')}</span> },
            { key: 'cv', header: 'Content velocity', cell: (c) => <span className="tabular-nums">{c.contentVelocity}/wk</span> },
          ]}
        />
        <p className="mt-2 text-xs text-muted">Positive visibility delta for a competitor is shown in red — they gained ground this week.</p>
      </Panel>

      <ReportMetaPanel meta={r.meta} schedule="Scheduled every Monday (change in Settings → Notifications)" />
    </div>
  );
}
