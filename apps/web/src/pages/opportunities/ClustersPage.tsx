import type { TopicCluster } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, DemoBadge, EmptyState, PageHeader, Panel, ProgressBar, Stat, type Tone } from '@/components/ui/primitives';
import { TrendChart } from '@/components/ui/charts';
import { SourceBadge } from '@/components/domain/badges';
import { SiteUrl, YesNo } from '@/components/opportunities/shared';
import { fmtNum } from '@/lib/format';

const PILLAR: Record<TopicCluster['pillarStatus'], { label: string; tone: Tone }> = {
  live: { label: 'Pillar live', tone: 'ok' },
  thin: { label: 'Pillar thin', tone: 'med' },
  missing: { label: 'Pillar missing', tone: 'crit' },
};

export default function ClustersPage() {
  const q = useApiQuery(['opportunities', 'clusters'], () => api.listClusters());
  return (
    <div>
      <PageHeader
        title="Topic clusters"
        description="Per topic cluster: pillar status, cluster completeness, pillar ↔ cluster interlinking integrity and combined weekly organic traffic. Missing pillars and broken links are flagged here (PDF §9 topic-cluster integrity, §13 cluster tracker)."
        meta={<DemoBadge />}
      />
      <Async q={q} rows={10} empty={(cs) => cs.length === 0 && <Panel><EmptyState title="No topic clusters defined" description="Clusters are derived from collections and blog categories after the first full crawl." /></Panel>}>
        {(clusters) => <Body clusters={clusters} />}
      </Async>
    </div>
  );
}

function Body({ clusters }: { clusters: TopicCluster[] }) {
  const avg = (f: (c: TopicCluster) => number) => Math.round(clusters.reduce((s, c) => s + f(c), 0) / clusters.length);
  const sorted = [...clusters].sort((a, b) => (a.pillarStatus === b.pillarStatus ? a.completeness - b.completeness : ['missing', 'thin', 'live'].indexOf(a.pillarStatus) - ['missing', 'thin', 'live'].indexOf(b.pillarStatus)));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Clusters tracked" value={clusters.length} />
        <Stat label="Pillars missing or thin" value={clusters.filter((c) => c.pillarStatus !== 'live').length} tone={clusters.some((c) => c.pillarStatus === 'missing') ? 'crit' : 'med'} />
        <Stat label="Avg completeness" value={`${avg((c) => c.completeness)}%`} />
        <Stat label="Avg interlink integrity" value={`${avg((c) => c.interlinkIntegrity)}%`} />
      </div>
      <p className="text-xs text-muted">Sorted with missing and thin pillars first, then lowest completeness. Traffic is GSC clicks per week — DEMO data until Search Console is connected.</p>
      {sorted.map((c) => <ClusterCard key={c.id} c={c} />)}
    </div>
  );
}

function ClusterCard({ c }: { c: TopicCluster }) {
  const first = c.trafficTrend[0]?.clicks ?? 0;
  const last = c.trafficTrend.at(-1)?.clicks ?? 0;
  const change = first ? Math.round(((last - first) / first) * 100) : 0;


  return (
    <Panel
      title={<span className="inline-flex flex-wrap items-center gap-2">{c.name}<Badge tone={PILLAR[c.pillarStatus].tone}>{PILLAR[c.pillarStatus].label}</Badge><SourceBadge source={c.source} /></span>}
      subtitle={c.pillarUrl ? <span className="font-mono">{c.pillarUrl.replace(/^https?:\/\/[^/]+/, '')}</span> : 'No pillar page'}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs text-muted">Cluster completeness</p>
            <ProgressBar value={c.completeness} tone={c.completeness >= 70 ? 'ok' : c.completeness >= 45 ? 'med' : 'crit'} label={`Completeness ${c.completeness}%`} />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">Interlink integrity</p>
            <ProgressBar value={c.interlinkIntegrity} tone={c.interlinkIntegrity >= 70 ? 'ok' : c.interlinkIntegrity >= 45 ? 'med' : 'crit'} label={`Interlink integrity ${c.interlinkIntegrity}%`} />
          </div>
          <div>
            <p className="text-xs text-muted">Combined weekly clicks</p>
            <p className="text-lg font-semibold tabular-nums">{fmtNum(last)} <span className={`text-xs font-medium ${change >= 0 ? 'text-ok-ink' : 'text-crit-ink'}`}>{change >= 0 ? '+' : ''}{change}% over 8 weeks</span></p>
          </div>
          {c.missingSubtopics.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted">Missing subtopics</p>
              <ul className="flex flex-wrap gap-1">{c.missingSubtopics.map((s) => <li key={s}><Badge tone="opp">{s}</Badge></li>)}</ul>
            </div>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <TrendChart data={c.trafficTrend} x="week" series={[{ key: 'clicks', label: 'Clicks / week' }]} height={150} area />
          <div className="relative overflow-x-auto rounded-ctl border border-line">
            <table className="w-full min-w-[480px] text-sm">
              <caption className="sr-only">Cluster pages for {c.name}</caption>
              <thead><tr className="border-b border-line bg-raised/70 text-left text-xs text-muted"><th scope="col" className="px-3 py-2 font-medium">Cluster page</th><th scope="col" className="px-3 py-2 font-medium">Links to pillar</th><th scope="col" className="px-3 py-2 font-medium">Linked from pillar</th></tr></thead>
              <tbody>
                {c.pages.map((p) => (
                  <tr key={p.url} className="border-b border-line last:border-0">
                    <td className="max-w-[320px] px-3 py-2"><SiteUrl url={p.url} /></td>
                    <td className="px-3 py-2"><YesNo value={p.linksToPillar} yes="Yes" no="Missing" /></td>
                    <td className="px-3 py-2"><YesNo value={p.linkedFromPillar} yes="Yes" no="Missing" /></td>
                  </tr>
                ))}
                {!c.pages.length && <tr><td colSpan={3} className="px-3 py-3 text-muted">No cluster pages yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Panel>
  );
}
