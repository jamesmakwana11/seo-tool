import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Play, Square } from 'lucide-react';
import { MAX_BATCH_WEBSITES, type BatchCrawlType, type CrawlBatchJob, type CrawlBatchJobStatus } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Checkbox, EmptyState, Field, Input, LoadingBlock, Notice, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { SiteMark } from '@/components/websites/WebsiteSelector';
import { useWebsites } from '@/websites/WebsiteContext';
import { fmtDateTime, fmtNum } from '@/lib/format';

const STATUS: Record<CrawlBatchJobStatus, { label: string; tone: 'signal' | 'neutral' | 'ok' | 'crit' | 'med' }> = {
  running: { label: 'Running', tone: 'signal' }, queued: { label: 'Queued', tone: 'neutral' }, completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'crit' }, cancelled: { label: 'Cancelled', tone: 'med' }, scheduled: { label: 'Scheduled', tone: 'neutral' }, not_started: { label: 'Not started', tone: 'crit' },
};
const ORDER: CrawlBatchJobStatus[] = ['running', 'queued', 'completed', 'failed', 'cancelled', 'not_started'];
const PHASE: Record<string, string> = {
  waiting: 'Waiting for the server', preflight: 'Checking address', robots: 'robots.txt', sitemaps: 'Sitemaps', crawling: 'Fetching pages', crawling_sitemap_only: 'Sitemap-only pages',
  samples: 'Samples', checks: 'Checks after crawl', finalizing: 'Writing results', text_analysis: 'Duplicate analysis', analysing: 'Analysing', saving: 'Saving',
};

/**
 * Crawl several websites with one start: each website gets its own crawl job (own progress, results, findings, errors
 * and Cancel). The server runs a few at a time — as many as its settings and memory allow — and queues the rest.
 */
export default function BatchCrawlPage() {
  const { can } = useAuth();
  const { websites, loading, error, select } = useWebsites();
  const [params, setParams] = useSearchParams();
  const [chosen, setChosen] = useState<string[]>([]);
  const [type, setType] = useState<BatchCrawlType>('smart');
  const [maxPages, setMaxPages] = useState('');
  const [formError, setFormError] = useState<string>();
  const list = useApiQuery(['crawlBatches'], () => api.listCrawlBatches());
  const batchId = params.get('batch') || list.data?.[0]?.id || '';
  const start = useApiMutation((input: Parameters<typeof api.startCrawlBatch>[0]) => api.startCrawlBatch(input), {
    success: (b) => `Batch ${b.id}: ${b.jobs.filter((j) => j.runId && !j.existing).length} crawl${b.jobs.length === 1 ? '' : 's'} created — ${b.counts.running} running, ${b.counts.queued} queued`,
    invalidate: [['crawlBatches'], ['crawls']],
    silentError: true,
    onSuccess: (b) => { setParams({ batch: b.id }, { replace: true }); setChosen([]); },
  });
  const sites = websites ?? [];
  const full = chosen.length >= MAX_BATCH_WEBSITES;
  const toggle = (id: string, on: boolean) => setChosen((c) => (on ? (c.includes(id) || c.length >= MAX_BATCH_WEBSITES ? c : [...c, id]) : c.filter((x) => x !== id)));
  const submit = () => {
    setFormError(undefined);
    const mp = maxPages.trim() === '' ? null : Number(maxPages);
    if (type === 'full' && mp !== null && (!Number.isInteger(mp) || mp < 1)) { setFormError('Maximum pages must be a whole number of at least 1, or empty for no limit.'); return; }
    start.mutate({ websiteIds: chosen, type, ...(type === 'full' ? { maxPages: mp } : {}) }, { onError: (e) => setFormError(errorMessage(e)) });
  };

  return (
    <div>
      <PageHeader
        title="Crawl several websites"
        description={`Start crawls of up to ${MAX_BATCH_WEBSITES} websites at once. Each website gets its own crawl — its own progress, results, issues and Cancel — and nothing is mixed between websites. The server runs a few at a time, as many as its memory allows, and starts the queued ones automatically.`}
      />
      <div className="space-y-5">
        <Panel title="Choose websites" subtitle={`${chosen.length} of at most ${MAX_BATCH_WEBSITES} selected`}>
          {loading ? <LoadingBlock rows={3} /> : error ? <Notice tone="crit">{errorMessage(error)}</Notice> : !sites.length ? (
            <EmptyState title="No websites yet" description="Add websites first." action={<Link className="text-sm font-medium text-signal hover:underline" to="/websites?add=1">Add a website</Link>} />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <button type="button" className="font-medium text-signal hover:underline" onClick={() => setChosen(sites.slice(0, MAX_BATCH_WEBSITES).map((w) => w.id))}>
                  Select {sites.length > MAX_BATCH_WEBSITES ? `the first ${MAX_BATCH_WEBSITES}` : 'all'}
                </button>
                {!!chosen.length && <button type="button" className="font-medium text-signal hover:underline" onClick={() => setChosen([])}>Clear</button>}
                {full && <span className="text-med-ink">{MAX_BATCH_WEBSITES} websites is the most one batch can crawl.</span>}
                <Link to="/websites?add=1" className="ml-auto font-medium text-signal hover:underline">Add a website</Link>
              </div>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Websites">
                {sites.map((w) => {
                  const on = chosen.includes(w.id);
                  return (
                    <li key={w.id} className={`flex items-center gap-3 rounded-ctl border px-3 py-2 ${on ? 'border-signal bg-signal/5' : 'border-line'}`}>
                      <SiteMark site={w} />
                      <div className="min-w-0 flex-1">
                        <Checkbox label={<span className="font-medium">{w.name}</span>} checked={on} disabled={!on && full} onChange={(v) => toggle(w.id, v)}
                          description={<span className="font-mono text-xs">{w.domain}</span>} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
                <Field label="Crawl type" htmlFor="batch-type">
                  <Select id="batch-type" value={type} onChange={(e) => setType(e.target.value as BatchCrawlType)}>
                    <option value="smart">Smart crawl (up to 1,000 priority pages each)</option>
                    <option value="full">Full crawl (every page)</option>
                  </Select>
                </Field>
                {type === 'full' && (
                  <Field label="Maximum pages per website" htmlFor="batch-max" hint="Empty = no limit">
                    <Input id="batch-max" inputMode="numeric" value={maxPages} onChange={(e) => setMaxPages(e.target.value)} placeholder="No limit" className="w-36" />
                  </Field>
                )}
                <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={start.isPending} disabled={!can('crawls.run') || !chosen.length}
                  title={!can('crawls.run') ? 'Your role cannot start crawls (needs crawls.run).' : undefined} onClick={submit}>
                  Start {chosen.length || ''} crawl{chosen.length === 1 ? '' : 's'}
                </Button>
              </div>
              {formError && <Notice tone="crit">{formError}</Notice>}
            </div>
          )}
        </Panel>

        {list.data && list.data.length > 1 && (
          <Field label="Show batch" htmlFor="batch-pick">
            <Select id="batch-pick" value={batchId} onChange={(e) => setParams({ batch: e.target.value }, { replace: true })}>
              {list.data.map((b) => <option key={b.id} value={b.id}>{b.id} · {b.jobs.length} websites · {fmtDateTime(b.createdAt)}</option>)}
            </Select>
          </Field>
        )}
        {batchId && <BatchView id={batchId} onOpen={(siteId, runId) => select(siteId, `/crawls/${runId}`)} />}
      </div>
    </div>
  );
}

function BatchView({ id, onOpen }: { id: string; onOpen: (siteId: string, runId: string) => void }) {
  const { can } = useAuth();
  const [polling, setPolling] = useState(true);
  const q = useApiQuery(['crawlBatch', id], async () => { const b = await api.getCrawlBatch(id); setPolling(!b.finished); return b; }, { refetchInterval: polling ? 2000 : undefined });
  const cancelAll = useApiMutation(() => api.cancelCrawlBatch(id), { success: 'Every crawl of the batch still queued or running was cancelled', invalidate: [['crawlBatch', id], ['crawlBatches'], ['crawls']] });
  const b = q.data;
  const rows = useMemo(() => b?.jobs ?? [], [b]);
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error) return <Notice tone="crit">{errorMessage(q.error)}</Notice>;
  if (!b) return null;
  return (
    <Panel
      title={`Batch ${b.id} · ${b.type === 'smart' ? 'Smart crawls' : `Full crawls${b.maxPages ? ` (max ${fmtNum(b.maxPages)} pages)` : ''}`}`}
      subtitle={`Started ${fmtDateTime(b.createdAt)} by ${b.createdBy} · ${b.jobs.length} website${b.jobs.length === 1 ? '' : 's'}`}
      actions={!b.finished && can('crawls.run') ? <Button size="sm" variant="secondary" icon={<Square className="h-3.5 w-3.5" />} loading={cancelAll.isPending} onClick={() => cancelAll.mutate()}>Cancel all remaining</Button> : <Badge tone="ok">Finished</Badge>}
      bodyClassName="p-3"
    >
      <dl className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Batch status">
        {ORDER.map((s) => (
          <div key={s} className="rounded-ctl border border-line px-3 py-2">
            <dt className="text-xs text-muted">{STATUS[s].label}</dt>
            <dd className="text-xl font-semibold tabular-nums" data-testid={`batch-count-${s}`}>{fmtNum(b.counts[s] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      <p className="mb-3 text-xs text-muted" data-testid="batch-server">
        This server runs at most {fmtNum(b.server.maxRunning)} crawls at the same time (all websites); now {fmtNum(b.server.running)} running, {fmtNum(b.server.waiting)} queued.
        {b.server.blockedBy ? ` Queued crawls wait because ${b.server.blockedBy}.` : ''} Queued crawls start automatically, in order. The crawls run on the server: closing this page does not stop them.
      </p>
      <DataTable<CrawlBatchJob>
        rows={rows}
        rowKey={(j) => j.websiteId}
        dense
        caption="Crawls of this batch"
        pageSize={MAX_BATCH_WEBSITES}
        columns={[
          { key: 'site', header: 'Website', cell: (j) => <div className="min-w-0"><p className="truncate font-medium">{j.websiteName}</p><p className="truncate font-mono text-xs text-muted">{j.domain}{j.runId ? ` · ${j.runId}` : ''}</p></div> },
          { key: 'status', header: 'Status', cell: (j) => <JobStatus job={j} /> },
          { key: 'progress', header: 'Progress', cell: (j) => <JobProgress job={j} /> },
          {
            key: 'actions', header: '', cell: (j) => (
              <span className="flex justify-end gap-2">
                {(j.status === 'running' || j.status === 'queued') && can('crawls.run') && !j.existing && <CancelJob batchId={b.id} job={j} />}
                {j.runId && <button type="button" className="text-sm font-medium text-signal hover:underline" onClick={() => onOpen(j.websiteId, j.runId!)}>{j.status === 'running' || j.status === 'queued' ? 'Watch' : 'Results'}</button>}
              </span>
            ),
          },
        ]}
      />
    </Panel>
  );
}

function JobStatus({ job: j }: { job: CrawlBatchJob }) {
  const st = STATUS[j.status];
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone={st.tone} icon={j.status === 'running' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" aria-hidden /> : undefined}>{st.label}</Badge>
      {j.status === 'queued' && j.run?.queue && <span className="text-xs text-muted">{`Position ${j.run.queue.position} of ${j.run.queue.waiting}`}</span>}
      {j.existing && <span className="text-xs text-muted">already running</span>}
    </span>
  );
}

function JobProgress({ job: j }: { job: CrawlBatchJob }) {
  const r = j.run;
  if (!r) return <span className="text-xs text-crit-ink">{j.error ?? 'Not started.'}</span>;
  if (r.status === 'queued') return <span className="text-xs text-muted">{r.queue?.reason ? `Waiting: ${r.queue.reason}.` : r.resume ? 'Waiting to start again after a server restart.' : 'Waiting for a free slot.'}</span>;
  return (
    <div className="space-y-0.5 text-xs">
      <p className="tabular-nums">
        {fmtNum(r.urlsCrawled)} processed{r.urlsDiscovered !== undefined ? ` · ${fmtNum(r.urlsDiscovered)} discovered` : ''}{r.urlsSucceeded !== undefined ? ` · ${fmtNum(r.urlsSucceeded)} successful` : ''}{r.urlsFailed ? ` · ${fmtNum(r.urlsFailed)} errors` : ''}
      </p>
      {r.status === 'running' && <p className="text-muted">{r.phase ? PHASE[r.phase] ?? r.phase : 'Running'}</p>}
      {r.status === 'completed' && <p className="text-ink-soft">{r.newIssues} new / {r.resolvedIssues} resolved / {r.recurringIssues} recurring issues</p>}
      {(r.status === 'failed' || r.status === 'cancelled') && r.error && <p className={r.status === 'failed' ? 'text-crit-ink' : 'text-med-ink'}>{r.error}</p>}
    </div>
  );
}

function CancelJob({ batchId, job }: { batchId: string; job: CrawlBatchJob }) {
  const m = useApiMutation(() => api.cancelCrawlBatchJob(batchId, job.websiteId), { success: `${job.websiteName}: crawl ${job.runId} cancelled — the other websites continue`, invalidate: [['crawlBatch', batchId], ['crawls']] });
  return <Button size="sm" variant="secondary" icon={<Square className="h-3.5 w-3.5" />} loading={m.isPending} onClick={() => m.mutate()} aria-label={`Cancel the crawl of ${job.websiteName}`}>Cancel</Button>;
}

