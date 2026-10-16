/** Human duration for crawl runs: "6s", "48m", "3h 12m". */
export function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export const CHECK_LABELS: Record<string, string> = {
  links: 'link targets', images: 'images', external: 'external links', scripts: 'third-party scripts', host: 'host variants', tls: 'TLS', botProbes: 'bot access', samples: 'samples',
};

type CheckGroup = { total: number; done: number; failed?: number; deferred?: number; excluded?: number; reused?: number; deferredAtLeast?: boolean };

/** One post-crawl check group in words: "link targets 25 / 111 checked · 2 broken · 86 deferred · 59 answered by the crawl". */
export function describeCheckGroup(name: string, g: CheckGroup): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const plus = g.deferredAtLeast ? '+' : '';
  const parts = [`${CHECK_LABELS[name] ?? name} ${n(g.done)} / ${n(g.total)}${plus} checked`];
  if (g.failed) parts.push(`${n(g.failed)} ${name === 'links' || name === 'external' ? 'broken' : 'failed'}`);
  if (g.deferred) parts.push(`${n(g.deferred)}${plus} deferred`);
  if (g.reused) parts.push(`${n(g.reused)} answered by the crawl`);
  if (g.excluded) parts.push(`${n(g.excluded)} excluded`);
  return parts.join(' · ');
}

/** The groups that had anything to do, in a stable order. */
export function checkGroups(groups: Record<string, CheckGroup> | undefined): [string, CheckGroup][] {
  const order = Object.keys(CHECK_LABELS);
  return Object.entries(groups ?? {})
    .filter(([, g]) => g.total || g.reused || g.excluded)
    .sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99);
}
