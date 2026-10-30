import { useMemo } from 'react';
import { defaultConfig, type CwvTemplateMetric } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { ModuleView } from '@/components/domain/ModuleView';
import { Async, Badge, EmptyState, Notice, Panel } from '@/components/ui/primitives';
import { SourceBadge } from '@/components/domain/badges';
import { Bullets, PanelLink, TONE_TEXT, ratingTone, useConfigQuery, SrOnly } from '@/components/modules/shared';
import { fmtMs } from '@/lib/format';

export default function PerformancePage() {
  return (
    <ModuleView
      module="performance"
      description="Core Web Vitals per template and device from CrUX field data, daily PageSpeed lab runs, app bloat, image weight and third-party payload (PDF §4.4)."
      headerActions={<PanelLink to="/modules/technical">Technical SEO overview</PanelLink>}
      extra={<CwvPanels />}
    />
  );
}

interface Thresholds { lcp: number; lcpPoor: number; inp: number; inpPoor: number; cls: number; clsPoor: number; psiReg: number; tpGrowth: number }

function useThresholds(): { t: Thresholds; fromConfig: boolean } {
  const { q } = useConfigQuery();
  return useMemo(() => {
    const src = q.data?.thresholds ?? defaultConfig().thresholds;
    return {
      fromConfig: !!q.data,
      t: { lcp: src.lcpMs, lcpPoor: src.lcpPoorMs, inp: src.inpMs, inpPoor: src.inpPoorMs, cls: src.cls, clsPoor: src.clsPoor, psiReg: src.psiRegressionPoints, tpGrowth: src.thirdPartyWeeklyGrowthPct },
    };
  }, [q.data]);
}

function CwvPanels() {
  const q = useApiQuery(['cwv'], () => api.getCwv());
  const { t, fromConfig } = useThresholds();
  return (
    <div className="space-y-5">
      <Panel
        title="Core Web Vitals by template and device"
        subtitle={`p75 field values · good ≤ LCP ${fmtMs(t.lcp)}, INP ${t.inp}ms, CLS ${t.cls} · poor > ${fmtMs(t.lcpPoor)}, ${t.inpPoor}ms, ${t.clsPoor}${fromConfig ? '' : ' (PDF defaults)'}`}
        bodyClassName="p-0"
      >
        <Async q={q} rows={6} empty={(rows) => (!rows.length ? <EmptyState title="No Core Web Vitals data yet" description="Connect the PageSpeed Insights / CrUX API key in Integrations." /> : false)}>
          {(rows) => <CwvTable rows={rows} t={t} />}
        </Async>
      </Panel>
      <Panel title="Field data vs. lab data">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <p className="mb-1 text-sm font-medium">Field — Chrome UX Report (PERF-CRUX)</p>
            <Bullets items={['Real-user p75 over a rolling 28 days, per origin and per template URL group.', 'This is what Google uses for ranking. Critical if any template is Poor; Medium if Needs improvement.', 'Slow to react: a fix shows up over two to four weeks.']} />
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">Lab — PageSpeed Insights (PERF-PSI)</p>
            <Bullets items={['Daily mobile + desktop runs on the homepage, top 5 collections and top 5 products.', `Synthetic and noisy, but immediate: a drop of more than ${t.psiReg} points vs. the 7-day average raises a regression alert.`, 'Used to spot a new app or script the day it lands (PERF-RENDER-BLOCKING).']} />
          </div>
        </div>
        <div className="mt-4">
          <Notice tone="caution" title="Requires the PageSpeed Insights / CrUX API key">Both field and lab figures come from Google's PSI and CrUX APIs. Until the key is configured in Integrations, this screen has no live values. <PanelLink to="/settings/integrations">Integrations</PanelLink></Notice>
        </div>
      </Panel>
    </div>
  );
}

function CwvTable({ rows, t }: { rows: CwvTemplateMetric[]; t: Thresholds }) {
  return (
    <>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <caption className="sr-only">Core Web Vitals by template and device</caption>
          <thead>
            <tr className="border-b border-line bg-raised/70 text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Template</th>
              <th className="px-3 py-2 font-medium">Device</th>
              <th className="px-3 py-2 font-medium">LCP</th>
              <th className="px-3 py-2 font-medium">INP</th>
              <th className="px-3 py-2 font-medium">CLS</th>
              <th className="px-3 py-2 font-medium">Field status</th>
              <th className="px-3 py-2 font-medium">PSI vs 7-day avg</th>
              <th className="px-3 py-2 font-medium">Third-party JS vs week ago</th>
              <th className="px-3 py-2 font-medium"><SrOnly>Source</SrOnly></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const psiDelta = c.psiScore !== undefined && c.psi7dAvg !== undefined ? c.psiScore - c.psi7dAvg : undefined;
              const regression = psiDelta !== undefined && -psiDelta > t.psiReg;
              const tpPct = c.thirdPartyKb !== undefined && c.thirdPartyKbWeekAgo ? ((c.thirdPartyKb - c.thirdPartyKbWeekAgo) / c.thirdPartyKbWeekAgo) * 100 : undefined;
              const tpFlag = tpPct !== undefined && tpPct > t.tpGrowth;
              return (
                <tr key={`${c.template}-${c.device}`} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 capitalize">{c.template}</td>
                  <td className="px-3 py-2 capitalize text-muted">{c.device}</td>
                  <td className={`px-3 py-2 tabular-nums ${TONE_TEXT[ratingTone(c.lcpMs, t.lcp, t.lcpPoor)]}`}>{fmtMs(c.lcpMs)}</td>
                  <td className={`px-3 py-2 tabular-nums ${TONE_TEXT[ratingTone(c.inpMs, t.inp, t.inpPoor)]}`}>{c.inpMs}ms</td>
                  <td className={`px-3 py-2 tabular-nums ${TONE_TEXT[ratingTone(c.cls, t.cls, t.clsPoor)]}`}>{c.cls.toFixed(2)}</td>
                  <td className="px-3 py-2"><Badge tone={c.status === 'poor' ? 'crit' : c.status === 'needs_improvement' ? 'med' : 'ok'}>{c.status === 'needs_improvement' ? 'Needs improvement' : c.status === 'poor' ? 'Poor' : 'Good'}</Badge></td>
                  <td className="px-3 py-2 tabular-nums">
                    {c.psiScore === undefined ? '—' : (
                      <span className="inline-flex items-center gap-1.5">
                        <span className={regression ? 'font-semibold text-crit-ink' : ''}>{c.psiScore}</span>
                        <span className="text-xs text-muted">vs {c.psi7dAvg}</span>
                        {psiDelta !== undefined && psiDelta !== 0 && <span className={`text-xs ${psiDelta < 0 ? 'text-crit-ink' : 'text-ok-ink'}`}>{psiDelta > 0 ? '+' : ''}{psiDelta.toFixed(0)}</span>}
                        {regression && <Badge tone="crit">Regression</Badge>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {c.thirdPartyKb === undefined ? '—' : (
                      <span className="inline-flex items-center gap-1.5">
                        <span>{c.thirdPartyKb} KB</span>
                        <span className="text-xs text-muted">vs {c.thirdPartyKbWeekAgo ?? '—'}</span>
                        {tpPct !== undefined && <span className={`text-xs ${tpFlag ? 'font-semibold text-crit-ink' : tpPct > 0 ? 'text-med-ink' : 'text-ok-ink'}`}>{tpPct > 0 ? '+' : ''}{tpPct.toFixed(1)}%</span>}
                        {tpFlag && <Badge tone="med">Over {t.tpGrowth}%/week</Badge>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2"><SourceBadge source={c.source} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-xs text-muted">Colour key: <span className="text-ok-ink">good</span> · <span className="text-med-ink">needs improvement</span> · <span className="font-semibold text-crit-ink">poor</span>. Regression = PSI score more than {t.psiReg} points below its 7-day average (PERF-PSI). Third-party growth over {t.tpGrowth}% per week raises PERF-THIRD-PARTY.</p>
    </>
  );
}
