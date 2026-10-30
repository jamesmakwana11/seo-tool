import { useNavigate, Link } from 'react-router-dom';
import { FileText, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { KeywordGap, SearchIntent } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, EmptyState, Notice, PageHeader, Panel, Stat, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ChipGroup, ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { INTENT_LABELS, IntentBadge } from '@/components/opportunities/shared';
import { fmtNum } from '@/lib/format';

const KEYS = ['intent', 'quick', 'status'] as const;
const GAP_STATUS: Record<KeywordGap['status'], { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'opp' },
  approved: { label: 'Approved', tone: 'signal' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  brief_created: { label: 'Brief created', tone: 'ok' },
  task_created: { label: 'Actioned', tone: 'ok' },
};

export default function KeywordGapsPage() {
  const q = useApiQuery(['gaps'], () => api.listKeywordGaps());
  return (
    <div>
      <PageHeader
        title="Competitor keyword gaps"
        description="Weekly pull of keywords where at least two competitors rank in the top 10 and DeoDap doesn't, filtered by relevance to live categories, classified by intent, with low-difficulty quick wins flagged. Approved gaps generate content briefs (PDF §13)."
      />
      <Async q={q} rows={10}>
        {(d) => (
          <div className="space-y-5">
            {!d.available ? (
              <Notice tone="med" title="Keyword gap data not available">{d.note ?? 'Keyword gaps require an Ahrefs or Semrush API subscription.'}</Notice>
            ) : d.note ? (
              <Notice tone="caution">{d.note}</Notice>
            ) : null}
            {d.available && <GapTable gaps={d.items} />}
          </div>
        )}
      </Async>
    </div>
  );
}

function GapTable({ gaps }: { gaps: KeywordGap[] }) {
  const f = useUrlFilters(KEYS);
  const nav = useNavigate();
  const { can } = useAuth();
  const allowed = can('opportunities.manage');
  const why = allowed ? undefined : 'Your role does not have permission to manage opportunities (opportunities.manage).';
  const intents = f.getList('intent') as SearchIntent[];
  const quick = f.get('quick') === '1';
  const status = f.get('status');

  const update = useApiMutation((v: { id: string; status: KeywordGap['status'] }) => api.updateKeywordGap(v.id, v.status), {
    success: (g) => `"${g.keyword}" ${g.status === 'approved' ? 'approved' : g.status === 'rejected' ? 'rejected' : `marked ${g.status}`}`,
    invalidate: [['gaps'], ['opportunities']],
  });
  const brief = useApiMutation((id: string) => api.generateBriefFromGap(id), {
    success: (b) => `Brief ${b.id} generated`,
    invalidate: [['gaps'], ['briefs'], ['opportunities']],
    onSuccess: (b) => nav(`/opportunities/briefs/${b.id}`),
  });

  const rows = gaps.filter((g) => (!intents.length || intents.includes(g.intent)) && (!quick || g.quickWin) && (!status || g.status === status));
  const presentIntents = (Object.keys(INTENT_LABELS) as SearchIntent[]).filter((i) => gaps.some((g) => g.intent === i));

  const columns: Column<KeywordGap>[] = [
    {
      key: 'keyword', header: 'Keyword', sort: (a, b) => a.keyword.localeCompare(b.keyword),
      cell: (g) => (
        <div className="min-w-[160px]">
          <span className="font-medium">{g.keyword}</span>
          {g.quickWin && <Badge tone="ok" className="ml-1.5" title="Keyword difficulty below 25 — a quick win">Quick win</Badge>}
        </div>
      ),
    },
    { key: 'volume', header: 'Volume', cell: (g) => <span className="tabular-nums">{fmtNum(g.volume)}</span>, sort: (a, b) => (a.volume ?? 0) - (b.volume ?? 0) },
    { key: 'kd', header: 'KD', cell: (g) => <span className={`tabular-nums ${(g.difficulty ?? 100) < 25 ? 'font-medium text-ok-ink' : ''}`}>{g.difficulty ?? '—'}</span>, sort: (a, b) => (a.difficulty ?? 100) - (b.difficulty ?? 100) },
    { key: 'intent', header: 'Intent', cell: (g) => <IntentBadge intent={g.intent} />, sort: (a, b) => a.intent.localeCompare(b.intent), hideOnMobile: true },
    {
      key: 'competitors', header: 'Competitors ranking', hideOnMobile: true,
      cell: (g) => (
        <ul className="space-y-0.5">
          {[...g.competitorsRanking].sort((a, b) => a.position - b.position).map((c) => (
            <li key={c.domain} className="whitespace-nowrap font-mono text-xs">{c.domain} <span className="text-muted">#{c.position}</span></li>
          ))}
        </ul>
      ),
      sort: (a, b) => a.competitorsRanking.length - b.competitorsRanking.length,
    },
    { key: 'deodap', header: 'DeoDap', cell: (g) => (g.deodapPosition ? <span className="tabular-nums">#{g.deodapPosition}</span> : <span className="text-xs text-muted">Not ranking</span>), sort: (a, b) => (a.deodapPosition ?? 999) - (b.deodapPosition ?? 999) },
    { key: 'category', header: 'Category', cell: (g) => g.relevantCategory ?? <span className="text-muted">—</span>, hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (g) => <div className="flex flex-col items-start gap-1"><Badge tone={GAP_STATUS[g.status].tone}>{GAP_STATUS[g.status].label}</Badge><SourceBadge source={g.source} /></div>, sort: (a, b) => a.status.localeCompare(b.status) },
    {
      key: 'actions', header: <span className="sr-only">Actions</span>,
      cell: (g) => {
        const busy = (update.isPending && update.variables?.id === g.id) || (brief.isPending && brief.variables === g.id);
        if (g.status === 'brief_created') return <Link to="/opportunities/briefs" className="whitespace-nowrap text-sm text-signal hover:underline">View briefs</Link>;
        if (g.status === 'task_created') return <span className="text-xs text-muted">Actioned</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {g.status !== 'approved' && (
              <Button size="sm" variant="secondary" icon={<ThumbsUp className="h-3.5 w-3.5" />} disabled={!allowed || busy} title={why} loading={update.isPending && update.variables?.id === g.id && update.variables.status === 'approved'} onClick={() => update.mutate({ id: g.id, status: 'approved' })}>Approve</Button>
            )}
            {g.status !== 'rejected' && (
              <Button size="sm" variant="ghost" icon={<ThumbsDown className="h-3.5 w-3.5" />} disabled={!allowed || busy} title={why} loading={update.isPending && update.variables?.id === g.id && update.variables.status === 'rejected'} onClick={() => update.mutate({ id: g.id, status: 'rejected' })}>Reject</Button>
            )}
            {g.status !== 'approved' ? null : (
              <Button size="sm" variant="subtle" icon={<FileText className="h-3.5 w-3.5" />} disabled={!allowed || busy} title={why ?? 'Generates a draft brief from this approved gap and opens it in the editor'} loading={brief.isPending && brief.variables === g.id} onClick={() => brief.mutate(g.id)}>Generate brief</Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Keyword gaps" value={gaps.length} />
        <Stat label="Quick wins (KD < 25)" value={gaps.filter((g) => g.quickWin).length} tone="ok" />
        <Stat label="Awaiting review" value={gaps.filter((g) => g.status === 'new').length} tone="signal" />
        <Stat label="Briefs generated" value={gaps.filter((g) => g.status === 'brief_created').length} />
      </div>
      {!allowed && <Notice>You can view gaps. Approving, rejecting and generating briefs needs <span className="font-mono">opportunities.manage</span>.</Notice>}
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(g) => g.id}
        search={(g) => `${g.keyword} ${g.relevantCategory ?? ''} ${g.competitorsRanking.map((c) => c.domain).join(' ')}`}
        searchPlaceholder="Search keywords, categories, competitors"
        initialSort={{ key: 'volume', dir: 'desc' }}
        caption="Competitor keyword gaps"
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <ChipGroup label="Intent" value={intents} onChange={(v) => f.set('intent', v)} options={presentIntents.map((i) => ({ value: i, label: INTENT_LABELS[i] }))} />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" className="h-4 w-4 accent-[#7650D8]" checked={quick} onChange={(e) => f.set('quick', e.target.checked ? '1' : '')} />
              Quick wins only
            </label>
            <FilterSelect label="Status" value={status} onChange={(v) => f.set('status', v)} options={Object.entries(GAP_STATUS).map(([value, s]) => ({ value, label: s.label }))} />
            <ClearFilters show={f.active} onClear={f.clear} />
          </div>
        }
        empty={<EmptyState title="No keyword gaps match these filters" description="Clear the filters, or wait for the next weekly gap pull." />}
      />
      <Panel>
        <p className="text-sm text-muted">
          Generated briefs use a template outline. SERP-based outlines (headings and entities from the current top 10) need the Ahrefs or Semrush SERP API. Approving a gap records the decision in the audit log; it does not publish anything.
        </p>
      </Panel>
    </>
  );
}
