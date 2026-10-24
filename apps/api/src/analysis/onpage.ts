/**
 * On-page analyzers (PDF §6.1, §6.2): titles, meta descriptions, H1, heading hierarchy, breadcrumbs,
 * image SEO, Open Graph and the homepage / collection / product template checklists.
 */
import type { PageTemplate } from '@sentinel/shared';
import { wordCount } from '@sentinel/shared';
import type { Finding } from '../services/ports';
import type { ParsedPage } from '../crawler/types';
import { collectionHandle, hostOf, isCollectionTagPage, pathOf, productHandle, sameUrl } from '../crawler/url';
import { aggregate, escapeHtml, htmlEv, isNoindex, metricEv, perTemplate, textEv, trunc, type AnalyzerResult, type Ev, type Prepared, type Problem } from './context';
import { hasType, nodesOfType } from './schema';
import { duplicateGroups } from './technical';

const TITLE_ARTIFACT = /(\{\{|\}\}|\{%|%\}|\buntitled\b|\bdefault title\b|\bnew product\b|\bproduct title\b|\bundefined\b|\bnull\b|\bcopy of\b|\bLiquid error\b)/i;
const CTA_USP = /\b(no moq|wholesale|bulk|cod|cash on delivery|free shipping|fast (shipping|delivery)|shipping|delivery|dropship\w*|lowest price|best price|buy now|shop now|order now|offers?|discount|sale|deals?)\b/i;

function pagesForMeta(prep: Prepared): ParsedPage[] {
  return prep.content.filter((p) => !isNoindex(p).noindex);
}

export function analyzeTitle(prep: Prepared): AnalyzerResult {
  const t = prep.ctx.thresholds;
  const brand = prep.ctx.config.site.brand || 'DeoDap';
  const pages = pagesForMeta(prep);
  const dups = prep.global?.titleDups ?? new Map<string, string[]>();
  if (!prep.global?.titleDups) for (const g of duplicateGroups(pages, (p) => p.html!.title?.toLowerCase().trim() || undefined)) for (const u of g) dups.set(u, g);
  return perTemplate(prep, pages, 'ONP-TITLE', 'title-tag defects', (p) => {
    const title = p.html!.title;
    const out: { label: string; evidence?: Ev[] }[] = [];
    const tag = `<title>${escapeHtml(title ?? '')}</title>`;
    if (!title) return [{ label: 'missing a <title>', evidence: [htmlEv(p.url, '<title>', p.html!.titleCount ? '<title></title> (empty)' : '(no <title> element)')] }];
    if (title.length > (t.titleMaxChars ?? 60)) out.push({ label: `with titles longer than ${t.titleMaxChars ?? 60} characters (truncated in SERPs)`, evidence: [htmlEv(p.url, `${title.length} characters`, tag)] });
    if (title.length < (t.titleMinChars ?? 30)) out.push({ label: `with titles shorter than ${t.titleMinChars ?? 30} characters`, evidence: [htmlEv(p.url, `${title.length} characters`, tag)] });
    const art = title.match(TITLE_ARTIFACT);
    if (art) out.push({ label: 'with template artifacts in the title', evidence: [htmlEv(p.url, `artifact "${art[0]}"`, tag)] });
    if (!title.toLowerCase().includes(brand.toLowerCase())) out.push({ label: `with titles missing the brand "${brand}"`, evidence: [htmlEv(p.url, 'brand pattern missing', tag)] });
    if (dups.has(p.url)) out.push({ label: 'with a title duplicated on other pages', evidence: [htmlEv(p.url, `duplicate of ${dups.get(p.url)!.length - 1} other page(s)`, tag)] });
    if (p.html!.titleCount > 1) out.push({ label: 'with more than one <title> element', evidence: [htmlEv(p.url, `${p.html!.titleCount} <title> elements`, tag)] });
    return out;
  });
}

export function analyzeMeta(prep: Prepared): AnalyzerResult {
  const t = prep.ctx.thresholds;
  const pages = pagesForMeta(prep);
  const dups = prep.global?.metaDups ?? new Map<string, string[]>();
  if (!prep.global?.metaDups) for (const g of duplicateGroups(pages, (p) => p.html!.metaDescription?.toLowerCase().trim() || undefined)) for (const u of g) dups.set(u, g);
  return perTemplate(prep, pages, 'ONP-META', 'meta-description defects', (p) => {
    const m = p.html!.metaDescription;
    if (!m) return [{ label: 'missing a meta description', evidence: [htmlEv(p.url, 'meta description', p.html!.metaDescriptionCount ? '<meta name="description" content=""> (empty)' : '(no <meta name="description">)')] }];
    const out: { label: string; evidence?: Ev[] }[] = [];
    const tag = `<meta name="description" content="${escapeHtml(m)}">`;
    if (m.length > (t.metaMaxChars ?? 160)) out.push({ label: `with meta descriptions over ${t.metaMaxChars ?? 160} characters`, evidence: [htmlEv(p.url, `${m.length} characters`, tag)] });
    if (m.length < (t.metaMinChars ?? 70)) out.push({ label: `with meta descriptions under ${t.metaMinChars ?? 70} characters`, evidence: [htmlEv(p.url, `${m.length} characters`, tag)] });
    if (dups.has(p.url)) out.push({ label: 'with a meta description duplicated on other pages', evidence: [htmlEv(p.url, `duplicate of ${dups.get(p.url)!.length - 1} other page(s)`, tag)] });
    if (['home', 'collection', 'product'].includes(p.template) && !CTA_USP.test(m)) {
      out.push({ label: 'with meta descriptions lacking a CTA/USP (No MOQ, wholesale price, COD, fast shipping)', evidence: [htmlEv(p.url, 'no CTA/USP terms', tag)] });
    }
    return out;
  });
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'by', 'at', 'from', 'is', 'buy', 'online', 'india', 'best', 'price', 'shop', 'deodap']);
export const tokens = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

export function analyzeH1(prep: Prepared): AnalyzerResult {
  const pages = pagesForMeta(prep);
  const dups = prep.global?.h1Dups ?? new Map<string, string[]>();
  if (!prep.global?.h1Dups) for (const g of duplicateGroups(pages.filter((p) => p.template !== 'home'), (p) => (p.html!.h1s.length === 1 ? p.html!.h1s[0].toLowerCase() : undefined))) for (const u of g) dups.set(u, g);
  return perTemplate(prep, pages, 'ONP-H1', 'H1 defects', (p) => {
    const h1s = p.html!.h1s.filter((x) => x.trim());
    if (!h1s.length) return [{ label: 'missing an H1', evidence: [htmlEv(p.url, 'H1', p.html!.h1s.length ? '<h1></h1> (empty)' : '(no <h1> on page)')] }];
    const out: { label: string; evidence?: Ev[] }[] = [];
    if (h1s.length > 1) out.push({ label: 'with multiple H1s', evidence: [htmlEv(p.url, `${h1s.length} H1 elements`, h1s.map((h) => `<h1>${escapeHtml(h)}</h1>`).join('\n'))] });
    if (dups.has(p.url)) out.push({ label: 'with an H1 duplicated on other pages', evidence: [htmlEv(p.url, `duplicate of ${dups.get(p.url)!.length - 1} other page(s)`, `<h1>${escapeHtml(h1s[0])}</h1>`)] });
    const tt = tokens(p.html!.title ?? '');
    const ht = tokens(h1s[0]);
    if (tt.length && ht.length && !ht.some((w) => tt.includes(w))) out.push({ label: 'whose H1 does not match the topic of the title', evidence: [htmlEv(p.url, 'title vs H1', `<title>${escapeHtml(p.html!.title ?? '')}</title>\n<h1>${escapeHtml(h1s[0])}</h1>`)] });
    return out;
  });
}

export function analyzeHeadings(prep: Prepared): AnalyzerResult {
  return perTemplate(prep, prep.content, 'ONP-HEADINGS', 'heading-hierarchy problems', (p) => {
    const hs = p.html!.headings;
    const out: { label: string; evidence?: Ev[] }[] = [];
    const skips: string[] = [];
    let prev = 0;
    for (const h of hs) {
      if (prev && h.level > prev + 1) skips.push(`<h${prev}> → <h${h.level}>${escapeHtml(trunc(h.text, 60))}</h${h.level}>`);
      prev = h.level;
    }
    if (skips.length) out.push({ label: 'skipping heading levels', evidence: [htmlEv(p.url, `${skips.length} skipped level(s)`, skips.slice(0, 6).join('\n'))] });
    const styling = hs.filter((h) => wordCount(h.text) === 0 || wordCount(h.text) > 25 || /^(sale|new|hot|-?\d+%( off)?|sold out|add to cart|quick view|close|menu)$/i.test(h.text.trim()));
    if (styling.length) out.push({ label: 'using headings for styling (empty, labels or paragraph-length)', evidence: [htmlEv(p.url, `${styling.length} styling heading(s)`, styling.slice(0, 6).map((h) => `<h${h.level}>${escapeHtml(trunc(h.text, 80))}</h${h.level}>`).join('\n'))] });
    const words = prep.uniqueWords(p);
    if (words > 600 && !hs.some((h) => h.level === 2)) out.push({ label: 'with no H2 despite long copy', evidence: [metricEv('long page without H2', { uniqueWords: words, h2: 0 }, p.url)] });
    return out;
  });
}

export function analyzeBreadcrumbs(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => p.template === 'product' || p.template === 'collection');
  return perTemplate(prep, pages, 'ONP-BREADCRUMBS', 'breadcrumb problems', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    if (!p.html!.breadcrumb.visible) out.push({ label: 'without a visible breadcrumb', evidence: [htmlEv(p.url, 'breadcrumb', '(no breadcrumb element: nav[aria-label=breadcrumb], .breadcrumb…)')] });
    const lists = nodesOfType(p, 'BreadcrumbList');
    if (!lists.length) out.push({ label: 'without BreadcrumbList schema', evidence: [{ kind: 'jsonld', label: 'BreadcrumbList missing', url: p.url, content: `types present: ${p.html!.schemaTypes.join(', ') || 'none'}` }] });
    else {
      const items = (Array.isArray(lists[0].itemListElement) ? lists[0].itemListElement : []) as Record<string, unknown>[];
      const last = items[items.length - 1];
      const lastUrl = typeof last?.item === 'string' ? last.item : (last?.item as Record<string, unknown> | undefined)?.['@id'];
      if (items.length < 2) out.push({ label: 'with a BreadcrumbList of fewer than 2 levels', evidence: [{ kind: 'jsonld', label: 'BreadcrumbList', url: p.url, content: JSON.stringify(lists[0]).slice(0, 800) }] });
      else if (typeof lastUrl === 'string' && hostOf(lastUrl) && !sameUrl(lastUrl, p.url) && !(p.template === 'product' && productHandle(lastUrl) === productHandle(p.url)) && !(p.template === 'collection' && collectionHandle(lastUrl) === collectionHandle(p.url))) {
        out.push({ label: 'whose BreadcrumbList does not end at the page itself', evidence: [{ kind: 'jsonld', label: `last item ${lastUrl}`, url: p.url, content: JSON.stringify(lists[0]).slice(0, 800) }] });
      }
    }
    return out;
  });
}

const STUFF_SEPARATORS = /[,|]/g;

export function analyzeImageSeo(prep: Prepared): AnalyzerResult {
  const brand = prep.ctx.config.site.brand || 'this website';
  return perTemplate(prep, prep.content, 'ONP-IMAGES', 'image SEO problems', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const imgs = p.html!.images.filter((i) => i.inMain);
    const missing = imgs.filter((i) => i.alt === null);
    const empty = imgs.filter((i) => i.alt !== null && !i.alt.trim() && i.index < 3);
    const stuffed = imgs.filter((i) => i.alt && (wordCount(i.alt) > 16 || (i.alt.match(STUFF_SEPARATORS) ?? []).length >= 4 || hasRepeatedWord(i.alt)));
    const badName = imgs.filter((i) => /\/(IMG|DSC|DSCN|PXL|Screenshot|WhatsApp[ _]Image|image|photo)[-_ ]?\d+[^/]*\.(jpe?g|png|webp|heic)/i.test(decodeURIComponent(pathOf(i.src))));
    const tag = (i: (typeof imgs)[number]) => `<img src="${i.src}"${i.alt === null ? '' : ` alt="${escapeHtml(i.alt)}"`}>`;
    if (missing.length) out.push({ label: 'with images missing ALT text', evidence: [htmlEv(p.url, `${missing.length} <img> without alt`, missing.slice(0, 6).map(tag).join('\n'))] });
    if (empty.length && p.template === 'product') out.push({ label: 'with empty ALT on primary product images', evidence: [htmlEv(p.url, `${empty.length} empty alt`, empty.slice(0, 6).map(tag).join('\n'))] });
    if (stuffed.length) out.push({ label: 'with keyword-stuffed ALT text', evidence: [htmlEv(p.url, `${stuffed.length} stuffed alt`, stuffed.slice(0, 4).map(tag).join('\n'))] });
    if (badName.length && p.tier === 1) out.push({ label: 'with camera-default image filenames (IMG_1234.jpg) on Tier 1', evidence: [htmlEv(p.url, `${badName.length} non-descriptive filename(s)`, badName.slice(0, 6).map(tag).join('\n'))] });
    if (p.template === 'product' && imgs.length) {
      const name = (p.html!.h1s[0] ?? '').toLowerCase();
      const primary = imgs[0];
      const nameTokens = tokens(name).slice(0, 3);
      if (primary.alt && nameTokens.length && !nameTokens.some((w) => primary.alt!.toLowerCase().includes(w))) {
        out.push({ label: `whose main image ALT does not follow "{product} – {key attribute} – ${brand}"`, evidence: [htmlEv(p.url, 'primary product image', tag(primary))] });
      }
    }
    return out;
  });
}

function hasRepeatedWord(s: string): boolean {
  const w = tokens(s);
  const c = new Map<string, number>();
  for (const x of w) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.values()].some((n) => n >= 3);
}

export function analyzeOg(prep: Prepared): AnalyzerResult {
  return perTemplate(prep, prep.content, 'ONP-OG', 'Open Graph / Twitter gaps', (p) => {
    const og = p.html!.og;
    const missing = [!og.title && 'og:title', !og.image && 'og:image', !og.url && 'og:url', !p.html!.twitter.card && 'twitter:card'].filter(Boolean) as string[];
    const core = missing.filter((m) => m === 'og:title' || m === 'og:image');
    if (core.length) return [{ label: `missing ${core.join(' and ')}`, evidence: [htmlEv(p.url, `missing ${missing.join(', ')}`, `og:title=${og.title ?? '(none)'}\nog:image=${og.image ?? '(none)'}\nog:url=${og.url ?? '(none)'}\ntwitter:card=${p.html!.twitter.card ?? '(none)'}`)] }];
    if (missing.length) return [{ label: `missing ${missing.join(', ')}`, evidence: [htmlEv(p.url, `missing ${missing.join(', ')}`, missing.join(', '))] }];
    return [];
  });
}

// ------------------------------------------------------------------------------------------------ template audits (PDF §6.2)

type Item = { item: string; pass: boolean | null; detail?: string };

function checklistFinding(checkId: string, t: PageTemplate, pages: ParsedPage[], results: Map<string, Item[]>, prep: Prepared): Finding | undefined {
  const failingByItem = new Map<string, string[]>();
  for (const [url, items] of results) for (const i of items) if (i.pass === false) { const list = failingByItem.get(i.item); if (list) list.push(url); else failingByItem.set(i.item, [url]); }
  const problems: Problem[] = [...failingByItem.entries()].map(([item, urls]) => ({ label: `fail: ${item}`, urls }));
  const itemNames = [...new Set([...results.values()].flat().map((i) => i.item))];
  const summaryTable = itemNames.map((name) => {
    const all = [...results.values()].map((items) => items.find((i) => i.item === name)).filter(Boolean) as Item[];
    const pass = all.filter((i) => i.pass === true).length;
    const fail = all.filter((i) => i.pass === false).length;
    const na = all.filter((i) => i.pass === null).length;
    return { item: name, pass, fail, notEvaluable: na };
  });
  const perPage = [...results.entries()].slice(0, 20).map(([url, items]) => ({ url, items: items.map((i) => ({ item: i.item, pass: i.pass, detail: i.detail })) }));
  void prep;
  return aggregate({
    checkId, template: t, noun: 'checklist failures', problems, examined: pages.length,
    extraEvidence: [
      { kind: 'metric', label: 'Template checklist (pass / fail / not evaluable)', data: { checklist: summaryTable, examined: pages.length } },
      { kind: 'note', label: 'Per-page checklist', data: { pages: perPage } },
    ],
  });
}

export function analyzeTplHome(prep: Prepared): AnalyzerResult {
  const home = prep.content.filter((p) => p.template === 'home');
  if (!home.length) return { evaluated: false, findings: [], reason: 'homepage not crawled successfully' };
  const tier1Collections = prep.ok.filter((p) => p.template === 'collection' && p.tier === 1);
  const maxLinks = prep.ctx.thresholds.homepageMaxInternalLinks ?? 500;
  const kws = ['wholesale', 'dropshipping'];
  const results = new Map<string, Item[]>();
  for (const p of home) {
    const h = p.html!;
    const text = `${h.title ?? ''} ${h.h1s.join(' ')} ${h.mainText}`.toLowerCase();
    const firstBlocks = h.ownBlocks.slice(0, 4).join(' ');
    const linked = (u: string) => h.internalLinks.some((l) => sameUrl(l, u) || collectionHandle(l) === collectionHandle(u));
    const missingT1 = tier1Collections.filter((c) => !linked(c.url));
    results.set(p.url, [
      { item: 'one clear H1', pass: h.h1s.length === 1, detail: `${h.h1s.length} H1(s)` },
      { item: 'primary keyword coverage (wholesale / dropshipping)', pass: kws.every((k) => text.includes(k)), detail: kws.filter((k) => !text.includes(k)).map((k) => `missing "${k}"`).join(', ') || 'ok' },
      { item: 'above-fold value proposition', pass: /\b(no moq|wholesale|bulk|dropship|lowest|free shipping|cod)\b/i.test(firstBlocks), detail: trunc(firstBlocks, 160) },
      { item: 'links to all Tier 1 collections', pass: tier1Collections.length ? missingT1.length === 0 : null, detail: tier1Collections.length ? `${missingT1.length} Tier 1 collection(s) not linked` : 'no Tier 1 collection crawled' },
      { item: 'Organization + WebSite schema', pass: hasType(p, 'Organization', 'OnlineStore', 'Corporation', 'Store') && hasType(p, 'WebSite'), detail: h.schemaTypes.join(', ') },
      { item: 'freshness block (new arrivals)', pass: /\b(new arrivals?|just (in|launched|arrived)|latest (products|arrivals)|what'?s new|new launch(es)?)\b/i.test(h.mainText), detail: '' },
      { item: `internal-link count sanity (< ${maxLinks})`, pass: h.internalLinkCount < maxLinks, detail: `${h.internalLinkCount} internal links` },
    ]);
  }
  const f = checklistFinding('ONP-TPL-HOME', 'home', home, results, prep);
  return { evaluated: true, templates: ['home'], findings: f ? [f] : [] };
}

export function analyzeTplCollection(prep: Prepared): AnalyzerResult {
  const cols = prep.content.filter((p) => p.template === 'collection' && !isCollectionTagPage(p.url) && !/\/collections\/?$/.test(pathOf(p.url)));
  if (!cols.length) return { evaluated: false, findings: [], reason: 'no collection pages crawled' };
  const min = prep.ctx.thresholds.collectionDescMinWords ?? 200;
  const max = prep.ctx.thresholds.collectionDescMaxWords ?? 400;
  const results = new Map<string, Item[]>();
  const descs = new Map<string, string>();
  for (const p of cols) descs.set(p.url, prep.uniqueText(p));
  // Description → collection URLs carrying it (in crawl order), to find identical descriptions without comparing every pair.
  const byDesc = new Map<string, string[]>();
  for (const [u, d] of descs) { if (d.length <= 80) continue; const list = byDesc.get(d); if (list) list.push(u); else byDesc.set(d, [u]); }
  for (const p of cols) {
    const h = p.html!;
    const words = wordCount(descs.get(p.url) ?? '');
    const sameDesc = byDesc.get(descs.get(p.url) ?? '');
    // Batch analysis: identical descriptions across the whole crawl come from the text core.
    const dupUrl = prep.global?.collectionDescDup ? prep.global.collectionDescDup.get(p.url) : sameDesc?.find((u) => u !== p.url);
    const dupOf = dupUrl !== undefined ? [dupUrl] : undefined;
    const handleWords = tokens((collectionHandle(p.url) ?? '').replace(/-/g, ' '));
    const h1 = (h.h1s[0] ?? '').toLowerCase();
    const filtered = (prep.global?.budgetSamples ?? prep.budgetSamples).filter((s) => collectionHandle(s.url) === collectionHandle(p.url) && s.status === 200 && s.html);
    const filteredOk = filtered.filter((s) => (s.html!.canonicals[0] && !sameUrl(s.html!.canonicals[0], s.url)) || isNoindex(s).noindex);
    const subLinks = h.links.filter((l) => l.internal && l.inMain && /^\/collections\/[^/]+\/?$/.test(pathOf(l.url)) && collectionHandle(l.url) !== collectionHandle(p.url));
    const productLinks = h.links.filter((l) => l.internal && l.inMain && /\/products\//.test(pathOf(l.url)));
    results.set(p.url, [
      { item: `unique ${min}–${max} word description`, pass: words >= min && words <= max * 1.5 && !dupOf, detail: `${words} unique words${dupOf ? `; identical to ${dupOf[0]}` : ''}` },
      { item: 'H1 = collection keyword', pass: h1 ? (handleWords.length ? handleWords.some((w) => h1.includes(w)) : true) : false, detail: `H1 "${h.h1s[0] ?? ''}" vs handle "${collectionHandle(p.url)}"` },
      { item: 'filtered/sorted URLs canonicalized', pass: filtered.length ? filteredOk.length === filtered.length : null, detail: filtered.length ? `${filteredOk.length}/${filtered.length} sampled filter/sort URLs canonicalized or noindexed` : 'no filter/sort URL sampled' },
      { item: 'subcollection interlinking', pass: subLinks.length > 0, detail: `${subLinks.length} links to other collections in content` },
      { item: 'FAQ block', pass: h.faq.present, detail: `${h.faq.items.length} Q&A items` },
      { item: 'ItemList / CollectionPage schema', pass: hasType(p, 'ItemList', 'CollectionPage', 'OfferCatalog'), detail: h.schemaTypes.join(', ') || 'none' },
      { item: 'first product row server-rendered', pass: productLinks.length >= 1, detail: `${productLinks.length} product links in raw HTML` },
    ]);
  }
  const f = checklistFinding('ONP-TPL-COLLECTION', 'collection', cols, results, prep);
  return { evaluated: true, templates: ['collection'], findings: f ? [f] : [] };
}

export function analyzeTplProduct(prep: Prepared): AnalyzerResult {
  const prods = prep.content.filter((p) => p.template === 'product');
  if (!prods.length) return { evaluated: false, findings: [], reason: 'no product pages crawled' };
  const results = new Map<string, Item[]>();
  for (const p of prods) {
    const h = p.html!;
    const desc = h.descriptionText ?? prep.uniqueText(p);
    const text = h.mainText;
    const prod = nodesOfType(p, 'Product')[0];
    const offers = prod?.offers;
    results.set(p.url, [
      { item: 'unique description (not supplier boilerplate)', pass: prep.uniqueWords(p) >= 80 && !/\b(supplier|manufacturer) (description|copy)\b|lorem ipsum/i.test(desc), detail: `${prep.uniqueWords(p)} unique words` },
      { item: 'specification table', pass: h.features.specTable, detail: h.features.specTable ? 'found' : 'no spec table / spec list' },
      { item: 'wholesale/bulk pricing clarity', pass: /\b(wholesale|bulk|moq|minimum order|pack of|per piece|quantity discount|tier(ed)? pric)/i.test(text), detail: '' },
      { item: 'Product schema completeness', pass: !!prod && !!offers && !!prod.image && !!prod.description, detail: prod ? ['offers', 'image', 'description', 'sku', 'brand'].filter((k) => !prod[k]).map((k) => `missing ${k}`).join(', ') || 'complete' : 'no Product schema' },
      { item: 'reviews visible + marked up', pass: h.reviews.hasVisible && hasType(p, 'Review', 'AggregateRating'), detail: `${h.reviews.visibleCount} visible review(s); markup: ${hasType(p, 'Review', 'AggregateRating') ? 'yes' : 'no'}` },
      { item: 'related / frequently-bought-together links', pass: h.links.filter((l) => l.internal && /\/products\//.test(pathOf(l.url)) && productHandle(l.url) !== productHandle(p.url)).length >= 2, detail: '' },
      { item: 'Q&A section', pass: h.faq.present || h.questionHeadings.length > 0 || /\b(questions? (&|and) answers?|q\s*&\s*a)\b/i.test(text), detail: '' },
      { item: 'shipping/return info', pass: /\b(shipping|delivery)\b/i.test(text) && /\b(return|refund|replacement|exchange)\b/i.test(text), detail: '' },
      { item: 'video', pass: h.features.video ? true : null, detail: h.features.video ? 'video present' : 'no video (only required "where available" — not scored)' },
    ]);
  }
  const f = checklistFinding('ONP-TPL-PRODUCT', 'product', prods, results, prep);
  return { evaluated: true, templates: ['product'], findings: f ? [f] : [] };
}

export { textEv };
