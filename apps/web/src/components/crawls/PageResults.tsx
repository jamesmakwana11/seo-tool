import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ExternalLink, Search } from 'lucide-react';
import {
  CRAWL_PROBLEM_LABELS, CRAWL_STATE_LABELS, CRAWL_STATUS_LABELS, crawlRowStatus,
  type CrawledUrl, type CrawledUrlIssue, type CrawlPageProblem, type CrawlPagesQuery, type Severity,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiQuery } from '@/api/hooks';
import { Badge, EmptyState, Input, LoadingBlock, Mono, Notice, Panel } from '@/components/ui/primitives';
import { Drawer } from '@/components/ui/overlay';
import { useAuth } from '@/auth/AuthContext';
import { DataTable } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect } from '@/components/ui/filters';
import { SeverityBadge } from '@/components/domain/badges';
import { HttpStatusBadge } from './crawlBadges';
import { fmtMs, fmtNum, shortUrl } from '@/lib/format';

/** True when the run stored page-level details (live crawls). */
export const hasPageDetails = (urls: CrawledUrl[]) => urls.some((u) => u.indexabilityReason !== undefined);

const effStatus = (u: CrawledUrl) => crawlRowStatus(u);
const SEV_RANK: Record<Severity, number> = { critical: 0, medium: 1, low: 2 };
const topSeverity = (u: CrawledUrl): Severity | undefined => u.topSeverity ?? u.issues?.slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0]?.severity;
const SOURCE_LABELS: Record<string, string> = { start: 'Start URL', link: 'Internal link', sitemap: 'Sitemap', pagination: 'Pagination', redirect: 'Redirect target', seed: 'Smart-crawl evidence' };
const SORT_KEYS: Record<string, CrawlPagesQuery['sort']> = { page: 'url', status: 'status', depth: 'depth', index: 'indexable', issues: 'issues', links: 'links', inlinks: 'inlinks', ms: 'response' };
const PAGE_SIZE = 50;

/** Debounced value (search box → server query). */
function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * Every URL of one crawl — fetched pages and URLs found but not fetched — searched, filtered, sorted and paged on the
 * server, so a 50,000-page crawl loads one page of rows at a time.
 */
export function PageResults({ runId, active }: { runId: string; active?: boolean }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [status, setStatus] = useState('');
  const [index, setIndex] = useState('');
  const [problem, setProblem] = useState('');
  const [state, setState] = useState('');
  const [source, setSource] = useState('');
  const [template, setTemplate] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | undefined>();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<CrawledUrl | null>(null);
  useEffect(() => setPage(1), [q, status, index, problem, state, source, template, sort]);
  const query: CrawlPagesQuery = {
    offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, q: q || undefined, status: (status || undefined) as CrawlPagesQuery['status'], indexable: (index || undefined) as CrawlPagesQuery['indexable'],
    problem: (problem || undefined) as CrawlPagesQuery['problem'], crawlState: (state || undefined) as CrawlPagesQuery['crawlState'], source: source || undefined, template: template || undefined,
    sort: sort ? SORT_KEYS[sort.key] : undefined, dir: sort?.dir,
  };
  const res = useApiQuery(['crawlPages', runId, JSON.stringify(query)], () => api.getCrawlPages(runId, query), { refetchInterval: active ? 5000 : undefined });
  const f = res.data?.facets;
  const opts = (rec: Record<string, number> | undefined, labels: Record<string, string>) => Object.entries(rec ?? {}).filter(([, n]) => n > 0).map(([k, n]) => ({ value: k, label: `${labels[k] ?? k} (${fmtNum(n)})` }));
  const filtered = !!(q || status || index || problem || state || source || template);

  return (
    <Panel title="Pages" subtitle="Every URL this crawl found: fetched pages and URLs it did not fetch (with the reason). Select a row for its details and issues." bodyClassName="p-3">
      {res.error && <Notice tone="crit">{errorMessage(res.error)}</Notice>}
      <DataTable
        rows={res.data?.rows ?? []}
        rowKey={(u) => u.url}
        dense
        onRowClick={setOpen}
        caption="Crawled pages"
        server={{ page, pageSize: PAGE_SIZE, total: res.data?.total ?? 0, onPage: setPage, sort, onSort: setSort }}
        toolbar={
          <>
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
              <Input aria-label="Search URL or title" placeholder="Search URL or title" value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
            </div>
            <FilterSelect label="Status" value={status} onChange={setStatus} options={opts(f?.status, CRAWL_STATUS_LABELS)} />
            <FilterSelect label="Crawl state" value={state} onChange={setState} options={opts(f?.crawlState, CRAWL_STATE_LABELS)} />
            <FilterSelect label="Indexable" value={index} onChange={setIndex} options={opts(f?.indexable, { yes: 'Indexable', no: 'Not indexable' })} />
            <FilterSelect label="Problem" value={problem} onChange={setProblem} options={(Object.keys(CRAWL_PROBLEM_LABELS) as CrawlPageProblem[]).map((k) => ({ value: k, label: `${CRAWL_PROBLEM_LABELS[k]} (${fmtNum(f?.problem[k] ?? 0)})` }))} />
            {!!Object.keys(f?.source ?? {}).length && <FilterSelect label="Found via" value={source} onChange={setSource} options={opts(f?.source, SOURCE_LABELS)} />}
            {!!Object.keys(f?.template ?? {}).length && <FilterSelect label="Template" value={template} onChange={setTemplate} options={opts(f?.template, {})} />}
            <ClearFilters show={filtered} onClear={() => { setText(''); setStatus(''); setIndex(''); setProblem(''); setState(''); setSource(''); setTemplate(''); }} />
            {res.isFetching && <span className="text-xs text-muted">Loading…</span>}
          </>
        }
        empty={res.isLoading ? <LoadingBlock rows={6} /> : <EmptyState title={filtered ? 'No pages match these filters' : active ? 'Pages appear when the crawl finishes' : 'No pages recorded'} description={filtered ? 'Clear the filters or search.' : undefined} />}
        columns={[
          {
            key: 'page', header: 'Page', cell: (u) => (
              <div className="min-w-0 max-w-[420px]">
                <p className="truncate text-sm font-medium text-ink" title={u.title}>{u.title?.trim() || <span className="font-normal italic text-faint">{u.crawlState && u.crawlState !== 'fetched' ? CRAWL_STATE_LABELS[u.crawlState] : html(u) ? 'No title' : '—'}</span>}</p>
                <p className="truncate font-mono text-xs text-muted" title={u.url}>{shortUrl(u.url)}</p>
              </div>
            ),
            sort: () => 0,
          },
          { key: 'status', header: 'Status', cell: (u) => statusCell(u), sort: () => 0 },
          { key: 'depth', header: 'Depth', hideOnMobile: true, className: 'tabular-nums', cell: (u) => <span className="text-xs">{u.depth ?? (u.reason === 'sitemap' ? 'sitemap' : '—')}</span>, sort: () => 0 },
          { key: 'index', header: 'Indexable', cell: (u) => (u.indexable === undefined || (u.crawlState && u.crawlState !== 'fetched') ? <span className="text-xs text-faint">—</span> : u.indexable ? <Badge tone="ok">Yes</Badge> : <Badge tone="med" title={u.indexabilityReason}>No</Badge>), sort: () => 0 },
          {
            key: 'issues', header: 'Issues', cell: (u) => (u.issues?.length ? <span className="inline-flex items-center gap-1.5"><SeverityBadge severity={topSeverity(u)!} /><span className="text-xs tabular-nums">{u.issues.length}</span></span> : <span className="text-xs text-faint">0</span>),
            sort: () => 0,
          },
          { key: 'inlinks', header: 'Inlinks', hideOnMobile: true, className: 'tabular-nums', cell: (u) => <span className="text-xs">{u.inlinks ?? '—'}</span>, sort: () => 0 },
          { key: 'links', header: 'Links / broken', hideOnMobile: true, cell: (u) => <span className="whitespace-nowrap text-xs tabular-nums">{u.internalLinks ?? '—'} / <span className={u.brokenLinks?.length ? 'font-medium text-crit-ink' : ''}>{u.brokenLinks?.length ?? 0}</span></span>, sort: () => 0 },
          { key: 'ms', header: 'Response', hideOnMobile: true, className: 'tabular-nums', cell: (u) => <span className={`text-xs ${u.responseMs && u.responseMs > 2000 ? 'font-medium text-med-ink' : ''}`}>{u.responseMs !== undefined ? fmtMs(u.responseMs) : '—'}</span>, sort: () => 0 },
        ]}
      />
      <PageDrawer page={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}

const html = (u: CrawledUrl) => u.title !== undefined || u.h1 !== undefined;

function statusCell(u: CrawledUrl) {
  if (u.skippedByRobots || u.crawlState === 'robots') return <Badge tone="neutral">robots.txt</Badge>;
  if (u.crawlState && u.crawlState !== 'fetched') return <Badge tone="neutral" title={u.exclusionReason ?? u.indexabilityReason}>{CRAWL_STATE_LABELS[u.crawlState]}</Badge>;
  return <HttpStatusBadge status={effStatus(u) ?? null} error={u.error} />;
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 border-b border-line py-2 text-sm last:border-0">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const len = (s?: string) => (s ? <span className="ml-1 text-xs tabular-nums text-faint">({s.length} chars)</span> : null);

function PageDrawer({ page: u, onClose }: { page: CrawledUrl | null; onClose: () => void }) {
  const canEdit = useAuth().can('shopify.edit');
  const dupTitle = !!u?.flags?.includes('dup-title');
  const dupMeta = !!u?.flags?.includes('dup-meta');
  return (
    <Drawer open={!!u} onClose={onClose} title={u ? <span className="block truncate" title={u.url}>{u.title?.trim() || shortUrl(u.url)}</span> : ''} width="lg">
      {u && (
        <div className="space-y-5">
          <a href={u.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-signal hover:underline">{u.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>
          {canEdit && /\/(products|collections|pages|blogs)\//.test(u.url) && (
            <Link to={`/seo-editor?url=${encodeURIComponent(u.url)}`} className="ml-3 inline-flex items-center gap-1 text-xs font-medium text-signal hover:underline">Fix in SEO editor</Link>
          )}
          <section>
            <h3 className="mb-1 text-sm font-semibold">Response</h3>
            <dl>
              <Row k="HTTP status">{u.skippedByRobots ? 'Not requested (disallowed by robots.txt)' : <span className="inline-flex flex-wrap items-center gap-2"><HttpStatusBadge status={u.status} error={u.error} />{u.redirects ? <span className="text-xs">→ {u.finalStatus ?? 'no response'} after {u.redirects} redirect{u.redirects > 1 ? 's' : ''}</span> : null}</span>}</Row>
              {u.finalUrl && <Row k="Final URL"><Mono className="text-xs">{u.finalUrl}</Mono></Row>}
              {u.redirectedFrom && <Row k="Reached via redirect from"><Mono className="text-xs">{u.redirectedFrom}</Mono></Row>}
              {u.error && <Row k="Error"><span className="text-crit-ink">{u.error}</span></Row>}
              <Row k="Content type">{u.contentType ?? '—'}</Row>
              <Row k="Response time">{u.responseMs !== undefined ? fmtMs(u.responseMs) : '—'}{u.bytes !== undefined && <span className="ml-2 text-xs text-muted">{fmtNum(Math.round(u.bytes / 1024))} KB</span>}</Row>
              {u.crawlState && <Row k="Crawl state">{CRAWL_STATE_LABELS[u.crawlState]}{u.exclusionReason && <span className="ml-1 text-xs text-muted">({u.exclusionReason.replace(/_/g, ' ')})</span>}</Row>}
              <Row k="Found via">{u.foundVia?.length ? u.foundVia.map((v) => SOURCE_LABELS[v] ?? v).join(', ') : u.reason === 'sitemap' ? 'Sitemap' : u.reason}{u.depth !== undefined && <span className="ml-1 text-xs text-muted">· link depth {u.depth}</span>}</Row>
              {u.foundOn && <Row k="First found on"><Mono className="text-xs">{u.foundOn}</Mono></Row>}
              {u.inlinks !== undefined && <Row k="Internal inlinks">{fmtNum(u.inlinks)}</Row>}
              {u.template && <Row k="Template">{u.template}</Row>}
              {u.inSitemap !== undefined && <Row k="In sitemap">{u.inSitemap ? 'Yes' : 'No'}</Row>}
            </dl>
          </section>
          {(u.title !== undefined || u.h1 !== undefined) && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">SEO elements</h3>
              <dl>
                <Row k="Title">{u.title?.trim() ? <>{u.title}{len(u.title)}{dupTitle && <Badge tone="med" className="ml-2">Duplicate in this crawl</Badge>}</> : <span className="text-crit-ink">Missing</span>}</Row>
                <Row k="Meta description">{u.metaDescription?.trim() ? <>{u.metaDescription}{len(u.metaDescription)}{dupMeta && <Badge tone="med" className="ml-2">Duplicate in this crawl</Badge>}</> : <span className="text-crit-ink">Missing</span>}</Row>
                <Row k={`H1 (${u.h1?.length ?? 0})`}>{u.h1?.length ? <ul className="list-disc pl-4">{u.h1.map((h, i) => <li key={i}>{h || <em className="text-faint">empty</em>}</li>)}</ul> : <span className="text-crit-ink">Missing</span>}</Row>
                <Row k="H2 headings">{u.h2Count ?? 0}</Row>
                {u.headings?.length ? <Row k="Heading outline"><ul className="space-y-0.5 text-xs">{u.headings.map((h, i) => <li key={i} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}><span className="mr-1 font-mono text-faint">H{h.level}</span>{h.text || <em className="text-faint">empty</em>}</li>)}</ul></Row> : null}
                {u.wordCount !== undefined && <Row k="Words">{fmtNum(u.wordCount)} on the page{u.uniqueWords !== undefined && <span className="ml-1 text-xs text-muted">· {fmtNum(u.uniqueWords)} unique (template text removed)</span>}</Row>}
                <Row k="Canonical">{u.canonical ? <Mono className="text-xs">{u.canonical}</Mono> : <span className="text-muted">None</span>}</Row>
                <Row k="Meta robots">{u.metaRobots ?? <span className="text-muted">None</span>}</Row>
                {u.xRobotsTag && <Row k="X-Robots-Tag">{u.xRobotsTag}</Row>}
              </dl>
            </section>
          )}
          <section>
            <h3 className="mb-1 text-sm font-semibold">Indexability</h3>
            <p className="text-sm">{u.indexable ? <Badge tone="ok">Indexable</Badge> : <Badge tone="med">Not indexable</Badge>} <span className="ml-1 text-ink-soft">{u.indexabilityReason}</span></p>
          </section>
          {u.internalLinks !== undefined && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Links and images</h3>
              <dl>
                <Row k="Internal links">{fmtNum(u.internalLinks)}</Row>
                <Row k="Broken internal links">{u.brokenLinks?.length ? <ul className="space-y-0.5">{u.brokenLinks.map((l) => <li key={l}><Mono className="text-xs text-crit-ink">{l}</Mono></li>)}</ul> : '0'}</Row>
                <Row k="Images">{fmtNum(u.images ?? 0)}{(u.imagesMissingAlt ?? 0) > 0 && <span className="ml-2 font-medium text-med-ink">{u.imagesMissingAlt} without alt text</span>}</Row>
              </dl>
            </section>
          )}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Issues on this page ({u.issues?.length ?? 0})</h3>
            {u.issues?.length ? (
              <ul className="space-y-2">
                {u.issues.map((i) => <IssueItem key={i.id} i={i} />)}
              </ul>
            ) : <p className="text-sm text-muted">No tracked issues reference this URL in this crawl.</p>}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function IssueItem({ i }: { i: CrawledUrlIssue }) {
  return (
    <li className="rounded-ctl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={i.severity} />
        <span className="font-mono text-xs text-muted">{i.checkId}</span>
      </div>
      <p className="mt-1 text-sm font-medium">{i.title}</p>
      {i.summary && <p className="mt-0.5 text-xs text-ink-soft">{i.summary}</p>}
      <Link to={`/issues/${i.id}`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-signal hover:underline">Open {i.id} and its Fix Card <ArrowUpRight className="h-3.5 w-3.5" /></Link>
    </li>
  );
}

/** Issues this crawl created, updated or re-opened (the issue tracker records, each with its Fix Card). */
export function IssuesFound({ runId }: { runId: string }) {
  const res = useApiQuery(['issues', 'byCrawl', runId], () => api.listIssues({ crawlRunId: runId, pageSize: 500, includeSuperseded: true, sort: 'severity' }));
  const list = res.data?.items ?? [];
  return (
    <Panel title="Issues found" subtitle="Tracked issues this crawl detected. Each opens its Fix Card with the evidence, why it matters and the recommended fix." bodyClassName="p-3">
      {res.error && <Notice tone="crit">{errorMessage(res.error)}</Notice>}
      <DataTable
        rows={list}
        rowKey={(i) => i.id}
        dense
        search={(i) => `${i.id} ${i.checkId} ${i.title}`}
        searchPlaceholder="Search issues"
        caption="Issues found in this crawl"
        empty={res.isLoading ? <LoadingBlock rows={4} /> : <EmptyState title="No issues recorded for this crawl" description="Either the crawled pages passed every check, or the crawl was cancelled or failed (partial crawls never create issues)." />}
        columns={[
          { key: 'sev', header: 'Severity', cell: (i) => <SeverityBadge severity={i.severity} />, sort: (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] },
          { key: 'title', header: 'Issue', cell: (i) => <div className="min-w-0 max-w-[480px]"><Link to={`/issues/${i.id}`} className="text-sm font-medium text-ink hover:text-signal">{i.title}</Link><p className="truncate text-xs text-muted">{i.summary.split('\n')[0]}</p></div> },
          { key: 'check', header: 'Check', hideOnMobile: true, cell: (i) => <Mono className="text-xs">{i.checkId}</Mono> },
          { key: 'pages', header: 'Pages', className: 'tabular-nums', cell: (i) => <span className="text-xs">{fmtNum(i.affectedCount)}</span>, sort: (a, b) => a.affectedCount - b.affectedCount },
          { key: 'delta', header: 'Change', hideOnMobile: true, cell: (i) => <span className="text-xs">{i.delta}</span> },
          { key: 'open', header: '', cell: (i) => <Link to={`/issues/${i.id}`} className="whitespace-nowrap text-xs font-medium text-signal hover:underline">Fix Card</Link> },
        ]}
      />
    </Panel>
  );
}
