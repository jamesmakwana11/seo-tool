import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Circle, KeyRound, ShieldCheck, Store, Unplug } from 'lucide-react';
import { ApiError, SHOPIFY_SCOPE_HELP, type ShopifyStatus } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Field, Input, KV, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { fmtDateTime } from '@/lib/format';

const CALLBACK_REASONS: Record<string, string> = {
  bad_hmac: 'The answer from Shopify failed the signature check, so it was ignored. If this happens again, the saved Client secret does not belong to the app with this Client ID — copy both again from the Shopify Dev Dashboard → your app → Settings.',
  bad_state: 'The connection link was already used or has expired (links last 10 minutes and work once). Start again.',
  expired: 'The answer from Shopify was too old. Start the connection again.',
  bad_shop: 'Shopify sent an invalid shop domain.',
  shop_mismatch: 'Shopify answered for a different store than the one you started with.',
  missing_scopes: 'The app was approved without all the access the SEO editor needs. Start again and approve every requested permission.',
  exchange_refused: 'Shopify refused the authorization code. Start the connection again.',
  exchange_network: 'The server could not reach Shopify to finish the connection.',
  not_configured: 'The Shopify app credentials are missing for this website — enter the Client ID and Client secret under “Shopify app credentials”.',
  workspace_gone: 'The website that started the connection no longer exists on this server (it restarted). Start again.',
  no_code: 'Shopify did not send an authorization code (the approval was cancelled). Start the connection again.',
  exchange_failed: 'The server could not finish the connection with Shopify. Start the connection again.',
  exchange_bad_response: 'Shopify answered the token request unexpectedly. Start the connection again.',
};

/** Same rule as the server: “deodap”, “deodap.myshopify.com” or the admin URL → “deodap.myshopify.com”. */
function myshopifyDomain(input: string): string | undefined {
  let v = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!v) return undefined;
  if (!v.includes('.')) v = `${v}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(v) ? v : undefined;
}

export default function ShopifyPage() {
  const q = useApiQuery(['shopify', 'status'], () => api.getShopifyStatus());
  const [params] = useSearchParams();
  const result = params.get('shopify');
  const reason = params.get('reason') ?? '';
  return (
    <div>
      <PageHeader
        title="Shopify"
        description="Connect the store so the SEO editor can read products, collections, pages and articles, and — after you confirm each batch — write SEO fixes back."
      />
      <div className="space-y-5">
        {result === 'connected' && <Notice tone="signal" icon={<CheckCircle2 className="h-4 w-4" />} title="Store connected">The SEO editor can now read and, after confirmation, change content in this store.</Notice>}
        {result === 'error' && <Notice tone="crit" title="Connection not completed">{CALLBACK_REASONS[reason] ?? `Shopify connection failed (${reason || 'unknown reason'}).`}</Notice>}
        <Async q={q} rows={6}>{(st) => <Connection st={st} />}</Async>
      </div>
    </div>
  );
}

function Connection({ st }: { st: ShopifyStatus }) {
  const { can } = useAuth();
  const toast = useToast();
  const [shop, setShop] = useState(st.shop ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const disconnect = useApiMutation(() => api.disconnectShopify(), { success: 'Disconnected — the token was dropped from server memory', invalidate: [['shopify']], onSuccess: () => setConfirmOff(false) });
  const [startError, setStartError] = useState<string | null>(null);
  const domain = myshopifyDomain(shop);
  const shopError = shop.trim() && !domain ? 'Enter the store’s .myshopify.com domain (Shopify admin → Settings → Domains), e.g. deodap.myshopify.com — not the storefront domain.' : undefined;
  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!domain) { setStartError(shopError ?? 'Enter the store’s .myshopify.com domain.'); return; }
    setBusy(true);
    setStartError(null);
    try {
      const r = await api.startShopifyOAuth(domain);
      window.location.assign(r.authorizeUrl);
    } catch (err) {
      // Shown next to the button (and as a toast): the reason is never lost.
      setStartError(errorMessage(err));
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };
  const manage = can('integrations.manage');
  const missingOpt = st.missingOptionalScopes;
  return (
    <>
      <Panel
        title={<span className="inline-flex items-center gap-2"><Store className="h-4 w-4" />{st.connected ? (st.shopName ?? st.shop) : 'Not connected'}</span>}
        subtitle={st.connected ? `${st.shop} · ${st.via === 'oauth' ? 'connected with OAuth on this server' : 'token from SHOPIFY_ADMIN_TOKEN'}` : 'No Shopify store is connected for this website.'}
        actions={st.connected && manage ? <Button variant="ghost" icon={<Unplug className="h-4 w-4" />} onClick={() => setConfirmOff(true)}>Disconnect</Button> : undefined}
      >
        <div className="mt-3 space-y-4">
          {st.problems.filter((_p, k) => !(k === 0 && !st.connected && manage && !st.oauthConfigured)).map((p) => <Notice key={p} tone="med">{p}</Notice>)}
          {st.connected && (
            <KV
              cols={3}
              items={[
                { k: 'Admin API version', v: <Mono>{st.apiVersion}</Mono> },
                { k: 'Connected', v: st.connectedAt ? `${fmtDateTime(st.connectedAt)}${st.connectedBy ? ` by ${st.connectedBy}` : ''}` : '—' },
                { k: 'SEO editor', v: st.capabilities.edit ? <Badge tone="ok">Can read and write</Badge> : <Badge tone="crit">Blocked</Badge> },
                { k: 'Themes', v: st.capabilities.themeWrite ? <Badge tone="ok">Read + write unpublished themes</Badge> : st.capabilities.themes ? <Badge tone="med">Read only</Badge> : <Badge>Not available</Badge> },
                { k: 'Image alt text', v: st.capabilities.imageAlt ? <Badge tone="ok">Can change</Badge> : <Badge>Not available</Badge> },
              ]}
            />
          )}
          {!st.connected && manage && (
            <form onSubmit={start} className="space-y-3" data-testid="shopify-connect-form">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[260px] flex-1">
                  <Field label="Store" htmlFor="shop" hint="The myshopify.com domain, e.g. deodap.myshopify.com" error={shopError}>
                    <Input id="shop" value={shop} onChange={(e) => { setShop(e.target.value); setStartError(null); }} placeholder="your-store.myshopify.com" className="font-mono text-[13px]" aria-invalid={!!shopError} />
                  </Field>
                </div>
                <Button type="submit" variant="primary" loading={busy} disabled={!st.oauthConfigured || !domain} title={!st.oauthConfigured ? 'Not set up on the server — see the message below' : !domain ? 'Enter the .myshopify.com domain first' : undefined}>Connect with Shopify</Button>
              </div>
              {!st.oauthConfigured && (
                <div data-testid="shopify-not-configured">
                  <Notice tone="crit" title="Connect with Shopify is not available yet">
                    {st.problems[0] ?? 'The Shopify app credentials are not set on the API server.'}
                  </Notice>
                </div>
              )}
              {startError && <Notice tone="crit" title="Could not start the connection">{startError}</Notice>}
            </form>
          )}
          {!st.connected && !manage && <p className="text-sm text-muted">Ask an administrator to connect the store.</p>}
          {st.redirectUrl && !st.connected && (
            <p className="text-xs text-muted">Allowed redirection URL to add in the Shopify app settings: <Mono className="text-xs">{st.redirectUrl}</Mono></p>
          )}
        </div>
      </Panel>

      {manage && <AppCredentials st={st} />}

      <Panel title="Access the app asks for" subtitle="Shopify shows these on the approval screen. A write permission includes reading.">
        <ul className="mt-3 space-y-2 text-sm">
          {[...st.requiredScopes, ...st.optionalScopes].map((s) => {
            const has = st.connected && !st.missingScopes.includes(s) && !missingOpt.includes(s) && st.scopes.length > 0;
            return (
              <li key={s} className="flex gap-2">
                {has ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok-ink" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-faint" />}
                <span><Mono className="text-xs">{s}</Mono>{st.optionalScopes.includes(s) && <span className="text-xs text-muted"> (optional)</span>} — {SHOPIFY_SCOPE_HELP[s]}</span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Notice tone="signal" icon={<ShieldCheck className="h-4 w-4" />} title="Where the token is kept">
        {st.tokenNote} Sentinel never publishes a theme and writes nothing until you review the changes and type the confirmation. <Link to="/seo-editor" className="font-medium underline">Open the SEO editor</Link>
      </Notice>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => disconnect.mutate()}
        title="Disconnect Shopify?"
        body="The token is removed from this server’s memory and open drafts are discarded. Nothing changes in the store. To revoke the token itself, uninstall the app in the Shopify admin."
        confirmLabel="Disconnect"
        danger
        loading={disconnect.isPending}
      />
    </>
  );
}

/** Sentinel's public address as seen in the browser (origin + the path before /settings/shopify) — a suggestion only. */
function suggestedAppUrl(): string {
  if (typeof window === 'undefined') return '';
  const p = window.location.pathname.replace(/\/settings\/shopify\/?$/, '');
  return `${window.location.origin}${p === '/' ? '' : p}`;
}

/**
 * The Shopify app's Client ID, Client secret and Sentinel's public URL, entered here instead of server environment
 * variables. The secret goes to the server once, is stored encrypted and is never shown again.
 */
function AppCredentials({ st }: { st: ShopifyStatus }) {
  const c = st.appCredentials;
  const [clientId, setClientId] = useState(c?.source === 'saved' ? c.clientId ?? '' : '');
  const [secret, setSecret] = useState('');
  const [appUrl, setAppUrl] = useState(c?.appUrlSource === 'saved' ? c.appUrl ?? '' : c?.appUrl ? '' : suggestedAppUrl());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useApiMutation(() => api.saveShopifyAppCredentials({ clientId: clientId.trim(), clientSecret: secret.trim() || undefined, appUrl: appUrl.trim() || undefined }), {
    success: 'Shopify app credentials saved — the Client secret is stored encrypted on the server',
    invalidate: [['shopify']],
    onSuccess: () => setSecret(''),
  });
  const remove = useApiMutation(() => api.removeShopifyAppCredentials(), { success: 'Shopify app credentials removed', invalidate: [['shopify']], onSuccess: () => { setConfirmRemove(false); setClientId(''); } });
  if (!c) return null;
  const keep = c.source === 'saved' && c.secretSet && clientId.trim() === (c.clientId ?? '');
  const base = (appUrl.trim() || c.appUrl || '').replace(/\/+$/, '');
  const fields = (save.error instanceof ApiError ? (save.error.details as { fields?: Record<string, string> } | undefined)?.fields : undefined) ?? {};
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><KeyRound className="h-4 w-4" />Shopify app credentials</span>} subtitle="From the Shopify Dev Dashboard → your app → Settings. Needed once per website for “Connect with Shopify”.">
      <div className="mt-3 space-y-4" data-testid="shopify-app-credentials">
        <p className="text-sm text-ink-soft">
          {c.source === 'saved' ? <>Saved in Sentinel{c.updatedBy ? ` by ${c.updatedBy}` : ''}{c.updatedAt ? ` · ${fmtDateTime(c.updatedAt)}` : ''}. The Client secret is stored encrypted and is never shown again.</>
            : c.source === 'env' ? <>In use: <Mono className="text-xs">SHOPIFY_API_KEY</Mono> / <Mono className="text-xs">SHOPIFY_API_SECRET</Mono> from the server environment. Credentials saved here replace them for this website.</>
              : 'Not set yet.'}
        </p>
        {!c.canStore && <Notice tone="crit" title="Credentials cannot be stored on this server">{c.storeProblem}</Notice>}
        {c.canStore && !c.persistent && <Notice tone="med">This server has no database: saved credentials and the connection last until the API restarts.</Notice>}
        <form className="grid gap-3 md:grid-cols-2" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
          <Field label="Client ID" htmlFor="shopify-client-id" error={fields.clientId}>
            <Input id="shopify-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono text-[13px]" />
          </Field>
          <Field label="Client secret" htmlFor="shopify-client-secret" error={fields.clientSecret} hint={keep ? 'Saved — leave empty to keep it, or enter a new one to replace it.' : 'Shown once to the server, stored encrypted, never sent back to the browser.'}>
            <Input id="shopify-client-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} placeholder={keep ? '•••••••• (saved)' : ''} className="font-mono text-[13px]" />
          </Field>
          <div className="md:col-span-2">
            <Field label="App URL (public address of Sentinel)" htmlFor="shopify-app-url" error={fields.appUrl} hint={c.appUrlSource === 'env' && !appUrl.trim() ? `Empty = ${c.appUrl} from APP_BASE_URL on the server.` : 'Where people open Sentinel, e.g. https://apps.deodap.info/seo-tool.'}>
              <Input id="shopify-app-url" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder={c.appUrl ?? 'https://apps.deodap.info/seo-tool'} autoComplete="off" className="font-mono text-[13px]" />
            </Field>
            {base && <p className="mt-1 text-xs text-muted">Allowed redirection URL to register in the Shopify app: <Mono className="text-xs" data-testid="shopify-callback-preview">{base}/api/shopify/oauth/callback</Mono></p>}
          </div>
          {save.error && !Object.keys(fields).length && <div className="md:col-span-2"><Notice tone="crit" title="Not saved">{errorMessage(save.error)}</Notice></div>}
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!c.canStore || !clientId.trim() || (!secret.trim() && !keep)}>Save credentials</Button>
            {c.source === 'saved' && <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)}>Remove</Button>}
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate()}
        title="Remove the Shopify app credentials?"
        body="The Client ID, Client secret and app URL saved in Sentinel are deleted. A store that is already connected stays connected until you disconnect it; new connections need the credentials again."
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
      />
    </Panel>
  );
}
