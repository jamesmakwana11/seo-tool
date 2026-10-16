import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, Download, ExternalLink, GitCompareArrows, HardDrive, Search } from 'lucide-react';
import {
  ApiError, CHANGE_FIELD_LABELS, CHANGE_FIELDS, CHANGE_KINDS,
  type ChangeConfidence, type ChangeField, type ChangeKind, type ChangeListQuery, type ChangeRecord, type ChangeRunSummary, type ChangeDetail,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, EmptyState, Input, KV, LoadingBlock, Notice, Panel } from '@/components/ui/primitives';
import { Drawer } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect } from '@/components/ui/filters';
import { useToast } from '@/components/ui/Toast';
import { SeverityBadge } from '@/components/domain/badges';
import { saveFile } from './LiveCrawl';
import { fmtDateTime, fmtNum, fmtRelative, shortUrl } from '@/lib/format';

export const KIND_LABELS: Record<ChangeKind, string> = { changed: 'Changed', new: 'New', removed: 'Removed', failed: 'Failed', unchecked: 'Unchecked', unchanged: 'Unchanged' };
const KIND_TONE: Record<ChangeKind, 'signal' | 'ok' | 'crit' | 'med' | 'neutral'> = { changed: 'signal', new: 'ok', removed: 'crit', failed: 'med', unchecked: 'neutral', unchanged: 'neutral' };
const KIND_HELP: Record<ChangeKind, string> = {
  changed: 'Fetched in both crawls; at least one SEO field differs.',
  new: 'Not in the baseline.',
  removed: 'Answered 404 / 410 now (confirmed), or a complete full crawl no longer found it (suspected).',
  failed: 'Did not answer usefully this time (5xx, 429, timeout). Never counted as removed.',
  unchecked: 'In the baseline but not fetched by this crawl.',
  unchanged: 'Fetched in both crawls with the same SEO fields.',
};
const EFFECT_LABELS: Record<ChangeRunSummary['baselineEffect'], string> = { created: 'Became the baseline', replaced: 'Replaced the baseline', merged: 'Updated baseline pages', kept: 'Baseline kept' };
const PAGE_SIZE = 50;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function KindBadge({ r }: { r: Pick<ChangeRecord, 'kind' | 'confidence'> }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={KIND_TONE[r.kind]} title={KIND_HELP[r.kind]}>{KIND_LABELS[r.kind]}</Badge>
      {r.confidence === 'suspected' && r.kind !== 'unchecked' && <Badge tone="med" title="The evidence is incomplete: check this one by hand.">Suspected</Badge>}
    </span>
  );
}

const mb = (b: number) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

/** Crawl Center: the baseline, what the last crawls changed, and where the history is kept. */
export function ChangeMonitorPanel() {
  const st = useApiQuery(['changes', 'status'], () => api.getChangeStatus());
  const s = st.data;
  return (
    <Panel
      title="Change Monitor"
      subtitle="Each crawl is compared with the baseline — the last valid crawl. Partial and cancelled crawls are compared but never replace it."
      actions={<Link to="/crawls/compare" className="inline-flex h-8 items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-2.5 text-[13px] font-medium shadow-card hover:border-signal/40 hover:text-signal-dark"><GitCompareArrows className="h-3.5 w-3.5" /> Compare page versions</Link>}
    >
      {st.isLoading && <LoadingBlock rows={3} />}
      {st.error && <Notice tone="crit">{errorMessage(st.error)}</Notice>}
      {s && (
        <div className="mt-3 space-y-4">
          {!s.enabled && <Notice tone="med">{s.persistentHint}</Notice>}
          {s.enabled && (
            <>
              <KV cols={3} items={[
                { k: 'Baseline', v: s.baseline ? <span><Link className="text-signal hover:underline" to={`/crawls/${s.baseline.runId}`}>{s.baseline.runId}</Link> · {s.baseline.crawlType} crawl of {fmtDateTime(s.baseline.observedAt)}{s.baseline.mergedFrom.length ? ` + ${s.baseline.mergedFrom.length} smart crawl(s)` : ''}</span> : <span className="text-muted">None yet — the next completed crawl becomes the baseline.</span> },
                { k: 'URLs in the baseline', v: s.baseline ? fmtNum(s.baseline.urls) : '—' },
                { k: 'Kept on disk', v: `${s.runs.length} crawl(s), ${mb(s.diskBytes)} · keeps ${s.retention.keepRuns} crawls / ${s.retention.maxAgeDays} days` },
              ]} />
              <p className="flex items-start gap-2 text-xs text-muted"><HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" />{s.persistentHint}</p>
              {s.runs.length ? (
                <DataTable
                  rows={s.runs.slice(0, 8)}
                  rowKey={(r) => r.snapshotId}
                  dense
                  caption="Recorded crawls"
                  columns={[
                    { key: 'run', header: 'Crawl', cell: (r) => <Link to={`/crawls/${r.runId}?tab=changes`} className="font-mono text-xs text-signal hover:underline">{r.runId}</Link> },
                    { key: 'when', header: 'Observed', cell: (r) => <span className="whitespace-nowrap text-xs" title={fmtDateTime(r.observedAt)}>{fmtRelative(r.observedAt)}</span> },
                    { key: 'type', header: 'Crawl', hideOnMobile: true, cell: (r) => <span className="text-xs">{r.crawlType} · {r.outcome.replace('_', ' ')}</span> },
                    {
                      key: 'counts', header: 'Compared with the baseline', cell: (r) => (r.counts ? (
                        <span className="flex flex-wrap gap-1">
                          {(['changed', 'new', 'removed', 'failed'] as ChangeKind[]).filter((k) => r.counts![k]).map((k) => <Badge key={k} tone={KIND_TONE[k]}>{fmtNum(r.counts![k])} {KIND_LABELS[k].toLowerCase()}</Badge>)}
                          {!r.counts.changed && !r.counts.new && !r.counts.removed && !r.counts.failed && <span className="text-xs text-muted">No change</span>}
                        </span>
                      ) : <span className="text-xs text-muted">{r.notes[0] ?? 'Not compared'}</span>),
                    },
                    { key: 'effect', header: 'Baseline', hideOnMobile: true, cell: (r) => <span className="text-xs" title={r.baselineNote}>{EFFECT_LABELS[r.baselineEffect]}</span> },
                  ]}
                />
              ) : <p className="text-sm text-muted">No crawl recorded yet. Run a crawl: the first completed crawl becomes the baseline and the next one shows what changed.</p>}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Crawl run page: every URL of this crawl compared with the baseline, filtered and paged on the server. */
export function ChangesTab({ runId, active }: { runId: string; active?: boolean }) {
  const [waiting, setWaiting] = useState(false);
  const sum = useApiQuery(['changes', 'summary', runId], () => api.getChangeSummary(runId), { refetchInterval: active || waiting ? 3000 : undefined });
  const comparing = sum.error instanceof ApiError && sum.error.code === 'COMPARING';
  useEffect(() => setWaiting(comparing || (!!active && !!sum.error)), [comparing, active, sum.error]);
  const [kind, setKind] = useState<ChangeKind | 'all'>('changed');
  const [field, setField] = useState('');
  const [confidence, setConfidence] = useState('');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ChangeRecord | null>(null);
  useEffect(() => setPage(1), [kind, field, confidence, q]);
  const s = sum.data;
  useEffect(() => { if (s?.counts && !s.counts.changed && kind === 'changed') setKind('all'); }, [s, kind]);
  const query: ChangeListQuery = { kind, field: (field || undefined) as ChangeField | undefined, confidence: (confidence || undefined) as ChangeConfidence | undefined, q: q || undefined, page, pageSize: PAGE_SIZE };
  const list = useApiQuery(['changes', 'list', runId, JSON.stringify(query)], () => api.listChanges(runId, query), { enabled: !!s?.counts });
  const urls = (list.data?.items ?? []).map((r) => r.url);
  const issues = useApiQuery(['changes', 'issues', runId, urls.join('|')], () => api.getChangeIssues(urls), { enabled: urls.length > 0 });
  const toast = useToast();
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const exp = async (format: 'csv' | 'json') => {
    setBusy(format);
    try { saveFile(await api.exportChanges(runId, format, { ...query, page: undefined, pageSize: undefined })); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };

  if (sum.isLoading) return <Panel><LoadingBlock rows={5} /></Panel>;
  if (comparing) return <Panel><EmptyState title="Comparing with the baseline…" description="The crawl has finished; its URLs are being compared with the baseline. This page updates by itself." /></Panel>;
  if (sum.error) {
    const missing = sum.error instanceof ApiError && sum.error.status === 404;
    return (
      <Panel>
        <EmptyState
          title={missing ? (active ? 'Changes appear when the crawl finishes' : 'No change data for this crawl') : 'Changes could not load'}
          description={missing ? (active ? 'The crawl is compared with the baseline as soon as it finishes.' : 'Re-verification crawls are not compared, and change history kept in a temporary folder is lost when the server restarts. Older crawls may also have been removed by retention.') : errorMessage(sum.error)}
        />
      </Panel>
    );
  }
  if (!s) return null;
  const c = s.counts;
  const keyOf = (u: string) => { try { const x = new URL(u); x.hash = ''; let v = x.toString(); if (x.pathname !== '/' && v.endsWith('/') && !x.search) v = v.slice(0, -1); return v; } catch { return u; } };
  const filtered = kind !== 'all' || !!field || !!confidence || !!q;

  return (
    <div className="space-y-5">
      <Panel title="Compared with the baseline" subtitle={s.baseline ? `Baseline: ${s.baseline.crawlType} crawl ${s.baseline.runId} of ${fmtDateTime(s.baseline.observedAt)} (${fmtNum(s.baseline.urls)} URLs). This crawl: ${fmtDateTime(s.observedAt)} (${fmtNum(s.urls)} URLs).` : 'There was no baseline to compare with.'}>
        <div className="mt-3 space-y-3">
          {c ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {CHANGE_KINDS.map((k) => (
                <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k} title={KIND_HELP[k]}
                  className={`rounded-ctl border px-3 py-2 text-left transition-colors ${kind === k ? 'border-signal/50 bg-signal-tint' : 'border-line bg-surface hover:border-signal/30'}`}>
                  <span className="block text-xs text-muted">{KIND_LABELS[k]}</span>
                  <span className="block text-lg font-semibold tabular-nums text-ink">{fmtNum(c[k])}</span>
                </button>
              ))}
            </div>
          ) : null}
          <Notice tone={s.baselineEffect === 'kept' && s.outcome !== 'completed' ? 'med' : 'neutral'} title={EFFECT_LABELS[s.baselineEffect]}>{s.baselineNote}</Notice>
          {s.notes.map((n) => <p key={n} className="text-xs text-muted">{n}</p>)}
          {c?.suspected ? <p className="text-xs text-med-ink">{fmtNum(c.suspected)} change(s) are marked suspected: the evidence is incomplete (a page cut at the size limit, or a URL no longer found rather than answering 404).</p> : null}
        </div>
      </Panel>

      {c && (
        <Panel title="URLs" subtitle="Select a row for the old and new values, the evidence and the open issues on that page." bodyClassName="p-3"
          actions={<div className="flex gap-2"><Button size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'csv'} onClick={() => exp('csv')}>Export CSV</Button><Button size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'json'} onClick={() => exp('json')}>Export JSON</Button></div>}>
          {list.error && <Notice tone="crit">{errorMessage(list.error)}</Notice>}
          <DataTable
            rows={list.data?.items ?? []}
            rowKey={(r) => r.url}
            dense
            onRowClick={setOpen}
            caption="Change records"
            server={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPage: setPage }}
            toolbar={
              <>
                <div className="relative w-full max-w-xs">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
                  <Input aria-label="Search URL or values" placeholder="Search URL or old / new values" value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
                </div>
                <FilterSelect label="Type" value={kind === 'all' ? '' : kind} onChange={(v) => setKind((v || 'all') as ChangeKind | 'all')} options={CHANGE_KINDS.map((k) => ({ value: k, label: `${KIND_LABELS[k]} (${fmtNum(c[k])})` }))} />
                <FilterSelect label="Field" value={field} onChange={setField} options={CHANGE_FIELDS.filter((f) => c.byField[f]).map((f) => ({ value: f, label: `${CHANGE_FIELD_LABELS[f]} (${fmtNum(c.byField[f] ?? 0)})` }))} />
                <FilterSelect label="Evidence" value={confidence} onChange={setConfidence} options={[{ value: 'confirmed', label: 'Confirmed' }, { value: 'suspected', label: 'Suspected' }]} />
                <ClearFilters show={filtered} onClear={() => { setKind('all'); setField(''); setConfidence(''); setText(''); }} />
                {list.isFetching && <span className="text-xs text-muted">Loading…</span>}
              </>
            }
            empty={list.isLoading ? <LoadingBlock rows={5} /> : <EmptyState title={filtered ? 'No URL matches these filters' : 'No URLs'} description={filtered ? 'Choose another type or clear the filters.' : undefined} />}
            columns={[
              { key: 'url', header: 'URL', cell: (r) => <span className="block max-w-[380px] truncate font-mono text-xs text-ink-soft" title={r.url}>{shortUrl(r.url)}</span> },
              { key: 'kind', header: 'Change', cell: (r) => <KindBadge r={r} /> },
              {
                key: 'fields', header: 'What changed', cell: (r) => (r.fields.length ? (
                  <span className="flex max-w-[300px] flex-wrap gap-1">{r.fields.map((f) => <span key={f.field} className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-soft">{CHANGE_FIELD_LABELS[f.field]}</span>)}</span>
                ) : <span className="text-xs text-faint">—</span>),
              },
              { key: 'status', header: 'Status (before → now)', hideOnMobile: true, cell: (r) => <span className="text-xs tabular-nums">{r.baselineStatus ?? '—'} → {r.status ?? '—'}</span> },
              {
                key: 'issues', header: 'Open issues', hideOnMobile: true, cell: (r) => {
                  const list = issues.data?.[keyOf(r.url)] ?? [];
                  return list.length ? <span className="inline-flex items-center gap-1"><SeverityBadge severity={list[0].severity as 'critical' | 'medium' | 'low'} /><span className="text-xs tabular-nums">{list.length}</span></span> : <span className="text-xs text-faint">{issues.isLoading ? '…' : '0'}</span>;
                },
              },
            ]}
          />
        </Panel>
      )}
      <ChangeDrawer runId={runId} rec={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function ChangeDrawer({ runId, rec, onClose }: { runId: string; rec: ChangeRecord | null; onClose: () => void }) {
  const d = useApiQuery(['changes', 'detail', runId, rec?.url ?? ''], () => api.getChange(runId, rec!.url), { enabled: !!rec });
  const { can } = useAuth();
  const capture = useApiMutation((url: string) => api.requestCaptures({ urls: [url], viewports: ['desktop', 'mobile'] }), {
    success: 'Screenshots queued — open the comparison to follow them',
    invalidate: [['captures']],
  });
  if (!rec) return null;
  const x: ChangeDetail | ChangeRecord = d.data ?? rec;
  return (
    <Drawer open={!!rec} onClose={onClose} title="URL change" width="lg"
      footer={
        <>
          {can('crawls.run') && <Button icon={<Camera className="h-4 w-4" />} loading={capture.isPending} onClick={() => capture.mutate(rec.url)}>Capture screenshots</Button>}
          <Link to={`/crawls/compare?url=${encodeURIComponent(rec.url)}`} className="inline-flex h-9 items-center gap-1.5 rounded-ctl bg-signal px-3.5 text-sm font-semibold text-on-signal hover:bg-signal-dark"><GitCompareArrows className="h-4 w-4" /> Compare versions</Link>
        </>
      }>
      <div className="space-y-4">
        <div>
          <a href={x.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all font-mono text-xs text-signal hover:underline">{x.url}<ExternalLink className="h-3 w-3 shrink-0" /></a>
          <div className="mt-2"><KindBadge r={x} /></div>
        </div>
        <Notice tone={x.kind === 'removed' || x.kind === 'failed' ? 'med' : 'neutral'} title="Evidence">{x.evidence}</Notice>
        <KV cols={2} items={[
          { k: 'Observed in this crawl', v: `${fmtDateTime(x.observedAt)} · ${x.status ?? '—'}` },
          { k: 'Baseline observation', v: x.baselineObservedAt ? `${fmtDateTime(x.baselineObservedAt)} · ${x.baselineStatus ?? '—'}${x.baselineRunId ? ` (${x.baselineRunId})` : ''}` : 'Not in the baseline' },
        ]} />
        {x.fields.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Old and new values</h3>
            {x.fields.map((f) => (
              <div key={f.field} className="rounded-ctl border border-line p-3">
                <div className="mb-2 flex items-center gap-2"><span className="text-sm font-medium">{CHANGE_FIELD_LABELS[f.field]}</span>{f.confidence === 'suspected' && <Badge tone="med">Suspected</Badge>}</div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="rounded border border-crit/20 bg-crit-tint/50 p-2"><p className="text-[11px] font-medium text-crit-ink">Before</p><p className="mt-0.5 break-words text-[13px] text-ink-soft">{f.old ?? '—'}</p></div>
                  <div className="rounded border border-ok/20 bg-ok-tint/50 p-2"><p className="text-[11px] font-medium text-ok-ink">Now</p><p className="mt-0.5 break-words text-[13px] text-ink-soft">{f.new ?? '—'}</p></div>
                </div>
                {!!f.added?.length && <p className="mt-2 break-words text-xs text-ok-ink"><span className="font-medium">Added:</span> {f.added.join(' · ')}</p>}
                {!!f.removed?.length && <p className="mt-1 break-words text-xs text-crit-ink"><span className="font-medium">Removed:</span> {f.removed.join(' · ')}</p>}
                {f.note && <p className="mt-1 text-xs text-muted">{f.note}</p>}
              </div>
            ))}
          </div>
        )}
        <div>
          <h3 className="mb-2 text-sm font-semibold">Open issues on this page</h3>
          {d.isLoading ? <LoadingBlock rows={2} /> : d.error ? <Notice tone="crit">{errorMessage(d.error)}</Notice> : (d.data?.issues.length ? (
            <ul className="divide-y divide-line rounded-ctl border border-line">
              {d.data.issues.map((i) => (
                <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <SeverityBadge severity={i.severity as 'critical' | 'medium' | 'low'} />
                  <Link to={`/issues/${i.id}`} className="min-w-0 flex-1 truncate text-signal hover:underline">{i.title}</Link>
                  <span className="font-mono text-[11px] text-muted">{i.checkId}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No open issue lists this URL.</p>)}
        </div>
      </div>
    </Drawer>
  );
}
