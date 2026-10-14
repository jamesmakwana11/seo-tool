import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ROLE_LABELS, TEAMS } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Code, DemoBadge, KV, Mono, Notice, PageHeader, Panel, Toggle } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { fmtDateTime } from '@/lib/format';

export default function DiagnosticsPage() {
  const [auto, setAuto] = useState(false);
  const q = useApiQuery(['diagnostics'], () => api.getDiagnostics(), { refetchInterval: auto ? 5000 : undefined });
  return (
    <div>
      <PageHeader
        title="API diagnostics"
        description="For developers: which API adapter the app is using, the endpoint contract, and the most recent requests."
        meta={<DemoBadge />}
        actions={<Button icon={<RefreshCw className="h-4 w-4" />} loading={q.isFetching && !q.isLoading} onClick={() => void q.refetch()}>Refresh</Button>}
      />
      <Async q={q} rows={10}>
        {(d) => (
          <div className="space-y-5">
            <Panel title="Adapter">
              <div className="space-y-4">
                <KV cols={3} items={[
                  { k: 'Mode', v: <Badge tone={d.mode === 'mock' ? 'demo' : 'ok'}>{d.mode === 'mock' ? 'mock (in-browser DEMO)' : 'http'}</Badge> },
                  { k: 'Version', v: <Mono>{d.version}</Mono> },
                  { k: 'Base URL', v: d.baseUrl ? <Mono>{d.baseUrl}</Mono> : <span className="text-muted">None — requests never leave the browser</span> },
                ]} />
                <Notice tone="signal" title="Switching to the real backend">
                  <p>Phase 1 runs the in-browser mock adapter: every call goes through the same <Mono>SentinelApi</Mono> contract, with permission checks and validation, but data is DEMO and resets on reload. When the Phase 2 API server exists, start the web app with:</p>
                  <div className="mt-2"><Code language="shell">{'VITE_API_MODE=http npm run dev   # proxies /api → http://localhost:4000'}</Code></div>
                  <p className="mt-2">Until the http client is built, <Mono>VITE_API_MODE=http</Mono> fails fast at start-up rather than silently falling back to DEMO data.</p>
                </Notice>
              </div>
            </Panel>

            <Panel
              title="Recent requests"
              subtitle={`Last ${d.recent.length} calls through the adapter (newest first)`}
              actions={<label className="flex items-center gap-2 text-sm"><Toggle checked={auto} onChange={setAuto} label="Auto-refresh every 5 seconds" /> Auto-refresh (5s)</label>}
              bodyClassName="p-3"
            >
              <DataTable
                rows={d.recent}
                rowKey={(r) => `${r.at}-${r.path}-${r.ms}`}
                dense
                pageSize={15}
                caption="Recent API requests"
                empty={<p className="p-4 text-sm text-muted">No requests yet.</p>}
                columns={[
                  { key: 'at', header: 'When (IST)', cell: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.at)}</span> },
                  { key: 'm', header: 'Method', cell: (r) => <Mono className="text-xs">{r.method}</Mono> },
                  { key: 'p', header: 'Path / operation', cell: (r) => <Mono className="text-xs">{r.path}</Mono> },
                  { key: 's', header: 'Status', cell: (r) => <Badge tone={r.status < 300 ? 'ok' : r.status < 500 ? 'med' : 'crit'}>{r.status}</Badge> },
                  { key: 'ms', header: 'Time', cell: (r) => <span className="tabular-nums text-xs">{r.ms} ms</span> },
                  { key: 'rid', header: 'Request id', cell: (r) => (r.requestId ? <Mono className="text-xs">{r.requestId}</Mono> : '—'), hideOnMobile: true },
                ]}
              />
            </Panel>

            <Panel title="Endpoint contract" subtitle="Planned HTTP routes and the permission each one enforces server-side" bodyClassName="p-3">
              <DataTable
                rows={d.endpoints}
                rowKey={(e) => `${e.method} ${e.path}`}
                dense
                caption="API endpoints"
                search={(e) => `${e.method} ${e.path} ${e.description} ${e.permission ?? ''}`}
                searchPlaceholder="Search endpoints"
                columns={[
                  { key: 'm', header: 'Method', cell: (e) => <Mono className="text-xs">{e.method}</Mono> },
                  { key: 'p', header: 'Path', cell: (e) => <Mono className="text-xs">{e.path}</Mono> },
                  { key: 'perm', header: 'Permission', cell: (e) => (e.permission ? <Mono className="text-xs">{e.permission}</Mono> : <span className="text-xs text-muted">signed-in / per-record</span>) },
                  { key: 'd', header: 'Description', cell: (e) => <span className="text-xs">{e.description}</span> },
                ]}
              />
            </Panel>

            <SessionPanel />
          </div>
        )}
      </Async>
    </div>
  );
}

function SessionPanel() {
  const { user: u } = useAuth();
  if (!u) return null;
  return (
    <Panel title="Current session">
      <div className="space-y-4">
        <KV cols={3} items={[
          { k: 'User', v: <>{u.name}<span className="block text-xs text-muted">{u.email}</span></> },
          { k: 'Role', v: <>{ROLE_LABELS[u.role]}{u.isSeoLead && <Badge tone="signal" className="ml-1">SEO lead</Badge>}</> },
          { k: 'Teams', v: u.teamIds.map((t) => TEAMS[t].shortName).join(', ') || '—' },
          { k: 'Session type', v: u.demo ? <Badge tone="demo">Development role preview</Badge> : <Badge>Signed in</Badge> },
          { k: 'User id', v: <Mono>{u.id}</Mono> },
        ]} />
        <div>
          <p className="mb-1.5 text-xs text-muted">Permissions ({u.permissions.length})</p>
          <ul className="flex flex-wrap gap-1.5">{[...u.permissions].sort().map((p) => <li key={p}><Badge><span className="font-mono">{p}</span></Badge></li>)}</ul>
        </div>
      </div>
    </Panel>
  );
}
