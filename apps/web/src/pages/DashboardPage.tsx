import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BellRing, CircleCheck, Clock, FilePlus2, OctagonAlert, PenLine, Plus, Radar, TrendingDown, Users } from 'lucide-react';
import { MODULE_LABELS, TEAMS, TEAM_IDS, type DashboardData, type MonitorEvent } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useUser } from '@/auth/AuthContext';
import { Async, EmptyState, KpiCard, MetricTabs, Notice, PageHeader, Panel, Segmented } from '@/components/ui/primitives';
import { ChartLegend, DonutChart, PillBars, SEVERITY_COLORS, SegmentRows, TrendChart } from '@/components/ui/charts';
import { HealthScoreSummary, ModulePerformanceBars } from '@/components/domain/HealthScore';
import { IssueStatusBadge, SeverityBadge, SlaCountdown } from '@/components/domain/badges';
import { fmtDateTime, fmtMs, fmtNum, fmtRelative } from '@/lib/format';
import { syncBusy, useSyncNow, useSyncStatus } from '@/components/crawls/WebsiteSync';

export default function DashboardPage() {
  const user = useUser();
  const q = useApiQuery(['dashboard'], () => api.getDashboard());
  return (
    <div>
      <PageHeader
        title={user.role === 'developer' ? 'Development overview' : 'Overview'}
        description="What broke or degraded on this website, how serious it is, and who is fixing it."
        actions={<Link to="/reports/daily" className="inline-flex h-9 items-center gap-1 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark">Today's digest <ArrowUpRight className="h-4 w-4" /></Link>}
      />
      {user.role === 'developer' && <DeveloperWork />}
      <Async q={q} rows={10}>{(d) => <Body d={d} />}</Async>
    </div>
  );
}

function DeveloperWork() {
  const user = useUser();
  const q = useApiQuery(['issues', 'team-dash', user.teamIds.join(',')], () => api.listIssues({ team: user.teamIds, status: ['ASSIGNED', 'IN_PROGRESS', 'FIXED'], sort: 'sla', dir: 'asc', pageSize: 8 }));
  return (
    <Panel title="Issues allocated to your team" className="mb-5" actions={<Link to={`/issues?team=${user.teamIds.join(',')}`} className="text-sm text-signal hover:underline">All team issues</Link>} bodyClassName="p-0">
      <Async q={q} rows={3}>
        {(p) => p.items.length ? (
          <ul className="divide-y divide-line">
            {p.items.map((i) => (
              <li key={i.id}>
                <Link to={`/issues/${i.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-raised">
                  <SeverityBadge severity={i.severity} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</span>
                  <IssueStatusBadge status={i.status} />
                  <SlaCountdown dueAt={i.slaDueAt} done={i.status === 'FIXED'} />
                </Link>
              </li>
            ))}
          </ul>
        ) : <EmptyState title={`Nothing open for your team, ${user.name.split(' ')[0]}`} description="Issues appear here when an SEO specialist allocates them to your team." />}
      </Async>
    </Panel>
  );
}

function Body({ d }: { d: DashboardData }) {
  const openCrit = d.issueCounts.reduce((s, x) => s + x.critical, 0);
  const openMed = d.issueCounts.reduce((s, x) => s + x.medium, 0);
  const openLow = d.issueCounts.reduce((s, x) => s + x.low, 0);
  const breached = d.slaWatchlist.filter((w) => w.breached).length;
  const trendVals = d.healthTrend.map((h) => h.score);
  const delta7 = trendVals.length > 7 ? trendVals.at(-1)! - trendVals.at(-8)! : undefined;
  const newCritToday = d.todaysChanges.filter((c) => c.kind === 'new' && c.severity === 'critical').length;
  const crawls = d.crawlTrend;
  const lastC = crawls.at(-1);
  const prevC = crawls.at(-2);
  const crawlPct = lastC && prevC && prevC.crawled ? ((lastC.crawled - prevC.crawled) / prevC.crawled) * 100 : undefined;
  const notConnected = d.dataNotes.length > 0;
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        {notConnected && (
          <Notice tone="caution" title="Data sources not connected">
            <details>
              <summary className="cursor-pointer">{d.dataNotes.length} data source{d.dataNotes.length > 1 ? 's are' : ' is'} not connected, so the figures that depend on them are incomplete. Show details</summary>
              <ul className="mt-1 list-disc pl-5">{d.dataNotes.map((n) => <li key={n}>{n}</li>)}</ul>
            </details>
          </Notice>
        )}

        <HealthScoreSummary score={d.health.score} modules={d.health.modules} delta={delta7} to="/health" />

        <Panel title="SEO Module Performance" subtitle="Each module scored 0–100 on the same scale. Select a module to open its findings.">
          <ModulePerformanceBars modules={d.health.modules} />
        </Panel>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <KpiCard label="Open critical" value={openCrit} icon={OctagonAlert} tint="violet" to="/issues?severity=critical"
            trend={newCritToday ? { text: `+${newCritToday} today`, up: true, good: false } : undefined} note="Target: zero" />
          <KpiCard label="Past SLA" value={breached} icon={Clock} tint="lilac" to="/issues?sort=sla" note="Past their due time" />
          <div className="col-span-2 sm:col-span-1">
            <KpiCard label="Pages crawled" value={lastC ? lastC.crawled : null} icon={Radar} tint="blue" to="/crawls"
              trend={crawlPct !== undefined && Math.abs(crawlPct) >= 0.1 ? { text: `${crawlPct >= 0 ? '+' : ''}${crawlPct.toFixed(1)}%`, up: crawlPct >= 0, good: crawlPct >= 0 } : undefined} note={lastC ? `Latest daily crawl · ${fmtNum(lastC.failed)} failed` : 'No crawl yet'} />
          </div>
        </div>

        <HealthTrendCard />

        <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <SearchPerformance d={d} />
          <Panel title="Issues by module" subtitle="Open critical, medium and low">
            <SegmentRows
              rows={d.issueCounts.map((c) => ({ key: c.module, label: MODULE_LABELS[c.module], values: [c.critical, c.medium, c.low] }))}
              segments={[{ label: 'Critical', color: SEVERITY_COLORS.critical }, { label: 'Medium', color: SEVERITY_COLORS.medium }, { label: 'Low', color: SEVERITY_COLORS.low }]}
            />
            <div className="mt-4 border-t border-line pt-3"><ChartLegend items={[{ label: 'Critical', color: SEVERITY_COLORS.critical }, { label: 'Medium', color: SEVERITY_COLORS.medium }, { label: 'Low', color: SEVERITY_COLORS.low }]} /></div>
          </Panel>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <CrawlActivity d={d} />
          <Panel title="Issue distribution" subtitle="Open issues by severity">
            <DonutChart
              size={164}
              centerValue={fmtNum(openCrit + openMed + openLow)}
              centerLabel="open issues"
              data={[
                { key: 'critical', label: 'Critical', value: openCrit, color: SEVERITY_COLORS.critical },
                { key: 'medium', label: 'Medium', value: openMed, color: SEVERITY_COLORS.medium },
                { key: 'low', label: 'Low', value: openLow, color: SEVERITY_COLORS.low },
              ]}
            />
            <IssueFacts d={d} />
          </Panel>
        </div>

        <Panel title="Core Web Vitals" subtitle="Field data at p75 per template · the line marks the 'good' threshold" actions={<Link to="/modules/performance" className="text-[13px] font-medium text-signal hover:underline">Performance</Link>}>
          <CwvCompare rows={d.cwv} />
        </Panel>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Panel title="Indexation" subtitle="Search Console index coverage, last 30 days">
            <TrendChart data={d.indexation} x="date" series={[{ key: 'indexed', label: 'Indexed' }, { key: 'crawledNotIndexed', label: 'Crawled, not indexed', color: SEVERITY_COLORS.critical, axis: 'right' }]} area height={210} />
          </Panel>
          <Panel title="AI mention share" subtitle="Weekly buyer-intent prompt panel" actions={<Link to="/modules/ai-visibility" className="text-[13px] font-medium text-signal hover:underline">Details</Link>}>
            <TrendChart data={d.aiMentions.map((p) => ({ week: p.week, ...p.mentionShare }))} x="week" series={Object.keys(d.aiMentions.at(-1)?.mentionShare ?? {}).map((k) => ({ key: k, label: k }))} yFormat={(v) => `${v}%`} height={210} />
          </Panel>
        </div>
      </div>

      {/* Right rail (reference: notifications / activities): alerts, today's changes, SLA and team load. */}
      <aside className="min-w-0 space-y-5" aria-label="Activity">
        <RailSection title="Real-time alerts" empty="No real-time alerts.">
          {d.criticalAlerts.slice(0, 4).map((a) => (
            <RailItem key={a.id} to={a.issueId ? `/issues/${a.issueId}` : undefined} icon={<BellRing className="h-4 w-4" />} tone="crit" title={a.title}
              meta={`${fmtRelative(a.at)} · ${a.delivered.length ? `${a.delivered.filter((x) => x.outcome === 'delivered').length} of ${a.delivered.length} channels delivered` : 'In-app only'}`} />
          ))}
        </RailSection>
        <RailSection title="Today's changes" empty="No changes since yesterday's crawl." timeline>
          {d.todaysChanges.slice(0, 6).map((c) => (
            <RailItem key={`${c.kind}-${c.issueId}`} to={`/issues/${c.issueId}`} icon={c.kind === 'resolved' ? <CircleCheck className="h-4 w-4" /> : c.kind === 'new' ? <Plus className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              tone={c.kind === 'resolved' ? 'ok' : c.kind === 'new' ? 'crit' : 'med'} title={c.title} meta={`${c.kind === 'new' ? 'New' : c.kind === 'resolved' ? 'Resolved' : c.kind === 'worsening' ? 'Worsening' : 'Recurring'} · ${MODULE_LABELS[c.module]}`} />
          ))}
        </RailSection>
        <MonitorRail />
        <RailSection title="Approaching SLA" empty="Nothing is approaching its SLA.">
          {d.slaWatchlist.slice(0, 5).map((w) => (
            <Link key={w.id} to={`/issues/${w.id}`} className="block rounded-xl px-2 py-1.5 transition-colors hover:bg-raised">
              <span className="line-clamp-1 text-[13px] text-ink">{w.title}</span>
              <span className="mt-0.5 flex items-center gap-2"><span className="font-mono text-2xs text-faint">{w.id}</span><SlaCountdown dueAt={w.dueAt} compact /></span>
            </Link>
          ))}
        </RailSection>
        <TeamLoad load={d.openLoad} />
      </aside>
    </div>
  );
}

/** Two plain facts under the donut, both straight from the data: the most affected module and today's movement. */
function IssueFacts({ d }: { d: DashboardData }) {
  const top = [...d.issueCounts].map((c) => ({ m: c.module, n: c.critical + c.medium + c.low })).sort((a, b) => b.n - a.n)[0];
  const opened = d.todaysChanges.filter((c) => c.kind === 'new').length;
  const resolved = d.todaysChanges.filter((c) => c.kind === 'resolved').length;
  return (
    <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
      <div className="rounded-xl bg-raised px-3 py-2.5"><dt className="text-xs text-muted">Most affected module</dt><dd className="mt-0.5 truncate font-semibold text-ink">{top ? `${MODULE_LABELS[top.m]} · ${top.n}` : '—'}</dd></div>
      <div className="rounded-xl bg-raised px-3 py-2.5"><dt className="text-xs text-muted">Since yesterday</dt><dd className="mt-0.5 font-semibold tabular-nums text-ink">{opened} new · {resolved} resolved</dd></div>
    </dl>
  );
}

function RailSection({ title, children, empty, timeline }: { title: string; children: ReactNode; empty: string; timeline?: boolean }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section className="rounded-panel border border-line bg-surface p-4 shadow-card">
      <h2 className="mb-2 px-2 text-[14px] font-semibold text-ink">{title}</h2>
      {items.length ? <div className={timeline ? 'rail-timeline space-y-0.5' : 'space-y-0.5'}>{items}</div> : <p className="px-2 text-sm text-muted">{empty}</p>}
    </section>
  );
}

const RAIL_TONE = { crit: 'bg-crit-tint text-crit-ink', med: 'bg-med-tint text-med-ink', ok: 'bg-ok-tint text-ok-ink', signal: 'bg-signal-tint text-signal' } as const;
function RailItem({ to, icon, tone, title, meta }: { to?: string; icon: ReactNode; tone: keyof typeof RAIL_TONE; title: string; meta: string }) {
  const body = (
    <>
      <span className={`relative z-[1] mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${RAIL_TONE[tone]}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-[13px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block truncate text-[11.5px] text-muted">{meta}</span>
      </span>
    </>
  );
  const cls = 'rail-item flex items-start gap-3 rounded-xl px-2 py-2 transition-colors';
  return to ? <Link to={to} className={`${cls} hover:bg-raised`}>{body}</Link> : <div className={cls}>{body}</div>;
}

type Range = '7' | '14' | '30';
/** Health trend with range selection and a dashed previous-period line (only when that history exists). */
function HealthTrendCard() {
  const [range, setRange] = useState<Range>('30');
  const n = Number(range);
  const q = useApiQuery(['health-history', 'trend', 2 * n], () => api.getHealthHistory(2 * n));
  return (
    <Panel
      title="Health trend"
      subtitle="Daily SEO Health Score"
      actions={<Segmented label="Date range" value={range} onChange={setRange} items={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} />}
    >
      <Async q={q} rows={4}>
        {(hist) => {
          const cur = hist.slice(-n);
          const prev = hist.length >= 2 * n ? hist.slice(-2 * n, -n) : [];
          const data = cur.map((p, i) => ({ date: p.date, score: p.score, previous: prev[i]?.score }));
          const avg = (a: { score: number }[]) => a.reduce((s, p) => s + p.score, 0) / (a.length || 1);
          const diff = prev.length ? avg(cur) - avg(prev) : undefined;
          return (
            <>
              <div className="mb-1 flex flex-wrap items-end justify-between gap-3">
                <div className="flex items-baseline gap-3">
                  <span className="text-[26px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">{cur.at(-1)?.score.toFixed(1) ?? '—'}</span>
                  {diff !== undefined && <span className={`text-xs font-semibold ${diff >= 0 ? 'text-ok-ink' : 'text-crit-ink'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(1)} avg vs previous {n} days</span>}
                </div>
                <ChartLegend items={[{ label: `Last ${n} days`, color: '#7650D8' }, ...(prev.length ? [{ label: `Previous ${n} days`, color: '#B6A0F5', dashed: true }] : [])]} />
              </div>
              <TrendChart key={range} data={data} x="date" legend={false} area height={240} yFormat={(v) => v.toFixed(1)}
                series={[{ key: 'score', label: `Last ${n} days` }, ...(prev.length ? [{ key: 'previous', label: `Previous ${n} days`, color: '#B6A0F5', dashed: true }] : [])]} />
            </>
          );
        }}
      </Async>
    </Panel>
  );
}

type SearchMetric = 'clicks' | 'impressions' | 'avgPosition';
/** Search Console clicks / impressions / position with metric tabs. Labelled when it does not come from a connected source. */
function SearchPerformance({ d }: { d: DashboardData }) {
  const [m, setM] = useState<SearchMetric>('clicks');
  const vals = d.visibility.map((v) => v[m]);
  const last7 = vals.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = vals.slice(-14, -7).reduce((a, b) => a + b, 0);
  const pct = prev7 ? ((last7 - prev7) / prev7) * 100 : undefined;
  const better = m === 'avgPosition' ? (pct ?? 0) <= 0 : (pct ?? 0) >= 0;
  return (
    <section className="min-w-0 rounded-panel border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MetricTabs value={m} onChange={setM} items={[{ value: 'clicks', label: 'Clicks' }, { value: 'impressions', label: 'Impressions' }, { value: 'avgPosition', label: 'Avg. position' }]} />
        <div className="flex items-center gap-2">{pct !== undefined && <span className={`text-xs font-semibold ${better ? 'text-ok-ink' : 'text-crit-ink'}`}>{pct >= 0 ? '+' : ''}{pct.toFixed(1)}% vs previous 7 days</span>}</div>
      </div>
      <p className="mt-1 text-xs text-muted">Organic search, last 30 days{m === 'avgPosition' ? ' · lower is better' : ''}</p>
      <div className="mt-3">
        {d.visibility.length ? (
          <TrendChart key={m} data={d.visibility} x="date" area height={250} legend={false}
            series={[{ key: m, label: m === 'clicks' ? 'Clicks' : m === 'impressions' ? 'Impressions' : 'Avg. position' }]}
            yDomain={m === 'avgPosition' ? ['auto', 'auto'] : undefined} yFormat={m === 'avgPosition' ? (v) => v.toFixed(1) : undefined} />
        ) : <EmptyState title="No search data" description="Connect Google Search Console to see clicks, impressions and position." />}
      </div>
    </section>
  );
}

type CrawlMetric = 'crawled' | 'newIssues' | 'resolvedIssues' | 'failed';
/** Daily smart crawls as rounded columns (latest highlighted), switchable between crawled / new / resolved / failed. */
function CrawlActivity({ d }: { d: DashboardData }) {
  const [m, setM] = useState<CrawlMetric>('crawled');
  const rows = d.crawlTrend.slice(-14);
  const names: Record<CrawlMetric, string> = { crawled: 'URLs crawled', newIssues: 'New issues', resolvedIssues: 'Resolved', failed: 'Failed URLs' };
  return (
    <Panel title="Crawl activity" subtitle="Last 14 daily crawls" actions={<Link to="/crawls" className="inline-flex items-center gap-1 text-[13px] font-medium text-signal hover:underline"><Radar className="h-4 w-4" /> Crawl Center</Link>}>
      <Segmented label="Crawl metric" value={m} onChange={setM} items={(Object.keys(names) as CrawlMetric[]).map((k) => ({ value: k, label: names[k] }))} />
      <div className="mt-3">
        {rows.length ? <PillBars key={m} data={rows} x="date" y={m} name={names[m]} height={210} /> : <EmptyState title="No crawls yet" description="Daily crawl results appear here." />}
      </div>
      {d.lastCrawl && (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-muted">
          <span>Last run <Link to={`/crawls/${d.lastCrawl.id}`} className="font-medium text-signal hover:underline">{d.lastCrawl.id}</Link> · {fmtDateTime(d.lastCrawl.finishedAt)} IST</span>
        </p>
      )}
    </Panel>
  );
}

const CWV_METRICS = [
  { key: 'lcpMs', label: 'LCP', good: 2500, poor: 4000, goodText: '≤ 2.5 s', fmt: (v: number) => fmtMs(v) },
  { key: 'inpMs', label: 'INP', good: 200, poor: 500, goodText: '≤ 200 ms', fmt: (v: number) => `${Math.round(v)} ms` },
  { key: 'cls', label: 'CLS', good: 0.1, poor: 0.25, goodText: '≤ 0.1', fmt: (v: number) => v.toFixed(2) },
] as const;

/**
 * LCP / INP / CLS side by side, one bar per template (mobile). Bars are violet; only a breach is coloured — amber for
 * "needs improvement", rose for "poor" — and a hairline marks the "good" threshold on every track.
 */
function CwvCompare({ rows }: { rows: DashboardData['cwv'] }) {
  const mobile = rows.filter((r) => r.device === 'mobile');
  const list = mobile.length ? mobile : rows;
  if (!list.length) return <EmptyState title="No Core Web Vitals data" description="Connect PageSpeed Insights / CrUX to see field data per template." />;
  return (
    <div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        {CWV_METRICS.map((m) => {
          const scale = m.poor * 1.3;
          return (
            <div key={m.key} className="min-w-0">
              <div className="mb-3 flex items-baseline justify-between"><span className="text-[13px] font-semibold text-ink">{m.label}</span><span className="text-2xs text-muted">good {m.goodText}</span></div>
              <ul className="space-y-2.5">
                {list.map((r) => {
                  const v = r[m.key] as number;
                  const st = v > m.poor ? 'poor' : v > m.good ? 'ni' : 'good';
                  return (
                    <li key={`${r.template}-${r.device}`} title={`${r.template} (${r.device}): ${m.fmt(v)} — ${st === 'good' ? 'Good' : st === 'ni' ? 'Needs improvement' : 'Poor'}`}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate capitalize text-muted">{r.template}</span>
                        <span className={`font-semibold tabular-nums ${st === 'poor' ? 'text-crit-ink' : st === 'ni' ? 'text-med-ink' : 'text-ink'}`}>{m.fmt(v)}</span>
                      </div>
                      <div className="relative mt-1 h-2 rounded-full bg-[#F1ECFA]">
                        <div className="bar-grow h-full rounded-full" style={{ width: `${Math.min(100, (v / scale) * 100)}%`, background: st === 'poor' ? 'linear-gradient(90deg,#F2B3BA,#DC5C6A)' : st === 'ni' ? 'linear-gradient(90deg,#F6D9A8,#E7A43B)' : 'linear-gradient(90deg,#B6A0F5,#7650D8)' }} />
                        <span className="absolute -top-0.5 h-3 w-px bg-[#252238]/30" style={{ left: `${(m.good / scale) * 100}%` }} aria-hidden />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-2xs text-muted">{mobile.length ? 'Mobile' : 'All devices'} · violet = good, amber = needs improvement, rose = poor</p>
    </div>
  );
}

/** Open allocated issues per team — a compact bar list rather than three more KPI tiles. */
function TeamLoad({ load }: { load: DashboardData['openLoad'] }) {
  const max = Math.max(1, ...TEAM_IDS.map((t) => load[t]));
  return (
    <Panel title="Open issues by team" subtitle="Allocated, not yet fixed" bodyClassName="space-y-3.5 p-4 pt-3">
      {TEAM_IDS.map((t) => (
        <Link key={t} to={`/issues?team=${t}`} className="group block rounded-ctl p-1 -m-1 transition-colors hover:bg-raised">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-sm text-ink-soft"><Users className="h-4 w-4 shrink-0 text-faint group-hover:text-signal" aria-hidden /><span className="truncate">{TEAMS[t].name}</span></span>
            <span className="text-lg font-semibold tabular-nums text-ink">{load[t]}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#F1ECFA]"><div className="bar-grow h-full rounded-full" style={{ width: `${(load[t] / max) * 100}%`, background: 'linear-gradient(90deg,#B6A0F5,#7650D8)' }} /></div>
        </Link>
      ))}
    </Panel>
  );
}

const MONITOR_LABEL: Record<MonitorEvent['kind'], string> = { new_page: 'New page', seo_change: 'SEO change', error: 'Error', resolved: 'Resolved', removed: 'Removed from sitemap' };
const FIELD_LABEL: Record<NonNullable<MonitorEvent['field']>, string> = { title: 'Title', metaDescription: 'Meta description', canonical: 'Canonical', robots: 'Meta robots', h1: 'H1', status: 'HTTP status' };
const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };

/** Website sync: Sync Now, last / next sync, and the changes found between crawls (each recorded once). */
function MonitorRail() {
  const canRun = useUser().permissions.includes('crawls.run');
  const q = useSyncStatus();
  const run = useSyncNow();
  const m = q.data;
  const busy = syncBusy(m);
  const meta = (e: MonitorEvent) => `${fmtRelative(e.at)} · ${MONITOR_LABEL[e.kind]}${e.field && e.kind === 'seo_change' ? ` · ${FIELD_LABEL[e.field]}` : ''}${e.kind === 'error' || e.kind === 'resolved' ? ` · HTTP ${e.status ?? 'no response'}` : ''}`;
  return (
    <section className="rounded-panel border border-line bg-surface p-4 shadow-card" data-testid="monitor-rail">
      <div className="mb-2 flex items-center gap-2 px-2">
        <h2 className="text-[14px] font-semibold text-ink">Website sync</h2>
        {m?.available && canRun && m.sync.baseline && <button type="button" onClick={() => run.mutate()} disabled={run.isPending || busy} className="ml-auto text-[12px] font-medium text-signal hover:underline disabled:text-faint">{run.isPending || busy ? 'Syncing…' : 'Sync now'}</button>}
      </div>
      {!m ? <p className="px-2 text-sm text-muted">Loading…</p> : !m.available ? <p className="px-2 text-sm text-muted">{m.reason}</p> : (
        <>
          <p className="px-2 pb-1 text-[11.5px] text-muted">
            {m.sync.lastSyncAt ? `Last sync ${fmtRelative(m.sync.lastSyncAt)}` : 'Not synced yet'}
            {m.sync.autoSync && m.sync.nextSyncAt ? ` · next ${fmtRelative(m.sync.nextSyncAt)}` : m.sync.autoSync && m.sync.schedulerOff ? ' · Auto Sync waits for the server scheduler' : ' · Auto Sync off'}
            {m.lastSync?.state === 'done' ? ` · ${m.lastSync.crawled} page(s) updated` : ''}{m.openErrors ? ` · ${m.openErrors} open error(s)` : ''}
          </p>
          {!m.sync.baseline && <p className="px-2 text-sm text-muted">Run one Full or Smart crawl; syncs then keep it current.</p>}
          {m.events.length ? (
            <div className="rail-timeline space-y-0.5">
              {m.events.slice(0, 6).map((e) => (
                <RailItem key={e.id} to={`/pages/report?url=${encodeURIComponent(e.url)}`} tone={e.kind === 'resolved' ? 'ok' : e.kind === 'error' ? 'crit' : e.kind === 'new_page' ? 'signal' : 'med'}
                  icon={e.kind === 'resolved' ? <CircleCheck className="h-4 w-4" /> : e.kind === 'error' ? <OctagonAlert className="h-4 w-4" /> : e.kind === 'new_page' ? <FilePlus2 className="h-4 w-4" /> : <PenLine className="h-4 w-4" />}
                  title={pathOf(e.url)} meta={meta(e)} />
              ))}
            </div>
          ) : m.sync.baseline ? <p className="px-2 text-sm text-muted">No changes found since the last crawl.</p> : null}
          <Link to="/crawls" className="mt-2 block px-2 text-[12px] font-medium text-signal hover:underline">Sync settings and history</Link>
        </>
      )}
    </section>
  );
}
