import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Circle, ShieldCheck, Store, Unplug } from 'lucide-react';
import { SHOPIFY_SCOPE_HELP, type ShopifyStatus } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Field, Input, KV, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { fmtDateTime } from '@/lib/format';

const CALLBACK_REASONS: Record<string, string> = {
  bad_hmac: 'The answer from Shopify failed the signature check, so it was ignored. Start the connection again.',
  bad_state: 'The connection link was already used or has expired (links last 10 minutes and work once). Start again.',
  expired: 'The answer from Shopify was too old. Start the connection again.',
  bad_shop: 'Shopify sent an invalid shop domain.',
  shop_mismatch: 'Shopify answered for a different store than the one you started with.',
  missing_scopes: 'The app was approved without all the access the SEO editor needs. Start again and approve every requested permission.',
  exchange_refused: 'Shopify refused the authorization code. Start the connection again.',
  exchange_network: 'The server could not reach Shopify to finish the connection.',
  not_configured: 'OAuth is not configured on the server (SHOPIFY_API_KEY / SHOPIFY_API_SECRET).',
  workspace_gone: 'The website that started the connection no longer exists on this server (it restarted). Start again.',
};

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
  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.startShopifyOAuth(shop);
      window.location.assign(r.authorizeUrl);
    } catch (err) {
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
          {st.problems.map((p) => <Notice key={p} tone="med">{p}</Notice>)}
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
            <form onSubmit={start} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[260px] flex-1">
                <Field label="Store" htmlFor="shop" hint="The myshopify.com domain, e.g. deodap.myshopify.com">
                  <Input id="shop" value={shop} onChange={(e) => setShop(e.target.value)} placeholder="your-store.myshopify.com" className="font-mono text-[13px]" />
                </Field>
              </div>
              <Button type="submit" variant="primary" loading={busy} disabled={!st.oauthConfigured || !shop.trim()}>Connect with Shopify</Button>
            </form>
          )}
          {!st.connected && !manage && <p className="text-sm text-muted">Ask an administrator to connect the store.</p>}
          {st.redirectUrl && !st.connected && (
            <p className="text-xs text-muted">Allowed redirection URL to add in the Shopify app settings: <Mono className="text-xs">{st.redirectUrl}</Mono></p>
          )}
        </div>
      </Panel>

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
