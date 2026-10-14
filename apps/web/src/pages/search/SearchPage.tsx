import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, BookOpen, FileText, LayoutGrid, ListChecks, Search, User, type LucideIcon } from 'lucide-react';
import type { SearchResult } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Button, DemoBadge, EmptyState, Input, PageHeader, Panel } from '@/components/ui/primitives';

const KIND_ORDER: SearchResult['kind'][] = ['screen', 'issue', 'page', 'employee', 'check', 'brief'];
const KIND: Record<SearchResult['kind'], { label: string; icon: LucideIcon }> = {
  screen: { label: 'Screens', icon: LayoutGrid },
  issue: { label: 'Issues', icon: AlertCircle },
  page: { label: 'Site pages', icon: FileText },
  employee: { label: 'People', icon: User },
  check: { label: 'Checks', icon: ListChecks },
  brief: { label: 'Content briefs', icon: BookOpen },
};

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const res = useApiQuery(['search', q], () => api.search(q), { enabled: q.length >= 2 });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    const next = new URLSearchParams(params);
    if (v) next.set('q', v);
    else next.delete('q');
    setParams(next);
  };

  return (
    <div>
      <PageHeader title="Search" description="Screens, issues, site pages, people, checks and content briefs for the selected website." meta={<DemoBadge />} />
      <form onSubmit={submit} role="search" className="mb-5 flex max-w-2xl gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" aria-hidden />
          <label htmlFor="search-q" className="sr-only">Search Sentinel</label>
          <Input id="search-q" type="search" className="pl-8" placeholder="e.g. noindex, ISS-0012, kitchen tools, Ritesh" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        </div>
        <Button type="submit" variant="primary">Search</Button>
      </form>

      {q.length < 2 ? (
        <Panel><EmptyState icon={<Search className="h-7 w-7" />} title="Type at least 2 characters" description="Search by issue ID, check name, page URL or title, screen name or a colleague’s name." /></Panel>
      ) : (
        <Async q={res} rows={6}>
          {(items) => <Results q={q} items={items} />}
        </Async>
      )}
    </div>
  );
}

function Results({ q, items }: { q: string; items: SearchResult[] }) {
  if (!items.length) {
    return <Panel><EmptyState title={`No results for “${q}”`} description="Try an ID like ISS-0001 or TSK-0001, a check name (e.g. canonical), or part of a URL such as /collections/." /></Panel>;
  }
  const groups = KIND_ORDER.map((k) => ({ kind: k, items: items.filter((r) => r.kind === k) })).filter((g) => g.items.length);
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted" aria-live="polite">
        {items.length} result{items.length === 1 ? '' : 's'} for “{q}”{items.length >= 40 && ' — showing the first 40; refine your search to narrow down.'}
      </p>
      <nav aria-label="Jump to result group" className="flex flex-wrap gap-1.5">
        {groups.map((g) => <a key={g.kind} href={`#results-${g.kind}`} className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-xs text-ink-soft hover:border-muted/50">{KIND[g.kind].label} <span className="tabular-nums text-muted">{g.items.length}</span></a>)}
      </nav>
      {groups.map((g) => {
        const Icon = KIND[g.kind].icon;
        return (
          <section key={g.kind} id={`results-${g.kind}`} className="scroll-mt-24">
            <Panel title={<span className="flex items-center gap-2"><Icon className="h-4 w-4 text-muted" aria-hidden />{KIND[g.kind].label}<span className="rounded-full bg-raised px-1.5 text-xs font-normal tabular-nums text-muted">{g.items.length}</span></span>} bodyClassName="p-0">
              <ul className="divide-y divide-line">
                {g.items.map((r) => (
                  <li key={`${r.kind}-${r.id}`}>
                    <Link to={r.href} className="flex flex-col gap-0.5 px-4 py-2.5 hover:bg-raised sm:flex-row sm:items-center sm:gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{r.title}</span>
                      {r.subtitle && <span className={`truncate text-xs text-muted ${r.kind === 'page' || r.kind === 'issue' ? 'font-mono' : ''}`}>{r.kind === 'page' ? `${r.id.replace(/^https?:\/\/[^/]+/, '') || '/'} · ${r.subtitle}` : r.subtitle}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        );
      })}
    </div>
  );
}
