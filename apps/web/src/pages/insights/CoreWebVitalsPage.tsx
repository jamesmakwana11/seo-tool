import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Monitor, Play, Smartphone } from 'lucide-react';
import {
  CWV_LABELS, CWV_METRICS, CWV_RATING_LABELS, CWV_THRESHOLDS, worstRating, type CwvMetric, type CwvRun, type CwvStrategy, type CwvValue,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, EmptyState, Notice, PageHeader, Panel, Segmented, Select } from '@/components/ui/primitives';
import { TrendChart } from '@/components/ui/charts';
import { RatingBadge, ratingText } from '@/components/insights/parts';
import { fmtDateTime, fmtRelative } from '@/lib/format';

const fmtValue = (m: CwvMetric | 'TBT', v: number) => (m === 'CLS' ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pageLabel = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname}`; } catch { return u; } };
const msAxis = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const threshold = (m: CwvMetric | 'TBT') => { const [g, p] = CWV_THRESHOLDS[m]; return `Good ≤ ${fmtValue(m, g)} · Poor > ${fmtValue(m, p)}`; };

/** Google insights → Core Web Vitals: PageSpeed Insights results (real-user field data and a lab run), mobile and desktop. */
export default function CoreWebVitalsPage() {
  const { can } = useAuth();
  const q = useApiQuery(['cwv'], () => api.getCwvReport(), { refetchInterval: (d) => (d?.running ? 3000 : false) });
  const run = useApiMutation(() => api.runCwv(), { success: (r) => `Testing ${r.tests / 2} page(s) on mobile and desktop — results appear here in a minute or two`, invalidate: [['cwv']] });
  const [strategy, setStrategy] = useState<CwvStrategy>('mobile');
  return (
    <div>
      <PageHeader
        title="Core Web Vitals"
        description="Loading, responsiveness and visual stability from Google PageSpeed Insights: real Chrome users (28-day field data) and a lab test of each run, separately for mobile and desktop."
        actions={<Button variant="primary" icon={<Play className="h-4 w-4" />} disabled={!q.data?.connected || q.data.running} loading={run.isPending || q.data?.running} onClick={() => run.mutate()}>{q.data?.running ? 'Testing…' : 'Run test now'}</Button>}
      />
      <Async q={q} rows={8}>
        {(r) => {
          if (!r.connected) {
            return <EmptyState title="PageSpeed Insights is not connected" description={r.problem} action={can('google.manage') ? <Link to="/settings/integrations" className="inline-flex h-9 items-center rounded-ctl bg-signal px-3 text-sm font-medium text-white hover:bg-signal-dark">Connect in Integrations</Link> : undefined} />;
          }
          const latest = r.latest.filter((x) => x.strategy === strategy).sort((a, b) => a.url.localeCompare(b.url));
          return (
            <div className="space-y-5">
              {r.problem && <Notice tone="crit">{r.problem}</Notice>}
              <div className="flex flex-wrap items-center gap-3">
                <Segmented<CwvStrategy> label="Device" value={strategy} onChange={setStrategy} items={[{ value: 'mobile', label: <span className="inline-flex items-center gap-1"><Smartphone className="h-3.5 w-3.5" />Mobile</span> }, { value: 'desktop', label: <span className="inline-flex items-center gap-1"><Monitor className="h-3.5 w-3.5" />Desktop</span> }]} />
                <span className="text-xs text-muted">{r.settings.urls.length ? `${r.settings.urls.length} page(s) tested` : 'Homepage tested'} · daily test {r.settings.autoDaily ? 'on (01:30 IST)' : 'off'}</span>
              </div>
              {latest.length ? latest.map((run) => <PageResult key={run.id} run={run} />) : <EmptyState title={`No ${strategy} results yet`} description="Run a test now; the daily test also fills this page." />}
              <History runs={r.history} strategy={strategy} />
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function MetricCell({ m, v, lab }: { m: CwvMetric | 'TBT'; v?: CwvValue; lab?: boolean }) {
  return (
    <div data-export-kpi className="min-w-0 rounded-ctl border border-line px-3 py-2.5" title={`${CWV_LABELS[m]} — ${threshold(m)}`}>
      <span data-export-hint hidden>{v ? CWV_RATING_LABELS[v.rating] : 'No data'} · {CWV_LABELS[m]}</span>
      <div className="flex items-center justify-between gap-2"><span data-export-label className="text-xs font-medium text-muted">{m}{lab ? ' (lab)' : ''}</span>{v && <span className={clsx('h-2 w-2 rounded-full', v.rating === 'good' ? 'bg-ok' : v.rating === 'needs_improvement' ? 'bg-med' : 'bg-crit')} aria-hidden />}</div>
      <div data-export-value className={clsx('mt-0.5 text-lg font-semibold tabular-nums', v ? ratingText[v.rating] : 'text-faint')}>{v ? fmtValue(m, v.value) : '—'}</div>
      <div className="truncate text-[11px] text-muted" data-export-skip>{CWV_LABELS[m]}</div>
    </div>
  );
}

function PageResult({ run }: { run: CwvRun }) {
  // Core Web Vitals assessment = LCP, INP and CLS (field data) all Good.
  const assessment = run.field ? worstRating([run.field.metrics.LCP?.rating, run.field.metrics.INP?.rating, run.field.metrics.CLS?.rating]) : undefined;
  return (
    <Panel
      title={<span className="break-all font-mono text-[14px]">{pageLabel(run.url)}</span>}
      subtitle={`${run.strategy === 'mobile' ? 'Mobile' : 'Desktop'} · tested ${fmtRelative(run.at)} (${fmtDateTime(run.at)} IST)${run.trigger === 'schedule' ? ' · daily test' : ''}`}
      actions={run.ok ? (
        <div className="flex items-center gap-2">
          {typeof run.performanceScore === 'number' && <Badge tone={run.performanceScore >= 90 ? 'ok' : run.performanceScore >= 50 ? 'med' : 'crit'}>Performance {run.performanceScore}</Badge>}
          {assessment && <Badge tone={assessment === 'good' ? 'ok' : 'crit'}>{assessment === 'good' ? 'Core Web Vitals passed' : 'Core Web Vitals failed'}</Badge>}
        </div>
      ) : <Badge tone="crit">Test failed</Badge>}
    >
      {!run.ok ? <p className="text-sm text-crit-ink">{run.error}</p> : (
        <div className="space-y-4">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-ink">Real users (field data)</h3>
              {run.field ? <><RatingBadge rating={run.field.overall} /><span className="text-xs text-muted">{run.field.scope === 'origin' ? 'Whole website (this page has too little Chrome traffic on its own)' : 'This page'} · 75th percentile of the last 28 days</span></> : <span className="text-xs text-muted">Chrome has too little traffic data for this page and website yet.</span>}
            </div>
            {run.field && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{CWV_METRICS.map((m) => <MetricCell key={m} m={m} v={run.field!.metrics[m]} />)}</div>}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">Lab test (this run)</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {(['LCP', 'TBT', 'CLS', 'FCP', 'TTFB'] as const).map((m) => <MetricCell key={m} m={m} v={run.lab[m]} lab />)}
            </div>
            <p className="mt-1.5 text-xs text-muted">INP needs real interactions, so the lab shows Total Blocking Time (TBT) in its place. TTFB in the lab is the server response time.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}

function History({ runs, strategy }: { runs: CwvRun[]; strategy: CwvStrategy }) {
  const urls = useMemo(() => [...new Set(runs.filter((r) => r.strategy === strategy).map((r) => r.url))].sort(), [runs, strategy]);
  const [url, setUrl] = useState('');
  const chosen = urls.includes(url) ? url : urls[0];
  const points = runs.filter((r) => r.strategy === strategy && r.url === chosen && r.ok).map((r) => ({
    at: r.at, score: r.performanceScore ?? null,
    lcp: r.field?.metrics.LCP?.value ?? r.lab.LCP?.value ?? null, inp: r.field?.metrics.INP?.value ?? null, cls: r.field?.metrics.CLS?.value ?? r.lab.CLS?.value ?? null,
  }));
  if (!urls.length) return null;
  return (
    <Panel title="History" subtitle={`${points.length} ${strategy} run(s) of the last 180 days`} actions={urls.length > 1 ? <Select aria-label="Page" value={chosen} onChange={(e) => setUrl(e.target.value)} className="max-w-xs">{urls.map((u) => <option key={u} value={u}>{pageLabel(u)}</option>)}</Select> : undefined}>
      {points.length < 2 ? <p className="text-sm text-muted">The trend appears after two or more runs of this page.</p> : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <div><p className="mb-1 text-xs font-medium text-muted">Performance score</p><TrendChart data={points} x="at" series={[{ key: 'score', label: 'Performance score' }]} yDomain={[0, 100]} height={200} xFormat={(v) => new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} /></div>
          <div><p className="mb-1 text-xs font-medium text-muted">LCP and INP (ms; field data where available)</p><TrendChart data={points} x="at" series={[{ key: 'lcp', label: 'LCP' }, { key: 'inp', label: 'INP', dashed: true }]} yFormat={msAxis} height={200} xFormat={(v) => new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} /></div>
        </div>
      )}
    </Panel>
  );
}
