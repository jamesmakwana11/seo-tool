/**
 * AI suggestions for an editor draft: chooses the fields that need work, asks the AI writer for them, and puts the
 * checked values into the draft as suggestions (pre-selected only when every check passed and the change is not a
 * product name or a replaced description — those always go to review). Fields the model could not write keep the
 * rule-based suggestion, with the reason in the draft's AI note.
 */
import { generatesDescription, type FieldAssessment, type SeoBulkField, type SeoFieldType, type ShopifyFieldDraft, type ShopifyFieldSuggestion } from '@sentinel/shared';
import { ClaudeError } from '../ai/claude';
import type { ClaudeService } from '../ai/service';
import { writeSeoFields, type WriteField, type WriteInput, type WriteResult } from '../ai/seoWriter';
import type { Limits } from './drafts';
import { htmlToText } from './drafts';
import type { ShopifyResource } from './resources';

export interface AiDraftOptions {
  /** Only these bulk fields (Fix All of one field, or of the fields chosen). */
  only?: Set<SeoBulkField>;
  /** Values other pages use, per field type (must differ). */
  avoid?: Partial<Record<SeoFieldType, string[]>>;
}

export interface H1Info { current: string; assessment: FieldAssessment; source?: 'title' | 'body' | 'theme' | 'unknown' }

const needs = (a?: FieldAssessment) => !!a && a.verdict !== 'good';
const problemsOf = (a?: FieldAssessment) => (a?.problems ?? []).filter((p) => p.severity !== 'note').map((p) => p.message);
const MAX_ALT_FIELDS = 6;

/** Fields to send to the model (empty = nothing needs AI). */
export function pickFields(res: ShopifyResource, fields: ShopifyFieldDraft[], h1: H1Info | undefined, L: Limits, o: AiDraftOptions, themeSuffix = '' ): WriteField[] {
  const want = (b: SeoBulkField) => !o.only || o.only.has(b);
  const out: WriteField[] = [];
  const avoid = (t: SeoFieldType, f?: ShopifyFieldDraft) => {
    const list = [...(o.avoid?.[t] ?? [])];
    if (f?.assessment?.problems.some((p) => p.code === 'duplicate') && f.current) list.push(f.current);
    return list.length ? [...new Set(list)] : undefined;
  };
  for (const f of fields) {
    if (f.suggestion?.keep) continue;
    if (f.key === 'seoTitle' && want('seoTitle') && needs(f.assessment)) {
      // The theme appends a suffix (“ – Shop”) to the title tag: it counts in the length and is not written again.
      const max = L.titleMaxChars - themeSuffix.length;
      const lo = Math.max(10, (f.assessment!.target?.[0] ?? 50) - themeSuffix.length);
      out.push({
        key: f.key, type: 'seoTitle', current: f.current || res.title, problems: problemsOf(f.assessment), target: [Math.min(lo, max), max], max, avoid: avoid('seoTitle', f),
        ...(themeSuffix ? { note: `The theme already appends “${themeSuffix.trim()}” to the title tag: do not add the shop name; the limits above leave room for it.` } : {}),
      });
    } else if (f.key === 'seoDescription' && want('seoDescription') && needs(f.assessment)) {
      out.push({ key: f.key, type: 'seoDescription', current: f.current, problems: problemsOf(f.assessment), target: f.assessment!.target, max: L.metaMaxChars, avoid: avoid('seoDescription', f) });
    } else if (f.key === 'title' && (want('title') || (want('h1') && h1?.source === 'title')) && needs(f.assessment)) {
      const onlySpacing = f.assessment!.problems.filter((p) => p.severity !== 'note').every((p) => p.code === 'whitespace');
      if (!onlySpacing) out.push({ key: f.key, type: 'title', current: f.current, problems: problemsOf(f.assessment), target: f.assessment!.target, max: 255, avoid: avoid('title', f) });
    } else if (f.key === 'tags' && want('tags') && f.assessment?.problems.some((p) => p.code === 'missing')) {
      out.push({ key: f.key, type: 'tags', current: f.current, problems: problemsOf(f.assessment), target: f.assessment!.target });
    } else if (f.key === 'bodyHtml' && want('description') && generatesDescription(res.kind) && needs(f.assessment)) {
      out.push({ key: f.key, type: 'description', current: htmlToText(f.current), problems: problemsOf(f.assessment), target: f.assessment!.target, avoid: avoid('description', f) });
    } else if (f.key.startsWith('imageAlt:') && want('imageAlt') && needs(f.assessment) && out.filter((x) => x.type === 'imageAlt').length < MAX_ALT_FIELDS) {
      out.push({ key: f.key, type: 'imageAlt', current: f.current, problems: problemsOf(f.assessment), max: Math.min(125, L.altMaxChars), ...(f.hint && /^https?:\/\//.test(f.hint) ? { imageUrl: f.hint } : {}) });
    }
  }
  if (h1 && h1.source !== 'title' && h1.source !== 'theme' && want('h1') && needs(h1.assessment) && !h1.assessment.problems.every((p) => p.code === 'multiple' || p.severity === 'note')) {
    out.push({ key: 'h1', type: 'h1', current: h1.current, problems: problemsOf(h1.assessment), target: h1.assessment.target, max: 255 });
  }
  return out;
}

/** Suggestion for one field from the writer's result. */
export function aiSuggestion(f: WriteField, w: WriteResult['values'][string], model: string, current: string): ShopifyFieldSuggestion {
  // A product / collection name or a replaced description is a bigger change: always reviewed by a person first.
  const bigChange = f.type === 'title' || (f.type === 'description' && current.trim() !== '');
  return {
    value: w.value, reason: w.reason || 'Written by Claude from the page’s content.', keep: false,
    confidence: w.confidence === 'high' && !bigChange ? 'high' : 'review', source: 'ai', model,
    ...(f.target ? { target: f.target } : {}), ...(f.type === 'description' ? { purpose: 'description' as const } : {}),
  };
}

/** Short-lived cache of AI results (per resource version and field values): lists, editor and Fix All reuse them. */
export function createAiCache(max = 400, ttlMs = 30 * 60_000) {
  const m = new Map<string, { at: number; r: WriteResult }>();
  return {
    get(k: string, now: number) { const v = m.get(k); return v && now - v.at < ttlMs ? v.r : undefined; },
    set(k: string, r: WriteResult, now: number) { m.set(k, { at: now, r }); if (m.size > max) m.delete(m.keys().next().value as string); },
  };
}

export async function runAi(claude: ClaudeService, input: WriteInput, cache: ReturnType<typeof createAiCache>, key: string, now: number): Promise<{ result?: WriteResult; error?: ClaudeError }> {
  const hit = cache.get(key, now);
  if (hit) return { result: hit };
  try {
    const result = await writeSeoFields(claude, input);
    cache.set(key, result, now);
    return { result };
  } catch (e) {
    return { error: e instanceof ClaudeError ? e : new ClaudeError('network', (e as Error).message) };
  }
}
