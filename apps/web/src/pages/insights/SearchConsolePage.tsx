import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ExternalLink, ScanSearch } from 'lucide-react';
import type { GscInspection, GscReport, GscRowOut, ReportCompare, ReportRange } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery, useSiteKey } from '@/api/hooks';
import { Badge, Button, Field, Input, KV, LoadingBlock, PageHeader, Panel, Tabs } from '@/components/ui/primitives';
import { TrendChart } from '@/components/ui/charts';
import { MetricTile, ReportControls, ReportError, TopTable, fmtRate } from '@/components/insights/parts';
import { fmtDateTime, fmtNum } from '@/lib/format';

type Dim = 'queries' | 'pages' | 'countries' | 'devices';
const DIM_LABEL: Record<Dim, string> = { queries: 'Query', pages: 'Page', countries: 'Country', devices: 'Device' };
const COUNTRY = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : undefined;
/** Search Console reports ISO 3166-1 alpha-3 country codes (e.g. "ind"). */
const ALPHA3: Record<string, string> = { ind: 'IN', usa: 'US', gbr: 'GB', are: 'AE', can: 'CA', aus: 'AU', deu: 'DE', sau: 'SA', sgp: 'SG', npl: 'NP', bgd: 'BD', pak: 'PK', lka: 'LK', fra: 'FR', nld: 'NL' };
const countryName = (c: string) => { const a2 = ALPHA3[c.toLowerCase()]; try { return a2 && COUNTRY ? `${COUNTRY.of(a2)} (${c.toUpperCase()})` : c.toUpperCase(); } catch { return c.toUpperCase(); } };

/** Google insights → Search Console: search performance and indexing for the selected website. */
export default function SearchConsolePage() {
  const [range, setRange] = useState<ReportRange>(28);
  const [compare, setCompare] = useState<ReportCompare>('previous');
  const [force, setForce] = useState(0);
  const siteKey = useSiteKey();
  const q = useQuery({
    queryKey: siteKey(['insights', 'gsc', range, compare, force]),
    queryFn: () => api.getGscReport({ range, compare, force: force > 0 }),
    placeholderData: keepPreviousData, retry: false, staleTime: 5 * 60_000,
  });
  const r = q.data;
  return (
    <div>
      <PageHeader
        title="Search Console"
        description={r ? <>Google Search Console · <span className="font-mono text-[13px] text-ink">{r.property}</span>{r.accountEmail ? <> · through {r.accountEmail}</> : null}. Search Console data arrives about two days late.</> : 'Clicks, impressions, CTR and average position from Google Search Console, with indexing data where Google provides it.'}
      />
      <div className="space-y-5">
        <ReportControls range={range} onRange={setRange} compare={compare} onCompare={setCompare} fetchedAt={r?.fetchedAt} cached={r?.cached} refreshing={q.isFetching} onRefresh={() => setForce((n) => n + 1)} window={r ? { cur: r.range, prev: r.compareRange } : undefined} />
        {q.error && !r ? <ReportError error={q.error} onRetry={() => void q.refetch()} what="Google Search Console" /> : !r ? <LoadingBlock rows={8} label="Loading Search Console" /> : <Report r={r} />}
      </div>
    </div>
  );
}

function Report({ r }: { r: GscReport }) {
  const t = r.totals;
  const p = r.previous;
  const [dim, setDim] = useState<Dim>('queries');
  const history = useApiQuery(['insights', 'history', 480], () => api.getGoogleHistory(480));
  const longTerm = (history.data ?? []).filter((x) => x.gsc).map((x) => ({ date: x.date, clicks: x.gsc!.clicks, impressions: x.gsc!.impressions }));
  const rows: GscRowOut[] = r[dim];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="gsc-totals">
        <MetricTile label="Clicks" value={fmtNum(t.clicks)} cur={t.clicks} prev={p.clicks} prevText={fmtNum(p.clicks)} />
        <MetricTile label="Impressions" value={fmtNum(t.impressions)} cur={t.impressions} prev={p.impressions} prevText={fmtNum(p.impressions)} />
        <MetricTile label="Average CTR" value={fmtRate(t.ctr, 2)} cur={t.ctr} prev={p.ctr} prevText={fmtRate(p.ctr, 2)} asPoints />
        <MetricTile label="Average position" value={t.position ? t.position.toFixed(1) : '—'} cur={t.position} prev={p.position} prevText={p.position ? p.position.toFixed(1) : '—'} lowerIsBetter hint="Lower is better" />
      </div>
      <Panel title="Daily performance" subtitle={`${r.daily.length} days`}>
        {r.daily.length ? <TrendChart data={r.daily} x="date" series={[{ key: 'clicks', label: 'Clicks' }, { key: 'impressions', label: 'Impressions', axis: 'right' }]} height={260} /> : <p className="text-sm text-muted">Search Console returned no daily data for this period.</p>}
      </Panel>
      <Panel title="Search performance" bodyClassName="p-0" actions={<Tabs<Dim> value={dim} onChange={setDim} items={(Object.keys(DIM_LABEL) as Dim[]).map((d) => ({ value: d, label: d === 'queries' ? 'Queries' : d === 'pages' ? 'Pages' : d === 'countries' ? 'Countries' : 'Devices', count: r[d].length }))} />}>
        <TopTable label={`Top ${dim}`} rows={rows} columns={[
          { header: DIM_LABEL[dim], cell: (x) => (dim === 'pages' ? <a href={x.key} target="_blank" rel="noreferrer" className="font-mono text-[13px] hover:text-signal hover:underline">{x.key}</a> : dim === 'countries' ? countryName(x.key) : dim === 'devices' ? x.key.charAt(0) + x.key.slice(1).toLowerCase() : x.key), className: 'max-w-[28rem] truncate' },
          { header: 'Clicks', cell: (x) => fmtNum(x.clicks), align: 'right' },
          { header: 'Impressions', cell: (x) => fmtNum(x.impressions), align: 'right' },
          { header: 'CTR', cell: (x) => fmtRate(x.ctr, 2), align: 'right' },
          { header: 'Position', cell: (x) => x.position.toFixed(1), align: 'right' },
        ]} />
      </Panel>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Panel title="Sitemaps and indexing" subtitle="As reported by Search Console">
          {r.sitemapsError ? <p className="text-sm text-crit-ink">{r.sitemapsError}</p> : r.sitemaps.length ? (
            <ul className="divide-y divide-line">
              {r.sitemaps.map((s) => (
                <li key={s.path} className="space-y-1 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[13px]">{s.path}</span>
                    {s.isSitemapsIndex && <Badge>Index</Badge>}
                    {s.isPending && <Badge tone="med">Pending</Badge>}
                    {s.errors > 0 && <Badge tone="crit">{s.errors} error{s.errors === 1 ? '' : 's'}</Badge>}
                    {s.warnings > 0 && <Badge tone="med">{s.warnings} warning{s.warnings === 1 ? '' : 's'}</Badge>}
                  </div>
                  <p className="text-xs text-muted">
                    {s.contents.map((c) => `${fmtNum(c.submitted)} ${c.type} URLs submitted${c.indexed ? `, ${fmtNum(c.indexed)} indexed` : ''}`).join(' · ') || 'No URL counts reported'}
                    {s.lastDownloaded ? ` · read by Google ${fmtDateTime(s.lastDownloaded)} IST` : ''}
                  </p>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No sitemaps are submitted in Search Console for this property.</p>}
          <p className="mt-3 text-xs text-muted">Google’s API does not give the Page indexing report’s totals; inspect single pages below for their index status.</p>
        </Panel>
        <Inspect />
      </div>
      {longTerm.length > r.daily.length && (
        <Panel title="Stored history" subtitle={`${longTerm.length} days kept by Sentinel from earlier reports`}>
          <TrendChart data={longTerm} x="date" series={[{ key: 'clicks', label: 'Clicks' }, { key: 'impressions', label: 'Impressions', axis: 'right' }]} height={220} />
        </Panel>
      )}
    </>
  );
}

function Inspect() {
  const [url, setUrl] = useState('');
  const [res, setRes] = useState<GscInspection | null>(null);
  const m = useApiMutation(() => api.inspectGscUrl(url.trim()), { onSuccess: setRes });
  return (
    <Panel title="URL inspection" subtitle="Index status of one page, straight from Google">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Page address" htmlFor="inspect-url"><Input id="inspect-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="w-full min-w-[16rem]" /></Field>
        <Button type="submit" icon={<ScanSearch className="h-4 w-4" />} disabled={!/^https?:\/\//.test(url.trim())} loading={m.isPending}>Inspect</Button>
      </form>
      {res && (
        <div className="mt-4 space-y-2" data-testid="inspection">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={res.verdict === 'PASS' ? 'ok' : res.verdict === 'FAIL' ? 'crit' : 'med'}>{res.verdict === 'PASS' ? 'Indexed' : res.verdict === 'FAIL' ? 'Not indexed' : res.verdict ?? 'Unknown'}</Badge>
            {res.link && <a href={res.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-signal hover:underline">Open in Search Console <ExternalLink className="h-3 w-3" /></a>}
          </div>
          <KV cols={1} items={[
            { k: 'Coverage', v: res.coverageState ?? '—' },
            { k: 'Indexing allowed', v: res.indexingState ?? '—' },
            { k: 'robots.txt', v: res.robotsTxtState ?? '—' },
            { k: 'Page fetch', v: res.pageFetchState ?? '—' },
            { k: 'Last crawl', v: res.lastCrawlTime ? `${fmtDateTime(res.lastCrawlTime)} IST${res.crawledAs ? ` (${res.crawledAs.toLowerCase()} crawler)` : ''}` : '—' },
            { k: 'Google-selected canonical', v: res.googleCanonical ?? '—' },
            ...(res.userCanonical && res.userCanonical !== res.googleCanonical ? [{ k: 'Declared canonical', v: res.userCanonical }] : []),
            ...(res.mobileUsability ? [{ k: 'Mobile usability', v: res.mobileUsability }] : []),
            ...(res.richResults ? [{ k: 'Rich results', v: res.richResults }] : []),
          ]} />
        </div>
      )}
    </Panel>
  );
}
