import { Link } from 'react-router-dom';
import { ArrowRight, Bot, Layers } from 'lucide-react';
import { TEAMS, TEAM_IDS, type AllocationEvent } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, EmptyState, Input, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { fmtDateTime } from '@/lib/format';

type Row = AllocationEvent & { issueTitle: string };
const KEYS = ['team', 'allocator', 'kind', 'q'] as const;

const columns: Column<Row>[] = [
  { key: 'at', header: 'When (IST)', cell: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</span>, sort: (a, b) => a.at.localeCompare(b.at) },
  { key: 'who', header: 'Allocated by', cell: (r) => <span className="inline-flex items-center gap-1 text-sm">{r.automatic && <Bot className="h-3.5 w-3.5 text-med-ink" aria-hidden />}{r.allocatedByName}</span>, sort: (a, b) => a.allocatedByName.localeCompare(b.allocatedByName) },
  {
    key: 'move', header: 'Team', cell: (r) => (
      <span className="inline-flex flex-wrap items-center gap-1 text-sm">
        {r.fromTeam && <><span className="text-muted line-through decoration-faint">{TEAMS[r.fromTeam].shortName}</span><ArrowRight className="h-3 w-3 text-faint" aria-hidden /></>}
        <span className="font-medium">{TEAMS[r.toTeam].name}</span>
      </span>
    ),
  },
  {
    key: 'issue', header: 'Issue', cell: (r) => (
      <div className="min-w-[200px]">
        <Link to={`/issues/${r.issueId}`} className="font-mono text-xs text-signal hover:underline">{r.issueId}</Link>
        <div className="line-clamp-2 text-sm">{r.issueTitle}</div>
      </div>
    ),
  },
  {
    key: 'flags', header: 'Type', cell: (r) => (
      <div className="flex flex-wrap gap-1">
        {r.fromTeam ? <Badge tone="opp">Reallocation</Badge> : <Badge tone="neutral">First allocation</Badge>}
        {r.automatic && <Badge tone="med" title="Critical left unallocated for more than 24 hours (PDF §12.4)">Automatic · Critical &gt;24h</Badge>}
        {r.bulkGroupId && <Badge tone="neutral" icon={<Layers className="h-3 w-3" />}>Bulk {r.bulkGroupId}</Badge>}
      </div>
    ),
  },
  { key: 'reason', header: 'Reason', cell: (r) => (r.reason ? <span className="text-xs text-ink-soft">“{r.reason}”</span> : <span className="text-xs text-faint">—</span>), hideOnMobile: true },
];

export default function AllocationHistoryPage() {
  const f = useUrlFilters(KEYS);
  const q = useApiQuery(['allocations'], () => api.listAllocationHistory());
  return (
    <div>
      <PageHeader
        title="Allocation history"
        description="Who allocated each issue → which 1into2 team → when, including reallocations with their reason, template-level bulk allocations, and automatic allocations of Criticals left unallocated for 24 hours (PDF §11.1a, §12.4)."
      />
      <Async q={q} rows={10}>
        {(rows) => {
          const allocators = [...new Map(rows.map((r) => [r.allocatedById, r.allocatedByName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
          const s = f.get('q').toLowerCase();
          const filtered = rows.filter((r) =>
            (!f.get('team') || r.toTeam === f.get('team') || r.fromTeam === f.get('team'))
            && (!f.get('allocator') || r.allocatedById === f.get('allocator'))
            && (!f.get('kind') || (f.get('kind') === 'automatic' ? r.automatic : f.get('kind') === 'manual' ? !r.automatic : f.get('kind') === 'reallocation' ? !!r.fromTeam : !!r.bulkGroupId))
            && (!s || r.issueId.toLowerCase().includes(s) || r.issueTitle.toLowerCase().includes(s) || (r.reason ?? '').toLowerCase().includes(s)));
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="Allocations" value={rows.length} />
                <Stat label="Reallocations" value={rows.filter((r) => r.fromTeam).length} tone="signal" />
                <Stat label="Automatic (Critical >24h)" value={rows.filter((r) => r.automatic).length} tone={rows.some((r) => r.automatic) ? 'med' : undefined} />
                <Stat label="Bulk (template groups)" value={rows.filter((r) => r.bulkGroupId).length} />
              </div>
              <Panel bodyClassName="flex flex-wrap items-center gap-3 p-3">
                <Input aria-label="Search allocations" placeholder="Search issue ID, title or reason" value={f.get('q')} onChange={(e) => f.set('q', e.target.value)} className="max-w-xs" />
                <FilterSelect label="Team" value={f.get('team')} onChange={(v) => f.set('team', v)} options={TEAM_IDS.map((t) => ({ value: t, label: TEAMS[t].name }))} />
                <FilterSelect label="Allocator" value={f.get('allocator')} onChange={(v) => f.set('allocator', v)} options={allocators.map(([value, label]) => ({ value, label }))} />
                <FilterSelect label="Type" value={f.get('kind')} onChange={(v) => f.set('kind', v)} options={[{ value: 'automatic', label: 'Automatic only' }, { value: 'manual', label: 'Manual only' }, { value: 'reallocation', label: 'Reallocations' }, { value: 'bulk', label: 'Bulk group' }]} />
                <ClearFilters show={f.active} onClear={f.clear} />
              </Panel>
              <DataTable
                caption="Allocation and reallocation events"
                rows={filtered}
                rowKey={(r) => r.id}
                columns={columns}
                initialSort={{ key: 'at', dir: 'desc' }}
                empty={<EmptyState title={rows.length ? 'No allocations match these filters' : 'No allocations yet'} description={rows.length ? 'Clear the filters to see everything.' : 'Allocations appear here when issues are allocated (automatically for unallocated Criticals, or through the API).'} />}
              />
            </div>
          );
        }}
      </Async>
    </div>
  );
}
