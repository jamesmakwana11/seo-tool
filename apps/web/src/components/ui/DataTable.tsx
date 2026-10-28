import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { EmptyState, Input } from './primitives';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sort?: (a: T, b: T) => number;
  className?: string;
  /** Hide below the md breakpoint to keep tables readable on phones. */
  hideOnMobile?: boolean;
  width?: string;
  /** A control shown beside the header (outside the sort button), e.g. a bulk action. */
  headerAction?: ReactNode;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  search?: (r: T) => string; // enables client-side search box
  searchPlaceholder?: string;
  pageSize?: number;
  empty?: ReactNode;
  toolbar?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  dense?: boolean;
  caption?: string;
  /**
   * Server-side pagination (controlled). When set, client paging/search are disabled. With `onSort`, clicking a sortable
   * header asks the server to sort (rows arrive sorted); without it, only the visible page is sorted.
   */
  server?: { page: number; pageSize: number; total: number; onPage: (p: number) => void; sort?: { key: string; dir: 'asc' | 'desc' }; onSort?: (s: { key: string; dir: 'asc' | 'desc' }) => void };
  rowClassName?: (r: T) => string | undefined;
}

export function DataTable<T>({ rows, columns, rowKey, onRowClick, search, searchPlaceholder = 'Search', pageSize = 25, empty, toolbar, initialSort, dense, caption, server, rowClassName }: Props<T>) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(initialSort);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let list = rows;
    if (!server && search && q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((r) => search(r).toLowerCase().includes(s));
    }
    if (sort && !server?.onSort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sort) list = [...list].sort((a, b) => col.sort!(a, b) * (sort.dir === 'asc' ? 1 : -1));
    }
    return list;
  }, [rows, q, sort, columns, search, server]);

  const total = server ? server.total : filtered.length;
  const ps = server ? server.pageSize : pageSize;
  const cur = server ? server.page : Math.min(page, Math.max(1, Math.ceil(total / ps)));
  const visible = server ? filtered : filtered.slice((cur - 1) * ps, cur * ps);
  const pages = Math.max(1, Math.ceil(total / ps));
  const go = (p: number) => (server ? server.onPage(p) : setPage(p));
  const curSort = server?.onSort ? server.sort : sort;
  const toggleSort = (key: string) => {
    const next = { key, dir: curSort?.key === key && curSort.dir === 'desc' ? 'asc' as const : 'desc' as const };
    if (server?.onSort) server.onSort(next);
    else setSort(next);
  };

  return (
    <div>
      {(search || toolbar) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {search && !server && (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
              <Input aria-label={searchPlaceholder} placeholder={searchPlaceholder} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="pl-8" />
            </div>
          )}
          {toolbar}
        </div>
      )}
      <div className="relative overflow-x-auto rounded-panel border border-line bg-surface shadow-card">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-line bg-raised/70 text-left">
              {columns.map((c) => (
                <th key={c.key} scope="col" style={{ width: c.width }} className={clsx('px-3 py-2.5 text-xs font-medium text-muted', c.hideOnMobile && 'hidden md:table-cell', c.className)} aria-sort={curSort?.key === c.key ? (curSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  <span className={c.headerAction ? 'flex items-center justify-between gap-2' : undefined}>
                    {c.sort ? (
                      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => toggleSort(c.key)}>
                        {c.header}
                        {curSort?.key === c.key && (curSort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    ) : c.header}
                    {c.headerAction}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={rowKey(r)}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
                className={clsx('border-b border-line/70 transition-colors last:border-0 hover:bg-raised/60', onRowClick && 'cursor-pointer hover:bg-raised focus:bg-raised', rowClassName?.(r))}
              >
                {columns.map((c) => (
                  <td key={c.key} className={clsx('px-3 align-top', dense ? 'py-1.5' : 'py-2.5', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.cell(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (empty ?? <EmptyState title={q ? 'No rows match your search' : 'Nothing here yet'} description={q ? 'Try a different term or clear the filters.' : undefined} />)}
      </div>
      {total > ps && (
        <nav className="mt-3 flex items-center justify-between text-sm text-muted" aria-label="Pagination">
          <span className="tabular-nums">{(cur - 1) * ps + 1}–{Math.min(cur * ps, total)} of {total}</span>
          <div className="flex items-center gap-1">
            <button className="inline-flex h-8 w-8 items-center justify-center rounded-ctl border border-line bg-surface disabled:opacity-40" disabled={cur <= 1} onClick={() => go(cur - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
            <span className="px-2 tabular-nums">Page {cur} of {pages}</span>
            <button className="inline-flex h-8 w-8 items-center justify-center rounded-ctl border border-line bg-surface disabled:opacity-40" disabled={cur >= pages} onClick={() => go(cur + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </nav>
      )}
    </div>
  );
}
