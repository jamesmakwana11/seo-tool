/**
 * Structured-data analyzers (PDF §4.6): TECH-SCHEMA-PRESENCE, TECH-SCHEMA-ERRORS, and helpers reused by
 * template audits, AEO and AI-compliance checks.
 */
import type { PageTemplate } from '@sentinel/shared';
import type { ParsedPage, SchemaNode } from '../crawler/types';
import { escapeHtml, perTemplate, trunc, type AnalyzerResult, type Ev, type Prepared } from './context';

export function typesOf(n: SchemaNode): string[] {
  const t = n['@type'];
  return typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

export function nodesOfType(p: ParsedPage, type: string): SchemaNode[] {
  const out: SchemaNode[] = [];
  const rec = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => rec(x, depth + 1));
    const o = v as SchemaNode;
    if (typesOf(o).includes(type)) out.push(o);
    for (const [k, val] of Object.entries(o)) if (k !== '@context') rec(val, depth + 1);
  };
  for (const n of p.html?.schemaNodes ?? []) rec(n, 0);
  return out;
}

export function hasType(p: ParsedPage, ...types: string[]): boolean {
  return types.some((t) => p.html?.schemaTypes.includes(t));
}

function asArray<T = unknown>(v: unknown): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? (v as T[]) : [v as T];
}

export function offersOf(product: SchemaNode): SchemaNode[] {
  const out: SchemaNode[] = [];
  for (const o of asArray<SchemaNode>(product.offers)) {
    if (!o || typeof o !== 'object') continue;
    if (typesOf(o).includes('AggregateOffer')) {
      out.push(o);
      out.push(...asArray<SchemaNode>(o.offers).filter((x) => x && typeof x === 'object'));
    } else out.push(o);
  }
  return out;
}

export function offerPrices(product: SchemaNode): number[] {
  const out: number[] = [];
  for (const o of offersOf(product)) {
    for (const k of ['price', 'lowPrice', 'highPrice']) {
      const v = o[k];
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/,/g, '')) : NaN;
      if (Number.isFinite(n)) out.push(n);
    }
    const spec = o.priceSpecification as SchemaNode | undefined;
    if (spec && typeof spec === 'object') {
      const n = Number(String(spec.price ?? '').replace(/,/g, ''));
      if (Number.isFinite(n) && String(spec.price ?? '') !== '') out.push(n);
    }
  }
  return out;
}

function snippet(n: SchemaNode): string {
  return trunc(JSON.stringify(n, null, 1), 1200);
}

export function jsonldEv(url: string, label: string, n: SchemaNode | undefined, data?: Record<string, unknown>): Ev {
  return { kind: 'jsonld', label, url, content: n ? snippet(n) : '(none)', data };
}

/** Required schema per template (PDF §4.6 list, mapped to templates). */
export const REQUIRED_SCHEMA: Partial<Record<PageTemplate, { need: string[][]; label: string }[]>> = {
  home: [
    { need: [['Organization', 'OnlineStore', 'Corporation', 'LocalBusiness', 'Store']], label: 'Organization' },
    { need: [['WebSite']], label: 'WebSite' },
  ],
  product: [
    { need: [['Product', 'ProductGroup']], label: 'Product' },
    { need: [['BreadcrumbList']], label: 'BreadcrumbList' },
  ],
  collection: [
    { need: [['CollectionPage', 'ItemList', 'OfferCatalog']], label: 'CollectionPage/ItemList' },
    { need: [['BreadcrumbList']], label: 'BreadcrumbList' },
  ],
  blog_article: [{ need: [['Article', 'BlogPosting', 'NewsArticle']], label: 'Article' }],
};

export function analyzeSchemaPresence(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => REQUIRED_SCHEMA[p.template]);
  return perTemplate(prep, pages, 'TECH-SCHEMA-PRESENCE', 'missing structured data', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const found = p.html!.schemaTypes;
    const ev = (label: string): Ev => ({ kind: 'jsonld', label, url: p.url, content: p.html!.jsonld.map((j) => trunc(j.raw, 600)).join('\n---\n') || '(no JSON-LD on page)', data: { typesFound: found } });
    for (const req of REQUIRED_SCHEMA[p.template]!) {
      if (!req.need.every((alts) => alts.some((t) => found.includes(t)))) out.push({ label: `missing ${req.label} schema`, evidence: [ev(`${req.label} not found (types present: ${found.join(', ') || 'none'})`)] });
    }
    if (p.template === 'product') {
      const prods = nodesOfType(p, 'Product');
      if (prods.length) {
        const missing: string[] = [];
        const prod = prods[0];
        const offers = offersOf(prod);
        if (!offers.length) missing.push('offers');
        else {
          if (!offerPrices(prod).length) missing.push('offers.price');
          if (!offers.some((o) => o.availability)) missing.push('offers.availability');
        }
        if (missing.length) out.push({ label: `Product schema missing ${missing.join(', ')}`, evidence: [jsonldEv(p.url, `Product without ${missing.join(', ')}`, prod, { missing })] });
      }
    }
    if (p.template === 'home') {
      const site = nodesOfType(p, 'WebSite')[0];
      if (site && !asArray<SchemaNode>(site.potentialAction).some((a) => a && typesOf(a).includes('SearchAction'))) {
        out.push({ label: 'WebSite schema without SearchAction', evidence: [jsonldEv(p.url, 'WebSite.potentialAction missing SearchAction', site)] });
      }
    }
    return out;
  }, () => ({ businessImpact: 'Missing structured data loses product rich results (price, availability, ratings) and weakens entity understanding by search and AI engines.' }));
}

const PRODUCT_REQUIRED = ['name'];
const PRODUCT_RECOMMENDED = ['image', 'description', 'sku', 'brand'];

export function analyzeSchemaErrors(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => p.html!.jsonld.length);
  const res = perTemplate(prep, pages, 'TECH-SCHEMA-ERRORS', 'structured-data errors', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const h = p.html!;
    for (const j of h.jsonld.filter((x) => !x.ok)) out.push({ label: 'with unparseable JSON-LD (syntax error)', evidence: [{ kind: 'jsonld', label: `JSON parse error: ${j.error}`, url: p.url, content: trunc(j.raw, 800) }] });
    for (const prod of nodesOfType(p, 'Product')) {
      const missReq = PRODUCT_REQUIRED.filter((k) => !prod[k]);
      if (missReq.length) out.push({ label: `Product markup missing required ${missReq.join(', ')}`, evidence: [jsonldEv(p.url, 'Product', prod)] });
      if (!prod.offers && !prod.review && !prod.aggregateRating) out.push({ label: 'Product markup has none of offers/review/aggregateRating (Google requires one)', evidence: [jsonldEv(p.url, 'Product', prod)] });
      else if (!prod.offers && p.template === 'product') out.push({ label: 'Product markup missing offers (required for merchant listings on product pages)', evidence: [jsonldEv(p.url, 'Product without offers', prod)] });
      const prices = offerPrices(prod);
      const visible = h.visiblePrices.flatMap((v) => v.values);
      if (prices.length && visible.length) {
        const match = prices.some((x) => visible.some((v) => Math.abs(v - x) < 0.01 || Math.abs(v - x / 100) < 0.01));
        if (!match) {
          out.push({
            label: 'with offers.price ≠ visible price',
            evidence: [
              jsonldEv(p.url, `JSON-LD price ${prices.join('/')}`, offersOf(prod)[0], { jsonldPrices: prices }),
              { kind: 'html_snippet', label: `Visible price ${visible.join('/')}`, url: p.url, content: h.visiblePrices.map((v) => v.text).join('\n'), data: { visiblePrices: visible } },
            ],
          });
        }
      }
      for (const o of offersOf(prod)) {
        if (o.availability && typeof o.availability === 'string' && !/schema\.org\/|^(InStock|OutOfStock|PreOrder|BackOrder|Discontinued|LimitedAvailability|SoldOut|OnlineOnly|InStoreOnly|PreSale)$/.test(o.availability)) {
          out.push({ label: 'with an invalid offers.availability value', evidence: [jsonldEv(p.url, `availability "${o.availability}"`, o)] });
        }
        if (o.priceCurrency === undefined && !typesOf(o).includes('AggregateOffer') && (o.price !== undefined)) out.push({ label: 'with offers missing priceCurrency', evidence: [jsonldEv(p.url, 'Offer', o)] });
      }
      const rec = PRODUCT_RECOMMENDED.filter((k) => !prod[k]);
      if (rec.length) out.push({ label: `Product markup missing recommended ${rec.join(', ')} (warning)`, evidence: [jsonldEv(p.url, 'Product', prod, { missingRecommended: rec })] });
    }
    // Review markup without visible reviews.
    const ratings = [...nodesOfType(p, 'AggregateRating'), ...nodesOfType(p, 'Review')];
    if (ratings.length && !h.reviews.hasVisible) {
      out.push({
        label: 'with review/aggregateRating markup but no visible reviews',
        evidence: [jsonldEv(p.url, 'Review markup', ratings[0]), { kind: 'html_snippet', label: 'Visible review elements', url: p.url, content: h.reviews.summaryText ? `Only a rating badge: "${escapeHtml(h.reviews.summaryText)}" (no review text)` : 'No review elements found on the page.' }],
      });
    }
    return out;
  });
  // Warning-only findings: mark isWarning when every sub-problem is a "(warning)".
  for (const f of res.findings) {
    const labels = f.evidence.filter((e) => e.kind === 'note').map((e) => String(e.data?.problem ?? ''));
    if (labels.length && labels.every((l) => l.includes('(warning)'))) f.severityContext = { ...f.severityContext, isWarning: true };
  }
  return res;
}
