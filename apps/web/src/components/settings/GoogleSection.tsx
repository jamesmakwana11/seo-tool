import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Copy, ExternalLink, Gauge, KeyRound, LineChart, LogIn, PlugZap, RefreshCw, Search, Trash2, Unplug } from 'lucide-react';
import {
  CWV_MAX_URLS, type GoogleAccount, type GoogleProduct, type GoogleSiteMapping, type GoogleStatus,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { Badge, Button, Field, Input, KV, LoadingBlock, Mono, Notice, Panel, Select, Textarea, Toggle, type Tone, ErrorState } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { appBasePath } from '@/lib/basePath';
import { fmtDateTime, fmtRelative } from '@/lib/format';

/** The address the browser uses for Sentinel (redirect URI when no app address is configured on the server). */
export const browserOrigin = () => (typeof window === 'undefined' ? undefined : `${window.location.origin}${appBasePath()}`);

const REASONS: Record<string, string> = {
  bad_state: 'The sign-in link expired or was already used. Click Connect Google account again.',
  denied: 'Access was not granted on Google’s consent screen.',
  missing_scopes: 'Google did not grant Analytics or Search Console access. Connect again and keep both boxes ticked on the consent screen.',
  redirect_uri_mismatch: 'Google refused the redirect address. In Google Cloud, add the exact redirect URI shown below to the OAuth client’s Authorized redirect URIs.',
  invalid_client: 'Google rejected the Client ID or Client secret. Check them below.',
  no_refresh_token: 'Google returned no long-lived access. Remove Sentinel’s access in the Google account’s security settings, then connect again.',
  different_account: 'You signed in with a different Google account than the one being reconnected.',
  not_configured: 'The Google OAuth client is not set up.',
};

const MAP_TONE: Record<GoogleSiteMapping['state'], Tone> = { connected: 'ok', not_tested: 'med', failed: 'crit', expired: 'crit', not_mapped: 'neutral', rate_limited: 'med' };
const MAP_LABEL: Record<GoogleSiteMapping['state'], string> = { connected: 'Connected', not_tested: 'Not tested', failed: 'Failed', expired: 'Reconnect needed', not_mapped: 'Not connected', rate_limited: 'Rate limited' };
const ACCOUNT_TONE: Record<GoogleAccount['state'], Tone> = { connected: 'ok', expired: 'crit', error: 'crit' };

const invalidate = [['google'], ['integrations'], ['audit']];

/**
 * Integrations → Google: the OAuth client, Google accounts (Connect / Reconnect / Test / Disconnect) and this website's
 * Google Analytics 4, Search Console and Core Web Vitals (PageSpeed Insights). Secrets go to the server once and are
 * never shown again.
 */
export function GoogleSection() {
  const q = useApiQuery(['google', 'status'], () => api.getGoogleStatus(browserOrigin()));
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  useEffect(() => {
    const g = params.get('google');
    if (!g) return;
    if (g === 'connected') toast.success(`Google account ${params.get('account') ?? ''} connected — choose its properties for this website below.`);
    else toast.error(REASONS[params.get('reason') ?? ''] ?? `Google sign-in did not complete (${params.get('reason') ?? 'unknown reason'}).`);
    params.delete('google'); params.delete('reason'); params.delete('account'); params.delete('site');
    setParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} title="Google connections could not load" />;
  if (!q.data) return <LoadingBlock rows={6} label="Loading Google connections" />;
  const s = q.data;
  return (
    <section aria-labelledby="google-heading" className="space-y-5" data-testid="google-section">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="google-heading" className="text-[17px] font-semibold tracking-tight text-ink">Google</h2>
          <p className="text-sm text-muted">Analytics, Search Console and Core Web Vitals for <span className="font-medium text-ink">{s.website.name}</span>. Each website chooses its own Google account and properties.</p>
        </div>
      </div>
      {!s.canStore && <Notice tone="crit" title="Credentials cannot be stored on this server">{s.storeProblem}</Notice>}
      {s.canStore && !s.persistent && <Notice tone="med">This server has no database (DATABASE_URL), so Google connections are kept only until the server restarts. With a database they are stored encrypted and survive restarts.</Notice>}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <OAuthClientPanel s={s} />
        <AccountsPanel s={s} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <MappingPanel s={s} product="ga4" />
        <MappingPanel s={s} product="gsc" />
        <CwvPanel s={s} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ OAuth client

function OAuthClientPanel({ s }: { s: GoogleStatus }) {
  const o = s.oauth;
  const [editing, setEditing] = useState(!o.configured && o.source !== 'env');
  const [clientId, setClientId] = useState(o.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [appUrl, setAppUrl] = useState(o.appUrlSource === 'saved' ? o.appUrl ?? '' : '');
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const save = useApiMutation(() => api.saveGoogleOAuthClient({ clientId: clientId.trim(), clientSecret: secret.trim() || undefined, appUrl: appUrl.trim() || undefined, origin: browserOrigin() }), {
    success: 'Google OAuth client saved — the secret is stored encrypted', invalidate, onSuccess: () => { setSecret(''); setEditing(false); },
  });
  const remove = useApiMutation(() => api.removeGoogleOAuthClient(), { success: 'Google OAuth client removed', invalidate, onSuccess: () => { setConfirm(false); setEditing(true); setClientId(''); } });
  const copy = (v: string) => { void navigator.clipboard?.writeText(v).then(() => toast.success('Copied'), () => toast.error('Copy failed — select the text and copy it.')); };
  return (
    <Panel title="Google sign-in (OAuth client)" subtitle="One-time setup in Google Cloud" actions={<Badge tone={o.configured ? 'ok' : 'med'}>{o.configured ? 'Ready' : 'Setup needed'}</Badge>}>
      <div className="space-y-4">
        {o.problem && <p className="text-sm text-ink-soft">{o.problem}</p>}
        {o.redirectUri && (
          <div>
            <p className="mb-1 text-xs text-muted">Authorized redirect URI — add exactly this to the OAuth client in Google Cloud</p>
            <div className="flex items-center gap-2 rounded-ctl border border-line bg-canvas px-2.5 py-1.5">
              <Mono className="min-w-0 flex-1 truncate">{o.redirectUri}</Mono>
              <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(o.redirectUri!)} aria-label="Copy redirect URI">Copy</Button>
            </div>
            {o.appUrlSource === 'request' && <p className="mt-1 text-xs text-muted">Taken from the address you are using now. If people open Sentinel at another address, enter it as “Sentinel address” below.</p>}
          </div>
        )}
        <details className="rounded-ctl border border-line px-3 py-2 text-sm text-ink-soft">
          <summary className="cursor-pointer font-medium text-ink">How to create the OAuth client (once)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>In Google Cloud Console open (or create) a project → APIs &amp; Services → Library, and enable: Google Analytics Admin API, Google Analytics Data API, Google Search Console API, PageSpeed Insights API.</li>
            <li>APIs &amp; Services → OAuth consent screen: set it up for your organisation (Internal for Google Workspace, or External and publish it — apps in “Testing” lose access after 7 days).</li>
            <li>Credentials → Create credentials → OAuth client ID → type “Web application”. Under Authorized redirect URIs add the address shown above.</li>
            <li>Copy the Client ID and Client secret into the form here. Sentinel asks only for read-only Analytics and Search Console access.</li>
          </ol>
        </details>
        {!editing ? (
          <>
            <KV items={[
              { k: 'Client ID', v: o.clientId ? <Mono className="break-all">{o.clientId}</Mono> : <span className="text-muted">Not set</span> },
              { k: 'Client secret', v: o.secretSet ? 'Saved (encrypted, never shown)' : <span className="text-muted">Not set</span> },
              { k: 'Source', v: o.source === 'env' ? 'Server environment (GOOGLE_OAUTH_CLIENT_ID)' : o.updatedAt ? `Saved ${fmtDateTime(o.updatedAt)} IST${o.updatedBy ? ` by ${o.updatedBy}` : ''}` : '—' },
            ]} />
            <div className="flex flex-wrap gap-2">
              <Button icon={<KeyRound className="h-4 w-4" />} onClick={() => setEditing(true)}>{o.source === 'saved' ? 'Change' : 'Enter client'}</Button>
              {o.source === 'saved' && <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirm(true)}>Remove</Button>}
            </div>
          </>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Client ID" htmlFor="g-client-id" required>
              <Input id="g-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789012-abc….apps.googleusercontent.com" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
            </Field>
            <Field label="Client secret" htmlFor="g-client-secret" hint={o.secretSet ? 'Leave empty to keep the saved secret.' : 'Stored encrypted on the server; never shown again.'} required={!o.secretSet}>
              <Input id="g-client-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={o.secretSet ? '•••••••• (saved)' : 'GOCSPX-…'} autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
            </Field>
            <Field label="Sentinel address (optional)" htmlFor="g-app-url" hint="The public address people use for Sentinel, e.g. https://apps.deodap.info/seo-tool. Leave empty to use the server’s configured address or the one in your browser.">
              <Input id="g-app-url" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder={o.appUrl ?? 'https://…'} autoComplete="off" spellCheck={false} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" loading={save.isPending} disabled={!clientId.trim() || (!o.secretSet && !secret.trim())}>Save client</Button>
              {(o.configured || o.source === 'env') && <Button variant="ghost" onClick={() => { setEditing(false); setSecret(''); }}>Cancel</Button>}
            </div>
          </form>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Remove client"
        title="Remove the Google OAuth client?" body="Connected Google accounts stop working until a client is saved again. Their stored access is kept." />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ accounts

function AccountsPanel({ s }: { s: GoogleStatus }) {
  const [confirm, setConfirm] = useState<GoogleAccount | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const start = useApiMutation((accountId?: string) => api.startGoogleOAuth({ origin: browserOrigin(), accountId }), {
    onSuccess: (r) => { window.location.assign(r.authorizeUrl); },
  });
  const test = useApiMutation((id: string) => api.testGoogleAccount(id), {
    invalidate, onSuccess: (r) => setResults((x) => ({ ...x, [test.variables!]: r })),
  });
  const disconnect = useApiMutation((id: string) => api.disconnectGoogleAccount(id), { success: 'Google account disconnected — its stored access was removed', invalidate, onSuccess: () => setConfirm(null) });
  return (
    <Panel title="Google accounts" subtitle="Read-only access to Analytics and Search Console" actions={<Button size="sm" variant="primary" icon={<LogIn className="h-4 w-4" />} disabled={!s.oauth.configured || !s.canStore} loading={start.isPending && !start.variables} onClick={() => start.mutate(undefined)}>Connect Google account</Button>}>
      {!s.oauth.configured && <p className="mb-3 text-sm text-muted">Save the OAuth client first — then connect the Google account that has access to your GA4 and Search Console properties.</p>}
      {s.accounts.length ? (
        <ul className="divide-y divide-line" data-testid="google-accounts">
          {s.accounts.map((a) => (
            <li key={a.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-medium text-ink">{a.email}</span>
                <Badge tone={ACCOUNT_TONE[a.state]}>{a.state === 'connected' ? 'Connected' : a.state === 'expired' ? 'Access expired' : 'Error'}</Badge>
                {a.products.map((p) => <Badge key={p}>{p === 'ga4' ? 'Analytics' : 'Search Console'}</Badge>)}
              </div>
              {a.stateDetail && a.state !== 'connected' && <p className="text-sm text-crit-ink">{a.stateDetail}</p>}
              <p className="text-xs text-muted">
                Connected {fmtRelative(a.connectedAt)}{a.connectedBy ? ` by ${a.connectedBy}` : ''}
                {a.usedBy.length ? ` · used by ${a.usedBy.map((u) => `${u.websiteName} (${u.product === 'ga4' ? 'GA4' : 'Search Console'})`).join(', ')}` : ' · not used by any website yet'}
              </p>
              {(results[a.id] || a.lastTestResult) && (
                <p className={`text-xs ${(results[a.id]?.ok ?? a.lastTestOk) === false ? 'text-crit-ink' : 'text-ok-ink'}`} role="status">{results[a.id]?.message ?? a.lastTestResult}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={<PlugZap className="h-3.5 w-3.5" />} loading={test.isPending && test.variables === a.id} onClick={() => test.mutate(a.id)}>Test connection</Button>
                <Button size="sm" variant={a.state === 'connected' ? 'ghost' : 'primary'} icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={!s.oauth.configured} loading={start.isPending && start.variables === a.id} onClick={() => start.mutate(a.id)}>Reconnect</Button>
                <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => setConfirm(a)}>Disconnect</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">No Google account connected yet.</p>}
      <ConfirmDialog
        open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => confirm && disconnect.mutate(confirm.id)} loading={disconnect.isPending} danger confirmLabel="Disconnect"
        title={`Disconnect ${confirm?.email ?? ''}?`}
        body={confirm?.usedBy.length ? `Sentinel revokes and removes its access. ${confirm.usedBy.map((u) => u.websiteName).join(', ')} then need another account for their reports.` : 'Sentinel revokes and removes its access.'}
      />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ GA4 / Search Console mapping

function MappingPanel({ s, product }: { s: GoogleStatus; product: GoogleProduct }) {
  const m = s[product];
  const title = product === 'ga4' ? 'Google Analytics 4' : 'Google Search Console';
  const usable = s.accounts.filter((a) => a.products.includes(product) && a.state !== 'error');
  const [editing, setEditing] = useState(m.via !== 'oauth');
  const [accountId, setAccountId] = useState(m.accountId ?? usable[0]?.id ?? '');
  const [property, setProperty] = useState(m.property ?? '');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!accountId && usable[0]) setAccountId(usable[0].id); }, [usable.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const props = useApiQuery(['google', 'props', product, accountId], () => (product === 'ga4' ? api.listGa4Properties(accountId).then((l) => l.map((p) => ({ value: p.propertyId, label: `${p.displayName} — ${p.accountName} (${p.propertyId})`, usable: true }))) : api.listGscSites(accountId).then((l) => l.map((p) => ({ value: p.siteUrl, label: `${p.siteUrl}${p.usable ? '' : ' — unverified'}`, usable: p.usable })))), { enabled: editing && !!accountId });
  const save = useApiMutation(() => api.setGoogleMapping(product, { accountId, property }), {
    invalidate, success: (r) => (r.test.ok ? `${title} connected for ${s.website.name}` : `${title} saved, but the test failed`),
    onSuccess: (r) => { setMessage({ ok: r.test.ok, text: r.test.message }); setEditing(false); },
  });
  const test = useApiMutation(() => api.testGoogleMapping(product), { invalidate, onSuccess: (r) => setMessage({ ok: r.ok, text: r.message }) });
  const clear = useApiMutation(() => api.clearGoogleMapping(product), { success: `${title} disconnected from ${s.website.name}`, invalidate, onSuccess: () => { setConfirm(false); setEditing(true); setProperty(''); setMessage(null); } });
  const options = props.data ?? [];
  return (
    <Panel title={title} subtitle={product === 'ga4' ? 'Users, sessions, engagement, traffic sources, conversions' : 'Clicks, impressions, CTR, position, indexing'} actions={<Badge tone={MAP_TONE[m.state]}>{MAP_LABEL[m.state]}</Badge>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">{m.stateDetail}</p>
        {m.via === 'oauth' && !editing && (
          <KV cols={1} items={[
            { k: 'Google account', v: m.accountEmail ?? <span className="text-crit-ink">No longer connected</span> },
            { k: product === 'ga4' ? 'GA4 property' : 'Search Console property', v: <>{m.propertyName ?? <Mono>{m.property}</Mono>}{m.propertyName && <span className="block font-mono text-xs text-muted">{m.property}</span>}</> },
            { k: 'Last test', v: m.lastTestAt ? `${fmtDateTime(m.lastTestAt)} IST` : <span className="text-muted">Never</span> },
          ]} />
        )}
        {message && <p className={`text-sm ${message.ok ? 'text-ok-ink' : 'text-crit-ink'}`} role="status">{message.text}</p>}
        {editing ? (
          usable.length ? (
            <div className="space-y-3">
              <Field label="Google account" htmlFor={`${product}-acct`}>
                <Select id={`${product}-acct`} value={accountId} onChange={(e) => { setAccountId(e.target.value); setProperty(''); }} className="w-full">
                  {usable.map((a) => <option key={a.id} value={a.id}>{a.email}{a.state === 'expired' ? ' (reconnect needed)' : ''}</option>)}
                </Select>
              </Field>
              <Field label={product === 'ga4' ? 'GA4 property' : 'Search Console property'} htmlFor={`${product}-prop`} error={props.error ? errorMessage(props.error) : undefined}>
                <Select id={`${product}-prop`} value={property} onChange={(e) => setProperty(e.target.value)} className="w-full" disabled={props.isLoading || !options.length}>
                  <option value="">{props.isLoading ? 'Loading properties…' : options.length ? 'Choose a property…' : 'No properties visible to this account'}</option>
                  {options.map((p) => <option key={p.value} value={p.value} disabled={!p.usable}>{p.label}</option>)}
                </Select>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<PlugZap className="h-4 w-4" />} disabled={!accountId || !property} loading={save.isPending} onClick={() => save.mutate()}>Connect and test</Button>
                {m.via === 'oauth' && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
              </div>
            </div>
          ) : <p className="text-sm text-muted">Connect a Google account{product === 'gsc' ? ' with Search Console access' : ' with Analytics access'} first.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<PlugZap className="h-3.5 w-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(true); setMessage(null); }}>Change</Button>
            <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => setConfirm(true)}>Disconnect</Button>
          </div>
        )}
        {m.state === 'connected' && (
          <Link to={product === 'ga4' ? '/insights/analytics' : '/insights/search-console'} className="inline-flex items-center gap-1 text-sm font-medium text-signal hover:underline">
            {product === 'ga4' ? <LineChart className="h-4 w-4" /> : <Search className="h-4 w-4" />} Open the report
          </Link>
        )}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => clear.mutate()} loading={clear.isPending} danger confirmLabel="Disconnect"
        title={`Disconnect ${title} from ${s.website.name}?`} body="The Google account stays connected (other websites can keep using it). Stored report history is kept." />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ PageSpeed Insights / Core Web Vitals

function CwvPanel({ s }: { s: GoogleStatus }) {
  const p = s.psi;
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [urls, setUrls] = useState(s.cwv.urls.join('\n'));
  const [auto, setAuto] = useState(s.cwv.autoDaily);
  const [confirm, setConfirm] = useState(false);
  const save = useApiMutation(() => api.savePsiKey(key.trim()), { success: 'PageSpeed Insights connected — the key is stored encrypted', invalidate: [...invalidate, ['cwv']], onSuccess: () => { setKey(''); setReplacing(false); setMessage(null); } });
  const test = useApiMutation(() => api.testPsi(), { invalidate: [...invalidate, ['cwv']], onSuccess: (r) => setMessage({ ok: r.ok, text: r.message }) });
  const remove = useApiMutation(() => api.removePsiKey(), { success: 'PageSpeed Insights key removed', invalidate, onSuccess: () => setConfirm(false) });
  const lines = useMemo(() => urls.split('\n').map((x) => x.trim()).filter(Boolean), [urls]);
  const dirty = lines.join('\n') !== s.cwv.urls.join('\n') || auto !== s.cwv.autoDaily;
  const saveSettings = useApiMutation(() => api.saveCwvSettings({ urls: lines, autoDaily: auto }), { success: 'Core Web Vitals pages saved', invalidate: [['google'], ['cwv']] });
  const showForm = p.keySource === 'none' || replacing;
  return (
    <Panel title="Core Web Vitals" subtitle="PageSpeed Insights — mobile and desktop" actions={<Badge tone={p.connected ? 'ok' : p.keySource === 'none' ? 'neutral' : 'crit'}>{p.connected ? 'Connected' : p.keySource === 'none' ? 'Not connected' : 'Failed'}</Badge>}>
      <div className="space-y-3">
        {p.problem && <Notice tone="crit">{p.problem}</Notice>}
        <KV cols={1} items={[
          { k: 'API key', v: p.keySource === 'saved' ? `Saved (encrypted)${p.connectedAt ? ` ${fmtRelative(p.connectedAt)}${p.connectedBy ? ` by ${p.connectedBy}` : ''}` : ''}` : p.keySource === 'env' ? 'From the server environment (GOOGLE_API_KEY)' : <span className="text-muted">Not set</span> },
          { k: 'Last check', v: p.lastTestAt ? <>{fmtDateTime(p.lastTestAt)} IST<span className={`block text-xs ${p.lastTestOk === false ? 'text-crit-ink' : 'text-muted'}`}>{p.lastTestResult}</span></> : <span className="text-muted">Never</span> },
          { k: 'Last run for this website', v: s.cwv.lastRunAt ? `${fmtRelative(s.cwv.lastRunAt)}${s.cwv.lastRunOk === false ? ' (failed)' : ''}` : <span className="text-muted">Never</span> },
        ]} />
        {message && <p className={`text-sm ${message.ok ? 'text-ok-ink' : 'text-crit-ink'}`} role="status">{message.text}</p>}
        {showForm ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            <Field label="Google API key" htmlFor="psi-key" hint="Google Cloud → APIs & Services → Credentials → API key, with the PageSpeed Insights API enabled. Sentinel runs one real test before saving it.">
              <Input id="psi-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={save.isPending} disabled={!key.trim() || !s.canStore}>{save.isPending ? 'Testing…' : 'Test and save'}</Button>
              {replacing && <Button variant="ghost" onClick={() => { setReplacing(false); setKey(''); }}>Cancel</Button>}
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<PlugZap className="h-3.5 w-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
            <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>{p.keySource === 'saved' ? 'Replace key' : 'Enter a key'}</Button>
            {p.keySource === 'saved' && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirm(true)}>Remove</Button>}
          </div>
        )}
        <div className="space-y-2 border-t border-line pt-3">
          <Field label={`Pages to test (up to ${CWV_MAX_URLS})`} htmlFor="cwv-urls" hint="One address or path per line, on this website. Empty = the homepage.">
            <Textarea id="cwv-urls" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={`${s.website.url}/\n/products/…`} className="font-mono text-[13px]" />
          </Field>
          <Toggle checked={auto} onChange={setAuto} label="Test every day at 01:30 IST (mobile and desktop)" />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!dirty || lines.length > CWV_MAX_URLS} loading={saveSettings.isPending} onClick={() => saveSettings.mutate()}>Save pages</Button>
            {lines.length > CWV_MAX_URLS && <span className="text-xs text-crit-ink">At most {CWV_MAX_URLS} pages.</span>}
            <Link to="/insights/core-web-vitals" className="inline-flex items-center gap-1 text-sm font-medium text-signal hover:underline"><Gauge className="h-4 w-4" /> Open the report</Link>
          </div>
        </div>
        <a href="https://developers.google.com/speed/docs/insights/v5/get-started" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-signal">How to get a PageSpeed Insights key <ExternalLink className="h-3 w-3" /></a>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} danger confirmLabel="Remove key"
        title="Remove the PageSpeed Insights key?" body="Core Web Vitals tests stop for every website. Stored results are kept." />
    </Panel>
  );
}
