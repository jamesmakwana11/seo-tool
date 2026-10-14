import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Check, ChevronsUpDown, LayoutGrid, Plus, Search } from 'lucide-react';
import type { WebsiteSummary } from '@sentinel/shared';
import { useWebsites } from '@/websites/WebsiteContext';

/** Monogram tile — a stable hue per domain so websites are recognisable at a glance. */
export function SiteMark({ site, size = 'md' }: { site: Pick<WebsiteSummary, 'name' | 'domain'>; size?: 'sm' | 'md' | 'lg' }) {
  let h = 0;
  for (const c of site.domain) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span
      aria-hidden
      className={clsx('inline-flex shrink-0 items-center justify-center rounded-[7px] font-semibold', size === 'sm' ? 'h-6 w-6 text-[11px]' : size === 'lg' ? 'h-10 w-10 text-base' : 'h-8 w-8 text-sm')}
      style={{ background: `hsl(${h} 85% 94%)`, color: `hsl(${h} 50% 34%)` }}
    >
      {site.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** Header website switcher. The choice is remembered for this browser session. */
export function WebsiteSelector() {
  const { current, websites, select } = useWebsites();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const list = (websites ?? []).filter((w) => !q.trim() || `${w.name} ${w.domain}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div ref={box} className="relative min-w-0">
      <button
        onClick={() => { setOpen((o) => !o); setQ(''); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Website: ${current?.name ?? 'loading'}. Switch website`}
        className="flex h-10 max-w-[260px] items-center gap-2.5 rounded-ctl border border-line bg-surface py-1 pl-1.5 pr-2.5 text-left shadow-card transition-colors hover:border-signal/40"
      >
        {current ? <SiteMark site={current} /> : <span className="h-8 w-8 animate-pulse rounded-[7px] bg-line" />}
        <span className="block min-w-0 max-w-[88px] leading-tight sm:max-w-none">
          <span className="block truncate text-[13px] font-semibold text-ink">{current?.name ?? 'Loading…'}</span>
          <span className="hidden truncate font-mono text-[11px] text-muted sm:block">{current?.domain ?? ''}</span>
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 text-faint" aria-hidden />
      </button>
      {open && (
        <div className="anim-pop absolute left-0 z-50 mt-2 w-[320px] max-w-[calc(100vw-24px)] overflow-hidden rounded-panel border border-line bg-surface shadow-pop">
          <div className="border-b border-line p-2">
            <label className="relative block">
              <span className="sr-only">Search websites</span>
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" aria-hidden />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search websites" className="h-9 w-full rounded-ctl border border-line bg-surface pl-8 pr-2 text-sm placeholder:text-faint focus:border-signal focus:shadow-[0_0_0_3px_rgba(118,80,216,0.14)] focus:outline-none" />
            </label>
          </div>
          <ul id={listId} role="listbox" aria-label="Websites" className="max-h-72 overflow-y-auto p-1">
            {list.map((w) => (
              <li key={w.id} role="option" aria-selected={w.id === current?.id}>
                <button
                  onClick={() => { setOpen(false); select(w.id); }}
                  className={clsx('flex w-full items-center gap-2.5 rounded-ctl px-2 py-2 text-left transition-colors hover:bg-raised', w.id === current?.id && 'bg-signal-tint')}
                >
                  <SiteMark site={w} size="sm" />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-sm font-medium text-ink">{w.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">{w.domain}{w.hasAuditData ? '' : ' · not crawled'}</span>
                  </span>
                  {w.healthScore !== undefined && <span className="text-xs font-semibold tabular-nums text-ink-soft">{w.healthScore}</span>}
                  {w.id === current?.id && <Check className="h-4 w-4 text-signal" aria-hidden />}
                </button>
              </li>
            ))}
            {!list.length && <li className="px-3 py-4 text-center text-sm text-muted">No website matches “{q}”.</li>}
          </ul>
          <div className="grid grid-cols-2 gap-1 border-t border-line p-1">
            <Link to="/websites/overview" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-ctl px-2 py-2 text-sm text-ink-soft hover:bg-raised hover:text-ink"><LayoutGrid className="h-4 w-4" aria-hidden /> All websites</Link>
            <Link to="/websites?add=1" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-ctl px-2 py-2 text-sm text-ink-soft hover:bg-raised hover:text-ink"><Plus className="h-4 w-4" aria-hidden /> Add website</Link>
          </div>
        </div>
      )}
    </div>
  );
}
