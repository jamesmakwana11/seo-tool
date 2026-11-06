import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Minus, Plug, RefreshCw } from 'lucide-react';
import { ApiError, CWV_RATING_LABELS, type CwvRating, type DateWindow, type ReportCompare, type ReportRange } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, EmptyState, ErrorState, Segmented, type Tone } from '@/components/ui/primitives';
import { fmtDate, fmtRelative } from '@/lib/format';

export function ReportControls({ range, onRange, compare, onCompare, fetchedAt, cached, refreshing, onRefresh, window }: {
  range: ReportRange; onRange: (r: ReportRange) => void; compare: ReportCompare; onCompare: (c: ReportCompare) => void;
  fetchedAt?: string; cached?: boolean; refreshing?: boolean; onRefresh: () => void; window?: { cur: DateWindow; prev: DateWindow };
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented<`${ReportRange}`> label="Period" value={String(range) as `${ReportRange}`} onChange={(v) => onRange(Number(v) as ReportRange)} items={[{ value: '7', label: '7 days' }, { value: '28', label: '28 days' }, { value: '90', label: '90 days' }]} />
      <Segmented<ReportCompare> label="Compare with" value={compare} onChange={onCompare} items={[{ value: 'previous', label: 'vs previous period' }, { value: 'year', label: 'vs last year' }]} />
      <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={refreshing} onClick={onRefresh}>Refresh</Button>
      {window && <span className="text-xs text-muted">{fmtDate(window.cur.start)} – {fmtDate(window.cur.end)} compared with {fmtDate(window.prev.start)} – {fmtDate(window.prev.end)}</span>}
      {fetchedAt && <span className="text-xs text-muted">Fetched from Google {fmtRelative(fetchedAt)}{cached ? ' (cached)' : ''}</span>}
    </div>
  );
}

/** Change from the previous value: green when it moved the good way (lower is better for position). */
export function Delta({ cur, prev, lowerIsBetter, asPoints }: { cur: number; prev: number; lowerIsBetter?: boolean; asPoints?: boolean }) {
  if (!prev && !cur) return <span className="text-xs text-muted">no data</span>;
  if (!prev) return <span className="text-xs text-muted">new</span>;
  const diff = cur - prev;
  const pct = asPoints ? diff * 100 : (diff / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.05) return <span className="inline-flex items-center gap-0.5 text-xs text-muted"><Minus className="h-3 w-3" aria-hidden />no change</span>;
  const up = diff > 0;
  const good = lowerIsBetter ? !up : up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const text = asPoints ? `${up ? '+' : ''}${pct.toFixed(1)} pts` : `${up ? '+' : ''}${pct.toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
  return <span className={clsx('inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums', good ? 'text-ok-ink' : 'text-crit-ink')}><Icon className="h-3.5 w-3.5" aria-hidden />{text}</span>;
}

/** Metric tile with its comparison. */
export function MetricTile({ label, value, cur, prev, lowerIsBetter, asPoints, prevText, hint }: { label: string; value: ReactNode; cur: number; prev: number; lowerIsBetter?: boolean; asPoints?: boolean; prevText: string; hint?: string }) {
  return (
    <div data-export-kpi className="min-w-0 rounded-panel border border-line bg-surface px-4 py-3.5 shadow-card" title={hint}>
      <div data-export-label className="truncate text-[12.5px] font-medium text-muted">{label}</div>
      <div data-export-value className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.025em] tabular-nums text-ink">{value}</div>
      <div data-export-hint className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5"><Delta cur={cur} prev={prev} lowerIsBetter={lowerIsBetter} asPoints={asPoints} /><span className="truncate text-xs text-muted">was {prevText}</span></div>
    </div>
  );
}

/** Report errors: "not connected" / "reconnect" get a way forward instead of a raw error. */
export function ReportError({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  const { can } = useAuth();
  if (error instanceof ApiError && (error.code === 'NOT_CONNECTED' || error.code === 'GOOGLE_RECONNECT' || error.code === 'GOOGLE_NOT_CONFIGURED')) {
    return (
      <EmptyState
        icon={<Plug className="h-8 w-8 text-muted" />}
        title={error.code === 'GOOGLE_RECONNECT' ? 'Google access expired' : `${what} is not connected for this website`}
        description={error.message}
        action={can('google.manage')
          ? <Link to="/settings/integrations" className="inline-flex h-9 items-center rounded-ctl bg-signal px-3 text-sm font-medium text-white hover:bg-signal-dark">{error.code === 'GOOGLE_RECONNECT' ? 'Reconnect in Integrations' : 'Connect in Integrations'}</Link>
          : <span className="text-sm text-muted">Ask an Admin to connect it under Settings → Integrations → Google.</span>}
      />
    );
  }
  return <ErrorState error={error} onRetry={onRetry} title={`The ${what} report could not load`} />;
}

const RATING_TONE: Record<CwvRating, Tone> = { good: 'ok', needs_improvement: 'med', poor: 'crit' };
export function RatingBadge({ rating }: { rating?: CwvRating }) {
  if (!rating) return <Badge>No data</Badge>;
  return <Badge tone={RATING_TONE[rating]}>{CWV_RATING_LABELS[rating]}</Badge>;
}
export const ratingText: Record<CwvRating, string> = { good: 'text-ok-ink', needs_improvement: 'text-med-ink', poor: 'text-crit-ink' };

/** Simple ranked table for top lists (queries, pages, channels…). */
export function TopTable<T>({ rows, columns, empty = 'No data for this period.', label }: { rows: T[]; columns: { header: string; cell: (r: T) => ReactNode; align?: 'right'; className?: string }[]; empty?: string; label: string }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label={label}>
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {columns.map((c) => <th key={c.header} scope="col" className={clsx('px-4 py-2 font-medium', c.align === 'right' && 'text-right', c.className)}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-canvas">
              {columns.map((c) => <td key={c.header} className={clsx('px-4 py-2', c.align === 'right' && 'text-right tabular-nums', c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const fmtDuration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
export const fmtRate = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
