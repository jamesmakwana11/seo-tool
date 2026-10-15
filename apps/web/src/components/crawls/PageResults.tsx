import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ExternalLink } from 'lucide-react';
import type { CrawledUrl, CrawledUrlIssue, Severity } from '@sentinel/shared';
import { Badge, EmptyState, Mono, Panel } from '@/components/ui/primitives';
import { Drawer } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect } from '@/components/ui/filters';
import { SeverityBadge } from '@/components/domain/badges';
import { HttpStatusBadge } from './crawlBadges';
import { fmtMs, fmtNum, shortUrl } from '@/lib/format';

/** True when the run stored page-level details (live crawls). */
export const hasPageDetails = (urls: CrawledUrl[]) => urls.some((u) => u.indexabilityReason !== undefined);

const effStatus = (u: CrawledUrl) => (u.redirects ? u.status : u.finalStatus ?? u.status);
type StatusGroup = '2xx' | '3xx' | '4xx' | '5xx' | 'none' | 'robots';
function statusGroup(u: CrawledUrl): StatusGroup {
  if (u.skippedByRobots) return 'robots';
  const s = effStatus(u);
  if (s === null || s === undefined) return 'none';
  return s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : '2xx';
}
const STATUS_LABELS: Record<StatusGroup, string> = { '2xx': '2xx OK', '3xx': '3xx Redirect', '4xx': '4xx Client error', '5xx': '5xx Server error', none: 'No response', robots: 'Blocked by robots.txt' };

type Problem = 'issues' | 'broken' | 'no-title' | 'dup-title' | 'no-meta' | 'dup-meta' | 'h1' | 'alt' | 'noindex';
const PROBLEM_LABELS: Record<Problem, string> = {
  issues: 'Has tracked issues', broken: 'Broken internal links', 'no-title': 'Missing title', 'dup-title': 'Duplicate title', 'no-meta': 'Missing meta description',
  'dup-meta': 'Duplicate meta description', h1: 'Missing or multiple H1', alt: 'Images without alt text', noindex: 'Not indexable',
};

const SEV_RANK: Record<Severity, number> = { critical: 0, medium: 1, low: 2 };
const topSeverity = (u: CrawledUrl): Severity | undefined => u.issues?.slice().sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0]?.severity;

/** Duplicate titles / meta descriptions across the HTML 200 pages of this crawl. */
function duplicates(urls: CrawledUrl[], pick: (u: CrawledUrl) => string | undefined) {
  const by = new Map<string, number>();
  for (const u of urls) {
    const v = pick(u)?.trim().toLowerCase();
    if (v && effStatus(u) === 200) by.set(v, (by.get(v) ?? 0) + 1);
  }
  return (u: CrawledUrl) => {
    const v = pick(u)?.trim().toLowerCase();
    return !!v && effStatus(u) === 200 && (by.get(v) ?? 0) > 1;
  };
}

export function PageResults({ urls }: { urls: CrawledUrl[] }) {
  const [status, setStatus] = useState('');
  const [index, setIndex] = useState('');
  const [problem, setProblem] = useState('');
  const [open, setOpen] = useState<CrawledUrl | null>(null);
  const dupTitle = useMemo(() => duplicates(urls, (u) => u.title), [urls]);
  const dupMeta = useMemo(() => duplicates(urls, (u) => u.metaDescription), [urls]);
  const html = (u: CrawledUrl) => u.title !== undefined || u.h1 !== undefined;
  const matches = (u: CrawledUrl, p: Problem) => {
    switch (p) {
      case 'issues': return !!u.issues?.length;
      case 'broken': return !!u.brokenLinks?.length;
      case 'no-title': return html(u) && !u.title?.trim();
      case 'dup-title': return dupTitle(u);
      case 'no-meta': return html(u) && !u.metaDescription?.trim();
      case 'dup-meta': return dupMeta(u);
      case 'h1': return html(u) && (u.h1?.length ?? 0) !== 1;
      case 'alt': return (u.imagesMissingAlt ?? 0) > 0;
      case 'noindex': return u.indexable === false;
    }
  };
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const u of urls) c[statusGroup(u)] = (c[statusGroup(u)] ?? 0) + 1;
    for (const p of Object.keys(PROBLEM_LABELS) as Problem[]) c[p] = urls.filter((u) => matches(u, p)).length;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls, dupTitle, dupMeta]);
  const rows = urls.filter((u) => (!status || statusGroup(u) === status) && (!index || (index === 'yes' ? u.indexable : u.indexable === false)) && (!problem || matches(u, problem as Problem)));
  const active = !!(status || index || problem);

  return (
    <Panel title="Pages" subtitle="Every URL this crawl requested. Select a row for its full details and issues." bodyClassName="p-3">
      <DataTable
        rows={rows}
        rowKey={(u) => u.url}
        dense
        onRowClick={setOpen}
        search={(u) => `${u.url} ${u.title ?? ''}`}
        searchPlaceholder="Search URL or title"
        caption="Crawled pages"
        toolbar={
          <>
            <FilterSelect label="Status" value={status} onChange={setStatus} options={(Object.keys(STATUS_LABELS) as StatusGroup[]).filter((k) => counts[k]).map((k) => ({ value: k, label: `${STATUS_LABELS[k]} (${counts[k]})` }))} />
            <FilterSelect label="Indexable" value={index} onChange={setIndex} options={[{ value: 'yes', label: 'Indexable' }, { value: 'no', label: 'Not indexable' }]} />
            <FilterSelect label="Problem" value={problem} onChange={setProblem} options={(Object.keys(PROBLEM_LABELS) as Problem[]).map((k) => ({ value: k, label: `${PROBLEM_LABELS[k]} (${counts[k] ?? 0})` }))} />
            <ClearFilters show={active} onClear={() => { setStatus(''); setIndex(''); setProblem(''); }} />
          </>
        }
        empty={<EmptyState title="No pages match these filters" description="Clear the filters or search." />}
        columns={[
          {
            key: 'page', header: 'Page', cell: (u) => (
              <div className="min-w-0 max-w-[420px]">
                <p className="truncate text-sm font-medium text-ink" title={u.title}>{u.title?.trim() || <span className="font-normal italic text-faint">{html(u) ? 'No title' : '—'}</span>}</p>
                <p className="truncate font-mono text-xs text-muted" title={u.url}>{shortUrl(u.url)}</p>
              </div>
            ),
            sort: (a, b) => a.url.localeCompare(b.url),
          },
          { key: 'status', header: 'Status', cell: (u) => (u.skippedByRobots ? <Badge tone="neutral">robots.txt</Badge> : <HttpStatusBadge status={effStatus(u) ?? null} error={u.error} />), sort: (a, b) => (effStatus(a) ?? 999) - (effStatus(b) ?? 999) },
          { key: 'depth', header: 'Depth', hideOnMobile: true, className: 'tabular-nums', cell: (u) => <span className="text-xs">{u.depth ?? (u.reason === 'sitemap' ? 'sitemap' : '—')}</span>, sort: (a, b) => (a.depth ?? 99) - (b.depth ?? 99) },
          { key: 'index', header: 'Indexable', cell: (u) => (u.indexable === undefined ? <span className="text-xs text-faint">—</span> : u.indexable ? <Badge tone="ok">Yes</Badge> : <Badge tone="med" title={u.indexabilityReason}>No</Badge>), sort: (a, b) => Number(!!a.indexable) - Number(!!b.indexable) },
          {
            key: 'issues', header: 'Issues', cell: (u) => (u.issues?.length ? <span className="inline-flex items-center gap-1.5"><SeverityBadge severity={topSeverity(u)!} /><span className="text-xs tabular-nums">{u.issues.length}</span></span> : <span className="text-xs text-faint">0</span>),
            sort: (a, b) => (a.issues?.length ?? 0) - (b.issues?.length ?? 0),
          },
          { key: 'links', header: 'Links / broken', hideOnMobile: true, cell: (u) => <span className="whitespace-nowrap text-xs tabular-nums">{u.internalLinks ?? '—'} / <span className={u.brokenLinks?.length ? 'font-medium text-crit-ink' : ''}>{u.brokenLinks?.length ?? 0}</span></span>, sort: (a, b) => (a.brokenLinks?.length ?? 0) - (b.brokenLinks?.length ?? 0) },
          { key: 'ms', header: 'Response', hideOnMobile: true, className: 'tabular-nums', cell: (u) => <span className={`text-xs ${u.responseMs && u.responseMs > 2000 ? 'font-medium text-med-ink' : ''}`}>{u.responseMs !== undefined ? fmtMs(u.responseMs) : '—'}</span>, sort: (a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0) },
        ]}
      />
      <PageDrawer page={open} onClose={() => setOpen(null)} dupTitle={open ? dupTitle(open) : false} dupMeta={open ? dupMeta(open) : false} />
    </Panel>
  );
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

function PageDrawer({ page: u, onClose, dupTitle, dupMeta }: { page: CrawledUrl | null; onClose: () => void; dupTitle: boolean; dupMeta: boolean }) {
  return (
    <Drawer open={!!u} onClose={onClose} title={u ? <span className="block truncate" title={u.url}>{u.title?.trim() || shortUrl(u.url)}</span> : ''} width="lg">
      {u && (
        <div className="space-y-5">
          <a href={u.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-signal hover:underline">{u.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>
          <section>
            <h3 className="mb-1 text-sm font-semibold">Response</h3>
            <dl>
              <Row k="HTTP status">{u.skippedByRobots ? 'Not requested (disallowed by robots.txt)' : <span className="inline-flex flex-wrap items-center gap-2"><HttpStatusBadge status={u.status} error={u.error} />{u.redirects ? <span className="text-xs">→ {u.finalStatus ?? 'no response'} after {u.redirects} redirect{u.redirects > 1 ? 's' : ''}</span> : null}</span>}</Row>
              {u.finalUrl && <Row k="Final URL"><Mono className="text-xs">{u.finalUrl}</Mono></Row>}
              {u.redirectedFrom && <Row k="Reached via redirect from"><Mono className="text-xs">{u.redirectedFrom}</Mono></Row>}
              {u.error && <Row k="Error"><span className="text-crit-ink">{u.error}</span></Row>}
              <Row k="Content type">{u.contentType ?? '—'}</Row>
              <Row k="Response time">{u.responseMs !== undefined ? fmtMs(u.responseMs) : '—'}{u.bytes !== undefined && <span className="ml-2 text-xs text-muted">{fmtNum(Math.round(u.bytes / 1024))} KB</span>}</Row>
              <Row k="Found via">{u.reason === 'sitemap' ? 'Sitemap' : u.depth !== undefined ? `Links, depth ${u.depth}` : u.reason}</Row>
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

/** Issues found in this crawl, with how many crawled pages each affects. */
export function IssuesFound({ urls }: { urls: CrawledUrl[] }) {
  const list = useMemo(() => {
    const by = new Map<string, { issue: CrawledUrlIssue; pages: number }>();
    for (const u of urls) for (const i of u.issues ?? []) {
      const cur = by.get(i.id) ?? { issue: i, pages: 0 };
      cur.pages++;
      by.set(i.id, cur);
    }
    return [...by.values()].sort((a, b) => SEV_RANK[a.issue.severity] - SEV_RANK[b.issue.severity] || b.pages - a.pages);
  }, [urls]);
  return (
    <Panel title="Issues found" subtitle="Tracked issues seen in this crawl. Each opens its Fix Card with the explanation and suggested fix." bodyClassName="p-3">
      <DataTable
        rows={list}
        rowKey={(r) => r.issue.id}
        dense
        search={(r) => `${r.issue.id} ${r.issue.checkId} ${r.issue.title}`}
        searchPlaceholder="Search issues"
        caption="Issues found in this crawl"
        empty={<EmptyState title="No issues recorded for this crawl" description="Either the crawled pages passed every check, or the crawl was cancelled (partial crawls never create issues)." />}
        columns={[
          { key: 'sev', header: 'Severity', cell: (r) => <SeverityBadge severity={r.issue.severity} />, sort: (a, b) => SEV_RANK[a.issue.severity] - SEV_RANK[b.issue.severity] },
          { key: 'title', header: 'Issue', cell: (r) => <div className="min-w-0 max-w-[480px]"><Link to={`/issues/${r.issue.id}`} className="text-sm font-medium text-ink hover:text-signal">{r.issue.title}</Link><p className="truncate text-xs text-muted">{r.issue.summary}</p></div> },
          { key: 'check', header: 'Check', hideOnMobile: true, cell: (r) => <Mono className="text-xs">{r.issue.checkId}</Mono> },
          { key: 'pages', header: 'Pages', className: 'tabular-nums', cell: (r) => <span className="text-xs">{r.pages}</span>, sort: (a, b) => a.pages - b.pages },
          { key: 'open', header: '', cell: (r) => <Link to={`/issues/${r.issue.id}`} className="whitespace-nowrap text-xs font-medium text-signal hover:underline">Fix Card</Link> },
        ]}
      />
    </Panel>
  );
}
