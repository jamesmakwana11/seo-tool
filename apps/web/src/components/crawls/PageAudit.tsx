import clsx from 'clsx';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { PAGE_AUDIT_AREA_LABELS, localizeLocation, pageCheckFix, type PageAudit, type PageAuditArea, type PageAuditStatus } from '@sentinel/shared';
import { useSitePlatform } from '@/websites/WebsiteContext';

/** Page audit score 0–100: poor under 50, fair 50–79, good 80+. */
export function ScoreBadge({ score, large }: { score?: number | null; large?: boolean }) {
  if (score === undefined || score === null) return <span className="text-xs text-faint" title="Not scored: not an HTML page, redirected or not fetched">—</span>;
  const tone = score < 50 ? 'bg-crit-tint text-crit-ink border-crit/25' : score < 80 ? 'bg-med-tint text-med-ink border-med/25' : 'bg-ok-tint text-ok-ink border-ok/25';
  return (
    <span className={clsx('inline-flex items-center justify-center rounded-full border font-semibold tabular-nums', tone, large ? 'h-14 w-14 text-xl' : 'h-6 min-w-[2.25rem] px-1.5 text-xs')} title={`Page audit score ${score} / 100`}>
      {score}
    </span>
  );
}

const ICON: Record<PageAuditStatus, { icon: typeof CircleCheck; cls: string; label: string }> = {
  fail: { icon: CircleAlert, cls: 'text-crit-ink', label: 'Fix' },
  warn: { icon: TriangleAlert, cls: 'text-med-ink', label: 'Improve' },
  info: { icon: Info, cls: 'text-muted', label: 'Note' },
  pass: { icon: CircleCheck, cls: 'text-ok-ink', label: 'Good' },
};
const AREA_ORDER: PageAuditArea[] = ['response', 'title', 'meta', 'headings', 'canonical', 'indexability', 'content', 'links', 'images'];

/**
 * The checks of one page audit grouped by element: what was found and what to do. `only="problems"` lists just the
 * failed and warned checks (drawer); the page report shows everything.
 */
/** Where to fix one finding and how long it takes, for the selected website's platform. */
function FixHint({ id, template }: { id: string; template?: string }) {
  const platform = useSitePlatform();
  const f = pageCheckFix(id, template);
  if (!f) return null;
  const where = f.where.map((w) => localizeLocation(w, platform));
  return (
    <div className="mt-1.5 space-y-0.5 rounded-ctl bg-canvas px-2 py-1.5 text-xs" data-testid={`fix-${id}`}>
      <p><span className="text-muted">Time to fix: </span><span className="font-medium tabular-nums text-ink">{f.time.label}</span><span className="text-muted"> — {f.time.basis}</span></p>
      <p><span className="text-muted">Where: </span>{where.map((w, i) => <span key={`${w.kind}-${i}`}>{i ? ' · ' : ''}<span className="font-medium text-ink">{w.label}</span>{w.path ? <span className="text-ink-soft"> — {w.path}</span> : null}</span>)}</p>
      <p><span className="text-muted">Verify: </span><span className="text-ink-soft">{f.verify}</span></p>
    </div>
  );
}

export function AuditChecks({ audit, only, template }: { audit: PageAudit; only?: 'problems'; template?: string }) {
  const list = only === 'problems' ? audit.checks.filter((c) => c.status === 'fail' || c.status === 'warn') : audit.checks;
  if (audit.notAudited && !list.length) return <p className="text-sm text-muted">{audit.notAudited}</p>;
  if (!list.length) return <p className="text-sm text-ok-ink">Every checked element passes.</p>;
  const areas = AREA_ORDER.filter((a) => list.some((c) => c.area === a));
  return (
    <div className="space-y-3">
      {audit.notAudited && <p className="text-xs text-muted">{audit.notAudited}</p>}
      {areas.map((a) => (
        <div key={a}>
          {only !== 'problems' && <h4 className="mb-1 text-xs font-semibold text-muted">{PAGE_AUDIT_AREA_LABELS[a]}</h4>}
          <ul className="space-y-1.5">
            {list.filter((c) => c.area === a).map((c) => {
              const I = ICON[c.status];
              return (
                <li key={c.id} className="flex gap-2 rounded-ctl border border-line px-3 py-2">
                  <I.icon className={clsx('mt-0.5 h-4 w-4 shrink-0', I.cls)} aria-label={I.label} />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="font-medium text-ink">{c.label}</p>
                    {c.value && <p className="mt-0.5 break-words text-xs text-ink-soft">{c.value}</p>}
                    {c.items?.length ? <ul className="mt-1 space-y-0.5">{c.items.map((x) => <li key={x} className="break-all font-mono text-[11.5px] text-ink-soft">{x}</li>)}</ul> : null}
                    {c.recommendation && (c.status === 'fail' || c.status === 'warn' || only !== 'problems') && <p className="mt-1 text-xs text-signal-dark">{c.recommendation}</p>}
                    {(c.status === 'fail' || c.status === 'warn') && <FixHint id={c.id} template={template} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
