import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { type CrawlDetail, type CrawledUrl, type SitemapDiff } from '@sentinel/shared';
import { api } from '@/api/client';
import { DetailError } from '@/components/domain/DetailError';
import { useApiQuery, useRefreshWhenCrawlsFinish, useSiteKey } from '@/api/hooks';
import { Badge, DemoBadge, EmptyState, KV, LoadingBlock, Mono, Notice, PageHeader, Panel, Tabs } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { ChipGroup } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { UrlList } from '@/components/domain/lists';
import { CRAWL_TRIGGER_LABELS, CRAWL_TYPE_LABELS, CrawlStatusBadge, HttpStatusBadge, VERIFICATION_METHOD_LABELS, VerificationOutcomeBadge } from '@/components/crawls/crawlBadges';
import { fmtDuration } from '@/components/crawls/format';
import { CrawlProgress, ExportButtons, TemporaryResultsNote } from '@/components/crawls/LiveCrawl';
import { hasPageDetails, IssuesFound, PageResults } from '@/components/crawls/PageResults';
import { CoverageReport, OutcomeBadge, RunDiagnostics } from '@/components/crawls/Coverage';
import { ChangesTab } from '@/components/crawls/ChangeMonitor';
import { fmtDateTime, fmtMs, fmtNum, shortUrl } from '@/lib/format';

type Tab = 'urls' | 'issues' | 'changes' | 'coverage' | 'sitemap' | 'reverify';

export default function CrawlRunPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const siteKey = useSiteKey();
  const cached = qc.getQueryData<CrawlDetail>(siteKey(['crawl', id]));
  const active = cached?.run.status === 'running' || cached?.run.status === 'queued';
  const q = useApiQuery(['crawl', id], () => api.getCrawl(id), { refetchInterval: active ? 2000 : undefined });
  const st = q.data?.run.status;
  useRefreshWhenCrawlsFinish(st ? (st === 'running' || st === 'queued' ? [id] : []) : undefined);

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error) return <DetailError error={q.error} what="Crawl run" id={id} back={{ to: '/crawls', label: 'Back to the Crawl Center' }} onRetry={() => q.refetch()} />;
  if (!q.data) return null;
  return <Detail d={q.data} />;
}

function BackLink() {
  return <Link to="/crawls" className="mb-3 inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> Crawl Center</Link>;
}

function Detail({ d }: { d: CrawlDetail }) {
  const { run } = d;
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'urls';
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); if (t === 'urls') p.delete('tab'); else p.set('tab', t); setParams(p, { replace: true }); };
  const simulated = run.source === 'simulated';
  const active = run.status === 'running' || run.status === 'queued';
  // Page-level results: live crawls (Go crawler rows are paged on the server; small runs carry them inline too).
  const detailed = hasPageDetails(d.urls) || !!d.urlsPaged || run.engine === 'go';
  const rowCount = d.urlCount ?? d.urls.length;
  return (
    <div>
      <BackLink />
      <PageHeader
        title={`${run.options ? 'Live crawl' : CRAWL_TYPE_LABELS[run.type]} ${run.id}`}
        description={`${run.options ? `${run.options.startUrl} · ` : ''}${CRAWL_TRIGGER_LABELS[run.trigger]} trigger · started ${fmtDateTime(run.startedAt ?? run.scheduledFor)} IST`}
        meta={<><DemoBadge /><CrawlStatusBadge run={run} />{!active && <OutcomeBadge run={run} />}{run.source !== 'demo' && <SourceBadge source={run.source} />}</>}
        actions={rowCount > 0 && !simulated ? <ExportButtons run={run} /> : undefined}
      />

      <div className="space-y-5">
        {simulated && (
          <Notice tone="demo" title="Simulated run">
            {run.error ?? 'This run is simulated: mock mode makes no HTTP requests.'} The counts below are what a real run would plan — no URLs were fetched and no findings were produced.
          </Notice>
        )}
        {!simulated && run.error && !run.options && <Notice tone={run.status === 'failed' ? 'crit' : 'med'} title={run.status === 'failed' ? 'Run failed' : 'Run notice'}>{run.error}</Notice>}
        {active && !run.options && <Notice tone="signal">This run is {run.status}. The page refreshes every 2 seconds until it finishes.</Notice>}
        {run.options && (
          <Panel title="Progress">
            <CrawlProgress run={run} showLink={false} />
            <div className="mt-4"><TemporaryResultsNote compact /></div>
          </Panel>
        )}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <Panel title="Summary">
            <KV cols={3} items={[
              { k: 'Type', v: run.options ? `Live crawl (${run.options.maxPages === null ? 'all pages' : `max ${fmtNum(run.options.maxPages)} pages`}, ${run.options.maxDepth === null ? 'any depth' : `depth ${run.options.maxDepth}`}, ${run.options.concurrency} parallel, ${run.options.timeoutMs / 1000}s timeout)` : CRAWL_TYPE_LABELS[run.type] },
              { k: 'Trigger', v: CRAWL_TRIGGER_LABELS[run.trigger] },
              { k: 'Status', v: <CrawlStatusBadge run={run} /> },
              { k: 'Started', v: run.startedAt ? `${fmtDateTime(run.startedAt)} IST` : '—' },
              { k: 'Finished', v: run.finishedAt ? `${fmtDateTime(run.finishedAt)} IST` : active ? 'Still running' : '—' },
              { k: 'Duration', v: fmtDuration(run.durationMs) },
              { k: 'URLs planned', v: fmtNum(run.urlsPlanned) },
              { k: 'URLs crawled', v: simulated ? <span className="text-demo">0 fetched (simulated)</span> : fmtNum(run.urlsCrawled) },
              { k: 'URLs failed', v: simulated ? '—' : <span className={run.urlsFailed ? 'font-medium text-crit-ink' : ''}>{fmtNum(run.urlsFailed)}</span> },
              { k: 'JS-rendered sample', v: simulated ? '—' : fmtNum(run.jsRenderedSample) },
              { k: 'New / resolved / recurring issues', v: simulated || active ? '—' : `${run.newIssues} / ${run.resolvedIssues} / ${run.recurringIssues}` },
              { k: 'Data source', v: <SourceBadge source={run.source} /> },
            ]} />
          </Panel>
          <Panel title="Scope" subtitle="How the URL set for this run was assembled (PDF §2.1)" bodyClassName="p-0">
            {run.scope.length ? (
              <ul className="divide-y divide-line">
                {run.scope.map((s) => (
                  <li key={s.label} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1">{s.label}</span>
                    <span className="tabular-nums font-medium">{fmtNum(s.count)}</span>
                  </li>
                ))}
                <li className="flex items-center gap-3 bg-canvas/60 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 text-muted">Total in scope (segments may overlap)</span>
                  <span className="tabular-nums font-semibold">{fmtNum(run.scope.reduce((a, s) => a + s.count, 0))}</span>
                </li>
              </ul>
            ) : <p className="px-4 py-3 text-sm text-muted">No scope breakdown recorded.</p>}
          </Panel>
        </div>

        <RunDiagnostics run={run} />

        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { value: 'urls', label: detailed ? 'Pages' : 'URLs', count: rowCount },
            ...(detailed ? [{ value: 'issues' as Tab, label: 'Issues' }] : []),
            ...(!simulated && run.source !== 'demo' && run.type !== 'reverify' ? [{ value: 'changes' as Tab, label: 'Changes' }] : []),
            ...(run.engine === 'go' ? [{ value: 'coverage' as Tab, label: 'Coverage' }] : []),
            { value: 'sitemap', label: 'Sitemap diff' },
            { value: 'reverify', label: 'Re-verification', count: d.verification.length },
          ]}
        />
        {tab === 'urls' && (detailed ? <PageResults runId={run.id} active={active} />
          : active && !d.urls.length ? <Panel><EmptyState title="Results appear when the crawl finishes" description="Pages are listed once the crawl completes or is cancelled. Progress is shown above." /></Panel>
            : run.options && !d.urls.length ? <Panel><EmptyState title="No pages were fetched" description={run.status === 'cancelled' ? 'The crawl was cancelled before its first page was fetched.' : run.error ?? 'This crawl produced no page results.'} /></Panel>
              : <UrlsTab urls={d.urls} simulated={simulated} />)}
        {tab === 'issues' && <IssuesFound runId={run.id} />}
        {tab === 'changes' && <ChangesTab runId={run.id} active={active} />}
        {tab === 'coverage' && <CoverageReport run={run} />}
        {tab === 'sitemap' && <SitemapTab diff={d.sitemapDiff} />}
        {tab === 'reverify' && <ReverifyTab d={d} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ URLs

const REASON_LABELS: Record<CrawledUrl['reason'], string> = {
  homepage: 'Homepage', collection: 'Collection', top_product: 'Top product', changed_48h: 'Changed (48h)', reverify: 'Re-verify', full: 'Full crawl', sitemap: 'Sitemap',
};
type Show = 'all' | 'changed' | 'failed';
const isFailed = (u: CrawledUrl) => u.status === null || u.status >= 400;

function UrlsTab({ urls, simulated }: { urls: CrawledUrl[]; simulated: boolean }) {
  const [show, setShow] = useState<Show>('all');
  const [reasons, setReasons] = useState<CrawledUrl['reason'][]>([]);
  const counts = useMemo(() => ({ all: urls.length, changed: urls.filter((u) => u.changed).length, failed: urls.filter(isFailed).length }), [urls]);
  const presentReasons = useMemo(() => (Object.keys(REASON_LABELS) as CrawledUrl['reason'][]).filter((r) => urls.some((u) => u.reason === r)), [urls]);
  const rows = urls.filter((u) => (show === 'all' || (show === 'changed' ? u.changed : isFailed(u))) && (!reasons.length || reasons.includes(u.reason)));

  if (!urls.length) {
    return (
      <Panel>
        <EmptyState
          title="No URL-level results recorded for this run"
          description={simulated ? 'Simulated runs fetch nothing, so there are no URL results.' : 'The DEMO data keeps per-URL results for the most recent completed smart crawl only. Open that run from the Crawl Center history.'}
        />
      </Panel>
    );
  }
  return (
    <Panel title="Crawled URLs" subtitle="Failed = no response or HTTP status ≥ 400" bodyClassName="p-3">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
          {(['all', 'changed', 'failed'] as Show[]).map((s) => (
            <button key={s} type="button" aria-pressed={show === s} onClick={() => setShow(s)} className={`h-7 rounded-full border px-2.5 text-xs ${show === s ? 'border-signal/50 bg-signal-tint text-signal-dark font-medium' : 'border-line-strong bg-surface text-ink-soft hover:border-muted/50'}`}>
              {s === 'all' ? 'All' : s === 'changed' ? 'Changed' : 'Failed'} <span className="tabular-nums opacity-70">{counts[s]}</span>
            </button>
          ))}
        </div>
        <ChipGroup label="Reason" options={presentReasons.map((r) => ({ value: r, label: REASON_LABELS[r] }))} value={reasons} onChange={setReasons} />
      </div>
      <DataTable
        rows={rows}
        rowKey={(u) => u.url}
        dense
        search={(u) => u.url}
        searchPlaceholder="Search URLs"
        caption="Crawled URLs"
        empty={<EmptyState title="No URLs match these filters" description="Choose All or clear the reason filter." />}
        columns={[
          { key: 'url', header: 'URL', cell: (u) => <a href={u.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-[360px] items-center gap-1 font-mono text-xs text-ink-soft hover:text-signal"><span className="truncate">{shortUrl(u.url)}</span><ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>, sort: (a, b) => a.url.localeCompare(b.url) },
          { key: 'status', header: 'Status', cell: (u) => <HttpStatusBadge status={u.status} error={u.error} />, sort: (a, b) => (a.status ?? 999) - (b.status ?? 999) },
          { key: 'reason', header: 'Why crawled', cell: (u) => <span className="text-xs">{REASON_LABELS[u.reason]}</span> },
          { key: 'ms', header: 'Response', className: 'tabular-nums', cell: (u) => <span className={`text-xs ${u.responseMs && u.responseMs > 2000 ? 'font-medium text-med-ink' : ''}`}>{u.responseMs !== undefined ? fmtMs(u.responseMs) : '—'}</span>, sort: (a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0) },
          { key: 'changed', header: 'Changed', hideOnMobile: true, cell: (u) => (u.changed ? <Badge tone="signal">Changed</Badge> : <span className="text-xs text-faint">—</span>) },
          { key: 'err', header: 'Error', hideOnMobile: true, cell: (u) => <span className="text-xs text-crit-ink">{u.error ?? ''}</span> },
        ]}
      />
    </Panel>
  );
}

// ------------------------------------------------------------------ Sitemap diff

function SitemapTab({ diff }: { diff?: SitemapDiff }) {
  if (!diff) return <Panel><EmptyState title="No sitemap diff recorded for this run" description="Sitemap diffs are stored for completed smart and full crawls. In DEMO data only the latest completed smart crawl has one." /></Panel>;
  const empty = (t: string) => <p className="text-sm text-muted">{t}</p>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">Sitemap compared with the previous run · <SourceBadge source={diff.source} /></div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DiffPanel title="Added to sitemap" count={diff.added.length}>{diff.added.length ? <UrlList urls={diff.added} max={8} title={`${diff.added.length} new URLs`} /> : empty('No URLs added.')}</DiffPanel>
        <DiffPanel title="Removed from sitemap" count={diff.removed.length}>{diff.removed.length ? <UrlList urls={diff.removed} max={8} title={`${diff.removed.length} removed URLs — check they redirect`} /> : empty('No URLs removed.')}</DiffPanel>
      </div>
      <Panel title="Lastmod changed" subtitle="Feeds the 'changed in last 48h' segment of the next smart crawl" bodyClassName="p-3">
        <DataTable
          rows={diff.lastmodChanged}
          rowKey={(r) => r.url}
          dense
          pageSize={10}
          caption="Lastmod changes"
          empty={<p className="p-4 text-sm text-muted">No lastmod changes.</p>}
          columns={[
            { key: 'url', header: 'URL', cell: (r) => <Mono className="text-xs">{shortUrl(r.url)}</Mono> },
            { key: 'from', header: 'From', cell: (r) => <span className="tabular-nums text-xs text-muted">{r.from ?? '—'}</span> },
            { key: 'to', header: 'To', cell: (r) => <span className="tabular-nums text-xs">{r.to ?? '—'}</span> },
          ]}
        />
      </Panel>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <DiffPanel title="In sitemap, not crawled" subtitle="Orphan candidates — no internal links reached them" count={diff.inSitemapNotCrawled.length}>{diff.inSitemapNotCrawled.length ? <UrlList urls={diff.inSitemapNotCrawled} max={8} /> : empty('None — every sitemap URL was reached by crawling.')}</DiffPanel>
        <DiffPanel title="Crawled, not in sitemap" subtitle="Often filter / sort parameters or tag pages" count={diff.crawledNotInSitemap.length}>{diff.crawledNotInSitemap.length ? <UrlList urls={diff.crawledNotInSitemap} max={8} /> : empty('None.')}</DiffPanel>
      </div>
      <Panel title="Invalid sitemap entries" subtitle="Sitemaps should list only 200, indexable, canonical URLs (PDF §4.1)" bodyClassName="p-3">
        <DataTable
          rows={diff.invalidEntries}
          rowKey={(r) => r.url}
          dense
          pageSize={10}
          caption="Invalid sitemap entries"
          empty={<p className="p-4 text-sm text-muted">No invalid entries.</p>}
          columns={[
            { key: 'url', header: 'URL', cell: (r) => <Mono className="text-xs">{shortUrl(r.url)}</Mono> },
            { key: 'p', header: 'Problem', cell: (r) => <Badge tone="crit">{r.problem}</Badge> },
          ]}
        />
      </Panel>
    </div>
  );
}

function DiffPanel({ title, subtitle, count, children }: { title: string; subtitle?: string; count: number; children: ReactNode }) {
  return <Panel title={<span className="flex items-center gap-2">{title}<span className="rounded-full bg-raised px-1.5 text-xs font-normal tabular-nums text-muted">{count}</span></span>} subtitle={subtitle}>{children}</Panel>;
}

// ------------------------------------------------------------------ Re-verification

function ReverifyTab({ d }: { d: CrawlDetail }) {
  return (
    <Panel title="Re-verification attempts" subtitle="Automated re-crawl checks of fixed issues made during this run. An issue closes only when failing URLs = 0." bodyClassName="p-3">
      <DataTable
        rows={d.verification}
        rowKey={(v) => v.id}
        dense
        caption="Re-verification attempts"
        empty={<EmptyState title="No re-verification attempts in this run" description="Re-verification runs on the URLs of issues marked Fixed. See all results on the Verification page." action={<Link to="/verification" className="text-sm text-signal hover:underline">Verification results</Link>} />}
        columns={[
          { key: 'at', header: 'When', cell: (v) => <span className="whitespace-nowrap text-xs">{fmtDateTime(v.at)}</span> },
          { key: 'issue', header: 'Issue', cell: (v) => (v.issueId && v.issueId !== '-' ? <Link to={`/issues/${v.issueId}`} className="font-mono text-xs text-signal hover:underline">{v.issueId}</Link> : <span className="text-xs text-muted">—</span>) },
          { key: 'method', header: 'Method', hideOnMobile: true, cell: (v) => <span className="text-xs">{VERIFICATION_METHOD_LABELS[v.method]}</span> },
          { key: 'outcome', header: 'Outcome', cell: (v) => <VerificationOutcomeBadge outcome={v.outcome} /> },
          { key: 'urls', header: 'Checked / failing', cell: (v) => <span className="tabular-nums text-xs">{fmtNum(v.checkedUrls)} / <span className={v.failingUrls ? 'font-medium text-crit-ink' : ''}>{fmtNum(v.failingUrls)}</span></span> },
          { key: 'details', header: 'Details', cell: (v) => <span className="text-xs">{v.details}</span> },
          { key: 'src', header: 'Source', cell: (v) => <span className="whitespace-nowrap"><SourceBadge source={v.source} /></span> },
        ]}
      />
    </Panel>
  );
}

