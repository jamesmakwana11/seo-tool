import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Plug, Radar, ScanSearch } from 'lucide-react';
import { useWebsites } from '@/websites/WebsiteContext';
import { LoadingBlock } from '@/components/ui/primitives';
import { API_MODE } from '@/api/client';

/**
 * Screens that report a score or pass/fail results (dashboard, health, audit modules, reports) only render for a website
 * that has audit data. A website that was never crawled shows this instead — never a score of 100 or a "pass".
 */
export function RequireAuditData({ children }: { children: ReactNode }) {
  const { current, loading } = useWebsites();
  if (loading && !current) return <LoadingBlock rows={4} label="Loading website" />;
  if (current && !current.hasAuditData) return <NoAuditData />;
  return <>{children}</>;
}

export function NoAuditData() {
  const { current } = useWebsites();
  if (!current) return null;
  return (
    <section aria-labelledby="no-data-title" className="mx-auto max-w-3xl py-6">
      <div className="rounded-panel border border-line bg-surface p-6 shadow-card sm:p-8">
        <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-ctl bg-signal-tint text-signal"><ScanSearch className="h-5 w-5" aria-hidden /></div>
        <h1 id="no-data-title" className="text-xl font-semibold text-ink">{current.name} has no audit data yet</h1>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          <span className="font-mono text-ink-soft">{current.domain}</span> was added on this workspace but has not been crawled, so there is no health score,
          no findings and nothing to report. Scores and pass/fail results appear only after a real crawl completes.
          {API_MODE === 'mock' && ' This review build runs in the browser and cannot crawl — simulated crawls never produce findings.'}
        </p>
        <ol className="mt-6 grid gap-3 sm:grid-cols-2">
          <li>
            <Link to="/crawls" className="group flex h-full gap-3 rounded-ctl border border-line bg-raised/60 p-4 transition-colors hover:border-signal/50">
              <Radar className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden />
              <span><span className="block text-sm font-medium text-ink">Run the first crawl</span><span className="mt-0.5 block text-xs text-muted">Crawl Center — needs the API server with crawling allowed for this domain.</span></span>
            </Link>
          </li>
          <li>
            <Link to="/settings/integrations" className="group flex h-full gap-3 rounded-ctl border border-line bg-raised/60 p-4 transition-colors hover:border-signal/50">
              <Plug className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden />
              <span><span className="block text-sm font-medium text-ink">Connect data sources</span><span className="mt-0.5 block text-xs text-muted">Search Console, GA4, CrUX… each is connected only after a passed test.</span></span>
            </Link>
          </li>
        </ol>
      </div>
    </section>
  );
}
