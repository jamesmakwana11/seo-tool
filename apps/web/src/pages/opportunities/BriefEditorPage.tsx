import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import type { ContentBrief, SearchIntent } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { DetailError } from '@/components/domain/DetailError';
import { Async, Badge, Button, DemoBadge, Field, IconButton, Input, KV, Notice, PageHeader, Panel, Select, Textarea } from '@/components/ui/primitives';
import { SourceBadge } from '@/components/domain/badges';
import { INTENT_LABELS } from '@/components/opportunities/shared';
import { BRIEF_STATUS, BriefStatusBadge, ORIGIN_LABELS, PAGE_TYPE_LABELS } from '@/components/opportunities/briefLabels';
import { fmtDateTime } from '@/lib/format';

export default function BriefEditorPage() {
  const { id = '' } = useParams();
  const q = useApiQuery(['brief', id], () => api.getBrief(id));
  return (
    <div>
      <Link to="/opportunities/briefs" className="mb-3 inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> All briefs</Link>
      {q.error
        ? <DetailError error={q.error} what="Brief" id={id} back={{ to: '/opportunities/briefs', label: 'Back to content briefs' }} onRetry={() => q.refetch()} />
        : <Async q={q} rows={12}>{(b) => <Editor key={`${b.id}-${b.updatedAt}`} brief={b} />}</Async>}
    </div>
  );
}

type Errors = Partial<Record<'title' | 'targetKeyword' | 'suggestedUrl' | 'outline' | 'faqs' | 'links', string>>;

function validate(b: ContentBrief): Errors {
  const e: Errors = {};
  if (!b.title.trim()) e.title = 'Enter a title.';
  if (!b.targetKeyword.trim()) e.targetKeyword = 'Enter the target keyword.';
  if (!b.suggestedUrl.trim().startsWith('/')) e.suggestedUrl = 'Must be a site path starting with "/", e.g. /blogs/news/my-guide.';
  if (b.outline.some((o) => !o.trim())) e.outline = 'Remove or fill empty outline sections.';
  if (b.faqs.some((f) => !f.q.trim())) e.faqs = 'Every FAQ needs a question.';
  if (b.internalLinks.some((l) => !l.from.trim().startsWith('/') || !l.anchor.trim())) e.links = 'Each internal link needs a source path starting with "/" and anchor text.';
  return e;
}

function Editor({ brief }: { brief: ContentBrief }) {
  const { can } = useAuth();
  const canEdit = can('opportunities.manage');
  const [form, setForm] = useState<ContentBrief>(brief);
  const [touched, setTouched] = useState(false);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(brief), [form, brief]);
  const errors = validate(form);
  const hasErrors = Object.keys(errors).length > 0;
  const showErr = (k: keyof Errors) => (touched ? errors[k] : undefined);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useApiMutation((b: ContentBrief) => api.saveBrief(b), { success: 'Brief saved', invalidate: [['briefs'], ['brief', brief.id], ['opportunities']] });

  const set = <K extends keyof ContentBrief>(k: K, v: ContentBrief[K]) => setForm((f) => ({ ...f, [k]: v }));
  const onSave = () => {
    setTouched(true);
    if (hasErrors) return;
    save.mutate({ ...form, title: form.title.trim(), targetKeyword: form.targetKeyword.trim(), suggestedUrl: form.suggestedUrl.trim(), outline: form.outline.map((o) => o.trim()) });
  };


  return (
    <div>
      <PageHeader
        title={brief.title || 'Untitled brief'}
        description={<>Content brief <span className="font-mono">{brief.id}</span> · updated {fmtDateTime(brief.updatedAt)} IST</>}
        meta={<><DemoBadge /><SourceBadge source={brief.source} /><BriefStatusBadge status={brief.status} />{dirty && <Badge tone="med">Unsaved changes</Badge>}</>}
        actions={
          canEdit ? (
            <>
              {dirty && <Button variant="ghost" onClick={() => { setForm(brief); setTouched(false); }}>Discard changes</Button>}
              <Button variant="primary" loading={save.isPending} disabled={!dirty} title={dirty ? undefined : 'No changes to save'} onClick={onSave}>Save brief</Button>
            </>
          ) : undefined
        }
      />

      <div className="space-y-5">
        <Notice tone="demo" title="Outline is a template in DEMO mode">
          SERP-based outlines (headings, entities and questions mined from the current top 10) need the Ahrefs or Semrush SERP API. Generated outlines here are templates — edit them before the brief goes to production.
        </Notice>
        {!canEdit && <Notice>You can read this brief. Editing needs the <span className="font-mono">opportunities.manage</span> permission.</Notice>}
        {touched && hasErrors && <Notice tone="crit" title="Fix these before saving"><ul className="list-disc pl-5">{Object.values(errors).map((e) => <li key={e}>{e}</li>)}</ul></Notice>}
        {save.error && <Notice tone="crit" title="The brief was not saved">{errorMessage(save.error)}</Notice>}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-5">
            <Panel title="Targeting">
              <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <Field label="Title" htmlFor="b-title" required error={showErr('title')}>
                    <Input id="b-title" value={form.title} onChange={(e) => set('title', e.target.value)} aria-invalid={!!showErr('title')} />
                  </Field>
                </div>
                <Field label="Target keyword" htmlFor="b-kw" required error={showErr('targetKeyword')}>
                  <Input id="b-kw" value={form.targetKeyword} onChange={(e) => set('targetKeyword', e.target.value)} aria-invalid={!!showErr('targetKeyword')} />
                </Field>
                <Field label="Cluster" htmlFor="b-cluster" hint="Topic cluster this page belongs to (see Topic clusters).">
                  <Input id="b-cluster" value={form.cluster} onChange={(e) => set('cluster', e.target.value)} />
                </Field>
                <Field label="Search intent" htmlFor="b-intent">
                  <Select id="b-intent" value={form.intent} onChange={(e) => set('intent', e.target.value as SearchIntent)}>
                    {(Object.keys(INTENT_LABELS) as SearchIntent[]).map((i) => <option key={i} value={i}>{INTENT_LABELS[i]}</option>)}
                  </Select>
                </Field>
                <Field label="Page type" htmlFor="b-type">
                  <Select id="b-type" value={form.pageType} onChange={(e) => set('pageType', e.target.value as ContentBrief['pageType'])}>
                    {(Object.keys(PAGE_TYPE_LABELS) as ContentBrief['pageType'][]).map((t) => <option key={t} value={t}>{PAGE_TYPE_LABELS[t]}</option>)}
                  </Select>
                </Field>
                <Field label="Suggested URL" htmlFor="b-url" required error={showErr('suggestedUrl')} hint='Site path starting with "/".'>
                  <Input id="b-url" className="font-mono" value={form.suggestedUrl} onChange={(e) => set('suggestedUrl', e.target.value)} aria-invalid={!!showErr('suggestedUrl')} />
                </Field>
                <Field label="Status" htmlFor="b-status">
                  <Select id="b-status" value={form.status} onChange={(e) => set('status', e.target.value as ContentBrief['status'])}>
                    {(Object.keys(BRIEF_STATUS) as ContentBrief['status'][]).map((s) => <option key={s} value={s}>{BRIEF_STATUS[s].label}</option>)}
                  </Select>
                </Field>
              </fieldset>
            </Panel>

            <OutlineEditor items={form.outline} onChange={(v) => set('outline', v)} disabled={!canEdit} error={showErr('outline')} />
            <EntitiesEditor items={form.entities} onChange={(v) => set('entities', v)} disabled={!canEdit} />
            <FaqEditor items={form.faqs} onChange={(v) => set('faqs', v)} disabled={!canEdit} error={showErr('faqs')} />
            <LinksEditor items={form.internalLinks} onChange={(v) => set('internalLinks', v)} disabled={!canEdit} error={showErr('links')} />
          </div>

          <div className="space-y-5">
            <Panel title="Origin" subtitle="Read-only — where this brief came from">
              <KV
                cols={1}
                items={[
                  { k: 'Origin', v: ORIGIN_LABELS[brief.origin] },
                  { k: 'Reference', v: brief.originRef ? <OriginRef origin={brief.origin} refId={brief.originRef} /> : '—' },
                  { k: 'Data source', v: <SourceBadge source={brief.source} /> },
                  { k: 'Last updated', v: `${fmtDateTime(brief.updatedAt)} IST` },
                ]}
              />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}

function OriginRef({ origin, refId }: { origin: ContentBrief['origin']; refId: string }) {
  if (origin === 'keyword_gap') return <Link to="/opportunities/gaps" className="font-mono text-signal hover:underline">{refId}</Link>;
  if (origin === 'seasonal') return <Link to="/opportunities/seasonal" className="font-mono text-signal hover:underline">{refId}</Link>;
  return <span className="font-mono">{refId}</span>;
}

// ------------------------------------------------------------------ list editors

function OutlineEditor({ items, onChange, disabled, error }: { items: string[]; onChange: (v: string[]) => void; disabled: boolean; error?: string }) {
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <Panel title="Outline" subtitle="Section headings in order" actions={!disabled && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...items, ''])}>Add section</Button>}>
      {items.length ? (
        <ol className="space-y-2">
          {items.map((o, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted">{i + 1}.</span>
              <Input aria-label={`Outline section ${i + 1}`} value={o} disabled={disabled} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} aria-invalid={!!error && !o.trim()} />
              {!disabled && (
                <>
                  <IconButton label={`Move section ${i + 1} up`} disabled={i === 0} className="disabled:opacity-30" onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconButton>
                  <IconButton label={`Move section ${i + 1} down`} disabled={i === items.length - 1} className="disabled:opacity-30" onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconButton>
                  <IconButton label={`Remove section ${i + 1}`} className="hover:text-crit-ink" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : <p className="text-sm text-muted">No sections yet. Add the H2s the page should cover, starting with a 40–60 word direct answer for AEO.</p>}
      {error && <p className="mt-2 text-xs text-crit-ink" role="alert">{error}</p>}
    </Panel>
  );
}

function EntitiesEditor({ items, onChange, disabled }: { items: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const vals = draft.split(',').map((s) => s.trim()).filter((s) => s && !items.some((x) => x.toLowerCase() === s.toLowerCase()));
    if (vals.length) onChange([...items, ...vals]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !draft && items.length) onChange(items.slice(0, -1));
  };
  return (
    <Panel title="Entities to cover" subtitle="Concepts, attributes and named things the page should mention">
      <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Entities">
        {items.map((t) => (
          <li key={t} className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pl-2.5 pr-1 text-xs">
            {t}
            {!disabled && <button type="button" aria-label={`Remove ${t}`} className="rounded-full p-0.5 text-muted hover:bg-raised hover:text-crit-ink" onClick={() => onChange(items.filter((x) => x !== t))}><X className="h-3 w-3" /></button>}
          </li>
        ))}
        {!items.length && <li className="text-sm text-muted">No entities yet.</li>}
      </ul>
      {!disabled && (
        <div className="flex gap-2">
          <Input aria-label="Add entity" placeholder="Type an entity and press Enter" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
          <Button onClick={add} disabled={!draft.trim()}>Add</Button>
        </div>
      )}
    </Panel>
  );
}

function FaqEditor({ items, onChange, disabled, error }: { items: ContentBrief['faqs']; onChange: (v: ContentBrief['faqs']) => void; disabled: boolean; error?: string }) {
  const upd = (i: number, patch: Partial<ContentBrief['faqs'][number]>) => onChange(items.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Panel title="FAQs" subtitle="Questions to answer on the page (FAQPage schema). Drafted answers are optional and need human review." actions={!disabled && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...items, { q: '' }])}>Add FAQ</Button>}>
      {items.length ? (
        <ol className="space-y-3">
          {items.map((f, i) => (
            <li key={i} className="rounded-ctl border border-line p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-2">
                  <Field label={`Question ${i + 1}`} htmlFor={`faq-q-${i}`}>
                    <Input id={`faq-q-${i}`} value={f.q} disabled={disabled} onChange={(e) => upd(i, { q: e.target.value })} aria-invalid={!!error && !f.q.trim()} />
                  </Field>
                  <Field label="Drafted answer (optional)" htmlFor={`faq-a-${i}`}>
                    <Textarea id={`faq-a-${i}`} rows={2} className="min-h-[56px]" value={f.a ?? ''} disabled={disabled} onChange={(e) => upd(i, { a: e.target.value || undefined })} />
                  </Field>
                </div>
                {!disabled && <IconButton label={`Remove question ${i + 1}`} className="mt-6 hover:text-crit-ink" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>}
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="text-sm text-muted">No FAQs yet. Add People Also Ask questions for the target keyword.</p>}
      {error && <p className="mt-2 text-xs text-crit-ink" role="alert">{error}</p>}
    </Panel>
  );
}

function LinksEditor({ items, onChange, disabled, error }: { items: ContentBrief['internalLinks']; onChange: (v: ContentBrief['internalLinks']) => void; disabled: boolean; error?: string }) {
  const upd = (i: number, patch: Partial<ContentBrief['internalLinks'][number]>) => onChange(items.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Panel title="Internal links to add" subtitle="Existing pages that should link to the new page" actions={!disabled && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onChange([...items, { from: '/', anchor: '' }])}>Add link</Button>}>
      {items.length ? (
        <ul className="space-y-2">
          {items.map((l, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input aria-label={`Link ${i + 1} source path`} placeholder="/collections/…" className="font-mono" value={l.from} disabled={disabled} onChange={(e) => upd(i, { from: e.target.value })} aria-invalid={!!error && !l.from.trim().startsWith('/')} />
              <Input aria-label={`Link ${i + 1} anchor text`} placeholder="Anchor text" className="col-start-1 sm:col-start-auto" value={l.anchor} disabled={disabled} onChange={(e) => upd(i, { anchor: e.target.value })} aria-invalid={!!error && !l.anchor.trim()} />
              {!disabled && <IconButton label={`Remove link ${i + 1}`} className="row-start-1 col-start-2 hover:text-crit-ink sm:col-start-auto" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">No internal links yet. Add the pillar and related collections that should point to this page.</p>}
      {error && <p className="mt-2 text-xs text-crit-ink" role="alert">{error}</p>}
    </Panel>
  );
}
