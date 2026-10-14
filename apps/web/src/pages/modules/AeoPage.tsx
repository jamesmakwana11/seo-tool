import { Link } from 'react-router-dom';
import type { ModuleData, SentinelConfig } from '@sentinel/shared';
import { ModuleView, useModule } from '@/components/domain/ModuleView';
import { Async, Badge, Mono, Panel } from '@/components/ui/primitives';
import { Bullets, NoAccess, OpportunityPanel, PanelLink, useConfigQuery } from '@/components/modules/shared';

const BOTS: { bot: string; engine: string }[] = [
  { bot: 'GPTBot', engine: 'OpenAI / ChatGPT' },
  { bot: 'Google-Extended', engine: 'Gemini and Google AI training' },
  { bot: 'PerplexityBot', engine: 'Perplexity' },
  { bot: 'CCBot', engine: 'Common Crawl (used by many LLMs)' },
  { bot: 'Bingbot', engine: 'Bing and Copilot' },
];

export default function AeoPage() {
  return (
    <ModuleView
      module="aeo"
      description="How retrievable and quotable DeoDap's content is for Google AI Overviews, ChatGPT, Gemini, Perplexity and Copilot — answer blocks, FAQs, PAA gaps, snippets, entity clarity and AI-crawler access (PDF §8)."
      headerActions={<PanelLink to="/modules/ai-visibility">AI visibility</PanelLink>}
      extra={
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <CrawlerAccess />
            <Extractability />
          </div>
          <OpportunityPanel
            title="PAA gaps & featured-snippet targets"
            subtitle="AEO-PAA and AEO-SNIPPET — questions the site doesn't answer and queries at positions 2–10 where a snippet exists"
            kinds={['paa_gap', 'snippet_target']}
            defaultTeam="content"
            empty={{ title: 'No PAA or snippet opportunities', description: 'New ones appear after the next GSC and SERP sync.' }}
          />
        </div>
      }
    />
  );
}

function CrawlerAccess() {
  const { q, allowed } = useConfigQuery();
  const mod = useModule('aeo');
  return (
    <Panel title="AI-crawler access" subtitle="AEO-AI-CRAWLERS — robots.txt and firewall must not block these unless the team decided to" actions={allowed ? <PanelLink to="/settings/crawl">Policy settings</PanelLink> : undefined} bodyClassName="p-0">
      {!allowed ? <div className="p-4"><NoAccess what="The crawler policy" perm="settings.view" /></div> : (
        <Async q={q} rows={5}>
          {(cfg) => <CrawlerTable cfg={cfg} mod={mod.data} />}
        </Async>
      )}
    </Panel>
  );
}

function CrawlerTable({ cfg, mod }: { cfg: SentinelConfig; mod?: ModuleData }) {
  const open = mod?.checks.find((c) => c.id === 'AEO-AI-CRAWLERS')?.openIssues;
  const extra = Object.keys(cfg.aiCrawlerPolicy).filter((b) => !BOTS.some((x) => x.bot === b)).map((bot) => ({ bot, engine: '' }));
  return (
    <>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">AI crawler policy</caption>
          <thead><tr className="border-b border-line bg-raised/70 text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Crawler</th><th className="px-3 py-2 font-medium">Used by</th><th className="px-3 py-2 font-medium">Policy</th></tr></thead>
          <tbody>
            {[...BOTS, ...extra].map(({ bot, engine }) => {
              const p = cfg.aiCrawlerPolicy[bot];
              return (
                <tr key={bot} className="border-b border-line last:border-0">
                  <td className="px-4 py-2"><Mono>{bot}</Mono></td>
                  <td className="px-3 py-2 text-xs text-muted">{engine}</td>
                  <td className="px-3 py-2">{p === 'allow' ? <Badge tone="ok">Allow</Badge> : p === 'block_intentional' ? <Badge tone="neutral">Blocked on purpose</Badge> : <Badge tone="med">No policy set</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-muted">
        This is the intended policy. Unintentional blocks are detected from the daily robots.txt and response check and raised as Critical findings
        {open !== undefined && <> — currently <Link to="/issues?checkId=AEO-AI-CRAWLERS" className="font-medium text-signal hover:underline">{open} open</Link></>}.
      </p>
    </>
  );
}

function Extractability() {
  return (
    <Panel title="Extractability" subtitle="AEO-EXTRACTABILITY (metric) — formats AI engines quote verbatim">
      <div className="space-y-3 text-sm text-ink-soft">
        <p>Each page is scored on whether it contains the structures answer engines lift into responses:</p>
        <Bullets items={[
          'Definition sentences ("No-MOQ wholesale means…") near the top',
          'A direct 40–60 word answer under a question-formatted H2 (AEO-ANSWER-BLOCK)',
          'Comparison tables and specification tables',
          'Numbered steps for how-to content',
          'FAQ blocks with matching FAQPage schema and short, specific answers (AEO-FAQ)',
        ]} />
        <p>Entity clarity (AEO-ENTITY) checks the Organization schema — sameAs, logo, founder, address — and that the brand description matches across the site and profiles.</p>
      </div>
    </Panel>
  );
}
