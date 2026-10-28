import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Send, Square } from 'lucide-react';
import { ApiError, SEO_BULK_FIELD_LABELS, type SeoBulkField, type SeoBulkItem, type SeoBulkJob, type SeoBulkStartInput } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiQuery } from '@/api/hooks';
import { Badge, Button, LoadingBlock, Notice, ProgressBar, Segmented } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { shortUrl } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';

const RESULT_TONE = { verified: 'ok', applied_unverified: 'med', failed: 'crit', conflict: 'crit', skipped: 'neutral' } as const;
const RESULT_LABEL = { verified: 'Written and verified', applied_unverified: 'Written, not verified', failed: 'Failed', conflict: 'Conflict — not written', skipped: 'Skipped' } as const;
const ISSUE_TONE = { resolved: 'ok', still_failing: 'med', not_verifiable: 'neutral', error: 'crit' } as const;
const ISSUE_LABEL = { resolved: 'Closed — re-check passed', still_failing: 'Still open', not_verifiable: 'Not re-checked', error: 'Re-check error' } as const;
const PAGE = 20;

/**
 * Bulk SEO fix: prepares the fixes (nothing written), shows what will change grouped by field with pages and changes
 * that can be excluded, applies the selection in the background with progress, and reports per change — verified,
 * failed, conflict, skipped — plus the issues closed after a passed re-check and what needs a person.
 *
 * `start` begins a new preparation when the dialog opens; without it the current job of this website is shown.
 */
export function BulkFixDialog({ start, title, onClose }: { start?: SeoBulkStartInput; title: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [job, setJob] = useState<SeoBulkJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<SeoBulkField | ''>('');
  const [filter, setFilter] = useState<'all' | 'selected' | 'review' | 'failed'>('all');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const began = useRef(false);

  // Start once (StrictMode-safe); a job already running for this website is shown instead of a second one.
  useEffect(() => {
    if (began.current) return;
    began.current = true;
    (async () => {
      try {
        setJob(start ? await api.startSeoBulkFix(start) : await api.getSeoBulkFix());
      } catch (e) {
        if (e instanceof ApiError && e.code === 'BULK_JOB_RUNNING') { setJob(await api.getSeoBulkFix().catch(() => null)); toast.error(e.message); }
        else setError(errorMessage(e));
      }
    })();
  }, [start, toast]);

  const live = job && (job.state === 'scanning' || job.state === 'applying');
  const poll = useApiQuery(['seo-bulk', job?.id], () => api.getSeoBulkFix(), { enabled: !!live, refetchInterval: live ? 1000 : undefined });
  useEffect(() => { if (poll.data && poll.data.id === job?.id) setJob(poll.data); }, [poll.data, job?.id]);
  useEffect(() => {
    if (job?.state === 'done') { void qc.invalidateQueries(); }
  }, [job?.state, qc]);

  const items = useApiQuery(['seo-bulk-items', job?.id, job?.state, job?.summary.selectedChanges, job?.progress.done, field, filter, page],
    () => api.listSeoBulkFixItems({ offset: page * PAGE, limit: PAGE, field: field || undefined, filter }),
    { enabled: !!job && job.state !== 'scanning' });

  const select = async (input: { url?: string; key?: string; included: boolean; all?: boolean }) => {
    if (!job || busy) return;
    setBusy(true);
    try { setJob(await api.selectSeoBulkFix({ jobId: job.id, ...input })); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!job || busy) return;
    setBusy(true);
    try { setJob(await api.applySeoBulkFix(job.id)); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!job) return;
    try { setJob(await api.cancelSeoBulkFix(job.id)); } catch (e) { toast.error(errorMessage(e)); }
  };

  const fields = job ? (Object.entries(job.summary.byField) as [SeoBulkField, { pages: number; changes: number }][]) : [];
  const pct = job && job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={title}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          {live && <Button variant="ghost" icon={<Square className="h-4 w-4" />} onClick={cancel} disabled={job?.cancelRequested}>{job?.cancelRequested ? 'Cancelling…' : 'Cancel'}</Button>}
          {job?.state === 'ready' && job.summary.changes > 0 && <Button variant="ghost" onClick={cancel}>Discard</Button>}
          {job?.state === 'ready' && job.summary.changes === 0 && <Button onClick={onClose}>Close</Button>}
          {job?.state === 'ready' && job.summary.changes > 0 && (
            <Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!job.summary.selectedChanges || busy} loading={busy} onClick={apply}>
              Apply {job.summary.selectedChanges} change{job.summary.selectedChanges === 1 ? '' : 's'} on {job.summary.selectedPages} page{job.summary.selectedPages === 1 ? '' : 's'}
            </Button>
          )}
          {!live && job?.state !== 'ready' && <Button onClick={onClose}>Close</Button>}
        </div>
      )}
    >
      <div className="space-y-4 text-sm">
        {error && <Notice tone="crit" title="The bulk fix could not start">{error}</Notice>}
        {!job && !error && <LoadingBlock rows={3} />}
        {job && (
          <>
            {live && (
              <div className="space-y-1.5" aria-live="polite">
                <p className="font-medium text-ink">{job.progress.phase}</p>
                <ProgressBar value={pct} label={job.progress.phase} />
                <p className="text-xs text-muted">
                  {job.state === 'scanning' ? `${job.scan.pagesScanned} page(s) read · ${job.summary.pages} to fix so far. Nothing is written while preparing.` : `${job.progress.done} of ${job.progress.total} page(s) written and read back.`}
                  {job.progress.message ? ` ${job.progress.message}` : ''}
                </p>
              </div>
            )}
            {job.state === 'failed' && <Notice tone="crit" title="Stopped">{job.error}</Notice>}
            {job.result && <ResultSummary job={job} />}
            {job.state !== 'scanning' && (
              <>
                <Summary job={job} />
                {job.scan.capped && <Notice tone="med">More than {job.scan.cap} pages need fixes: the first {job.scan.cap} are prepared here. Apply these, then run the bulk fix again for the rest.</Notice>}
                {fields.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Segmented label="Field" value={field || 'all'} onChange={(v) => { setField(v === 'all' ? '' : v as SeoBulkField); setPage(0); }}
                      items={[{ value: 'all', label: 'All fields' }, ...fields.map(([f, v]) => ({ value: f, label: `${SEO_BULK_FIELD_LABELS[f]} · ${v.pages}` }))]} />
                    <Segmented label="Show" value={filter} onChange={(v) => { setFilter(v); setPage(0); }}
                      items={[{ value: 'all', label: 'All' }, { value: 'selected', label: 'Selected' }, { value: 'review', label: 'To review' }, ...(job.result ? [{ value: 'failed' as const, label: 'Failed' }] : [])]} />
                    {job.state === 'ready' && (
                      <span className="ml-auto flex gap-2">
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => select({ all: true, included: true })}>Select all safe changes</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => select({ all: true, included: false })}>Select none</Button>
                      </span>
                    )}
                  </div>
                )}
                {items.isLoading ? <LoadingBlock rows={4} /> : items.data && (
                  <>
                    <ul className="space-y-2">
                      {items.data.items.map((it) => <ItemRow key={it.url} it={it} editable={job.state === 'ready' && !busy} onSelect={select} />)}
                      {!items.data.items.length && (
                        <li className="text-muted">
                          {job.summary.pages ? 'No page matches this filter.'
                            : job.manual.length ? 'No page needs a change the editor can make. What needs a person is listed below.'
                              : job.scope === 'issues' ? 'Nothing to fix: no open issue from a live crawl of this website concerns a title, meta description, H1, image alt text or internal link the editor can change.'
                                : 'Nothing to fix: every page’s values are already good.'}
                        </li>
                      )}
                    </ul>
                    {items.data.total > PAGE && (
                      <div className="flex items-center justify-between text-xs text-muted">
                        <span>{page * PAGE + 1}–{Math.min((page + 1) * PAGE, items.data.total)} of {items.data.total} pages</span>
                        <span className="flex gap-2">
                          <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                          <Button size="sm" variant="ghost" disabled={(page + 1) * PAGE >= items.data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
                        </span>
                      </div>
                    )}
                  </>
                )}
                <ManualList job={job} />
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function Summary({ job }: { job: SeoBulkJob }) {
  const s = job.summary;
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="bulk-summary">
      <Fig k="Pages to fix" v={s.pages} />
      <Fig k="Changes selected" v={s.selectedChanges} sub={`of ${s.changes}`} />
      <Fig k="To review first" v={s.reviewChanges} sub="wording changes, not selected" />
      <Fig k="Need a person" v={s.manual} sub="see the list below" />
    </dl>
  );
}

function Fig({ k, v, sub }: { k: string; v: number; sub?: string }) {
  return (
    <div className="rounded-ctl border border-line px-3 py-2">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-xl font-semibold tabular-nums text-ink">{v}{sub && <span className="ml-1 text-xs font-normal text-muted">{sub}</span>}</dd>
    </div>
  );
}

function ResultSummary({ job }: { job: SeoBulkJob }) {
  const r = job.result!;
  const closed = r.issues.filter((i) => i.outcome === 'resolved').length;
  return (
    <div className="space-y-2" data-testid="bulk-result">
      <Notice tone={r.failed || r.conflicts ? 'med' : 'signal'} title={job.state === 'cancelled' ? 'Cancelled' : 'Finished'}>
        {r.verified} change(s) written and verified · {r.unverified} written, not verified · {r.failed} failed · {r.conflicts} conflict(s) · {r.skipped} skipped.
        {r.pagesRechecked ? ` ${r.pagesRechecked} page(s) fetched again: scores updated in All pages.` : ''} {closed ? `${closed} issue(s) closed after their re-check passed.` : ''} {r.message !== 'Finished.' ? r.message : ''}
      </Notice>
      {r.issues.length > 0 && (
        <ul className="space-y-1 text-xs">
          {r.issues.map((i) => <li key={i.issueId} className="flex flex-wrap gap-1.5"><Badge tone={ISSUE_TONE[i.outcome]}>{ISSUE_LABEL[i.outcome]}</Badge><Link className="font-medium text-signal hover:underline" to={`/issues/${i.issueId}`}>{i.issueId}</Link><span>{i.title}</span><span className="text-ink-soft">— {i.details}</span></li>)}
        </ul>
      )}
    </div>
  );
}

function ItemRow({ it, editable, onSelect }: { it: SeoBulkItem; editable: boolean; onSelect: (x: { url?: string; key?: string; included: boolean }) => void }) {
  return (
    <li className={`rounded-ctl border p-3 ${it.included ? 'border-line' : 'border-line bg-raised/50 opacity-70'}`}>
      <div className="flex flex-wrap items-start gap-2">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[#7650D8]" aria-label={`Include ${it.title}`} checked={it.included} disabled={!editable} onChange={(e) => onSelect({ url: it.url, included: e.target.checked })} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{it.title}</span>
            <Badge>{it.pageType}</Badge>
            {it.status !== 'planned' && <Badge tone={it.status === 'done' ? 'ok' : it.status === 'partial' ? 'med' : it.status === 'failed' ? 'crit' : 'neutral'}>{it.status}</Badge>}
            {it.score?.after !== undefined && it.score.after !== null && <span className="text-xs text-muted">score {it.score.before ?? '—'} → <span className="font-semibold text-ink">{it.score.after}</span></span>}
          </div>
          <a href={it.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-signal hover:underline">{shortUrl(it.url)}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>
          <ul className="mt-2 space-y-2">
            {it.changes.map((c) => (
              <li key={c.key} className="grid gap-1 border-t border-line pt-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 accent-[#7650D8]" aria-label={`Apply ${c.label} on ${it.title}`} checked={c.included && it.included} disabled={!editable} onChange={(e) => onSelect({ url: it.url, key: c.key, included: e.target.checked })} />
                  <span className="font-medium">{c.label}</span>
                  {c.problems.map((p) => <Badge key={p} tone="med">{p}</Badge>)}
                  {c.confidence === 'review' && <Badge tone="signal">Review wording</Badge>}
                  {c.result && <Badge tone={RESULT_TONE[c.result.status]}>{RESULT_LABEL[c.result.status]}</Badge>}
                </div>
                {c.key !== 'bodyHtml' ? (
                  <div className="grid gap-1 sm:grid-cols-2">
                    <p className="break-words text-ink-soft"><span className="text-muted">Now: </span>{c.current || <em className="text-faint">empty</em>}</p>
                    <p className="break-words text-ink"><span className="text-muted">New: </span>{c.proposed}</p>
                  </div>
                ) : <p className="text-ink-soft">Content HTML changed (text kept).</p>}
                <p className="text-muted">{c.reason}</p>
                {c.result?.message && <p className={c.result.status === 'verified' ? 'text-muted' : 'text-crit-ink'}>{c.result.message}</p>}
              </li>
            ))}
          </ul>
          {it.storefront?.note && <p className="mt-1 text-xs text-med-ink">{it.storefront.note}</p>}
        </div>
      </div>
    </li>
  );
}

function ManualList({ job }: { job: SeoBulkJob }) {
  const [open, setOpen] = useState(false);
  if (!job.manual.length) return null;
  const shown = open ? job.manual : job.manual.slice(0, 4);
  return (
    <section className="rounded-ctl border border-line p-3" data-testid="bulk-manual">
      <h3 className="font-semibold text-ink">Needs a person ({job.summary.manual})</h3>
      <p className="text-xs text-muted">Not changed by the bulk fix — unsupported, ambiguous or risky. Each says why.</p>
      <ul className="mt-2 space-y-2 text-xs">
        {shown.map((m, i) => (
          <li key={i} className="border-t border-line pt-2">
            <p className="font-medium text-ink">{m.reason}</p>
            <p className="text-ink-soft">{m.detail}{m.count > 1 ? ` · ${m.count} item(s)` : ''}{m.issueId && <> · <Link className="text-signal hover:underline" to={`/issues/${m.issueId}`}>{m.issueId}</Link></>}</p>
            {m.suggestion && <p className="text-ink-soft">Suggestion: “{m.suggestion}”</p>}
            {m.urls.length > 0 && <p className="break-all font-mono text-muted">{m.urls.slice(0, 3).map(shortUrl).join(' · ')}{m.urls.length > 3 ? ' …' : ''}</p>}
          </li>
        ))}
      </ul>
      {job.manual.length > 4 && <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Show fewer' : `Show all ${job.manual.length}`}</Button>}
    </section>
  );
}
