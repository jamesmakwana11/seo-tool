import { useState } from 'react';
import { Download, FileCode2, GitCompare } from 'lucide-react';
import { ApiError, type DiffLine, type ShopifyThemeFile, type ShopifyThemeProposal } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { Async, Badge, Button, EmptyState, Field, Input, Mono, Notice, Panel, Select, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { saveFile } from '@/components/crawls/LiveCrawl';
import { fmtDateTime } from '@/lib/format';

/**
 * Theme changes for SEO problems the Admin API cannot fix (an H1 hard-coded in a section, a canonical tag in the layout…):
 * open a file of a theme, edit it, and create a proposal (diff + original kept). An unpublished copy is written after
 * typing the confirmation; the live theme only after the original file was downloaded and its own live-theme phrase was
 * typed. Sentinel never publishes a theme.
 */
export function ThemeWork() {
  const toast = useToast();
  const themes = useApiQuery(['shopify', 'themes'], () => api.listShopifyThemes());
  const proposals = useApiQuery(['shopify', 'theme-proposals'], () => api.listShopifyThemeProposals());
  const [themeId, setThemeId] = useState('');
  const [filename, setFilename] = useState('sections/main-product.liquid');
  const [file, setFile] = useState<ShopifyThemeFile | null>(null);
  const [content, setContent] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<ShopifyThemeProposal | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      const f = await api.getShopifyThemeFile(themeId, filename.trim());
      setFile(f);
      setContent(f.content);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const propose = useApiMutation(() => api.proposeShopifyThemeChange({ themeId, filename: file!.filename, content, reason }), {
    success: 'Proposal created — nothing was written to the theme',
    invalidate: [['shopify', 'theme-proposals']],
    onSuccess: (p) => setOpen(p),
  });
  return (
    <div className="space-y-5">
      <Notice tone="signal" title="How theme changes work">
        Safest: make the change on an unpublished copy of the theme (duplicate the live theme in Shopify first), preview it, and publish it yourself. Sentinel shows the diff, keeps the original file, and writes only after you type the confirmation. A change to the live theme is shown on the storefront at once, so it also requires downloading the original file first and typing a separate live-theme confirmation. Sentinel never publishes a theme.
      </Notice>
      <Panel title="Edit a theme file">
        {themes.error instanceof ApiError && themes.error.status === 409 ? (
          <div className="mt-3"><Notice tone="med" title="No Shopify connection with theme access">{errorMessage(themes.error)}</Notice></div>
        ) : <Async q={themes} rows={2}>
          {(list) => (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Theme" htmlFor="th-id">
                  <Select id="th-id" value={themeId} onChange={(e) => { setThemeId(e.target.value); setFile(null); }}>
                    <option value="">Choose…</option>
                    {list.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.role}{t.writable ? '' : ' (read only)'}</option>)}
                  </Select>
                </Field>
                <div className="min-w-[240px] flex-1">
                  <Field label="File" htmlFor="th-file" hint="layout/, templates/, sections/ or snippets/ (.liquid or .json)">
                    <Input id="th-file" value={filename} onChange={(e) => setFilename(e.target.value)} className="font-mono text-[13px]" />
                  </Field>
                </div>
                <Button icon={<FileCode2 className="h-4 w-4" />} disabled={!themeId || !filename.trim()} loading={loading} onClick={load}>Open</Button>
              </div>
              {file && (
                <>
                  {list.find((t) => t.id === themeId)?.role === 'MAIN' && <Notice tone="med">This is the live theme: a written change is visible on the storefront at once. Writing it requires downloading the original file and typing a separate live-theme confirmation.</Notice>}
                  <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={16} className="font-mono text-xs" aria-label="File content" spellCheck={false} />
                  <Field label="Why (shown with the proposal)" htmlFor="th-reason"><Input id="th-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Product title rendered as a second H1 by the theme" /></Field>
                  <Button variant="primary" icon={<GitCompare className="h-4 w-4" />} disabled={content === file.content || !reason.trim()} loading={propose.isPending} onClick={() => propose.mutate()}>Create proposal</Button>
                </>
              )}
            </div>
          )}
        </Async>}
      </Panel>
      <Panel title="Proposals" bodyClassName="p-0">
        <Async q={proposals} rows={3}>
          {(list) => (list.length ? (
            <ul className="divide-y divide-line">
              {list.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                  <span className="min-w-0"><Mono className="text-xs">{p.filename}</Mono> in <span className="font-medium">{p.themeName}</span> ({p.themeRole}) · <span className="text-ok-ink">+{p.added}</span> <span className="text-crit-ink">−{p.removed}</span> · {p.createdBy}, {fmtDateTime(p.createdAt)}</span>
                  <span className="flex items-center gap-2"><Badge tone={p.status === 'applied' ? 'ok' : p.status === 'proposed' ? 'neutral' : 'crit'}>{p.status}</Badge><Button size="sm" onClick={() => setOpen(p)}>Open</Button></span>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No proposals" description="Open a theme file above to prepare one." />)}
        </Async>
      </Panel>
      {open && <ProposalDialog p={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function ProposalDialog({ p, onClose }: { p: ShopifyThemeProposal; onClose: () => void }) {
  const toast = useToast();
  const [phrase, setPhrase] = useState('');
  const [cur, setCur] = useState(p);
  const apply = useApiMutation(() => api.applyShopifyThemeProposal(p.id, phrase), {
    invalidate: [['shopify', 'theme-proposals']],
    success: (r) => (r.status === 'applied' ? (r.live ? 'Written to the live theme' : 'Written to the unpublished theme') : `Not written: ${r.status}`),
    onSuccess: (r) => setCur(r),
  });
  const [backedUp, setBackedUp] = useState(!!p.backupTakenAt);
  const backup = async () => { try { saveFile(await api.downloadShopifyThemeBackup(p.id)); setBackedUp(true); } catch (e) { toast.error(errorMessage(e)); } };
  const live = !!cur.live;
  const lc = cur.result?.liveCheck;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`${cur.filename} — ${cur.themeName}`}
      footer={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button icon={<Download className="h-4 w-4" />} onClick={backup}>Download original file</Button>
          {cur.status === 'proposed' && <Button variant="primary" disabled={(live && !backedUp) || phrase.trim() !== cur.confirmPhrase} loading={apply.isPending} onClick={() => apply.mutate()}>Write to {cur.themeName}</Button>}
        </div>
      )}
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">{cur.reason}</p>
        <DiffView lines={cur.diff} />
        {cur.result && <Notice tone={cur.status === 'applied' && cur.result.verified ? 'signal' : 'crit'}>{cur.result.message}</Notice>}
        {lc && (
          <Notice tone={lc.ok ? 'signal' : 'med'} title={lc.ok ? 'Storefront shows the new H1' : 'Storefront not confirmed'}>
            Expected “{lc.expected}” on {lc.url}; found {lc.found.length ? lc.found.map((h) => `“${h}”`).join(', ') : 'no H1'}.{lc.note ? ` ${lc.note}` : ''}
          </Notice>
        )}
        {cur.status === 'proposed' && live && (
          <Notice tone="crit" title="Live theme">
            This writes to the published theme: customers see the change immediately. {backedUp ? 'Original file downloaded.' : 'Download the original file first — it is your way back.'}
          </Notice>
        )}
        {cur.status === 'proposed' && (
          <Field label={<>Type <Mono>{cur.confirmPhrase}</Mono> to write the file{live ? '' : ' (the theme is not published)'}</>} htmlFor="th-confirm">
            <Input id="th-confirm" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" disabled={live && !backedUp} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="max-h-[50vh] overflow-auto rounded-ctl border border-line bg-raised/60 p-2 font-mono text-xs leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className={l.op === '+' ? 'bg-ok-tint text-ok-ink' : l.op === '-' ? 'bg-crit-tint text-crit-ink' : l.op === '…' ? 'text-faint' : 'text-ink-soft'}>
          {l.op === '…' ? '  …' : `${l.op} ${l.text}`}
        </div>
      ))}
    </pre>
  );
}
