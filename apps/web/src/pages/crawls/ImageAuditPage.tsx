import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, ExternalLink, Images, Play, RotateCw, Search, Square } from 'lucide-react';
import {
  IMAGE_ISSUE_LABELS, IMAGE_STATE_LABELS, IMAGE_STATES, imageIssueFix, localizeLocation,
  type ImageAuditItem, type ImageAuditJob, type ImageAuditQuery, type ImageCheckState, type ImageIssueId,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, EmptyState, Field, Input, LoadingBlock, Mono, Notice, PageHeader, Panel, ProgressBar, Select } from '@/components/ui/primitives';
import { Drawer } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect } from '@/components/ui/filters';
import { useToast } from '@/components/ui/Toast';
import { saveFile } from '@/components/crawls/LiveCrawl';
import { fmtDateTime, fmtNum, shortUrl } from '@/lib/format';
import { useSitePlatform } from '@/websites/WebsiteContext';
import { ImageThumb } from '@/components/crawls/ImageThumb';

const PAGE_SIZE = 50;
const STATE_TONE: Record<ImageCheckState, 'ok' | 'crit' | 'med' | 'neutral'> = { ok: 'ok', broken: 'crit', failed: 'crit', unverified: 'med', deferred: 'med', pending: 'neutral' };
const STATE_HELP: Record<ImageCheckState, string> = {
  ok: 'Answered 2xx with image content',
  broken: '4xx, or the answer was not an image',
  failed: '5xx, timeout or network error — may be temporary',
  unverified: 'Not requested: robots.txt, rate limited, or a third-party host',
  deferred: 'Not checked yet: the audit was cancelled or stopped — Resume checks these',
  pending: 'Waiting to be checked',
};
const ISSUE_ORDER: ImageIssueId[] = ['broken', 'failed', 'alt-missing', 'alt-empty', 'heavy', 'legacy-format', 'oversized', 'no-dimensions', 'not-lazy', 'redirect', 'duplicate', 'repeated', 'unverified'];
const kb = (b?: number) => (b === undefined ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${fmtNum(Math.round(b / 1024))} KB`);

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/**
 * Image Audit: a separate job, started here, that checks the images of one finished crawl. Crawls never request images
 * (ALT text, width / height and lazy-loading come from the HTML they fetched).
 */
export default function ImageAuditPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = useApiQuery(['imageAudits', 'status'], () => api.getImageAuditStatus(), { refetchInterval: 3000 });
  const st = status.data;
  const jobId = params.get('job') || st?.running?.id || st?.jobs[0]?.id || '';
  const [runId, setRunId] = useState('');
  const run = runId || st?.runs[0]?.runId || '';
  const start = useApiMutation((id: string) => api.startImageAudit(id), {
    success: (j) => `Image Audit ${j.id} started: ${fmtNum(j.images)} unique images${j.counts.reused ? `, ${fmtNum(j.counts.reused)} answers reused` : ''}`,
    invalidate: [['imageAudits']],
    onSuccess: (j) => setParams({ job: j.id }, { replace: true }),
  });

  return (
    <div>
      <PageHeader
        title="Image Audit"
        description="Checks the images of a finished crawl: availability, HTTP status and redirects, format, file size and pixel size, ALT text, width / height and lazy-loading. Each unique image is requested once, only when you start an audit — crawls never request images."
      />
      <div className="space-y-5">
        {status.isLoading ? <LoadingBlock rows={3} /> : status.error ? <Notice tone="crit">{errorMessage(status.error)}</Notice> : st && (
          <Panel title="Start an audit" subtitle={`Up to ${fmtNum(st.limits.maxImages)} unique images per audit, ${st.limits.concurrency} at a time, in rounds of ${st.limits.budgetMinutes < 1 ? `${fmtNum(Math.round(st.limits.budgetMinutes * 60))} seconds` : `${fmtNum(st.limits.budgetMinutes)} minutes`} that continue until every image is answered (at most ${fmtNum(st.limits.maxHours)} hours). The first ${st.limits.probeKb} KB of each image are read — never the whole file. robots.txt, rate limits and Retry-After are respected. It runs on the server: closing this page does not stop it.`}>
            {!st.available && <Notice tone="med">{st.reason}</Notice>}
            {st.available && !st.runs.length && (
              <EmptyState icon={<Images className="h-8 w-8" />} title="No crawl to audit yet" description="Run a Smart or Full crawl first. Its image references are kept with its results (temporary storage)." action={<Link className="text-sm font-medium text-signal hover:underline" to="/crawls">Open the Crawl Center</Link>} />
            )}
            {st.available && (
              <p className="mb-3 text-xs text-muted" data-testid="image-audit-storage">
                {st.storage === 'database'
                  ? 'Progress is stored in the database every few seconds: an audit running during a server restart continues afterwards, without requesting the images already answered.'
                  : 'Progress is kept in server memory only (no database): Resume works until the server restarts; a restart loses the audit.'}
              </p>
            )}
            {st.available && !!st.runs.length && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Crawl" htmlFor="img-run">
                  <Select id="img-run" value={run} onChange={(e) => setRunId(e.target.value)}>
                    {st.runs.map((r) => <option key={r.runId} value={r.runId}>{r.runId} · {r.type} · {r.startedAt ? fmtDateTime(r.startedAt) : '—'}{r.pages ? ` · ${fmtNum(r.pages)} pages` : ''}</option>)}
                  </Select>
                </Field>
                <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={start.isPending} disabled={!can('crawls.run') || !!st.running || !run}
                  title={!can('crawls.run') ? 'Your role cannot start audits (needs crawls.run).' : st.running ? `${st.running.id} is running` : undefined} onClick={() => start.mutate(run)}>
                  Start Image Audit
                </Button>
                {st.jobs.length > 1 && (
                  <Field label="Show audit" htmlFor="img-job">
                    <Select id="img-job" value={jobId} onChange={(e) => setParams({ job: e.target.value }, { replace: true })}>
                      {st.jobs.map((j) => <option key={j.id} value={j.id}>{j.id} · crawl {j.runId} · {fmtDateTime(j.startedAt)}</option>)}
                    </Select>
                  </Field>
                )}
              </div>
            )}
          </Panel>
        )}
        {jobId && <JobView id={jobId} />}
      </div>
    </div>
  );
}

function JobView({ id }: { id: string }) {
  const { can } = useAuth();
  const job = useApiQuery(['imageAudits', 'job', id], () => api.getImageAudit(id), { refetchInterval: 1000 });
  const j = job.data;
  const runningNow = j?.status === 'running';
  const cancel = useApiMutation(() => api.cancelImageAudit(id), { success: 'Image Audit cancelled — images not checked are listed as deferred; Resume continues with them', invalidate: [['imageAudits']] });
  const resume = useApiMutation(() => api.resumeImageAudit(id), { success: (r) => `Image Audit ${r.id} resumed: only the images not answered yet are checked`, invalidate: [['imageAudits']] });
  if (job.isLoading) return <LoadingBlock rows={4} />;
  if (job.error) return <Notice tone="crit">{errorMessage(job.error)}</Notice>;
  if (!j) return null;
  const c = j.counts;
  // Progress = images with a final answer. 100 % only when nothing is pending or deferred (deferred = not checked yet).
  const finished = c.finished ?? c.total - c.pending - c.deferred;
  const left = c.pending + c.deferred;
  const pct = !c.total ? 100 : left ? Math.min(99, Math.floor((finished / c.total) * 100)) : 100;
  return (
    <>
      <Panel
        title={`${j.id} · crawl ${j.runId}`}
        subtitle={`Started ${fmtDateTime(j.startedAt)} by ${j.startedBy}${j.finishedAt ? ` · finished ${fmtDateTime(j.finishedAt)}` : ''}`}
        actions={runningNow && can('crawls.run')
          ? <Button size="sm" variant="secondary" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel audit</Button>
          : (
            <span className="flex items-center gap-2">
              <JobStatus job={j} />
              {j.resumable && can('crawls.run') && <Button size="sm" variant="primary" icon={<RotateCw className="h-3.5 w-3.5" />} loading={resume.isPending} onClick={() => resume.mutate()}>Resume ({fmtNum(left)} left)</Button>}
            </span>
          )}
      >
        <div className="space-y-3">
          <ProgressBar value={pct} tone={j.status === 'failed' ? 'crit' : j.status === 'cancelled' || j.status === 'partial' ? 'med' : 'signal'} label="Images with a final answer" />
          <p className="text-sm font-medium text-ink" data-testid="image-audit-progress">
            {fmtNum(finished)} of {fmtNum(c.total)} images answered ({pct}%){left ? ` · ${fmtNum(c.pending)} pending · ${fmtNum(c.deferred)} deferred` : ' · every image is answered'}
            {j.rounds ? ` · ${fmtNum(j.rounds)} checking round${j.rounds === 1 ? '' : 's'}` : ''}{j.resumes ? ` · resumed ${fmtNum(j.resumes)}×` : ''}
          </p>
          {j.waiting && <p className="text-sm text-med-ink">{j.waiting}</p>}
          {j.checkpoint && (
            <p className="text-xs text-muted">
              Progress stored {fmtDateTime(j.checkpoint.at)} ({fmtNum(j.checkpoint.finished)} answers){j.checkpoint.storage === 'database' ? ' in the database — kept across server restarts' : ' in server memory — lost on a server restart'}.
              {runningNow ? ' The audit runs on the server: closing this page does not stop it.' : ''}
            </p>
          )}
          <p className="text-sm text-ink-soft">
            {fmtNum(j.images)} unique images from {fmtNum(j.references)} references on {fmtNum(j.pages)} pages
            {j.inlineImages ? ` · ${fmtNum(j.inlineImages)} inline (data:) images not counted` : ''}
            {j.overLimit ? ` · ${fmtNum(j.overLimit)} references to further images beyond the ${fmtNum(j.images)}-image limit` : ''}
            {c.requests !== undefined ? ` · ${fmtNum(c.requests)} requests` : ''}{c.rateLimited ? ` · ${fmtNum(c.rateLimited)} rate-limited answers` : ''}
            {c.reused ? ` · ${fmtNum(c.reused)} answers reused (not requested again)` : ''}
          </p>
          {j.reason && <p className="text-sm text-med-ink">{j.reason}</p>}
          {j.error && <Notice tone="crit">{j.error}</Notice>}
        </div>
      </Panel>
      <ImageList id={id} job={j} />
    </>
  );
}

function JobStatus({ job }: { job: ImageAuditJob }) {
  const tone = job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'crit' : job.status === 'running' ? 'signal' : 'med';
  return <Badge tone={tone}>{job.status === 'partial' ? 'Partly done — resume to finish' : job.status[0].toUpperCase() + job.status.slice(1)}</Badge>;
}

function ImageList({ id, job }: { id: string; job: ImageAuditJob }) {
  const toast = useToast();
  const [state, setState] = useState<'' | ImageCheckState>('');
  const [issue, setIssue] = useState<'' | ImageIssueId>('');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | undefined>();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ImageAuditItem | null>(null);
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  useEffect(() => setPage(1), [state, issue, q, sort, id]);
  const query: ImageAuditQuery = {
    state: state || undefined, issue: issue || undefined, q: q || undefined, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE,
    sort: sort ? (sort.key as ImageAuditQuery['sort']) : undefined, dir: sort?.dir,
  };
  // The key follows the job's progress, so the list is fetched again when results arrive and when the job ends.
  const res = useApiQuery(['imageAudits', 'images', id, JSON.stringify(query), job.status, job.counts.pending], () => api.listImageAudit(id, query), { refetchInterval: job.status === 'running' ? 2000 : undefined });
  const f = res.data?.facets;
  const filtered = !!(state || issue || q);
  const exportAs = async (format: 'csv' | 'json') => {
    setBusy(format);
    try { saveFile(await api.exportImageAudit(id, format, { ...query, offset: undefined, limit: undefined })); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const c = job.counts;
  return (
    <Panel title="Images" subtitle="Select a state or a problem to filter; select a row for the pages that show the image and what to do." bodyClassName="p-3">
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {IMAGE_STATES.map((s) => {
          const n = c[s];
          const on = state === s;
          return (
            <button key={s} type="button" aria-pressed={on} title={STATE_HELP[s]} onClick={() => setState(on ? '' : s)}
              className={`rounded-ctl border px-3 py-2 text-left transition-colors ${on ? 'border-signal bg-signal/5' : 'border-line hover:border-signal/50'}`}>
              <span className={`block text-xl font-semibold tabular-nums ${s === 'ok' ? 'text-ok-ink' : s === 'broken' || s === 'failed' ? 'text-crit-ink' : s === 'pending' ? 'text-muted' : 'text-med-ink'}`}>{fmtNum(n)}</span>
              <span className="block text-xs font-medium text-ink">{IMAGE_STATE_LABELS[s]}</span>
            </button>
          );
        })}
      </div>
      {res.error && <Notice tone="crit">{errorMessage(res.error)}</Notice>}
      <DataTable
        rows={res.data?.rows ?? []}
        rowKey={(i) => i.url}
        dense
        onRowClick={setOpen}
        caption="Audited images"
        server={{ page, pageSize: PAGE_SIZE, total: res.data?.total ?? 0, onPage: setPage, sort, onSort: setSort }}
        toolbar={
          <>
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
              <Input aria-label="Search image, page or ALT" placeholder="Search image, page or ALT" value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
            </div>
            <FilterSelect label="Problem" value={issue} onChange={(v) => setIssue(v as ImageIssueId | '')} options={ISSUE_ORDER.filter((k) => f?.issue[k]).map((k) => ({ value: k, label: `${IMAGE_ISSUE_LABELS[k]} (${fmtNum(f!.issue[k]!)})` }))} />
            <ClearFilters show={filtered} onClear={() => { setState(''); setIssue(''); setText(''); }} />
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'csv'} onClick={() => void exportAs('csv')}>CSV</Button>
              <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'json'} onClick={() => void exportAs('json')}>JSON</Button>
            </span>
          </>
        }
        empty={res.isLoading ? <LoadingBlock rows={6} /> : <EmptyState title={filtered ? 'No image matches these filters' : 'No images in this crawl'} description={filtered ? 'Clear the filters or search.' : undefined} />}
        columns={[
          {
            key: 'url', header: 'Image', sort: () => 0, cell: (i) => (
              <div className="flex min-w-0 max-w-[400px] items-center gap-2">
                <ImageThumb src={i.url} alt="" size={36} />
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-ink" title={i.url}>{shortUrl(i.url)}</p>
                  {i.altText ? <p className="truncate text-xs text-muted" title={i.altText}>ALT: {i.altText}</p> : i.altMissing ? <p className="text-xs font-medium text-med-ink">No ALT text</p> : null}
                </div>
              </div>
            ),
          },
          { key: 'state', header: 'Result', sort: () => 0, cell: (i) => <Badge tone={STATE_TONE[i.state]} title={i.reason ?? STATE_HELP[i.state]}>{IMAGE_STATE_LABELS[i.state]}</Badge> },
          { key: 'http', header: 'HTTP', hideOnMobile: true, cell: (i) => <span className="whitespace-nowrap text-xs tabular-nums">{i.status ?? '—'}{i.redirects ? ` → ${i.finalStatus ?? '—'}` : ''}</span> },
          { key: 'format', header: 'Format', hideOnMobile: true, cell: (i) => <span className="text-xs uppercase">{i.format ?? '—'}</span> },
          { key: 'bytes', header: 'Size', sort: () => 0, className: 'tabular-nums', cell: (i) => <span className={`text-xs ${i.issues.includes('heavy') ? 'font-medium text-med-ink' : ''}`}>{kb(i.bytes)}</span> },
          { key: 'dims', header: 'Pixels', hideOnMobile: true, cell: (i) => <span className="whitespace-nowrap text-xs tabular-nums">{i.width ? `${i.width}×${i.height ?? '?'}` : '—'}</span> },
          { key: 'pages', header: 'Pages', sort: () => 0, className: 'tabular-nums', cell: (i) => <span className="text-xs">{fmtNum(i.pageCount)}</span> },
          { key: 'issues', header: 'Problems', cell: (i) => (i.issues.length ? <span className="text-xs" title={i.issues.map((x) => IMAGE_ISSUE_LABELS[x]).join(', ')}>{i.issues.slice(0, 2).map((x) => IMAGE_ISSUE_LABELS[x]).join(', ')}{i.issues.length > 2 ? ` +${i.issues.length - 2}` : ''}</span> : <span className="text-xs text-faint">None</span>) },
        ]}
      />
      <ImageDrawer item={open} auditId={id} runId={job.runId} onClose={() => setOpen(null)} />
    </Panel>
  );
}

/** Where each problem is fixed, how long it takes and how to verify it (for the selected website's platform). */
function ImageFixes({ issues }: { issues: ImageIssueId[] }) {
  const platform = useSitePlatform();
  const rows = issues.map((id) => ({ id, f: imageIssueFix(id) })).filter((x) => x.f);
  if (!rows.length) return null;
  return (
    <section data-testid="image-fixes">
      <h3 className="mb-1 text-sm font-semibold">Where to fix it and how long it takes</h3>
      <ul className="space-y-2">
        {rows.map(({ id, f }) => (
          <li key={id} className="rounded-ctl border border-line px-3 py-2 text-xs">
            <p className="text-sm font-medium text-ink">{IMAGE_ISSUE_LABELS[id]} <span className="ml-1 font-normal tabular-nums text-muted">· {f!.time.label}</span></p>
            <p className="text-muted">{f!.time.basis}</p>
            <p className="mt-0.5"><span className="text-muted">Where: </span>{f!.where.map((w) => localizeLocation(w, platform)).map((w, k) => <span key={k}>{k ? ' · ' : ''}<span className="font-medium text-ink">{w.label}</span>{w.path ? <span className="text-ink-soft"> — {w.path}</span> : null}</span>)}</p>
            <p className="mt-0.5"><span className="text-muted">Verify: </span><span className="text-ink-soft">{f!.verify}</span></p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 border-b border-line py-1.5 text-sm last:border-0"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{children}</dd></div>;
}

const pageHref = (runId: string, p: string) => `/pages/report?run=${encodeURIComponent(runId)}&url=${encodeURIComponent(p)}`;
const OCC_PAGE = 50;

/**
 * The pages showing one image, read from the crawl's image references: every page (paged), how many times the image
 * appears on each, and — for `repeated` — every copy on the page with its position, HTML location, ALT and loading.
 */
function Occurrences({ auditId, runId, item, repeated }: { auditId: string; runId: string; item: ImageAuditItem; repeated?: boolean }) {
  const [page, setPage] = useState(0);
  const q = useApiQuery(['imageOccurrences', auditId, item.url, repeated ? 'repeated' : 'all', page], () => api.getImageOccurrences(auditId, item.url, { repeated, offset: page * OCC_PAGE, limit: OCC_PAGE }));
  const kind = repeated ? 'repeated' : 'pages';
  if (q.isLoading) return <LoadingBlock rows={3} />;
  if (q.error || !q.data) {
    return (
      <div data-testid={`occ-${kind}-fallback`}>
        <p className="mb-1 text-xs text-muted">The pages could not be loaded ({errorMessage(q.error)}).{repeated ? ' Which copies repeat could not be identified.' : ` The first ${item.pages.length} of ${fmtNum(item.pageCount)} pages:`}</p>
        {!repeated && <ul className="space-y-0.5">{item.pages.map((p) => <li key={p}><Link className="break-all font-mono text-xs text-signal hover:underline" to={pageHref(runId, p)}>{shortUrl(p)}</Link></li>)}</ul>}
      </div>
    );
  }
  const d = q.data;
  if (!d.available) {
    return (
      <div data-testid={`occ-${kind}-unavailable`}>
        <p className="mb-1 text-xs text-muted">{d.reason}</p>
        {!repeated && <ul className="space-y-0.5">{item.pages.map((p) => <li key={p}><Link className="break-all font-mono text-xs text-signal hover:underline" to={pageHref(runId, p)}>{shortUrl(p)}</Link></li>)}</ul>}
      </div>
    );
  }
  const pages = Math.max(1, Math.ceil(d.total / OCC_PAGE));
  return (
    <div data-testid={`occ-${kind}`}>
      <p className="mb-1.5 text-xs text-ink-soft">
        {repeated
          ? <><span className="font-medium text-ink tabular-nums">{fmtNum(d.repeatedPages)}</span> {d.repeatedPages === 1 ? 'page shows' : 'pages show'} this image more than once.</>
          : <>Shown on <span className="font-medium text-ink tabular-nums">{fmtNum(d.pages)}</span> page{d.pages === 1 ? '' : 's'} — {fmtNum(d.references)} &lt;img&gt; in total.</>}
      </p>
      <ul className="space-y-1.5">
        {d.rows.map((o) => (
          <li key={o.page} className="rounded-ctl border border-line px-2.5 py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Link className="min-w-0 flex-1 break-all font-mono text-xs text-signal hover:underline" to={pageHref(runId, o.page)} title={o.page}>{shortUrl(o.page)}</Link>
              <a href={o.page} target="_blank" rel="noreferrer noopener" className="text-faint hover:text-signal" aria-label={`Open ${o.page} in a new tab`}><ExternalLink className="h-3.5 w-3.5" /></a>
              <span className={`text-xs tabular-nums ${o.count > 1 ? 'font-medium text-med-ink' : 'text-muted'}`}>{o.count > 1 ? `${o.count}× on this page` : 'once'}</span>
            </div>
            {repeated && (
              <table className="mt-1 w-full text-left text-xs">
                <thead className="text-muted"><tr><th className="py-0.5 pr-2 font-normal">Copy</th><th className="py-0.5 pr-2 font-normal">Where in the HTML</th><th className="py-0.5 pr-2 font-normal">ALT</th><th className="py-0.5 font-normal">Size / loading</th></tr></thead>
                <tbody>
                  {o.instances.map((x, k) => (
                    <tr key={k} className="border-t border-line align-top">
                      <td className="py-1 pr-2 tabular-nums">{k + 1} <span className="text-muted">(image #{x.position})</span></td>
                      <td className="py-1 pr-2">{x.location ? <Mono className="text-[11px]">{x.location}</Mono> : <span className="text-muted">{x.inMain ? 'Main content — section not identifiable' : 'Section not identifiable'}</span>}</td>
                      <td className="py-1 pr-2">{x.alt === null ? <span className="text-med-ink">missing</span> : x.alt === '' ? <span className="text-muted">empty</span> : `"${x.alt}"`}</td>
                      <td className="py-1">{x.width ? `${x.width}×${x.height ?? '?'}` : <span className="text-muted">no size</span>}{x.loading ? ` · ${x.loading}` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="mt-1.5 flex items-center gap-3 text-xs">
          <button type="button" className="text-signal hover:underline disabled:text-faint disabled:no-underline" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
          <span className="tabular-nums text-muted">{fmtNum(page * OCC_PAGE + 1)}–{fmtNum(Math.min(d.total, (page + 1) * OCC_PAGE))} of {fmtNum(d.total)}</span>
          <button type="button" className="text-signal hover:underline disabled:text-faint disabled:no-underline" disabled={page + 1 >= pages} onClick={() => setPage((n) => n + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function ImageDrawer({ item: i, auditId, runId, onClose }: { item: ImageAuditItem | null; auditId: string; runId: string; onClose: () => void }) {
  const repeated = !!i && ((i.repeatedPages ?? 0) > 0 || i.issues.includes('repeated'));
  return (
    <Drawer open={!!i} onClose={onClose} title={i ? <span className="block truncate font-mono text-sm" title={i.url}>{shortUrl(i.url)}</span> : ''} width="lg">
      {i && (
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <ImageThumb src={i.url} alt={i.altText ?? ''} size={112} />
            <a href={i.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-w-0 max-w-full items-center gap-1 break-all font-mono text-xs text-signal hover:underline">{i.url}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>
          </div>
          <section>
            <h3 className="mb-1 text-sm font-semibold">Check</h3>
            <dl>
              <Row k="Result"><Badge tone={STATE_TONE[i.state]}>{IMAGE_STATE_LABELS[i.state]}</Badge>{i.reason && <span className="ml-2 text-xs text-ink-soft">{i.reason}</span>}{i.reused && <span className="ml-2 text-xs text-muted">({i.reused === 'crawl' ? "from the crawl's link check" : 'from the previous audit'})</span>}</Row>
              <Row k="HTTP status">{i.status ?? '—'}{i.redirects ? <span className="ml-2 text-xs">→ {i.finalStatus ?? '—'} after {i.redirects} redirect{i.redirects > 1 ? 's' : ''}</span> : null}</Row>
              {i.finalUrl && <Row k="Final URL"><Mono className="text-xs">{i.finalUrl}</Mono></Row>}
              <Row k="Format">{i.format ? i.format.toUpperCase() : '—'}{i.contentType && <span className="ml-2 text-xs text-muted">{i.contentType}</span>}</Row>
              <Row k="File size">{kb(i.bytes)}</Row>
              <Row k="Pixel size">{i.width ? `${i.width} × ${i.height ?? '?'} px` : '—'}</Row>
              <Row k="Shown at (HTML)">{i.htmlWidth ? `${i.htmlWidth} × ${i.htmlHeight ?? '?'}` : '—'}</Row>
              {i.checkedAt && <Row k="Checked">{fmtDateTime(i.checkedAt)}{i.ms !== undefined && <span className="ml-2 text-xs text-muted">{fmtNum(i.ms)} ms</span>}</Row>}
            </dl>
          </section>
          <section>
            <h3 className="mb-1 text-sm font-semibold">In the HTML</h3>
            <dl>
              <Row k="References">{fmtNum(i.refs)} on {fmtNum(i.pageCount)} page{i.pageCount === 1 ? '' : 's'}{i.inMain ? '' : ' (outside the main content)'}</Row>
              <Row k="Same page">{repeated ? <span className="font-medium text-med-ink">Shown more than once on {i.repeatedPages !== undefined ? `${fmtNum(i.repeatedPages)} page${i.repeatedPages === 1 ? '' : 's'}` : 'at least one page'}{i.maxPerPage ? ` (up to ${i.maxPerPage}× on one page)` : ''}</span> : 'Shown once per page'}</Row>
              {i.pageCount > 1 && <Row k="Other pages">Reused on {fmtNum(i.pageCount)} pages <span className="text-xs text-muted">— normal for logos, badges and banners; not a problem</span></Row>}
              <Row k="ALT text">{i.altText ?? <span className="text-muted">none</span>}{i.altMissing ? <span className="ml-2 text-xs font-medium text-med-ink">missing on {fmtNum(i.altMissing)}</span> : null}{i.altEmpty ? <span className="ml-2 text-xs text-med-ink">alt="" on {fmtNum(i.altEmpty)}</span> : null}</Row>
              <Row k="width / height">{i.noDimensions ? <span className="text-med-ink">missing on {fmtNum(i.noDimensions)} reference{i.noDimensions === 1 ? '' : 's'}</span> : 'present'}</Row>
              <Row k="Lazy-loading">{fmtNum(i.lazy)} lazy{i.eagerBelowFold ? <span className="ml-2 text-med-ink">{fmtNum(i.eagerBelowFold)} below the fold without loading="lazy"</span> : null}</Row>
              {i.duplicateUrls ? <Row k="Same file as"><Mono className="text-xs">{i.duplicateOf}</Mono>{i.duplicateUrls > 1 && <span className="ml-1 text-xs text-muted">and {i.duplicateUrls - 1} more URL(s)</span>}</Row> : null}
            </dl>
          </section>
          {!!i.recommendations.length && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">What to do</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">{i.recommendations.map((r) => <li key={r}>{r}</li>)}</ul>
            </section>
          )}
          <ImageFixes issues={i.issues} />
          {repeated && (
            <section data-testid="image-repeated-section">
              <h3 className="mb-0.5 text-sm font-semibold">Repeated on the same page</h3>
              <p className="mb-1.5 text-xs text-muted">The same image file appears more than once on one page. Each copy is listed with where it sits in the HTML, so you can remove the extra one or mark it decorative.</p>
              <Occurrences key={`${i.url}-r`} auditId={auditId} runId={runId} item={i} repeated />
            </section>
          )}
          <section>
            <h3 className="mb-0.5 text-sm font-semibold">Pages showing it ({fmtNum(i.pageCount)})</h3>
            {i.pageCount > 1 && <p className="mb-1.5 text-xs text-muted">Using one image on several pages is not flagged; only extra copies on the same page are.</p>}
            <Occurrences key={`${i.url}-a`} auditId={auditId} runId={runId} item={i} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
