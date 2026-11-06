import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Ga4Report, ReportCompare, ReportRange } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery, useSiteKey } from '@/api/hooks';
import { LoadingBlock, PageHeader, Panel } from '@/components/ui/primitives';
import { CompareBars, TrendChart } from '@/components/ui/charts';
import { MetricTile, ReportControls, ReportError, TopTable, fmtDuration, fmtRate } from '@/components/insights/parts';
import { fmtNum } from '@/lib/format';

/** Google insights → Analytics: GA4 for the selected website through its mapped Google account. */
export default function AnalyticsPage() {
  const [range, setRange] = useState<ReportRange>(28);
  const [compare, setCompare] = useState<ReportCompare>('previous');
  const [force, setForce] = useState(0);
  const siteKey = useSiteKey();
  const q = useQuery({
    queryKey: siteKey(['insights', 'ga4', range, compare, force]),
    queryFn: () => api.getGa4Report({ range, compare, force: force > 0 }),
    placeholderData: keepPreviousData, retry: false, staleTime: 5 * 60_000,
  });
  const r = q.data;
  return (
    <div>
      <PageHeader
        title="Analytics"
        description={r ? <>Google Analytics 4 · <span className="font-medium text-ink">{r.propertyName ?? r.propertyId}</span>{r.accountEmail ? <> · through {r.accountEmail}</> : null}</> : 'Users, sessions, engagement, traffic sources and conversions from Google Analytics 4.'}
      />
      <div className="space-y-5">
        <ReportControls range={range} onRange={setRange} compare={compare} onCompare={setCompare} fetchedAt={r?.fetchedAt} cached={r?.cached} refreshing={q.isFetching} onRefresh={() => setForce((n) => n + 1)} window={r ? { cur: r.range, prev: r.compareRange } : undefined} />
        {q.error && !r ? <ReportError error={q.error} onRetry={() => void q.refetch()} what="Google Analytics 4" /> : !r ? <LoadingBlock rows={8} label="Loading Google Analytics" /> : <Report r={r} />}
      </div>
    </div>
  );
}

function Report({ r }: { r: Ga4Report }) {
  const t = r.totals;
  const p = r.previous;
  const history = useApiQuery(['insights', 'history', 480], () => api.getGoogleHistory(480));
  const longTerm = (history.data ?? []).filter((x) => x.ga4).map((x) => ({ date: x.date, sessions: x.ga4!.sessions, users: x.ga4!.activeUsers }));
  const maxCh = Math.max(1, ...r.channels.map((c) => c.sessions));
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="ga4-totals">
        <MetricTile label="Users" value={fmtNum(t.activeUsers)} cur={t.activeUsers} prev={p.activeUsers} prevText={fmtNum(p.activeUsers)} hint="Active users" />
        <MetricTile label="New users" value={fmtNum(t.newUsers)} cur={t.newUsers} prev={p.newUsers} prevText={fmtNum(p.newUsers)} />
        <MetricTile label="Sessions" value={fmtNum(t.sessions)} cur={t.sessions} prev={p.sessions} prevText={fmtNum(p.sessions)} />
        <MetricTile label={r.conversionMetric === 'keyEvents' ? 'Conversions (key events)' : 'Conversions'} value={fmtNum(t.conversions, 1)} cur={t.conversions} prev={p.conversions} prevText={fmtNum(p.conversions, 1)} />
        <MetricTile label="Engagement rate" value={fmtRate(t.engagementRate)} cur={t.engagementRate} prev={p.engagementRate} prevText={fmtRate(p.engagementRate)} asPoints />
        <MetricTile label="Engaged sessions" value={fmtNum(t.engagedSessions)} cur={t.engagedSessions} prev={p.engagedSessions} prevText={fmtNum(p.engagedSessions)} />
        <MetricTile label="Avg. session duration" value={fmtDuration(t.averageSessionDuration)} cur={t.averageSessionDuration} prev={p.averageSessionDuration} prevText={fmtDuration(p.averageSessionDuration)} />
        <MetricTile label="Views" value={fmtNum(t.screenPageViews)} cur={t.screenPageViews} prev={p.screenPageViews} prevText={fmtNum(p.screenPageViews)} />
      </div>
      <Panel title="Daily trend" subtitle={`${r.daily.length} days`}>
        {r.daily.length ? (
          <TrendChart data={r.daily} x="date" series={[{ key: 'sessions', label: 'Sessions' }, { key: 'activeUsers', label: 'Users' }, { key: 'conversions', label: 'Conversions', axis: 'right', dashed: true }]} height={260} />
        ) : <p className="text-sm text-muted">Google returned no daily data for this period.</p>}
      </Panel>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Traffic by channel">
          {r.channels.length ? <CompareBars rows={r.channels.map((c) => ({ key: c.name, label: c.name, value: c.sessions, note: `${fmtNum(c.activeUsers)} users · ${fmtRate(c.engagementRate)} engaged · ${fmtNum(c.conversions, 1)} conv.` }))} max={maxCh} format={(v) => `${fmtNum(v)} sessions`} /> : <p className="text-sm text-muted">No channel data.</p>}
        </Panel>
        <Panel title="Top sources" bodyClassName="p-0">
          <TopTable label="Top sources" rows={r.sources} columns={[
            { header: 'Source / medium', cell: (x) => x.name, className: 'max-w-[16rem] truncate' },
            { header: 'Sessions', cell: (x) => fmtNum(x.sessions), align: 'right' },
            { header: 'Users', cell: (x) => fmtNum(x.activeUsers), align: 'right' },
            { header: 'Engaged', cell: (x) => fmtRate(x.engagementRate), align: 'right' },
            { header: 'Conv.', cell: (x) => fmtNum(x.conversions, 1), align: 'right' },
          ]} />
        </Panel>
      </div>
      <Panel title="Top pages" bodyClassName="p-0">
        <TopTable label="Top pages" rows={r.pages} columns={[
          { header: 'Page', cell: (x) => <span className="font-mono text-[13px]">{x.path}</span>, className: 'max-w-[28rem] truncate' },
          { header: 'Views', cell: (x) => fmtNum(x.views), align: 'right' },
          { header: 'Users', cell: (x) => fmtNum(x.activeUsers), align: 'right' },
          { header: 'Engagement rate', cell: (x) => fmtRate(x.engagementRate), align: 'right' },
        ]} />
      </Panel>
      {longTerm.length > r.daily.length && (
        <Panel title="Stored history" subtitle={`${longTerm.length} days kept by Sentinel from earlier reports`}>
          <TrendChart data={longTerm} x="date" series={[{ key: 'sessions', label: 'Sessions' }, { key: 'users', label: 'Users' }]} height={220} />
        </Panel>
      )}
    </>
  );
}
