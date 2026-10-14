import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { defaultConfig, SCORE_MODULE_LABELS, SCORE_MODULES, type HealthScore, type ScoreModule, type SentinelConfig } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Checkbox, DemoBadge, Mono, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { TrendChart, SERIES } from '@/components/ui/charts';
import { ChipGroup } from '@/components/ui/filters';
import { HealthScoreSummary, MODULE_LINKS, ModulePerformanceBars } from '@/components/domain/HealthScore';
import { SourceBadge } from '@/components/domain/badges';
import { fmtDateTime, fmtNum } from '@/lib/format';

export default function HealthPage() {
  const { can } = useAuth();
  const q = useApiQuery(['dashboard', 'health-score'], () => api.getHealthScore());
  const cfgQ = useApiQuery(['config'], () => api.getConfig(), { enabled: can('settings.view') });
  return (
    <div>
      <PageHeader
        title="SEO Health Score"
        description="One 0–100 number made of seven weighted module scores (PDF §14). It is a motivation instrument: fixing Criticals — especially on Tier 1 pages — moves it visibly."
        meta={<DemoBadge />}
        actions={can('settings.view') ? <Link to="/settings/thresholds" className="inline-flex h-9 items-center rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark">Scoring settings</Link> : undefined}
      />
      <Async q={q} rows={10}>{(h) => <Body h={h} cfg={cfgQ.data} cfgFromServer={!!cfgQ.data} />}</Async>
    </div>
  );
}

function Body({ h, cfg, cfgFromServer }: { h: HealthScore; cfg?: SentinelConfig; cfgFromServer: boolean }) {
  const { hash } = useLocation();
  const scoring = (cfg ?? defaultConfig()).scoring;
  const focus = hash.replace('#', '') as ScoreModule;

  // Scroll the module row into view when the URL hash names a module (e.g. from the dashboard dial).
  useEffect(() => {
    if (!focus || !SCORE_MODULES.includes(focus)) return;
    const el = document.getElementById(focus);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus]);

  const totalOpen = h.modules.reduce((a, m) => a + m.openIssues.critical + m.openIssues.medium + m.openIssues.low, 0);
  const totalCrit = h.modules.reduce((a, m) => a + m.openIssues.critical, 0);
  const weakest = [...h.modules].sort((a, b) => b.weight * (100 - b.score) - a.weight * (100 - a.score))[0];
  // Change vs. the snapshot 7 days earlier — only when that snapshot exists.
  const histQ = useApiQuery(['dashboard', 'health-history', 8], () => api.getHealthHistory(8));
  const hist = histQ.data ?? [];
  const delta7 = hist.length >= 8 ? hist.at(-1)!.score - hist.at(-8)!.score : undefined;

  return (
    <div className="space-y-5">
      <HealthScoreSummary score={h.score} modules={h.modules} delta={delta7} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Panel title="SEO Module Performance" subtitle={`Computed ${fmtDateTime(h.at)} IST from open issues · each module scored 0–100`} actions={<SourceBadge source={h.source} />}>
          <ModulePerformanceBars modules={h.modules} />
        </Panel>
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Open issues" value={totalOpen} hint="All severities, all modules" to="/issues" />
            <Stat label="Open Critical issues" value={totalCrit} tone={totalCrit ? 'crit' : 'ok'} to="/issues?severity=critical" hint="Target: zero" />
            <Stat label="Indexable pages (site size)" value={fmtNum(h.siteSize)} hint="Normalises penalties" />
            <Stat label="Most points lost" value={weakest ? weakest.label : '—'} hint={weakest ? `${(weakest.weight * (100 - weakest.score)).toFixed(1)} points below 100` : undefined} />
          </div>
          <FormulaPanel scoring={scoring} siteSize={h.siteSize} fromServer={cfgFromServer} />
        </div>
      </div>

      <ContributionTable h={h} focus={focus} scoring={scoring} />
      <TrendPanel />
      <RemediationNote h={h} scoring={scoring} />
    </div>
  );
}

// ------------------------------------------------------------------ formula

function FormulaPanel({ scoring, siteSize, fromServer }: { scoring: SentinelConfig['scoring']; siteSize: number; fromServer: boolean }) {
  return (
    <Panel title="How the score is calculated" subtitle="PDF §14 — normalisation constants are configurable (kickoff workshop)">
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">
          <strong>Health score</strong> = weighted average of the module scores:{' '}
          {SCORE_MODULES.map((m, i) => <span key={m}>{SCORE_MODULE_LABELS[m]} {Math.round(scoring.weights[m] * 100)}%{i < SCORE_MODULES.length - 1 ? ' · ' : ''}</span>)}.
        </p>
        <p className="text-ink-soft"><strong>Module score</strong> = 100 − severity-weighted open issues, normalised by site size, with Tier 1 issues weighted {scoring.tierMultipliers[1]}×:</p>
        <div className="relative overflow-x-auto rounded-ctl border border-line bg-canvas px-3 py-2">
          <Mono className="block whitespace-nowrap">penalty P = Σ severityWeight × tierMultiplier (open issues)</Mono>
          <Mono className="block whitespace-nowrap">score = 100 × (1 − P ÷ (P + K × siteSize))</Mono>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <div><dt className="text-xs text-muted">Critical weight</dt><dd className="tabular-nums font-medium">{scoring.severityWeights.critical}</dd></div>
          <div><dt className="text-xs text-muted">Medium weight</dt><dd className="tabular-nums font-medium">{scoring.severityWeights.medium}</dd></div>
          <div><dt className="text-xs text-muted">Low weight</dt><dd className="tabular-nums font-medium">{scoring.severityWeights.low}</dd></div>
          <div><dt className="text-xs text-muted">Tier multipliers</dt><dd className="tabular-nums font-medium">T1 ×{scoring.tierMultipliers[1]} · T2 ×{scoring.tierMultipliers[2]} · T3 ×{scoring.tierMultipliers[3]}</dd></div>
          <div><dt className="text-xs text-muted">K (normalizationK)</dt><dd className="tabular-nums font-medium">{scoring.normalizationK}</dd></div>
          <div><dt className="text-xs text-muted">Site size</dt><dd className="tabular-nums font-medium">{fmtNum(siteSize)}</dd></div>
          <div className="col-span-2"><dt className="text-xs text-muted">K × site size</dt><dd className="tabular-nums font-medium">{fmtNum(scoring.normalizationK * siteSize, 1)} penalty points absorbed</dd></div>
        </dl>
        <p className="text-xs text-muted">Opportunities and closed, verified, superseded or not-an-issue findings carry no penalty. Template-level parents count once; their superseded children do not.{!fromServer && ' Your role cannot read the live configuration, so default values are shown.'}</p>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ contribution table

function ContributionTable({ h, focus, scoring }: { h: HealthScore; focus: string; scoring: SentinelConfig['scoring'] }) {
  return (
    <Panel title="Module contributions" subtitle="Contribution = module score × weight. Points lost = (100 − score) × weight." bodyClassName="p-0">
      <div className="relative overflow-x-auto">
        <table className="relative w-full min-w-[760px] text-sm">
          <caption className="sr-only">Health score contribution by module</caption>
          <thead>
            <tr className="border-b border-line bg-raised/70 text-left text-xs text-muted">
              <th scope="col" className="px-4 py-2 font-medium">Module</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Weight</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Score</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Contribution</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Points lost</th>
              <th scope="col" className="px-3 py-2 font-medium">Open C / M / L</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Penalty P</th>
              <th scope="col" className="px-3 py-2 font-medium">Drill down</th>
            </tr>
          </thead>
          <tbody>
            {h.modules.map((m) => (
              <tr key={m.module} id={m.module} className={clsx('scroll-mt-24 border-b border-line last:border-0', focus === m.module && 'bg-signal-tint/60')}>
                <th scope="row" className="px-4 py-2.5 text-left font-medium">
                  {m.label}
                </th>
                <td className="px-3 py-2.5 text-right tabular-nums">{Math.round(m.weight * 100)}%</td>
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{m.score.toFixed(1)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{m.contribution.toFixed(1)}</td>
                <td className={clsx('px-3 py-2.5 text-right tabular-nums', m.weight * (100 - m.score) >= 3 && 'font-medium text-crit-ink')}>{(m.weight * (100 - m.score)).toFixed(1)}</td>
                <td className="px-3 py-2.5 tabular-nums">
                  <span className={m.openIssues.critical ? 'font-medium text-crit-ink' : ''}>{m.openIssues.critical}</span> / <span className={m.openIssues.medium ? 'text-med-ink' : ''}>{m.openIssues.medium}</span> / {m.openIssues.low}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums" title={`${m.penalty} ÷ (${m.penalty} + ${scoring.normalizationK} × ${h.siteSize})`}>{fmtNum(m.penalty, 1)}</td>
                <td className="px-3 py-2.5 text-xs whitespace-nowrap">
                  <Link to={MODULE_LINKS[m.module].issues} className="text-signal hover:underline">Issues</Link>
                  <span className="text-faint"> · </span>
                  <Link to={MODULE_LINKS[m.module].href} className="text-signal hover:underline">Module</Link>
                </td>
              </tr>
            ))}
            <tr className="bg-canvas/60">
              <th scope="row" className="px-4 py-2.5 text-left font-semibold">Health score</th>
              <td className="px-3 py-2.5 text-right tabular-nums">{Math.round(h.modules.reduce((a, m) => a + m.weight, 0) * 100)}%</td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{h.score.toFixed(1)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{h.modules.reduce((a, m) => a + m.contribution, 0).toFixed(1)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{h.modules.reduce((a, m) => a + m.weight * (100 - m.score), 0).toFixed(1)}</td>
              <td className="px-3 py-2.5 tabular-nums">{h.modules.reduce((a, m) => a + m.openIssues.critical, 0)} / {h.modules.reduce((a, m) => a + m.openIssues.medium, 0)} / {h.modules.reduce((a, m) => a + m.openIssues.low, 0)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(h.modules.reduce((a, m) => a + m.penalty, 0), 1)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ trend

const RANGES = [30, 60, 90] as const;

function TrendPanel() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [showModules, setShowModules] = useState(false);
  const [mods, setMods] = useState<ScoreModule[]>(['technical', 'onpage', 'content_ai']);
  const q = useApiQuery(['dashboard', 'health-history', days], () => api.getHealthHistory(days));
  return (
    <Panel
      title="Score trend"
      subtitle="Daily snapshot of the health score"
      actions={
        <div className="flex rounded-ctl border border-line-strong" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)} className={clsx('h-8 px-3 text-xs first:rounded-l-ctl last:rounded-r-ctl', days === r ? 'bg-signal-tint text-signal-dark' : 'bg-surface text-ink-soft hover:bg-raised')}>{r} days</button>
          ))}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Checkbox checked={showModules} onChange={setShowModules} label="Show module trend lines" />
        {showModules && <ChipGroup label="Modules" options={SCORE_MODULES.map((m) => ({ value: m, label: SCORE_MODULE_LABELS[m] }))} value={mods} onChange={setMods} />}
      </div>
      <Async q={q} rows={5} empty={(d) => d.length === 0 && <p className="py-8 text-center text-sm text-muted">No score history yet — a snapshot is stored after each daily run.</p>}>
        {(pts) => <TrendBody pts={pts} showModules={showModules} mods={mods} />}
      </Async>
    </Panel>
  );
}

function TrendBody({ pts, showModules, mods }: { pts: Awaited<ReturnType<typeof api.getHealthHistory>>; showModules: boolean; mods: ScoreModule[] }) {
  const data = useMemo(() => pts.map((p) => ({ date: p.date, score: p.score, ...p.modules })), [pts]);
  const first = pts[0]?.score ?? 0;
  const last = pts.at(-1)?.score ?? 0;
  const delta = last - first;
  const series = [
    { key: 'score', label: 'Health score', color: '#7650D8' },
    ...(showModules ? mods.map((m) => ({ key: m, label: SCORE_MODULE_LABELS[m], color: SERIES[SCORE_MODULES.indexOf(m) % SERIES.length], dashed: true })) : []),
  ];
  const sources = [...new Set(pts.map((p) => p.source))];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Over {pts.length} days:</span>
        <Badge tone={delta >= 0 ? 'ok' : 'crit'}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)} points</Badge>
        <span className="text-xs text-muted">{first.toFixed(1)} → {last.toFixed(1)}</span>
        <span className="ml-auto flex gap-1">{sources.map((s) => <SourceBadge key={s} source={s} />)}</span>
      </div>
      <TrendChart data={data} x="date" series={series} height={260} yFormat={(v) => v.toFixed(1)} />
    </div>
  );
}

// ------------------------------------------------------------------ remediation effect

function RemediationNote({ h, scoring }: { h: HealthScore; scoring: SentinelConfig['scoring'] }) {
  // Illustrate with the live numbers: what closing one Tier 1 Critical in the top-weighted module would do.
  const m = h.modules.find((x) => x.openIssues.critical > 0) ?? h.modules[0];
  const unit = scoring.severityWeights.critical * scoring.tierMultipliers[1];
  const kN = scoring.normalizationK * Math.max(1, h.siteSize);
  const newP = Math.max(0, m.penalty - unit);
  const newScore = 100 * (1 - newP / (newP + kN));
  const moduleGain = newScore - m.score;
  const totalW = h.modules.reduce((a, x) => a + x.weight, 0) || 1;
  const overallGain = (moduleGain * m.weight) / totalW;
  return (
    <Notice tone="signal" title="Verified remediation raises the score">
      <p>
        The score only changes when issues close, and issues close only after automated re-verification finds 0 failing pages — an issue marked Fixed does not move it yet.
        {m.penalty >= unit && (
          <> With today’s numbers, verifying one Tier 1 Critical in {m.label} removes {unit} penalty points ({scoring.severityWeights.critical} × {scoring.tierMultipliers[1]}), lifting that module by about {moduleGain.toFixed(1)} and the overall score by about {overallGain.toFixed(2)}.</>
        )}
      </p>
      <p className="mt-1"><Link to="/verification" className="font-medium underline">See verification results</Link> · <Link to="/issues?severity=critical" className="font-medium underline">Open Critical issues</Link></p>
    </Notice>
  );
}
