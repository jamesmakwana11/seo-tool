import type { BrandMention } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, EmptyState, Notice, PageHeader, Select, Stat, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ChipGroup, ClearFilters, useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { SiteUrl } from '@/components/opportunities/shared';
import { fmtDate, fmtRelative } from '@/lib/format';

const STATUS: Record<BrandMention['status'], { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'opp' },
  outreach: { label: 'In outreach', tone: 'signal' },
  reclaimed: { label: 'Link reclaimed', tone: 'ok' },
  ignored: { label: 'Ignored', tone: 'neutral' },
};
/** Allowed next states (new → outreach → reclaimed / ignored; anything can be reopened). */
const NEXT: Record<BrandMention['status'], BrandMention['status'][]> = {
  new: ['outreach', 'ignored'],
  outreach: ['reclaimed', 'ignored', 'new'],
  reclaimed: ['outreach'],
  ignored: ['new'],
};
const KEYS = ['status'] as const;

export default function MentionsPage() {
  const q = useApiQuery(['mentions'], () => api.listBrandMentions());
  return (
    <div>
      <PageHeader
        title="Unlinked brand mentions"
        description='New mentions of "DeoDap" across the web and news that do not link to deodap.in, queued for link-reclamation outreach (PDF §7.1 brand-mention monitor).'
      />
      <Async q={q} rows={8}>{(rows) => <Body rows={rows} />}</Async>
    </div>
  );
}


function Body({ rows }: { rows: BrandMention[] }) {
  const f = useUrlFilters(KEYS);
  const { can } = useAuth();
  const allowed = can('opportunities.manage');
  const status = f.getList('status') as BrandMention['status'][];
  const update = useApiMutation((v: { id: string; status: BrandMention['status'] }) => api.updateBrandMention(v.id, v.status), {
    success: (m) => `Mention on ${m.domain} marked ${STATUS[m.status].label.toLowerCase()}`,
    invalidate: [['mentions'], ['opportunities']],
  });
  const visible = rows.filter((m) => !status.length || status.includes(m.status));

  const columns: Column<BrandMention>[] = [
    { key: 'domain', header: 'Domain', cell: (m) => <span className="font-mono text-[12.5px] font-medium">{m.domain}</span>, sort: (a, b) => a.domain.localeCompare(b.domain) },
    { key: 'url', header: 'URL', cell: (m) => <SiteUrl url={m.url} />, hideOnMobile: true },
    { key: 'snippet', header: 'Snippet', cell: (m) => <span className="block min-w-[200px] text-sm italic text-ink-soft">{m.snippet}</span> },
    { key: 'found', header: 'Found', cell: (m) => <span className="whitespace-nowrap text-xs text-muted" title={fmtDate(m.foundAt)}>{fmtRelative(m.foundAt)}</span>, sort: (a, b) => a.foundAt.localeCompare(b.foundAt) },
    {
      key: 'status', header: 'Status', sort: (a, b) => a.status.localeCompare(b.status),
      cell: (m) => (
        <div className="flex min-w-[150px] flex-col items-start gap-1">
          <div className="flex flex-wrap gap-1"><Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge><SourceBadge source={m.source} /></div>
          {allowed && (
            <Select
              aria-label={`Change status of mention on ${m.domain}`}
              className="h-8 text-xs"
              value=""
              disabled={update.isPending && update.variables?.id === m.id}
              onChange={(e) => e.target.value && update.mutate({ id: m.id, status: e.target.value as BrandMention['status'] })}
            >
              <option value="">Change status…</option>
              {NEXT[m.status].map((s) => <option key={s} value={s}>{s === 'new' ? 'Reopen as new' : `Mark ${STATUS[s].label.toLowerCase()}`}</option>)}
            </Select>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Notice tone="caution">Live monitoring needs a brand-mention source (Ahrefs/Semrush alerts or a news API). Sentinel never contacts sites itself — outreach is done by the SEO team.</Notice>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(Object.keys(STATUS) as BrandMention['status'][]).map((s) => <Stat key={s} label={STATUS[s].label} value={rows.filter((m) => m.status === s).length} tone={s === 'new' ? 'signal' : s === 'reclaimed' ? 'ok' : undefined} />)}
      </div>
      {!allowed && <Notice>You can view mentions. Changing status needs <span className="font-mono">opportunities.manage</span>.</Notice>}
      <DataTable
        rows={visible}
        columns={columns}
        rowKey={(m) => m.id}
        search={(m) => `${m.domain} ${m.url} ${m.snippet}`}
        searchPlaceholder="Search mentions"
        initialSort={{ key: 'found', dir: 'desc' }}
        caption="Unlinked brand mentions"
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <ChipGroup label="Status" value={status} onChange={(v) => f.set('status', v)} options={(Object.keys(STATUS) as BrandMention['status'][]).map((s) => ({ value: s, label: STATUS[s].label }))} />
            <ClearFilters show={f.active} onClear={f.clear} />
          </div>
        }
        empty={<EmptyState title={status.length ? 'No mentions with this status' : 'No unlinked mentions found'} description={status.length ? 'Clear the filter to see every mention.' : 'New unlinked mentions appear here after the daily brand-mention scan.'} />}
      />
    </div>
  );
}
