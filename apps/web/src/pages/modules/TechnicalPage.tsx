import type { ModuleData } from '@sentinel/shared';
import { useModule, ModuleLinkCards, ModuleView } from '@/components/domain/ModuleView';
import { Badge, Panel, Skeleton } from '@/components/ui/primitives';
import { TECH_GROUPS } from '@/components/modules/techGroups';

export default function TechnicalPage() {
  return (
    <ModuleView
      module="technical"
      description="Daily crawlability, response-code, canonical, security and structured-data checks (PDF §4). Each check reports status, affected URLs, severity, evidence and a Fix Card."
      extra={<GroupCards />}
    />
  );
}

function GroupCards() {
  const tech = useModule('technical');
  const perf = useModule('performance');
  const count = (d: ModuleData | undefined, prefix: string) => d?.checks.filter((c) => c.group.startsWith(prefix)).reduce((s, c) => s + c.openIssues, 0);
  return (
    <Panel title="Technical areas" subtitle="Open findings per PDF §4 group — open an area for its checks and supporting data.">
      <ModuleLinkCards
        items={TECH_GROUPS.map((g) => {
          const isPerf = g.slug === 'performance';
          const n = isPerf ? count(perf.data, g.prefix) : count(tech.data, g.prefix);
          return {
            to: isPerf ? '/modules/performance' : `/modules/technical/${g.slug}`,
            title: `${g.prefix} ${g.title}`,
            text: g.text,
            badge: n === undefined ? <Skeleton className="h-5 w-14" /> : <Badge tone={n ? 'med' : 'ok'}>{n} open</Badge>,
          };
        })}
      />
    </Panel>
  );
}
