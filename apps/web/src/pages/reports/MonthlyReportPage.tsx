import { Link } from 'react-router-dom';
import type { MonthlyReport } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { TrendChart } from '@/components/ui/charts';
import { ReportActions, ReportMetaPanel } from '@/components/reports/ReportParts';
import { fmtDate, fmtNum } from '@/lib/format';

const NA_GSC = 'Not available — needs GSC/GA4 history';

export default function MonthlyReportPage() {
  const q = useApiQuery(['digest', 'monthly'], () => api.getMonthlyReport());
  return (
    <div className="print:text-[12px]">
      <PrintStyles />
      <PageHeader
        title="Monthly executive report"
        description="One-page summary for leadership (PDF §12.5), generated from the audit log so every figure is evidence-backed (PDF §17)."
        meta={<>{q.data && <span className="text-xs text-muted">{fmtDate(q.data.meta.periodStart)} → {fmtDate(q.data.meta.periodEnd)}</span>}</>}
        actions={<ReportActions kind="monthly" print />}
      />
      <Async q={q} rows={12}>{(r) => <Body r={r} />}</Async>
    </div>
  );
}

/** Hides app chrome (sidebar, top bar) when printing so the report fits one page. Scoped to this page. */
function PrintStyles() {
  return (
    <style>{`@media print {
  aside, header.h-14, [aria-label="Breadcrumb"] { display: none !important; }
  .h-screen { height: auto !important; overflow: visible !important; }
  #main { overflow: visible !important; }
  body { background: #fff !important; }
}`}</style>
  );
}

/** null → explicit "not available"; never rendered as 0. */
function Metric({ label, value, format, hint }: { label: string; value: number | null; format: (n: number) => string; hint?: string }) {
  return (
    <div className="rounded-panel border border-line bg-surface px-4 py-3 shadow-card print:break-inside-avoid">
      <div className="text-xs text-muted">{label}</div>
      {value === null ? <div className="mt-1 text-sm font-medium text-muted">{NA_GSC}</div> : <div className="mt-1 text-2xl font-semibold tabular-nums">{format(value)}</div>}
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

function pctChange(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
}

function Body({ r }: { r: MonthlyReport }) {
  const o = r.organic;
  const inr = (n: number) => `₹${fmtNum(n)}`;
  const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
  const trend = r.healthTrend.map((h) => ({ date: h.date, score: h.score }));
  const h0 = trend[0]?.score;
  const h1 = trend.at(-1)?.score;
  const shares = Object.entries(r.aiMentionShare).sort((a, b) => b[1] - a[1]);
  const maxShare = Math.max(1, ...shares.map(([, v]) => v));
  return (
    <div className="space-y-5">
      <Panel title="Organic traffic & revenue" subtitle="vs last month and year-over-year. Missing history is shown as not available, never as zero.">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Metric label="Organic clicks (30 days)" value={o.clicks} format={fmtNum} hint="Google Search Console" />
          <Metric label="Clicks vs last month" value={pctChange(o.clicks, o.clicksPrevMonth)} format={pct} />
          <Metric label="Clicks year-over-year" value={pctChange(o.clicks, o.clicksYoY)} format={pct} />
          <Metric label="Organic revenue (30 days)" value={o.revenue} format={inr} hint="GA4" />
          <Metric label="Revenue vs last month" value={pctChange(o.revenue, o.revenuePrevMonth)} format={pct} />
          <Metric label="Revenue year-over-year" value={pctChange(o.revenue, o.revenueYoY)} format={pct} />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Health-score trend" subtitle={h0 !== undefined && h1 !== undefined ? `${h0.toFixed(1)} → ${h1.toFixed(1)} over the period` : 'No history in this period'}>
          {trend.length > 1 ? <TrendChart data={trend} x="date" series={[{ key: 'score', label: 'Health score' }]} height={200} area yFormat={(v) => v.toFixed(0)} /> : <p className="text-sm text-muted">Not enough history to chart yet.</p>}
        </Panel>
        <Panel title="Issues opened & closed" subtitle="Counted from audit-log events (issue.detected, verification passed)">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Opened" value={fmtNum(r.issuesOpened)} tone="med" />
            <Stat label="Closed (verified)" value={fmtNum(r.issuesClosed)} tone="ok" />
          </div>
          <p className="mt-3 text-xs text-muted">Net change: {r.issuesClosed - r.issuesOpened >= 0 ? `${r.issuesClosed - r.issuesOpened} fewer open issues` : `${r.issuesOpened - r.issuesClosed} more open issues`}.</p>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Money-keyword ranking movement" subtitle="Keyword set from Settings → Thresholds (finalised in the kickoff workshop)" bodyClassName="p-0">
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <caption className="sr-only">Money keyword positions</caption>
              <thead><tr className="border-b border-line bg-raised/70 text-left text-xs text-muted"><th scope="col" className="px-4 py-2 font-medium">Keyword</th><th scope="col" className="px-3 py-2 font-medium">Position</th><th scope="col" className="px-3 py-2 font-medium">Last month</th><th scope="col" className="px-3 py-2 font-medium">Movement</th></tr></thead>
              <tbody>
                {r.moneyKeywords.map((k) => {
                  const mv = k.position !== null && k.prevPosition !== null ? k.prevPosition - k.position : null;
                  return (
                    <tr key={k.keyword} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">{k.keyword}</td>
                      <td className="px-3 py-2 tabular-nums">{k.position ?? <span className="text-xs text-muted">needs GSC</span>}</td>
                      <td className="px-3 py-2 tabular-nums">{k.prevPosition ?? <span className="text-xs text-muted">needs GSC</span>}</td>
                      <td className="px-3 py-2 tabular-nums">{mv === null ? <span className="text-xs text-muted">needs GSC</span> : <span className={mv > 0 ? 'text-ok-ink' : mv < 0 ? 'text-crit-ink' : ''}>{mv > 0 ? `▲ ${mv}` : mv < 0 ? `▼ ${-mv}` : '—'}</span>}</td>
                    </tr>
                  );
                })}
                {!r.moneyKeywords.length && <tr><td colSpan={4} className="px-4 py-3 text-sm text-muted">No money keywords configured. <Link to="/settings/thresholds" className="text-signal hover:underline">Add them</Link>.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="AI-mention share vs competitors" subtitle="Latest weekly AI-visibility panel (PDF §8)">
          {shares.length ? (
            <ul className="space-y-2">
              {shares.map(([name, v]) => (
                <li key={name} className="grid grid-cols-[130px_minmax(0,1fr)_48px] items-center gap-2 text-sm">
                  <span className="truncate">{name}</span>
                  <span className="h-2 rounded-full bg-line" aria-hidden><span className="block h-2 rounded-full bg-opp" style={{ width: `${(v / maxShare) * 100}%` }} /></span>
                  <span className="text-right tabular-nums">{v}%</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Not available — needs the AI-visibility panel (OpenAI / Gemini / Perplexity API keys).</p>}
        </Panel>
      </div>

      <Panel title="3 recommended strategic actions">
        <ol className="list-decimal space-y-2 pl-5 text-sm">{r.strategicActions.map((a) => <li key={a}>{a}</li>)}</ol>
      </Panel>

      <Notice tone="signal" title="Evidence basis">{r.evidenceBasis} <Link to="/audit" className="underline print:hidden">Open the audit log</Link></Notice>

      <div className="print:break-before-page">
        <ReportMetaPanel meta={r.meta} schedule={`Scheduled monthly (day set in Settings → Notifications)`} />
      </div>
    </div>
  );
}
