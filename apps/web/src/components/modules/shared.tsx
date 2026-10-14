import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { type OpportunityItem, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, EmptyState, Notice, Panel } from '@/components/ui/primitives';
import { SourceBadge } from '@/components/domain/badges';
import { useToast } from '@/components/ui/Toast';
import { fmtNum, shortUrl } from '@/lib/format';
import { OpportunityActions } from '@/components/opportunities/shared';

/** Small text link used in panel headers ("View all →"). */
export function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-sm text-signal hover:underline">
      {children} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

/** Config is gated behind settings.view — only fetch when the user may read it. */
export function useConfigQuery() {
  const { can } = useAuth();
  const allowed = can('settings.view');
  return { q: useApiQuery(['config'], () => api.getConfig(), { enabled: allowed }), allowed };
}

/** Plain explanation shown instead of a panel when the signed-in role lacks a read permission. */
export function NoAccess({ what, perm }: { what: string; perm: string }) {
  return <Notice>{what} is not visible to your role (needs the <span className="font-mono text-xs">{perm}</span> permission). Ask an admin or the SEO lead if you need it.</Notice>;
}

/** API `note` → DEMO notice (prompt §7.2 honesty rule). */
export function ApiNote({ note, available = true }: { note?: string; available?: boolean }) {
  if (!note && available) return null;
  return (
    <Notice tone="demo" title={available ? undefined : 'Data source not connected'}>
      {note ?? 'This section needs an external data source that is not connected.'}
    </Notice>
  );
}

/** Copy-to-clipboard button with confirmation; falls back to a toast error when the clipboard is blocked. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={done ? <Check className="h-3.5 w-3.5 text-ok-ink" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          toast.error('Copy failed — your browser blocked clipboard access. Select the text and copy it manually.');
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Opportunity list filtered by kind. */
export function OpportunityPanel({ title, subtitle, kinds, empty }: { title: string; subtitle?: ReactNode; kinds: OpportunityItem['kind'][]; defaultTeam?: TeamId; empty: { title: string; description: string } }) {
  const { can } = useAuth();
  const allowed = can('opportunities.view');
  const q = useApiQuery(['opportunities'], () => api.listOpportunities(), { enabled: allowed });
  return (
    <Panel title={title} subtitle={subtitle} actions={allowed ? <PanelLink to="/opportunities">Opportunities board</PanelLink> : undefined} bodyClassName="p-0">
      {!allowed ? (
        <div className="p-4"><NoAccess what="The opportunity list" perm="opportunities.view" /></div>
      ) : (
        <Async q={q} rows={3}>
          {(all) => {
            const items = all.filter((o) => kinds.includes(o.kind));
            if (!items.length) return <EmptyState title={empty.title} description={empty.description} />;
            return (
              <ul className="divide-y divide-line">
                {items.map((o) => (
                  <li key={o.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="opp">{o.kind.replace(/_/g, ' ')}</Badge>
                        <span className="text-sm font-medium text-ink">{o.title}</span>
                        <SourceBadge source={o.source} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {o.detail}
                        {o.url && <> · <span className="font-mono">{shortUrl(o.url)}</span></>}
                        {' '}· value {fmtNum(o.value)}
                      </p>
                    </div>
                    <OpportunityActions o={o} />
                  </li>
                ))}
              </ul>
            );
          }}
        </Async>
      )}
    </Panel>
  );
}

/** Coloured value cell for good / needs improvement / poor thresholds. */
export function ratingTone(v: number, good: number, poor: number): 'ok' | 'med' | 'crit' {
  return v > poor ? 'crit' : v > good ? 'med' : 'ok';
}

export const TONE_TEXT = { ok: 'text-ok-ink', med: 'text-med-ink', crit: 'font-semibold text-crit-ink' } as const;

/** Bulleted explanation list used by several module panels. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

/**
 * Latest completed crawl and its detail (URLs + sitemap diff). Prefers a non-simulated run because
 * simulated runs in mock mode fetch nothing and carry no URL-level data.
 */
export function useLatestCrawl() {
  const { can } = useAuth();
  const allowed = can('crawls.view');
  const runs = useApiQuery(['crawls'], () => api.listCrawls(), { enabled: allowed });
  const completed = (runs.data ?? []).filter((r) => r.status === 'completed');
  const run = completed.find((r) => r.source !== 'simulated') ?? completed[0];
  const detail = useApiQuery(['crawl', run?.id ?? ''], () => api.getCrawl(run!.id), { enabled: allowed && !!run });
  return { allowed, runs, run, detail };
}

/**
 * Visually hidden text that stays inside horizontally scrolled tables. A bare `sr-only` span is
 * absolutely positioned against the page, so in a far-right column it widens the document on phones.
 */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="relative inline-block h-0 w-0 overflow-hidden align-middle"><span className="sr-only">{children}</span></span>;
}
