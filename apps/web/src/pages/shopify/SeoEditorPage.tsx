import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, ExternalLink, FilePlus2, GitCompare, RefreshCw, RotateCcw, Search, Send, Trash2 } from 'lucide-react';
import { ApiError, type ShopifyApplyBatchResult, type ShopifyApplyPreview, type ShopifyDraft, type ShopifyFieldDraft, type ShopifyResourceKind, type ShopifyThemeProposal } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Checkbox, EmptyState, Field, Input, Mono, Notice, PageHeader, Panel, Select, Tabs, Textarea } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { Dialog, Drawer } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { saveFile } from '@/components/crawls/LiveCrawl';
import { ProposalDialog, ThemeWork } from '@/components/shopify/ThemeWork';
import { fmtDateTime } from '@/lib/format';

const KIND_LABEL: Record<ShopifyResourceKind, string> = { product: 'Product', collection: 'Collection', page: 'Page', article: 'Article' };
const STATUS_TONE = { draft: 'neutral', applied: 'ok', partial: 'med', failed: 'crit' } as const;

export default function SeoEditorPage() {
  const { can } = useAuth();
  const status = useApiQuery(['shopify', 'status'], () => api.getShopifyStatus(), { enabled: can('integrations.view') });
  const [tab, setTab] = useState<'content' | 'themes'>(can('shopify.edit') ? 'content' : 'themes');
  const st = status.data;
  return (
    <div>
      <PageHeader
        title="SEO editor"
        description="Fix titles, meta descriptions, headings, descriptions, tags and image alt text in Shopify. Suggestions reuse the text already on the page; you review every change, and nothing is written until you confirm."
        meta={st?.connected ? <Badge tone="ok">{st.shopName ?? st.shop}</Badge> : undefined}
      />
      {st && !st.capabilities.edit && (
        <div className="mb-4"><Notice tone="med" title={st.connected ? 'Editing is blocked' : 'Shopify is not connected'}>{st.problems.join(' ') || 'Connect the store first.'} <Link to="/settings/shopify" className="font-medium underline">Settings → Shopify</Link></Notice></div>
      )}
      {can('shopify.theme') && can('shopify.edit') && (
        <Tabs className="mb-4" value={tab} onChange={setTab} items={[{ value: 'content', label: 'Content (Admin API)' }, { value: 'themes', label: 'Theme changes' }]} />
      )}
      {tab === 'themes' && can('shopify.theme') ? <ThemeWork /> : can('shopify.edit') ? <ContentWork /> : <EmptyState title="No access" description="Your role cannot edit Shopify content." />}
    </div>
  );
}

function ContentWork() {
  const [params, setParams] = useSearchParams();
  const drafts = useApiQuery(['shopify', 'drafts'], () => api.listShopifyDrafts());
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [applyIds, setApplyIds] = useState<string[] | null>(null);
  const [url, setUrl] = useState(params.get('url') ?? '');
  const create = useApiMutation((input: { url?: string; kind?: ShopifyResourceKind; id?: string }) => api.createShopifyDraft(input), {
    invalidate: [['shopify', 'drafts']],
    onSuccess: (d) => setOpenId(d.id),
  });
  // /seo-editor?url=… (from a crawl's page list) opens a draft for that page once.
  const auto = useRef(false);
  useEffect(() => {
    const u = params.get('url');
    if (u && !auto.current) { auto.current = true; create.mutate({ url: u }); setParams({}, { replace: true }); }
  }, [params, create, setParams]);
  const list = drafts.data ?? [];
  const open = list.find((d) => d.id === openId) ?? null;
  const submit = (e: FormEvent) => { e.preventDefault(); if (url.trim()) create.mutate({ url: url.trim() }); };
  return (
    <div className="space-y-5">
      <Panel title="Open a page" subtitle="Paste a product, collection, page or blog article URL of this website (from the crawl’s page list, for example), or browse the store.">
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <Field label="Page URL" htmlFor="seo-url"><Input id="seo-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/products/…" className="font-mono text-[13px]" /></Field>
          </div>
          <Button type="submit" variant="primary" icon={<FilePlus2 className="h-4 w-4" />} loading={create.isPending} disabled={!url.trim()}>Create draft</Button>
        </form>
        <Browser onPick={(kind, id) => create.mutate({ kind, id })} />
      </Panel>

      <Panel
        title="Drafts"
        subtitle="Drafts live in server memory until applied, discarded or the server restarts."
        actions={<Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!selected.length} onClick={() => setApplyIds(selected)}>Review and apply {selected.length || ''}</Button>}
        bodyClassName="p-0"
      >
        <Async q={drafts} rows={4}>
          {() => (
            <DataTable
              rows={list}
              rowKey={(d) => d.id}
              dense
              pageSize={20}
              caption="SEO editor drafts"
              onRowClick={(d) => setOpenId(d.id)}
              empty={<EmptyState title="No drafts yet" description="Open a page above to see suggested fixes." />}
              columns={[
                {
                  key: 'sel', header: '', cell: (d) => (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Checkbox label={<span className="sr-only">Select {d.resourceTitle}</span>} checked={selected.includes(d.id)} onChange={(v) => setSelected((s) => (v ? [...s, d.id] : s.filter((x) => x !== d.id)))} />
                    </span>
                  ),
                },
                { key: 'title', header: 'Resource', cell: (d) => <span className="text-sm"><span className="font-medium">{d.resourceTitle}</span><br /><Mono className="text-xs text-muted">{d.handle}</Mono></span> },
                { key: 'kind', header: 'Type', cell: (d) => <Badge>{KIND_LABEL[d.kind]}</Badge> },
                { key: 'changes', header: 'Changes', cell: (d) => { const n = d.fields.filter((f) => f.include).length; const bad = d.fields.filter((f) => f.include && !f.validation.ok).length; return <span className="text-xs">{n} selected{bad ? <Badge tone="crit" className="ml-1">{bad} invalid</Badge> : null}</span>; } },
                { key: 'status', header: 'Status', cell: (d) => <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge> },
                { key: 'at', header: 'Updated', hideOnMobile: true, cell: (d) => <span className="whitespace-nowrap text-xs">{fmtDateTime(d.updatedAt)}</span> },
              ]}
            />
          )}
        </Async>
      </Panel>

      <Drawer open={!!open} onClose={() => setOpenId(null)} title={open ? `${KIND_LABEL[open.kind]}: ${open.resourceTitle}` : ''} width="lg">
        {open && <DraftEditor d={open} onApply={() => setApplyIds([open.id])} onClosed={() => setOpenId(null)} />}
      </Drawer>
      {applyIds && <ApplyDialog ids={applyIds} onClose={() => setApplyIds(null)} onDone={() => setSelected([])} />}
    </div>
  );
}

function Browser({ onPick }: { onPick: (kind: ShopifyResourceKind, id: string) => void }) {
  const [kind, setKind] = useState<ShopifyResourceKind>('product');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState<{ kind: ShopifyResourceKind; q: string; after?: string } | null>(null);
  const res = useApiQuery(['shopify', 'resources', query], () => api.listShopifyResources(query!), { enabled: !!query });
  return (
    <div className="mt-4 border-t border-line pt-4">
      <form onSubmit={(e) => { e.preventDefault(); setQuery({ kind, q }); }} className="flex flex-wrap items-end gap-2">
        <Field label="Browse" htmlFor="br-kind">
          <Select id="br-kind" value={kind} onChange={(e) => setKind(e.target.value as ShopifyResourceKind)}>
            {(Object.keys(KIND_LABEL) as ShopifyResourceKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}s</option>)}
          </Select>
        </Field>
        <div className="min-w-[200px] flex-1"><Field label="Search (Shopify search syntax)" htmlFor="br-q"><Input id="br-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="title:chopper" /></Field></div>
        <Button type="submit" icon={<Search className="h-4 w-4" />}>Search</Button>
      </form>
      {query && (
        <div className="mt-3">
          <Async q={res} rows={3}>
            {(r) => (
              <>
                <ul className="divide-y divide-line rounded-ctl border border-line">
                  {r.items.map((it) => (
                    <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0"><span className="font-medium">{it.title}</span> <Mono className="text-xs text-muted">{it.path}</Mono>{!it.seoDescription && <Badge tone="med" className="ml-1">no meta description</Badge>}</span>
                      <Button size="sm" onClick={() => onPick(it.kind, it.id)}>Draft</Button>
                    </li>
                  ))}
                  {!r.items.length && <li className="px-3 py-2 text-sm text-muted">Nothing found.</li>}
                </ul>
                {r.nextCursor && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setQuery({ ...query, after: r.nextCursor })}>Next 50</Button>}
              </>
            )}
          </Async>
        </div>
      )}
    </div>
  );
}

function DraftEditor({ d, onApply, onClosed }: { d: ShopifyDraft; onApply: () => void; onClosed: () => void }) {
  const toast = useToast();
  const save = useApiMutation((fields: Record<string, { proposed?: string; include?: boolean }>) => api.updateShopifyDraft(d.id, { fields }), { invalidate: [['shopify', 'drafts']] });
  const refresh = useApiMutation(() => api.refreshShopifyDraft(d.id), { success: 'Draft rebuilt from the current Shopify values', invalidate: [['shopify', 'drafts']] });
  const reaudit = useApiMutation(() => api.reauditShopifyDraft(d.id), { success: 'Storefront checked again', invalidate: [['shopify', 'drafts']] });
  const remove = useApiMutation(() => api.deleteShopifyDraft(d.id), { success: 'Draft discarded', invalidate: [['shopify', 'drafts']], onSuccess: onClosed });
  const backup = async () => { try { saveFile(await api.downloadShopifyBackup([d.id])); } catch (e) { toast.error(errorMessage(e)); } };
  const selected = d.fields.filter((f) => f.include);
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap gap-2">
        {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-signal hover:underline">Storefront <ExternalLink className="h-3 w-3" /></a>}
        {d.adminUrl && <a href={d.adminUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-signal hover:underline">Shopify admin <ExternalLink className="h-3 w-3" /></a>}
      </div>
      <section>
        <h3 className="mb-1 font-semibold">Where the H1 comes from</h3>
        <p className="text-ink-soft">{d.h1.summary}{d.h1.observedAt ? ` (crawl of ${fmtDateTime(d.h1.observedAt)})` : ''}</p>
        {!!d.h1.sources.length && (
          <ul className="mt-2 space-y-1">
            {d.h1.sources.map((s, i) => (
              <li key={i} className="flex gap-2"><Badge tone={s.applyVia === 'theme' ? 'med' : 'ok'}>{s.applyVia === 'theme' ? 'Theme edit' : 'Editable here'}</Badge><span><span className="font-medium">“{s.text || '(empty)'}”</span> — {s.explanation}</span></li>
            ))}
          </ul>
        )}
      </section>
      {!!d.notes.length && <Notice tone="med" title="Needs theme work (not changed here)">{d.notes.map((n) => <p key={n}>{n}</p>)}</Notice>}
      {d.result && <ResultView d={d} />}
      <section className="space-y-4">
        <h3 className="font-semibold">Fields</h3>
        {d.fields.map((f) => <FieldEditor key={`${d.id}:${f.key}`} f={f} draftId={d.id} onSave={(v) => save.mutate({ [f.key]: v })} saving={save.isPending} />)}
      </section>
      <div className="sticky bottom-0 -mx-1 flex flex-wrap gap-2 border-t border-line bg-surface px-1 py-3">
        <Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!selected.length} onClick={onApply}>Review and apply {selected.length} change{selected.length === 1 ? '' : 's'}</Button>
        <Button icon={<Download className="h-4 w-4" />} onClick={backup}>Download original values</Button>
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} loading={refresh.isPending} onClick={() => refresh.mutate()}>Rebuild from Shopify</Button>
        {d.result && <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} loading={reaudit.isPending} onClick={() => reaudit.mutate()}>Check storefront again</Button>}
        <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} loading={remove.isPending} onClick={() => remove.mutate()}>Discard</Button>
      </div>
    </div>
  );
}

function FieldEditor({ f, draftId, onSave, saving }: { f: ShopifyFieldDraft; draftId: string; onSave: (v: { proposed?: string; include?: boolean }) => void; saving: boolean }) {
  const { can } = useAuth();
  const [v, setV] = useState(f.proposed);
  const themeH1 = f.key === 'h1' && f.applyVia === 'theme';
  useEffect(() => setV(f.proposed), [f.proposed]);
  const isHtml = f.key === 'bodyHtml' || f.key === 'summaryHtml';
  const long = isHtml || f.key === 'seoDescription';
  const dirty = v !== f.proposed;
  const changed = f.proposed !== f.current;
  return (
    <div className={`rounded-ctl border p-3 ${f.include ? 'border-signal/40 bg-signal-tint/30' : 'border-line'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{f.label}</span>
          <Badge tone={f.applyVia === 'theme' ? 'med' : 'neutral'} title={f.mutation}>{f.applyVia === 'theme' ? 'Theme edit' : f.mutation ?? 'Admin API'}</Badge>
          {f.source === 'suggested' && <Badge tone="signal">Suggested</Badge>}
          {f.source === 'manual' && <Badge>Edited</Badge>}
        </div>
        {themeH1 ? <ThemeH1Button draftId={draftId} text={v} disabled={!can('shopify.theme') || !v.trim() || v === f.current} /> : <Checkbox label="Apply" checked={f.include} disabled={!changed || saving} onChange={(inc) => onSave({ include: inc })} />}
      </div>
      {f.reason && <p className="mt-1 text-xs text-ink-soft">{f.reason}</p>}
      {f.hint && (/^https?:\/\//.test(f.hint) ? <img src={f.hint} alt="" className="mt-2 h-20 w-20 rounded object-cover" loading="lazy" /> : <p className="mt-1 text-xs text-muted">{f.hint}</p>)}
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-muted">Now in Shopify</div>
          <pre className={`max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-ctl border border-line bg-raised/60 p-2 text-xs ${isHtml ? 'font-mono' : 'font-sans'}`}>{f.current || <em className="text-faint">empty</em>}</pre>
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted"><span>Proposed</span><span className="tabular-nums">{v.length} chars</span></div>
          {long ? <Textarea value={v} onChange={(e) => setV(e.target.value)} rows={isHtml ? 8 : 3} className={isHtml ? 'font-mono text-xs' : 'text-sm'} aria-label={`${f.label} proposed`} />
            : <Input value={v} onChange={(e) => setV(e.target.value)} aria-label={`${f.label} proposed`} />}
          <div className="mt-1 flex gap-2">
            <Button size="sm" disabled={!dirty || saving} onClick={() => onSave({ proposed: v })}>Save edit</Button>
            {v !== f.current && <Button size="sm" variant="ghost" onClick={() => { setV(f.current); onSave({ proposed: f.current, include: false }); }}>Keep current</Button>}
          </div>
        </div>
      </div>
      {(!!f.validation.errors.length || !!f.validation.warnings.length) && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {f.validation.errors.map((e) => <li key={e} className="text-crit-ink">✕ {e}</li>)}
          {f.validation.warnings.map((w) => <li key={w} className="text-med-ink">! {w}</li>)}
        </ul>
      )}
    </div>
  );
}

/** H1 rendered by the theme: finds the file that contains it and creates a theme proposal (diff + backup + confirmation). */
function ThemeH1Button({ draftId, text, disabled }: { draftId: string; text: string; disabled: boolean }) {
  const toast = useToast();
  const [files, setFiles] = useState<string[] | null>(null);
  const [file, setFile] = useState('');
  const [proposal, setProposal] = useState<ShopifyThemeProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (filename?: string) => {
    setBusy(true);
    try {
      const p = await api.proposeShopifyH1Theme(draftId, { text, ...(filename ? { filename } : {}) });
      setFiles(null);
      setProposal(p);
    } catch (e) {
      const list = e instanceof ApiError ? (e.details as { files?: string[] } | undefined)?.files : undefined;
      if (list?.length) { setFiles(list); setFile(list[0]); toast.error(`${errorMessage(e)} Pick the file, then choose “Change in theme” again.`); } else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      {files && (
        <Select aria-label="Theme file with the H1" value={file} onChange={(e) => setFile(e.target.value)} className="text-xs">
          {files.map((x) => <option key={x} value={x}>{x}</option>)}
        </Select>
      )}
      <Button size="sm" variant="primary" icon={<GitCompare className="h-4 w-4" />} disabled={disabled} loading={busy} onClick={() => void run(files ? file : undefined)}>Change in theme</Button>
      {proposal && <ProposalDialog p={proposal} onClose={() => setProposal(null)} />}
    </span>
  );
}

const RESULT_TONE = { verified: 'ok', applied_unverified: 'med', failed: 'crit', conflict: 'crit', skipped: 'neutral' } as const;
const RESULT_LABEL = { verified: 'Written and verified', applied_unverified: 'Written, not verified', failed: 'Failed', conflict: 'Conflict — not written', skipped: 'Skipped' } as const;

function ResultView({ d }: { d: ShopifyDraft }) {
  const r = d.result!;
  return (
    <section className="rounded-ctl border border-line p-3">
      <h3 className="mb-1 font-semibold">Last apply — {fmtDateTime(r.at)} by {r.by}</h3>
      <ul className="space-y-1">
        {r.fields.map((f) => <li key={f.key} className="flex flex-wrap gap-2 text-xs"><Badge tone={RESULT_TONE[f.status]}>{RESULT_LABEL[f.status]}</Badge><span className="font-medium">{f.label}</span>{f.message && <span className="text-ink-soft">{f.message}</span>}</li>)}
      </ul>
      {r.reaudit && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold">Storefront check {r.reaudit.status ? `(HTTP ${r.reaudit.status}, ${fmtDateTime(r.reaudit.at)})` : ''}</h4>
          {r.reaudit.skipped && <p className="text-xs text-muted">{r.reaudit.skipped}</p>}
          <ul className="mt-1 space-y-0.5 text-xs">
            {r.reaudit.checks.map((c, i) => <li key={i}>{c.ok ? '✓' : '✕'} {c.field}: expected “{c.expected.slice(0, 80)}”, found “{c.found.slice(0, 80)}”</li>)}
          </ul>
          {r.reaudit.note && <p className="mt-1 text-xs text-med-ink">{r.reaudit.note}</p>}
        </div>
      )}
    </section>
  );
}

function ApplyDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const pv = useApiQuery(['shopify', 'preview', ids], () => api.previewShopifyApply(ids));
  const [phrase, setPhrase] = useState('');
  const [result, setResult] = useState<ShopifyApplyBatchResult | null>(null);
  const apply = useApiMutation((p: { phrase: string }) => api.applyShopifyDrafts(ids, p.phrase), {
    invalidate: [['shopify', 'drafts']],
    success: (r) => `${r.applied} change(s) written${r.failed ? `, ${r.failed} not written` : ''}`,
    onSuccess: (r) => { setResult(r); onDone(); },
  });
  const backup = async () => { try { saveFile(await api.downloadShopifyBackup(ids)); } catch (e) { toast.error(errorMessage(e)); } };
  const p: ShopifyApplyPreview | undefined = pv.data;
  const ready = !!p && p.total > 0 && phrase.trim() === p.confirmPhrase;
  const counts = useMemo(() => result?.drafts.map((d) => ({ d, ok: d.result?.fields.filter((f) => f.status === 'verified').length ?? 0 })), [result]);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={result ? 'Applied' : 'Review changes before writing to Shopify'}
      footer={result ? <Button onClick={onClose}>Close</Button> : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button icon={<Download className="h-4 w-4" />} onClick={backup}>Download original values</Button>
          <Button variant="primary" disabled={!ready} loading={apply.isPending} onClick={() => apply.mutate({ phrase })}>Write {p?.total ?? 0} change{p?.total === 1 ? '' : 's'} to Shopify</Button>
        </div>
      )}
    >
      {result ? (
        <ul className="space-y-2 text-sm">
          {counts?.map(({ d, ok }) => <li key={d.id}><Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge> <span className="font-medium">{d.resourceTitle}</span> — {ok} verified{d.result?.reaudit?.note ? `. ${d.result.reaudit.note}` : ''}</li>)}
          <li className="text-xs text-muted">Open a draft to see each field’s result and the storefront check.</li>
        </ul>
      ) : (
        <Async q={pv} rows={4}>
          {(pr) => (
            <div className="space-y-4 text-sm">
              <p className="text-ink-soft">Values were read from Shopify just now. Fields changed in Shopify since the draft was made are conflicts and will not be written.</p>
              {pr.drafts.map((d) => (
                <section key={d.id}>
                  <h3 className="font-semibold">{KIND_LABEL[d.kind]}: {d.resourceTitle}</h3>
                  {d.problems.map((x) => <p key={x} className="text-xs text-crit-ink">✕ {x}</p>)}
                  <table className="mt-1 w-full text-xs">
                    <thead><tr className="text-left text-muted"><th className="py-1 pr-2">Field</th><th className="pr-2">In Shopify now</th><th>Will become</th></tr></thead>
                    <tbody>
                      {d.changes.map((c) => (
                        <tr key={c.key} className={`border-t border-line align-top ${c.conflict ? 'bg-crit-tint/50' : ''}`}>
                          <td className="py-1 pr-2 font-medium">{c.label}{c.conflict && <Badge tone="crit" className="ml-1">conflict</Badge>}<div className="font-normal text-muted">{c.mutation}</div></td>
                          <td className="max-w-[260px] break-words py-1 pr-2">{c.live.slice(0, 300) || <em className="text-faint">empty</em>}</td>
                          <td className="max-w-[260px] break-words py-1">{c.proposed.slice(0, 300) || <em className="text-faint">empty</em>}</td>
                        </tr>
                      ))}
                      {!d.changes.length && <tr><td colSpan={3} className="py-1 text-muted">Nothing to write.</td></tr>}
                    </tbody>
                  </table>
                </section>
              ))}
              {pr.total > 0 ? (
                <Field label={<>Type <Mono>{pr.confirmPhrase}</Mono> to confirm</>} htmlFor="confirm-apply">
                  <Input id="confirm-apply" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
                </Field>
              ) : <Notice tone="med">There is nothing to write: every change is unchanged, invalid or in conflict.</Notice>}
            </div>
          )}
        </Async>
      )}
    </Dialog>
  );
}
