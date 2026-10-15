import type { ReactNode } from 'react';
import type { CrawlCoverageReport, CrawlRun } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiQuery } from '@/api/hooks';
import { Badge, EmptyState, KV, LoadingBlock, Mono, Notice, Panel } from '@/components/ui/primitives';
import { fmtMs, fmtNum, shortUrl } from '@/lib/format';

const EXCLUSION_LABELS: Record<string, string> = {
  sort_filter_search_parameter: 'Sort / filter / search parameters',
  too_many_parameter_variants: 'Too many parameter variants of one path',
  cart_account_or_app_path: 'Cart, checkout, account and app paths',
  non_html: 'Files (images, PDFs, scripts …)',
  crawl_trap: 'Likely crawl traps (very long, deep or repeating URLs)',
  excluded_by_settings: 'Your exclusion patterns',
};
const SOURCE_LABELS: Record<string, string> = { start: 'Start URL', link: 'Internal links', sitemap: 'Sitemap', pagination: 'Pagination', redirect: 'Redirect targets', seed: 'Smart-crawl evidence' };

const OUTCOME: Record<NonNullable<CrawlRun['outcome']>, { label: string; tone: 'ok' | 'med' | 'crit' | 'neutral' }> = {
  completed: { label: 'Completed — every eligible URL was fetched', tone: 'ok' },
  partial: { label: 'Partially completed', tone: 'med' },
  cancelled: { label: 'Cancelled', tone: 'med' },
  failed: { label: 'Failed', tone: 'crit' },
  resource_stopped: { label: 'Stopped for memory', tone: 'med' },
};

export function OutcomeBadge({ run }: { run: CrawlRun }) {
  if (!run.outcome) return null;
  const o = OUTCOME[run.outcome];
  return <Badge tone={o.tone} title={run.outcomeReason}>{o.label}</Badge>;
}

/** Engine, outcome, memory of every crawl process, speed, phase timings and the crawler's warnings. */
export function RunDiagnostics({ run }: { run: CrawlRun }) {
  if (!run.engine && !run.memory && !run.coverage) return null;
  const c = run.coverage;
  const m = run.memory;
  const t = run.timings ?? {};
  const phase = (k: string, label: string): { k: string; v: ReactNode } | undefined => (t[k] !== undefined ? { k: label, v: fmtMs(t[k]) } : undefined);
  const items: ({ k: string; v: ReactNode } | undefined)[] = [
    { k: 'Crawler', v: run.engine === 'go' ? 'Go crawler + Rust text core' : run.engine === 'node' ? 'Built-in Node.js crawler' : '—' },
    { k: 'Outcome', v: run.outcome ? <span className="inline-flex flex-wrap items-center gap-2"><OutcomeBadge run={run} />{run.outcomeReason && <span className="text-xs text-ink-soft">{run.outcomeReason}</span>}</span> : '—' },
    { k: 'Duplicate-content analysis', v: run.textCore ? (run.textCore.ok ? 'Ran (Rust text core)' : <span className="text-med-ink">Not run: {run.textCore.error ?? 'unavailable'}</span>) : '—' },
    ...(c ? [
      { k: 'Speed', v: `${fmtNum(c.pagesPerMin)} pages / min${c.politeness?.avgLatencyMs ? ` · average response ${fmtMs(c.politeness.avgLatencyMs)}` : ''}` },
      { k: 'Pacing', v: c.politeness ? `${fmtNum(c.politeness.delayMs)} ms between requests${c.politeness.floorMs ? ` (floor ${fmtNum(c.politeness.floorMs)} ms)` : ''}${c.politeness.crawlDelayMs ? ` · robots.txt Crawl-delay ${fmtNum(c.politeness.crawlDelayMs / 1000)} s` : ''}${c.politeness.rateLimited ? ` · ${fmtNum(c.politeness.rateLimited)} × 429` : ''}${c.politeness.retries ? ` · ${fmtNum(c.politeness.retries)} retries` : ''}${c.politeness.waitedMs ? ` · waited ${fmtMs(c.politeness.waitedMs)} for the site` : ''}` : '—' },
    ] : []),
    ...(m ? [
      { k: 'Memory now / peak', v: `${fmtNum(Math.round(m.totalMB))} MB / ${fmtNum(Math.round(m.peakTotalMB))} MB${m.budgetMB ? ` of a ${fmtNum(m.budgetMB)} MB budget` : ' (no budget set)'}` },
      { k: 'By process', v: `API ${fmtNum(Math.round(m.nodeRssMB))} MB (heap ${fmtNum(Math.round(m.nodeHeapMB))}) · crawler ${m.goRssMB !== undefined ? `${fmtNum(Math.round(m.goRssMB))} MB` : '—'} · text core ${m.textCoreRssMB !== undefined ? `${fmtNum(Math.round(m.textCoreRssMB))} MB` : '—'}` },
    ] : []),
    phase('crawlProcessMs', 'Fetching (crawler process)'),
    phase('sitemapMs', 'Sitemaps'),
    phase('textMs', 'Text analysis (Rust)'),
    phase('indexMs', 'Indexing results'),
    phase('batchAnalysisMs', 'Page checks'),
    phase('wholeCrawlMs', 'Whole-site checks'),
  ];
  const shown = items.filter((x): x is { k: string; v: ReactNode } => !!x);
  return (
    <Panel title="Run diagnostics" subtitle="Which crawler ran, how it ended, how fast it went and how much memory every crawl process used">
      <KV cols={2} items={shown} />
      {!!run.warnings?.length && (
        <div className="mt-4 space-y-1.5">
          <h3 className="text-sm font-semibold">Crawler messages</h3>
          <ul className="space-y-1">
            {run.warnings.slice(-8).reverse().map((w, i) => <li key={i} className="text-xs text-ink-soft"><Mono className="mr-1 text-[11px] text-muted">{w.code}</Mono>{w.message}</li>)}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Count({ label, value, tone, hint }: { label: string; value?: number; tone?: 'crit' | 'med'; hint?: string }) {
  return (
    <div className="rounded-ctl border border-line px-3 py-2" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tone === 'crit' && value ? 'text-crit-ink' : tone === 'med' && value ? 'text-med-ink' : ''}`}>{value === undefined ? '—' : fmtNum(value)}</dd>
    </div>
  );
}

function UrlRows({ items, total, limit }: { items: { url: string; note?: ReactNode }[]; total: number; limit: number }) {
  if (!items.length) return <p className="text-sm text-muted">None.</p>;
  return (
    <div>
      <ul className="max-h-72 space-y-0.5 overflow-auto">
        {items.map((x) => <li key={x.url} className="flex min-w-0 items-baseline gap-2 text-xs"><Mono className="truncate">{shortUrl(x.url)}</Mono>{x.note && <span className="shrink-0 text-muted">{x.note}</span>}</li>)}
      </ul>
      {total > items.length && <p className="mt-1 text-xs text-muted">Showing {fmtNum(items.length)} of {fmtNum(total)} (lists are capped at {fmtNum(limit)}; use the Pages tab filters or the export for all of them).</p>}
    </div>
  );
}

/** URL coverage: what was found, crawled, failed and excluded, sitemap vs link graph, variants and duplicates. */
export function CoverageReport({ run }: { run: CrawlRun }) {
  const q = useApiQuery(['crawlCoverage', run.id, run.status], () => api.getCrawlCoverage(run.id));
  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error) return <Notice tone="crit">{errorMessage(q.error)}</Notice>;
  const r = q.data as CrawlCoverageReport;
  const c = run.coverage;
  return (
    <div className="space-y-5">
      {c && (
        <Panel title="URL accounting" subtitle="Every URL found is fetched, or listed with why not. Discovered = fetched + robots + excluded + limits + not processed.">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            <Count label="Discovered" value={c.discovered} />
            <Count label="Processed" value={c.processed} />
            <Count label="Successful" value={c.succeeded} />
            <Count label="Failed (4xx / 5xx / none)" value={c.failed} tone="crit" />
            <Count label="Disallowed by robots.txt" value={c.robots} />
            <Count label="Excluded by rule" value={c.excluded} />
            <Count label="Beyond depth limit" value={c.depthLimited} tone="med" />
            <Count label="Page limit reached" value={c.pageLimited} tone="med" />
            <Count label="Not processed" value={c.notProcessed + c.queued + c.waiting + c.active} tone="med" hint="Eligible but not fetched because the crawl was cancelled or stopped" />
            <Count label="In sitemaps" value={c.sitemapUrls} />
          </dl>
          {!!Object.keys(c.excludedBy).length && (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-semibold">Excluded, by reason</h3>
              <ul className="space-y-0.5 text-sm">{Object.entries(c.excludedBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => <li key={k} className="flex justify-between gap-3"><span>{EXCLUSION_LABELS[k] ?? k}</span><span className="tabular-nums">{fmtNum(n)}</span></li>)}</ul>
            </div>
          )}
        </Panel>
      )}
      {!r.available ? (
        <Panel><EmptyState title="No coverage report for this crawl" description={r.note} /></Panel>
      ) : (
        <>
          {r.note && <Notice tone="med">{r.note}</Notice>}
          {!!Object.keys(r.foundVia).length && (
            <Panel title="How URLs were found"><ul className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{Object.entries(r.foundVia).map(([k, n]) => <li key={k} className="flex justify-between rounded-ctl border border-line px-3 py-1.5"><span>{SOURCE_LABELS[k] ?? k}</span><span className="tabular-nums font-medium">{fmtNum(n)}</span></li>)}</ul></Panel>
          )}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel title={`In the sitemap, not crawled (${fmtNum(r.sitemapNotCrawled.count)})`} subtitle="Listed in a sitemap but not fetched — with the reason"><UrlRows items={r.sitemapNotCrawled.urls.map((u) => ({ url: u.url, note: `${u.state.replace(/_/g, ' ')}${u.reason ? ` · ${u.reason.replace(/_/g, ' ')}` : ''}` }))} total={r.sitemapNotCrawled.count} limit={r.listLimit} /></Panel>
            <Panel title={`Crawled, not in the sitemap (${fmtNum(r.linkedNotInSitemap.count)})`} subtitle="Indexable, self-canonical pages reached by links that no sitemap lists"><UrlRows items={r.linkedNotInSitemap.urls.map((url) => ({ url }))} total={r.linkedNotInSitemap.count} limit={r.listLimit} /></Panel>
            <Panel title={`Orphan candidates (${fmtNum(r.orphanCandidates.count)})`} subtitle={r.orphanCandidates.note}>
              {!r.orphanCandidates.evaluated && <p className="mb-2 text-xs text-med-ink">Candidates only — the link graph of this crawl is incomplete.</p>}
              <UrlRows items={r.orphanCandidates.urls.map((url) => ({ url }))} total={r.orphanCandidates.count} limit={r.listLimit} />
            </Panel>
            <Panel title={`Failed URLs (${fmtNum(r.failed.count)})`} subtitle="4xx, 5xx and requests without a response"><UrlRows items={r.failed.urls.map((u) => ({ url: u.url, note: u.status ?? u.error ?? 'no response' }))} total={r.failed.count} limit={r.listLimit} /></Panel>
            <Panel title={`Redirects (${fmtNum(r.redirects.count)})`}><UrlRows items={r.redirects.urls.map((u) => ({ url: u.url, note: `${u.status} → ${u.finalUrl ? shortUrl(u.finalUrl) : '?'}${u.hops > 1 ? ` (${u.hops} hops)` : ''}` }))} total={r.redirects.count} limit={r.listLimit} /></Panel>
            <Panel title={`Not processed (${fmtNum(r.notProcessed.count)})`} subtitle="Eligible URLs the crawl did not reach before it stopped"><UrlRows items={r.notProcessed.urls.map((u) => ({ url: u.url }))} total={r.notProcessed.count} limit={r.listLimit} /></Panel>
          </div>
          <Panel title={`URL variants (${fmtNum(r.variantGroups.count)} groups)`} subtitle="Several URLs that redirect to, or declare as canonical, the same page">
            {r.variantGroups.groups.length ? (
              <ul className="max-h-80 space-y-2 overflow-auto">{r.variantGroups.groups.map((g) => <li key={`${g.kind}:${g.target}`} className="rounded-ctl border border-line p-2 text-xs"><div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{g.kind === 'redirect' ? 'redirect to' : 'canonical'}</Badge><Mono>{shortUrl(g.target)}</Mono><span className="text-muted">{fmtNum(g.urls.length)} URLs</span></div><ul className="mt-1 space-y-0.5 pl-3">{g.urls.slice(0, 6).map((u) => <li key={u}><Mono className="text-muted">{shortUrl(u)}</Mono></li>)}</ul></li>)}</ul>
            ) : <p className="text-sm text-muted">None.</p>}
          </Panel>
          <Panel title="Duplicates" subtitle="Duplicate titles and meta descriptions are confirmed matches. Exact duplicate copy is confirmed; near-duplicate copy are candidates (≥ 90% overlap of 4-word phrases) to review, not a verdict.">
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <DupGroups title={`Duplicate titles (${fmtNum(r.duplicates.titles.count)} groups)`} groups={r.duplicates.titles.groups.map((g) => ({ label: g.value, urls: g.urls }))} />
              <DupGroups title={`Duplicate meta descriptions (${fmtNum(r.duplicates.metaDescriptions.count)} groups)`} groups={r.duplicates.metaDescriptions.groups.map((g) => ({ label: g.value, urls: g.urls }))} />
              <DupGroups title={`Exact duplicate copy (${fmtNum(r.duplicates.exactContent.count)} groups)`} groups={r.duplicates.exactContent.groups.map((urls) => ({ label: `${urls.length} pages with identical unique text`, urls }))} />
              <DupGroups title={`Near-duplicate copy — candidates (${fmtNum(r.duplicates.nearContent.count)} groups)`} groups={r.duplicates.nearContent.groups.map((urls) => ({ label: `${urls.length} pages ≥ ${Math.round(r.duplicates.nearContent.threshold * 100)}% similar`, urls }))} />
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function DupGroups({ title, groups }: { title: string; groups: { label: string; urls: string[] }[] }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {groups.length ? (
        <ul className="max-h-72 space-y-2 overflow-auto">
          {groups.slice(0, 50).map((g, i) => (
            <li key={i} className="rounded-ctl border border-line p-2 text-xs">
              <p className="font-medium">{g.label || <em className="text-faint">(empty)</em>}</p>
              <ul className="mt-1 space-y-0.5">{g.urls.slice(0, 5).map((u) => <li key={u}><Mono className="text-muted">{shortUrl(u)}</Mono></li>)}{g.urls.length > 5 && <li className="text-muted">+{fmtNum(g.urls.length - 5)} more</li>}</ul>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">None found.</p>}
    </section>
  );
}
