import { useState } from 'react';
import { Pencil, Play, Plus, Save, Trash2 } from 'lucide-react';
import { EXAMPLE_RULES, TEAMS, TEAM_IDS, validateRule, type CustomRule, type DryRunResult, type PageTemplate, type PageTier, type RuleMethod, type Severity, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { Async, Badge, Button, Checkbox, DemoBadge, EmptyState, Field, Input, Notice, PageHeader, Panel, Select, Textarea, Toggle } from '@/components/ui/primitives';
import { ConfirmDialog, Drawer } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { SeverityBadge, SourceBadge, TeamBadge } from '@/components/domain/badges';
import { fmtDateTime, shortUrl } from '@/lib/format';

type RuleInput = Omit<CustomRule, 'id' | 'createdAt' | 'updatedAt' | 'createdById' | 'source'> & { id?: string };
type Threshold = NonNullable<CustomRule['threshold']>;

const METHOD_LABEL: Record<RuleMethod, string> = { regex: 'Pattern / regex', phrase_list: 'Phrase list', threshold: 'Threshold', llm_judged: 'LLM-judged' };
const ACTION_LABEL: Record<CustomRule['action'], string> = { flag: 'Flag only', flag_and_rewrite: 'Flag + draft rewrite', block_qa_gate: 'Block in publish QA gate' };
const SCHEDULE_LABEL: Record<CustomRule['schedule'], string> = { daily: 'Daily', on_publish: 'On publish', weekly: 'Weekly' };
const METRIC_LABEL: Record<Threshold['metric'], string> = { word_count: 'Word count', keyword_density: 'Keyword density (%)', duplication_pct: 'Duplication %', ai_likelihood: 'AI-likelihood score' };
const TEMPLATES: { id: PageTemplate; label: string }[] = [{ id: 'product', label: 'Products' }, { id: 'collection', label: 'Collections' }, { id: 'blog_article', label: 'Blog articles' }];
const TIERS: PageTier[] = [1, 2, 3];
const RULE_KEYS = [['rules']];

function scopeSummary(s: CustomRule['scope']): string {
  if (s.fullSite) return s.newlyPublishedOnly ? 'Full site · new pages only' : 'Full site';
  const parts: string[] = [];
  if (s.templates.length) parts.push(s.templates.map((t) => TEMPLATES.find((x) => x.id === t)?.label ?? t).join(', '));
  if (s.collections.length) parts.push(`${s.collections.length} collection${s.collections.length > 1 ? 's' : ''}`);
  if (s.tiers.length) parts.push(`Tier ${s.tiers.join('/')}`);
  if (s.newlyPublishedOnly) parts.push('new pages only');
  return parts.join(' · ') || '—';
}

const blank = (): RuleInput => ({
  name: '', description: '', method: 'regex', pattern: '', flags: 'i',
  scope: { templates: ['product'], collections: [], tiers: [], newlyPublishedOnly: false, fullSite: false },
  severity: 'medium', defaultTeam: 'content', action: 'flag', schedule: 'daily', enabled: false,
});

function toInput(r: CustomRule): RuleInput {
  const { createdAt: _c, updatedAt: _u, createdById: _b, source: _s, lastDryRun: _l, ...rest } = r;
  return structuredClone(rest);
}

/** Strip fields that don't belong to the chosen method so the saved rule is clean. */
function normalize(r: RuleInput): RuleInput {
  const out: RuleInput = { ...r, name: r.name.trim(), description: r.description.trim() };
  if (r.method !== 'regex') { delete out.pattern; delete out.flags; }
  if (r.method !== 'phrase_list') { delete out.phrases; delete out.phraseMode; }
  if (r.method !== 'threshold') delete out.threshold;
  else if (out.threshold && out.threshold.metric !== 'keyword_density') out.threshold = { ...out.threshold, keyword: undefined };
  if (r.method !== 'llm_judged') delete out.llmInstruction;
  return out;
}

export default function RuleBuilderPage() {
  const { can } = useAuth();
  const canManage = can('rules.manage');
  const q = useApiQuery(['rules'], () => api.listRules());
  const [editing, setEditing] = useState<RuleInput | null>(null);
  const [deleting, setDeleting] = useState<CustomRule | null>(null);
  const del = useApiMutation((id: string) => api.deleteRule(id), { success: 'Rule deleted', invalidate: [...RULE_KEYS, ['audit']], onSuccess: () => setDeleting(null) });
  return (
    <div>
      <PageHeader
        title="Custom rule builder"
        description="Add AI-content checks without code (PDF §10.2). Custom rules run in the same pipeline as built-ins — same severities, Fix Cards, digest section and verification loop. Dry-run a rule against the last 30 days of pages before enabling it so noisy rules never reach the digest."
        meta={<DemoBadge />}
        actions={canManage ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(blank())}>New rule</Button> : undefined}
      />
      <div className="space-y-5">
        <Notice tone="signal" title="Day-one examples are pre-seeded">
          The {EXAMPLE_RULES.length} example checks from PDF §10.2 are loaded below (lowest-price claim, missing No-MOQ mention, machine-translated Hindi/Hinglish, festival copy after the festival, delivery-timeline promises). LLM-judged rules stay disabled until an LLM provider key is configured on the API server.
        </Notice>
        {!canManage && <Notice>You can view rules. Creating, editing, enabling and dry runs need the rules.manage permission.</Notice>}
        <Panel title="Rules" bodyClassName="p-3">
          <Async q={q} rows={6}>
            {(rules) => (
              <DataTable<CustomRule>
                rows={rules}
                rowKey={(r) => r.id}
                caption="Custom AI-content rules"
                search={(r) => `${r.name} ${r.description}`}
                searchPlaceholder="Search rules"
                empty={<EmptyState title="No custom rules yet" description="Create one with “New rule”, then dry-run it before enabling." />}
                columns={[
                  {
                    key: 'name', header: 'Rule', cell: (r) => (
                      <div className="min-w-[200px]">
                        <p className="font-medium">{r.name}</p>
                        <p className="text-xs text-muted">{METHOD_LABEL[r.method]} · {scopeSummary(r.scope)}</p>
                      </div>
                    ), sort: (a, b) => a.name.localeCompare(b.name),
                  },
                  { key: 'sev', header: 'Severity', cell: (r) => <SeverityBadge severity={r.severity} /> },
                  { key: 'team', header: 'Default team', cell: (r) => <TeamBadge team={r.defaultTeam} short />, hideOnMobile: true },
                  { key: 'act', header: 'Action · schedule', cell: (r) => <span className="text-xs">{ACTION_LABEL[r.action]} · {SCHEDULE_LABEL[r.schedule]}</span>, hideOnMobile: true },
                  { key: 'dry', header: 'Last dry run', cell: (r) => <DryRunSummary d={r.lastDryRun} />, hideOnMobile: true },
                  { key: 'en', header: 'Enabled', cell: (r) => <EnableToggle rule={r} canManage={canManage} /> },
                  {
                    key: 'ops', header: <span className="sr-only">Actions</span>, cell: (r) => (
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(toInput(r))} aria-label={`${canManage ? 'Edit' : 'View'} ${r.name}`}>{canManage ? 'Edit' : 'View'}</Button>
                        {canManage && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}>Delete</Button>}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </Async>
        </Panel>
      </div>

      {editing && <RuleDrawer key={editing.id ?? 'new'} initial={editing} canManage={canManage} lastDryRun={q.data?.find((r) => r.id === editing.id)?.lastDryRun} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete “${deleting.name}”?` : ''}
        body="The rule stops running. Flags it already raised stay on their issues. This is logged in the audit log."
        confirmLabel="Delete rule"
        danger
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </div>
  );
}

function DryRunSummary({ d }: { d?: DryRunResult }) {
  if (!d) return <span className="text-xs text-muted">Not run yet</span>;
  if (!d.evaluated) return <span className="text-xs text-med-ink" title={d.note}>Not evaluated · {fmtDateTime(d.ranAt)}</span>;
  return <span className="text-xs">{d.pagesFlagged} of {d.pagesScanned} flagged<span className="block text-muted">{fmtDateTime(d.ranAt)}</span></span>;
}

function EnableToggle({ rule, canManage }: { rule: CustomRule; canManage: boolean }) {
  const m = useApiMutation((v: boolean) => api.setRuleEnabled(rule.id, v), { success: (r) => (r.enabled ? `Enabled “${r.name}”` : `Disabled “${r.name}”`), invalidate: [...RULE_KEYS, ['audit']] });
  return (
    <div className="space-y-1">
      <Toggle checked={rule.enabled} onChange={(v) => m.mutate(v)} label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`} disabled={!canManage || m.isPending} />
      {m.error && <p className="max-w-[220px] text-xs text-crit-ink" role="alert">{errorMessage(m.error)}</p>}
    </div>
  );
}

function RuleDrawer({ initial, canManage, lastDryRun, onClose }: { initial: RuleInput; canManage: boolean; lastDryRun?: DryRunResult; onClose: () => void }) {
  const toast = useToast();
  const [r, setR] = useState<RuleInput>(initial);
  const [touched, setTouched] = useState(false);
  const [dry, setDry] = useState<DryRunResult | undefined>(lastDryRun);
  const [dryStale, setDryStale] = useState(false);
  const [collectionsText, setCollectionsText] = useState(initial.scope.collections.join(', '));
  const [phrasesText, setPhrasesText] = useState((initial.phrases ?? []).join('\n'));
  const ro = !canManage;
  const isNew = !initial.id;

  const set = (p: Partial<RuleInput>) => { setR((x) => ({ ...x, ...p })); setDryStale(true); };
  const setScope = (p: Partial<RuleInput['scope']>) => set({ scope: { ...r.scope, ...p } });
  const setThreshold = (p: Partial<Threshold>) => set({ threshold: { metric: 'word_count', operator: '<', value: 150, ...r.threshold, ...p } });

  const prepared = (): RuleInput => normalize({
    ...r,
    phrases: r.method === 'phrase_list' ? phrasesText.split(/\n|,/).map((s) => s.trim()).filter(Boolean) : r.phrases,
    scope: { ...r.scope, collections: collectionsText.split(',').map((s) => s.trim()).filter(Boolean) },
  });
  const errors = validateRule(prepared());
  const showErrors = touched && errors.length > 0;

  const save = useApiMutation((x: RuleInput) => api.saveRule(x), { success: (x) => (isNew ? `Rule “${x.name}” created` : `Rule “${x.name}” saved`), invalidate: [...RULE_KEYS, ['audit']], onSuccess: onClose });
  const run = useApiMutation((x: RuleInput) => api.dryRunRule(x), {
    invalidate: RULE_KEYS,
    onSuccess: (res) => {
      setDry(res);
      setDryStale(false);
      if (res.evaluated) toast.success(`Dry run finished: ${res.pagesFlagged} of ${res.pagesScanned} pages would be flagged`);
      else toast.info('Dry run could not evaluate this rule — see the note in the drawer.');
    },
  });
  const attempt = (fn: (x: RuleInput) => void) => { setTouched(true); if (!errors.length) fn(prepared()); };
  /** Attach the dry run only when it was run on exactly this definition, so a new rule can be enabled right after saving. */
  const withDryRun = (x: RuleInput): RuleInput => (dry && !dryStale ? { ...x, lastDryRun: dry } : x);

  return (
    <Drawer
      open
      onClose={onClose}
      width="lg"
      title={ro ? `Rule: ${initial.name}` : isNew ? 'New rule' : `Edit rule: ${initial.name}`}
      footer={ro ? <Button onClick={onClose}>Close</Button> : (
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button icon={<Play className="h-4 w-4" />} loading={run.isPending} onClick={() => attempt((x) => run.mutate(x))}>Run dry run (last 30 days)</Button>
          <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => attempt((x) => save.mutate(withDryRun(x)))}>Save rule</Button>
        </div>
      )}
    >
      <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); if (!ro) attempt((x) => save.mutate(withDryRun(x))); }}>
        <fieldset disabled={ro} className="space-y-3">
          <Field label="Name" htmlFor="r-name" required>
            <Input id="r-name" data-autofocus value={r.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={touched && r.name.trim().length < 3} placeholder='e.g. Unsupported "lowest price in India" claim' />
          </Field>
          <Field label="Description" htmlFor="r-desc" hint="Why this rule exists — shown on the Fix Card.">
            <Textarea id="r-desc" value={r.description} onChange={(e) => set({ description: e.target.value })} className="min-h-[60px]" />
          </Field>
        </fieldset>

        <fieldset disabled={ro} className="space-y-3">
          <legend className="text-sm font-semibold">Detection method</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Detection method">
            {(Object.keys(METHOD_LABEL) as RuleMethod[]).map((m) => (
              <label key={m} className={`flex cursor-pointer items-center gap-2 rounded-ctl border px-3 py-2 text-sm ${r.method === m ? 'border-signal bg-signal-tint' : 'border-line-strong'}`}>
                <input type="radio" name="method" value={m} checked={r.method === m} onChange={() => set({ method: m, ...(m === 'threshold' && !r.threshold ? { threshold: { metric: 'word_count', operator: '<', value: 150 } } : {}), ...(m === 'phrase_list' && !r.phraseMode ? { phraseMode: 'banned' } : {}) })} className="accent-[#7650D8]" />
                {METHOD_LABEL[m]}
              </label>
            ))}
          </div>
          {r.method === 'regex' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field label="Pattern" htmlFor="r-pattern" required hint="JavaScript regular expression, matched against visible page copy.">
                <Input id="r-pattern" value={r.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })} className="font-mono" placeholder="lowest\s+price\s+in\s+india" />
              </Field>
              <Field label="Flags" htmlFor="r-flags" hint="i = ignore case">
                <Input id="r-flags" value={r.flags ?? ''} onChange={(e) => set({ flags: e.target.value })} className="font-mono" maxLength={6} />
              </Field>
            </div>
          )}
          {r.method === 'phrase_list' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-4">
                {(['banned', 'required'] as const).map((pm) => (
                  <label key={pm} className="flex items-center gap-2 text-sm"><input type="radio" name="phraseMode" checked={r.phraseMode === pm} onChange={() => set({ phraseMode: pm })} className="accent-[#7650D8]" />{pm === 'banned' ? 'Banned — flag if any phrase appears' : 'Required — flag if none appear'}</label>
                ))}
              </div>
              <Field label="Phrases" htmlFor="r-phrases" required hint="One per line (or comma-separated). Matched as whole words, case-insensitive.">
                <Textarea id="r-phrases" value={phrasesText} onChange={(e) => { setPhrasesText(e.target.value); setDryStale(true); }} placeholder={'no moq\nno minimum order'} />
              </Field>
            </div>
          )}
          {r.method === 'threshold' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <Field label="Metric" htmlFor="r-metric">
                <Select id="r-metric" value={r.threshold?.metric ?? 'word_count'} onChange={(e) => setThreshold({ metric: e.target.value as Threshold['metric'] })}>
                  {(Object.keys(METRIC_LABEL) as Threshold['metric'][]).map((m) => <option key={m} value={m}>{METRIC_LABEL[m]}</option>)}
                </Select>
              </Field>
              <Field label="Operator" htmlFor="r-op">
                <Select id="r-op" value={r.threshold?.operator ?? '<'} onChange={(e) => setThreshold({ operator: e.target.value as Threshold['operator'] })}>
                  {(['<', '<=', '>', '>='] as const).map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
              </Field>
              <Field label="Value" htmlFor="r-val">
                <Input id="r-val" type="number" step="any" value={r.threshold?.value ?? ''} onChange={(e) => setThreshold({ value: Number(e.target.value) })} />
              </Field>
              {r.threshold?.metric === 'keyword_density' && (
                <Field label="Keyword" htmlFor="r-kw" required>
                  <Input id="r-kw" value={r.threshold.keyword ?? ''} onChange={(e) => setThreshold({ keyword: e.target.value })} />
                </Field>
              )}
              {r.threshold?.metric === 'duplication_pct' && <p className="text-xs text-muted sm:col-span-4">Duplication % needs the duplicate-content analysis; pages without it are reported as not evaluated.</p>}
              {r.threshold?.metric === 'ai_likelihood' && <p className="text-xs text-muted sm:col-span-4">AI-likelihood is a heuristic score (0–100), not a detector verdict — use it to prioritise human review.</p>}
            </div>
          )}
          {r.method === 'llm_judged' && (
            <div className="space-y-2">
              <Field label="Plain-language instruction" htmlFor="r-llm" required hint="The configured LLM evaluates each in-scope page against this instruction.">
                <Textarea id="r-llm" value={r.llmInstruction ?? ''} onChange={(e) => set({ llmInstruction: e.target.value })} placeholder="Flag any product description that promises delivery timelines, since ops hasn't approved delivery promises in copy." />
              </Field>
              <Notice tone="med">LLM-judged rules need an LLM provider (OPENAI_API_KEY or GEMINI_API_KEY) on the API server. Until then dry runs return “not evaluated” and the rule cannot be enabled.</Notice>
            </div>
          )}
        </fieldset>

        <fieldset disabled={ro} className="space-y-3">
          <legend className="text-sm font-semibold">Scope</legend>
          <Checkbox label="Full site" description="Every indexable page; other scope filters are ignored." checked={r.scope.fullSite} onChange={(v) => setScope({ fullSite: v })} disabled={ro} />
          {!r.scope.fullSite && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[13px] font-medium">Templates</p>
                <div className="space-y-1">
                  {TEMPLATES.map((t) => <Checkbox key={t.id} label={t.label} checked={r.scope.templates.includes(t.id)} disabled={ro} onChange={(v) => setScope({ templates: v ? [...r.scope.templates, t.id] : r.scope.templates.filter((x) => x !== t.id) })} />)}
                </div>
              </div>
              <div>
                <p className="mb-1 text-[13px] font-medium">Page tiers</p>
                <div className="space-y-1">
                  {TIERS.map((t) => <Checkbox key={t} label={`Tier ${t}`} checked={r.scope.tiers.includes(t)} disabled={ro} onChange={(v) => setScope({ tiers: v ? [...r.scope.tiers, t].sort() : r.scope.tiers.filter((x) => x !== t) })} />)}
                </div>
              </div>
              <div className="sm:col-span-2">
                <Field label="Specific collections" htmlFor="r-cols" hint="Collection handles, comma-separated (e.g. kitchen-tools, diwali-gifts). Leave empty for all.">
                  <Input id="r-cols" value={collectionsText} onChange={(e) => { setCollectionsText(e.target.value); setDryStale(true); }} className="font-mono" />
                </Field>
              </div>
            </div>
          )}
          <Checkbox label="Newly published pages only" checked={r.scope.newlyPublishedOnly} onChange={(v) => setScope({ newlyPublishedOnly: v })} disabled={ro} />
        </fieldset>

        <fieldset disabled={ro} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-semibold sm:col-span-2">Severity, routing, action & schedule</legend>
          <Field label="Severity" htmlFor="r-sev">
            <Select id="r-sev" value={r.severity} onChange={(e) => set({ severity: e.target.value as Severity })}>
              <option value="critical">Critical</option><option value="medium">Medium</option><option value="low">Low</option>
            </Select>
          </Field>
          <Field label="Fix Card defaults to" htmlFor="r-team">
            <Select id="r-team" value={r.defaultTeam} onChange={(e) => set({ defaultTeam: e.target.value as TeamId })}>
              {TEAM_IDS.map((t) => <option key={t} value={t}>{TEAMS[t].name}</option>)}
            </Select>
          </Field>
          <Field label="Action" htmlFor="r-action" hint={r.action === 'block_qa_gate' ? 'Blocks new pages only — set scope to newly published or schedule to on publish.' : undefined}>
            <Select id="r-action" value={r.action} onChange={(e) => set({ action: e.target.value as CustomRule['action'] })}>
              {(Object.keys(ACTION_LABEL) as CustomRule['action'][]).map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}{a === 'block_qa_gate' ? ' (new pages only)' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Schedule" htmlFor="r-sched">
            <Select id="r-sched" value={r.schedule} onChange={(e) => set({ schedule: e.target.value as CustomRule['schedule'] })}>
              {(Object.keys(SCHEDULE_LABEL) as CustomRule['schedule'][]).map((s) => <option key={s} value={s}>{SCHEDULE_LABEL[s]}</option>)}
            </Select>
          </Field>
        </fieldset>
        {isNew && !ro && <p className="text-xs text-muted">New rules are saved disabled. Run a dry run, then enable the rule from the list.</p>}

        {showErrors && (
          <Notice tone="crit" title="Fix these before saving or running a dry run">
            <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </Notice>
        )}
        {save.error && <Notice tone="crit" title="Not saved">{errorMessage(save.error)}</Notice>}
        {run.error && <Notice tone="crit" title="Dry run failed">{errorMessage(run.error)}</Notice>}

        <DryRunPanel d={dry} stale={dryStale && !!dry} />
        {!ro && !isNew && dry && !dryStale && <p className="text-xs text-muted">This dry run is attached to the rule. Remember to “Save rule” if you changed the definition.</p>}
      </form>
    </Drawer>
  );
}

function DryRunPanel({ d, stale }: { d?: DryRunResult; stale: boolean }) {
  if (!d) return <Notice>No dry run yet. “Run dry run” scans pages from the last 30 days without flagging anything in the digest.</Notice>;
  return (
    <section className="space-y-3 rounded-panel border border-line p-3" aria-label="Dry run result">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Dry run result</h3>
        <SourceBadge source={d.source} />
        {stale && <Badge tone="med">Rule changed since this run</Badge>}
        <span className="ml-auto text-xs text-muted">{fmtDateTime(d.ranAt)} IST · last {d.windowDays} days</span>
      </div>
      {d.evaluated ? (
        <p className="text-sm"><span className="font-semibold tabular-nums">{d.pagesFlagged}</span> of <span className="tabular-nums">{d.pagesScanned}</span> pages scanned would be flagged.</p>
      ) : (
        <Notice tone="med" title="Not evaluated">{d.note ?? 'This rule could not be evaluated.'}</Notice>
      )}
      {d.evaluated && d.note && <p className="text-xs text-muted">{d.note}</p>}
      {d.samples.length > 0 && (
        <ul className="space-y-2">
          {d.samples.map((s, i) => (
            <li key={i} className="rounded-ctl border border-line bg-canvas px-3 py-2">
              <p className="font-mono text-xs text-muted">{shortUrl(s.url)}</p>
              <p className="mt-1 text-sm">“{s.passage}”</p>
              <p className="mt-0.5 text-xs text-muted">{s.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
