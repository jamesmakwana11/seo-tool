import type { Backlink } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, Badge, DemoBadge, EmptyState, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { ChipGroup, ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { ApiNote, PanelLink, SrOnly } from '@/components/modules/shared';
import { fmtDate, shortUrl } from '@/lib/format';

const LOST_RECLAIM_DR = 40; // PDF §7.1: lost links from DR>40 domains flagged for reclamation
const TOXIC_MIN = 70;
const ANCHORS: { value: Backlink['anchorType']; label: string }[] = [
  { value: 'branded', label: 'Branded' }, { value: 'exact_match', label: 'Exact match' }, { value: 'partial', label: 'Partial' }, { value: 'url', label: 'Naked URL' }, { value: 'generic', label: 'Generic' },
];
const KEYS = ['status', 'anchor', 'toxic', 'dr'] as const;

export default function BacklinksPage() {
  const q = useApiQuery(['backlinks'], () => api.listBacklinks());
  return (
    <div>
      <PageHeader
        title="Backlink analysis"
        description="Every referring link in the latest backlink snapshot: new and lost links, anchor types, domain rating and toxic signals (PDF §7.1)."
        meta={<><DemoBadge /><span className="text-xs text-muted">Requires the Ahrefs or Semrush API</span></>}
        actions={<PanelLink to="/modules/offpage">Off-page overview</PanelLink>}
      />
      <Async q={q} rows={10}>
        {(d) => (
          <div className="space-y-5">
            <ApiNote note={d.note} available={d.available} />
            {!d.available ? (
              <EmptyState title="Backlink data not connected" description="Add an Ahrefs or Semrush API key in Integrations to load backlinks." action={<PanelLink to="/settings/integrations">Integrations</PanelLink>} />
            ) : <Body items={d.items} />}
          </div>
        )}
      </Async>
    </div>
  );
}

function Body({ items }: { items: Backlink[] }) {
  const f = useUrlFilters(KEYS);
  const status = f.getList('status');
  const anchor = f.get('anchor');
  const toxic = f.get('toxic') === '1';
  const dr = f.get('dr') === '1';
  const rows = items.filter((b) =>
    (!status.length || status.includes(b.status)) && (!anchor || b.anchorType === anchor) && (!toxic || (b.toxicScore ?? 0) >= TOXIC_MIN) && (!dr || b.domainRating >= LOST_RECLAIM_DR));
  const reclaim = items.filter((b) => b.status === 'lost' && b.domainRating > LOST_RECLAIM_DR).length;
  const toxicCount = items.filter((b) => (b.toxicScore ?? 0) >= TOXIC_MIN).length;
  const flags = [...(toxic ? ['toxic'] : []), ...(dr ? ['dr'] : [])];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Links in snapshot" value={items.length} />
        <Stat label="New" value={items.filter((b) => b.status === 'new').length} tone="ok" />
        <Stat label="Lost — reclaim" value={reclaim} tone={reclaim ? 'med' : undefined} hint={`lost from DR > ${LOST_RECLAIM_DR}`} />
        <Stat label="Toxic links" value={toxicCount} tone={toxicCount ? 'crit' : undefined} hint={`toxic score ≥ ${TOXIC_MIN}`} />
      </div>
      {reclaim > 0 && <Notice tone="med" title={`${reclaim} quality link${reclaim === 1 ? '' : 's'} lost`}>Lost links from domains above DR {LOST_RECLAIM_DR} are worth reclaiming — contact the site owner or restore the target URL if it now 404s.</Notice>}
      <Panel bodyClassName="p-3">
        <DataTable
          rows={rows}
          rowKey={(b) => b.id}
          dense
          caption="Backlinks"
          search={(b) => `${b.sourceDomain} ${b.sourceUrl} ${b.anchor} ${b.targetUrl}`}
          searchPlaceholder="Search domain, anchor or target"
          initialSort={{ key: 'dr', dir: 'desc' }}
          rowClassName={(b) => (b.status === 'lost' && b.domainRating > LOST_RECLAIM_DR ? 'bg-med-tint/50' : (b.toxicScore ?? 0) >= TOXIC_MIN ? 'bg-crit-tint/40' : undefined)}
          toolbar={
            <>
              <ChipGroup label="Status" options={[{ value: 'new', label: 'New' }, { value: 'live', label: 'Live' }, { value: 'lost', label: 'Lost' }]} value={status} onChange={(v) => f.set('status', v)} />
              <FilterSelect label="Anchor" value={anchor} onChange={(v) => f.set('anchor', v)} options={ANCHORS} />
              <ChipGroup label="Toxic" options={[{ value: 'toxic', label: `Score ≥ ${TOXIC_MIN}` }]} value={flags.filter((x) => x === 'toxic')} onChange={(v) => f.set('toxic', v.length ? '1' : '')} />
              <ChipGroup label="Authority" options={[{ value: 'dr', label: `DR ≥ ${LOST_RECLAIM_DR}` }]} value={flags.filter((x) => x === 'dr')} onChange={(v) => f.set('dr', v.length ? '1' : '')} />
              <ClearFilters show={f.active} onClear={f.clear} />
            </>
          }
          empty={<EmptyState title="No links match these filters" description="Clear the filters to see the full snapshot." />}
          columns={[
            {
              key: 'src', header: 'Referring page', cell: (b) => (
                <div className="min-w-[200px]">
                  <div className="font-medium">{b.sourceDomain}</div>
                  <a href={b.sourceUrl} target="_blank" rel="noreferrer" className="font-mono text-2xs text-signal hover:underline">{shortUrl(b.sourceUrl)}</a>
                </div>
              ),
            },
            { key: 'dr', header: 'DR', width: '60px', sort: (a, b) => a.domainRating - b.domainRating, cell: (b) => <span className="tabular-nums">{b.domainRating}</span> },
            { key: 'anchor', header: 'Anchor', cell: (b) => <div><span className="text-sm">"{b.anchor}"</span><div><Badge tone={b.anchorType === 'exact_match' ? 'med' : 'neutral'}>{ANCHORS.find((a) => a.value === b.anchorType)?.label}</Badge></div></div> },
            { key: 'tgt', header: 'Target', hideOnMobile: true, cell: (b) => <span className="font-mono text-xs">{shortUrl(b.targetUrl)}</span> },
            {
              key: 'st', header: 'Status', width: '130px', sort: (a, b) => a.status.localeCompare(b.status),
              cell: (b) => (
                <div className="space-y-0.5">
                  <Badge tone={b.status === 'new' ? 'ok' : b.status === 'lost' ? 'crit' : 'neutral'}>{b.status === 'new' ? 'New' : b.status === 'lost' ? 'Lost' : 'Live'}</Badge>
                  {b.status === 'lost' && b.domainRating > LOST_RECLAIM_DR && <div><Badge tone="med">Reclaim</Badge></div>}
                  <div className="text-2xs text-muted">{b.lostAt ? `lost ${fmtDate(b.lostAt)}` : `seen ${fmtDate(b.firstSeen)}`}</div>
                </div>
              ),
            },
            {
              key: 'tox', header: 'Toxic', width: '170px', sort: (a, b) => (a.toxicScore ?? 0) - (b.toxicScore ?? 0),
              cell: (b) => (
                <div>
                  <span className={`tabular-nums ${(b.toxicScore ?? 0) >= TOXIC_MIN ? 'font-semibold text-crit-ink' : 'text-muted'}`}>{b.toxicScore ?? '—'}</span>
                  {b.toxicSignals && b.toxicSignals.length > 0 && <ul className="mt-0.5 list-disc pl-4 text-2xs text-muted">{b.toxicSignals.map((s) => <li key={s}>{s}</li>)}</ul>}
                </div>
              ),
            },
            { key: 's', header: <SrOnly>Source</SrOnly>, width: '80px', hideOnMobile: true, cell: (b) => <SourceBadge source={b.source} /> },
          ]}
        />
      </Panel>
    </>
  );
}
