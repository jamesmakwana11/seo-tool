import { Link } from 'react-router-dom';
import { ArrowUpRight, Bot, CheckCircle2, PartyPopper } from 'lucide-react';
import { MODULE_LABELS, TEAMS, TEAM_IDS, type DailyDigest, type IssueStatus, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, DemoBadge, EmptyState, Mono, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { TrendChart } from '@/components/ui/charts';
import { AllocationButtons } from '@/components/domain/allocation';
import { SeverityBadge, SlaCountdown, TeamBadge } from '@/components/domain/badges';
import { scoreColor } from '@/components/domain/HealthScore';
import { ReportActions, ReportMetaPanel } from '@/components/reports/ReportParts';
import { fmtDate, fmtDateTime, fmtNum, shortUrl } from '@/lib/format';

export default function DailyDigestPage() {
  const q = useApiQuery(['digest'], () => api.getDailyDigest());
  return (
    <div>
      <PageHeader
        title="Daily digest"
        description="Auto-delivered at 8:00 AM IST by email, WhatsApp and Slack (PDF §12.1). Every issue line carries the three one-tap allocation buttons (PDF §11.1a)."
        meta={<><DemoBadge />{q.data && <span className="text-xs text-muted">For {fmtDate(q.data.meta.periodEnd)} · generated {fmtDateTime(q.data.meta.generatedAt)} IST</span>}</>}
        actions={<ReportActions kind="daily" />}
      />
      <Async q={q} rows={12}>{(d) => <Digest d={d} />}</Async>
    </div>
  );
}

/** The digest line only carries ids/teams; derive the fields AllocationButtons needs. */
function lineIssue(x: { issueId: string; title: string; recommendedTeam: TeamId; allocatedTeam?: TeamId }) {
  const status: IssueStatus = x.allocatedTeam ? 'ASSIGNED' : 'NEW';
  return { id: x.issueId, title: x.title, recommendedTeam: x.recommendedTeam, allocatedTeam: x.allocatedTeam, status };
}

function Digest({ d }: { d: DailyDigest }) {
  const trend = d.health.trend7d;
  const first = trend[0]?.score ?? d.health.score;
  const delta = d.health.score - first;
  const mediumCount = d.newMediumsByModule.reduce((s, m) => s + m.items.length, 0);
  return (
    <div className="space-y-5">
      {/* 1 — Health */}
      <Panel title="1. SEO Health Score" subtitle="Weighted composite 0–100 (PDF §14) with 7-day trend" actions={<Link to="/health" className="text-sm text-signal hover:underline">Breakdown</Link>}>
        <div className="grid items-center gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
          <div>
            <p className="text-[44px] font-semibold leading-none tabular-nums" style={{ color: scoreColor(d.health.score) }}>{d.health.score.toFixed(1)}</p>
            <p className="mt-1 text-xs text-muted">of 100 · <span className={delta >= 0 ? 'text-ok-ink' : 'text-crit-ink'}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)} over 7 days</span></p>
          </div>
          <TrendChart data={trend.map((p) => ({ date: p.date, score: p.score }))} x="date" series={[{ key: 'score', label: 'Health score' }]} height={150} area yFormat={(v) => v.toFixed(0)} />
        </div>
      </Panel>

      {/* 2 — New criticals */}
      <Panel title={<span className="flex items-center gap-2">2. New Criticals <Badge tone={d.newCriticals.length ? 'crit' : 'ok'}>{d.newCriticals.length}</Badge></span>} subtitle="Target: zero. Each line links to its Fix Card." bodyClassName="p-0">
        {d.newCriticals.length ? (
          <ul className="divide-y divide-line">
            {d.newCriticals.map((c) => (
              <li key={c.issueId} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-start gap-2">
                  <SeverityBadge severity="critical" />
                  <div className="min-w-0 flex-1">
                    <Link to={`/issues/${c.issueId}`} className="font-medium text-ink hover:text-signal hover:underline">{c.title}</Link>
                    <p className="text-sm text-muted">{c.summary}</p>
                  </div>
                  <Link to={`/issues/${c.issueId}`} className="inline-flex shrink-0 items-center gap-1 text-sm text-signal hover:underline">Fix Card <span className="font-mono text-xs">{c.issueId}</span><ArrowUpRight className="h-3.5 w-3.5" /></Link>
                </div>
                <AllocationButtons compact issue={lineIssue(c)} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<PartyPopper className="h-7 w-7 text-ok-ink" />} title="Zero new Criticals in the last 24 hours" description="Target met. Keep the streak — Mediums and the SLA watchlist below are next." />
        )}
      </Panel>

      {/* 3 — New mediums */}
      <Panel title={<span className="flex items-center gap-2">3. New Mediums by module <Badge tone={mediumCount ? 'med' : 'ok'}>{mediumCount}</Badge></span>} bodyClassName="p-0">
        {d.newMediumsByModule.length ? (
          <div className="divide-y divide-line">
            {d.newMediumsByModule.map((m) => (
              <section key={m.module} className="px-4 py-3">
                <h3 className="mb-2 text-sm font-semibold">{MODULE_LABELS[m.module]} <span className="font-normal text-muted">· {m.items.length}</span></h3>
                <ul className="space-y-3">
                  {m.items.map((i) => (
                    <li key={i.issueId} className="space-y-1.5">
                      <Link to={`/issues/${i.issueId}`} className="flex items-start gap-2 text-sm hover:text-signal">
                        <Mono className="shrink-0 text-muted">{i.issueId}</Mono>
                        <span className="min-w-0 flex-1 hover:underline">{i.title}</span>
                      </Link>
                      <AllocationButtons compact issue={lineIssue(i)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : <EmptyState title="No new Medium issues since yesterday" />}
      </Panel>

      {/* 4 — AI compliance */}
      <Panel title={<span className="flex items-center gap-2"><Bot className="h-4 w-4 text-opp-ink" aria-hidden /> 4. AI Content Compliance</span>} subtitle="New Module 7 flags with the offending passage and a rewrite draft (PDF §10)" actions={<Link to="/modules/ai-compliance" className="text-sm text-signal hover:underline">All flags</Link>} bodyClassName="p-0">
        {d.aiCompliance.length ? (
          <ul className="divide-y divide-line">
            {d.aiCompliance.map((f) => (
              <li key={f.flagId} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{f.rule}</span>
                  <a href={f.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-muted hover:underline">{shortUrl(f.url)}</a>
                  {f.issueId && <Link to={`/issues/${f.issueId}`} className="ml-auto text-sm text-signal hover:underline">Fix Card {f.issueId}</Link>}
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <blockquote className="rounded-ctl border border-crit/25 bg-crit-tint px-3 py-2 text-sm text-ink-soft"><span className="mb-0.5 block text-2xs font-medium text-crit-ink">Offending passage</span>{f.passage}</blockquote>
                  <div className="rounded-ctl border border-line bg-canvas px-3 py-2 text-sm text-ink-soft"><span className="mb-0.5 block text-2xs font-medium text-muted">Rewrite draft (needs human approval)</span>{f.rewrite ?? <span className="text-muted">No rewrite drafted for this rule (action is “flag only”).</span>}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No new AI-content flags" description="Built-in checks and custom rules found nothing new in the last 24 hours." />}
      </Panel>

      {/* 5 — Verified fixed */}
      <Panel title={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-ok-ink" aria-hidden /> 5. Verified fixed since yesterday</span>} subtitle="Closed only after automated re-verification passed" bodyClassName="p-0">
        {d.verifiedFixed.length ? (
          <ul className="divide-y divide-line">
            {d.verifiedFixed.map((v) => (
              <li key={v.issueId}>
                <Link to={`/issues/${v.issueId}`} className="flex flex-wrap items-center gap-2 px-4 py-2 hover:bg-raised">
                  <Mono className="text-muted">{v.issueId}</Mono>
                  <span className="min-w-0 flex-1 text-sm">{v.title}</span>
                  <span className="text-xs text-muted">{fmtDateTime(v.verifiedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Nothing verified since yesterday" description="Fixes appear here once the re-verification crawl confirms 0 failing URLs." />}
      </Panel>

      {/* 6 — Opportunities */}
      <Panel title="6. Daily opportunities" subtitle="Top 5 striking-distance keywords · top 3 CTR rewrites · 1 content brief (PDF §12.1)" actions={<Link to="/opportunities" className="text-sm text-signal hover:underline">Opportunities board</Link>}>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          <section>
            <h3 className="mb-2 text-sm font-semibold">Striking distance (positions 5–20)</h3>
            {d.opportunities.strikingDistance.length ? (
              <ol className="space-y-2">
                {d.opportunities.strikingDistance.map((s) => (
                  <li key={s.id} className="rounded-ctl border border-line px-3 py-2">
                    <p className="text-sm font-medium">{s.query}</p>
                    <p className="font-mono text-2xs text-muted">{shortUrl(s.url)}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-muted">pos {s.position.toFixed(1)} · {fmtNum(s.impressions)} impr · {fmtNum(s.clicks)} clicks · CTR {s.ctr}%</p>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted">No striking-distance queries today.</p>}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">CTR rewrites</h3>
            {d.opportunities.ctrRewrites.length ? (
              <ol className="space-y-2">
                {d.opportunities.ctrRewrites.map((c) => (
                  <li key={c.id} className="rounded-ctl border border-line px-3 py-2">
                    <p className="text-sm font-medium">{c.query}</p>
                    <p className="text-xs tabular-nums text-muted">pos {c.position} · CTR {c.ctr}% vs {c.benchmarkCtr}% benchmark</p>
                    <p className="mt-1 text-xs"><span className="text-muted">Now:</span> {c.currentTitle}</p>
                    {c.variants[0]?.title && <p className="text-xs"><span className="text-muted">Draft:</span> {c.variants[0].title}</p>}
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted">No CTR rewrites today.</p>}
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold">Content brief</h3>
            {d.opportunities.brief ? (
              <Link to={`/opportunities/briefs/${d.opportunities.brief.id}`} className="block rounded-ctl border border-line px-3 py-2 hover:border-signal/50">
                <p className="text-sm font-medium">{d.opportunities.brief.title}</p>
                <p className="text-xs text-muted">Target: {d.opportunities.brief.targetKeyword} · {d.opportunities.brief.pageType.replace('_', ' ')} · {d.opportunities.brief.status}</p>
                <p className="mt-1 font-mono text-2xs text-muted">{d.opportunities.brief.suggestedUrl}</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-signal">Open brief <ArrowUpRight className="h-3 w-3" /></span>
              </Link>
            ) : <p className="text-sm text-muted">No draft or approved brief waiting.</p>}
          </section>
        </div>
      </Panel>

      {/* 7 — Allocation status */}
      <Panel title="7. Allocation status" subtitle="Who allocated what to which 1into2 team yesterday; unallocated issues past 24h; open load per team" actions={<Link to="/team/allocations" className="text-sm text-signal hover:underline">Allocation history</Link>}>
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {TEAM_IDS.map((t) => <Stat key={t} label={`${TEAMS[t].shortName} open issues`} value={d.allocation.openLoad[t]} hint={TEAMS[t].name} to={`/tasks/list?team=${t}`} />)}
          </div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <section>
              <h3 className="mb-2 text-sm font-semibold">Allocated in the last 24 hours ({d.allocation.yesterday.length})</h3>
              {d.allocation.yesterday.length ? (
                <ul className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-ctl border border-line">
                  {[...d.allocation.yesterday].sort((a, b) => b.at.localeCompare(a.at)).map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm">
                      {e.automatic && <Bot className="h-3.5 w-3.5 text-med-ink" aria-label="Automatic" />}
                      <span className="font-medium">{e.allocatedByName}</span>
                      <span className="text-muted">→</span>
                      <TeamBadge team={e.toTeam} short />
                      <Link to={`/issues/${e.issueId}`} className="font-mono text-xs text-signal hover:underline">{e.issueId}</Link>
                      <span className="ml-auto text-xs text-muted">{fmtDateTime(e.at)}</span>
                      {e.automatic && <span className="w-full text-xs text-med-ink">Auto-allocated: Critical unallocated past 24h (PDF §12.4)</span>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">No allocations in the last 24 hours.</p>}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Unallocated past 24 hours ({d.allocation.unallocatedPast24h.length})</h3>
              {d.allocation.unallocatedPast24h.length ? (
                <ul className="max-h-[320px] divide-y divide-line overflow-y-auto rounded-ctl border border-line">
                  {d.allocation.unallocatedPast24h.map((u) => (
                    <li key={u.issueId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <SeverityBadge severity={u.severity} />
                      <Link to={`/issues/${u.issueId}`} className="min-w-0 flex-1 text-sm hover:text-signal hover:underline">{u.title}</Link>
                      <span className="text-xs tabular-nums text-muted">{u.hours}h waiting</span>
                      {u.escalatedToSeoLead && <Badge tone="med">Auto-escalated to SEO lead</Badge>}
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">Every issue older than 24 hours has a team.</p>}
            </section>
          </div>
        </div>
      </Panel>

      {/* 8 — Watchlist */}
      <Panel title="8. Watchlist — approaching SLA" subtitle="Issues closest to (or past) their SLA" bodyClassName="p-0">
        {d.watchlist.length ? (
          <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">
            {d.watchlist.map((w) => (
              <li key={`${w.kind}-${w.id}`}>
                <Link to={`/issues/${w.id}`} className="flex flex-wrap items-center gap-2 px-4 py-2 hover:bg-raised">
                  <Badge tone="neutral">{w.kind}</Badge>
                  <Mono className="text-muted">{w.id}</Mono>
                  <span className="min-w-0 flex-1 text-sm">{w.title}</span>
                  <SlaCountdown dueAt={w.dueAt} compact />
                </Link>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Nothing approaching SLA" />}
      </Panel>

      <ReportMetaPanel meta={d.meta} schedule="Scheduled daily at 8:00 AM IST (change in Settings → Notifications)" />
    </div>
  );
}
