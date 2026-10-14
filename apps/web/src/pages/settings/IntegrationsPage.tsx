import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle, KeyRound, PlugZap, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { ApiError, SYNCABLE_INTEGRATIONS, type IntegrationStatus, type SyncableIntegrationId } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery, useSiteKey } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, DemoBadge, IconButton, Input, KV, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { FilterSelect } from '@/components/ui/filters';
import { IntegrationStateBadge } from '@/components/settings/ConfigSection';
import { fmtDateTime } from '@/lib/format';

const CATEGORY_LABEL: Record<IntegrationStatus['category'], string> = {
  crawler: 'Crawler', search: 'Search', analytics: 'Analytics', performance: 'Performance', backlinks: 'Backlinks', commerce: 'Commerce',
  local: 'Local', ai: 'AI engines', notification: 'Notifications', tasks: 'Task Ops',
};

export default function IntegrationsPage() {
  // Task Ops sync belonged to the removed task-management workflow — not offered here.
  const q = useApiQuery(['integrations'], () => api.listIntegrations().then((l) => l.filter((i) => i.category !== 'tasks')));
  const [cat, setCat] = useState('');
  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Data sources and delivery channels Sentinel needs (PDF §15, notification adapters per prompt §5.16). Each card says what it powers, what access to request, and which server environment variables to set."
        meta={<DemoBadge />}
      />
      <div className="space-y-5">
        <Notice tone="signal" icon={<KeyRound className="h-4 w-4" />} title="Secrets never go through the browser">
          API keys, tokens and passwords are set as environment variables on the API server only. This screen shows variable <em>names</em> and whether they are set — never values. The settings editor accepts non-secret options only and rejects anything that looks like a key, token or password. An integration is shown as “Connected” only after a successful connection test from the server.
        </Notice>
        <Async q={q} rows={8}>
          {(list) => {
            const connected = list.filter((i) => i.state === 'connected').length;
            const cats = [...new Set(list.map((i) => i.category))];
            const shown = cat ? list.filter((i) => i.category === cat) : list;
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted"><span className="font-semibold tabular-nums text-ink">{connected}</span> of {list.length} connected</p>
                  <FilterSelect label="Category" value={cat} onChange={setCat} options={cats.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} />
                </div>
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                  {shown.map((i) => <IntegrationCard key={i.id} i={i} />)}
                </div>
              </>
            );
          }}
        </Async>
      </div>
    </div>
  );
}

function IntegrationCard({ i }: { i: IntegrationStatus }) {
  const { can } = useAuth();
  const canManage = can('integrations.manage');
  const test = useApiMutation(() => api.testIntegration(i.id), {
    success: (r) => (r.state === 'connected' ? `${r.name}: connection test passed` : `${r.name}: not connected — ${r.lastTestResult ?? r.stateDetail}`),
    invalidate: [['integrations'], ['audit']],
  });
  const syncable = (SYNCABLE_INTEGRATIONS as readonly string[]).includes(i.id);
  const syncReady = ['connected', 'partial', 'sync_failed'].includes(i.state);
  const qc = useQueryClient();
  const siteKey = useSiteKey();
  const sync = useApiMutation(async () => {
    try {
      const r = await api.syncIntegration(i.id as SyncableIntegrationId);
      // Report exactly what happened — "not connected" and provider failures are errors, never success toasts.
      if (!r.ran) throw new ApiError(409, 'NOT_CONNECTED', `${i.name}: nothing synced — ${r.reason}`);
      if (!r.ok) throw new ApiError(502, 'SYNC_FAILED', `${i.name}: sync failed — ${r.error}`);
      return r;
    } finally {
      void qc.invalidateQueries({ queryKey: siteKey(['integrations']) }); // the card shows the recorded outcome either way
    }
  }, {
    success: (r) => `${i.name}: ${r.summary}`,
    invalidate: [['integrations'], ['audit'], ['dashboard'], ['cwv'], ['module'], ['system-health']],
  });
  return (
    <Panel
      title={i.name}
      subtitle={<span className="flex flex-wrap items-center gap-1.5">{CATEGORY_LABEL[i.category]}{i.costNote && <Badge tone="med">{i.costNote}</Badge>}</span>}
      actions={<IntegrationStateBadge state={i.state} />}
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">{i.stateDetail}</p>
        <KV
          items={[
            { k: 'Used for', v: i.usedFor },
            { k: 'Access needed (PDF §15)', v: i.accessNeeded },
            { k: 'Last connection test', v: i.lastTestAt ? <>{fmtDateTime(i.lastTestAt)} IST<span className="block text-xs text-muted">{i.lastTestResult}</span></> : <span className="text-muted">Never tested</span> },
            { k: 'Last successful sync', v: i.lastSuccessfulSyncAt ? `${fmtDateTime(i.lastSuccessfulSyncAt)} IST` : <span className="text-muted">Never</span> },
            ...(i.lastSyncError ? [{ k: 'Last sync error', v: <span className="text-crit-ink">{i.lastSyncError}</span> }] : []),
          ]}
        />
        <div>
          <p className="mb-1.5 text-xs text-muted">Server environment variables ({i.configuredVars.length} of {i.envVars.length} set)</p>
          <ul className="flex flex-wrap gap-1.5">
            {i.envVars.map((v) => {
              const set = i.configuredVars.includes(v);
              return (
                <li key={v} className={`inline-flex items-center gap-1 rounded-ctl border px-2 py-0.5 ${set ? 'border-ok/30 bg-ok-tint' : 'border-line bg-canvas'}`} title={set ? 'Set on the server' : 'Not set'}>
                  {set ? <CheckCircle2 className="h-3.5 w-3.5 text-ok-ink" aria-label="set" /> : <Circle className="h-3.5 w-3.5 text-faint" aria-label="not set" />}
                  <Mono>{v}</Mono>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <p className="mb-1.5 text-xs text-muted">Features that depend on it</p>
          <ul className="flex flex-wrap gap-1.5">{i.dependentFeatures.map((f) => <li key={f}><Badge>{f}</Badge></li>)}</ul>
        </div>
        <SettingsEditor i={i} canManage={canManage} />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button icon={<PlugZap className="h-4 w-4" />} loading={test.isPending} disabled={!canManage} title={canManage ? 'Runs a connection test from the API server' : 'Requires integrations.manage'} onClick={() => test.mutate()}>Test connection</Button>
          {syncable && (
            <Button
              icon={<RefreshCw className="h-4 w-4" />} loading={sync.isPending} disabled={!canManage || !syncReady}
              title={!canManage ? 'Requires integrations.manage' : syncReady ? 'Pull fresh data from this source now (also runs daily at 01:00 IST)' : 'Pass a connection test first'}
              onClick={() => sync.mutate()}
            >
              Sync data now
            </Button>
          )}
          {!canManage && <span className="text-xs text-muted">Testing and editing need the integrations.manage permission (Admin).</span>}
          {canManage && syncable && !syncReady && <span className="text-xs text-muted">Data sync unlocks after a passed connection test.</span>}
        </div>
      </div>
    </Panel>
  );
}

type Row = { key: string; value: string };
const toRows = (s: IntegrationStatus['settings']): Row[] => Object.entries(s).map(([key, value]) => ({ key, value: String(value) }));
const SECRETISH = /token|secret|password|key/i;

function SettingsEditor({ i, canManage }: { i: IntegrationStatus; canManage: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const value = rows ?? toRows(i.settings);
  const m = useApiMutation((s: Record<string, string | number | boolean>) => api.updateIntegration(i.id, s), {
    success: 'Integration settings saved',
    invalidate: [['integrations'], ['audit']],
    onSuccess: () => setRows(null),
  });
  const dirty = rows !== null;
  const keys = value.map((r) => r.key.trim());
  const errs: string[] = [];
  if (keys.some((k) => !k)) errs.push('Every setting needs a key.');
  if (new Set(keys).size !== keys.length) errs.push('Keys must be unique.');
  const secret = keys.find((k) => SECRETISH.test(k));
  if (secret) errs.push(`“${secret}” looks like a secret. Set secrets as environment variables on the API server instead.`);
  const save = () => {
    const out: Record<string, string | number | boolean> = {};
    for (const r of value) {
      const v = r.value.trim();
      out[r.key.trim()] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    m.mutate(out);
  };
  const update = (idx: number, p: Partial<Row>) => setRows(value.map((r, j) => (j === idx ? { ...r, ...p } : r)));
  if (!canManage && !value.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">Non-secret settings (e.g. property id, region, recipient list name)</p>
      {value.length ? (
        <ul className="space-y-2">
          {value.map((r, idx) => (
            <li key={idx} className="flex flex-wrap items-center gap-2">
              <Input aria-label="Setting key" placeholder="key" value={r.key} disabled={!canManage} onChange={(e) => update(idx, { key: e.target.value })} className="w-40 font-mono" aria-invalid={SECRETISH.test(r.key)} />
              <Input aria-label={`Value for ${r.key || 'setting'}`} placeholder="value" value={r.value} disabled={!canManage} onChange={(e) => update(idx, { value: e.target.value })} className="min-w-0 flex-1" />
              {canManage && <IconButton label={`Remove ${r.key || 'setting'}`} onClick={() => setRows(value.filter((_, j) => j !== idx))}><Trash2 className="h-4 w-4" /></IconButton>}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">No settings saved.</p>}
      {errs.map((e) => <p key={e} className="text-xs text-crit-ink" role="alert">{e}</p>)}
      {m.error && dirty && <Notice tone="crit" title="Not saved">{errorMessage(m.error)}</Notice>}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setRows([...value, { key: '', value: '' }])}>Add setting</Button>
          {dirty && <Button size="sm" variant="ghost" onClick={() => { setRows(null); m.reset(); }}>Discard</Button>}
          <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty || errs.length > 0} loading={m.isPending} onClick={save}>Save settings</Button>
        </div>
      )}
    </div>
  );
}
