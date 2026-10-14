import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CtrRewrite, ModuleData, StrikingDistanceQuery } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { ModuleView, useModule } from '@/components/domain/ModuleView';
import { Async, Badge, EmptyState, Mono, Notice, Panel, Tabs } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { SourceBadge } from '@/components/domain/badges';
import { CopyButton, NoAccess, PanelLink, SrOnly } from '@/components/modules/shared';
import { fmtNum, shortUrl } from '@/lib/format';

export default function OnPagePage() {
  return (
    <ModuleView
      module="onpage"
      description="Titles, metas, headings, breadcrumbs, image SEO and Open Graph on every page; template audits for homepage, collections and products; keyword targeting and CTR (PDF §6)."
      extra={<OnPageExtra />}
    />
  );
}

type Tab = 'templates' | 'striking' | 'ctr';

function OnPageExtra() {
  const [tab, setTab] = useState<Tab>('templates');
  return (
    <Panel bodyClassName="p-0">
      <Tabs<Tab>
        className="px-2"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'templates', label: '6.2 Template audits' },
          { value: 'striking', label: '6.3 Striking distance' },
          { value: 'ctr', label: '6.3 Low-CTR rewrites' },
        ]}
      />
      <div className="p-4">
        {tab === 'templates' && <TemplateAudits />}
        {tab === 'striking' && <Striking />}
        {tab === 'ctr' && <CtrRewrites />}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- 6.2
type ChecklistItem = { text: string; checks: string[] };
const TEMPLATES: { id: string; title: string; checkId: string; items: ChecklistItem[] }[] = [
  {
    id: 'home', title: 'Homepage', checkId: 'ONP-TPL-HOME', items: [
      { text: 'One clear H1', checks: ['ONP-H1'] },
      { text: 'Primary keyword coverage ("wholesale shopping India", "dropshipping products India" cluster)', checks: ['ONP-KEYWORD-MAP', 'ONP-TITLE'] },
      { text: 'Above-fold value proposition', checks: ['ONP-TPL-HOME'] },
      { text: 'Links to all Tier 1 collections', checks: ['ONP-TPL-HOME', 'TECH-CRAWL-DEPTH'] },
      { text: 'Organization + WebSite schema', checks: ['TECH-SCHEMA-PRESENCE', 'AEO-ENTITY'] },
      { text: 'Freshness block (new arrivals)', checks: ['ONP-TPL-HOME'] },
      { text: 'Internal-link count sanity (not 500+ links diluting equity)', checks: ['ONP-TPL-HOME'] },
    ],
  },
  {
    id: 'collection', title: 'Collection pages', checkId: 'ONP-TPL-COLLECTION', items: [
      { text: 'Unique 200–400 word description (top + expandable bottom copy)', checks: ['ONP-TPL-COLLECTION', 'TECH-THIN', 'TECH-DUPLICATE'] },
      { text: 'H1 = collection keyword', checks: ['ONP-H1', 'ONP-KEYWORD-MAP'] },
      { text: 'Filtered/sorted URLs canonicalised', checks: ['TECH-CANONICAL', 'TECH-CRAWL-BUDGET'] },
      { text: 'Subcollection interlinking', checks: ['ONP-TPL-COLLECTION', 'GEO-CLUSTER'] },
      { text: 'FAQ block', checks: ['AEO-FAQ'] },
      { text: 'ItemList schema', checks: ['TECH-SCHEMA-PRESENCE'] },
      { text: 'First product row server-rendered', checks: ['TECH-JS-RENDER'] },
    ],
  },
  {
    id: 'product', title: 'Product pages', checkId: 'ONP-TPL-PRODUCT', items: [
      { text: 'Unique description (not supplier boilerplate)', checks: ['TECH-DUPLICATE', 'CONT-PLAGIARISM', 'AIC-10'] },
      { text: 'Specification table', checks: ['ONP-TPL-PRODUCT', 'AEO-EXTRACTABILITY'] },
      { text: 'Wholesale / bulk pricing clarity', checks: ['ONP-TPL-PRODUCT'] },
      { text: 'Product schema completeness', checks: ['TECH-SCHEMA-PRESENCE', 'TECH-SCHEMA-ERRORS'] },
      { text: 'Reviews visible and marked up', checks: ['TECH-SCHEMA-ERRORS', 'AIC-06'] },
      { text: 'Related products and "frequently bought together" internal links', checks: ['ONP-TPL-PRODUCT'] },
      { text: 'Q&A section', checks: ['ONP-TPL-PRODUCT', 'AEO-FAQ'] },
      { text: 'Shipping / return info (trust for E-E-A-T)', checks: ['GEO-EEAT'] },
      { text: 'Video where available', checks: ['ONP-TPL-PRODUCT'] },
    ],
  },
];

function TemplateAudits() {
  const q = useModule('onpage');
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Run daily on samples and weekly on every page. Each checklist item is evaluated by the checks listed beside it; follow a check ID to its open findings.</p>
      <Async q={q} rows={4}>
        {(d) => (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {TEMPLATES.map((t) => <TemplateCard key={t.id} t={t} d={d} />)}
          </div>
        )}
      </Async>
    </div>
  );
}

function TemplateCard({ t, d }: { t: (typeof TEMPLATES)[number]; d: ModuleData }) {
  const own = d.checks.find((c) => c.id === t.checkId);
  return (
    <section className="rounded-panel border border-line" aria-labelledby={`tpl-${t.id}`}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h3 id={`tpl-${t.id}`} className="text-sm font-semibold">{t.title}</h3>
        {own && <Link to={`/issues?checkId=${own.id}`}><Badge tone={own.openIssues ? 'med' : 'ok'}>{own.openIssues} open</Badge></Link>}
      </header>
      <ul className="divide-y divide-line">
        {t.items.map((it) => (
          <li key={it.text} className="px-3 py-2">
            <p className="text-sm text-ink">{it.text}</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {it.checks.map((c) => <Link key={c} to={`/issues?checkId=${c}`} className="rounded border border-line px-1 font-mono text-2xs text-signal hover:border-signal/50">{c}</Link>)}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- 6.3 striking distance
function Striking() {
  const { can } = useAuth();
  const allowed = can('opportunities.view');
  const q = useApiQuery(['opportunities', 'striking'], () => api.listStrikingDistance(), { enabled: allowed });
  if (!allowed) return <NoAccess what="Striking-distance queries" perm="opportunities.view" />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Queries ranking positions 5–20 with meaningful impressions — the daily quick-win list (ONP-STRIKING, GSC data).</p>
        <PanelLink to="/opportunities">Convert on the opportunities board</PanelLink>
      </div>
      <Async q={q} rows={5}>
        {(rows) => (
          <DataTable<StrikingDistanceQuery>
            rows={rows}
            rowKey={(r) => r.id}
            dense
            caption="Striking-distance queries"
            search={(r) => `${r.query} ${r.url}`}
            searchPlaceholder="Search queries"
            initialSort={{ key: 'imp', dir: 'desc' }}
            empty={<EmptyState title="No striking-distance queries" description="Nothing ranks 5–20 with enough impressions right now." />}
            columns={[
              { key: 'q', header: 'Query', cell: (r) => <span className="font-medium">{r.query}</span> },
              { key: 'u', header: 'Ranking URL', hideOnMobile: true, cell: (r) => <Mono className="text-xs">{shortUrl(r.url)}</Mono> },
              { key: 'pos', header: 'Position', width: '90px', sort: (a, b) => a.position - b.position, cell: (r) => <span className="tabular-nums">{r.position.toFixed(1)}</span> },
              { key: 'imp', header: 'Impressions', width: '110px', sort: (a, b) => a.impressions - b.impressions, cell: (r) => <span className="tabular-nums">{fmtNum(r.impressions)}</span> },
              { key: 'c', header: 'Clicks', width: '80px', hideOnMobile: true, sort: (a, b) => a.clicks - b.clicks, cell: (r) => <span className="tabular-nums">{fmtNum(r.clicks)}</span> },
              { key: 'ctr', header: 'CTR', width: '70px', sort: (a, b) => a.ctr - b.ctr, cell: (r) => <span className="tabular-nums">{r.ctr}%</span> },
              { key: 's', header: <SrOnly>Source</SrOnly>, width: '80px', hideOnMobile: true, cell: (r) => <SourceBadge source={r.source} /> },
            ]}
          />
        )}
      </Async>
    </div>
  );
}

// ---------------------------------------------------------------- 6.3 CTR rewrites
function CtrRewrites() {
  const { can } = useAuth();
  const allowed = can('opportunities.view');
  const q = useApiQuery(['opportunities', 'ctr'], () => api.listCtrRewrites(), { enabled: allowed });
  if (!allowed) return <NoAccess what="CTR rewrite suggestions" perm="opportunities.view" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Queries in the top 5 with CTR below the position benchmark (ONP-LOW-CTR). Three title/meta variants are drafted for each; a person picks one and edits it in Shopify — Sentinel never changes the live site.</p>
      <Notice>Variant scores are a heuristic estimate (length, keyword position and DeoDap CTR levers: No MOQ, wholesale price, COD, fast shipping) — not a CTR prediction.</Notice>
      <Async q={q} rows={4} empty={(r) => (!r.length ? <EmptyState title="No low-CTR queries" description="Every top-5 query is at or above its position benchmark." /> : false)}>
        {(rows) => <div className="space-y-4">{rows.map((r) => <RewriteCard key={r.id} r={r} />)}</div>}
      </Async>
    </div>
  );
}

function RewriteCard({ r }: { r: CtrRewrite }) {
  return (
    <article className="rounded-panel border border-line">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-medium">"{r.query}"</span>
        <span className="text-xs text-muted">position {r.position.toFixed(1)} · CTR <span className="font-semibold text-crit-ink">{r.ctr}%</span> vs benchmark {r.benchmarkCtr}%</span>
        <Mono className="text-xs text-muted">{shortUrl(r.url)}</Mono>
        <span className="ml-auto"><SourceBadge source={r.source} /></span>
      </header>
      <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-4">
        <div className="rounded-ctl bg-canvas p-2.5">
          <p className="text-xs font-medium text-muted">Current</p>
          <p className="mt-1 text-sm font-medium text-ink">{r.currentTitle}</p>
          <p className="mt-0.5 text-xs text-ink-soft">{r.currentMeta}</p>
          <p className="mt-1 text-2xs text-muted">{r.currentTitle.length} / {r.currentMeta.length} chars</p>
        </div>
        {r.variants.slice(0, 3).map((v) => (
          <div key={v.label} className="rounded-ctl border border-line p-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted">{v.label}</p>
              {v.score !== undefined && <Badge tone="signal" title={v.scoreBasis ?? 'Heuristic estimate'}>{v.score} · heuristic estimate</Badge>}
            </div>
            <p className="mt-1 text-sm font-medium text-ink">{v.title}</p>
            <p className="mt-0.5 text-xs text-ink-soft">{v.meta}</p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-2xs text-muted">{v.title?.length ?? 0} / {v.meta?.length ?? 0} chars</span>
              <CopyButton text={`${v.title ?? ''}\n${v.meta ?? ''}`} />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
