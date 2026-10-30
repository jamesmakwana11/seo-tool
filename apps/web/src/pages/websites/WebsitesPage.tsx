import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Pencil, Plus } from 'lucide-react';
import type { WebsiteSummary } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, EmptyState, ErrorState, LoadingBlock, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { SiteMark } from '@/components/websites/WebsiteSelector';
import { WebsiteFormDialog } from '@/components/websites/WebsiteFormDialog';
import { platformLabel, useWebsites } from '@/websites/WebsiteContext';
import { useApiQuery } from '@/api/hooks';
import { fmtRelative } from '@/lib/format';
import { api } from '@/api/client';

export function SiteStatus({ w }: { w: WebsiteSummary }) {
  if (!w.hasAuditData) return <Badge tone="neutral" title="No completed crawl and no findings — nothing is scored for this website.">Not crawled yet</Badge>;
  return w.source === 'sample' ? <Badge tone="caution">Sample data</Badge> : <Badge tone="ok">Audited</Badge>;
}

export default function WebsitesPage() {
  const { websites, loading, error, refetch, select, websiteId } = useWebsites();
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<WebsiteSummary | null>(null);
  const [adding, setAdding] = useState(false);
  const canManage = can('websites.manage');
  useEffect(() => {
    if (params.get('add') === '1') { if (canManage) setAdding(true); params.delete('add'); setParams(params, { replace: true }); }
  }, [params, setParams, canManage]);

  // Whether this server keeps data in a database (from the crawler status of the selected website).
  const storage = useApiQuery(['crawls', 'status'], () => api.getCrawlerStatus());
  return (
    <div>
      <PageHeader
        title="Websites"
        description="Each website is a separate SEO workspace with its own issues, Fix Cards, crawls, reports, settings and integrations. Switching websites never mixes their data."
        actions={canManage ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>Add website</Button> : undefined}
      />
      <div className="space-y-5">
        {storage.data?.temporaryStorage && (
          <Notice tone="caution">
            {'This server has no database (DATABASE_URL is not set): websites and their crawl results are kept in temporary memory and are lost when it restarts.'}
          </Notice>
        )}
        <Panel bodyClassName="p-3">
          {loading ? <LoadingBlock rows={4} /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
            <DataTable
              rows={websites ?? []}
              rowKey={(w) => w.id}
              search={(w) => `${w.name} ${w.domain} ${w.url} ${platformLabel(w.platform)}`}
              searchPlaceholder="Search by name or domain"
              empty={<EmptyState title="No websites match" description="Try another name or domain." />}
              initialSort={{ key: 'name', dir: 'asc' }}
              rowClassName={(w) => (w.id === websiteId ? 'bg-signal/[0.06]' : undefined)}
              columns={[
                {
                  key: 'name', header: 'Website', sort: (a, b) => a.name.localeCompare(b.name),
                  cell: (w) => (
                    <div className="flex min-w-0 items-center gap-3">
                      <SiteMark site={w} />
                      <div className="min-w-0 leading-tight">
                        <div className="truncate font-medium text-ink">{w.name}{w.id === websiteId && <span className="ml-2 text-2xs font-medium text-signal">Selected</span>}</div>
                        <a href={w.url} target="_blank" rel="noreferrer noopener" className="truncate font-mono text-xs text-muted hover:text-ink">{w.domain}</a>
                      </div>
                    </div>
                  ),
                },
                { key: 'platform', header: 'Platform', hideOnMobile: true, cell: (w) => <span className="text-sm text-ink-soft">{platformLabel(w.platform)}</span>, sort: (a, b) => a.platform.localeCompare(b.platform) },
                { key: 'status', header: 'Status', cell: (w) => <SiteStatus w={w} /> },
                { key: 'crawl', header: 'Last crawl', hideOnMobile: true, cell: (w) => <span className="text-xs text-muted">{w.lastCrawlAt ? `${fmtRelative(w.lastCrawlAt)}${w.lastCrawlSource === 'simulated' ? ' · simulated' : ''}` : 'Never'}</span> },
                { key: 'health', header: 'Health', cell: (w) => (w.healthScore !== undefined ? <span className="font-semibold tabular-nums text-ink">{w.healthScore}</span> : <span className="text-xs text-faint" title="No score until the website has audit data">No score</span>), sort: (a, b) => (a.healthScore ?? -1) - (b.healthScore ?? -1) },
                { key: 'issues', header: 'Open issues', hideOnMobile: true, cell: (w) => (w.hasAuditData ? <span className="inline-flex items-center gap-2 text-xs tabular-nums"><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-crit" />{w.openIssues.critical}</span><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-med" />{w.openIssues.medium}</span><span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-low" />{w.openIssues.low}</span></span> : <span className="text-xs text-faint">—</span>) },
                { key: 'integrations', header: 'Integrations', hideOnMobile: true, cell: (w) => <span className={w.integrationsConnected ? 'text-xs text-ok-ink' : 'text-xs text-muted'}>{w.integrationsConnected} of {w.integrationsTotal} connected</span> },
                {
                  key: 'actions', header: <span className="sr-only">Actions</span>,
                  cell: (w) => (
                    <div className="flex justify-end gap-1.5">
                      {canManage && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(w)} aria-label={`Edit ${w.name}`} title={`Edit ${w.name}`}>Edit</Button>}
                      <Button size="sm" icon={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => { select(w.id); nav('/'); }}>Open</Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Panel>
      </div>
      {adding && <WebsiteFormDialog open onClose={() => setAdding(false)} onSaved={(w) => select(w.id, '/')} />}
      {editing && <WebsiteFormDialog open website={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
