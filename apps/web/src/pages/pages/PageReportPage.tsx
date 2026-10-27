import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, GitCompareArrows, PencilLine } from 'lucide-react';
import { ApiError, CHANGE_FIELD_LABELS, type CrawledUrl, type CrawlPageReport, type PageAudit, type PageAuditLimits } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, EmptyState, LoadingBlock, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { AuditChecks, ScoreBadge } from '@/components/crawls/PageAudit';
import { PageList } from '@/components/crawls/CheckDetails';
import { IssueItem } from '@/components/crawls/PageResults';
import { HttpStatusBadge } from '@/components/crawls/crawlBadges';
import { KindBadge } from '@/components/crawls/ChangeMonitor';
import { fmtDateTime, fmtMs, fmtNum, shortUrl } from '@/lib/format';

const EDITABLE = /\/(products|collections|pages|blogs)\//;

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 border-b border-line py-2 text-sm last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Length against the configured range: "54 characters (30–60)". */
function Len({ text, min, max }: { text?: string; min: number; max: number }) {
  const n = [...(text ?? '').trim()].length;
  const off = n < min || n > max;
  return <span className={`ml-2 whitespace-nowrap text-xs ${off ? 'text-med-ink' : 'text-muted'}`}>{n} characters ({min}–{max})</span>;
}

/** One page of one crawl: the full audit with recommendations, what the crawler read, issues, and the latest change. */
export default function PageReportPage() {
  const [params] = useSearchParams();
  const runId = params.get('run') || 'latest';
  const url = params.get('url') ?? '';
  const report = useApiQuery(['crawlPage', runId, url], () => api.getCrawlPage(runId, url), { enabled: !!url });
  const back = `/pages${runId !== 'latest' ? `?run=${encodeURIComponent(runId)}` : ''}`;

  return (
    <div>
      <Link to={back} className="mb-3 inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> All pages</Link>
      {!url ? (
        <Panel><EmptyState title="No page selected" description="Open a page from All pages to see its report." /></Panel>
      ) : report.isLoading ? <LoadingBlock rows={8} /> : report.error ? (
        <Notice tone="crit" title={report.error instanceof ApiError && report.error.status === 404 ? 'This page is not in that crawl' : 'The page report could not be loaded'}>{errorMessage(report.error)}</Notice>
      ) : report.data && (
        <Report row={report.data.row} audit={report.data.audit} limits={report.data.limits} runId={report.data.runId} crawledAt={report.data.crawledAt} duplicates={report.data.duplicates} />
      )}
    </div>
  );
}

function Report({ row: u, audit, limits, runId, crawledAt, duplicates }: { row: CrawledUrl; audit: PageAudit; limits: PageAuditLimits; runId: string; crawledAt?: string; duplicates?: CrawlPageReport['duplicates'] }) {
  const canEdit = useAuth().can('shopify.edit');
  const c = audit.counts;
  // Title / description are only "missing" on a page whose HTML was read.
  const missing = audit.notAudited ? <span className="text-muted">—</span> : <span className="text-crit-ink">Missing</span>;
  return (
    <>
      <PageHeader
        title={<span className="block break-words">{u.title?.trim() || shortUrl(u.url)}</span>}
        description={<a href={u.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-signal hover:underline">{u.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>}
        meta={<span className="text-xs text-muted">Crawl <Link className="text-signal hover:underline" to={`/crawls/${runId}`}>{runId}</Link>{crawledAt && <> · {fmtDateTime(crawledAt)} IST</>}</span>}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {canEdit && EDITABLE.test(u.url) && (
              <Link to={`/seo-editor?url=${encodeURIComponent(u.url)}`} className="inline-flex items-center gap-1.5 rounded-ctl bg-signal px-3 py-2 text-sm font-medium text-white hover:bg-signal-dark"><PencilLine className="h-4 w-4" /> Fix in SEO editor</Link>
            )}
            <Link to={`/crawls/compare?url=${encodeURIComponent(u.url)}`} className="inline-flex items-center gap-1.5 rounded-ctl border border-line px-3 py-2 text-sm font-medium text-ink hover:border-signal"><GitCompareArrows className="h-4 w-4" /> Compare versions</Link>
          </div>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-5">
          <Panel>
            <div className="flex flex-wrap items-center gap-4">
              <ScoreBadge score={audit.score} large />
              <div className="text-sm">
                <p className="font-medium text-ink">{audit.score === null ? 'Not scored' : audit.score >= 80 ? 'Good' : audit.score >= 50 ? 'Fair' : 'Poor'}</p>
                <p className="text-muted">{c.fail} to fix · {c.warn} to improve · {c.pass} passed{c.info ? ` · ${c.info} notes` : ''}</p>
              </div>
            </div>
            {audit.notAudited && <p className="mt-3 text-sm text-muted">{audit.notAudited}</p>}
          </Panel>
          <Panel title="Audit" subtitle="Each element of the page, what the crawler found, what to change, where, how long it takes and how to verify it.">
            <AuditChecks key={u.url} audit={audit} template={u.template} context={{ row: u, runId, limits, duplicates }} />
          </Panel>
          <Panel title={`Issues on this page (${u.issues?.length ?? 0})`} subtitle="Tracked issues of this crawl that reference this URL.">
            {u.issues?.length ? <ul className="space-y-2">{u.issues.map((i) => <IssueItem key={i.id} i={i} />)}</ul> : <p className="text-sm text-muted">No tracked issue references this URL.</p>}
          </Panel>
        </div>
        <div className="space-y-5">
          <Panel title="What the crawler read">
            <dl>
              <Row k="HTTP status"><HttpStatusBadge status={u.status} error={u.error} />{u.redirects ? <span className="ml-2 text-xs">→ {u.finalStatus ?? 'no response'} after {u.redirects} redirect{u.redirects > 1 ? 's' : ''}</span> : null}</Row>
              {u.finalUrl && <Row k="Final URL"><Mono className="text-xs">{u.finalUrl}</Mono></Row>}
              <Row k="Response time">{u.responseMs !== undefined ? fmtMs(u.responseMs) : '—'}</Row>
              <Row k="Title">{u.title?.trim() ? <>{u.title}<Len text={u.title} min={limits.titleMinChars} max={limits.titleMaxChars} /></> : missing}</Row>
              <Row k="Meta description">{u.metaDescription?.trim() ? <>{u.metaDescription}<Len text={u.metaDescription} min={limits.metaMinChars} max={limits.metaMaxChars} /></> : missing}</Row>
              <Row k="Canonical">{u.canonical ? <Mono className="text-xs">{u.canonical}</Mono> : <span className="text-muted">None</span>}</Row>
              <Row k="Indexable">{u.indexable === undefined ? '—' : u.indexable ? <Badge tone="ok">Yes</Badge> : <Badge tone="med">No</Badge>}{u.indexabilityReason && <span className="ml-2 text-xs text-ink-soft">{u.indexabilityReason}</span>}</Row>
              <Row k="Meta robots">{u.metaRobots ?? <span className="text-muted">None</span>}{u.xRobotsTag && <span className="ml-2 text-xs">X-Robots-Tag: {u.xRobotsTag}</span>}</Row>
              <Row k="In sitemap">{u.inSitemap === undefined ? '—' : u.inSitemap ? 'Yes' : 'No'}</Row>
              <Row k="Words">{u.wordCount !== undefined ? fmtNum(u.wordCount) : '—'}{u.uniqueWords !== undefined && <span className="ml-1 text-xs text-muted">({fmtNum(u.uniqueWords)} unique)</span>}</Row>
              <Row k="Internal links">{u.internalLinks !== undefined ? fmtNum(u.internalLinks) : '—'}{u.inlinks !== undefined && <span className="ml-2 text-xs text-muted">{fmtNum(u.inlinks)} pointing here</span>}{(u.nofollowLinks ?? 0) > 0 && <span className="ml-2 text-xs font-medium text-med-ink">{u.nofollowLinks} nofollow</span>}</Row>
              <Row k="External links">{u.externalLinks !== undefined ? fmtNum(u.externalLinks) : '—'}</Row>
              {(u.titleCount || u.metaDescriptionCount || u.canonicalCount) && <Row k="Repeated tags"><span className="text-med-ink">{[u.titleCount && `${u.titleCount} titles`, u.metaDescriptionCount && `${u.metaDescriptionCount} meta descriptions`, u.canonicalCount && `${u.canonicalCount} canonicals`].filter(Boolean).join(' · ')}</span></Row>}
              <Row k="Images">{u.images !== undefined ? fmtNum(u.images) : '—'}{(u.imagesMissingAlt ?? 0) > 0 && <span className="ml-2 font-medium text-med-ink">{u.imagesMissingAlt} without ALT</span>}</Row>
            </dl>
          </Panel>
          <Panel title="Heading outline">
            {u.headings?.length ? (
              <ul className="space-y-1 text-sm">
                {u.headings.map((h, i) => <li key={i} style={{ paddingLeft: `${(h.level - 1) * 14}px` }}><span className="mr-1.5 font-mono text-xs text-faint">H{h.level}</span>{h.text || <em className="text-faint">empty</em>}</li>)}
              </ul>
            ) : u.h1?.length ? (
              <ul className="space-y-1 text-sm">{u.h1.map((h, i) => <li key={i}><span className="mr-1.5 font-mono text-xs text-faint">H1</span>{h || <em className="text-faint">empty</em>}</li>)}<li className="text-xs text-muted">{u.h2Count ?? 0} H2 headings (outline not recorded by this crawl)</li></ul>
            ) : <p className="text-sm text-muted">No headings recorded.</p>}
          </Panel>
          {duplicates && (duplicates.title.total > 0 || duplicates.meta.total > 0 || (duplicates.h1?.total ?? 0) > 0) && (
            <Panel title="Same as other pages" subtitle="Pages of this crawl with exactly the same text. Each page needs its own.">
              {(['title', 'meta', 'h1'] as const).map((k) => [k, duplicates[k]] as const).filter(([, g]) => (g?.total ?? 0) > 0).map(([k, g]) => (
                <div key={k} className="mb-3 last:mb-0" data-testid={`same-${k}`}>
                  <p className="mb-1 text-xs font-semibold text-muted">{k === 'title' ? 'Same title' : k === 'meta' ? 'Same meta description' : 'Same H1'} · {fmtNum(g!.total)} other page{g!.total === 1 ? '' : 's'}</p>
                  {g!.text && <p className="mb-1 break-words text-xs text-ink-soft">"{g!.text}"</p>}
                  <PageList urls={g!.urls} runId={runId} total={g!.total} />
                </div>
              ))}
            </Panel>
          )}
          <LatestChange url={u.url} />
        </div>
      </div>
    </>
  );
}

/** The newest recorded change of this URL from the Change Monitor — or a plain statement that none is recorded. */
function LatestChange({ url }: { url: string }) {
  const q = useApiQuery(['urlChange', url], () => api.getUrlChange(url));
  const ch = q.data?.change;
  return (
    <Panel title="Latest change" subtitle="From the Change Monitor: this URL in the newest compared crawl against the baseline.">
      {q.isLoading ? <LoadingBlock rows={2} /> : q.error ? <p className="text-sm text-crit-ink">{errorMessage(q.error)}</p> : !ch ? (
        <p className="text-sm text-muted">No comparison is recorded for this URL yet. One appears after two valid crawls of the website (history is kept on this server's disk only).</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2"><KindBadge r={ch} /><span className="text-xs text-muted">observed {fmtDateTime(ch.observedAt)} IST{ch.baselineObservedAt && <> · baseline {fmtDateTime(ch.baselineObservedAt)} IST</>}</span></div>
          <p className="text-ink-soft">{ch.evidence}</p>
          {ch.fields.length > 0 && (
            <ul className="space-y-1.5">
              {ch.fields.slice(0, 6).map((f) => (
                <li key={f.field} className="rounded-ctl border border-line px-3 py-2">
                  <p className="text-xs font-semibold text-muted">{CHANGE_FIELD_LABELS[f.field]}</p>
                  {(f.old !== undefined || f.new !== undefined) && <p className="mt-0.5 break-words text-xs"><span className="text-crit-ink line-through">{f.old || '(empty)'}</span> → <span className="text-ok-ink">{f.new || '(empty)'}</span></p>}
                  {f.note && <p className="mt-0.5 text-xs text-ink-soft">{f.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}
