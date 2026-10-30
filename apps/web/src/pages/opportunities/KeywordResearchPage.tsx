import { Link } from 'react-router-dom';
import type { StrikingDistanceQuery } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, EmptyState, Notice, PageHeader, Panel, Tabs } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { CopyButton, SiteUrl } from '@/components/opportunities/shared';
import { fmtNum, fmtPct, shortUrl } from '@/lib/format';

type Tab = 'striking' | 'ctr' | 'money';
const KEYS = ['tab'] as const;

export default function KeywordResearchPage() {
  const f = useUrlFilters(KEYS);
  const tab = (['striking', 'ctr', 'money'].includes(f.get('tab')) ? f.get('tab') : 'striking') as Tab;
  return (
    <div>
      <PageHeader
        title="Keyword research"
        description="Daily quick wins from Search Console: queries in striking distance (positions 5–20 with meaningful impressions) and top-5 queries whose CTR is below the position benchmark, with rewrite suggestions (PDF §6.3)."
      />
      <Tabs<Tab>
        className="mb-5"
        value={tab}
        onChange={(v) => f.set('tab', v === 'striking' ? '' : v)}
        items={[
          { value: 'striking', label: 'Striking distance' },
          { value: 'ctr', label: 'CTR rewrites' },
          { value: 'money', label: 'Money keywords' },
        ]}
      />
      {tab === 'striking' && <StrikingTab />}
      {tab === 'ctr' && <CtrTab />}
      {tab === 'money' && <MoneyTab />}
    </div>
  );
}

// ------------------------------------------------------------------ striking distance


function StrikingTab() {
  const q = useApiQuery(['opportunities', 'striking'], () => api.listStrikingDistance());
  const columns: Column<StrikingDistanceQuery>[] = [
    { key: 'query', header: 'Query', cell: (s) => <span className="font-medium">{s.query}</span>, sort: (a, b) => a.query.localeCompare(b.query) },
    { key: 'url', header: 'Ranking URL', cell: (s) => <SiteUrl url={s.url} />, hideOnMobile: true },
    { key: 'position', header: 'Position', cell: (s) => <span className="tabular-nums">{s.position.toFixed(1)}</span>, sort: (a, b) => a.position - b.position },
    { key: 'impressions', header: 'Impressions', cell: (s) => <span className="tabular-nums">{fmtNum(s.impressions)}</span>, sort: (a, b) => a.impressions - b.impressions },
    { key: 'clicks', header: 'Clicks', cell: (s) => <span className="tabular-nums">{fmtNum(s.clicks)}</span>, sort: (a, b) => a.clicks - b.clicks, hideOnMobile: true },
    { key: 'ctr', header: 'CTR', cell: (s) => <span className="tabular-nums">{fmtPct(s.ctr, 1)}</span>, sort: (a, b) => a.ctr - b.ctr },
    { key: 'source', header: 'Source', cell: (s) => <SourceBadge source={s.source} />, hideOnMobile: true },
  ];
  return (
    <Async q={q} rows={8}>
      {(rows) => (
        <div className="space-y-3">
          <Notice tone="caution">Search Console is not connected. Live striking-distance lists need the Google Search Console API connection (Settings → Integrations).</Notice>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(s) => s.id}
            search={(s) => `${s.query} ${s.url}`}
            searchPlaceholder="Search queries or URLs"
            initialSort={{ key: 'impressions', dir: 'desc' }}
            caption="Striking-distance queries"
            empty={<EmptyState title="No striking-distance queries" description="No queries currently rank in positions 5–20 with meaningful impressions." />}
          />
        </div>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------ CTR rewrites


function CtrTab() {
  const q = useApiQuery(['opportunities', 'ctr'], () => api.listCtrRewrites());
  return (
    <Async q={q} rows={8} empty={(rows) => rows.length === 0 && <Panel><EmptyState title="No CTR rewrites needed" description="Every top-5 query is at or above its position CTR benchmark." /></Panel>}>
      {(rows) => (
        <div className="space-y-5">
          <Notice tone="caution" title="Heuristic estimate — not measured CTR">
            Variant scores (0–100) rank drafts by length, keyword placement and value cues such as No MOQ and COD. They are not predicted or measured click-through rates. Measure real CTR in Search Console 2–4 weeks after a change goes live.
          </Notice>
          {rows.map((c) => (
            <Panel
              key={c.id}
              title={<>&ldquo;{c.query}&rdquo;</>}
              subtitle={<>Position {c.position} · CTR <span className="font-medium text-crit-ink">{fmtPct(c.ctr, 1)}</span> vs benchmark {fmtPct(c.benchmarkCtr, 1)} · <span className="font-mono">{shortUrl(c.url)}</span></>}
              actions={<><SourceBadge source={c.source} /></>}
            >
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="rounded-ctl border border-line bg-canvas p-3">
                  <p className="text-xs font-medium text-muted">Current</p>
                  <p className="mt-1 text-sm font-medium text-ink">{c.currentTitle}</p>
                  <p className="mt-0.5 text-sm text-muted">{c.currentMeta}</p>
                  <p className="mt-2 text-xs text-muted">Title {c.currentTitle.length} chars · meta {c.currentMeta.length} chars</p>
                  <div className="mt-2"><SiteUrl url={c.url} /></div>
                </div>
                <ul className="space-y-2">
                  {c.variants.map((v) => (
                    <li key={v.label} className="rounded-ctl border border-line p-3">
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted">{v.label}</span>
                        {v.score !== undefined && (
                          <Badge tone="opp" title={v.scoreBasis ?? 'Heuristic estimate — not measured CTR'}>Heuristic score {v.score}/100</Badge>
                        )}
                      </div>
                      {v.title && (
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 text-sm font-medium text-ink">{v.title} <span className="text-xs font-normal text-muted">({v.title.length})</span></p>
                          <CopyButton text={v.title} label={`Copy ${v.label} title`} />
                        </div>
                      )}
                      {v.meta && (
                        <div className="flex items-start justify-between gap-2">
                          <p className="min-w-0 text-sm text-muted">{v.meta} <span className="text-xs">({v.meta.length})</span></p>
                          <CopyButton text={v.meta} label={`Copy ${v.label} meta description`} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </Async>
  );
}

// ------------------------------------------------------------------ money keywords

function MoneyTab() {
  const { can } = useAuth();
  const allowed = can('settings.view');
  const q = useApiQuery(['config'], () => api.getConfig(), { enabled: allowed });
  if (!allowed) {
    return <Panel><EmptyState title="Money keyword list not available to your role" description="The money-keyword set is part of Settings, which your role cannot view. Ask an SEO Specialist or Admin." /></Panel>;
  }
  return (
    <Async q={q} rows={5}>
      {(cfg) => (
        <div className="space-y-3">
          <Notice tone="med" title="Live positions need Google Search Console">
            Daily rank tracking for these keywords requires the Search Console connection. Until then this is the configured list only — no positions are shown rather than invented ones. The monthly executive report tracks movement on this set (PDF §12.5).
          </Notice>
          <Panel
            title="Money-keyword set"
            subtitle={`${cfg.moneyKeywords.length} keywords · edit in Settings → Thresholds`}
            actions={can('settings.manage') ? <Link to="/settings/thresholds" className="text-sm text-signal hover:underline">Edit list</Link> : undefined}
            bodyClassName="p-0"
          >
            {cfg.moneyKeywords.length ? (
              <ul className="divide-y divide-line">
                {cfg.moneyKeywords.map((k, i) => (
                  <li key={k} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <span className="w-6 text-right text-xs tabular-nums text-muted">{i + 1}</span>
                    <span className="min-w-0 flex-1 text-sm font-medium">{k}</span>
                    <span className="text-xs text-muted">Position: awaiting GSC</span>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No money keywords configured" description="Add the keywords that drive revenue in Settings → Thresholds." />}
          </Panel>
        </div>
      )}
    </Async>
  );
}
