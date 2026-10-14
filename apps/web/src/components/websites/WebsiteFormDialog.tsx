import { useState } from 'react';
import { ApiError, WEBSITE_PLATFORMS, type Website, type WebsiteInput, type WebsitePlatform } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation } from '@/api/hooks';
import { Button, Field, Input, Notice, Select } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';

/** Add / edit a website. Validation (URL, platform, sitemap on the same domain, duplicate domain) runs on the API; its message lands on the right field. */
export function WebsiteFormDialog({ open, onClose, website, onSaved }: { open: boolean; onClose: () => void; website?: Website; onSaved?: (w: Website) => void }) {
  const [form, setForm] = useState<WebsiteInput>(() => ({ name: website?.name ?? '', url: website?.url ?? '', platform: website?.platform ?? 'shopify', sitemapUrl: website?.sitemapUrl ?? '' }));
  const [err, setErr] = useState<{ field: keyof WebsiteInput | 'form'; msg: string } | null>(null);
  const m = useApiMutation((v: WebsiteInput) => (website ? api.updateWebsite(website.id, v) : api.createWebsite(v)), {
    success: (w) => (website ? `Saved ${w.name}` : `Added ${w.name} — it has not been crawled yet`),
    silentError: true,
    onSuccess: (w) => { onSaved?.(w); onClose(); },
  });
  const submit = () => {
    setErr(null);
    if (form.name.trim().length < 2) return setErr({ field: 'name', msg: 'Website name is required.' });
    if (!form.url.trim()) return setErr({ field: 'url', msg: 'Website URL is required.' });
    m.mutate({ ...form, sitemapUrl: form.sitemapUrl?.trim() || undefined }, {
      onError: (e) => {
        const msg = e instanceof ApiError ? e.message : 'Could not save the website.';
        const field: keyof WebsiteInput | 'form' = /sitemap/i.test(msg) ? 'sitemapUrl' : /already added|URL|domain/i.test(msg) ? 'url' : /name/i.test(msg) ? 'name' : /platform/i.test(msg) ? 'platform' : 'form';
        setErr({ field, msg });
      },
    });
  };
  const fe = (f: keyof WebsiteInput) => (err?.field === f ? err.msg : undefined);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={website ? `Edit ${website.name}` : 'Add website'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={submit}>{website ? 'Save changes' : 'Add website'}</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <Field label="Website name" htmlFor="ws-name" required error={fe('name')}>
          <Input id="ws-name" data-autofocus value={form.name} maxLength={80} placeholder="e.g. DeoDap Wholesale" onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={!!fe('name')} />
        </Field>
        <Field label="Website URL" htmlFor="ws-url" required hint="The home page. One workspace per domain — www. and the bare domain count as the same site." error={fe('url')}>
          <Input id="ws-url" type="url" inputMode="url" value={form.url} placeholder="https://example.com" onChange={(e) => setForm({ ...form, url: e.target.value })} aria-invalid={!!fe('url')} disabled={website?.source === 'demo'} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Platform" htmlFor="ws-platform" required error={fe('platform')}>
            <Select id="ws-platform" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value as WebsitePlatform })}>
              {WEBSITE_PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label="Sitemap URL" htmlFor="ws-sitemap" hint="Optional — must be on the same domain." error={fe('sitemapUrl')}>
            <Input id="ws-sitemap" type="url" inputMode="url" value={form.sitemapUrl ?? ''} placeholder="https://example.com/sitemap.xml" onChange={(e) => setForm({ ...form, sitemapUrl: e.target.value })} aria-invalid={!!fe('sitemapUrl')} />
          </Field>
        </div>
        {err?.field === 'form' && <Notice tone="crit">{err.msg}</Notice>}
        {!website && <p className="text-xs text-muted">The new workspace starts empty: no crawl, no findings, no connected integrations. Nothing is fetched from the site until a crawl runs.</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
