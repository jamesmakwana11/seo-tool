import { useState } from 'react';
import { KeyRound, PlugZap, Unplug } from 'lucide-react';
import type { ClaudeModelOption, ClaudeStatus, IntegrationStatus } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Field, Input, KV, LoadingBlock, Notice, Panel, Select } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { IntegrationStateBadge } from '@/components/settings/ConfigSection';
import { fmtDateTime } from '@/lib/format';

/**
 * Claude AI on the Integrations screen: the Anthropic API key is typed here once, sent to the API server (HTTPS),
 * checked with Anthropic and stored encrypted there. It is never shown again or returned by the server — the card only
 * shows that a key is saved, the model and the last result.
 */
export function ClaudeCard({ i }: { i: IntegrationStatus }) {
  const { can } = useAuth();
  const canManage = can('integrations.manage');
  const q = useApiQuery(['claude'], () => api.getClaudeStatus());
  const s = q.data;
  return (
    <Panel
      title={i.name}
      subtitle={<span className="flex flex-wrap items-center gap-1.5">AI engines{i.costNote && <Badge tone="med">{i.costNote}</Badge>}</span>}
      actions={<IntegrationStateBadge state={i.state} />}
    >
      <div className="space-y-4" data-testid="claude-card">
        <p className="text-sm text-ink-soft">{i.stateDetail}</p>
        {!s ? <LoadingBlock rows={2} /> : (
          <>
            <KV items={[
              { k: 'Used for', v: i.usedFor },
              ...(s.connected ? [{ k: 'Model', v: <>{s.modelName ?? s.model}<span className="block font-mono text-xs text-muted">{s.model}</span></> }] : []),
              ...(s.connectedAt ? [{ k: 'Connected', v: `${fmtDateTime(s.connectedAt)} IST${s.connectedBy ? ` by ${s.connectedBy}` : ''}` }] : []),
              { k: 'Last check', v: s.lastTestAt ? <>{fmtDateTime(s.lastTestAt)} IST<span className={`block text-xs ${s.lastTestOk === false ? 'text-crit-ink' : 'text-muted'}`}>{s.lastTestResult}</span></> : <span className="text-muted">{s.lastTestResult ?? 'Never'}</span> },
              ...(s.usage.requests ? [{ k: 'Requests since the server started', v: <>{s.usage.requests} · {s.usage.failures} failed{s.usage.lastError && <span className="block text-xs text-muted">Last error {s.usage.lastErrorAt ? fmtDateTime(s.usage.lastErrorAt) : ''}: {s.usage.lastError}</span>}</> }] : []),
            ]} />
            {!s.canStore && <Notice tone="crit" title="The key cannot be stored on this server">{s.storeProblem}</Notice>}
            {s.canStore && !s.persistent && <Notice tone="med">This server has no database (DATABASE_URL), so a saved key is kept only until the server restarts. With a database it is stored encrypted and survives restarts.</Notice>}
            {canManage ? <ClaudeForm s={s} /> : <p className="text-xs text-muted">Connecting Claude needs the integrations.manage permission (Super Admin).</p>}
          </>
        )}
      </div>
    </Panel>
  );
}

function ClaudeForm({ s }: { s: ClaudeStatus }) {
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [models, setModels] = useState<ClaudeModelOption[] | null>(null);
  const [model, setModel] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [testing, setTesting] = useState(false);
  const invalidate = [['claude'], ['integrations'], ['audit']];
  const showKeyForm = !s.connected || replacing;

  const test = async (withKey: boolean) => {
    setTesting(true);
    setMessage(null);
    try {
      const r = await api.testClaude(withKey ? { apiKey: key.trim() } : {});
      setMessage({ ok: r.ok, text: r.message });
      if (r.models?.length) {
        setModels(r.models);
        setModel((cur) => cur || (r.models!.some((m) => m.id === s.model) ? s.model! : r.models!.find((m) => /sonnet/i.test(m.id))?.id ?? r.models![0].id));
      }
    } catch (e) {
      setMessage({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  const connect = useApiMutation(() => api.connectClaude({ apiKey: key.trim(), model }), {
    success: (r) => `Claude AI connected — ${r.modelName ?? r.model}`, invalidate,
    onSuccess: () => { setKey(''); setReplacing(false); setMessage(null); },
  });
  const changeModel = useApiMutation(() => api.updateClaudeModel({ model }), { success: (r) => `Model changed to ${r.modelName ?? r.model}`, invalidate });
  const disconnect = useApiMutation(() => api.disconnectClaude(), { success: 'Claude AI disconnected — the stored key was removed', invalidate, onSuccess: () => { setConfirm(false); setModels(null); setModel(''); } });

  return (
    <div className="space-y-3 rounded-ctl border border-line p-3">
      {showKeyForm ? (
        <>
          <Field label="Anthropic API key" htmlFor="claude-key" hint="From console.anthropic.com → API keys. It is sent once to the server, checked with Anthropic and stored encrypted — it is never shown again.">
            <Input id="claude-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => { setKey(e.target.value); setModels(null); setMessage(null); }} placeholder="sk-ant-…" className="font-mono text-[13px]" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button icon={<KeyRound className="h-4 w-4" />} disabled={!key.trim()} loading={testing} onClick={() => void test(true)}>Test key and load models</Button>
            {replacing && <Button variant="ghost" onClick={() => { setReplacing(false); setKey(''); setModels(null); setMessage(null); }}>Cancel</Button>}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button icon={<PlugZap className="h-4 w-4" />} loading={testing} onClick={() => void test(false)}>Test connection</Button>
          <Button variant="ghost" onClick={() => setReplacing(true)}>Replace key</Button>
          <Button variant="ghost" icon={<Unplug className="h-4 w-4" />} onClick={() => setConfirm(true)}>Disconnect</Button>
        </div>
      )}
      {message && <p className={`text-sm ${message.ok ? 'text-ok-ink' : 'text-crit-ink'}`} role="status">{message.text}</p>}
      {models && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Model" htmlFor="claude-model" hint="Used for every SEO suggestion and Fix All.">
            <Select id="claude-model" value={model} onChange={(e) => setModel(e.target.value)} className="w-full max-w-sm">
              {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
            </Select>
          </Field>
          {showKeyForm
            ? <Button variant="primary" icon={<PlugZap className="h-4 w-4" />} disabled={!model || !key.trim()} loading={connect.isPending} onClick={() => connect.mutate()}>{s.connected ? 'Save new key' : 'Connect'}</Button>
            : <Button variant="primary" disabled={!model || model === s.model} loading={changeModel.isPending} onClick={() => changeModel.mutate()}>Use this model</Button>}
        </div>
      )}
      {connect.error && <Notice tone="crit" title="Not connected">{errorMessage(connect.error)}</Notice>}
      <ConfirmDialog
        open={confirm} onClose={() => setConfirm(false)} onConfirm={() => disconnect.mutate()} loading={disconnect.isPending} danger confirmLabel="Disconnect"
        title="Disconnect Claude AI?" body="The stored API key is removed. SEO suggestions then reuse the page’s own text until Claude is connected again."
      />
    </div>
  );
}
