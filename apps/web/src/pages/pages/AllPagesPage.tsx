import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, ListChecks, Wand2 } from 'lucide-react';
import { PAGE_AUDIT_AREA_LABELS, PAGE_AUDIT_TODO, type CrawlRun, type SeoBulkStartInput } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { BulkFixDialog } from '@/components/seo/BulkFixDialog';
import { api } from '@/api/client';
import { errorMessage, useApiQuery } from '@/api/hooks';
import { Button, EmptyState, Field, LoadingBlock, Notice, PageHeader, Panel, Select } from '@/components/ui/primitives';
import { PageResults } from '@/components/crawls/PageResults';
import { ScoreBadge } from '@/components/crawls/PageAudit';
import { saveFile } from '@/components/crawls/LiveCrawl';
import { useToast } from '@/components/ui/Toast';
import { fmtDateTime, fmtNum } from '@/lib/format';

const TEMPLATE_LABELS: Record<string, string> = { product: 'Products', collection: 'Collections', page: 'Pages', blog_article: 'Blog articles', blog_index: 'Blog index', home: 'Homepage', search: 'Search', other: 'Other' };

const BANDS: { id: 'poor' | 'fair' | 'good' | 'none'; label: string; hint: string; cls: string }[] = [
  { id: 'poor', label: 'Poor', hint: 'score under 50', cls: 'text-crit-ink' },
  { id: 'fair', label: 'Fair', hint: '50 – 79', cls: 'text-med-ink' },
  { id: 'good', label: 'Good', hint: '80 and above', cls: 'text-ok-ink' },
  { id: 'none', label: 'Not scored', hint: 'redirects, errors without HTML, files, URLs not fetched', cls: 'text-muted' },
];

/** Finished crawls whose pages can be listed: newest first, live crawls before simulated ones. */
function pickable(runs: CrawlRun[]): CrawlRun[] {
  return runs
    .filter((r) => (r.status === 'completed' || r.status === 'cancelled') && r.type !== 'reverify' && r.urlsCrawled > 0)
    .sort((a, b) => Number(b.source === 'live') - Number(a.source === 'live') || (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}

/**
 * All Pages: every URL of one crawl with its page audit score, a to-do list of the failing checks across the site,
 * and a full report per page.
 */
export default function AllPagesPage() {
  const [params, setParams] = useSearchParams();
  const runs = useApiQuery(['crawls'], () => api.listCrawls());
  const list = useMemo(() => pickable(runs.data ?? []), [runs.data]);
  const runId = params.get('run') || list[0]?.id || '';
  const run = list.find((r) => r.id === runId);
  const check = params.get('check') ?? '';
  const score = params.get('score') ?? '';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const summary = useApiQuery(['crawlPages', runId, 'summary'], () => api.getCrawlPages(runId, { offset: 0, limit: 1 }), { enabled: !!runId });
  const f = summary.data?.facets;
  const toast = useToast();
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const exportAs = async (format: 'csv' | 'json') => {
    setBusy(format);
    try { saveFile(await api.exportCrawl(runId, format)); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  };
  const sum = summary.data?.scoreSummary;
  const templates = Object.entries(sum?.byTemplate ?? {}).sort((a, b) => b[1].pages - a[1].pages);
  const canFix = useAuth().can('shopify.edit');
  const [fix, setFix] = useState<{ start: SeoBulkStartInput; title: string } | null>(null);
  const live = run?.source === 'live';
  const todo = PAGE_AUDIT_TODO.map((t) => ({ ...t, n: f?.check?.[t.id] ?? 0 })).filter((t) => t.n > 0).sort((a, b) => b.n - a.n);

  return (
    <div>
      <PageHeader
        title="All pages"
        description="Every page of a crawl with its audit score: title, meta description, headings, canonical, indexability, links and image ALT text, each with what to change."
        actions={list.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
          {canFix && live && <Button variant="primary" icon={<Wand2 className="h-4 w-4" />} onClick={() => setFix({ start: { scope: 'pages', runId }, title: 'Fix all SEO issues' })} title="Find SEO problems on every page of this crawl and prepare fixes — you review them before anything is written">Fix all SEO issues</Button>}
          <Button variant="secondary" icon={<Download className="h-4 w-4" />} disabled={!runId || !!busy} onClick={() => void exportAs('csv')} title="Every URL with its audit score and the checks to fix">{busy === 'csv' ? 'Exporting…' : 'Export CSV'}</Button>
          <Field label="Crawl" htmlFor="pages-run">
            <Select id="pages-run" value={runId} onChange={(e) => { const p = new URLSearchParams(); p.set('run', e.target.value); setParams(p, { replace: true }); }}>
              {list.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.type} · {r.startedAt ? fmtDateTime(r.startedAt) : '—'}{r.source !== 'live' ? ' (sample)' : ''}</option>)}
            </Select>
          </Field>
          </div>
        )}
      />
      {runs.isLoading ? <LoadingBlock rows={5} /> : runs.error ? <Notice tone="crit" title="Crawls could not be loaded">{errorMessage(runs.error)}</Notice> : !run ? (
        <Panel>
          <EmptyState icon={<ListChecks className="h-8 w-8" />} title="No finished crawl yet" description="Run a crawl in the Crawl Center; its pages are listed and audited here when it finishes." action={<Link to="/crawls" className="text-sm font-medium text-signal hover:underline">Open the Crawl Center</Link>} />
        </Panel>
      ) : (
        <div className="space-y-5">
          {run.source !== 'live' && <Notice tone="caution">This crawl is sample data: pages carry only the fields the sample recorded, so many checks cannot be judged.</Notice>}
          {summary.error && <Notice tone="crit" title="Pages could not be loaded">{errorMessage(summary.error)}</Notice>}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Panel title="Page scores" subtitle={summary.data ? `${fmtNum(summary.data.total)} URLs in ${run.id}. Each page starts at 100: −15 per problem to fix, −5 per improvement.` : undefined}>
              {!f ? <LoadingBlock rows={2} /> : (
                <>
                {sum && (
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <ScoreBadge score={sum.average} large />
                    <div className="min-w-0 text-sm">
                      <p className="font-medium text-ink">Site average</p>
                      <p className="text-muted">{sum.scored ? `over ${fmtNum(sum.scored)} scored pages` : 'no page could be scored'}</p>
                    </div>
                    {templates.length > 1 && (
                      <ul className="flex basis-full flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
                        {templates.map(([t, v]) => <li key={t}><span className="text-muted">{TEMPLATE_LABELS[t] ?? t}</span> <span className="font-semibold tabular-nums text-ink">{v.average}</span> <span className="text-faint">· {fmtNum(v.pages)}</span></li>)}
                      </ul>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {BANDS.map((b) => {
                    const on = score === b.id;
                    return (
                      <button key={b.id} type="button" aria-pressed={on} onClick={() => set('score', on ? '' : b.id)}
                        className={`rounded-ctl border px-3 py-2.5 text-left transition-colors ${on ? 'border-signal bg-signal/5' : 'border-line hover:border-signal/50'}`}>
                        <span className={`block text-2xl font-semibold tabular-nums ${b.cls}`}>{fmtNum(f.score?.[b.id] ?? 0)}</span>
                        <span className="block text-sm font-medium text-ink">{b.label}</span>
                        <span className="block text-xs text-muted">{b.hint}</span>
                      </button>
                    );
                  })}
                </div>
                </>
              )}
            </Panel>
            <Panel title="To do" subtitle="Checks that fail or need work, by number of pages. Select one to list those pages.">
              {!f ? <LoadingBlock rows={4} /> : !todo.length ? <p className="text-sm text-ok-ink">No page of this crawl fails a check.</p> : (
                <ul className="max-h-72 divide-y divide-line overflow-y-auto">
                  {todo.map((t) => {
                    const on = check === t.id;
                    return (
                      <li key={t.id}>
                        <button type="button" aria-pressed={on} onClick={() => set('check', on ? '' : t.id)}
                          className={`flex w-full items-center gap-3 px-2 py-1.5 text-left text-sm ${on ? 'bg-signal/5 font-medium text-signal-dark' : 'hover:bg-canvas'}`}>
                          <span className="min-w-0 flex-1 truncate">{t.label}</span>
                          <span className="text-xs text-muted">{PAGE_AUDIT_AREA_LABELS[t.area]}</span>
                          <span className="w-14 text-right tabular-nums">{fmtNum(t.n)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </div>
          <PageResults key={run.id} runId={run.id} check={check} onCheck={(v) => set('check', v)} scoreBand={score} onScoreBand={(v) => set('score', v)}
            onFixPages={canFix && live ? (filter, n) => setFix({ start: { scope: 'pages', runId: run.id, ...(Object.keys(filter).some((k) => filter[k as keyof typeof filter]) ? { filter } : {}) }, title: Object.keys(filter).some((k) => filter[k as keyof typeof filter]) ? `Fix SEO issues on the ${n} listed page${n === 1 ? '' : 's'}` : 'Fix all SEO issues' }) : undefined} />
        </div>
      )}
      {fix && <BulkFixDialog title={fix.title} start={fix.start} onClose={() => setFix(null)} />}
    </div>
  );
}
