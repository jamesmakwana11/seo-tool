import { useState, type ReactNode } from 'react';
import { Plus, RotateCcw, Save, X } from 'lucide-react';
import type { IntegrationState, SentinelConfig } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation } from '@/api/hooks';
import { Badge, Button, Input, Notice, Panel, type Tone } from '@/components/ui/primitives';

/** True when any number nested in the value is NaN/Infinity (e.g. a cleared number input). */
function hasNonFinite(v: unknown): boolean {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasNonFinite);
  if (v && typeof v === 'object') return Object.values(v).some(hasNonFinite);
  return false;
}

export function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Small provenance tag: where a default value comes from. */
export function OriginTag({ origin }: { origin: string }) {
  const workshop = /workshop/i.test(origin);
  return <Badge tone={workshop ? 'caution' : 'neutral'} title={workshop ? 'Not specified in the PDF — placeholder until the kickoff workshop (PDF p22)' : 'Default taken from seotooldocs.pdf'}>{origin}</Badge>;
}

/**
 * One editable slice of SentinelConfig with its own dirty tracking and Save.
 * Only this slice is sent to api.updateConfig, so saving one section never overwrites another.
 * Server validation errors are shown inline (and toasted by useApiMutation).
 */
export function ConfigSection<K extends keyof SentinelConfig>({
  config, k, title, subtitle, canEdit, readOnlyReason, validate, children, id, origin, saveLabel = 'Save',
}: {
  config: SentinelConfig;
  k: K;
  title: ReactNode;
  subtitle?: ReactNode;
  canEdit: boolean;
  readOnlyReason?: string;
  validate?: (v: SentinelConfig[K]) => string | undefined;
  children: (value: SentinelConfig[K], set: (v: SentinelConfig[K]) => void, disabled: boolean) => ReactNode;
  id?: string;
  origin?: string;
  saveLabel?: string;
}) {
  const [draft, setDraft] = useState<SentinelConfig[K] | null>(null);
  const value = draft ?? config[k];
  const dirty = draft !== null && !sameJson(draft, config[k]);
  const clientError = !dirty ? undefined : hasNonFinite(value) ? 'Enter a number in every numeric field.' : validate?.(value);
  const m = useApiMutation((v: SentinelConfig[K]) => api.updateConfig({ [k]: v } as Partial<SentinelConfig>), {
    success: 'Settings saved',
    invalidate: [['config'], ['audit'], ['dashboard']],
    onSuccess: () => setDraft(null),
  });
  const apiError = m.error && dirty ? errorMessage(m.error) : undefined;
  return (
    <Panel
      id={id}
      title={<span className="flex flex-wrap items-center gap-2">{title}{origin && <OriginTag origin={origin} />}{dirty && <Badge tone="med">Unsaved changes</Badge>}</span>}
      subtitle={subtitle}
      actions={canEdit ? (
        <>
          {dirty && <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { setDraft(null); m.reset(); }}>Discard</Button>}
          <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty || !!clientError} loading={m.isPending} onClick={() => m.mutate(value)}>{saveLabel}</Button>
        </>
      ) : <Badge tone="neutral" title={readOnlyReason}>Read-only</Badge>}
    >
      <div className="space-y-4">
        {children(value, (v) => setDraft(v), !canEdit || m.isPending)}
        {clientError && <Notice tone="crit">{clientError}</Notice>}
        {apiError && <Notice tone="crit" title="Not saved">{apiError}</Notice>}
        {!canEdit && readOnlyReason && <p className="text-xs text-muted">{readOnlyReason}</p>}
      </div>
    </Panel>
  );
}

/** Labelled number input bound to a field. */
export function NumberField({ id, label, value, onChange, disabled, min, max, step, hint, suffix }: { id: string; label: ReactNode; value: number; onChange: (n: number) => void; disabled?: boolean; min?: number; max?: number; step?: number; hint?: ReactNode; suffix?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[13px] font-medium text-ink">{label}</label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step ?? 'any'} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} aria-invalid={!Number.isFinite(value) || (min !== undefined && value < min)} className="max-w-[160px]" />
        {suffix && <span className="text-xs text-muted">{suffix}</span>}
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Add/remove list of strings. */
export function StringListEditor({ label, items, onChange, disabled, placeholder, mono }: { label: string; items: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; mono?: boolean }) {
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (!t || items.includes(t)) return;
    onChange([...items, t]);
    setText('');
  };
  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {items.map((it) => (
          <li key={it} className={`inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pl-2.5 pr-1 text-sm ${mono ? 'font-mono text-[12.5px]' : ''}`}>
            {it}
            {!disabled && <button type="button" className="rounded-full p-0.5 text-muted hover:bg-raised hover:text-crit-ink" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((x) => x !== it))}><X className="h-3.5 w-3.5" /></button>}
          </li>
        ))}
        {!items.length && <li className="text-sm text-muted">None yet.</li>}
      </ul>
      {!disabled && (
        <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input aria-label={`Add to ${label}`} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} className={mono ? 'font-mono' : undefined} />
          <Button type="submit" size="md" icon={<Plus className="h-4 w-4" />} disabled={!text.trim()}>Add</Button>
        </form>
      )}
    </div>
  );
}

const STATE: Record<IntegrationState, { label: string; tone: Tone }> = {
  not_configured: { label: 'Not configured', tone: 'neutral' },
  credentials_missing: { label: 'Credentials missing', tone: 'med' },
  connection_failed: { label: 'Connection failed', tone: 'crit' },
  connected: { label: 'Connected', tone: 'ok' },
  partial: { label: 'Partially connected', tone: 'med' },
  rate_limited: { label: 'Rate limited', tone: 'med' },
  sync_failed: { label: 'Sync failed', tone: 'crit' },
};

export function IntegrationStateBadge({ state }: { state: IntegrationState }) {
  return <Badge tone={STATE[state].tone}>{STATE[state].label}</Badge>;
}

/** "tier1TopProducts" → "Tier 1 top products". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
  const map: Record<string, string> = { ms: 'ms', pct: '%', kb: 'KB', px: 'px', lcp: 'LCP', inp: 'INP', cls: 'CLS', psi: 'PSI', ctr: 'CTR', dr: 'DR', ai: 'AI', seo: 'SEO', cwv: 'CWV', url: 'URL', urls: 'URLs', desc: 'description' };
  const unitWords = new Set(['ms', '%', 'KB', 'px']);
  const kept: string[] = [];
  const extras: string[] = [];
  for (const w of words.map((x) => map[x] ?? x)) {
    if (unitWords.has(w) || /^\d+[hd]$/.test(w)) extras.push(w);
    else kept.push(w);
  }
  const s = kept.join(' ');
  const label = s.charAt(0).toUpperCase() + s.slice(1);
  return extras.length ? `${label} (${extras.join(', ')})` : label;
}
