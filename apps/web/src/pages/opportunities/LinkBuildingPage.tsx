import { Link } from 'react-router-dom';
import type { LinkProspect } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, EmptyState, Notice, PageHeader, Panel, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { SourceBadge } from '@/components/domain/badges';
import { OPP_KIND_LABELS, OppStatusBadge, OpportunityActions, SiteUrl } from '@/components/opportunities/shared';
import { fmtNum, fmtRelative } from '@/lib/format';

const PROSPECT_STATUS: Record<LinkProspect['status'], { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'opp' },
  outreach: { label: 'In outreach', tone: 'signal' },
  won: { label: 'Link won', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'neutral' },
};

export default function LinkBuildingPage() {
  return (
    <div>
      <PageHeader
        title="Link building & digital PR"
        description="Competitor backlink gap — domains linking to two or more competitors but not DeoDap, sorted by DR × relevance with a suggested pitch angle — plus digital PR and seasonal opportunities (PDF §7.2)."
        actions={<Link to="/opportunities/mentions" className="inline-flex h-9 items-center rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark">Unlinked brand mentions</Link>}
      />
      <div className="space-y-5">
        <Notice tone="caution">The weekly backlink-gap pull needs an Ahrefs or Semrush API subscription; Sentinel never sends outreach itself — the SEO team does, from the task.</Notice>
        <Prospects />
        <PrOpportunities />
      </div>
    </div>
  );
}


function Prospects() {
  const q = useApiQuery(['opportunities', 'prospects'], () => api.listLinkProspects());
  const columns: Column<LinkProspect>[] = [
    { key: 'domain', header: 'Domain', cell: (p) => <span className="font-mono text-[12.5px] font-medium">{p.domain}</span>, sort: (a, b) => a.domain.localeCompare(b.domain) },
    { key: 'dr', header: 'DR', cell: (p) => <span className="tabular-nums">{p.domainRating}</span>, sort: (a, b) => a.domainRating - b.domainRating },
    { key: 'rel', header: 'Relevance', cell: (p) => <span className="tabular-nums">{Math.round(p.relevance * 100)}%</span>, sort: (a, b) => a.relevance - b.relevance, hideOnMobile: true },
    { key: 'priority', header: <span title="DR × relevance">Priority</span>, cell: (p) => <span className="font-semibold tabular-nums">{fmtNum(p.domainRating * p.relevance)}</span>, sort: (a, b) => a.domainRating * a.relevance - b.domainRating * b.relevance },
    { key: 'comps', header: 'Links to competitors', cell: (p) => <span className="text-xs">{p.linksToCompetitors.join(', ')}</span>, hideOnMobile: true },
    { key: 'pitch', header: 'Pitch angle', cell: (p) => <span className="text-sm">{p.pitchAngle}</span> },
    { key: 'status', header: 'Status', cell: (p) => <div className="flex flex-col items-start gap-1"><Badge tone={PROSPECT_STATUS[p.status].tone}>{PROSPECT_STATUS[p.status].label}</Badge><SourceBadge source={p.source} /></div>, sort: (a, b) => a.status.localeCompare(b.status) },
    {
      key: 'action', header: <span className="sr-only">Actions</span>,
      cell: (p) => (p.status === 'won' || p.status === 'rejected' ? <span className="text-xs text-muted">Closed</span> : null),
    },
  ];
  return (
    <Panel title="Link prospects" subtitle="Priority = domain rating × relevance — highest first" bodyClassName="p-3">
      <Async q={q} rows={6}>
        {(rows) => (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(p) => p.id}
            search={(p) => `${p.domain} ${p.pitchAngle} ${p.linksToCompetitors.join(' ')}`}
            searchPlaceholder="Search prospects"
            initialSort={{ key: 'priority', dir: 'desc' }}
            caption="Link prospects"
            empty={<EmptyState title="No link prospects" description="The weekly competitor backlink-gap job adds domains here." />}
          />
        )}
      </Async>
    </Panel>
  );
}

function PrOpportunities() {
  const q = useApiQuery(['opportunities'], () => api.listOpportunities());
  return (
    <Panel title="Digital PR & seasonal opportunities" subtitle="Data stories and festival-driven pitches, ranked by value" actions={<Link to="/opportunities?kind=digital_pr,seasonal&status=all" className="text-sm text-signal hover:underline">On the opportunities board</Link>} bodyClassName="p-0">
      <Async q={q} rows={4}>
        {(all) => {
          const rows = all.filter((o) => o.kind === 'digital_pr' || o.kind === 'seasonal').sort((a, b) => b.value - a.value);
          if (!rows.length) return <EmptyState title="No digital PR or seasonal opportunities" description="The weekly digital-PR scan and the seasonal planner add items here." />;
          return (
            <ul className="divide-y divide-line">
              {rows.map((o) => (
                <li key={o.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-start md:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone="opp">{OPP_KIND_LABELS[o.kind]}</Badge>
                      <OppStatusBadge status={o.status} />
                      <SourceBadge source={o.source} />
                    </div>
                    <p className="text-sm font-medium">{o.title}</p>
                    <p className="text-sm text-muted">{o.detail}</p>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                      {o.url && <SiteUrl url={o.url} />}
                      <span>Found {fmtRelative(o.createdAt)}</span>
                      <span className="tabular-nums">Value {fmtNum(o.value)}</span>
                    </div>
                  </div>
                  <OpportunityActions o={o} />
                </li>
              ))}
            </ul>
          );
        }}
      </Async>
    </Panel>
  );
}
