import clsx from 'clsx';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Multi-select toggle chips (keyboard accessible). */
export function ChipGroup<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: ReactNode; tone?: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <span className="mr-1 text-xs text-muted">{label}</span>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={clsx('h-7 rounded-full border px-2.5 text-xs transition-colors', on ? 'border-signal/50 bg-signal-tint text-signal-dark font-medium' : 'border-line-strong bg-surface text-ink-soft hover:border-muted/50')}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Compact labelled select used in filter bars. */
export function FilterSelect({ label, value, onChange, options, allLabel = 'All' }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; allLabel?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 rounded-ctl border border-line-strong bg-surface px-2 text-sm text-ink">
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function ClearFilters({ onClear, show }: { onClear: () => void; show: boolean }) {
  if (!show) return null;
  return <button onClick={onClear} className="inline-flex items-center gap-1 text-xs text-signal hover:underline"><X className="h-3 w-3" /> Clear filters</button>;
}

/** URL-synced filter state so filtered views are shareable / bookmarkable. */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  const get = (k: K) => params.get(k) ?? '';
  const getList = (k: K) => (params.get(k) ? params.get(k)!.split(',').filter(Boolean) : []);
  const set = (k: K, v: string | string[]) => {
    const next = new URLSearchParams(params);
    const val = Array.isArray(v) ? v.join(',') : v;
    if (val) next.set(k, val);
    else next.delete(k);
    if (k !== ('page' as K)) next.delete('page');
    setParams(next, { replace: true });
  };
  const clear = () => setParams(new URLSearchParams(), { replace: true });
  const active = keys.some((k) => params.get(k));
  return { get, getList, set, clear, active, params };
}
