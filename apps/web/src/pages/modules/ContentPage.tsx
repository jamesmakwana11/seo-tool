import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import type { AiComplianceFlag, ContentScore, PageTier } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { ModuleView } from '@/components/domain/ModuleView';
import { Async, Badge, EmptyState, Panel } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { ChipGroup, ClearFilters } from '@/components/ui/filters';
import { SeverityBadge, SourceBadge, TierBadge } from '@/components/domain/badges';
import { scoreColor } from '@/components/domain/HealthScore';
import { PanelLink, SrOnly } from '@/components/modules/shared';
import { fmtDate, fmtNum, fmtRelative, shortUrl } from '@/lib/format';

const QUALITY_MIN = 50; // PDF §5: Medium if Tier 1–2 scores < 50

export default function ContentPage() {
  return (
    <ModuleView
      module="content"
      description="Content quality, intent, decay, freshness, cannibalisation and AI-content risk on every page; new pages are audited within 24h (PDF §5)."
      extra={
        <div className="space-y-5">
          <QaGatePanel />
          <QualityPanel />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- quality score
function QualityPanel() {
  const q = useApiQuery(['content-scores'], () => api.getContentScores());
  return (
    <Panel title="Content quality score" subtitle={`0–100 per page: uniqueness 30%, depth vs. top-10 SERP word count 30%, readability 15%, media 15%, freshness 10%. Tier 1–2 pages under ${QUALITY_MIN} raise CONT-QUALITY.`} bodyClassName="p-3">
      <Async q={q} rows={6} empty={(r) => (!r.length ? <EmptyState title="No pages scored yet" description="Scores appear after the next crawl evaluates page content." /> : false)}>
        {(rows) => <QualityTable rows={rows} />}
      </Async>
    </Panel>
  );
}

const COMPONENTS: { key: keyof ContentScore['components']; label: string }[] = [
  { key: 'uniqueness', label: 'Uniq.' }, { key: 'depth', label: 'Depth' }, { key: 'readability', label: 'Read.' }, { key: 'media', label: 'Media' }, { key: 'freshness', label: 'Fresh' },
];

function QualityTable({ rows }: { rows: ContentScore[] }) {
  const [tiers, setTiers] = useState<string[]>([]);
  const [below, setBelow] = useState<string[]>([]);
  const [templates, setTemplates] = useState<string[]>([]);
  const templateOpts = useMemo(() => [...new Set(rows.map((r) => r.template))].map((t) => ({ value: t, label: t.replace('_', ' ') })), [rows]);
  const filtered = rows.filter((r) => (!tiers.length || tiers.includes(String(r.tier))) && (!below.length || r.score < QUALITY_MIN) && (!templates.length || templates.includes(r.template)));
  const failing = rows.filter((r) => r.tier <= 2 && r.score < QUALITY_MIN).length;
  return (
    <DataTable
      rows={filtered}
      rowKey={(r) => r.url}
      dense
      caption="Content quality scores"
      search={(r) => r.url}
      searchPlaceholder="Search URLs"
      initialSort={{ key: 'score', dir: 'asc' }}
      toolbar={
        <>
          <ChipGroup label="Tier" options={([1, 2, 3] as PageTier[]).map((t) => ({ value: String(t), label: `T${t}` }))} value={tiers} onChange={setTiers} />
          <ChipGroup label="Score" options={[{ value: 'below', label: `Below ${QUALITY_MIN}` }]} value={below} onChange={setBelow} />
          <ChipGroup label="Template" options={templateOpts} value={templates} onChange={setTemplates} />
          <ClearFilters show={!!(tiers.length || below.length || templates.length)} onClear={() => { setTiers([]); setBelow([]); setTemplates([]); }} />
          <span className="ml-auto text-xs text-muted">{failing} Tier 1–2 page{failing === 1 ? '' : 's'} under {QUALITY_MIN}</span>
        </>
      }
      empty={<EmptyState title="No pages match these filters" description="Clear the filters to see every scored page." />}
      columns={[
        { key: 'url', header: 'Page', cell: (r) => <div className="min-w-[200px]"><span className="font-mono text-xs">{shortUrl(r.url)}</span><div className="text-2xs capitalize text-muted">{r.template.replace('_', ' ')}{r.lastUpdated ? ` · updated ${fmtDate(r.lastUpdated)}` : ''}</div></div> },
        { key: 'tier', header: 'Tier', width: '56px', sort: (a, b) => a.tier - b.tier, cell: (r) => <TierBadge tier={r.tier} /> },
        {
          key: 'score', header: 'Score', width: '90px', sort: (a, b) => a.score - b.score,
          cell: (r) => (
            <span className="inline-flex items-center gap-1">
              <span className="text-base font-semibold tabular-nums" style={{ color: scoreColor(r.score) }}>{r.score}</span>
              <span title={r.explanation} aria-label={`How this score is calculated: ${r.explanation}`} className="cursor-help text-faint"><Info className="h-3.5 w-3.5" /></span>
            </span>
          ),
        },
        {
          key: 'comp', header: 'Components', hideOnMobile: true,
          cell: (r) => (
            <div className="flex gap-2">
              {COMPONENTS.map((c) => (
                <div key={c.key} className="w-10 text-center" title={`${c.label}: ${r.components[c.key]}`}>
                  <div className="text-2xs text-muted">{c.label}</div>
                  <div className="h-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${r.components[c.key]}%`, backgroundColor: scoreColor(r.components[c.key]) }} /></div>
                  <div className="text-2xs tabular-nums">{r.components[c.key]}</div>
                </div>
              ))}
            </div>
          ),
        },
        {
          key: 'words', header: 'Words vs SERP avg', width: '140px', sort: (a, b) => a.wordCount / (a.serpAvgWords ?? 1) - b.wordCount / (b.serpAvgWords ?? 1),
          cell: (r) => (
            <span className="tabular-nums">
              <span className={r.serpAvgWords && r.wordCount < r.serpAvgWords * 0.5 ? 'font-semibold text-med-ink' : ''}>{fmtNum(r.wordCount)}</span>
              <span className="text-xs text-muted"> / {fmtNum(r.serpAvgWords)}</span>
            </span>
          ),
        },
        { key: 'src', header: <SrOnly>Source</SrOnly>, width: '80px', hideOnMobile: true, cell: (r) => <SourceBadge source={r.source} /> },
      ]}
    />
  );
}

// ---------------------------------------------------------------- QA gate
function QaGatePanel() {
  const q = useApiQuery(['ai-flags'], () => api.listAiFlags());
  return (
    <Panel title="New-page QA gate" subtitle="CONT-QA-GATE — every new product, collection and blog is audited within 24h. YMYL claims (AIC-07) hold the page until a person signs off." actions={<PanelLink to="/modules/ai-compliance">Review in AI compliance</PanelLink>} bodyClassName="p-0">
      <Async q={q} rows={3}>
        {(flags) => <QaList flags={flags.filter((f) => f.qaHold)} />}
      </Async>
    </Panel>
  );
}

function QaList({ flags }: { flags: AiComplianceFlag[] }) {
  if (!flags.length) return <EmptyState title="Nothing is held at the QA gate" description="New pages with unverified health or safety claims will appear here until a person approves them." />;
  const held = flags.filter((f) => f.qaHoldStatus === 'held').length;
  return (
    <>
      <p className="border-b border-line px-4 py-2 text-xs text-muted">{held} held · {flags.length - held} decided</p>
      <ul className="divide-y divide-line">
        {flags.map((f) => (
          <li key={f.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
            <Badge tone={f.qaHoldStatus === 'held' ? 'crit' : f.qaHoldStatus === 'approved' ? 'ok' : 'neutral'}>{f.qaHoldStatus === 'held' ? 'Held' : f.qaHoldStatus === 'approved' ? 'Approved' : 'Rejected'}</Badge>
            <SeverityBadge severity={f.severity} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{shortUrl(f.url)}</span>
            <span className="text-xs text-muted">{f.ruleName} · {fmtRelative(f.detectedAt)}</span>
            <Link to={`/modules/ai-compliance#flag-${f.id}`} className="text-sm text-signal hover:underline">Review</Link>
          </li>
        ))}
      </ul>
    </>
  );
}
