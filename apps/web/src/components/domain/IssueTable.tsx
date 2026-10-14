import { useNavigate } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { CHECKS_BY_ID, MODULE_LABELS, SEVERITY_ORDER, type Issue } from '@sentinel/shared';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { DeltaBadge, IssueStatusBadge, SeverityBadge, SlaCountdown, TeamBadge, TierBadge } from './badges';
import { fmtNum, fmtRelative } from '@/lib/format';
import type { ReactNode } from 'react';

export function issueColumns(opts: { showModule?: boolean; showAllocator?: boolean } = {}): Column<Issue>[] {
  const cols: Column<Issue>[] = [
    { key: 'sev', header: 'Severity', width: '108px', cell: (i) => <SeverityBadge severity={i.severity} />, sort: (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] },
    {
      key: 'title', header: 'Issue', cell: (i) => (
        <div className="min-w-[240px]">
          <div className="flex items-start gap-1.5">
            {i.isTemplateGroup && <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-opp-ink" aria-label="Template-level group" />}
            <span className="font-medium text-ink">{i.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span className="font-mono">{i.id}</span>
            <span>{CHECKS_BY_ID[i.checkId]?.name}</span>
            {opts.showModule && <span>· {MODULE_LABELS[i.module]}</span>}
            {i.severityHistory.some((h) => h.rule !== 'template_grouping') && <span className="text-crit-ink">· escalated</span>}
          </div>
        </div>
      ),
    },
    { key: 'tier', header: 'Tier', width: '56px', cell: (i) => <TierBadge tier={i.highestTier} />, sort: (a, b) => b.highestTier - a.highestTier },
    { key: 'urls', header: 'URLs', width: '64px', className: 'tabular-nums', cell: (i) => fmtNum(i.affectedCount), sort: (a, b) => a.affectedCount - b.affectedCount },
    { key: 'delta', header: 'Change', hideOnMobile: true, cell: (i) => <DeltaBadge delta={i.delta} /> },
    { key: 'status', header: 'Status', cell: (i) => <IssueStatusBadge status={i.status} /> },
    {
      key: 'team', header: 'Allocated', hideOnMobile: true, cell: (i) => (
        <div>
          <TeamBadge team={i.allocatedTeam} short />
          {opts.showAllocator && i.allocation.length > 0 && <div className="mt-0.5 text-xs text-muted">by {i.allocation.at(-1)!.allocatedByName}</div>}
        </div>
      ),
    },
    { key: 'sla', header: 'SLA', hideOnMobile: true, cell: (i) => <SlaCountdown dueAt={i.slaDueAt} done={['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE', 'SUPERSEDED', 'FIXED'].includes(i.status)} />, sort: (a, b) => +new Date(b.slaDueAt) - +new Date(a.slaDueAt) },
    { key: 'det', header: 'Detected', hideOnMobile: true, cell: (i) => <span className="text-xs text-muted">{fmtRelative(i.detectedAt)}</span>, sort: (a, b) => +new Date(a.detectedAt) - +new Date(b.detectedAt) },
  ];
  return cols;
}

export function IssueTable({ issues, showModule = true, empty, toolbar, server }: { issues: Issue[]; showModule?: boolean; empty?: ReactNode; toolbar?: ReactNode; server?: { page: number; pageSize: number; total: number; onPage: (p: number) => void } }) {
  const nav = useNavigate();
  return (
    <DataTable
      rows={issues}
      columns={issueColumns({ showModule, showAllocator: true })}
      rowKey={(i) => i.id}
      onRowClick={(i) => nav(`/issues/${i.id}`)}
      search={server ? undefined : (i) => `${i.id} ${i.title} ${i.checkId} ${i.affectedUrls.slice(0, 5).join(' ')}`}
      searchPlaceholder="Search issues"
      empty={empty}
      toolbar={toolbar}
      server={server}
      caption="Issues"
    />
  );
}
