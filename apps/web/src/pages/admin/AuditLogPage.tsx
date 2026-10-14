import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AuditLogEntry } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, Code, DemoBadge, EmptyState, Input, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { useEmployees } from '@/hooks/lookups';
import { fmtDateTime } from '@/lib/format';

const ENTITY_TYPES: AuditLogEntry['entityType'][] = ['issue', 'crawl', 'config', 'employee', 'rule', 'integration', 'report', 'alert', 'verification', 'auth', 'disavow', 'qa_gate', 'exclusion', 'brief', 'opportunity'];
const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const f = useUrlFilters(['q', 'entity', 'actor', 'page'] as const);
  const employees = useEmployees();
  const page = Math.max(1, Number(f.get('page')) || 1);
  const [text, setText] = useState(f.get('q'));
  const q = f.get('q');
  // Debounce the search box into the URL (server-side filter).
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => f.set('q', text.trim()), 300);
    return () => clearTimeout(t);
  }, [text, q, f]);
  const query = useApiQuery(['audit', { q, entity: f.get('entity'), actor: f.get('actor'), page }], () =>
    api.listAuditLog({ q: q || undefined, entityType: f.get('entity') || undefined, actorId: f.get('actor') || undefined, page, pageSize: PAGE_SIZE }));
  const actorOptions = [{ value: 'system', label: 'Sentinel (system)' }, ...employees.list.map((e) => ({ value: e.id, label: e.name }))];
  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Every alert, allocation, status change, verification, configuration change and export is logged (PDF §17). The monthly executive report is generated from this log, so reporting is evidence-backed, never manual."
        meta={<DemoBadge />}
      />
      <div className="space-y-5">
        <Notice tone="demo">DEMO mode: the log lives in browser memory and resets on reload. Actions you take in this session are appended live.</Notice>
        <Panel bodyClassName="p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input aria-label="Search audit log" placeholder="Search summary, action or entity id" value={text} onChange={(e) => setText(e.target.value)} className="w-full max-w-xs" />
            <FilterSelect label="Entity" value={f.get('entity')} onChange={(v) => f.set('entity', v)} options={ENTITY_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }))} />
            <FilterSelect label="Actor" value={f.get('actor')} onChange={(v) => f.set('actor', v)} options={actorOptions} />
            <ClearFilters show={f.active} onClear={() => { setText(''); f.clear(); }} />
          </div>
          <Async q={query} rows={10}>
            {(p) => <AuditTable rows={p.items} total={p.total} page={p.page} pageSize={p.pageSize} onPage={(n) => f.set('page', String(n))} />}
          </Async>
        </Panel>
      </div>
    </div>
  );
}

function AuditTable({ rows, total, page, pageSize, onPage }: { rows: AuditLogEntry[]; total: number; page: number; pageSize: number; onPage: (p: number) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (!rows.length) return <EmptyState title="No audit entries match" description="Try a different search term or clear the filters." />;
  return (
    <div>
      <div className="relative overflow-x-auto rounded-panel border border-line">
        <table className="w-full min-w-[720px] text-sm">
          <caption className="sr-only">Audit log entries</caption>
          <thead>
            <tr className="border-b border-line bg-raised/70 text-left text-xs text-muted">
              <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Details</span></th>
              <th scope="col" className="px-3 py-2 font-medium">When (IST)</th>
              <th scope="col" className="px-3 py-2 font-medium">Actor</th>
              <th scope="col" className="px-3 py-2 font-medium">Action</th>
              <th scope="col" className="px-3 py-2 font-medium">Entity</th>
              <th scope="col" className="px-3 py-2 font-medium">Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const hasDiff = a.before !== undefined || a.after !== undefined;
              const isOpen = open.has(a.id);
              return (
                <Fragment key={a.id}>
                  <tr className="border-b border-line align-top last:border-0">
                    <td className="px-2 py-2">
                      {hasDiff && (
                        <button type="button" onClick={() => toggle(a.id)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} before/after for ${a.id}`} className="inline-flex h-6 w-6 items-center justify-center rounded-ctl text-muted hover:bg-raised hover:text-ink">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(a.at)}</td>
                    <td className="px-3 py-2">{a.actorName}</td>
                    <td className="px-3 py-2"><Mono className="text-xs">{a.action}</Mono></td>
                    <td className="px-3 py-2"><Badge>{a.entityType.replace('_', ' ')}</Badge> <Mono className="text-xs text-muted">{a.entityId}</Mono></td>
                    <td className="px-3 py-2 text-xs">{a.summary}{hasDiff && !isOpen && <span className="ml-1 text-muted">· has before/after</span>}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-line bg-canvas/50">
                      <td colSpan={6} className="px-3 py-3">
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                          <div><p className="mb-1 text-xs text-muted">Before</p>{a.before !== undefined ? <Code language="json">{JSON.stringify(a.before, null, 2)}</Code> : <p className="text-xs text-muted">—</p>}</div>
                          <div><p className="mb-1 text-xs text-muted">After</p>{a.after !== undefined ? <Code language="json">{JSON.stringify(a.after, null, 2)}</Code> : <p className="text-xs text-muted">—</p>}</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted" aria-label="Pagination">
        <span className="tabular-nums">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span>
        <div className="flex items-center gap-1">
          <button className="inline-flex h-8 w-8 items-center justify-center rounded-ctl border border-line bg-surface disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronRight className="h-4 w-4 rotate-180" /></button>
          <span className="px-2 tabular-nums">Page {page} of {pages}</span>
          <button className="inline-flex h-8 w-8 items-center justify-center rounded-ctl border border-line bg-surface disabled:opacity-40" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </nav>
    </div>
  );
}
