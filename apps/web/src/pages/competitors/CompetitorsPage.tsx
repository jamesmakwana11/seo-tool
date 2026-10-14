import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DataSource } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, DemoBadge, EmptyState, Notice, PageHeader, Panel, type Tone } from '@/components/ui/primitives';
import { SERIES, Sparkline, TrendChart, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM } from '@/components/ui/charts';
import { SourceBadge } from '@/components/domain/badges';
import { fmtNum } from '@/lib/format';

type Competitor = { domain: string; name: string; visibility: number[]; cwv: string; referringDomains: number; contentVelocity: number; source: DataSource };

const CWV: Record<string, { label: string; tone: Tone }> = {
  good: { label: 'Good', tone: 'ok' },
  needs_improvement: { label: 'Needs improvement', tone: 'med' },
  poor: { label: 'Poor', tone: 'crit' },
};

export default function CompetitorsPage() {
  const q = useApiQuery(['opportunities', 'competitors'], () => api.getCompetitors());
  return (
    <div>
      <PageHeader
        title="Competitor view"
        description="Side-by-side organic visibility, Core Web Vitals, referring-domain strength and content velocity against the named competitor set (PDF §12.3)."
        meta={<DemoBadge />}
      />
      <Async q={q} rows={10} empty={(rows) => rows.length === 0 && <Panel><EmptyState title="No competitors configured" description="Add 3–5 competitors in Settings → Thresholds." /></Panel>}>
        {(rows) => <Body rows={rows} />}
      </Async>
    </div>
  );
}

function weekLabel(i: number, n: number) {
  const d = new Date();
  d.setDate(d.getDate() - 7 * (n - 1 - i));
  return d.toISOString().slice(0, 10);
}

function Body({ rows }: { rows: Competitor[] }) {
  const { can } = useAuth();
  const self = rows[0];
  const weeks = Math.max(...rows.map((r) => r.visibility.length));
  const trend = Array.from({ length: weeks }, (_, i) => {
    const point: Record<string, string | number> = { week: weekLabel(i, weeks) };
    rows.forEach((r) => { if (r.visibility[i] !== undefined) point[r.domain] = r.visibility[i]; });
    return point;
  });
  const color = (i: number) => (i === 0 ? SERIES[0] : SERIES[(i % (SERIES.length - 1)) + 1]);
  const refData = rows.map((r) => ({ name: r.name, referringDomains: r.referringDomains }));
  const last = (r: Competitor) => r.visibility.at(-1) ?? 0;
  const delta = (r: Competitor) => (r.visibility.length > 1 ? last(r) - r.visibility[0] : 0);

  return (
    <div className="space-y-5">
      <Notice tone="demo" demoData title="Placeholder competitors and sample data">
        Competitor names are placeholders until the kickoff workshop finalises the list of 3–5 competitors{can('settings.view') ? <> — configure them in <Link to="/settings/thresholds" className="underline">Settings → Thresholds</Link></> : ' (configurable in Settings → Thresholds)'}. Visibility, backlink and content-velocity figures require the Ahrefs or Semrush API; CWV comparisons require CrUX/PageSpeed Insights. Everything below is DEMO data.
      </Notice>

      <Panel title="Side-by-side comparison" subtitle={`${self?.name ?? 'DeoDap'} first, then competitors`} bodyClassName="p-0">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Competitor comparison</caption>
            <thead>
              <tr className="border-b border-line bg-raised/70 text-left text-xs text-muted">
                <th scope="col" className="px-4 py-2 font-medium">Site</th>
                <th scope="col" className="px-3 py-2 font-medium">Visibility (latest)</th>
                <th scope="col" className="px-3 py-2 font-medium">8-week change</th>
                <th scope="col" className="px-3 py-2 font-medium">Trend</th>
                <th scope="col" className="px-3 py-2 font-medium">Core Web Vitals</th>
                <th scope="col" className="px-3 py-2 font-medium">Referring domains</th>
                <th scope="col" className="px-3 py-2 font-medium">Content velocity</th>
                <th scope="col" className="px-3 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const d = delta(r);
                const cwv = CWV[r.cwv] ?? { label: r.cwv.replace(/_/g, ' '), tone: 'neutral' as Tone };
                return (
                  <tr key={r.domain} className={`border-b border-line last:border-0 ${i === 0 ? 'bg-signal-tint/40' : ''}`}>
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <span className="font-medium text-ink">{r.name}</span>{i === 0 && <Badge tone="signal" className="ml-1.5">You</Badge>}
                      <span className="block font-mono text-xs text-muted">{r.domain}</span>
                    </th>
                    <td className="px-3 py-2.5 tabular-nums">
                      {last(r)}
                      {i > 0 && self && <span className={`ml-1.5 text-xs ${last(r) > last(self) ? 'text-crit-ink' : 'text-ok-ink'}`}>{last(r) > last(self) ? `+${last(r) - last(self)} vs you` : `${last(r) - last(self)} vs you`}</span>}
                    </td>
                    <td className={`px-3 py-2.5 tabular-nums ${d > 0 ? 'text-ok-ink' : d < 0 ? 'text-crit-ink' : 'text-muted'}`}>{d > 0 ? '+' : ''}{d}</td>
                    <td className="px-3 py-2.5"><Sparkline values={r.visibility} color={color(i)} /></td>
                    <td className="px-3 py-2.5"><Badge tone={cwv.tone}>{cwv.label}</Badge></td>
                    <td className="px-3 py-2.5 tabular-nums">{fmtNum(r.referringDomains)}</td>
                    <td className="px-3 py-2.5 tabular-nums">{r.contentVelocity}<span className="ml-1 text-xs text-muted">pages / month</span></td>
                    <td className="px-3 py-2.5"><SourceBadge source={r.source} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-2 text-xs text-muted">Visibility is a relative index (share of tracked keywords weighted by position). Content velocity counts new indexable pages per month.</p>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Organic visibility — last 8 weeks" subtitle="Weekly visibility index">
          <TrendChart data={trend} x="week" series={rows.map((r, i) => ({ key: r.domain, label: r.name, color: color(i), dashed: i > 0 }))} height={260} />
        </Panel>
        <Panel title="Referring domains" subtitle="Total unique referring domains">
          <div role="img" aria-label={`Referring domains: ${rows.map((r) => `${r.name} ${r.referringDomains}`).join(', ')}`}>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={refData} layout="vertical" margin={{ top: 6, right: 16, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#F1ECFA" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: '#777487' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtNum(v)} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#777487' }} width={110} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: number) => fmtNum(v)} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(118,80,216,0.06)' }} />
                <Bar dataKey="referringDomains" name="Referring domains" maxBarSize={26} isAnimationActive={false}>
                  {refData.map((r, i) => <Cell key={r.name} fill={i === 0 ? SERIES[0] : '#C9C4D6'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-muted">The 30-day referring-domain trend lives on <Link to="/modules/offpage" className="text-signal hover:underline">Off-page SEO</Link>; the domains linking to competitors but not DeoDap are on <Link to="/opportunities/link-building" className="text-signal hover:underline">Link building</Link>.</p>
        </Panel>
      </div>
    </div>
  );
}
