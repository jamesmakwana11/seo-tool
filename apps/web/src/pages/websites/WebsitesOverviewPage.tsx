import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowUpRight, Plus } from 'lucide-react';
import type { WebsiteSummary } from '@sentinel/shared';
import { useAuth } from '@/auth/AuthContext';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Panel } from '@/components/ui/primitives';
import { CompareBars } from '@/components/ui/charts';
import { SiteMark } from '@/components/websites/WebsiteSelector';
import { SiteStatus } from './WebsitesPage';
import { platformLabel, useWebsites } from '@/websites/WebsiteContext';
import { fmtRelative } from '@/lib/format';

function scoreTone(s: number) {
  return s >= 80 ? 'text-ok-ink' : s >= 60 ? 'text-signal' : 'text-crit-ink';
}

function SiteCard({ w, active, onOpen }: { w: WebsiteSummary; active: boolean; onOpen: () => void }) {
  const open = w.openIssues.critical + w.openIssues.medium + w.openIssues.low;
  return (
    <article className={clsx('flex flex-col rounded-panel border bg-surface transition-colors', active ? 'border-signal/50 shadow-lift' : 'border-line shadow-card hover:border-signal/30 hover:shadow-lift')} aria-label={w.name}>
      <header className="flex items-start gap-3 p-4 pb-3">
        <SiteMark site={w} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-ink">{w.name}</h2>
          <p className="truncate font-mono text-xs text-muted">{w.domain} · {platformLabel(w.platform)}</p>
        </div>
        <SiteStatus w={w} />
      </header>
      <div className="grid grid-cols-3 border-y border-line">
        <div className="px-4 py-3">
          <div className="text-2xs text-muted">Health</div>
          {w.healthScore !== undefined
            ? <div className={clsx('mt-0.5 text-2xl font-semibold tabular-nums', scoreTone(w.healthScore))}>{w.healthScore}</div>
            : <div className="mt-1.5 text-sm text-faint" title="No score until the website has audit data">No score</div>}
        </div>
        <div className="border-l border-line px-4 py-3">
          <div className="text-2xs text-muted">Open critical</div>
          <div className={clsx('mt-0.5 text-2xl font-semibold tabular-nums', w.hasAuditData ? (w.openIssues.critical ? 'text-crit-ink' : 'text-ink') : 'text-faint')}>{w.hasAuditData ? w.openIssues.critical : '—'}</div>
        </div>
        <div className="border-l border-line px-4 py-3">
          <div className="text-2xs text-muted">Open issues</div>
          <div className={clsx('mt-0.5 text-2xl font-semibold tabular-nums', w.hasAuditData ? 'text-ink' : 'text-faint')}>{w.hasAuditData ? open : '—'}</div>
        </div>
      </div>
      {w.hasAuditData && open > 0 && (
        <div className="flex h-1.5 overflow-hidden" aria-label={`${w.openIssues.critical} critical, ${w.openIssues.medium} medium, ${w.openIssues.low} low`}>
          <span className="bg-crit" style={{ flexGrow: w.openIssues.critical }} />
          <span className="bg-med" style={{ flexGrow: w.openIssues.medium }} />
          <span className="bg-low" style={{ flexGrow: w.openIssues.low }} />
        </div>
      )}
      <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-xs">
        <div><dt className="text-muted">Last crawl</dt><dd className="mt-0.5 text-ink-soft">{w.lastCrawlAt ? `${fmtRelative(w.lastCrawlAt)}${w.lastCrawlSource === 'simulated' ? ' (simulated)' : ''}` : 'Never'}</dd></div>
        <div><dt className="text-muted">Integrations</dt><dd className="mt-0.5 text-ink-soft">{w.integrationsConnected} of {w.integrationsTotal} connected</dd></div>
      </dl>
      <footer className="flex items-center justify-end border-t border-line bg-raised/50 px-3 py-2">
        <button onClick={onOpen} className="inline-flex items-center gap-1 rounded-ctl px-2 py-1 text-sm font-medium text-signal hover:bg-signal/10">
          {active ? 'Go to dashboard' : 'Open workspace'} <ArrowUpRight className="h-4 w-4" aria-hidden />
        </button>
      </footer>
    </article>
  );
}

export default function WebsitesOverviewPage() {
  const { websites, loading, error, refetch, select, websiteId } = useWebsites();
  const { can } = useAuth();
  const nav = useNavigate();
  const list = websites ?? [];
  const audited = list.filter((w) => w.hasAuditData);
  const crit = audited.reduce((n, w) => n + w.openIssues.critical, 0);
  const open = audited.reduce((n, w) => n + w.openIssues.critical + w.openIssues.medium + w.openIssues.low, 0);
  return (
    <div>
      <PageHeader
        title="All websites"
        description="Every workspace at a glance. Figures appear only for websites with audit data; a website that has never been crawled shows no score."
        actions={can('websites.manage') ? <Link to="/websites?add=1" className="inline-flex h-9 items-center gap-1.5 rounded-ctl bg-signal px-3 text-sm font-semibold text-on-signal hover:bg-signal-dark"><Plus className="h-4 w-4" /> Add website</Link> : undefined}
      />
      {loading ? <LoadingBlock rows={6} /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <dl className="mb-6 grid grid-cols-2 overflow-hidden rounded-panel border border-line bg-surface shadow-card md:grid-cols-4">
            {[
              { k: 'Websites', v: list.length },
              { k: 'With audit data', v: `${audited.length} of ${list.length}` },
              { k: 'Open critical issues', v: crit, tone: crit ? 'text-crit-ink' : undefined },
              { k: 'Open issues', v: open },
            ].map((s, i) => (
              <div key={s.k} className={clsx('px-5 py-4', i > 0 && 'border-l border-line', i === 2 && 'max-md:border-l-0 max-md:border-t', i === 3 && 'max-md:border-t')}>
                <dt className="text-xs text-muted">{s.k}</dt>
                <dd className={clsx('mt-1 text-2xl font-semibold tabular-nums text-ink', s.tone)}>{s.v}</dd>
              </div>
            ))}
          </dl>
          {list.length > 1 && (
            <div className="mb-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
              <Panel title="Health score by website" subtitle="Only websites with audit data are scored">
                <CompareBars max={100} format={(v) => v.toFixed(1)} rows={list.map((w) => ({ key: w.id, label: w.name, value: w.healthScore, note: 'Not crawled yet' }))} />
              </Panel>
              <Panel title="Open issues by website" subtitle="Critical issues shown in rose">
                <CompareBars rows={list.map((w) => ({ key: w.id, label: <>{w.name}{w.hasAuditData && w.openIssues.critical > 0 && <span className="ml-2 text-xs text-crit-ink">{w.openIssues.critical} critical</span>}</>, value: w.hasAuditData ? w.openIssues.critical + w.openIssues.medium + w.openIssues.low : undefined, color: '#B6A0F5', note: 'Not crawled yet' }))} />
              </Panel>
            </div>
          )}
          {list.length ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {list.map((w) => <SiteCard key={w.id} w={w} active={w.id === websiteId} onOpen={() => { select(w.id); nav('/'); }} />)}
            </div>
          ) : <EmptyState title="No websites yet" description="Add a website to create its workspace." />}
        </>
      )}
    </div>
  );
}
