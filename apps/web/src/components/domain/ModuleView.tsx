import { useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CheckCircle2, CircleDashed, CircleSlash, XCircle, AlertTriangle } from 'lucide-react';
import { MODULE_LABELS, type AuditModule, type ModuleData } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, DemoBadge, EmptyState, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { IssueTable } from './IssueTable';
import { scoreColor } from './HealthScore';
import { Link } from 'react-router-dom';

const STATUS_ICON = {
  pass: <CheckCircle2 className="h-4 w-4 text-ok-ink" aria-label="Pass" />,
  warn: <AlertTriangle className="h-4 w-4 text-med-ink" aria-label="Warning" />,
  fail: <XCircle className="h-4 w-4 text-crit-ink" aria-label="Fail" />,
  not_run: <CircleDashed className="h-4 w-4 text-faint" aria-label="Opportunity / metric" />,
  unavailable: <CircleSlash className="h-4 w-4 text-faint" aria-label="Unavailable" />,
  not_built: <CircleSlash className="h-4 w-4 text-med-ink" aria-label="Not built yet" />,
  awaiting_crawl: <CircleDashed className="h-4 w-4 text-faint" aria-label="No crawl yet" />,
};
const STATUS_LABEL = { pass: 'Pass', warn: 'Open issues', fail: 'Critical open', not_run: 'Metric / opportunity', unavailable: 'Data source missing', not_built: 'Not built yet', awaiting_crawl: 'No crawl yet' };

export function useModule(module: AuditModule) {
  return useApiQuery(['module', module], () => api.getModule(module));
}

/** Check-library table for a module (one row per PDF table row). */
export function CheckTable({ checks, groupFilter }: { checks: ModuleData['checks']; groupFilter?: string }) {
  const rows = groupFilter ? checks.filter((c) => c.group.startsWith(groupFilter)) : checks;
  return (
    <DataTable
      rows={rows}
      rowKey={(c) => c.id}
      dense
      caption="Checks"
      columns={[
        { key: 's', header: 'Status', width: '120px', cell: (c) => <span className="inline-flex items-center gap-1.5 text-xs">{STATUS_ICON[c.lastStatus]}<span className="text-muted">{STATUS_LABEL[c.lastStatus]}</span></span> },
        {
          key: 'n', header: 'Check', cell: (c) => (
            <div className="min-w-[260px]">
              <div className="font-medium text-ink">{c.name} <span className="font-mono text-2xs font-normal text-faint">{c.id}</span></div>
              <div className="mt-0.5 text-xs text-muted">{c.detects}</div>
              {c.policy && <div className="mt-0.5 text-xs text-opp-ink">Protects against: {c.policy}</div>}
              {(c.lastStatus === 'not_built' || c.lastStatus === 'unavailable' || c.lastStatus === 'awaiting_crawl') && c.unavailableReason && <div className="mt-0.5 text-xs text-med-ink">{c.unavailableReason}</div>}
            </div>
          ),
        },
        { key: 'sev', header: 'Default severity (PDF)', hideOnMobile: true, cell: (c) => <span className="text-xs text-ink-soft">{c.defaultSeverityText}</span> },
        { key: 'cad', header: 'Cadence', hideOnMobile: true, cell: (c) => <span className="text-xs capitalize text-muted">{c.cadence.replace('_', ' ')}</span> },
        { key: 'src', header: 'Data', hideOnMobile: true, cell: (c) => <span className="text-xs text-muted" title={c.unavailableReason}>{c.dataSources.join(', ')}</span> },
        { key: 'o', header: 'Open', width: '64px', cell: (c) => (c.openIssues ? <Link to={`/issues?checkId=${c.id}`} className="font-semibold tabular-nums text-signal hover:underline">{c.openIssues}</Link> : <span className="text-faint">0</span>) },
        { key: 'p', header: 'PDF', width: '56px', hideOnMobile: true, cell: (c) => <span className="text-xs text-muted">p{c.pdfRef.page}</span> },
      ]}
    />
  );
}

/**
 * Standard module screen: score, data-source notes, check library, open findings.
 * `extra` renders module-specific panels (CWV table, backlinks, AI panel…) between checks and issues.
 */
export function ModuleView({ module, title, description, groupFilter, extra, headerActions }: { module: AuditModule; title?: string; description: ReactNode; groupFilter?: string; extra?: ReactNode; headerActions?: ReactNode }) {
  const q = useModule(module);
  const [tab, setTab] = useState<'open' | 'all'>('open');
  return (
    <div>
      <PageHeader title={title ?? MODULE_LABELS[module]} description={description} meta={<DemoBadge />} actions={headerActions} />
      <Async q={q} rows={8}>
        {(d) => <ModuleBody d={d} groupFilter={groupFilter} extra={extra} tab={tab} setTab={setTab} />}
      </Async>
    </div>
  );
}

function ModuleBody({ d, groupFilter, extra, tab, setTab }: { d: ModuleData; groupFilter?: string; extra?: ReactNode; tab: 'open' | 'all'; setTab: (t: 'open' | 'all') => void }) {
  const checks = groupFilter ? d.checks.filter((c) => c.group.startsWith(groupFilter)) : d.checks;
  const ids = useMemo(() => new Set(checks.map((c) => c.id)), [checks]);
  const issues = d.issues.filter((i) => ids.has(i.checkId));
  const open = issues.filter((i) => ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'FIXED'].includes(i.status));
  const crit = open.filter((i) => i.severity === 'critical').length;
  const med = open.filter((i) => i.severity === 'medium').length;
  const low = open.filter((i) => i.severity === 'low').length;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {d.score !== undefined && !groupFilter && <Stat label="Module score" value={<span style={{ color: scoreColor(d.score) }}>{d.score.toFixed(1)}</span>} hint="PDF §14 module score" />}
        <Stat label="Checks" value={checks.length} hint={`${checks.filter((c) => c.lastStatus === 'pass').length} passing · ${checks.filter((c) => c.lastStatus === 'not_built').length} not built yet`} />
        <Stat label="Critical open" value={crit} tone={crit ? 'crit' : undefined} />
        <Stat label="Medium open" value={med} tone={med ? 'med' : undefined} />
        <Stat label="Low open" value={low} tone={low ? 'low' : undefined} />
      </div>
      {d.dataNotes.map((n) => <Notice key={n} tone="demo">{n}</Notice>)}
      <Panel title="Check library" subtitle="Every check from the specification for this area, with its last result." bodyClassName="p-3">
        <CheckTable checks={checks} />
      </Panel>
      {extra}
      <Panel
        title="Findings"
        actions={
          <div className="flex rounded-ctl border border-line p-0.5 text-xs" role="group" aria-label="Findings filter">
            {(['open', 'all'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={clsx('rounded px-2 py-1', tab === t ? 'bg-signal-tint text-signal-dark' : 'text-muted hover:text-ink')} aria-pressed={tab === t}>
                {t === 'open' ? `Open (${open.length})` : `All (${issues.length})`}
              </button>
            ))}
          </div>
        }
        bodyClassName="p-3"
      >
        <IssueTable issues={tab === 'open' ? open : issues} showModule={false} empty={<EmptyState title="No open findings" description="Every check in this area passed its last run." />} />
      </Panel>
    </div>
  );
}

export function ModuleLinkCards({ items }: { items: { to: string; title: string; text: string; badge?: ReactNode }[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((i) => (
        <Link key={i.to} to={i.to} className="rounded-panel border border-line bg-surface p-4 shadow-card transition-[border-color,box-shadow] hover:border-signal/40 hover:shadow-lift">
          <div className="flex items-center justify-between gap-2"><span className="font-medium text-ink">{i.title}</span>{i.badge}</div>
          <p className="mt-1 text-sm text-muted">{i.text}</p>
        </Link>
      ))}
    </div>
  );
}

