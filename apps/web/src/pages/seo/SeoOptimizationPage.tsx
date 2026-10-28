import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ExternalLink, Search, Wand2 } from 'lucide-react';
import { SEO_OPTIMIZATION_FIELDS, SEO_PROBLEM_LABELS, type SeoBulkStartInput, type SeoOptimizationField, type SeoOptimizationRow } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { DataTable } from '@/components/ui/DataTable';
import { Badge, Button, EmptyState, Input, LoadingBlock, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { ClearFilters, FilterSelect } from '@/components/ui/filters';
import { BulkFixDialog } from '@/components/seo/BulkFixDialog';
import { shortUrl } from '@/lib/format';

const PAGE_SIZE = 25;

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}
const TEMPLATES = [{ value: 'product', label: 'Products' }, { value: 'collection', label: 'Collections' }, { value: 'page', label: 'Pages' }, { value: 'blog_article', label: 'Blog articles' }, { value: 'home', label: 'Homepage' }, { value: 'other', label: 'Other' }];
const INTRO: Record<SeoOptimizationField, string> = {
  titles: 'The title tag of every page (the SEO title, or the title when none is set) as the storefront shows it, with what is wrong and a suggestion built from the page’s own content.',
  'meta-descriptions': 'The meta description of every page, with what is wrong and a suggestion taken from the page’s own description text.',
  h1: 'The H1 heading of every page and where it comes from. H1s printed by the theme are changed with a reviewed theme change in the SEO editor.',
  'image-alt': 'Pages with images that have no alt text. Shopify product, collection and article images are fixed here; images placed by the theme or inside content need a person.',
  tags: 'Product tags in Shopify: duplicates and blank tags are cleaned up. No tag is ever added.',
};

/**
 * SEO Optimization: one list per field (Titles, Meta descriptions, H1 headings, Image alt text, Tags) for the website
 * chosen in the header. Pages are read from the latest crawl on the server (paged — never the whole site in the
 * browser); select pages and fix them in bulk with a review step, or open one in the SEO editor.
 */
export default function SeoOptimizationPage() {
  const { field: raw } = useParams();
  const field = (raw ?? 'titles') as SeoOptimizationField;
  if (!SEO_OPTIMIZATION_FIELDS[field]) return <Navigate to="/optimize/titles" replace />;
  return <FieldList key={field} field={field} />;
}

function FieldList({ field }: { field: SeoOptimizationField }) {
  const meta = SEO_OPTIMIZATION_FIELDS[field];
  const { can } = useAuth();
  const canFix = can('shopify.edit');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 300);
  const [template, setTemplate] = useState('');
  const [problem, setProblem] = useState('needs_work');
  const [issue, setIssue] = useState('');
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fix, setFix] = useState<{ start: SeoBulkStartInput; title: string } | null>(null);
  const tags = field === 'tags';
  useEffect(() => { setPage(1); setCursors([undefined]); }, [q, template, problem, issue]);
  const query = { q: q || undefined, template: template || undefined, problem: problem || undefined, issue: (issue || undefined) as 'open' | 'none' | undefined, offset: tags ? 0 : (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, cursor: tags ? cursors[page - 1] : undefined };
  const res = useApiQuery(['seo-optimization', field, JSON.stringify(query)], () => api.getSeoOptimization(field, query));
  const d = res.data;
  const counts = d?.counts ?? {};
  const problemOptions = [
    { value: 'needs_work', label: `Needs work${counts.needs_work !== undefined ? ` (${counts.needs_work})` : ''}` },
    { value: 'good', label: `Good — keep${counts.good !== undefined ? ` (${counts.good})` : ''}` },
    ...Object.entries(SEO_PROBLEM_LABELS).filter(([k]) => counts[k]).map(([k, label]) => ({ value: k, label: `${label} (${counts[k]})` })),
  ];
  const rows = d?.rows ?? [];
  const toggle = (url: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(url); else n.delete(url); return n; });
  const pageEditable = rows.filter((r) => r.editable && r.assessment.verdict !== 'good');
  const allOnPage = pageEditable.length > 0 && pageEditable.every((r) => selected.has(r.url));
  const range = d?.guidelines && (field === 'titles' ? `${d.guidelines.titleMinChars}–${d.guidelines.titleMaxChars}` : field === 'meta-descriptions' ? `${d.guidelines.metaMinChars}–${d.guidelines.metaMaxChars}` : field === 'h1' ? `${d.guidelines.h1MinChars}–${d.guidelines.h1MaxChars}` : field === 'image-alt' ? `up to ${d.guidelines.altMaxChars}` : undefined);

  return (
    <div>
      <PageHeader
        title={meta.label}
        description={INTRO[field]}
        actions={canFix && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Wand2 className="h-4 w-4" />} disabled={!selected.size} onClick={() => setFix({ start: { scope: 'urls', urls: [...selected], fields: [meta.bulkField] }, title: `Fix ${meta.label.toLowerCase()} on ${selected.size} page${selected.size === 1 ? '' : 's'}` })}>
              Fix selected ({selected.size})
            </Button>
            {!tags && <Button variant="primary" icon={<Wand2 className="h-4 w-4" />} onClick={() => setFix({ start: { scope: 'pages', fields: [meta.bulkField], ...(d?.runId ? { runId: d.runId } : {}) }, title: `Fix all ${meta.label.toLowerCase()}` })}>Fix all that need work</Button>}
          </div>
        )}
      />
      {range && <p className="-mt-2 mb-3 text-xs text-muted">Recommended length: {range} characters — a little outside is only noted. Change it in <Link className="text-signal hover:underline" to="/settings/thresholds">Thresholds &amp; scoring</Link>.</p>}
      {d?.note && <div className="mb-3"><Notice tone="signal">{d.note}</Notice></div>}
      {res.error && <Notice tone="crit" title="The list could not be loaded">{errorMessage(res.error)}</Notice>}
      <Panel bodyClassName="p-3">
        <DataTable<SeoOptimizationRow>
          rows={rows}
          rowKey={(r) => r.url}
          caption={meta.label}
          server={tags ? undefined : { page, pageSize: PAGE_SIZE, total: d?.total ?? 0, onPage: setPage }}
          pageSize={PAGE_SIZE}
          toolbar={
            <>
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
                <Input aria-label="Search URL or title" placeholder="Search URL or title" value={text} onChange={(e) => setText(e.target.value)} className="pl-8" />
              </div>
              {!tags && <FilterSelect label="Page type" value={template} onChange={setTemplate} options={TEMPLATES} />}
              <FilterSelect label="Value" allLabel="All" value={problem} onChange={setProblem} options={problemOptions} />
              {!tags && <FilterSelect label="Issue" value={issue} onChange={setIssue} options={[{ value: 'open', label: 'Has an open issue' }, { value: 'none', label: 'No open issue' }]} />}
              <ClearFilters show={!!(text || template || problem !== 'needs_work' || issue)} onClear={() => { setText(''); setTemplate(''); setProblem('needs_work'); setIssue(''); }} />
              {res.isFetching && <span className="text-xs text-muted">Loading…</span>}
            </>
          }
          empty={res.isLoading ? <LoadingBlock rows={6} /> : <EmptyState title={problem === 'needs_work' ? 'Nothing needs work here' : 'No pages match'} description={problem === 'needs_work' ? 'Every page’s value is fine for these filters.' : 'Clear the filters or search.'} />}
          columns={[
            {
              key: 'sel', width: '36px',
              header: canFix ? <input type="checkbox" className="h-4 w-4 accent-[#7650D8]" aria-label="Select all on this page" checked={allOnPage} disabled={!pageEditable.length} onChange={(e) => setSelected((s) => { const n = new Set(s); for (const r of pageEditable) { if (e.target.checked) n.add(r.url); else n.delete(r.url); } return n; })} /> : '',
              cell: (r) => canFix ? <input type="checkbox" className="h-4 w-4 accent-[#7650D8]" aria-label={`Select ${r.title || r.url}`} checked={selected.has(r.url)} disabled={!r.editable} title={r.manualReason} onChange={(e) => toggle(r.url, e.target.checked)} /> : null,
            },
            {
              key: 'page', header: 'Page', cell: (r) => (
                <div className="min-w-[180px] max-w-[300px]">
                  <span className="block truncate font-medium text-ink" title={r.title}>{r.title || '—'}</span>
                  <a href={r.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-signal hover:underline">{shortUrl(r.url)}<ExternalLink className="h-3 w-3 shrink-0" aria-hidden /></a>
                  <span className="ml-1 text-xs text-muted">{r.pageType}</span>
                  {/* Phones: the current value and its problems sit under the page (those columns are hidden). */}
                  <div className="mt-1 space-y-1 md:hidden">
                    <p className="break-words text-xs text-ink-soft">{r.current || <em className="text-faint">empty</em>}</p>
                    <div className="flex flex-wrap gap-1">{r.assessment.verdict === 'good' ? <Badge tone="ok">Good</Badge> : r.assessment.problems.filter((p) => p.severity !== 'note').map((p) => <Badge key={p.code} tone={p.severity === 'fix' ? 'crit' : 'med'}>{SEO_PROBLEM_LABELS[p.code]}</Badge>)}</div>
                  </div>
                </div>
              ),
            },
            {
              key: 'cur', header: 'Current', hideOnMobile: true, cell: (r) => (
                <div className="min-w-[180px] max-w-[320px] text-xs">
                  <p className="break-words text-ink">{r.current || <em className="text-faint">empty</em>}</p>
                  {r.detail && <p className="whitespace-pre-line break-all text-muted">{r.detail}</p>}
                </div>
              ),
            },
            {
              key: 'prob', header: 'Assessment', hideOnMobile: true, cell: (r) => (
                <div className="flex max-w-[220px] flex-wrap gap-1">
                  {r.assessment.verdict === 'good' && <Badge tone="ok">Good</Badge>}
                  {r.assessment.problems.map((p) => <Badge key={p.code} tone={p.severity === 'fix' ? 'crit' : p.severity === 'improve' ? 'med' : 'neutral'} title={p.message}>{SEO_PROBLEM_LABELS[p.code]}</Badge>)}
                  {r.issueIds.length > 0 && <Link to={`/issues/${r.issueIds[0]}`} className="text-xs text-signal hover:underline">{r.issueIds.length} open issue{r.issueIds.length === 1 ? '' : 's'}</Link>}
                </div>
              ),
            },
            {
              key: 'sug', header: 'Suggestion', cell: (r) => (
                <div className="min-w-[160px] max-w-[340px] text-xs">
                  {!r.editable ? <p className="text-muted">{r.manualReason}</p>
                    : r.suggestion === undefined ? <span className="text-faint">…</span>
                      : r.suggestion === null ? <p className="text-muted">{r.suggestionNote ?? 'No suggestion.'}</p>
                        : r.suggestion.keep ? <p className="text-ok-ink">Keep — {r.suggestion.reason.replace(/^Already good — keep it\.$/, 'already good.')}</p>
                          : (
                            <>
                              <p className="break-words font-medium text-ink">{r.suggestion.value || <em className="text-faint">—</em>}{r.suggestion.confidence === 'review' && <Badge tone="signal" className="ml-1">review wording</Badge>}</p>
                              <p className="text-muted">{r.suggestion.reason}</p>
                              {r.suggestionNote && <p className="text-muted">{r.suggestionNote}</p>}
                            </>
                          )}
                </div>
              ),
            },
            { key: 'open', header: '', hideOnMobile: true, cell: (r) => (r.editable && canFix ? <Link to={`/seo-editor?url=${encodeURIComponent(r.url)}`} className="whitespace-nowrap text-xs font-medium text-signal hover:underline">Open in editor</Link> : null) },
          ]}
        />
        {tags && (cursors[page] || page > 1 || d?.nextCursor) && (
          <div className="mt-2 flex items-center justify-end gap-2 text-xs">
            <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span className="text-muted">Page {page}</span>
            <Button size="sm" variant="ghost" disabled={!d?.nextCursor} onClick={() => { setCursors((c) => { const n = [...c]; n[page] = d!.nextCursor; return n; }); setPage((p) => p + 1); }}>Next</Button>
          </div>
        )}
      </Panel>
      {fix && <BulkFixDialog title={fix.title} start={fix.start} onClose={() => { setFix(null); setSelected(new Set()); void res.refetch(); }} />}
    </div>
  );
}
