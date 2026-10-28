/**
 * Field assessment and suggestions: missing, too short / long (with tolerance and page type), duplicated,
 * keyword-stuffed, unclear and already-good values; configurable guidelines; suggestions that reuse only the page's
 * own text, keep good values, leave room for a theme's title suffix, and never drop a store keyword silently.
 */
import { describe, expect, it } from 'vitest';
import { assessSeoField, seoGuidelinesFrom, DEFAULT_SEO_GUIDELINES } from '@sentinel/shared';
import { buildFields, dedupeText, descriptionText, readableCase, shortenKeepingBrand, suggestText } from '../../src/shopify/drafts';
import type { ShopifyResource } from '../../src/shopify/resources';

const codes = (type: Parameters<typeof assessSeoField>[0], v: string, c: Parameters<typeof assessSeoField>[2] = {}) => assessSeoField(type, v, c).problems.map((p) => p.code);
const res = (x: Partial<ShopifyResource> = {}): ShopifyResource => ({ kind: 'product', id: 'gid://shopify/Product/1', handle: 'steel-bottle', title: 'Insulated Steel Water Bottle 750 ml', seoTitle: '', seoDescription: '', bodyHtml: '<p>Keeps water cold for 24 hours and hot for 12 hours. Leak-proof lid and a powder-coated finish that does not slip.</p>', tags: [], images: [], path: '/products/steel-bottle', ...x });

describe('assessSeoField', () => {
  it('flags missing values per field', () => {
    expect(codes('seoDescription', '')).toEqual(['missing']);
    expect(assessSeoField('seoDescription', '').verdict).toBe('fix');
    expect(assessSeoField('seoTitle', '').verdict).toBe('improve'); // falls back to the title
    expect(codes('imageAlt', '   ')).toEqual(['missing']);
    expect(codes('h1', '')).toEqual(['missing']);
  });

  it('uses a tolerance: a little outside the range is only a note, far outside is flagged', () => {
    expect(assessSeoField('seoTitle', 'x'.repeat(63)).verdict).toBe('good');
    expect(codes('seoTitle', 'x'.repeat(63))).toEqual(['slightly_long']);
    expect(codes('seoTitle', 'A '.repeat(40).trim())).toContain('too_long');
    expect(codes('seoDescription', 'Short meta text about bottles here.')).toContain('too_short');
  });

  it('takes the page type into account (a simple page may have a short title)', () => {
    expect(assessSeoField('seoTitle', 'Contact Us', { pageType: 'page' }).verdict).toBe('good');
    expect(assessSeoField('seoTitle', 'Contact Us', { pageType: 'product' }).verdict).toBe('improve');
  });

  it('follows configured guidelines', () => {
    const g = seoGuidelinesFrom({ titleMaxChars: 70, titleMinChars: 20, unrelated: 5 });
    expect(g).toMatchObject({ titleMaxChars: 70, titleMinChars: 20, metaMaxChars: DEFAULT_SEO_GUIDELINES.metaMaxChars });
    expect(assessSeoField('seoTitle', 'x'.repeat(68), { guidelines: g }).verdict).toBe('good');
    expect(assessSeoField('seoTitle', 'x'.repeat(68)).verdict).toBe('improve');
  });

  it('flags duplicates, keyword stuffing, all capitals, file names and generic text', () => {
    expect(codes('seoTitle', 'Steel Water Bottle 750 ml – DeoDap Online Store', { duplicate: true })).toContain('duplicate');
    expect(codes('seoTitle', 'Kitchen Tools | Kitchen Tools | Kitchen Tools Online')).toContain('keyword_stuffed');
    expect(codes('imageAlt', 'bottle bottle steel bottle water bottle')).toContain('keyword_stuffed');
    expect(codes('title', 'INSULATED STEEL WATER BOTTLE')).toContain('all_caps');
    expect(codes('imageAlt', 'IMG_2041.jpg')).toContain('filename');
    expect(codes('imageAlt', 'image')).toContain('unclear');
    expect(codes('seoDescription', 'Insulated Steel Water Bottle', { title: 'Insulated Steel Water Bottle' })).toContain('same_as_title');
    expect(codes('h1', 'Bottle', { h1Count: 3 })).toContain('multiple');
  });

  it('calls a good value good', () => {
    const a = assessSeoField('seoTitle', 'Insulated Steel Water Bottle 750 ml – DeoDap');
    expect(a).toMatchObject({ verdict: 'good', problems: [] });
    expect(assessSeoField('seoDescription', 'Keeps water cold for 24 hours and hot for 12 hours. Leak-proof lid and a powder-coated finish that does not slip.').verdict).toBe('good');
  });

  it('checks tags for blanks, duplicates and spaces', () => {
    expect(codes('tags', 'kitchen, Kitchen, ,chopper')).toEqual(expect.arrayContaining(['blank_tags', 'duplicate_tags']));
    expect(assessSeoField('tags', 'kitchen,chopper').verdict).toBe('good');
  });
});

describe('suggestions', () => {
  const L = DEFAULT_SEO_GUIDELINES;
  const ctx = (r: ShopifyResource) => ({ res: r, shopName: 'DeoDap', limits: L, descText: descriptionText(r.bodyHtml), keywords: ['steel water bottle'] });

  it('recommends keeping a good value', () => {
    const r = res({ seoTitle: 'Insulated Steel Water Bottle 750 ml – DeoDap' });
    const s = suggestText('seoTitle', r.seoTitle, assessSeoField('seoTitle', r.seoTitle), ctx(r));
    expect(s).toMatchObject({ keep: true, value: r.seoTitle });
    expect(s.reason).toMatch(/keep/i);
  });

  it('suggests even for an existing value when it is problematic (stuffed, too long, all caps)', () => {
    const r = res();
    const stuffed = 'Steel Water Bottle | Steel Water Bottle | Steel Water Bottle';
    const s = suggestText('seoTitle', stuffed, assessSeoField('seoTitle', stuffed), ctx(r));
    expect(s.keep).toBe(false);
    expect(s.value).toBe('Steel Water Bottle – DeoDap');
    expect(s.reason).toMatch(/repeated/);
    const caps = suggestText('title', 'INSULATED STEEL WATER BOTTLE 750 ML', assessSeoField('title', 'INSULATED STEEL WATER BOTTLE 750 ML'), ctx(r));
    expect(caps).toMatchObject({ value: 'Insulated Steel Water Bottle 750 ml', confidence: 'review' });
  });

  it('builds a missing meta description from the page’s own description text, skipping forms', () => {
    const r = res({ bodyHtml: '<form><label>Select option:</label><select><option>Tracking id</option></select><button>Track</button></form><p>Enter your order number to see where your parcel is right now.</p><p>Orders sent with India Post can be tracked on their website as well.</p>' });
    const s = suggestText('seoDescription', '', assessSeoField('seoDescription', ''), ctx(r));
    expect(s.value).not.toMatch(/Select option|Tracking id/);
    expect(s.value).toMatch(/^Enter your order number to see where your parcel is right now\. Orders sent with India Post/);
  });

  it('shortens long titles at a word boundary keeping the brand', () => {
    expect(shortenKeepingBrand('Insulated Steel Water Bottle 750 ml with Leak Proof Lid for Office and Gym | DeoDap', 60, 'DeoDap')).toMatch(/ \| DeoDap$/);
    expect(dedupeText('Kitchen Tools | Kitchen Tools | Shop')).toBe('Kitchen Tools | Shop');
    expect(readableCase('USB LED DESK LAMP 5W')).toBe('USB LED Desk Lamp 5W');
  });

  it('leaves room for the title suffix the theme adds and does not add the shop name twice', () => {
    const r = res({ title: 'Insulated Steel Water Bottle 750 ml with Leak Proof Lid for Office, Gym and Travel' });
    const fields = buildFields({ res: r, shopName: 'DeoDap', siteHost: 'deodap.test', pageH1s: [r.title], h1Basis: 'crawl', row: { url: 'https://deodap.test/products/steel-bottle', status: 200, title: `${r.title} – DeoDap` } as never });
    const t = fields.find((f) => f.key === 'seoTitle')!;
    expect(t.proposed.length + ' – DeoDap'.length).toBeLessThanOrEqual(60);
    expect(t.proposed).not.toMatch(/DeoDap/);
    expect(t.reason).toMatch(/theme adds/);
  });

  it('marks a suggestion for review when it would drop a store keyword', () => {
    const r = res();
    const long = 'Leak Proof Insulated Office and Gym Companion Flask for Daily Use – steel water bottle';
    const s = suggestText('seoTitle', long, assessSeoField('seoTitle', long), ctx(r));
    expect(s.confidence).toBe('review');
    expect(s.reason).toMatch(/keyword “steel water bottle”/);
  });

  it('cleans tags without adding any', () => {
    const fields = buildFields({ res: res({ tags: ['kitchen', 'Kitchen', ' ', 'bottle'] }), siteHost: 'x', pageH1s: [], h1Basis: 'crawl' });
    expect(fields.find((f) => f.key === 'tags')!).toMatchObject({ proposed: 'kitchen, bottle', include: true });
  });
});
