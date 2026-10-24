import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { CHECKS_BY_ID, MODULE_LABELS, type Issue, type IssueGroup, type PageTemplate } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, DemoBadge, EmptyState, LoadingBlock, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { IssueStatusBadge, SeverityBadge, SlaCountdown, SourceBadge, TeamBadge, TierBadge } from '@/components/domain/badges';
import { fmtDateTime, fmtNum } from '@/lib/format';

type GroupRow = IssueGroup & { parent: Issue };

const TEMPLATE_LABELS: Record<PageTemplate, string> = {
  home: 'Homepage', collection: 'Collection template', product: 'Product template', blog_article: 'Blog article template', blog_index: 'Blog index', page: 'Static page template', search: 'Search results', other: 'Other template',
};

export default function IssueGroupsPage() {
  const q = useApiQuery(['groups'], () => api.listIssueGroups());
  return (
    <div>
      <PageHeader
        title="Template-level issues"
        description="Related page-level issues that share one root cause in a Shopify theme template, grouped into a single fix (PDF §3.3, §11.2)."
        meta={<DemoBadge />}
        actions={<Link to="/issues" className="inline-flex h-9 items-center rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark">All issues</Link>}
      />
      <div className="space-y-5">
        <Notice tone="signal" title="Why issues are grouped">
          <ul className="list-disc space-y-0.5 pl-5">
            <li>Three or more related <strong>Medium</strong> issues on one template (for example every product page missing offers schema) are grouped into <strong>one Critical template-level issue</strong>, because template bugs multiply across every page that uses them.</li>
            <li>One template fix supersedes the page-level cards, so the team works one issue instead of hundreds. Child issues are marked Superseded and close when the parent is verified.</li>
          </ul>
        </Notice>
        <Async q={q} rows={6} empty={(d) => d.length === 0 && <Panel><EmptyState icon={<Layers className="h-7 w-7" />} title="No template-level issues" description="Groups appear automatically when three or more related Medium issues land on the same template." /></Panel>}>
          {(groups) => <Body groups={groups.filter((g) => !!g.parent)} />}
        </Async>
      </div>
    </div>
  );
}

function Body({ groups }: { groups: GroupRow[] }) {
  const open = groups.filter((g) => !['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE'].includes(g.parent.status));
  const children = groups.reduce((a, g) => a + g.issueIds.length, 0);
  const pages = groups.reduce((a, g) => a + g.parent.affectedCount, 0);
  const unallocated = open.filter((g) => !g.parent.allocatedTeam).length;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Template-level issues" value={groups.length} hint={`${open.length} open`} />
        <Stat label="Page-level issues superseded" value={children} hint="Replaced by one fix each" />
        <Stat label="Pages covered" value={fmtNum(pages)} />
        <Stat label="Open and unallocated" value={unallocated} tone={unallocated ? 'crit' : 'ok'} />
      </div>
      {groups.map((g) => <GroupCard key={g.id} g={g} />)}
    </div>
  );
}

function GroupCard({ g }: { g: GroupRow }) {
  const { parent } = g;
  const [expanded, setExpanded] = useState(false);
  const check = CHECKS_BY_ID[g.checkId];
  const done = ['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE', 'SUPERSEDED', 'FIXED'].includes(parent.status);
  return (
    <Panel bodyClassName="p-0">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={parent.severity} />
          <IssueStatusBadge status={parent.status} />
          <TierBadge tier={parent.highestTier} />
          <Badge tone="opp" icon={<Layers className="h-3 w-3" />}>{TEMPLATE_LABELS[g.template]}</Badge>
          <SourceBadge source={parent.source} />
          <span className="ml-auto"><SlaCountdown dueAt={parent.slaDueAt} done={done} /></span>
        </div>
        <div>
          <Link to={`/issues/${parent.id}`} className="text-[15px] font-semibold text-ink hover:text-signal hover:underline">{parent.title}</Link>
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-mono">{parent.id}</span> · <span className="font-mono">{g.id}</span> · {MODULE_LABELS[parent.module]} · {check?.name ?? g.checkId} · grouped {fmtDateTime(g.createdAt)} IST
          </p>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted">Affected pages</dt><dd className="font-medium tabular-nums">{fmtNum(parent.affectedCount)} <span className="text-xs font-normal text-muted">(T1 {parent.tierBreakdown[1]} · T2 {parent.tierBreakdown[2]} · T3 {parent.tierBreakdown[3]})</span></dd></div>
          <div><dt className="text-xs text-muted">Child issues</dt><dd className="font-medium tabular-nums">{g.issueIds.length}</dd></div>
          <div><dt className="text-xs text-muted">Allocated</dt><dd><TeamBadge team={parent.allocatedTeam} /></dd></div>
          <div className="sm:col-span-3"><dt className="text-xs text-muted">Why grouped</dt><dd className="text-ink-soft">{g.reason}</dd></div>
        </dl>
      </div>
      <div className="border-t border-line">
        <button type="button" className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-sm font-medium text-ink hover:bg-raised" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          {expanded ? 'Hide' : 'Show'} {g.issueIds.length} child issue{g.issueIds.length === 1 ? '' : 's'} superseded by this fix
        </button>
        {expanded && <Children parentId={parent.id} ids={g.issueIds} />}
      </div>
    </Panel>
  );
}

function Children({ parentId, ids }: { parentId: string; ids: string[] }) {
  const { can } = useAuth();
  const q = useApiQuery(['issue', parentId], () => api.getIssue(parentId), { enabled: can('issues.view') });
  if (q.isLoading) return <div className="p-4"><LoadingBlock rows={3} /></div>;
  const children = q.data?.children;
  if (q.error || !children) {
    // Fall back to plain links when the detail call fails.
    return (
      <ul className="divide-y divide-line border-t border-line">
        {ids.map((id) => <li key={id}><Link to={`/issues/${id}`} className="block px-4 py-2 font-mono text-xs text-signal hover:bg-raised">{id}</Link></li>)}
      </ul>
    );
  }
  return (
    <ul className="divide-y divide-line border-t border-line">
      {children.map((c) => (
        <li key={c.id}>
          <Link to={`/issues/${c.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 hover:bg-raised">
            <span className="w-[72px] shrink-0 font-mono text-xs text-muted">{c.id}</span>
            <SeverityBadge severity={c.severity} />
            <span className="min-w-0 flex-1 text-sm">{c.title}</span>
            <span className="text-xs tabular-nums text-muted">{fmtNum(c.affectedCount)} URL{c.affectedCount === 1 ? '' : 's'}</span>
            <IssueStatusBadge status={c.status} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
