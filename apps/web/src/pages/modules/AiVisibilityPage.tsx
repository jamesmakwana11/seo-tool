import { useMemo, useState } from 'react';
import { Check, Link2, Minus } from 'lucide-react';
import type { AiVisibilityPrompt, AiVisibilityTrendPoint } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Async, EmptyState, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { TrendChart } from '@/components/ui/charts';
import { FilterSelect } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { ApiNote, PanelLink, SrOnly } from '@/components/modules/shared';
import { fmtShortDate } from '@/lib/format';

type Engine = AiVisibilityPrompt['results'][number]['engine'];
const ENGINES: { id: Engine; label: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT' }, { id: 'gemini', label: 'Gemini' }, { id: 'perplexity', label: 'Perplexity' }, { id: 'copilot', label: 'Copilot' }, { id: 'google_aio', label: 'AI Overviews' },
];

export default function AiVisibilityPage() {
  const q = useApiQuery(['ai-visibility'], () => api.getAiVisibility());
  return (
    <div>
      <PageHeader
        title="AI visibility"
        description="A fixed weekly panel of ~50 buyer-intent prompts run against the major AI engines, logging whether DeoDap is mentioned or cited and which competitors are (AEO-AI-VISIBILITY, PDF §8)."
        meta={<><span className="text-xs text-muted">Sampling requires OpenAI, Gemini and Perplexity API keys</span></>}
        actions={<PanelLink to="/modules/aeo">AEO module</PanelLink>}
      />
      <Async q={q} rows={10}>
        {(d) => (
          <div className="space-y-5">
            <ApiNote note={d.note} available={d.available} />
            {!d.available ? (
              <EmptyState title="AI engines not connected" description="Add OpenAI, Gemini and Perplexity API keys in Integrations to run the weekly prompt panel." action={<PanelLink to="/settings/integrations">Integrations</PanelLink>} />
            ) : (
              <>
                <EngineStats prompts={d.prompts} trend={d.trend} />
                <Panel title="Mention share vs. competitors" subtitle="Share of all brand mentions across the prompt panel, by week">
                  <ShareTrend trend={d.trend} />
                </Panel>
                <Panel title="Prompt panel" subtitle="Mentioned = DeoDap named in the answer · cited = deodap.in linked as a source" bodyClassName="p-3">
                  <PromptTable prompts={d.prompts} />
                </Panel>
                <Notice>Answers from AI engines vary run to run and by account and location; treat single-prompt results as samples and read the weekly trend. Google AI Overviews and Copilot have no official answer API — those columns depend on the sampling method configured in Phase 2.</Notice>
              </>
            )}
          </div>
        )}
      </Async>
    </div>
  );
}

function EngineStats({ prompts, trend }: { prompts: AiVisibilityPrompt[]; trend: AiVisibilityTrendPoint[] }) {
  const rate = (e: Engine) => {
    const rs = prompts.flatMap((p) => p.results.filter((r) => r.engine === e));
    return rs.length ? { m: (rs.filter((r) => r.mentioned).length / rs.length) * 100, c: (rs.filter((r) => r.cited).length / rs.length) * 100, n: rs.length } : null;
  };
  const last = trend.at(-1)?.mentionShare.DeoDap;
  const prev = trend.at(-2)?.mentionShare.DeoDap;
  const delta = last !== undefined && prev !== undefined ? last - prev : undefined;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat
        label="DeoDap mention share"
        value={last !== undefined ? `${last.toFixed(1)}%` : '—'}
        tone={delta !== undefined && delta < 0 ? 'crit' : undefined}
        hint={delta !== undefined ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pts vs. last week${delta < 0 ? ' — loss' : ''}` : 'latest week'}
      />
      {ENGINES.map((e) => {
        const r = rate(e.id);
        return <Stat key={e.id} label={`${e.label} mention rate`} value={r ? `${r.m.toFixed(0)}%` : '—'} hint={r ? `cited ${r.c.toFixed(0)}% · ${r.n} prompts` : 'not sampled'} />;
      })}
    </div>
  );
}

function ShareTrend({ trend }: { trend: AiVisibilityTrendPoint[] }) {
  if (!trend.length) return <EmptyState title="No weekly samples yet" description="The trend starts after the first weekly panel run." />;
  const keys = Object.keys(trend.at(-1)?.mentionShare ?? {});
  const data = trend.map((p) => ({ week: p.week, ...p.mentionShare }));
  return <TrendChart data={data} x="week" series={keys.map((k) => ({ key: k, label: k, dashed: k !== 'DeoDap' }))} yFormat={(v) => `${v}%`} />;
}

function Cell({ r }: { r?: AiVisibilityPrompt['results'][number] }) {
  if (!r) return <span className="text-faint">—</span>;
  if (r.cited) return <span className="inline-flex items-center gap-0.5 text-ok-ink" title="Mentioned and cited"><Link2 className="h-4 w-4" aria-hidden /><SrOnly>Cited</SrOnly></span>;
  if (r.mentioned) return <span className="inline-flex text-signal" title="Mentioned, not cited"><Check className="h-4 w-4" aria-hidden /><SrOnly>Mentioned</SrOnly></span>;
  return <span className="inline-flex text-faint" title="Not mentioned"><Minus className="h-4 w-4" aria-hidden /><SrOnly>Not mentioned</SrOnly></span>;
}

function PromptTable({ prompts }: { prompts: AiVisibilityPrompt[] }) {
  const [category, setCategory] = useState('');
  const categories = useMemo(() => [...new Set(prompts.map((p) => p.category))].sort().map((c) => ({ value: c, label: c })), [prompts]);
  const rows = category ? prompts.filter((p) => p.category === category) : prompts;
  const mentionCount = (p: AiVisibilityPrompt) => p.results.filter((r) => r.mentioned).length;
  return (
    <DataTable
      rows={rows}
      rowKey={(p) => p.id}
      dense
      caption="AI visibility prompt panel"
      pageSize={50}
      search={(p) => `${p.prompt} ${p.category}`}
      searchPlaceholder="Search prompts"
      initialSort={{ key: 'm', dir: 'asc' }}
      toolbar={
        <>
          <FilterSelect label="Category" value={category} onChange={setCategory} options={categories} />
          <span className="ml-auto inline-flex flex-wrap items-center gap-3 text-xs text-muted">
            <span className="inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5 text-ok-ink" aria-hidden /> Cited</span>
            <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-signal" aria-hidden /> Mentioned</span>
            <span className="inline-flex items-center gap-1"><Minus className="h-3.5 w-3.5 text-faint" aria-hidden /> Not mentioned</span>
          </span>
        </>
      }
      empty={<EmptyState title="No prompts match" description="Clear the search or category filter." />}
      columns={[
        { key: 'p', header: 'Prompt', cell: (p) => <div className="min-w-[220px]"><span className="text-sm">{p.prompt}</span><div className="text-2xs capitalize text-muted">{p.category}</div></div> },
        ...ENGINES.map((e) => ({ key: e.id, header: e.label, width: '84px', cell: (p: AiVisibilityPrompt) => <Cell r={p.results.find((r) => r.engine === e.id)} /> })),
        { key: 'm', header: 'Engines mentioning', width: '90px', sort: (a, b) => mentionCount(a) - mentionCount(b), cell: (p) => <span className="tabular-nums">{mentionCount(p)} / {p.results.length}</span> },
        { key: 'c', header: 'Competitors mentioned', hideOnMobile: true, cell: (p) => { const c = [...new Set(p.results.flatMap((r) => r.competitorsMentioned))]; return <span className="text-xs text-muted">{c.length ? c.join(', ') : 'None'}</span>; } },
        { key: 'at', header: 'Sampled', width: '80px', hideOnMobile: true, cell: (p) => { const at = p.results.map((r) => r.sampledAt).sort().at(-1); return <span className="text-xs text-muted">{fmtShortDate(at)}</span>; } },
        { key: 's', header: <SrOnly>Source</SrOnly>, width: '80px', hideOnMobile: true, cell: (p) => <SourceBadge source={p.source} /> },
      ]}
    />
  );
}
