import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Gauge, TrendingDown, TrendingUp } from 'lucide-react';
import type { ModuleScore, ScoreModule } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { CountUp, useMounted, useReducedMotion } from '@/lib/motion';

/** Status colour for a score (used for numbers that need a good/bad cue). */
export function scoreColor(s: number): string {
  if (s >= 85) return '#5E3CC2';
  if (s >= 70) return '#7650D8';
  if (s >= 50) return '#B07514';
  return '#C23A4A';
}

/** Where each score bucket's findings live. `issues` filters the issue list to the same bucket. */
export const MODULE_LINKS: Record<ScoreModule, { href: string; issues: string }> = {
  technical: { href: '/modules/technical', issues: '/issues?module=technical' },
  onpage: { href: '/modules/onpage', issues: '/issues?module=onpage' },
  content_ai: { href: '/modules/content', issues: '/issues?module=content,ai_compliance' },
  performance: { href: '/modules/performance', issues: '/issues?module=performance' },
  offpage: { href: '/modules/offpage', issues: '/issues?module=offpage' },
  aeo: { href: '/modules/aeo', issues: '/issues?module=aeo' },
  geo: { href: '/modules/geo', issues: '/issues?module=geo' },
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** A 0–100 horizontal bar: violet fill on a lavender track. Grows in once on first render unless reduced motion is set. */
function ScoreBar({ value, thick }: { value: number; thick?: boolean }) {
  const mounted = useMounted();
  const reduced = useReducedMotion();
  const w = mounted || reduced ? clamp(value) : 0;
  return (
    <span className={`block w-full overflow-hidden rounded-full bg-[#EEE8FB] ${thick ? 'h-2.5' : 'h-2'}`} aria-hidden>
      <span
        className="block h-full rounded-full bg-gradient-to-r from-[#9474E8] to-[#7650D8]"
        style={{ width: `${w}%`, transition: reduced ? undefined : 'width 700ms cubic-bezier(.2,.7,.2,1)' }}
      />
    </span>
  );
}

/**
 * The overall SEO Health Score: the weighted average of the seven module scores, exactly as the API computes it.
 * `delta` is shown only when the caller has an earlier snapshot to compare against.
 */
export function HealthScoreSummary({ score, modules, delta, deltaLabel = 'vs 7 days ago', to }: {
  score: number; modules: ModuleScore[]; delta?: number; deltaLabel?: string; to?: string;
}) {
  // Same arithmetic as the Health page's "Most points lost": weight × (100 − score).
  const weakest = [...modules].sort((a, b) => b.weight * (100 - b.score) - a.weight * (100 - a.score))[0];
  return (
    <section aria-labelledby="health-summary-title" className="rounded-panel border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-raised text-signal" aria-hidden><Gauge className="h-[18px] w-[18px]" /></span>
          <div>
            <h2 id="health-summary-title" className="text-[15px] font-semibold tracking-[-0.012em] text-ink">SEO Health Score</h2>
            <p className="text-xs text-muted">Weighted average of {modules.length} module scores</p>
          </div>
        </div>
        {to && <Link to={to} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-signal transition-colors hover:bg-raised">Detailed breakdown <ArrowUpRight className="h-4 w-4" /></Link>}
      </div>

      <div className="mt-4 grid grid-cols-1 items-end gap-x-8 gap-y-4 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <p className="leading-none" aria-label={`SEO Health Score ${score.toFixed(1)} out of 100`}>
            <span className="text-[40px] font-semibold tracking-[-0.035em] tabular-nums text-ink"><CountUp value={score} decimals={1} duration={700} /></span>
            <span className="ml-1 text-lg font-medium text-faint">/ 100</span>
          </p>
          {delta !== undefined && (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${delta >= 0 ? 'bg-ok-tint text-ok-ink' : 'bg-crit-tint text-crit-ink'}`}>
              {delta >= 0 ? <TrendingUp className="h-3.5 w-3.5" aria-hidden /> : <TrendingDown className="h-3.5 w-3.5" aria-hidden />}
              {delta >= 0 ? '+' : '−'}{Math.abs(delta).toFixed(1)}
              <span className="font-normal opacity-80">{deltaLabel}</span>
            </span>
          )}
        </div>
        <div className="min-w-0">
          <ScoreBar value={score} thick />
          <div className="mt-1.5 flex justify-between text-[11px] tabular-nums text-faint" aria-hidden><span>0</span><span>50</span><span>100</span></div>
        </div>
      </div>

      {weakest && weakest.score < 100 && (
        <p className="mt-3 border-t border-line pt-3 text-[13px] text-muted">
          Most points lost: <span className="font-medium text-ink">{weakest.label}</span>{' '}
          <span className="tabular-nums">({(weakest.weight * (100 - weakest.score)).toFixed(1)} points below a perfect score)</span>
        </p>
      )}
    </section>
  );
}

/**
 * The seven module scores as horizontal bars on one shared 0–100 scale. Each row links to that module's findings
 * (or, for roles that cannot open module pages, to its row on the Health page).
 */
export function ModulePerformanceBars({ modules }: { modules: ModuleScore[] }) {
  const { can } = useAuth();
  const canOpen = can('modules.view');
  return (
    <ul className="-mx-2 divide-y divide-line/70">
      {modules.map((m) => {
        const href = canOpen ? MODULE_LINKS[m.module].href : `/health#${m.module}`;
        const { critical, medium, low } = m.openIssues;
        return (
          <li key={m.module}>
            <Link
              to={href}
              aria-label={`${m.label}: ${m.score.toFixed(1)} out of 100, weight ${Math.round(m.weight * 100)}%, ${critical} critical, ${medium} medium, ${low} low open issues. Open findings.`}
              className="module-row group rounded-xl px-2 py-3 transition-colors duration-200 hover:bg-raised focus-visible:bg-raised"
            >
              <span className="[grid-area:name] min-w-0 text-sm font-medium text-ink">
                {m.label}
                <span className="ml-1.5 inline-block whitespace-nowrap text-[11px] font-normal tabular-nums text-faint">{Math.round(m.weight * 100)}% weight</span>
              </span>
              <span className="[grid-area:score] flex items-center justify-end gap-1 whitespace-nowrap">
                <span className="text-[15px] font-semibold tabular-nums text-ink">{m.score.toFixed(1)}</span>
                <span className="text-[11px] text-faint">/100</span>
                <ChevronRight className="h-4 w-4 text-faint transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-signal" aria-hidden />
              </span>
              <span className="[grid-area:bar] self-center"><ScoreBar value={m.score} /></span>
              <span className="[grid-area:meta] flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted">
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-crit" aria-hidden /><span className={critical ? 'font-medium text-crit-ink' : undefined}>{critical} critical</span></span>
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-med" aria-hidden />{medium} medium</span>
                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#B6A0F5]" aria-hidden />{low} low</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
