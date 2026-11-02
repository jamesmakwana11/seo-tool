/**
 * AI SEO writer: asks the connected Claude model for better values of the fields that need work on one product,
 * collection, page or article — from that resource's own content (title, description text, tags, images) — then checks
 * every value before it is offered:
 *  - length against the field's target (SEO title ~50–60, meta description ~140–160, a normal title / description by
 *    their own needs; alt text describes the image and is never padded);
 *  - still has the store keywords the current value has; adds no figures the content does not have;
 *  - differs from values other pages already use (duplicates) and from the current value;
 *  - HTML descriptions keep to simple, safe markup (paragraphs, lists, H2/H3 — no H1, links, scripts or styles).
 * A value that misses its target gets one corrective retry with the exact problem; if it still misses, it is offered
 * for review (never pre-selected) with the reason. Nothing here writes to Shopify.
 */
import { load } from 'cheerio';
import { assessSeoField, type SeoFieldType, type ShopifyResourceKind } from '@sentinel/shared';
import { ClaudeError } from './claude';
import type { ClaudeService } from './service';

export interface WriteField {
  /** Draft field key: seoTitle, seoDescription, title, h1, bodyHtml (the description), tags, imageAlt:<id>. */
  key: string;
  type: SeoFieldType;
  /** Current value (description: plain text; tags: comma-separated). */
  current: string;
  /** What is wrong with it, in words. */
  problems: string[];
  target?: [number, number];
  /** Hard maximum (characters) — never exceeded. */
  max?: number;
  imageUrl?: string;
  /** Values other pages already use for this field: the new value must differ from them. */
  avoid?: string[];
  /** Extra instruction for this field (e.g. the theme already appends the shop name). */
  note?: string;
}

export interface WriteInput {
  kind: ShopifyResourceKind;
  title: string;
  /** The resource's description / content as plain text (truncated by the caller). */
  descriptionText: string;
  tags: string[];
  shopName?: string;
  url?: string;
  /** Store keywords (Settings → money keywords) the current values contain: keep them. */
  keywords: string[];
  fields: WriteField[];
}

export interface WrittenValue {
  value: string;
  reason: string;
  /** high: every check passed; review: a check failed (stated in `reason`) — a person decides. */
  confidence: 'high' | 'review';
}

export interface WriteResult {
  model: string;
  values: Record<string, WrittenValue>;
  /** Per field that could not be written, why. */
  failed: Record<string, string>;
}

const MAX_DESC_CONTEXT = 4000;
const MAX_IMAGES = 6;

export const SYSTEM_PROMPT = [
  'You are a senior e-commerce SEO copywriter for a Shopify store. You improve the SEO fields of one product, collection, page or blog article.',
  'Rules:',
  '- Use only facts that appear in the provided content (title, description, tags, images). Never invent specifications, sizes, quantities, materials, certifications, prices, discounts, delivery promises, ratings or claims.',
  '- Keep the brand, product names, model numbers and the important keywords that appear in the current values.',
  '- Write natural, specific, readable text for shoppers. No keyword stuffing, no repeated phrases, no ALL CAPS, no emojis, no clickbait, no quotation marks around values.',
  '- Write in the same language as the existing content.',
  '- Hit each field\'s target length range (characters, counted exactly) without padding with meaningless words. Every value must be complete (never cut off mid-sentence).',
  '- SEO title (title tag): the main keyword first, specific, ends with " | <shop name>" when it fits within the target.',
  '- Meta description: one or two complete sentences: what it is, the key benefit or use, and a natural call to action. Different from the title.',
  '- Title (the product / collection / page name shown on the page): a clear name, not marketing copy; product titles name the product and its key distinguishing attribute present in the content.',
  '- H1: the main heading of the page, close to the title.',
  '- Description (HTML): short paragraphs (<p>) and, where useful, one bulleted list (<ul><li>) of features that are in the content. Optional <h2>/<h3>. No <h1>, no links, no images, no styles, no scripts. It must be unique to this item.',
  '- Image alt text: describe what the image actually shows, concisely (usually 5–15 words), naming the product. Do not start with "image of" or "picture of". Do not stuff keywords. If several images, describe each one\'s view or detail differently.',
  '- Tags: return only NEW tags to add (the existing ones are kept automatically): short, lowercase labels for product type, category, material, use or audience that the content supports. No duplicates of existing tags.',
  '- Values listed under "must differ from" are used on other pages: yours must be clearly different.',
  'Return every requested field through the tool, with a one-sentence reason for each.',
].join('\n');

const FIELD_HELP: Record<SeoFieldType, string> = {
  seoTitle: 'SEO title (title tag)',
  seoDescription: 'Meta description',
  title: 'Title (name shown on the page)',
  description: 'Description (HTML)',
  h1: 'H1 heading',
  imageAlt: 'Image alt text',
  tags: 'Tags (new tags to add, comma-separated)',
};

export const TOOL = {
  name: 'submit_seo_fields',
  description: 'Submit the improved value of every requested SEO field.',
  schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The field key exactly as requested.' },
            value: { type: 'string', description: 'The new value. Description: HTML. Tags: comma-separated new tags.' },
            reason: { type: 'string', description: 'One sentence: what changed and why.' },
          },
          required: ['key', 'value', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    additionalProperties: false,
  },
} as const;

const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
const lenOf = (s: string) => [...s].length;

export function htmlText(html: string): string {
  if (!html) return '';
  const $ = load(`<div id="r">${html}</div>`);
  $('script,style').remove();
  $('p,li,h2,h3,h4,br,div').each((_, el) => { $(el).append(' '); });
  return norm($('#r').text());
}

/** Safe description HTML: only p, ul, ol, li, strong, em, b, i, br, h2, h3 (no attributes); h1 → h2; everything else unwrapped. */
export function sanitizeDescriptionHtml(html: string): string {
  const raw = /<[a-z][^>]*>/i.test(html) ? html : html.split(/\n{2,}/).map((p) => `<p>${p.trim()}</p>`).join('');
  const $ = load(`<div id="r">${raw}</div>`);
  $('#r').find('script,style,iframe,object,embed,form,input,button,img,svg,noscript,template,link,meta').remove();
  $('#r').find('h1').each((_, el) => { el.tagName = 'h2'; });
  const allowed = new Set(['p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'br', 'h2', 'h3']);
  // Deepest first so unwrapping keeps the text.
  const els = $('#r').find('*').toArray().reverse();
  for (const el of els) {
    if (!('tagName' in el)) continue;
    if (!allowed.has(el.tagName)) { $(el).replaceWith($(el).contents()); continue; }
    for (const a of Object.keys(el.attribs ?? {})) $(el).removeAttr(a);
  }
  return ($('#r').html() ?? '').replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

/** Figures (numbers, with units) in `text` that the sources do not contain. */
export function newFigures(text: string, sources: string): string[] {
  const src = sources.toLowerCase().replace(/,/g, '');
  const figs = text.toLowerCase().replace(/,/g, '').match(/\d+(?:\.\d+)?\s?(?:%|ml|l|ltr|kg|g|gm|mm|cm|m|inch|in|w|v|mah|pcs|pieces|years?|months?|days?|hours?)?/g) ?? [];
  return [...new Set(figs.map((f) => f.trim()))].filter((f) => !src.includes(f) && !src.includes(f.replace(/\s/g, '')));
}

function describe(f: WriteField): string {
  const lines = [`- key: ${f.key} — ${FIELD_HELP[f.type]}`];
  lines.push(`  current: ${f.current ? JSON.stringify(f.current.slice(0, 600)) : '(empty)'}`);
  if (f.problems.length) lines.push(`  problems: ${f.problems.join(' ')}`);
  if (f.target) lines.push(`  target length: ${f.target[0]}–${f.target[1]} ${f.type === 'tags' ? 'tags in total (existing + new)' : 'characters'}`);
  else if (f.type === 'imageAlt') lines.push(`  length: concise, at most ${f.max ?? 125} characters`);
  if (f.max && f.type !== 'imageAlt') lines.push(`  never longer than: ${f.max} characters`);
  if (f.imageUrl) lines.push('  the image is attached above, in the order the alt-text fields are listed');
  if (f.note) lines.push(`  note: ${f.note}`);
  if (f.avoid?.length) lines.push(`  must differ from: ${f.avoid.slice(0, 8).map((a) => JSON.stringify(a.slice(0, 160))).join(', ')}`);
  return lines.join('\n');
}

export function buildPrompt(input: WriteInput, fields: WriteField[], feedback?: string[]): string {
  const desc = input.descriptionText.length > MAX_DESC_CONTEXT ? `${input.descriptionText.slice(0, MAX_DESC_CONTEXT)} […]` : input.descriptionText;
  return [
    `Shop: ${input.shopName ?? 'unknown'}`,
    `Resource type: ${input.kind}`,
    input.url ? `URL: ${input.url}` : '',
    `Title: ${input.title}`,
    `Existing tags: ${input.tags.length ? input.tags.join(', ') : '(none)'}`,
    input.keywords.length ? `Store keywords present in the current values (keep them): ${input.keywords.join(', ')}` : '',
    `Description / content (plain text):\n"""\n${desc || '(empty)'}\n"""`,
    '',
    'Fields to write:',
    ...fields.map(describe),
    ...(feedback?.length ? ['', 'Your previous answer had these problems — fix them:', ...feedback.map((x) => `- ${x}`)] : []),
  ].filter((x) => x !== '').join('\n');
}

interface Checked { value: string; issues: string[]; reason: string }

/** Cleans one returned value and lists what is wrong with it (empty = passes). */
export function checkValue(f: WriteField, raw: string, input: WriteInput): Checked {
  let value = f.type === 'description' ? sanitizeDescriptionHtml(raw) : norm(raw).replace(/^["“'‘]+|["”'’]+$/g, '').trim();
  const issues: string[] = [];
  const sources = [input.title, input.descriptionText, input.tags.join(' '), input.shopName ?? '', ...input.fields.map((x) => x.current)].join(' ');
  if (f.type === 'tags') {
    const existing = new Set(input.tags.map((t) => t.toLowerCase().trim()));
    const add: string[] = [];
    for (const t of value.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean)) {
      if (t.length > 40 || existing.has(t.toLowerCase()) || add.some((a) => a.toLowerCase() === t.toLowerCase())) continue;
      add.push(t);
    }
    const kept = input.tags.map((t) => t.trim()).filter((t, i, a) => t && a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i);
    const room = Math.max(0, (f.target?.[1] ?? 15) - kept.length);
    const merged = [...kept, ...add.slice(0, room)];
    if (!add.length) issues.push('No new tags were proposed.');
    else if (f.target && merged.length < f.target[0]) issues.push(`Only ${merged.length} tags in total; aim for ${f.target[0]}–${f.target[1]}.`);
    return { value: merged.join(', '), issues, reason: '' };
  }
  const text = f.type === 'description' ? htmlText(value) : value;
  const n = lenOf(text);
  if (!n) issues.push('Empty value.');
  if (f.max && n > f.max) issues.push(`${n} characters — over the maximum of ${f.max}.`);
  if (f.target) {
    const [lo, hi] = f.target;
    if (n < lo) issues.push(`${n} characters — under the target ${lo}–${hi}${f.type === 'seoDescription' || f.type === 'description' ? ' (add real information from the content, not filler)' : ''}.`);
    if (n > hi && f.type !== 'description') issues.push(`${n} characters — over the target ${lo}–${hi}.`);
    if (f.type === 'description' && n > hi * 1.2) issues.push(`${n} characters — much longer than the target ${lo}–${hi}.`);
  }
  if (/<[a-z/][^>]*>/i.test(value) && f.type !== 'description') { value = norm(value.replace(/<[^>]+>/g, ' ')); issues.push('Contained HTML.'); }
  if (f.type === 'imageAlt' && /^(image|photo|picture|img)\s+(of|showing)\b/i.test(value)) issues.push('Starts with “image of”.');
  if (norm(text).toLowerCase() === norm(f.current).toLowerCase()) issues.push('Same as the current value.');
  const dup = f.avoid?.find((a) => norm(a).toLowerCase() === norm(text).toLowerCase());
  if (dup) issues.push('Same as a value another page already uses.');
  const a = assessSeoField(f.type === 'description' ? 'description' : f.type, text, { pageType: input.kind, title: f.type === 'seoDescription' || f.type === 'description' ? input.title : undefined });
  for (const p of a.problems) if (p.severity !== 'note' && ['keyword_stuffed', 'all_caps', 'same_as_title', 'unclear', 'filename', 'html'].includes(p.code)) issues.push(p.message);
  const figs = newFigures(text, sources);
  if (figs.length) issues.push(`Adds figures not in the content: ${figs.slice(0, 4).join(', ')}.`);
  const kws = input.keywords.filter((k) => norm(f.current).toLowerCase().includes(k.toLowerCase()) && !text.toLowerCase().includes(k.toLowerCase()));
  if (kws.length && f.type !== 'imageAlt') issues.push(`Drops the store keyword “${kws[0]}”.`);
  return { value, issues, reason: '' };
}

/**
 * Writes the fields with the connected Claude model. Images (alt text) are attached by URL so the model sees them.
 * Throws ClaudeError when the provider cannot be used at all (not connected, key rejected, rate limited after retries).
 */
export async function writeSeoFields(claude: ClaudeService, input: WriteInput): Promise<WriteResult> {
  const fields = input.fields;
  const values: Record<string, WrittenValue> = {};
  const failed: Record<string, string> = {};
  if (!fields.length) return { model: (await claude.model()) ?? '', values, failed };
  const images = fields.filter((f) => f.type === 'imageAlt' && f.imageUrl).slice(0, MAX_IMAGES);
  const ask = async (list: WriteField[], feedback?: string[], withImages = true) => {
    const imgs = withImages ? list.filter((f) => images.includes(f)) : [];
    const content = [
      ...imgs.map((f) => ({ type: 'image' as const, source: { type: 'url' as const, url: f.imageUrl! } })),
      { type: 'text' as const, text: buildPrompt(input, list, feedback) },
    ];
    const maxTokens = Math.min(4000, 400 + list.reduce((n, f) => n + (f.type === 'description' ? 1400 : 220), 0));
    try {
      return await claude.call<{ fields?: { key?: unknown; value?: unknown; reason?: unknown }[] }>({ system: SYSTEM_PROMPT, content, tool: TOOL, maxTokens });
    } catch (e) {
      // An image the provider cannot download: once more without images (alt text then comes from the content only).
      if (withImages && imgs.length && e instanceof ClaudeError && e.code === 'bad_request' && /image|url|download|fetch/i.test(e.message)) return ask(list, feedback, false);
      throw e;
    }
  };
  let model = '';
  const take = (list: WriteField[], out: { fields?: { key?: unknown; value?: unknown; reason?: unknown }[] }) => {
    const byKey = new Map<string, { value: string; reason: string }>();
    for (const x of Array.isArray(out.fields) ? out.fields : []) if (typeof x.key === 'string' && typeof x.value === 'string') byKey.set(x.key, { value: x.value, reason: typeof x.reason === 'string' ? norm(x.reason).slice(0, 300) : '' });
    return list.map((f) => ({ f, got: byKey.get(f.key) }));
  };

  const first = await ask(fields);
  model = first.model;
  const retry: WriteField[] = [];
  const feedback: string[] = [];
  const firstChecked = new Map<string, Checked>();
  for (const { f, got } of take(fields, first.input)) {
    if (!got) { retry.push(f); feedback.push(`${f.key}: missing from your answer.`); continue; }
    const c = { ...checkValue(f, got.value, input), reason: got.reason };
    firstChecked.set(f.key, c);
    if (c.issues.length) { retry.push(f); feedback.push(`${f.key}: ${c.issues.join(' ')}`); } else values[f.key] = { value: c.value, reason: c.reason, confidence: 'high' };
  }
  if (retry.length) {
    let second: Awaited<ReturnType<typeof ask>> | undefined;
    try { second = await ask(retry, feedback); } catch (e) { if (!(e instanceof ClaudeError) || !e.transient) throw e; }
    const got2 = second ? new Map(take(retry, second.input).map((x) => [x.f.key, x.got])) : new Map();
    for (const f of retry) {
      const g = got2.get(f.key);
      const c2 = g ? { ...checkValue(f, g.value, input), reason: g.reason } : undefined;
      const best = c2 && (!firstChecked.get(f.key) || c2.issues.length <= firstChecked.get(f.key)!.issues.length) ? c2 : firstChecked.get(f.key);
      if (!best) { failed[f.key] = 'The model did not return this field.'; continue; }
      if (!best.issues.length) { values[f.key] = { value: best.value, reason: best.reason, confidence: 'high' }; continue; }
      const blocking = best.issues.some((i) => /^Empty value|Same as the current value|over the maximum/.test(i));
      if (blocking) { failed[f.key] = best.issues.join(' '); continue; }
      values[f.key] = { value: best.value, reason: `${best.reason} Check: ${best.issues.join(' ')}`.trim(), confidence: 'review' };
    }
  }
  return { model, values, failed };
}
