import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { SYNC_REASON_LABELS, type MonitorStatus, type SyncReason, type SyncSummary } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, KV, LoadingBlock, Notice, Panel, Toggle } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { fmtDateTime, fmtNum, fmtRelative } from '@/lib/format';

const STATE_LABEL: Record<SyncSummary['state'], string> = {
  checking: 'Checking', crawling: 'Crawling changed pages', done: 'Synced', no_changes: 'No changes', failed: 'Failed', skipped: 'Skipped',
};
const STATE_TONE: Record<SyncSummary['state'], 'signal' | 'ok' | 'neutral' | 'crit' | 'med'> = {
  checking: 'signal', crawling: 'signal', done: 'ok', no_changes: 'neutral', failed: 'crit', skipped: 'med',
};

export const syncBusy = (m?: MonitorStatus) => !!m && (m.running || m.lastSync?.state === 'checking' || m.lastSync?.state === 'crawling');

/** Shared query: polls while a sync is checking or crawling, otherwise once a minute (Auto Sync may run meanwhile). */
export function useSyncStatus() {
  return useApiQuery(['monitor'], () => api.getMonitor(), { refetchInterval: (m) => (syncBusy(m) ? 3000 : 60_000) });
}

export function useSyncNow() {
  return useApiMutation(() => api.runMonitor(), {
    success: (m) => {
      const s = m.lastSync;
      if (!s) return 'Sync started';
      if (s.state === 'crawling') return s.message ?? 'Crawling the new and changed pages';
      return s.message ?? STATE_LABEL[s.state];
    },
    invalidate: [['monitor'], ['crawls']],
  });
}

export function SyncReasons({ s }: { s: SyncSummary }) {
  const entries = (Object.entries(s.reasons) as [SyncReason, number][]).filter(([, n]) => n);
  if (!entries.length) return <span className="text-xs text-faint">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([r, n]) => <span key={r} className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink-soft">{SYNC_REASON_LABELS[r]} · {fmtNum(n)}</span>)}
    </span>
  );
}

/** Crawl Center: Sync Now, Auto Sync, the last and next sync, and recent syncs. */
export function WebsiteSyncPanel() {
  const { can } = useAuth();
  const q = useSyncStatus();
  const sync = useSyncNow();
  const settings = useApiMutation((autoSync: boolean) => api.updateSyncSettings({ autoSync }), {
    success: (m) => (m.sync.autoSync ? `Auto Sync is on — every ${m.sync.intervalHours} hours` : 'Auto Sync is off'),
    invalidate: [['monitor']],
  });
  const m = q.data;
  const busy = syncBusy(m);
  const cur = m?.lastSync;
  return (
    <Panel
      title="Website sync"
      subtitle="After one Full or Smart crawl, a sync finds new, changed and removed pages and crawls only those. Their results replace the old rows; every other page keeps its stored results."
      actions={m?.available && can('crawls.run') ? (
        <Button size="sm" variant="primary" icon={<RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />} loading={sync.isPending} disabled={busy || !m.sync.baseline} onClick={() => sync.mutate()}>
          {busy ? 'Syncing…' : 'Sync now'}
        </Button>
      ) : undefined}
    >
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <Notice tone="crit">{errorMessage(q.error)}</Notice>}
      {m && !m.available && <Notice tone="med">{m.reason}</Notice>}
      {m?.available && (
        <div className="mt-3 space-y-4">
          {!m.sync.baseline && <Notice tone="med" title="Run one crawl first">Sync needs the results of a finished Full or Smart crawl to compare with. Start one above; after that, syncing keeps it current.</Notice>}
          <div className="flex flex-wrap items-center gap-3 rounded-ctl border border-line bg-raised/50 px-3 py-2.5">
            <Toggle
              checked={m.sync.autoSync && m.sync.intervalHours > 0}
              disabled={!can('crawls.configure') || m.sync.intervalHours <= 0 || settings.isPending}
              onChange={(v) => settings.mutate(v)}
              label="Auto Sync"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">Auto Sync {m.sync.intervalHours > 0 ? `every ${m.sync.intervalHours} hours` : ''}</p>
              <p className="text-xs text-muted">
                {m.sync.intervalHours <= 0
                  ? 'Turned off on this server (MONITOR_INTERVAL_MINUTES=0).'
                  : m.sync.autoSync && m.sync.schedulerOff
                    ? 'Waiting for the server scheduler: Auto Sync runs only when the API server is started with SCHEDULER_ENABLED=true.'
                  : m.sync.autoSync
                    ? m.sync.nextSyncAt ? `Next sync ${fmtDateTime(m.sync.nextSyncAt)} (${fmtRelative(m.sync.nextSyncAt)}).` : 'Starts after the first finished crawl.'
                    : 'Off — use Sync now whenever you need it.'}
                {!can('crawls.configure') && ' Changing it needs the crawls.configure permission.'}
              </p>
            </div>
          </div>
          <KV cols={3} items={[
            { k: 'Last sync', v: m.sync.lastSyncAt ? <span title={fmtDateTime(m.sync.lastSyncAt)}>{fmtDateTime(m.sync.lastSyncAt)} <span className="text-xs text-muted">({fmtRelative(m.sync.lastSyncAt)})</span></span> : <span className="text-muted">Not synced yet</span> },
            { k: 'Next sync', v: m.sync.autoSync && m.sync.nextSyncAt ? fmtDateTime(m.sync.nextSyncAt) : <span className="text-muted">{m.sync.autoSync && m.sync.schedulerOff ? 'Scheduler off on the server' : 'Manual only'}</span> },
            { k: 'Current results', v: m.sync.baseline ? <span><Link className="font-mono text-xs text-signal hover:underline" to={`/crawls/${m.sync.baseline.runId}`}>{m.sync.baseline.runId}</Link> · {m.sync.baseline.type} · {fmtNum(m.sync.baseline.pages)} pages</span> : '—' },
          ]} />
          {cur && (
            <Notice tone={cur.state === 'failed' ? 'crit' : cur.state === 'skipped' ? 'med' : busy ? 'signal' : 'neutral'} title={`${STATE_LABEL[cur.state]}${cur.trigger === 'auto' ? ' (Auto Sync)' : ''} · ${fmtRelative(cur.at)}`}>
              <p>{cur.message}</p>
              {cur.crawlRunId && <p className="mt-1"><Link className="text-signal hover:underline" to={`/crawls/${cur.crawlRunId}`}>Open sync crawl {cur.crawlRunId}</Link></p>}
              {cur.notes.map((n) => <p key={n} className="mt-1 text-xs">{n}</p>)}
            </Notice>
          )}
          {m.history.length > 0 && (
            <DataTable
              rows={m.history.slice(0, 10)}
              rowKey={(s) => s.at}
              dense
              caption="Recent syncs"
              columns={[
                { key: 'at', header: 'Started', cell: (s) => <span className="whitespace-nowrap text-xs" title={fmtDateTime(s.at)}>{fmtRelative(s.at)}</span> },
                { key: 'state', header: 'Result', cell: (s) => <span className="flex items-center gap-1"><Badge tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</Badge>{s.trigger === 'auto' && <span className="text-[11px] text-muted">auto</span>}</span> },
                { key: 'checked', header: 'Checked', hideOnMobile: true, cell: (s) => <span className="text-xs tabular-nums" title="Pages requested to look for changes; unchanged = 304 Not Modified or the same SEO fingerprint">{fmtNum(s.checked)} · {fmtNum(s.unchanged)} unchanged</span> },
                { key: 'crawled', header: 'Crawled', cell: (s) => (s.crawlRunId ? <Link to={`/crawls/${s.crawlRunId}`} className="text-xs tabular-nums text-signal hover:underline">{fmtNum(s.crawled)}</Link> : <span className="text-xs tabular-nums">{fmtNum(s.crawled)}</span>) },
                { key: 'why', header: 'Why', hideOnMobile: true, cell: (s) => <SyncReasons s={s} /> },
                { key: 'issues', header: 'Issues', hideOnMobile: true, cell: (s) => (s.newIssues !== undefined ? <span className="text-xs tabular-nums">{s.newIssues} new · {s.resolvedIssues ?? 0} resolved</span> : <span className="text-xs text-faint">—</span>) },
              ]}
            />
          )}
        </div>
      )}
    </Panel>
  );
}
