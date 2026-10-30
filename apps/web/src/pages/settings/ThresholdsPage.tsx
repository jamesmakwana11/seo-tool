import { useState } from 'react';
import { Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { SCORE_MODULE_LABELS, type FestivalEntry, type PageTier, type ScoreModule, type SentinelConfig, type Severity } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Checkbox, IconButton, Input, Notice, PageHeader, Select, Toggle } from '@/components/ui/primitives';
import { ConfigSection, NumberField, OriginTag, StringListEditor, humanizeKey } from '@/components/settings/ConfigSection';
import { fmtDateTime } from '@/lib/format';

const READ_ONLY = 'Editing thresholds needs the settings.manage permission (SEO lead or Admin).';

export default function ThresholdsPage() {
  const q = useApiQuery(['config'], () => api.getConfig());
  return (
    <div>
      <PageHeader
        title="Thresholds & scoring"
        description="The threshold configuration file (PDF §17) — severity cutoffs, tier definitions, SLA days and scoring — editable by the SEO lead without code changes. Values not given in the PDF are placeholders until the kickoff workshop (PDF p22)."
        meta={<>{q.data && <span className="text-xs text-muted">Last updated {fmtDateTime(q.data.updatedAt)} IST by {q.data.updatedBy}</span>}</>}
      />
      <Async q={q} rows={12}>{(c) => <Sections c={c} />}</Async>
    </div>
  );
}

function Sections({ c }: { c: SentinelConfig }) {
  const { can, user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const edit = can('settings.manage');
  const nav = [
    ['tiers', 'Page tiers'], ['sla', 'SLA'], ['escalation', 'Escalation'], ['scoring', 'Scoring'], ['thresholds', 'Check thresholds'], ['automation', 'Automation'],
    ['ai-crawlers', 'AI crawlers'], ['noindex', 'Intentional noindex'], ['competitors', 'Competitors'], ['money', 'Money keywords'], ['festivals', 'Festival calendar'],
  ];
  return (
    <div className="space-y-5">
      {!edit && <Notice>{READ_ONLY} You can view every value.</Notice>}
      <nav aria-label="Sections" className="flex flex-wrap gap-1.5">
        {nav.map(([id, label]) => <a key={id} href={`#${id}`} className="rounded-full border border-line-strong bg-surface px-2.5 py-1 text-xs text-ink-soft hover:border-muted/50">{label}</a>)}
      </nav>

      <ConfigSection config={c} k="tiers" id="tiers" title="Page tiers" subtitle="Tier 1 = top collections + top products by revenue or sessions, recomputed nightly (PDF §3.1)" origin="PDF §3.1" canEdit={edit} readOnlyReason={READ_ONLY}
        validate={(v) => (v.tier1TopCollections < 1 || v.tier1TopProducts < 1 || v.tier1LookbackDays < 1 ? 'All tier values must be at least 1.' : undefined)}>
        {(v, set, d) => (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField id="t-col" label="Tier 1 top collections" value={v.tier1TopCollections} min={1} step={1} disabled={d} onChange={(n) => set({ ...v, tier1TopCollections: n })} />
            <NumberField id="t-prod" label="Tier 1 top products" value={v.tier1TopProducts} min={1} step={1} disabled={d} onChange={(n) => set({ ...v, tier1TopProducts: n })} />
            <NumberField id="t-look" label="Lookback window" value={v.tier1LookbackDays} min={1} step={1} suffix="days" disabled={d} onChange={(n) => set({ ...v, tier1LookbackDays: n })} hint="Basis: revenue or sessions (GA4)." />
          </div>
        )}
      </ConfigSection>

      <ConfigSection config={c} k="sla" id="sla" title="SLA" subtitle="Critical same day · Medium 7 days · Low 30 days (PDF §3.2). Watch window is a workshop placeholder." origin="PDF §3.2" canEdit={edit} readOnlyReason={READ_ONLY}
        validate={(v) => (v.mediumDays < 1 ? 'Medium SLA must be at least 1 day.' : v.lowDays < v.mediumDays ? 'Low SLA must be at least the Medium SLA.' : v.watchWindowHours < 1 ? 'Watch window must be at least 1 hour.' : undefined)}>
        {(v, set, d) => (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <p className="text-[13px] font-medium">Critical fixed same day</p>
              <div className="flex items-center gap-2"><Toggle checked={v.criticalSameDay} onChange={(b) => set({ ...v, criticalSameDay: b })} label="Critical fixed same day" disabled={d} /><span className="text-sm text-muted">{v.criticalSameDay ? 'On' : 'Off'}</span></div>
            </div>
            <NumberField id="s-med" label="Medium SLA" value={v.mediumDays} min={1} step={1} suffix="days" disabled={d} onChange={(n) => set({ ...v, mediumDays: n })} />
            <NumberField id="s-low" label="Low SLA" value={v.lowDays} min={1} step={1} suffix="days" disabled={d} onChange={(n) => set({ ...v, lowDays: n })} />
            <NumberField id="s-watch" label={<span className="inline-flex items-center gap-1.5">Watchlist window <OriginTag origin="Workshop" /></span>} value={v.watchWindowHours} min={1} step={1} suffix="hours" disabled={d} onChange={(n) => set({ ...v, watchWindowHours: n })} hint="Items due within this window appear on the digest watchlist." />
          </div>
        )}
      </ConfigSection>

      <ConfigSection config={c} k="escalation" id="escalation" title="Escalation" subtitle="Escalation and auto-allocation rules (PDF §3.3, §11.1a, §12.4)" origin="PDF §3.3" canEdit={edit} readOnlyReason={READ_ONLY}
        validate={(v) => (v.templateGroupThreshold < 2 ? 'Template grouping threshold must be at least 2.' : v.unallocatedCriticalHours < 1 ? 'Unallocated-critical window must be at least 1 hour.' : undefined)}>
        {(v, set, d) => (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Checkbox label="Medium past SLA escalates to Critical" checked={v.mediumBreachEscalates} disabled={d} onChange={(b) => set({ ...v, mediumBreachEscalates: b })} />
            <Checkbox label="Issue on a page promoted to Tier 1 escalates" checked={v.tier1PromotionEscalates} disabled={d} onChange={(b) => set({ ...v, tier1PromotionEscalates: b })} />
            <NumberField id="e-group" label="Template-level grouping threshold" value={v.templateGroupThreshold} min={2} step={1} suffix="pages" disabled={d} onChange={(n) => set({ ...v, templateGroupThreshold: n })} hint="Same issue on this many pages of one template becomes one template-level fix." />
            <NumberField id="e-unalloc" label="Auto-allocate unallocated Criticals after" value={v.unallocatedCriticalHours} min={1} step={1} suffix="hours" disabled={d} onChange={(n) => set({ ...v, unallocatedCriticalHours: n })} hint="Creates a task for the engine-suggested team and escalates to the SEO lead (PDF §12.4)." />
          </div>
        )}
      </ConfigSection>

      <ScoringSection c={c} edit={edit} />
      <ThresholdsSection c={c} edit={edit} />

      <ConfigSection config={c} k="automation" id="automation" title="Live-site automation opt-ins" subtitle="Off by default. Admin only." origin="PDF §17" canEdit={edit && isAdmin} readOnlyReason="Only Admins can change live-site automation opt-ins." saveLabel="Save opt-ins">
        {(v, set, d) => (
          <div className="space-y-3">
            <Notice tone="med" icon={<ShieldAlert className="h-4 w-4" />} title="No silent auto-changes to the live site (PDF §17)">
              Sentinel only proposes redirects, meta rewrites, schema updates and disavows — humans approve. These two are the only live-site automations the PDF allows, and each still needs an explicit opt-in here. Both also require the Shopify write scope on the API server.
            </Notice>
            <div className="flex items-start gap-3">
              <Toggle checked={v.autoRedirectDeletedProducts} onChange={(b) => set({ ...v, autoRedirectDeletedProducts: b })} label="Auto-301 deleted products to their parent collection" disabled={d} />
              <div><p className="text-sm font-medium">Auto-301 deleted products to their parent collection</p><p className="text-xs text-muted">Needs write_online_store_navigation on the Shopify custom app.</p></div>
            </div>
            <div className="flex items-start gap-3">
              <Toggle checked={v.autoApplySchemaUpdates} onChange={(b) => set({ ...v, autoApplySchemaUpdates: b })} label="Auto-apply schema updates required by Google guideline changes" disabled={d} />
              <div><p className="text-sm font-medium">Auto-apply schema updates required by Google’s monthly guideline changes</p><p className="text-xs text-muted">Linked to the schema guideline sync check (PDF §4.6).</p></div>
            </div>
          </div>
        )}
      </ConfigSection>

      <ConfigSection config={c} k="aiCrawlerPolicy" id="ai-crawlers" title="AI crawler policy" subtitle="Which AI crawlers DeoDap intends to allow. Blocks marked intentional are not raised as GEO issues (PDF §9)." origin="Workshop" canEdit={edit} readOnlyReason={READ_ONLY}>
        {(v, set, d) => <CrawlerPolicy value={v} set={set} disabled={d} />}
      </ConfigSection>

      <ConfigSection config={c} k="intentionalNoindex" id="noindex" title="Intentional noindex paths" subtitle="Path prefixes the classifier skips for noindex checks — the learned-exclusions list (PDF §17)" canEdit={edit} readOnlyReason={READ_ONLY}
        validate={(v) => (v.some((p) => !p.startsWith('/')) ? 'Paths must start with “/”.' : undefined)}>
        {(v, set, d) => <StringListEditor label="Intentional noindex paths" items={v} onChange={set} disabled={d} placeholder="/pages/internal" mono />}
      </ConfigSection>

      <ConfigSection config={c} k="competitors" id="competitors" title="Competitors" subtitle="3–5 named competitors for the competitor view and keyword gaps (PDF §12.3). Placeholders until the kickoff workshop." origin="Workshop" canEdit={edit} readOnlyReason={READ_ONLY}
        validate={(v) => (v.some((x) => !x.name.trim() || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.domain.trim())) ? 'Every competitor needs a name and a bare domain like example.in.' : new Set(v.map((x) => x.domain)).size !== v.length ? 'Domains must be unique.' : undefined)}>
        {(v, set, d) => (
          <div className="space-y-2">
            {v.map((x, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input aria-label={`Competitor ${i + 1} name`} placeholder="Name" value={x.name} disabled={d} onChange={(e) => set(v.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} className="w-44" />
                <Input aria-label={`Competitor ${i + 1} domain`} placeholder="domain.in" value={x.domain} disabled={d} onChange={(e) => set(v.map((y, j) => (j === i ? { ...y, domain: e.target.value } : y)))} className="w-56 font-mono" />
                {x.domain.endsWith('.example') && <Badge tone="caution">Placeholder</Badge>}
                {!d && <IconButton label={`Remove competitor ${x.name || i + 1}`} onClick={() => set(v.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton>}
              </div>
            ))}
            {!d && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} disabled={v.length >= 8} onClick={() => set([...v, { name: '', domain: '' }])}>Add competitor</Button>}
          </div>
        )}
      </ConfigSection>

      <ConfigSection config={c} k="moneyKeywords" id="money" title="Money keywords" subtitle="Tracked in the monthly executive report’s ranking-movement table (PDF §12.5)" origin="Workshop" canEdit={edit} readOnlyReason={READ_ONLY}>
        {(v, set, d) => <StringListEditor label="Money keywords" items={v} onChange={set} disabled={d} placeholder="wholesale kitchen products" />}
      </ConfigSection>

      <ConfigSection config={c} k="festivals" id="festivals" title="Festival & season calendar" subtitle="Drives 60-day-ahead seasonal prompts (PDF §13). Lunar-calendar dates shift yearly — confirm each one." canEdit={edit} readOnlyReason={READ_ONLY}
        validate={(v) => (v.some((f) => !f.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) ? 'Every entry needs a name and a date.' : undefined)}>
        {(v, set, d) => <FestivalEditor value={v} set={set} disabled={d} />}
      </ConfigSection>
    </div>
  );
}

const MODULES: ScoreModule[] = ['technical', 'onpage', 'content_ai', 'performance', 'offpage', 'aeo', 'geo'];
const SEVS: Severity[] = ['critical', 'medium', 'low'];
const TIERS: PageTier[] = [1, 2, 3];

function ScoringSection({ c, edit }: { c: SentinelConfig; edit: boolean }) {
  const sumPct = (w: Record<ScoreModule, number>) => Math.round(MODULES.reduce((s, m) => s + (w[m] || 0), 0) * 1000) / 10;
  return (
    <ConfigSection config={c} k="scoring" id="scoring" title="Scoring" subtitle="SEO Health Score = weighted modules; module score = 100 − severity-weighted open issues normalised by site size, Tier 1 weighted 5× (PDF §14)" origin="PDF §14" canEdit={edit} readOnlyReason={READ_ONLY}
      validate={(v) => {
        const s = sumPct(v.weights);
        if (!(Math.abs(s - 100) <= 0.05)) return `Module weights must sum to 100% (currently ${s}%).`;
        if ([...SEVS.map((x) => v.severityWeights[x]), ...TIERS.map((t) => v.tierMultipliers[t]), v.normalizationK].some((n) => !Number.isFinite(n) || n < 0)) return 'Weights, multipliers and K must be non-negative numbers.';
        return undefined;
      }}>
      {(v, set, d) => {
        const s = sumPct(v.weights);
        const ok = Math.abs(s - 100) <= 0.05;
        return (
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">Module weights <Badge tone={ok ? 'ok' : 'crit'}>Sum {s}%{ok ? '' : ' — must be 100%'}</Badge></legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {MODULES.map((m) => (
                  <NumberField key={m} id={`w-${m}`} label={SCORE_MODULE_LABELS[m]} value={Math.round(v.weights[m] * 1000) / 10} min={0} max={100} step={0.5} suffix="%" disabled={d}
                    onChange={(n) => set({ ...v, weights: { ...v.weights, [m]: n / 100 } })} />
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">PDF defaults: Technical 30 · On-Page 20 · Content & AI 15 · Performance 10 · Off-Page 10 · AEO 8 · GEO 7.</p>
            </fieldset>
            <fieldset>
              <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">Severity weights <OriginTag origin="Workshop" /></legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {SEVS.map((x) => <NumberField key={x} id={`sw-${x}`} label={x.charAt(0).toUpperCase() + x.slice(1)} value={v.severityWeights[x]} min={0} step={0.5} disabled={d} onChange={(n) => set({ ...v, severityWeights: { ...v.severityWeights, [x]: n } })} />)}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">Tier multipliers <OriginTag origin="PDF §14 (Tier 1 = 5×)" /></legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {TIERS.map((t) => <NumberField key={t} id={`tm-${t}`} label={`Tier ${t}`} value={v.tierMultipliers[t]} min={0} step={0.5} suffix="×" disabled={d} onChange={(n) => set({ ...v, tierMultipliers: { ...v.tierMultipliers, [t]: n } })} />)}
              </div>
            </fieldset>
            <NumberField id="norm-k" label={<span className="inline-flex items-center gap-1.5">Normalization K <OriginTag origin="Workshop" /></span>} value={v.normalizationK} min={0} step={0.01} disabled={d} onChange={(n) => set({ ...v, normalizationK: n })} hint="Penalty points absorbed per indexable page — larger sites tolerate more open issues." />
          </div>
        );
      }}
    </ConfigSection>
  );
}

/** Group threshold keys by the PDF area they belong to (prefix-based, unmatched → Other). */
const GROUPS: { title: string; match: RegExp }[] = [
  { title: 'Indexation & crawl (PDF §4.1–4.2)', match: /^(index|sitemap|crawl|server|redirect)/ },
  { title: 'Core Web Vitals & performance (PDF §4.4)', match: /^(lcp|inp|cls|psi|image|thirdParty)/ },
  { title: 'Security & mobile (PDF §4.5)', match: /^(cert|mobile)/ },
  { title: 'Structured data (PDF §4.6)', match: /^richResult/ },
  { title: 'Content (PDF §5)', match: /^(thinContent|content|freshness)/ },
  { title: 'On-page & keywords (PDF §6)', match: /^(title|meta|homepage|collectionDesc|striking|lowCtr)/ },
  { title: 'Off-page (PDF §7)', match: /^(lostLink|toxic|exactMatch|festival)/ },
  { title: 'AEO, GEO & AI content (PDF §8–10)', match: /^(answerBlock|aiPrompt|retrieval|scaledAbuse|dryRun)/ },
  { title: 'Opportunities & reporting (PDF §12–13, §16)', match: /^(keywordGap|digest|weekly|falsePositive)/ },
];

function ThresholdsSection({ c, edit }: { c: SentinelConfig; edit: boolean }) {
  const keys = Object.keys(c.thresholds);
  const grouped = GROUPS.map((g) => ({ title: g.title, keys: keys.filter((k) => g.match.test(k)) }));
  const used = new Set(grouped.flatMap((g) => g.keys));
  const other = keys.filter((k) => !used.has(k));
  if (other.length) grouped.push({ title: 'Other', keys: other });
  return (
    <ConfigSection config={c} k="thresholds" id="thresholds" title="Check thresholds" subtitle={`${keys.length} severity cutoffs used by the checks. Most come from the PDF; a few (e.g. striking-distance minimum impressions) are workshop placeholders.`} origin="PDF §4–§16" canEdit={edit} readOnlyReason={READ_ONLY}
      validate={(v) => { const bad = Object.entries(v).find(([, n]) => !Number.isFinite(n) || n < 0); return bad ? `${humanizeKey(bad[0])} must be a non-negative number.` : undefined; }}>
      {(v, set, d) => (
        <div className="space-y-5">
          {grouped.filter((g) => g.keys.length).map((g) => (
            <fieldset key={g.title}>
              <legend className="mb-2 text-sm font-semibold">{g.title}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {g.keys.map((k) => (
                  <NumberField key={k} id={`th-${k}`} label={<span title={k}>{humanizeKey(k)}</span>} value={v[k]} min={0} disabled={d} onChange={(n) => set({ ...v, [k]: n })} hint={<span className="font-mono">{k}</span>} />
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
    </ConfigSection>
  );
}

function CrawlerPolicy({ value, set, disabled }: { value: SentinelConfig['aiCrawlerPolicy']; set: (v: SentinelConfig['aiCrawlerPolicy']) => void; disabled: boolean }) {
  const [bot, setBot] = useState('');
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-ctl border border-line">
        {Object.entries(value).map(([name, policy]) => (
          <li key={name} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-[140px] flex-1 font-mono text-[12.5px]">{name}</span>
            <label className="sr-only" htmlFor={`bot-${name}`}>Policy for {name}</label>
            <Select id={`bot-${name}`} value={policy} disabled={disabled} onChange={(e) => set({ ...value, [name]: e.target.value as 'allow' | 'block_intentional' })} className="w-56">
              <option value="allow">Allow</option>
              <option value="block_intentional">Block (intentional)</option>
            </Select>
            {!disabled && <IconButton label={`Remove ${name}`} onClick={() => { const n = { ...value }; delete n[name]; set(n); }}><Trash2 className="h-4 w-4" /></IconButton>}
          </li>
        ))}
      </ul>
      {!disabled && (
        <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); const b = bot.trim(); if (b && !(b in value)) { set({ ...value, [b]: 'allow' }); setBot(''); } }}>
          <Input aria-label="Add crawler user-agent token" placeholder="ClaudeBot" value={bot} onChange={(e) => setBot(e.target.value)} className="font-mono" />
          <Button type="submit" icon={<Plus className="h-4 w-4" />} disabled={!bot.trim()}>Add crawler</Button>
        </form>
      )}
    </div>
  );
}

function FestivalEditor({ value, set, disabled }: { value: FestivalEntry[]; set: (v: FestivalEntry[]) => void; disabled: boolean }) {
  const patch = (id: string, p: Partial<FestivalEntry>) => set(value.map((f) => (f.id === id ? { ...f, ...p } : f)));
  return (
    <div className="space-y-3">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">Festival calendar</caption>
          <thead><tr className="border-b border-line text-left text-xs text-muted"><th scope="col" className="py-2 pr-2 font-medium">Name</th><th scope="col" className="px-2 py-2 font-medium">Date</th><th scope="col" className="px-2 py-2 font-medium">Confirmed</th><th scope="col" className="px-2 py-2 font-medium">Kind</th><th scope="col" className="px-2 py-2 font-medium">Categories (comma-separated)</th><th scope="col" className="py-2 pl-2"><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {[...value].sort((a, b) => a.date.localeCompare(b.date)).map((f) => (
              <tr key={f.id} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-2"><Input aria-label="Festival name" value={f.name} disabled={disabled} onChange={(e) => patch(f.id, { name: e.target.value })} /></td>
                <td className="px-2 py-1.5"><Input aria-label={`Date for ${f.name}`} type="date" value={f.date} disabled={disabled} onChange={(e) => patch(f.id, { date: e.target.value })} className="w-40" /></td>
                <td className="px-2 py-1.5"><Checkbox label={f.dateConfirmed ? 'Confirmed' : 'Unconfirmed'} checked={f.dateConfirmed} disabled={disabled} onChange={(b) => patch(f.id, { dateConfirmed: b })} /></td>
                <td className="px-2 py-1.5">
                  <Select aria-label={`Kind for ${f.name}`} value={f.kind} disabled={disabled} onChange={(e) => patch(f.id, { kind: e.target.value as FestivalEntry['kind'] })} className="w-28"><option value="festival">Festival</option><option value="season">Season</option></Select>
                </td>
                <td className="px-2 py-1.5"><CategoriesInput value={f.categories} disabled={disabled} onChange={(cats) => patch(f.id, { categories: cats })} label={`Categories for ${f.name}`} /></td>
                <td className="py-1.5 pl-2">{!disabled && <IconButton label={`Remove ${f.name}`} onClick={() => set(value.filter((x) => x.id !== f.id))}><Trash2 className="h-4 w-4" /></IconButton>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set([...value, { id: `fest-${Date.now().toString(36)}`, name: '', date: new Date().toISOString().slice(0, 10), dateConfirmed: false, categories: [], kind: 'festival' }])}>Add entry</Button>}
    </div>
  );
}

/** Comma-separated text that only commits parsed categories on blur, so typing commas feels natural. */
function CategoriesInput({ value, onChange, disabled, label }: { value: string[]; onChange: (v: string[]) => void; disabled: boolean; label: string }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      aria-label={label}
      value={text ?? value.join(', ')}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== null) { onChange(text.split(',').map((s) => s.trim()).filter(Boolean)); setText(null); } }}
    />
  );
}
