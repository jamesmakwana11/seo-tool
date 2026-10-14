import { Link } from 'react-router-dom';
import type { TopicCluster } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { ModuleView } from '@/components/domain/ModuleView';
import { Async, Badge, EmptyState, Panel, ProgressBar } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { SourceBadge } from '@/components/domain/badges';
import { Bullets, NoAccess, OpportunityPanel, PanelLink, SrOnly } from '@/components/modules/shared';
import { shortUrl } from '@/lib/format';

export default function GeoPage() {
  return (
    <ModuleView
      module="geo"
      description="Whether generative engines can trust, cite and retrieve DeoDap: E-E-A-T surfaces, citation-worthy data, topic clusters, semantic coverage, freshness, brand facts and chunk-friendly structure (PDF §9)."
      extra={
        <div className="space-y-5">
          <ClusterPanel />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <OpportunityPanel
              title="Citation gaps"
              subtitle="GEO-CITATION — original stats, price benchmarks and guides with unique data an AI would cite"
              kinds={['citation_gap']}
              defaultTeam="content"
              empty={{ title: 'No citation gaps flagged', description: 'Gaps appear when no citation-worthy original data covers a money topic.' }}
            />
            <BrandFacts />
          </div>
        </div>
      }
    />
  );
}

function ClusterPanel() {
  const { can } = useAuth();
  const allowed = can('opportunities.view');
  const q = useApiQuery(['opportunities', 'clusters'], () => api.listClusters(), { enabled: allowed });
  return (
    <Panel title="Topic-cluster integrity" subtitle="GEO-CLUSTER — pillar → cluster internal-link graph per category; orphan cluster pages and missing pillars" actions={allowed ? <PanelLink to="/opportunities/clusters">Cluster details</PanelLink> : undefined} bodyClassName="p-3">
      {!allowed ? <NoAccess what="Topic clusters" perm="opportunities.view" /> : (
        <Async q={q} rows={5}>
          {(rows) => (
            <DataTable<TopicCluster>
              rows={rows}
              rowKey={(c) => c.id}
              dense
              caption="Topic clusters"
              initialSort={{ key: 'comp', dir: 'asc' }}
              empty={<EmptyState title="No topic clusters defined" description="Define clusters on the clusters screen to track pillar and interlink health." />}
              columns={[
                { key: 'n', header: 'Cluster', cell: (c) => <div><span className="font-medium">{c.name}</span>{c.pillarUrl && <div className="font-mono text-2xs text-muted">{shortUrl(c.pillarUrl)}</div>}</div> },
                { key: 'p', header: 'Pillar', width: '100px', cell: (c) => <Badge tone={c.pillarStatus === 'live' ? 'ok' : c.pillarStatus === 'thin' ? 'med' : 'crit'}>{c.pillarStatus === 'live' ? 'Live' : c.pillarStatus === 'thin' ? 'Thin' : 'Missing'}</Badge> },
                { key: 'comp', header: 'Completeness', width: '160px', sort: (a, b) => a.completeness - b.completeness, cell: (c) => <ProgressBar value={c.completeness} tone={c.completeness < 50 ? 'med' : 'signal'} label={`${c.name} completeness ${c.completeness}%`} /> },
                { key: 'int', header: 'Interlink integrity', width: '160px', sort: (a, b) => a.interlinkIntegrity - b.interlinkIntegrity, cell: (c) => <ProgressBar value={c.interlinkIntegrity} tone={c.interlinkIntegrity < 50 ? 'crit' : c.interlinkIntegrity < 80 ? 'med' : 'ok'} label={`${c.name} interlink integrity ${c.interlinkIntegrity}%`} /> },
                { key: 'orph', header: 'Pages not linked both ways', width: '110px', hideOnMobile: true, cell: (c) => { const n = c.pages.filter((p) => !p.linksToPillar || !p.linkedFromPillar).length; return <span className={`tabular-nums ${n ? 'text-med-ink' : 'text-muted'}`}>{n} of {c.pages.length}</span>; } },
                { key: 'miss', header: 'Missing subtopics', hideOnMobile: true, cell: (c) => <span className="text-xs text-muted">{c.missingSubtopics.join(', ') || '—'}</span> },
                { key: 's', header: <SrOnly>Source</SrOnly>, width: '80px', hideOnMobile: true, cell: (c) => <SourceBadge source={c.source} /> },
              ]}
            />
          )}
        </Async>
      )}
    </Panel>
  );
}

function BrandFacts() {
  return (
    <Panel title="Brand-fact consistency" subtitle="GEO-BRAND-FACTS — conflicting facts confuse knowledge graphs">
      <div className="space-y-3 text-sm text-ink-soft">
        <p>The same facts about DeoDap must read identically everywhere an engine might learn them:</p>
        <Bullets items={[
          'Founding year, legal name and headquarters location',
          'USPs: No MOQ, wholesale pricing, COD, shipping coverage',
          'Contact details and customer-support hours',
        ]} />
        <p>Sources compared: the site (About page, footer, Organization schema), Google Business Profile, LinkedIn and marketplace seller profiles. A mismatch raises a Medium finding naming both values.</p>
        <p className="text-xs text-muted">Comparing external profiles needs the GBP API and profile URLs configured; site-side facts are checked by the crawler. See <Link to="/issues?checkId=GEO-BRAND-FACTS" className="text-signal hover:underline">open GEO-BRAND-FACTS findings</Link>.</p>
      </div>
    </Panel>
  );
}
