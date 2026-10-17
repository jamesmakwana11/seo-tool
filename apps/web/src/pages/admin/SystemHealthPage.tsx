import { Database, RefreshCw } from 'lucide-react';
import type { SystemComponentHealth, SystemErrorEntry } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, Button, DemoBadge, Mono, Notice, PageHeader, Panel, Stat, type Tone } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { fmtDateTime, fmtRelative } from '@/lib/format';

const SUBSYSTEM: Record<SystemComponentHealth['subsystem'], string> = {
  A: 'A — Crawler & Renderer',
  B: 'B — Data Connectors',
  C: 'C — Analysis Engine',
  D: 'D — Severity Classifier',
  E: 'E — Recommendation Engine',
  F: 'F — Reporting & Workflow',
  platform: 'Platform',
};
const STATUS: Record<SystemComponentHealth['status'], { label: string; tone: Tone }> = {
  operational: { label: 'Operational', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'med' },
  down: { label: 'Down', tone: 'crit' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
};

export default function SystemHealthPage() {
  const q = useApiQuery(['system'], () => api.getSystemHealth());
  return (
    <div>
      <PageHeader
        title="System health"
        description="Status of Sentinel’s six subsystems (A–F) and the platform, plus recent errors and warnings."
        meta={<DemoBadge />}
        actions={<Button icon={<RefreshCw className="h-4 w-4" />} loading={q.isFetching && !q.isLoading} onClick={() => void q.refetch()}>Re-check</Button>}
      />
      <Async q={q} rows={10}>
        {(d) => {
          const count = (s: SystemComponentHealth['status']) => d.components.filter((c) => c.status === s).length;
          const order = ['A', 'B', 'C', 'D', 'E', 'F', 'platform'];
          const comps = [...d.components].sort((a, b) => order.indexOf(a.subsystem) - order.indexOf(b.subsystem));
          return (
            <div className="space-y-5">
              {!d.storage.persistent ? (
                <Notice tone="demo" icon={<Database className="h-4 w-4" />} title="Storage is not persistent">
                  {d.storage.note} Kind: <Mono>{d.storage.kind.replace('_', ' ')}</Mono>.
                </Notice>
              ) : d.storage.error ? (
                <Notice tone="crit" icon={<Database className="h-4 w-4" />} title="The database cannot be written">
                  {d.storage.error}. Changes are kept in memory and retried; they are lost if the server restarts before the database is back.
                </Notice>
              ) : (
                <Notice tone="neutral" icon={<Database className="h-4 w-4" />} title="Stored in PostgreSQL">{d.storage.note}</Notice>
              )}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Operational" value={count('operational')} tone="ok" />
                <Stat label="Degraded" value={count('degraded')} tone={count('degraded') ? 'med' : undefined} />
                <Stat label="Down" value={count('down')} tone={count('down') ? 'crit' : undefined} />
                <Stat label="Not configured" value={count('not_configured')} />
              </div>
              <Panel title="Components" bodyClassName="p-0">
                <ul className="divide-y divide-line">
                  {comps.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted">{SUBSYSTEM[c.subsystem]}</p>
                        <p className="font-medium">{c.name}</p>
                        <p className="text-sm text-ink-soft">{c.detail}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                        <span className="text-2xs text-muted" title={`${fmtDateTime(c.lastCheckedAt)} IST`}>checked {fmtRelative(c.lastCheckedAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Errors & warnings" bodyClassName="p-3">
                <DataTable<SystemErrorEntry>
                  rows={d.errors}
                  rowKey={(e) => e.id}
                  dense
                  caption="System errors and warnings"
                  initialSort={{ key: 'at', dir: 'desc' }}
                  search={(e) => `${e.component} ${e.message} ${e.requestId ?? ''}`}
                  searchPlaceholder="Search errors"
                  empty={<p className="p-4 text-sm text-muted">No errors or warnings recorded.</p>}
                  columns={[
                    { key: 'at', header: 'When (IST)', cell: (e) => <span className="whitespace-nowrap text-xs">{fmtDateTime(e.at)}</span>, sort: (a, b) => a.at.localeCompare(b.at) },
                    { key: 'lvl', header: 'Level', cell: (e) => <Badge tone={e.level === 'error' ? 'crit' : 'med'}>{e.level}</Badge> },
                    { key: 'comp', header: 'Component', cell: (e) => e.component },
                    { key: 'msg', header: 'Message', cell: (e) => <span className="text-xs">{e.message}</span> },
                    { key: 'req', header: 'Request id', cell: (e) => (e.requestId ? <Mono className="text-xs">{e.requestId}</Mono> : '—'), hideOnMobile: true },
                  ]}
                />
              </Panel>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
