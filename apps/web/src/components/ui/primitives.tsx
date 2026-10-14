import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { AlertTriangle, Inbox, Loader2, RotateCcw, Activity, CircleCheck, Info, OctagonAlert, TriangleAlert, type LucideIcon, TrendingDown, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { demoScope } from '@/api/websiteScope';
import { CountUp } from '@/lib/motion';

// ------------------------------------------------------------------ Button
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-signal font-semibold text-on-signal hover:bg-signal-dark border border-signal-dark/30 shadow-[0_1px_2px_rgba(76,29,149,0.25)]',
  secondary: 'bg-surface text-ink border border-line-strong shadow-card hover:border-signal/40 hover:text-signal-dark',
  ghost: 'text-ink-soft hover:bg-raised hover:text-signal-dark border border-transparent',
  danger: 'bg-crit text-white hover:bg-[#C23A4A] border border-crit',
  subtle: 'bg-signal-tint text-signal-dark hover:bg-[#DED2FA] border border-transparent',
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-ctl font-medium transition-[color,background-color,border-color,box-shadow] duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} className={clsx('inline-flex h-8 w-8 items-center justify-center rounded-ctl text-muted hover:bg-raised hover:text-ink', className)} {...rest}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Panel
export function Panel({ title, actions, children, className, bodyClassName, subtitle, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  // Content panels read as one surface (no header rule); flush lists/tables keep a hairline under the header.
  const flush = /(^|\s)p-0(\s|$)/.test(bodyClassName ?? '');
  return (
    <section id={id} className={clsx('min-w-0 rounded-panel border border-line bg-surface shadow-card', className)}>
      {(title || actions) && (
        <header className={clsx('flex flex-wrap items-start justify-between gap-2 px-5 pt-4', flush ? 'border-b border-line pb-3' : 'pb-0')}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold tracking-[-0.012em] text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx('p-5', (title || actions) && !flush ? 'pt-4' : undefined, bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.022em] text-ink sm:text-[24px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted">{description}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Stat
type StatTone = 'crit' | 'med' | 'low' | 'ok' | 'signal';
const STAT_ICON: Record<StatTone, LucideIcon> = { crit: OctagonAlert, med: TriangleAlert, low: Info, ok: CircleCheck, signal: Activity };
const STAT_ICON_TONE: Record<StatTone, string> = { crit: 'bg-crit-tint text-crit-ink', med: 'bg-med-tint text-med-ink', low: 'bg-low-tint text-low-ink', ok: 'bg-ok-tint text-ok-ink', signal: 'bg-signal-tint text-signal' };
/** KPI card: label, prominent value, optional hint; a severity-coded icon tile when it carries a status. */
export function Stat({ label, value, hint, tone, to, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: StatTone; to?: string; icon?: LucideIcon }) {
  const Icon = icon ?? (tone ? STAT_ICON[tone] : undefined);
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 truncate text-[12.5px] font-medium text-muted">{label}</div>
        {Icon && <span className={clsx('-mr-1 -mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', tone ? STAT_ICON_TONE[tone] : 'bg-signal-tint text-signal')}><Icon className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden /></span>}
      </div>
      <div className={clsx('mt-1 text-[26px] font-semibold leading-tight tracking-[-0.025em] tabular-nums', tone === 'crit' ? 'text-crit-ink' : tone === 'med' ? 'text-med-ink' : tone === 'low' ? 'text-low-ink' : tone === 'ok' ? 'text-ok-ink' : tone === 'signal' ? 'text-signal' : 'text-ink')}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted">{hint}</div>}
    </>
  );
  const cls = 'group block min-w-0 rounded-panel border border-line bg-surface px-4 py-3.5 shadow-card transition-[border-color,box-shadow,transform] duration-200 ease-out';
  return to ? <Link to={to} className={clsx(cls, 'hover:-translate-y-0.5 hover:border-signal/40 hover:shadow-lift')}>{body}</Link> : <div className={cls}>{body}</div>;
}

const KPI_TINT = { violet: 'bg-[#F1ECFE]', blue: 'bg-[#ECF1FE]', lilac: 'bg-[#F6EEFC]', rose: 'bg-[#FDF0F2]' } as const;
/**
 * Headline KPI tile (dashboard top row): pastel ground, white icon chip, a large value that counts up once, and a small
 * trend chip. `trend` is shown only when it is computed from real history — never decorative.
 */
export function KpiCard({ label, value, decimals, format, icon: Icon, tint = 'violet', trend, note, to }: {
  label: string; value: number | null; decimals?: number; format?: (v: number) => string; icon: LucideIcon; tint?: keyof typeof KPI_TINT;
  trend?: { text: string; up: boolean; good: boolean }; note?: ReactNode; to?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <span className="pt-1 text-[13px] font-medium text-ink-soft">{label}</span>
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-signal shadow-[0_1px_2px_rgba(37,34,56,0.06)] transition-transform duration-200 group-hover:scale-105"><Icon className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden /></span>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">{value === null ? '—' : <CountUp value={value} decimals={decimals} format={format} />}</span>
        {trend && (
          <span className={clsx('inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums', trend.good ? 'text-ok-ink' : 'text-crit-ink')}>
            {trend.up ? <TrendingUp className="h-3.5 w-3.5" aria-hidden /> : <TrendingDown className="h-3.5 w-3.5" aria-hidden />}{trend.text}
          </span>
        )}
      </div>
      {note && <div className="mt-2 truncate text-xs text-muted">{note}</div>}
    </>
  );
  const cls = clsx('group block min-w-0 rounded-panel px-5 py-4 transition-[transform,box-shadow] duration-200 ease-out', KPI_TINT[tint]);
  return to ? <Link to={to} className={clsx(cls, 'hover:-translate-y-0.5 hover:shadow-lift')}>{body}</Link> : <div className={cls}>{body}</div>;
}

// ------------------------------------------------------------------ Badge
export type Tone = 'neutral' | 'crit' | 'med' | 'low' | 'ok' | 'opp' | 'signal' | 'demo' | 'dark';
const TONES: Record<Tone, string> = {
  neutral: 'bg-[#F5F3F9] text-ink-soft border-line',
  crit: 'bg-crit-tint text-crit-ink border-crit/25',
  med: 'bg-med-tint text-med-ink border-med/25',
  low: 'bg-low-tint text-low-ink border-low/25',
  ok: 'bg-ok-tint text-ok-ink border-ok/25',
  opp: 'bg-opp-tint text-opp-ink border-opp/25',
  signal: 'bg-signal-tint text-signal-dark border-signal/20',
  demo: 'bg-demo-tint text-demo border-demo/30',
  dark: 'bg-raised text-signal-dark border-signal/20',
};
export function Badge({ tone = 'neutral', children, className, title, icon }: { tone?: Tone; children: ReactNode; className?: string; title?: string; icon?: ReactNode }) {
  return (
    <span title={title} className={clsx('inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

/** Marks sample / simulated data (prompt §7.2). Hatched so it never reads as a status colour. */
export function DemoBadge({ label = 'DEMO data', title = 'Deterministic sample data — not from a live crawl or connected API.' }: { label?: string; title?: string }) {
  // A website added by a person holds no sample data, so the generic badge would be false there.
  const demoSite = useSyncExternalStore(demoScope.subscribe, demoScope.get);
  if (!demoSite && label === 'DEMO data') return null;
  return (
    <span title={title} className="demo-hatch inline-flex items-center rounded-full border border-demo/40 px-2 py-0.5 text-xs font-semibold text-demo">
      {label}
    </span>
  );
}

// ------------------------------------------------------------------ Form controls
export function Field({ label, hint, error, children, htmlFor, required }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-ink">
        {label}
        {required && <span className="text-crit-ink" aria-hidden> *</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-crit-ink" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const ctl = 'w-full rounded-ctl border border-line-strong bg-surface px-2.5 text-sm text-ink placeholder:text-faint transition-[border-color,box-shadow] hover:border-[#C9B8F2] focus:border-signal focus:shadow-[0_0_0_3px_rgba(118,80,216,0.14)] focus:outline-none disabled:cursor-not-allowed disabled:bg-canvas disabled:opacity-70 aria-[invalid=true]:border-crit aria-[invalid=true]:shadow-[0_0_0_3px_rgba(220,38,38,0.10)]';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(ctl, 'h-9', className)} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(ctl, 'min-h-[80px] py-2', className)} {...rest} />;
});
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(ctl, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}
export function Checkbox({ label, checked, onChange, disabled, description }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-line-strong accent-[#7650D8]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-ink">
        {label}
        {description && <span className="block text-xs text-muted">{description}</span>}
      </label>
    </div>
  );
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-signal' : 'bg-line-strong')}
    >
      <span className={clsx('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

// ------------------------------------------------------------------ Feedback
export function ProgressBar({ value, tone = 'signal', label }: { value: number; tone?: 'signal' | 'ok' | 'crit' | 'med'; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={label ?? 'Progress'} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className={clsx('h-full rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'crit' ? 'bg-crit' : tone === 'med' ? 'bg-med' : 'bg-signal')} style={{ width: `${v}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-muted">{v}%</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton rounded-ctl', className)} aria-hidden />;
}

export function LoadingBlock({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className={clsx('h-8', i % 3 === 2 ? 'w-2/3' : 'w-full')} />)}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-2 text-faint">{icon ?? <Inbox className="h-7 w-7" />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'This section could not load' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center" role="alert">
      <AlertTriangle className="mb-2 h-7 w-7 text-crit-ink" />
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted">{msg}</p>
      {onRetry && <Button className="mt-3" size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** Renders loading / error / content for a react-query result. */
export function Async<T>({ q, children, rows, empty }: { q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown }; children: (d: T) => ReactNode; rows?: number; empty?: (d: T) => boolean | ReactNode }) {
  if (q.isLoading) return <LoadingBlock rows={rows} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.data === undefined) return null;
  if (empty) {
    const e: unknown = empty(q.data);
    if (e === true) return <EmptyState title="Nothing to show yet" />;
    if (e && e !== false) return <>{e as ReactNode}</>;
  }
  return <>{children(q.data)}</>;
}

// ------------------------------------------------------------------ Tabs
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div role="tablist" className={clsx('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx('-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors', value === it.value ? 'border-signal font-medium text-signal-dark' : 'border-transparent text-muted hover:border-line-strong hover:text-ink')}
        >
          {it.label}
          {it.count !== undefined && <span className="rounded-full bg-raised px-1.5 text-xs tabular-nums text-muted">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Key/value + misc
export function KV({ items, cols = 2 }: { items: { k: ReactNode; v: ReactNode }[]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx('grid grid-cols-1 gap-x-6 gap-y-3', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3')}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-muted">{it.k}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Code({ children, language }: { children: string; language?: string }) {
  return (
    <div className="overflow-hidden rounded-ctl border border-line bg-canvas">
      {language && <div className="border-b border-line px-3 py-1 font-mono text-2xs text-muted">{language}</div>}
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-ink-soft"><code>{children}</code></pre>
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono text-[12.5px] [overflow-wrap:anywhere]', className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-4 w-4 animate-spin text-muted', className)} aria-label="Loading" />;
}

export function Notice({ tone = 'neutral', title, children, icon, demoData }: { tone?: 'neutral' | 'demo' | 'crit' | 'med' | 'signal'; title?: ReactNode; children: ReactNode; icon?: ReactNode; /** says the shown data is DEMO sample data — hidden on websites that hold none */ demoData?: boolean }) {
  const demoSite = useSyncExternalStore(demoScope.subscribe, demoScope.get);
  if (demoData && !demoSite) return null;
  return (
    <div className={clsx('flex gap-2.5 rounded-ctl border px-3.5 py-2.5 text-sm leading-relaxed', tone === 'demo' ? 'border-demo/30 bg-demo-tint text-[#8A5408]' : tone === 'crit' ? 'border-crit/30 bg-crit-tint text-[#B0303F]' : tone === 'med' ? 'border-med/30 bg-med-tint text-[#8A5408]' : tone === 'signal' ? 'border-signal/30 bg-signal-tint text-signal-dark' : 'border-line bg-raised/60 text-ink-soft')}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        <div className={clsx(title && 'mt-0.5')}>{children}</div>
      </div>
    </div>
  );
}

/** Compact segmented control (chart ranges / metric switches). The active option slides on a white pill. */
export function Segmented<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5 rounded-xl bg-[#F3F0FA] p-0.5">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx('h-7 rounded-[10px] px-2.5 text-xs font-medium transition-[background-color,color,box-shadow] duration-200', value === it.value ? 'bg-white text-ink shadow-[0_1px_2px_rgba(37,34,56,0.08)]' : 'text-muted hover:text-ink')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Text tabs for switching a chart's metric (reference: "Total Users · Total Projects · …"). */
export function MetricTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <button key={it.value} type="button" role="tab" aria-selected={value === it.value} onClick={() => onChange(it.value)}
          className={clsx('relative py-1 text-[15px] transition-colors duration-200', value === it.value ? 'font-semibold text-ink' : 'font-medium text-faint hover:text-muted')}>
          {it.label}
          <span className={clsx('absolute -bottom-0.5 left-0 h-0.5 rounded-full bg-signal transition-all duration-300', value === it.value ? 'w-full opacity-100' : 'w-0 opacity-0')} />
        </button>
      ))}
    </div>
  );
}
