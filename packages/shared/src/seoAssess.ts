/**
 * SEO field assessment: what is wrong with a title, meta title, meta description, H1, image alt text or tag list —
 * missing, too short / long, duplicated, keyword-stuffed, unclear — judged against configurable guidelines
 * (Settings → Thresholds & scoring) rather than one hard character limit.
 *
 * Lengths are guidelines: a value a little outside the recommended range is only noted (no change proposed); one well
 * outside it is marked for improvement. The page type matters (a "Contact" page may have a short title). A value
 * with no problem is "good" — the editor then recommends keeping it.
 *
 * Pure functions: used by the API (suggestions, bulk fixes, the SEO Optimization lists) and the web app.
 */

export type SeoFieldType = 'title' | 'seoTitle' | 'seoDescription' | 'h1' | 'imageAlt' | 'tags';

export type SeoProblemCode =
  | 'missing' | 'too_short' | 'too_long' | 'slightly_short' | 'slightly_long' | 'duplicate' | 'keyword_stuffed'
  | 'unclear' | 'filename' | 'all_caps' | 'same_as_title' | 'multiple' | 'html' | 'whitespace' | 'duplicate_tags'
  | 'blank_tags' | 'long_tags' | 'too_many_tags';

export interface SeoProblem {
  code: SeoProblemCode;
  /** fix: wrong (missing, broken); improve: worth changing; note: within tolerance, no change needed. */
  severity: 'fix' | 'improve' | 'note';
  message: string;
}

export interface FieldAssessment {
  /** good = recommend keeping the current value. */
  verdict: 'good' | 'improve' | 'fix';
  problems: SeoProblem[];
  length: number;
  /** Recommended length range used for this field and page type. */
  range?: [number, number];
}

export interface SeoGuidelines {
  titleMinChars: number;
  titleMaxChars: number;
  metaMinChars: number;
  metaMaxChars: number;
  h1MinChars: number;
  h1MaxChars: number;
  altMaxChars: number;
  /** Percentage outside a range that is still only a note (no change proposed). */
  lengthTolerancePct: number;
  /** A content word repeated more often than this in a short text counts as keyword stuffing. */
  keywordRepeatMax: number;
  tagsMax: number;
}

export const DEFAULT_SEO_GUIDELINES: SeoGuidelines = {
  titleMinChars: 30, titleMaxChars: 60, metaMinChars: 70, metaMaxChars: 160, h1MinChars: 10, h1MaxChars: 70, altMaxChars: 125,
  lengthTolerancePct: 10, keywordRepeatMax: 2, tagsMax: 50,
};

/** Guidelines from the configured thresholds (unknown keys fall back to the defaults). */
export function seoGuidelinesFrom(thresholds: Record<string, number> | undefined): SeoGuidelines {
  const t = thresholds ?? {};
  const pick = (k: keyof SeoGuidelines) => (typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 0 ? t[k] : DEFAULT_SEO_GUIDELINES[k]);
  return Object.fromEntries((Object.keys(DEFAULT_SEO_GUIDELINES) as (keyof SeoGuidelines)[]).map((k) => [k, pick(k)])) as unknown as SeoGuidelines;
}

export const SEO_FIELD_LABELS: Record<SeoFieldType, string> = {
  title: 'Title', seoTitle: 'SEO title (meta title)', seoDescription: 'Meta description', h1: 'H1 heading', imageAlt: 'Image alt text', tags: 'Tags',
};

export const SEO_PROBLEM_LABELS: Record<SeoProblemCode, string> = {
  missing: 'Missing', too_short: 'Too short', too_long: 'Too long', slightly_short: 'A little short', slightly_long: 'A little long',
  duplicate: 'Duplicated', keyword_stuffed: 'Keyword-stuffed', unclear: 'Unclear', filename: 'File name', all_caps: 'All capitals',
  same_as_title: 'Same as title', multiple: 'Several H1s', html: 'Contains HTML', whitespace: 'Extra spaces', duplicate_tags: 'Duplicate tags',
  blank_tags: 'Blank tags', long_tags: 'Very long tags', too_many_tags: 'Many tags',
};

/** Page kinds the assessment adapts to (Shopify kinds and crawl templates). */
export type SeoPageType = 'product' | 'collection' | 'page' | 'article' | 'blog_article' | 'blog_index' | 'home' | 'search' | 'other';

export interface AssessContext {
  guidelines?: Partial<SeoGuidelines>;
  pageType?: SeoPageType | string;
  /** Same value on other pages of the site (from the crawl). */
  duplicate?: boolean;
  /** The page / resource title (meta description equal to it is flagged). */
  title?: string;
  /** Number of H1s on the page (H1 field). */
  h1Count?: number;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'you', 'our', 'are', 'this', 'that', 'all', 'buy', 'shop', 'online', 'best', 'new', 'set', 'of', 'in', 'on', 'to', 'by', 'at', 'a', 'an', 'or', 'is', 'it', 'its', 'as', 'be', 'can', 'more', 'per']);
const GENERIC = new Set([
  'home', 'homepage', 'home page', 'untitled', 'untitled page', 'products', 'product', 'collection', 'collections', 'page', 'new page', 'default title',
  'test', 'item', 'shop', 'store', 'image', 'photo', 'picture', 'img', 'logo', 'banner', 'placeholder', 'lorem ipsum', 'title', 'description', 'welcome',
]);
const FILENAME = /(^|\s)[\w-]+\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)(\?|$|\s)|^(img|dsc|dscn|image|photo|pic|screenshot|untitled)[-_ ]?\d+$|^[a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}|^[a-z0-9]+[-_][a-z0-9_-]{12,}$/i;

const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Content words repeated more than `max` times (case-insensitive), e.g. ["kitchen"]. */
export function repeatedWords(text: string, max: number): string[] {
  const counts = new Map<string, number>();
  for (const w of norm(text).toLowerCase().match(WORD) ?? []) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > max).map(([w]) => w);
}

/** Segments split by | – — - , that occur more than once ("Kitchen Tools | Kitchen Tools"). */
export function repeatedSegments(text: string): string[] {
  const segs = norm(text).split(/\s[|–—-]\s|\s*[|,]\s*/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 2);
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const s of segs) { if (seen.has(s)) out.add(s); seen.add(s); }
  return [...out];
}

export function isAllCaps(text: string): boolean {
  const letters = norm(text).replace(/[^\p{L}]/gu, '');
  if (letters.length < 8) return false;
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return upper / letters.length > 0.8;
}

function rangeFor(type: SeoFieldType, g: SeoGuidelines, pageType?: string): [number, number] | undefined {
  if (type === 'seoTitle') return [g.titleMinChars, g.titleMaxChars];
  if (type === 'seoDescription') return [g.metaMinChars, g.metaMaxChars];
  if (type === 'h1' || type === 'title') return [pageType === 'page' || pageType === 'home' ? Math.min(3, g.h1MinChars) : g.h1MinChars, g.h1MaxChars];
  if (type === 'imageAlt') return [5, g.altMaxChars];
  return undefined;
}

/** Assesses one field value. `value` for tags is the comma-separated list. */
export function assessSeoField(type: SeoFieldType, value: string | undefined, c: AssessContext = {}): FieldAssessment {
  const g = { ...DEFAULT_SEO_GUIDELINES, ...(c.guidelines ?? {}) };
  const raw = value ?? '';
  const v = norm(raw);
  const problems: SeoProblem[] = [];
  const add = (code: SeoProblemCode, severity: SeoProblem['severity'], message: string) => problems.push({ code, severity, message });
  const range = rangeFor(type, g, c.pageType);
  const len = [...v].length;

  if (type === 'tags') {
    const tags = raw.split(',');
    const trimmed = tags.map((t) => t.trim());
    if (!v) return { verdict: 'good', problems: [], length: 0 };
    if (trimmed.some((t) => !t)) add('blank_tags', 'fix', 'Blank tags in the list.');
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const t of trimmed.filter(Boolean)) { const k = t.toLowerCase(); if (seen.has(k)) dups.push(t); else seen.set(k, t); }
    if (dups.length) add('duplicate_tags', 'fix', `Duplicate tags (ignoring case): ${[...new Set(dups)].slice(0, 5).join(', ')}.`);
    if (tags.some((t) => t !== t.trim() && t.trim())) add('whitespace', 'improve', 'Tags with leading or trailing spaces.');
    const long = trimmed.filter((t) => t.length > 40);
    if (long.length) add('long_tags', 'note', `${long.length} tag(s) longer than 40 characters read like sentences — tags work best as short labels.`);
    if (seen.size > g.tagsMax) add('too_many_tags', 'note', `${seen.size} tags — more than ${g.tagsMax}; consider removing ones not used for filtering or collections.`);
    return finish(problems, seen.size);
  }

  if (!v) {
    if (type === 'imageAlt') add('missing', 'fix', 'No alt text: screen readers and image search get nothing.');
    else if (type === 'seoTitle') add('missing', 'improve', 'No SEO title: the storefront falls back to the title.');
    else if (type === 'seoDescription') add('missing', 'fix', 'No meta description: search engines pick text from the page.');
    else if (type === 'h1') add('missing', 'fix', 'The page has no H1.');
    else add('missing', 'fix', 'Empty.');
    return finish(problems, 0, range);
  }

  if (raw !== v && /\s{2,}|^\s|\s$/.test(raw)) add('whitespace', 'improve', 'Extra spaces.');
  if (/<[a-z/][^>]*>/i.test(v)) add('html', 'fix', 'Contains HTML tags.');
  if (type === 'h1' && (c.h1Count ?? 1) > 1) add('multiple', 'fix', `${c.h1Count} H1s on the page — keep one.`);

  if (range) {
    const [min, max] = range;
    const tol = g.lengthTolerancePct / 100;
    if (len > max) {
      if (len <= Math.ceil(max * (1 + tol))) add('slightly_long', 'note', `${len} characters, a little over the recommended ${max} — fine unless the end is important.`);
      else add('too_long', 'improve', type === 'seoTitle' || type === 'seoDescription' ? `${len} characters; search results cut it near ${max}.` : `${len} characters — longer than the recommended ${max}.`);
    } else if (len < min) {
      const shortPage = (type === 'title' || type === 'h1' || type === 'seoTitle') && (c.pageType === 'page' || c.pageType === 'home');
      if (len >= Math.floor(min * (1 - tol)) || shortPage) add('slightly_short', 'note', `${len} characters, under the recommended ${min}${shortPage ? ' (normal for a simple page)' : ''}.`);
      else add('too_short', 'improve', `${len} characters — shorter than the recommended ${min}; there is room to describe the page.`);
    }
  }

  const lower = v.toLowerCase().replace(/[.!]+$/, '');
  if (GENERIC.has(lower)) add('unclear', type === 'imageAlt' ? 'fix' : 'improve', `“${v}” says nothing specific about this page.`);
  if (type === 'imageAlt' && FILENAME.test(v)) add('filename', 'fix', 'Looks like a file name, not a description of the image.');
  if (type === 'imageAlt' && /^(image|photo|picture|graphic)\s+of\b/i.test(v)) add('unclear', 'improve', 'Starts with “image of” — describe the image directly.');
  if (isAllCaps(v)) add('all_caps', 'improve', 'All capitals are harder to read.');

  const segs = repeatedSegments(v);
  const reps = repeatedWords(v, type === 'seoDescription' ? g.keywordRepeatMax + 1 : g.keywordRepeatMax);
  if (segs.length || reps.length) add('keyword_stuffed', 'improve', segs.length ? `Repeats “${segs[0]}”.` : `Repeats “${reps.slice(0, 3).join('”, “')}” too often.`);

  if (c.duplicate) add('duplicate', type === 'imageAlt' ? 'note' : 'improve', 'The same text is used on other pages — each page needs its own.');
  if (type === 'seoDescription' && c.title && norm(c.title).toLowerCase() === lower) add('same_as_title', 'improve', 'Only repeats the title — describe what the page offers.');
  if (type === 'seoDescription' && v.split(' ').length < 4 && len >= 1) add('unclear', 'improve', 'Too few words to describe the page.');
  return finish(problems, len, range);
}

function finish(problems: SeoProblem[], length: number, range?: [number, number]): FieldAssessment {
  const verdict = problems.some((p) => p.severity === 'fix') ? 'fix' : problems.some((p) => p.severity === 'improve') ? 'improve' : 'good';
  return { verdict, problems, length, ...(range ? { range } : {}) };
}

/** Problems that make a field worth changing (fix / improve). */
export const needsWork = (a: FieldAssessment) => a.verdict !== 'good';
