import { load, type CheerioAPI } from 'cheerio';
import { wordCount } from '@sentinel/shared';
import type { ParsedHtml, SchemaNode, Segment } from './types';
import { isSameSite, resolveUrl } from './url';

/** Minimal structural view of a DOM node (avoids a direct domhandler dependency). */
interface N {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: N[];
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'nav', 'header', 'footer', 'select', 'button', 'head', 'title']);
const SKIP_CLASS = /(^|[\s_-])(breadcrumbs?|announcement-bar|cookie|visually-hidden|skip-to-content|drawer|menu-drawer)([\s_-]|$)/i;
const GRID_CLASS = /(^|\s)(product-grid|product-card[\w-]*|card-wrapper|card--product|grid-product|grid__item|product-item|productitem|collection-products|related-products|product-recommendations|predictive-search)(\s|$)/i;
const BLOCK = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'section', 'article', 'aside', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'dd', 'dt', 'dl', 'blockquote',
  'figure', 'figcaption', 'pre', 'br', 'details', 'summary', 'main', 'form', 'address', 'hr', 'body', 'caption', 'label',
]);
const HEADING = /^h([1-6])$/;
const QUESTION_START = /^(what|how|why|which|is|are|can|could|does|do|did|where|when|who|should|will|would|wholesale\s.*\?)\b/i;

export const PRICE_SELECTORS = '.price-item--sale, .price-item--regular, [data-product-price], .price, [itemprop="price"], .product__price, .product-price';
const REVIEW_ITEM_SELECTORS = '.spr-review, .jdgm-rev, .review, .review-item, [data-review-id], [itemprop="review"], .yotpo-review, .stamped-review, .loox-review, .okeReviews-review, .product-review';
const BREADCRUMB_SELECTORS = 'nav[aria-label*="breadcrumb" i], .breadcrumb, .breadcrumbs, [class*="breadcrumb" i], [itemtype*="BreadcrumbList"]';
const DESCRIPTION_SELECTORS = '.product__description, .product-description, .product-single__description, [itemprop="description"], .collection-description, .collection__description, .collection-hero__description, .rte';

function collapse(s: string): string {
  return s.replace(/[\s ]+/g, ' ').trim();
}

function classOf(n: N): string {
  return n.attribs?.class ?? '';
}

function isSkipped(n: N, extra?: (n: N) => boolean): boolean {
  if (n.type !== 'tag' && n.type !== 'script' && n.type !== 'style') return false;
  const name = (n.name ?? '').toLowerCase();
  if (SKIP_TAGS.has(name)) return true;
  if (n.attribs?.role === 'navigation' || n.attribs?.['aria-hidden'] === 'true' || n.attribs?.hidden !== undefined) return true;
  if (SKIP_CLASS.test(classOf(n))) return true;
  return extra ? extra(n) : false;
}

/** Plain text of a subtree with block boundaries turned into spaces. */
export function textOfNode(n: N, skip?: (n: N) => boolean): string {
  const out: string[] = [];
  const rec = (x: N) => {
    if (x.type === 'text') {
      out.push(x.data ?? '');
      return;
    }
    if (x.type === 'script' || x.type === 'style' || x.type === 'comment' || x.type === 'directive' || x.type === 'cdata') return;
    if (skip && skip(x)) return;
    const name = (x.name ?? '').toLowerCase();
    if (name === 'script' || name === 'style' || name === 'noscript' || name === 'template' || name === 'svg') return;
    const block = BLOCK.has(name) || HEADING.test(name);
    if (block) out.push(' ');
    for (const c of x.children ?? []) rec(c);
    if (block) out.push(' ');
  };
  rec(n);
  return collapse(out.join(''));
}

/** Walk main content producing ordered heading/text segments (navigation, header, footer, scripts excluded). */
function segmentsOf(root: N, extraSkip?: (n: N) => boolean): Segment[] {
  const segs: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = collapse(buf.join(''));
    if (t) segs.push({ kind: 'text', text: t });
    buf = [];
  };
  const rec = (x: N) => {
    if (x.type === 'text') {
      buf.push(x.data ?? '');
      return;
    }
    if (x.type !== 'tag' && x.type !== 'root') return;
    if (x !== root && isSkipped(x, extraSkip)) return;
    const name = (x.name ?? '').toLowerCase();
    const h = name.match(HEADING);
    if (h) {
      flush();
      const t = textOfNode(x);
      if (t) segs.push({ kind: 'heading', level: Number(h[1]), text: t });
      return;
    }
    const block = BLOCK.has(name);
    if (block) flush();
    for (const c of x.children ?? []) rec(c);
    if (block) flush();
  };
  rec(root);
  flush();
  return segs;
}

function collectTypes(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) collectTypes(x, out, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  const t = o['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  for (const [k, val] of Object.entries(o)) if (k !== '@type' && k !== '@context') collectTypes(val, out, depth + 1);
}

export function parsePriceValues(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

const DATE_RE = /(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/;

function toIso(s: string): string | undefined {
  const d = new Date(s.replace(/(\d)(st|nd|rd|th)/, '$1'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Parse one HTML document. Pure: no network. All URLs returned are absolute.
 */
const COMPONENT_CLASS = /(gallery|slider|slideshow|carousel|swiper|thumbnail|media|card|logo|banner|badge|icon|menu|footer__|header__|collage|grid__item|image-with-text|multicolumn|testimonial)/i;

/**
 * Where an <img> is (from its parent up): page landmark, Shopify section (id="shopify-section-…", part after "__") and
 * the nearest component class — same rule and wording as the Go crawler (services/crawler-go/extract.go imageLocation).
 */
function imageLocation(parent: ReturnType<CheerioAPI>): string {
  const parts: string[] = [];
  const land = parent.closest('header, nav, main, aside, footer');
  if (land.length) parts.push((land.get(0) as { tagName?: string }).tagName ?? '');
  const sec = parent.closest('[id^="shopify-section-"]');
  if (sec.length) {
    let id = (sec.attr('id') ?? '').replace(/^shopify-section-/, '');
    const k = id.lastIndexOf('__');
    if (k >= 0) id = id.slice(k + 2);
    parts.push(`section "${id}"`);
  }
  // Parent first, then its ancestors (nearest first) — like Go's closest(img.Parent, …).
  const chain = [...parent.toArray(), ...parent.parents().toArray()];
  const comp = chain.find((n) => COMPONENT_CLASS.test((n as { attribs?: Record<string, string> }).attribs?.class ?? ''));
  if (comp) {
    const tok = ((comp as { attribs?: Record<string, string> }).attribs?.class ?? '').split(/\s+/).find((t) => COMPONENT_CLASS.test(t));
    if (tok) parts.push(`.${tok}`);
  }
  return parts.filter(Boolean).join(' › ');
}

export function parseHtml(html: string, pageUrl: string, siteHost: string): ParsedHtml {
  const $: CheerioAPI = load(html);
  const isHttps = pageUrl.startsWith('https:');
  const abs = (h?: string) => resolveUrl(h, pageUrl);

  // ------------------------------------------------------------------ head
  const titles = $('title').filter((_, e) => $(e).closest('svg').length === 0);
  const title = titles.length ? collapse(titles.first().text()) : undefined;
  const metaDesc = $('meta[name="description" i]');
  const metaDescription = metaDesc.length ? collapse(metaDesc.first().attr('content') ?? '') : undefined;
  const metaRobots = $('meta[name="robots" i], meta[name="googlebot" i]')
    .toArray()
    .map((e) => ($(e).attr('content') ?? '').toLowerCase())
    .filter(Boolean)
    .join(', ') || undefined;
  const canonicals = $('link[rel]')
    .filter((_, e) => ($(e).attr('rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'))
    .toArray()
    .map((e) => abs($(e).attr('href')) ?? ($(e).attr('href') ?? ''))
    .filter((x) => x !== undefined);
  const meta = (sel: string) => {
    const v = $(sel).first().attr('content');
    return v === undefined ? undefined : collapse(v);
  };
  const og = {
    url: meta('meta[property="og:url"]'),
    title: meta('meta[property="og:title"]'),
    image: meta('meta[property="og:image"]') ?? meta('meta[property="og:image:secure_url"]'),
    description: meta('meta[property="og:description"]'),
    type: meta('meta[property="og:type"]'),
  };
  const twitter = { card: meta('meta[name="twitter:card"]'), title: meta('meta[name="twitter:title"]'), image: meta('meta[name="twitter:image"]') };
  const headScripts = $('head script[src]')
    .toArray()
    .map((e) => {
      const el = $(e);
      const type = el.attr('type');
      return { src: abs(el.attr('src')) ?? el.attr('src') ?? '', async: el.attr('async') !== undefined, defer: el.attr('defer') !== undefined, module: type === 'module', type };
    })
    .filter((s) => s.src);
  const scriptSrcs = [...new Set($('script[src]').toArray().map((e) => abs($(e).attr('src'))).filter((x): x is string => !!x))];
  const stylesheets = $('link[rel="stylesheet" i]').toArray().map((e) => abs($(e).attr('href'))).filter((x): x is string => !!x);

  // ------------------------------------------------------------------ JSON-LD
  const jsonld: ParsedHtml['jsonld'] = [];
  const schemaNodes: SchemaNode[] = [];
  const types = new Set<string>();
  $('script[type="application/ld+json" i]').each((_, e) => {
    const raw = ($(e).html() ?? '').trim();
    if (!raw) return;
    try {
      const data = JSON.parse(raw.replace(/^\s*<!--|-->\s*$/g, ''));
      jsonld.push({ raw, ok: true });
      const push = (n: unknown) => {
        if (n && typeof n === 'object' && !Array.isArray(n)) {
          const o = n as SchemaNode;
          if (Array.isArray(o['@graph'])) (o['@graph'] as unknown[]).forEach(push);
          else schemaNodes.push(o);
        }
      };
      if (Array.isArray(data)) data.forEach(push);
      else push(data);
      collectTypes(data, types);
    } catch (err) {
      jsonld.push({ raw: raw.slice(0, 2000), ok: false, error: (err as Error).message });
    }
  });

  // ------------------------------------------------------------------ main content
  const mainEl = $('main, [role="main"], #MainContent, #main-content').first();
  const body = $('body').first();
  const rootSel = mainEl.length ? mainEl : body;
  const rootNode = (rootSel.get(0) ?? $.root().get(0)) as unknown as N;
  const segments = segmentsOf(rootNode);
  const blocks = segments.filter((s) => s.kind === 'text').map((s) => s.text);
  const mainText = segments.map((s) => s.text).join('\n');
  const wc = wordCount(mainText);
  const gridSkip = (n: N) => GRID_CLASS.test(classOf(n)) || n.attribs?.['data-product-grid'] !== undefined;
  const ownSegments = segmentsOf(rootNode, gridSkip);
  const ownBlocks = ownSegments.filter((s) => s.kind === 'text').map((s) => s.text);
  const contentWordsExcludingGrid = wordCount(ownSegments.map((s) => s.text).join('\n'));

  const headings = segmentsOf(body.get(0) as unknown as N)
    .filter((s) => s.kind === 'heading')
    .map((s) => ({ level: s.level!, text: s.text }));
  // H1s anywhere in the body (incl. header), as search engines see them.
  const h1s = $('body h1').toArray().filter((e) => $(e).closest('svg').length === 0).map((e) => textOfNode(e as unknown as N));

  const descEl = $(DESCRIPTION_SELECTORS).filter((_, e) => $(e).closest('.product-card, .card-wrapper, .grid__item, .related-products').length === 0).first();
  const descriptionText = descEl.length ? textOfNode(descEl.get(0) as unknown as N) : undefined;

  // ------------------------------------------------------------------ links
  const links: ParsedHtml['links'] = [];
  $('a[href]').each((_, e) => {
    const el = $(e);
    const url = abs(el.attr('href'));
    if (!url) return;
    const chrome = el.closest('header, nav, footer, [role="navigation"]').length > 0;
    const inMain = !chrome && (mainEl.length ? el.closest(mainEl).length > 0 : true);
    links.push({ url, text: collapse(el.text()), internal: isSameSite(url, siteHost), inMain, rel: el.attr('rel') });
  });
  const internalLinks = [...new Set(links.filter((l) => l.internal).map((l) => l.url))];
  const externalLinks = [...new Set(links.filter((l) => !l.internal).map((l) => l.url))];

  // ------------------------------------------------------------------ images
  const images: ParsedHtml['images'] = [];
  $('body img').each((i, e) => {
    const el = $(e);
    const rawSrc = el.attr('src') || el.attr('data-src') || (el.attr('srcset') ?? el.attr('data-srcset') ?? '').split(',')[0]?.trim().split(/\s+/)[0];
    if (!rawSrc || rawSrc.startsWith('data:')) return;
    const src = abs(rawSrc.startsWith('//') ? `${pageUrl.startsWith('https') ? 'https:' : 'http:'}${rawSrc}` : rawSrc);
    if (!src) return;
    const alt = el.attr('alt');
    const location = imageLocation(el.parent());
    images.push({
      src, alt: alt === undefined ? null : alt, width: el.attr('width'), height: el.attr('height'), loading: el.attr('loading')?.toLowerCase(),
      inMain: mainEl.length ? el.closest(mainEl).length > 0 : el.closest('header, nav, footer').length === 0, index: i,
      ...(location ? { location } : {}),
    });
  });

  // ------------------------------------------------------------------ prices / breadcrumbs / reviews
  const priceEls = $(PRICE_SELECTORS).filter(
    (_, e) => $(e).closest('.product-card, .card-wrapper, .card, .grid__item, .related-products, .product-recommendations, [class*="product-card" i]').length === 0,
  );
  const visiblePrices = priceEls
    .toArray()
    .filter((e) => $(e).find(PRICE_SELECTORS).length === 0)
    .map((e) => {
      const text = collapse($(e).text());
      return { text, values: parsePriceValues(text) };
    })
    .filter((p) => p.values.length);

  const bc = $(BREADCRUMB_SELECTORS).filter((_, e) => $(e).prop('tagName')?.toLowerCase() !== 'script').first();
  const breadcrumb = { visible: bc.length > 0 && collapse(bc.text()).length > 0, text: bc.length ? collapse(bc.text()) : undefined };

  const reviewEls = $(REVIEW_ITEM_SELECTORS).filter((_, e) => $(e).parents(REVIEW_ITEM_SELECTORS).length === 0);
  const reviewTexts = reviewEls.toArray().map((e) => collapse($(e).text())).filter((t) => wordCount(t) >= 3);
  const summaryEl = $('.spr-badge, .jdgm-prev-badge, .rating, [class*="rating" i], .stamped-badge').first();
  const reviews = { visibleCount: reviewTexts.length, texts: reviewTexts.slice(0, 30), summaryText: summaryEl.length ? collapse(summaryEl.text()) || undefined : undefined, hasVisible: reviewTexts.length > 0 };

  // ------------------------------------------------------------------ FAQ & question headings
  const questionHeadings: ParsedHtml['questionHeadings'] = [];
  const faqItems: { q: string; a: string }[] = [];
  let inFaq = false;
  let faqLevel = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.kind !== 'heading') continue;
    const lvl = s.level!;
    if (/\b(faq|faqs|frequently asked|questions? (&|and) answers?|q\s*&\s*a)\b/i.test(s.text)) {
      inFaq = true;
      faqLevel = lvl;
      continue;
    }
    const endsQ = /\?\s*$/.test(s.text);
    const isQ = endsQ || (inFaq && QUESTION_START.test(s.text));
    if (inFaq && lvl <= faqLevel && !isQ) inFaq = false;
    if (!isQ) continue;
    const answerParts: string[] = [];
    for (let j = i + 1; j < segments.length && segments[j].kind === 'text'; j++) answerParts.push(segments[j].text);
    const firstAnswer = answerParts[0] ?? '';
    if (endsQ && lvl >= 2 && lvl <= 4) questionHeadings.push({ level: lvl, text: s.text, firstAnswer, firstAnswerWords: wordCount(firstAnswer) });
    if (inFaq) faqItems.push({ q: s.text, a: answerParts.join(' ') });
  }
  $('details').each((_, e) => {
    const q = collapse($(e).children('summary').first().text());
    if (!q) return;
    const all = textOfNode(e as unknown as N);
    const a = collapse(all.slice(all.indexOf(q) + q.length));
    if (/\?\s*$/.test(q) || QUESTION_START.test(q) || $(e).closest('[class*="faq" i], #faq').length) faqItems.push({ q, a });
  });
  $('[class*="faq" i] dt, #faq dt').each((_, e) => {
    const q = collapse($(e).text());
    const a = collapse($(e).next('dd').text());
    if (q) faqItems.push({ q, a });
  });
  const faqSeen = new Set<string>();
  const faq = {
    items: faqItems.filter((x) => (faqSeen.has(x.q) ? false : (faqSeen.add(x.q), true))),
    present: false,
  };
  faq.present = faq.items.length > 0;

  // ------------------------------------------------------------------ author / dates
  const authorEl = $('[rel="author"], .article__author, .article-author, [itemprop="author"], .byline, .author, [class*="author-name" i]').first();
  const bioEl = $('.author-bio, .author__bio, [class*="author-bio" i], [class*="author-info" i], .about-author').first();
  const bioText = bioEl.length ? collapse(bioEl.text()) : undefined;
  const author = {
    name: authorEl.length ? collapse(authorEl.text()).replace(/^(by|written by|author:?)\s+/i, '') || undefined : undefined,
    hasBio: !!bioText && wordCount(bioText) >= 12,
    bioText,
  };
  const visibleDates: ParsedHtml['visibleDates'] = [];
  $('time').each((_, e) => {
    const el = $(e);
    const dt = el.attr('datetime');
    const ctx = collapse(el.parent().text());
    const label = /updated|modified/i.test(ctx) ? 'updated' : /published|posted/i.test(ctx) ? 'published' : 'date';
    visibleDates.push({ label, text: collapse(el.text()) || dt || '', iso: dt ? toIso(dt) : toIso(collapse(el.text())) });
  });
  const bodyText = textOfNode(body.get(0) as unknown as N);
  const updRe = new RegExp(`(last updated|updated on|updated|last modified|modified on|published on|posted on|published)\\s*:?\\s*${DATE_RE.source}`, 'gi');
  let dm: RegExpExecArray | null;
  while ((dm = updRe.exec(bodyText))) {
    const label = /updated|modified/i.test(dm[1]) ? 'updated' : 'published';
    visibleDates.push({ label, text: dm[0], iso: toIso(dm[2]) });
  }

  // ------------------------------------------------------------------ mixed content
  const mixedContent: string[] = [];
  if (isHttps) {
    $('img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src], link[rel="stylesheet" i][href]').each((_, e) => {
      const raw = $(e).attr('src') ?? $(e).attr('href') ?? '';
      if (/^http:\/\//i.test(raw.trim())) mixedContent.push(raw.trim());
    });
  }

  // ------------------------------------------------------------------ extractability features
  const tablesEls = rootSel.find('table');
  const dataTables = tablesEls.filter((_, t) => $(t).find('th').length > 0 || $(t).find('tr').length >= 2).length;
  const specKw = /\b(material|dimensions?|size|weight|capacity|specifications?|colou?r|warranty|power|wattage|voltage|battery|pack of|quantity|model)\b/i;
  const specTable =
    rootSel.find('table, dl').toArray().some((t) => specKw.test($(t).text())) ||
    segments.some((s, i) => s.kind === 'heading' && /specification|specs|product details/i.test(s.text) && segments[i + 1]?.kind === 'text');
  const definitionSentence = blocks
    .slice(0, 8)
    .flatMap((b) => b.split(/(?<=[.!?])\s+/))
    .find((sen) => /\b(is|are|refers to|means)\s+(a|an|the)\b/i.test(sen) && wordCount(sen) >= 8 && wordCount(sen) <= 45);
  const features = {
    tables: tablesEls.length,
    dataTables,
    orderedLists: rootSel.find('ol').filter((_, o) => $(o).children('li').length >= 3).length,
    definitionLists: rootSel.find('dl').length,
    video: $('video, iframe[src*="youtube" i], iframe[src*="vimeo" i], iframe[data-src*="youtube" i]').length > 0,
    specTable,
    definitionSentence,
  };

  const internalLinkCount = links.filter((l) => l.internal).length;
  const relLink = (rel: string) => abs($(`link[rel="${rel}"]`).first().attr('href'));

  return {
    lang: $('html').attr('lang'),
    hasViewport: $('meta[name="viewport" i]').length > 0,
    title,
    titleCount: titles.length,
    metaDescription,
    metaDescriptionCount: metaDesc.length,
    metaRobots,
    canonicals,
    og,
    twitter,
    h1s,
    headings,
    links,
    internalLinks,
    externalLinks,
    internalLinkCount,
    images,
    headScripts,
    scriptSrcs,
    stylesheets,
    jsonld,
    schemaNodes,
    schemaTypes: [...types],
    visiblePrices,
    breadcrumb,
    reviews,
    faq,
    questionHeadings,
    author,
    visibleDates,
    mainText,
    wordCount: wc,
    blocks,
    ownBlocks,
    segments,
    descriptionText,
    descriptionWords: descriptionText ? wordCount(descriptionText) : 0,
    contentWordsExcludingGrid,
    mixedContent,
    pagination: { next: relLink('next'), prev: relLink('prev') },
    features,
    phoneVisible: $('a[href^="tel:"]').length > 0 || /(\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/.test(bodyText),
  };
}
