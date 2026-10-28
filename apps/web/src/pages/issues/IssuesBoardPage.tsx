import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Ban, Wand2 } from 'lucide-react';
import { MODULE_LABELS, ISSUE_STATUS_LABELS, TEAMS, type AuditModule, type IssueFilter, type IssueStatus, type Severity, type TeamId, type PageTemplate } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useEmployees } from '@/hooks/lookups';
import { useAuth } from '@/auth/AuthContext';
import { Async, Button, DemoBadge, EmptyState, Input, PageHeader, Panel } from '@/components/ui/primitives';
import { BulkFixDialog } from '@/components/seo/BulkFixDialog';
import { ChipGroup, ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { IssueTable } from '@/components/domain/IssueTable';

const KEYS = ['q', 'severity', 'module', 'status', 'team', 'allocator', 'tier', 'template', 'delta', 'checkId', 'sort', 'page'] as const;
const OPEN: IssueStatus[] = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'FIXED'];

export default function IssuesBoardPage() {
  const f = useUrlFilters(KEYS);
  const emp = useEmployees();
  const statusList = f.getList('status') as IssueStatus[];
  const filter: IssueFilter = {
    q: f.get('q') || undefined,
    severity: f.getList('severity') as Severity[],
    module: f.getList('module') as AuditModule[],
    status: statusList.length ? statusList : f.get('status') === '' && !f.params.has('status') ? OPEN : undefined,
    team: f.getList('team') as (TeamId | 'unallocated')[],
    allocatorId: f.get('allocator') || undefined,
    tier: f.getList('tier').map(Number) as (1 | 2 | 3)[],
    template: f.getList('template') as PageTemplate[],
    delta: f.getList('delta'),
    checkId: f.get('checkId') || undefined,
    sort: (f.get('sort') as IssueFilter['sort']) || 'severity',
    page: Number(f.get('page')) || 1,
    pageSize: 25,
  };
  const q = useApiQuery(['issues', filter], () => api.listIssues(filter));
  const allocators = [...new Map(emp.list.filter((e) => e.role !== 'developer').map((e) => [e.id, e])).values()];
  const canFix = useAuth().can('shopify.edit');
  const [fixing, setFixing] = useState(false);
  const fixAll = canFix ? (
    <Button size="sm" variant="primary" icon={<Wand2 className="h-3.5 w-3.5" />} onClick={(e) => { e.stopPropagation(); setFixing(true); }} title="Prepare fixes for every eligible open issue — you review them before anything is written">Fix all</Button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title="Issues board"
        description="Every finding with severity, page tier and allocation. Filter by severity, module, allocated team, allocator and status (PDF §12.3). Nothing closes without automated re-verification."
        meta={<DemoBadge />}
        actions={
          <>
            <Link to="/issues/groups" className="inline-flex h-9 items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark"><Layers className="h-4 w-4" /> Template-level issues</Link>
            <Link to="/issues/exclusions" className="inline-flex h-9 items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark"><Ban className="h-4 w-4" /> Exclusions</Link>
          </>
        }
      />
      <Panel bodyClassName="space-y-3 p-3" className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input aria-label="Search issues" placeholder="Search by ID, title, check or URL" value={f.get('q')} onChange={(e) => f.set('q', e.target.value)} className="max-w-xs" />
          <ChipGroup label="Severity" value={f.getList('severity')} onChange={(v) => f.set('severity', v)} options={[{ value: 'critical', label: 'Critical' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }]} />
          <ChipGroup label="Tier" value={f.getList('tier')} onChange={(v) => f.set('tier', v)} options={[{ value: '1', label: 'T1' }, { value: '2', label: 'T2' }, { value: '3', label: 'T3' }]} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect label="Module" value={f.get('module')} onChange={(v) => f.set('module', v)} options={Object.entries(MODULE_LABELS).map(([value, label]) => ({ value, label }))} />
          <FilterSelect label="Status" allLabel="Open (default)" value={f.get('status')} onChange={(v) => f.set('status', v)} options={[...Object.entries(ISSUE_STATUS_LABELS).map(([value, label]) => ({ value, label })), { value: OPEN.join(','), label: 'Any open' }, { value: Object.keys(ISSUE_STATUS_LABELS).join(','), label: 'All statuses' }]} />
          <FilterSelect label="Allocated team" value={f.get('team')} onChange={(v) => f.set('team', v)} options={[{ value: 'unallocated', label: 'Unallocated' }, ...Object.values(TEAMS).map((t) => ({ value: t.id, label: t.name }))]} />
          <FilterSelect label="Allocator" value={f.get('allocator')} onChange={(v) => f.set('allocator', v)} options={[{ value: 'system', label: 'Sentinel (automatic)' }, ...allocators.map((e) => ({ value: e.id, label: e.name }))]} />
          <FilterSelect label="Change" value={f.get('delta')} onChange={(v) => f.set('delta', v)} options={[{ value: 'new', label: 'New' }, { value: 'worsening', label: 'Worsening' }, { value: 'recurring', label: 'Recurring' }, { value: 'unchanged', label: 'Unchanged' }, { value: 'resolved', label: 'Resolved' }]} />
          <FilterSelect label="Sort" allLabel="Severity" value={f.get('sort') === 'severity' ? '' : f.get('sort')} onChange={(v) => f.set('sort', v)} options={[{ value: 'priority', label: 'Priority score' }, { value: 'detected', label: 'Newest' }, { value: 'affected', label: 'Most URLs' }]} />
          {f.get('checkId') && <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-xs">Check: <span className="font-mono">{f.get('checkId')}</span></span>}
          <ClearFilters show={f.active} onClear={f.clear} />
        </div>
      </Panel>
      <Async q={q} rows={10}>
        {(p) => (
          <IssueTable
            issues={p.items}
            server={{ page: p.page, pageSize: p.pageSize, total: p.total, onPage: (n) => f.set('page', String(n)) }}
            empty={<EmptyState title="No issues match these filters" description="Clear filters to see everything, or include closed statuses." />}
            detectedAction={fixAll}
          />
        )}
      </Async>
      {fixing && <BulkFixDialog title="Fix all eligible issues" start={{ scope: 'issues' }} onClose={() => setFixing(false)} />}
    </div>
  );
}
