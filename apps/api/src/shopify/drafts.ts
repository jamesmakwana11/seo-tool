/**
 * SEO editor drafts: every field is assessed (missing, too short / long, duplicated, keyword-stuffed, unclear — against
 * the configurable guidelines) and gets a suggestion built only from text that already exists on the resource (its
 * title, description, the shop name) — never invented facts. A good value is recommended to be kept. Plus validation
 * of every value, suggested or typed by hand, and where the page's H1 comes from.
 *
 * Nothing here talks to Shopify; the service reads the resource, calls these, and writes only after confirmation.
 */
import { load } from 'cheerio';
import { assessSeoField, DEFAULT_SEO_GUIDELINES, isAllCaps, type CrawledUrl, type FieldAssessment, type H1SourceReport, type SeoFieldType, type SeoGuidelines, type ShopifyFieldDraft, type ShopifyFieldSuggestion, type ShopifyFieldValidation, type ShopifyResourceKind } from '@sentinel/shared';
import { mutationFor, type ShopifyResource } from './resources';

/** Length and wording guidelines (Settings → Thresholds & scoring). */
export type Limits = SeoGuidelines;
export const DEFAULT_LIMITS: Limits = DEFAULT_SEO_GUIDELINES;
export const ALT_MAX = 125;

export interface DraftContext {
  res: ShopifyResource;
  shopName?: string;
  siteHost: string;
  /** The page's row in the newest crawl (issues, flags, H1s), when one exists. */
  row?: CrawledUrl & { flags?: string[] };
  pageH1s: string[];
  h1Basis: H1SourceReport['basis'];
  observedAt?: string;
  limits?: Limits;
  /** Important keywords of the store (Settings): a suggestion never drops one that is in the current value. */
  keywords?: string[];
}

// ---------------------------------------------------------------------------------------------- text helpers

export function htmlToText(html: string, o: { skipHeadings?: boolean } = {}): string {
  if (!html) return '';
  const $ = load(`<div id="r">${html}</div>`);
  $('script,style,noscript,template,svg').remove();
  if (o.skipHeadings) $('h1,h2,h3,h4,h5,h6').remove();
  $('br').replaceWith(' ');
  $('p,div,li,h1,h2,h3,h4,h5,h6,tr').each((_, el) => { $(el).append(' '); });
  return $('#r').text().replace(/\s+/g, ' ').trim();
}

const norm = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Readable description text for a meta description: paragraphs and list items, without forms, buttons, labels and
 * headings (a tracking form's "Select option: Tracking id" is not a description).
 */
export function descriptionText(html: string): string {
  if (!html) return '';
  const $ = load(`<div id="r">${html}</div>`);
  $('script,style,noscript,template,svg,form,label,input,select,option,button,textarea,iframe,h1,h2,h3,h4,h5,h6,nav,table').remove();
  const blocks = $('#r').find('p,li,blockquote').toArray().map((el) => norm($(el).text())).filter((t) => t.split(' ').length >= 5);
  const text = blocks.length ? blocks.join(' ') : htmlToText($('#r').html() ?? '');
  return norm(text.replace(/\s+([.,;:!?])/g, '$1'));
}
const lc = (s: string) => norm(s).toLowerCase();

/** Shortens at a word boundary to at most `max` characters (never cuts a word; drops a dangling separator). */
export function shorten(s: string, max: number): string {
  const t = norm(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const i = cut.lastIndexOf(' ');
  let out = (i > max * 0.5 ? cut.slice(0, i) : t.slice(0, max)).replace(/[\s,;:–—|-]+$/, '').trim();
  // Never end on a dangling joining word (“… Chopper and Slicer with”).
  for (let k = 0; k < 3; k++) {
    const next = out.replace(/\s+(?:and|or|with|for|of|the|a|an|in|on|to|by|from|at|&|\+)$/i, '').replace(/[\s,;:–—|-]+$/, '');
    if (next === out || next.length < max * 0.4) break;
    out = next;
  }
  return out;
}

/** The first sentences of a text up to `max` characters, ending at a sentence end when one fits. */
export function leadSentences(text: string, max: number): string {
  const t = norm(text);
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const s of sentences) {
    if ((out + s).trim().length > max) break;
    out += s;
  }
  return out.trim().length >= Math.min(70, max * 0.5) ? out.trim() : shorten(t, max);
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const words = (s: string) => (s.toLowerCase().match(WORD) ?? []);

/** Figures (numbers with units) in `text` that appear in none of the sources — flagged so nothing is invented. */
export function unsupportedFigures(text: string, sources: string[]): string[] {
  const src = sources.join(' ').toLowerCase().replace(/,/g, '');
  const figs = text.toLowerCase().replace(/,/g, '').match(/\d+(?:\.\d+)?\s?(?:%|ml|l|kg|g|mm|cm|m|inch|in|w|v|mah|pcs|pieces|years?|months?|days?|hours?)?/g) ?? [];
  return [...new Set(figs.map((f) => f.trim()))].filter((f) => !src.includes(f) && !src.includes(f.replace(/\s/g, '')));
}

/** Words in a suggestion that come from none of the sources (used to prove suggestions only reuse existing text). */
export function newWords(text: string, sources: string[]): string[] {
  const known = new Set(sources.flatMap(words));
  return [...new Set(words(text))].filter((w) => !known.has(w));
}

// ---------------------------------------------------------------------------------------------- H1 source

/**
 * Where each H1 on the page comes from:
 *  - equal to the resource title → the theme prints the title as H1; changing the *title* (API) changes it;
 *  - an <h1> inside the description / body → editable through the API (body field);
 *  - anything else → hard-coded or generated by the theme (section settings, logo, app block) → theme edit.
 */
export function detectH1Sources(res: ShopifyResource, pageH1s: string[], basis: H1SourceReport['basis'], observedAt?: string): H1SourceReport {
  const bodyH1s = bodyHeadings(res.bodyHtml).filter((h) => h.level === 1).map((h) => lc(h.text));
  const title = lc(res.title);
  const sources = pageH1s.map((h): H1SourceReport['sources'][number] => {
    const t = lc(h);
    // Same text in the title and in a body <h1> (ignoring case): the exact spelling on the page decides.
    const exactBody = bodyHeadings(res.bodyHtml).some((b) => b.level === 1 && b.text === norm(h)) && norm(res.title) !== norm(h);
    if (t && t === title && !exactBody) return { text: h, source: 'title', applyVia: 'admin_api', explanation: `The theme prints the ${res.kind} title as the H1. Change the title field (Admin API) to change it.` };
    if (t && bodyH1s.includes(t)) return { text: h, source: 'body', applyVia: 'admin_api', explanation: `This H1 is inside the ${res.kind === 'product' || res.kind === 'collection' ? 'description' : 'content'} HTML. Edit or demote it there (Admin API).` };
    if (!t) return { text: h, source: 'theme', applyVia: 'theme', explanation: 'An empty H1 (often a logo or icon heading) comes from the theme. Fix it in the theme code.' };
    return { text: h, source: 'theme', applyVia: 'theme', explanation: 'This text is not the title and not in the description, so the theme (a section, snippet or app block) outputs it. Fix it with a theme edit.' };
  });
  let summary: string;
  if (basis === 'none') summary = 'No crawl data for this page yet, so the H1s on the storefront are unknown. Crawl the site or run the re-audit.';
  else if (!pageH1s.length) summary = 'The page has no H1. Most themes print the title as H1 on this template — if not, the theme template needs one.';
  else if (pageH1s.length === 1) summary = sources[0].source === 'theme' ? 'One H1, written by the theme (theme edit needed to change it).' : `One H1, from the ${sources[0].source === 'title' ? 'title' : 'description/content'} (editable here).`;
  else summary = `${pageH1s.length} H1s: ${sources.map((s) => s.source).join(', ')}. Keep one H1; demote the others to H2.`;
  return { pageH1s, basis, observedAt, sources, summary };
}

export function bodyHeadings(html: string): { level: number; text: string }[] {
  if (!html) return [];
  const $ = load(`<div id="r">${html}</div>`);
  return $('#r').find('h1,h2,h3,h4,h5,h6').toArray().map((el) => ({ level: Number(el.tagName.slice(1)), text: norm($(el).text()) }));
}

/** Demotes every <h1> in the body to <h2>, keeping attributes and content. */
export function demoteBodyH1(html: string): string {
  return html.replace(/<h1(\s[^>]*)?>/gi, (_m, a) => `<h2${a ?? ''}>`).replace(/<\/h1\s*>/gi, '</h2>');
}

// ---------------------------------------------------------------------------------------------- validation

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function validateField(key: string, value: string, ctx: { res: ShopifyResource; siteHost: string; limits?: Limits; current: string; sources: string[]; source: ShopifyFieldDraft['source']; keywords?: string[] }): ShopifyFieldValidation {
  const L = ctx.limits ?? DEFAULT_LIMITS;
  const errors: string[] = [];
  const warnings: string[] = [];
  const v = value ?? '';
  if (CTRL.test(v)) errors.push('Contains control characters.');
  if (key === 'seoTitle' || key === 'seoDescription') {
    const isTitle = key === 'seoTitle';
    const [min, max] = isTitle ? [L.titleMinChars, L.titleMaxChars] : [L.metaMinChars, L.metaMaxChars];
    const t = norm(v);
    if (!t) {
      if (ctx.current) errors.push(`An existing ${isTitle ? 'SEO title' : 'meta description'} cannot be cleared from here (Shopify would fall back to ${isTitle ? 'the title' : 'the description text'}). Clear it in the Shopify admin if that is intended.`);
      else warnings.push(isTitle ? 'Empty: the storefront uses the title instead.' : 'Empty: search engines will pick text from the page.');
    } else {
      if (t.length > max) warnings.push(`${t.length} characters — longer than ${max}, search results will cut it.`);
      if (t.length < min) warnings.push(`${t.length} characters — shorter than ${min}.`);
      if (/<[a-z/][^>]*>/i.test(t)) errors.push('HTML tags are not allowed here.');
      if (t.length > (isTitle ? 255 : 320)) errors.push(`Too long for Shopify (${t.length} characters).`);
    }
  } else if (key === 'title' || key === 'h1') {
    const t = norm(v);
    const what = key === 'h1' ? 'H1' : 'title';
    if (!t) errors.push(`The ${what} cannot be empty.`);
    if (t.length > 255) errors.push(`The ${what} is at most 255 characters.`);
    if (/<[a-z/][^>]*>/i.test(t)) errors.push(`HTML tags are not allowed in the ${what}.`);
  } else if (key === 'tags') {
    const tags = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (tags.some((x) => x.length > 255)) errors.push('A tag is longer than 255 characters.');
    if (tags.length > 250) errors.push('Shopify allows at most 250 tags.');
    const seen = new Set<string>();
    for (const t of tags) { if (seen.has(t.toLowerCase())) { warnings.push(`Duplicate tag “${t}”.`); break; } seen.add(t.toLowerCase()); }
  } else if (key === 'bodyHtml' || key === 'summaryHtml') {
    validateHtml(v, ctx.siteHost, errors, warnings, key === 'bodyHtml' ? ctx.res.kind : undefined);
  } else if (key.startsWith('imageAlt:')) {
    const t = norm(v);
    if (!t) warnings.push('Empty alt text: screen readers and image search get nothing.');
    if (t.length > 512) errors.push('Shopify alt text is at most 512 characters.');
    else if (t.length > ALT_MAX) warnings.push(`${t.length} characters — keep alt text under ${ALT_MAX}.`);
    if (/^(image|photo|picture|img)\b/i.test(t)) warnings.push('Do not start alt text with “image of” — describe the image.');
  }
  // Facts: figures that appear nowhere in the current content are flagged on every changed field.
  if (norm(v) !== norm(ctx.current)) {
    const figs = unsupportedFigures(key === 'bodyHtml' || key === 'summaryHtml' ? htmlToText(v) : v, ctx.sources);
    if (figs.length) warnings.push(`New figures not found in the current content: ${figs.slice(0, 5).join(', ')}. Check they are accurate before applying.`);
    const dropped = droppedKeywords(ctx.current, v, ctx.keywords);
    if (dropped.length && key !== 'bodyHtml' && key !== 'summaryHtml' && key !== 'tags') warnings.push(`Drops the keyword “${dropped[0]}” that the current value has.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function validateHtml(html: string, siteHost: string, errors: string[], warnings: string[], kind?: ShopifyResourceKind) {
  if (/<script[\s>]/i.test(html)) errors.push('<script> tags are not allowed in content.');
  if (/\son[a-z]+\s*=/i.test(html)) errors.push('Inline event handlers (onclick=…) are not allowed.');
  if (/(?:href|src)\s*=\s*["']?\s*javascript:/i.test(html)) errors.push('javascript: links are not allowed.');
  if (/<iframe[\s>]/i.test(html)) warnings.push('Contains an <iframe>.');
  const opens = (html.match(/<(p|div|ul|ol|li|h[1-6]|table|span|strong|em|a)(\s[^>]*)?>/gi) ?? []).length;
  const closes = (html.match(/<\/(p|div|ul|ol|li|h[1-6]|table|span|strong|em|a)\s*>/gi) ?? []).length;
  if (opens !== closes) warnings.push(`Unbalanced HTML: ${opens} opening and ${closes} closing tags (Shopify may re-format it).`);
  const heads = bodyHeadings(html);
  const h1 = heads.filter((h) => h.level === 1).length;
  if (h1 && kind) warnings.push(`${h1} H1 in the ${kind === 'product' || kind === 'collection' ? 'description' : 'content'} — the theme usually prints the title as H1, so the page would have ${h1 + 1}. Use H2.`);
  let prev = 1;
  for (const h of heads) {
    if (h.level > prev + 1) { warnings.push(`Heading level skipped: H${prev} → H${h.level} (“${h.text.slice(0, 40)}”).`); break; }
    prev = h.level;
  }
  if (heads.some((h) => !h.text)) warnings.push('An empty heading.');
  const $ = load(`<div id="r">${html}</div>`);
  const host = siteHost.replace(/^www\./, '');
  for (const a of $('#r a[href]').toArray()) {
    const href = ($(a).attr('href') ?? '').trim();
    const text = norm($(a).text());
    if (!href || href === '#') { warnings.push('A link without a target.'); continue; }
    if (!text && !$(a).find('img[alt]').length) warnings.push(`Link to ${href.slice(0, 60)} has no anchor text.`);
    if (/^https?:\/\//i.test(href)) {
      let h = '';
      try { h = new URL(href).host.replace(/^www\./, ''); } catch { errors.push(`Invalid link URL: ${href.slice(0, 80)}`); continue; }
      if (h === host && href.startsWith('http:')) warnings.push(`Internal link uses http:// — use https:// or a relative path (${href.slice(0, 60)}).`);
    } else if (!href.startsWith('/') && !/^(mailto|tel):/i.test(href)) warnings.push(`Relative link “${href.slice(0, 40)}” — start internal links with “/”.`);
    if (/\/collections\/[^/]+\/products\//.test(href)) warnings.push(`Link to a collection-scoped product URL (${href.slice(0, 60)}); link to /products/… instead.`);
  }
}

// ---------------------------------------------------------------------------------------------- suggestions

const LABEL: Record<string, string> = { seoTitle: 'SEO title (meta title)', seoDescription: 'Meta description', title: 'Title', h1: 'H1 heading', tags: 'Tags', bodyHtml: 'Description / content (H2–H3 headings, internal links)', summaryHtml: 'Excerpt' };

/** Every source of existing text a suggestion may reuse. */
export function sourceTexts(res: ShopifyResource, shopName?: string): string[] {
  return [res.title, res.seoTitle, res.seoDescription, htmlToText(res.bodyHtml), htmlToText(res.summaryHtml ?? ''), (res.tags ?? []).join(' '), shopName ?? ''].filter(Boolean);
}

/** Store keywords present in `before` but missing from `after`. */
export function droppedKeywords(before: string, after: string, keywords?: string[]): string[] {
  const b = norm(before).toLowerCase();
  const a = norm(after).toLowerCase();
  return (keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k && b.includes(k) && !a.includes(k));
}

const UNITS = new Set(['ML', 'L', 'KG', 'G', 'GM', 'MM', 'CM', 'M', 'LTR', 'PCS', 'INCH', 'FT']);
/** ALL CAPS → Title Case, keeping short acronyms (USB, LED), figures as written (5W) and units in lower case (750 ml). */
export function readableCase(s: string): string {
  return norm(s).split(' ').map((w) => {
    const letters = w.replace(/[^\p{L}]/gu, '');
    if (UNITS.has(letters.toUpperCase()) && !/\d/.test(w)) return w.toLowerCase();
    if (/\d/.test(w)) return w;
    if (letters.length <= 3 && /^[\p{Lu}]+$/u.test(letters)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

/** Removes repeated segments (“Kitchen Tools | Kitchen Tools | Shop”) and doubled words (“Steel Steel”). */
export function dedupeText(s: string): string {
  const t = norm(s);
  const sep = / \| /.test(t) || /\|/.test(t) ? ' | ' : / – /.test(t) ? ' – ' : / - /.test(t) ? ' - ' : ', ';
  const parts = t.split(/\s[|–—-]\s|\s*\|\s*|,\s+/);
  const seen = new Set<string>();
  const kept = parts.filter((p) => { const k = p.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  return kept.join(sep).replace(/\b(\p{L}+)(\s+\1\b)+/giu, '$1');
}

/** Shortens to `max`, keeping a trailing “| Brand” / “– Brand” when there is one. */
export function shortenKeepingBrand(s: string, max: number, brand?: string): string {
  const t = norm(s);
  if (t.length <= max) return t;
  const m = brand ? new RegExp(`\\s*[|–—-]\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').exec(t) : null;
  if (m && m.index > 0) {
    const suffix = t.slice(m.index);
    const head = shorten(t.slice(0, m.index), max - suffix.length);
    if (head.length >= 10) return `${head}${suffix}`;
  }
  return shorten(t, max);
}

const withBrand = (base: string, max: number, brand?: string) => (brand && !norm(base).toLowerCase().includes(brand.toLowerCase()) && `${norm(base)} – ${brand}`.length <= max ? `${norm(base)} – ${brand}` : norm(base));
const KEEP = (cur: string, why: string): ShopifyFieldSuggestion => ({ value: cur, reason: why, keep: true, confidence: 'high' });
const NEEDS_PERSON = (cur: string, why: string): ShopifyFieldSuggestion => ({ value: cur, reason: why, keep: false, confidence: 'review' });
const has = (a: FieldAssessment, ...codes: string[]) => a.problems.some((p) => codes.includes(p.code) && p.severity !== 'note');

/** Suggestion for a short text field from its assessment. Never invents facts: reuses the resource's own text. */
export function suggestText(type: SeoFieldType, cur: string, a: FieldAssessment, c: { res: ShopifyResource; shopName?: string; limits: Limits; descText: string; keywords?: string[]; index?: number }): ShopifyFieldSuggestion {
  const L = c.limits;
  const title = norm(c.res.title);
  const kindWord = c.res.kind === 'article' ? 'article' : c.res.kind;
  if (a.verdict === 'good') return KEEP(cur, a.problems.length ? `Fine as it is (${a.problems.map((p) => p.message).join(' ')}) — keep it.` : 'Already good — keep it.');
  let v = norm(cur);
  const why: string[] = [];
  let confidence: ShopifyFieldSuggestion['confidence'] = 'high';
  if (type === 'seoTitle') {
    if (!v || has(a, 'unclear')) { v = withBrand(title, L.titleMaxChars, c.shopName); why.push(!norm(cur) ? `No SEO title; built from the ${kindWord} title${v !== title ? ' and the shop name' : ''}.` : `“${norm(cur)}” is not specific; built from the ${kindWord} title.`); }
    if (has(a, 'duplicate') && norm(cur) && norm(cur).toLowerCase() !== title.toLowerCase()) { v = withBrand(title, L.titleMaxChars, c.shopName); why.push(`Other pages use the same title tag; built from this ${kindWord}’s own title.`); }
    if (has(a, 'keyword_stuffed')) { v = dedupeText(v); why.push('Removed repeated words.'); }
    if (has(a, 'all_caps') || isAllCaps(v)) { v = readableCase(v); why.push('Changed from all capitals.'); confidence = 'review'; }
    if (v.length > L.titleMaxChars) {
      v = shortenKeepingBrand(v, L.titleMaxChars, c.shopName);
      why.push(`Shortened to ${v.length} characters at a word boundary${c.shopName && v.endsWith(c.shopName) ? ', keeping the shop name' : ''}.`);
      if (v.length < L.titleMaxChars * 0.6) confidence = 'review';
    }
    // The shop name: themes usually append it to the title tag anyway; set here it is counted in the length.
    if (why.length || v.length < L.titleMinChars) { const b = withBrand(v, L.titleMaxChars, c.shopName); if (b !== v) { v = b; why.push('Added the shop name.'); } }
  } else if (type === 'seoDescription') {
    const text = c.descText;
    const fromText = (max: number) => leadSentences(text, max);
    if (!v || has(a, 'too_short', 'unclear', 'same_as_title', 'duplicate', 'keyword_stuffed', 'missing')) {
      if (text.length >= 50) {
        let d = fromText(L.metaMaxChars - 5);
        if (d.length < L.metaMinChars && `${title} – ${d}`.length <= L.metaMaxChars) d = `${title} – ${d}`;
        v = d;
        why.push(!norm(cur) ? 'No meta description. Taken from the first sentences of the existing description (nothing added).' : `${a.problems.filter((p) => p.severity !== 'note').map((p) => p.message).join(' ')} Replaced by the first sentences of the existing description.`);
      } else {
        const brand = c.shopName ? ` at ${c.shopName}` : '';
        const lead = c.res.kind === 'product' ? `Buy ${title} online${brand}.` : c.res.kind === 'collection' ? `Shop ${title} online${brand}.` : `${title}${c.shopName ? ` – ${c.shopName}` : ''}.`;
        v = norm(`${lead} ${text}`);
        if (v.length > L.metaMaxChars) v = leadSentences(v, L.metaMaxChars - 5);
        why.push(`The ${kindWord} has almost no description text, so this is built from the title${c.shopName ? ' and shop name' : ''}${text ? ' plus the little text there is' : ''}. Better: write a sentence about what the page offers.`);
        confidence = 'review';
      }
    }
    if (v.length > L.metaMaxChars) { v = leadSentences(v, L.metaMaxChars - 5); why.push(`Shortened to ${v.length} characters at a sentence or word boundary.`); }
    if (isAllCaps(v)) { v = readableCase(v); why.push('Changed from all capitals.'); confidence = 'review'; }
  } else if (type === 'title' || type === 'h1') {
    if (has(a, 'missing', 'unclear')) return NEEDS_PERSON(cur, `${a.problems.filter((p) => p.severity !== 'note').map((p) => p.message).join(' ')} Write a heading that names what the page is about.`);
    if (has(a, 'whitespace') || has(a, 'html')) { v = norm(v.replace(/<[^>]+>/g, ' ')); why.push('Cleaned up spaces / tags.'); }
    if (has(a, 'keyword_stuffed')) { v = dedupeText(v); why.push('Removed repeated words.'); confidence = 'review'; }
    if (has(a, 'all_caps')) { v = readableCase(v); why.push('Changed from all capitals.'); confidence = 'review'; }
    if (has(a, 'too_long')) { v = shorten(v, L.h1MaxChars); why.push(`Shortened to ${v.length} characters — check the product name still reads well.`); confidence = 'review'; }
    if (has(a, 'multiple') && why.length === 0) return KEEP(cur, 'The text is fine; the extra H1s are removed in the description field (demoted to H2).');
  } else if (type === 'imageAlt') {
    const alt = (c.index ?? 0) > 0 ? `${title} – view ${(c.index ?? 0) + 1}` : title;
    if (has(a, 'missing', 'filename', 'unclear')) { v = shorten(alt, L.altMaxChars); why.push(!norm(cur) ? `No alt text. Uses the ${kindWord} title (describe what the image shows if it differs).` : `“${norm(cur)}” does not describe the image. Uses the ${kindWord} title.`); }
    if (has(a, 'keyword_stuffed')) { v = dedupeText(v); why.push('Removed repeated words.'); confidence = 'review'; }
    if (has(a, 'all_caps')) { v = readableCase(v); why.push('Changed from all capitals.'); confidence = 'review'; }
    if (v.length > L.altMaxChars) { v = shorten(v, L.altMaxChars); why.push(`Shortened to ${v.length} characters.`); }
  }
  if (!why.length || norm(v) === norm(cur)) return NEEDS_PERSON(cur, `${a.problems.filter((p) => p.severity !== 'note').map((p) => p.message).join(' ')} No safe automatic rewrite — needs a person.`);
  const dropped = droppedKeywords(cur, v, c.keywords);
  if (dropped.length) { confidence = 'review'; why.push(`Check: the keyword “${dropped[0]}” is no longer in it.`); }
  return { value: v, reason: why.join(' '), keep: false, confidence };
}

export function suggestTags(cur: string[], a: FieldAssessment): ShopifyFieldSuggestion {
  const joined = cur.join(', ');
  if (a.verdict === 'good') return KEEP(joined, a.problems.length ? `Fine as it is (${a.problems.map((p) => p.message).join(' ')}) — keep it.` : 'Already good — keep it.');
  const seen = new Set<string>();
  const dedup = cur.map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  const v = dedup.join(', ');
  if (v === joined) return NEEDS_PERSON(joined, 'Nothing to clean up automatically.');
  return { value: v, reason: `${cur.length - dedup.length} duplicate or blank tag(s) removed; no tag added.`, keep: false, confidence: 'high' };
}

export function buildFields(c: DraftContext): ShopifyFieldDraft[] {
  const { res } = c;
  const L = { ...DEFAULT_LIMITS, ...(c.limits ?? {}) };
  const sources = sourceTexts(res, c.shopName);
  const flags = new Set(c.row?.flags ?? []);
  const descText = descriptionText(res.bodyHtml) || descriptionText(res.summaryHtml ?? '');
  const fields: ShopifyFieldDraft[] = [];
  /** A field with its assessment and suggestion; high-confidence suggestions are pre-selected, others shown for review. */
  const push = (key: string, current: string, sug: ShopifyFieldSuggestion | undefined, assessment: FieldAssessment | undefined, hint?: string) => {
    const changed = !!sug && !sug.keep && norm(sug.value) !== norm(current);
    const value = changed ? sug!.value : current;
    fields.push({
      key, label: key === 'imageAlt:featured' ? `Image alt text (${res.kind} image)` : key.startsWith('imageAlt:') ? `Image alt text #${fields.filter((f) => f.key.startsWith('imageAlt:')).length + 1}` : LABEL[key],
      current, proposed: value, reason: changed ? sug!.reason : '', source: changed ? 'suggested' : 'unchanged', applyVia: 'admin_api', mutation: mutationFor(res.kind, key),
      validation: validateField(key, value, { res, siteHost: c.siteHost, limits: L, current, sources, source: changed ? 'suggested' : 'unchanged', keywords: c.keywords }),
      include: changed && sug!.confidence === 'high', hint,
      ...(assessment ? { assessment } : {}), ...(sug ? { suggestion: sug } : {}),
    });
  };
  const sctx = { res, shopName: c.shopName, limits: L, descText, keywords: c.keywords };

  // ---- SEO title (title tag). Empty → the storefront shows the title, so that is what is judged. Many themes append
  // “ – Shop name” to the title tag: when the crawl shows such a suffix, it counts in the length and is not added again.
  {
    const cur = res.seoTitle;
    const effective = norm(cur) || norm(res.title);
    const tag = norm(c.row?.title ?? '');
    const suffix = tag && tag !== effective && tag.toLowerCase().startsWith(effective.toLowerCase()) && tag.length - effective.length <= 40 ? tag.slice(effective.length) : '';
    const a = assessSeoField('seoTitle', effective + suffix, { guidelines: L, pageType: res.kind, duplicate: flags.has('dup-title') });
    const tctx = suffix ? { ...sctx, shopName: undefined, limits: { ...L, titleMaxChars: L.titleMaxChars - suffix.length, titleMinChars: Math.max(0, L.titleMinChars - suffix.length) } } : sctx;
    let sug = suggestText('seoTitle', cur, norm(cur) ? a : { ...a, problems: [...a.problems, { code: 'missing', severity: 'note', message: 'No SEO title.' }] }, tctx);
    if (suffix && !sug.keep && sug.value !== cur) sug = { ...sug, reason: `${sug.reason} The theme adds “${suffix.trim()}”, so the title tag will read “${sug.value}${suffix}” (${sug.value.length + suffix.length} characters).` };
    if (!norm(cur) && sug.keep) sug = KEEP('', `No SEO title, so the title “${shorten(res.title, 70)}” is used — it is fine. Keep it empty or set one to control the search result.`);
    push('seoTitle', cur, sug, a, !norm(cur) ? `Empty — the storefront uses the title “${shorten(res.title, 70)}”.` : undefined);
  }
  // ---- meta description
  {
    const cur = res.seoDescription;
    const a = assessSeoField('seoDescription', cur, { guidelines: L, pageType: res.kind, duplicate: flags.has('dup-meta'), title: res.title });
    push('seoDescription', cur, suggestText('seoDescription', cur, a, sctx), a);
  }
  // ---- title (H1 on most templates): only clear-cut clean-ups are pre-selected; wording changes are for review
  {
    const cur = res.title;
    const a = assessSeoField('title', cur, { guidelines: L, pageType: res.kind });
    if (cur !== norm(cur) && !a.problems.some((p) => p.code === 'whitespace')) a.problems.push({ code: 'whitespace', severity: 'improve', message: 'Extra spaces.' });
    if (a.problems.some((p) => p.code === 'whitespace') && a.verdict === 'good') a.verdict = 'improve';
    push('title', cur, suggestText('title', cur, a, sctx), a);
  }
  // ---- tags (products, articles): duplicates and blanks removed; never adds tags
  if (res.kind === 'product' || res.kind === 'article') {
    const cur = (res.tags ?? []).join(', ');
    const a = assessSeoField('tags', (res.tags ?? []).join(','), { guidelines: L });
    push('tags', cur, suggestTags(res.tags ?? [], a), a);
  }
  // ---- description / content: extra H1s demoted to H2
  {
    const cur = res.bodyHtml;
    const bodyH1 = bodyHeadings(cur).filter((h) => h.level === 1).length;
    const themeH1 = c.pageH1s.length - bodyH1 > 0 || c.h1Basis === 'none';
    const proposed = bodyH1 && themeH1 ? demoteBodyH1(cur) : undefined;
    const reason = `${bodyH1} H1 in the ${res.kind === 'product' || res.kind === 'collection' ? 'description' : 'content'} while the theme already prints an H1 — demoted to H2. Text unchanged.`;
    push('bodyHtml', cur, proposed ? { value: proposed, reason, keep: false, confidence: 'high' } : undefined, undefined,
      'Edit headings (H2/H3) and add internal links (<a href="/collections/…">) here. Only links to this site are expected.');
  }
  if (res.kind === 'article') push('summaryHtml', res.summaryHtml ?? '', undefined, undefined);
  // ---- image alt text (product media; the featured image of a collection or article)
  const imgs = res.kind === 'product' ? (res.images ?? []).slice(0, 20) : (res.images ?? []);
  const altCount = new Map<string, number>();
  for (const img of imgs) { const k = norm(img.alt).toLowerCase(); if (k) altCount.set(k, (altCount.get(k) ?? 0) + 1); }
  imgs.forEach((img, i) => {
    const a = assessSeoField('imageAlt', img.alt, { guidelines: L, pageType: res.kind, duplicate: (altCount.get(norm(img.alt).toLowerCase()) ?? 0) > 1 });
    const key = res.kind === 'product' ? `imageAlt:${img.id}` : 'imageAlt:featured';
    push(key, img.alt, suggestText('imageAlt', img.alt, a, { ...sctx, index: res.kind === 'product' ? i : 0 }), a, img.url);
  });
  return fields;
}

/** Notes for things only a theme edit (or nothing in Shopify) can change. */
export function themeNotes(c: DraftContext, h1: H1SourceReport): string[] {
  const out: string[] = [];
  for (const s of h1.sources) if (s.applyVia === 'theme') out.push(`H1 “${s.text.slice(0, 80) || '(empty)'}” comes from the theme — change it with a theme edit (Themes tab), not here.`);
  if (c.row?.imagesMissingAlt && c.res.kind !== 'product') out.push(`${c.row.imagesMissingAlt} image(s) without alt text on this page are placed by the theme or inside the content HTML — edit the content (alt attributes) or the theme section.`);
  const tagIssue = (c.row?.issues ?? []).find((i) => /CANONICAL|ROBOTS|HREFLANG|SCHEMA/.test(i.checkId));
  if (tagIssue) out.push(`“${tagIssue.title}” is produced by theme code (layout/theme.liquid or a snippet) — it needs a theme edit.`);
  return out;
}
