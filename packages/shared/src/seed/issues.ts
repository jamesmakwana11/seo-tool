import type { AuditModule, DeltaState, Evidence, Issue, IssueStatus, PageTemplate, PageTier, SentinelConfig, SitePage, TeamId } from '../types';
import { getCheck } from '../checks/library';
import { classifySeverity, type SeverityContext } from '../rules/severity';
import { slaDueAt } from '../rules/sla';
import type { Catalog } from './catalog';
import { type Rng, addDays, addHours, pad } from './rng';

export interface IssueSpec {
  checkId: string;
  title: string;
  summary: string;
  impact: string;
  pages: SitePage[];
  extraUrls?: string[];
  template?: PageTemplate;
  ctx?: Partial<SeverityContext>;
  status?: IssueStatus;
  delta?: DeltaState;
  daysAgo?: number;
  occurrences?: number;
  evidence?: Omit<Evidence, 'id' | 'capturedAt' | 'source'>[];
  allocateTo?: TeamId;
  allocatedBy?: string;
  group?: string; // group key for template grouping
  key?: string;
}

/** DEMO issue scenarios. Each mirrors a check row in PDF §4–§10 with realistic DeoDap context. */
export function issueSpecs(cat: Catalog, r: Rng, now: Date): IssueSpec[] {
  const t1p = cat.products.filter((p) => p.tier === 1);
  const t2p = cat.products.filter((p) => p.tier === 2);
  const t3p = cat.products.filter((p) => p.tier === 3);
  const t1c = cat.collections.filter((p) => p.tier === 1);
  const t2c = cat.collections.filter((p) => p.tier === 2);
  const blogs = cat.blogs;
  const take = <T>(arr: T[], n: number, offset = 0): T[] => {
    if (!arr.length) return [];
    const out: T[] = [];
    for (let i = 0; i < Math.min(n, arr.length); i++) out.push(arr[(offset + i) % arr.length]);
    return out;
  };
  const mixProducts = (n: number, t1: number) => [...take(t1p, t1, r.int(0, 20)), ...take(t2p, n - t1, r.int(0, 40))];
  const bottlePages = cat.products.filter((p) => p.collectionHandle === 'water-bottles');
  const changeDate = addDays(now, -3).toISOString().slice(0, 10);
  const priceMismatchPages = [...new Map([...t1p.slice(0, 118), ...cat.products.filter((p) => p.tier !== 1).slice(0, 194)].map((p) => [p.url, p])).values()];

  return [
    {
      key: 'price-mismatch', checkId: 'TECH-SCHEMA-ERRORS', title: `Product schema price mismatch on ${priceMismatchPages.length} product pages`,
      summary: 'JSON-LD offers.price shows the pre-discount price while the visible price is discounted. Google flags this as misleading markup; price/rating rich results are at risk of removal.',
      impact: `${priceMismatchPages.filter((p) => p.tier <= 2).length} of the affected pages are Tier 1–2 with combined ~42k monthly impressions (DEMO figures).`,
      pages: priceMismatchPages,
      template: 'product', ctx: { isWarning: false }, status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [
        { kind: 'jsonld', label: 'Extracted JSON-LD (sample)', url: t1p[0]?.url, content: '{"@type":"Offer","price":"499.00","priceCurrency":"INR"}', data: { priceMismatch: true, changedAfter: changeDate } },
        { kind: 'html_snippet', label: 'Rendered visible price (sample)', url: t1p[0]?.url, content: '<span class="price-item--sale">₹349.00</span>' },
        { kind: 'note', label: 'Change correlation', content: `Mismatch first observed after the discount app update on ${changeDate}.` },
      ],
    },
    {
      key: 'catalog-404', checkId: 'TECH-4XX', title: '40 product URLs returning 404 after catalog cleanup',
      summary: '40 product URLs that were live yesterday now return 404. 6 are Tier 1 products and 11 have external backlinks.',
      impact: 'Tier 1 products returning 404 lose rankings and revenue immediately; backlinked URLs leak link equity.',
      pages: mixProducts(40, 6), template: 'product', ctx: { hasBacklinks: true }, status: 'ASSIGNED', delta: 'new', daysAgo: 1,
      allocateTo: 'seo', allocatedBy: 'emp-ritesh', occurrences: 4,
      evidence: [
        { kind: 'http_response', label: 'HTTP response (sample)', url: t1p[1]?.url, content: 'HTTP/2 404\ncontent-type: text/html; charset=utf-8\nx-shopid: 0000000 (DEMO)' },
        { kind: 'note', label: 'Shopify webhook correlation', content: '38 of 40 URLs match products/update webhooks setting status=draft in the last 24h.', data: { shopifyDraftedCount: 38 } },
      ],
    },
    {
      key: 'render-block', checkId: 'PERF-RENDER-BLOCKING', title: 'New render-blocking script from a wishlist app on all templates',
      summary: 'A new synchronous <script> in <head> appeared in today\'s script diff on home, collection and product templates.',
      impact: 'Lab LCP degraded by ~620ms on mobile product pages (DEMO).',
      pages: [cat.home, ...take(t1c, 3), ...take(t1p, 5)], template: 'product', ctx: { metric: 620 }, status: 'IN_PROGRESS', delta: 'new', daysAgo: 2,
      allocateTo: 'development', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'diff', label: 'Script-list diff vs yesterday', content: '+ <script src="https://cdn.wishlist-app.example/loader.js"></script>  (render-blocking, 148 KB)', data: { app: 'Wishlist Plus (DEMO app name)', scriptHost: 'cdn.wishlist-app.example' } }],
    },
    {
      key: 'noindex', checkId: 'TECH-NOINDEX', title: 'noindex added to 3 previously indexed collections',
      summary: 'Three Tier 2 collections that were indexed last week now return X-Robots-Tag: noindex.',
      impact: 'Collections drop from Google on the next crawl; combined ~6k monthly impressions (DEMO).',
      pages: take(t2c, 3), template: 'collection', status: 'FIXED', delta: 'unchanged', daysAgo: 3, allocateTo: 'development', allocatedBy: 'emp-neha',
      evidence: [{ kind: 'http_response', label: 'Response headers', url: t2c[0]?.url, content: 'HTTP/2 200\nx-robots-tag: noindex', data: { xRobotsTag: 'noindex' } }],
    },
    {
      key: 'cwv-poor', checkId: 'PERF-CRUX', title: 'Product template LCP "Poor" on mobile (CrUX p75 4.6s)',
      summary: 'CrUX field data for the product template on mobile shows LCP p75 = 4.6s (Poor), INP 240ms, CLS 0.08.',
      impact: 'Every product page shares this template; conversion and rankings suffer sitewide.',
      pages: take(t1p, 12), template: 'product', ctx: { cwvStatus: 'poor' }, status: 'IN_PROGRESS', delta: 'recurring', daysAgo: 4,
      allocateTo: 'development', allocatedBy: 'emp-ritesh', occurrences: 2,
      evidence: [{ kind: 'field_data', label: 'CrUX p75 (mobile, product template)', content: 'LCP 4.6s · INP 240ms · CLS 0.08', data: { lcpMs: 4600, inpMs: 240, cls: 0.08 } }],
    },
    {
      key: 'redirect-chains', checkId: 'TECH-REDIRECTS', title: '14 redirect chains (2–3 hops) from retired collections',
      summary: 'Old collection URLs redirect through 2–3 hops before reaching the destination.',
      impact: 'Equity leak and slower crawling on retired paths.', pages: take(t2c, 4, 5), extraUrls: Array.from({ length: 10 }, (_, i) => `https://deodap.in/collections/old-category-${i + 1}`),
      template: 'collection', ctx: { metric: 2 }, status: 'CLOSED', delta: 'resolved', daysAgo: 12, allocateTo: 'seo', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'http_response', label: 'Redirect trace', content: '/collections/old-category-1 → 301 → /collections/kitchen → 301 → /collections/kitchen-tools (200)' }],
    },
    {
      key: 'sitemap', checkId: 'TECH-SITEMAP', title: '27 non-200 URLs listed in sitemap_products_1.xml',
      summary: '27 sitemap entries return 404 or redirect; 4 carry noindex.', impact: 'Wastes crawl budget and lowers trust in lastmod.',
      pages: take(t3p, 27), template: 'product', status: 'NEW', delta: 'worsening', daysAgo: 1, occurrences: 2,
      evidence: [{ kind: 'metric', label: 'Sitemap scan', content: 'sitemap_products_1.xml: 4,812 URLs · 23 × 404 · 4 × noindex', data: { invalid: 27 } }],
    },
    {
      key: 'orphans', checkId: 'TECH-ORPHAN', title: '18 orphan product pages found only via sitemap',
      summary: 'Indexable product URLs with zero internal links.', impact: 'Low crawl frequency and no internal equity.',
      pages: take(t2p, 18, 60), template: 'product', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'note', label: 'Discovery source', content: 'Found in sitemap; 0 internal inlinks in the last full crawl.' }],
    },
    {
      key: 'depth', checkId: 'TECH-CRAWL-DEPTH', title: '9 Tier 2 collections deeper than 3 clicks',
      summary: 'Collections reachable only via paginated parents at depth 4–5.', impact: 'Reduced crawl priority for working pages.',
      pages: take(t2c, 9, 2), template: 'collection', status: 'ASSIGNED', delta: 'unchanged', daysAgo: 5, allocateTo: 'seo', allocatedBy: 'emp-karan',
      evidence: [{ kind: 'metric', label: 'Click depth', content: 'Depth 4: 6 URLs · Depth 5: 3 URLs' }],
    },
    {
      key: 'tag-pages', checkId: 'TECH-CRAWL-BUDGET', title: '340 collection tag/filter URLs crawled and indexed',
      summary: '/collections/x/tag and ?filter.* URLs are being crawled and 340 are indexed as near-duplicates.', impact: 'Crawl budget waste; index bloat.',
      pages: take(t1c, 5), extraUrls: Array.from({ length: 20 }, (_, i) => `https://deodap.in/collections/kitchen-tools/steel?page=${i + 1}`),
      template: 'collection', ctx: { metric: 340 }, status: 'NEW', delta: 'recurring', daysAgo: 2, occurrences: 3,
      evidence: [{ kind: 'metric', label: 'GSC indexed parameter URLs (DEMO)', content: '340 indexed · 2,140 crawled last 7 days' }],
    },
    {
      key: 'broken-internal', checkId: 'TECH-BROKEN-INTERNAL', title: '22 internal links pointing to 404s',
      summary: 'Menus and collection descriptions link to retired products.', impact: 'Wasted crawl and broken buyer journeys.',
      pages: take(t2c, 6, 10), template: 'collection', status: 'IN_PROGRESS', delta: 'unchanged', daysAgo: 3, allocateTo: 'seo', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'note', label: 'Linked from', content: 'Main menu → "Garden" (1), collection descriptions (17), blog bodies (4)' }],
    },
    {
      key: 'outbound', checkId: 'TECH-BROKEN-OUTBOUND', title: '11 broken outbound links in blog posts',
      summary: 'External references in older blog posts return 404.', impact: 'Minor trust/UX signal.',
      pages: take(blogs, 5), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 9,
      evidence: [{ kind: 'note', label: 'Dead targets', content: '11 external URLs return 404/410' }],
    },
    {
      key: 'discontinued', checkId: 'TECH-DISCONTINUED', title: '12 discontinued products leaving 404s instead of 301s',
      summary: 'Products drafted in Shopify without a redirect to their parent collection. Suggested targets attached.',
      impact: '4th time this pattern has occurred.', pages: take(t3p, 12, 30), template: 'product', status: 'NEW', delta: 'recurring', daysAgo: 1, occurrences: 4,
      evidence: [{ kind: 'note', label: 'Suggested redirect targets', content: 'Each URL → its parent collection (see table)', data: { shopifyDraftedCount: 12 } }],
    },
    {
      key: 'canonical', checkId: 'TECH-CANONICAL', title: '5 collections canonicalize to a redirected URL',
      summary: 'Canonical tags point to old handles that now 301.', impact: 'Google may ignore the canonical.',
      pages: take(t2c, 5, 20), template: 'collection', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'html_snippet', label: 'Canonical (sample)', content: '<link rel="canonical" href="https://deodap.in/collections/kitchen-old">' }],
    },
    ...['Kitchen Tools', 'Toys & Games', 'Home Decor', 'Electronics Gadgets'].map((catName, i) => ({
      key: `schema-group-${i}`, group: 'offers-missing', checkId: 'TECH-SCHEMA-PRESENCE',
      title: `Product schema missing "offers" on ${catName} products`,
      summary: `Product JSON-LD on ${catName} products lacks offers (price, availability).`, impact: 'Not eligible for price rich results.',
      pages: cat.products.filter((p) => p.collectionHandle === catName.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 25),
      template: 'product' as PageTemplate, status: 'NEW' as IssueStatus, delta: 'new' as DeltaState, daysAgo: 1,
      evidence: [{ kind: 'jsonld' as const, label: 'JSON-LD (sample)', content: '{"@type":"Product","name":"…","sku":"…"}  // no "offers"' }],
    })),
    {
      key: 'thin', checkId: 'TECH-THIN', title: '7 collections with zero description (<150 words unique)',
      summary: 'Collection pages render only the product grid.', impact: 'Nothing for Google to rank beyond product names.',
      pages: take(t2c, 7, 25), template: 'collection', status: 'ASSIGNED', delta: 'unchanged', daysAgo: 4, allocateTo: 'content', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'metric', label: 'Unique word count', content: '0–42 words on all 7 URLs' }],
    },
    {
      key: 'dup-titles', checkId: 'TECH-DUPLICATE', title: '36 products with near-duplicate titles and descriptions',
      summary: 'Variant-style listings share >90% identical copy.', impact: 'Pages compete with each other.',
      pages: take(t2p, 36, 100), template: 'product', status: 'NEW', delta: 'unchanged', daysAgo: 6,
      evidence: [{ kind: 'metric', label: 'Similarity', content: 'Mean Jaccard similarity 0.93 across 36 URLs' }],
    },
    {
      key: 'mobile', checkId: 'TECH-MOBILE', title: 'Spec tables overflow the 390px viewport on 6 product pages',
      summary: 'Content wider than screen detected at 390px.', impact: 'Mobile usability failure on product pages.',
      pages: take(t2p, 6, 150), template: 'product', status: 'NEW', delta: 'new', daysAgo: 1,
      evidence: [{ kind: 'screenshot', label: 'Render at 390px', content: 'Screenshot capture requires the headless renderer (DEMO placeholder).' }],
    },
    {
      key: 'js-menu', checkId: 'TECH-JS-RENDER', title: 'Mega-menu links only present after JavaScript rendering',
      summary: 'Main navigation is injected by an app; raw HTML has 4 menu links vs 86 rendered.', impact: 'Non-rendering crawlers miss most collection links.',
      pages: [cat.home], template: 'home', status: 'ASSIGNED', delta: 'unchanged', daysAgo: 5, allocateTo: 'development', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'diff', label: 'Raw vs rendered links', content: 'Raw HTML: 4 nav links · Rendered DOM: 86 nav links' }],
    },
    {
      key: 'pagination', checkId: 'TECH-PAGINATION', title: '?page=N canonicalizes to page 1 on 3 collections',
      summary: 'Paginated URLs point canonical to page 1.', impact: 'Deeper products hidden from Google.',
      pages: take(t1c, 3, 4), template: 'collection', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'html_snippet', label: 'Canonical on ?page=2', content: '<link rel="canonical" href="https://deodap.in/collections/kitchen-tools">' }],
    },
    {
      key: 'images', checkId: 'PERF-IMAGES', title: '48 images over 200KB on Tier 1 product pages',
      summary: 'Hero/product images served at full resolution without width parameters.', impact: 'Slower LCP on money pages.',
      pages: take(t1p, 20, 30), template: 'product', status: 'IN_PROGRESS', delta: 'unchanged', daysAgo: 3, allocateTo: 'development', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'metric', label: 'Image weight', content: '48 images · median 412KB · max 1.8MB' }],
    },
    {
      key: 'third-party', checkId: 'PERF-THIRD-PARTY', title: 'Third-party JS up 18% week-over-week on product template',
      summary: 'Third-party bytes grew from 612KB to 722KB.', impact: 'Compounding INP/LCP cost.',
      pages: take(t1p, 3), template: 'product', status: 'NEW', delta: 'worsening', daysAgo: 1,
      evidence: [{ kind: 'metric', label: 'Third-party bytes', content: '612KB → 722KB (+18%)' }],
    },
    {
      key: 'psi', checkId: 'PERF-PSI', title: 'Homepage mobile PSI dropped 12 points vs 7-day average',
      summary: 'PSI mobile 61 today vs 73 average.', impact: 'Regression alert.',
      pages: [cat.home], template: 'home', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'metric', label: 'PSI mobile', content: 'Today 61 · 7-day avg 73' }],
    },
    {
      key: 'schema-sync', checkId: 'TECH-SCHEMA-SYNC', title: 'Monthly guideline sync: Offer return-policy and shipping details recommended',
      summary: 'Google merchant-listing documentation recommends hasMerchantReturnPolicy and shippingDetails on Offer; live Product markup has neither. (DEMO changelog item — the real feed requires the guideline-sync source.)',
      impact: 'Ineligible for some merchant-listing enhancements.', pages: take(t1p, 10, 40), template: 'product', status: 'NEW', delta: 'new', daysAgo: 6,
      evidence: [{ kind: 'link', label: 'Source document', url: 'https://developers.google.com/search/docs/appearance/structured-data/merchant-listing', content: 'Google Search Central — Merchant listing structured data' }],
    },
    {
      key: 'content-quality', checkId: 'CONT-QUALITY', title: '6 Tier 1–2 product pages score below 50 for content quality',
      summary: 'Short descriptions, no media beyond one image, no spec table.', impact: 'Underperform top-10 SERP average depth.',
      pages: take(t1p, 6, 60), template: 'product', status: 'NEW', delta: 'new', daysAgo: 1,
      evidence: [{ kind: 'metric', label: 'Scores', content: '31, 38, 42, 44, 46, 48 (threshold 50)' }],
    },
    {
      key: 'decay', checkId: 'CONT-DECAY', title: 'Tier 1 collection lost 34% organic clicks (28d vs prior 28d)',
      summary: '"Kitchen Tools" clicks fell from 5,120 to 3,380.', impact: 'Highest-ROI refresh candidate.',
      pages: take(t1c, 1), template: 'collection', status: 'ASSIGNED', delta: 'worsening', daysAgo: 2, allocateTo: 'content', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'metric', label: 'GSC clicks (DEMO)', content: 'Prior 28d: 5,120 · Last 28d: 3,380 (−34%)' }],
    },
    {
      key: 'cannibal', checkId: 'CONT-CANNIBAL', title: 'Two URLs alternating for "wholesale kitchen products"',
      summary: 'A collection and a blog post swap positions 6–14 daily.', impact: 'Split clicks; neither ranks top 5.',
      pages: [t1c[0], blogs[1]].filter(Boolean) as SitePage[], status: 'NEW', delta: 'recurring', daysAgo: 3, occurrences: 2,
      evidence: [{ kind: 'metric', label: 'Query→URL history', content: '14 days: collection 8 days, blog 6 days' }],
    },
    {
      key: 'intent', checkId: 'CONT-INTENT', title: 'Product page ranking for an informational "how to choose" query',
      summary: 'SERP for "how to choose water bottle" is dominated by guides.', impact: 'A buying guide would win the click.',
      pages: take(bottlePages, 1), template: 'product', status: 'NEW', delta: 'new', daysAgo: 2,
      evidence: [{ kind: 'note', label: 'SERP composition (DEMO)', content: '8/10 results are blog/guide pages' }],
    },
    {
      key: 'freshness', checkId: 'CONT-FRESHNESS', title: '5 Tier 1 collections not updated in 180+ days',
      summary: 'Descriptions unchanged since early this year.', impact: 'Lost freshness signals on money pages.',
      pages: take(t1c, 5, 8), template: 'collection', status: 'NEW', delta: 'unchanged', daysAgo: 4,
      evidence: [{ kind: 'metric', label: 'Shopify updated_at', content: '186–240 days ago' }],
    },
    {
      key: 'plagiarism', checkId: 'CONT-PLAGIARISM', title: 'Supplier descriptions found verbatim on 2 competitor sites',
      summary: '9 product descriptions match competitor pages word-for-word.', impact: 'DeoDap may not be treated as the canonical source.',
      pages: take(t2p, 9, 200), template: 'product', status: 'NEW', delta: 'new', daysAgo: 2,
      evidence: [{ kind: 'text_passage', label: 'Matching passage', content: '"Made of high quality material, durable and long lasting, easy to use and clean…"' }],
    },
    {
      key: 'title-liquid', checkId: 'ONP-TITLE', title: 'Raw Liquid variable in titles of filtered collection URLs',
      summary: 'Titles render "{{ current_tags }} – DeoDap" on tag-filtered collections.', impact: 'Template-wide defect visible in SERPs.',
      pages: take(t1c, 4, 2), extraUrls: Array.from({ length: 27 }, (_, i) => `https://deodap.in/collections/home-decor/tag-${i + 1}`),
      template: 'collection', ctx: { templateWide: true }, status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'html_snippet', label: '<title> (sample)', content: '<title>{{ current_tags }} – DeoDap</title>' }],
    },
    {
      key: 'title-long', checkId: 'ONP-TITLE', title: '58 Tier 2 product titles longer than 60 characters',
      summary: 'Titles truncate in SERPs.', impact: 'Wasted SERP real estate.', pages: take(t2p, 58, 20), template: 'product', status: 'NEW', delta: 'unchanged', daysAgo: 5,
      evidence: [{ kind: 'metric', label: 'Title length', content: 'Median 74 chars, max 112' }],
    },
    {
      key: 'meta', checkId: 'ONP-META', title: '120 products missing meta descriptions',
      summary: 'Shopify falls back to the first description sentence, often a supplier line.', impact: 'Missed CTR levers (No MOQ, COD).',
      pages: [...take(t1p, 20, 80), ...take(t2p, 100, 50)], template: 'product', status: 'IN_PROGRESS', delta: 'unchanged', daysAgo: 4, allocateTo: 'content', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'metric', label: 'Missing', content: '120 URLs with no meta description' }],
    },
    {
      key: 'h1', checkId: 'ONP-H1', title: 'Multiple H1s on every collection page (logo wrapped in <h1>)',
      summary: 'Header logo uses <h1> on non-home templates, giving collections two H1s.', impact: 'Template-level heading defect.',
      pages: take(t1c, 10), template: 'collection', status: 'ASSIGNED', delta: 'unchanged', daysAgo: 3, allocateTo: 'development', allocatedBy: 'emp-neha',
      evidence: [{ kind: 'html_snippet', label: 'Header', content: '<h1 class="header__heading"><a href="/">DeoDap</a></h1>' }],
    },
    {
      key: 'headings', checkId: 'ONP-HEADINGS', title: 'Skipped heading levels on 14 blog posts',
      summary: 'H2 → H4 jumps.', impact: 'Hygiene.', pages: take(blogs, 14, 3), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 8,
      evidence: [{ kind: 'note', label: 'Outline sample', content: 'H1 › H2 › H4 › H4' }],
    },
    {
      key: 'breadcrumbs', checkId: 'ONP-BREADCRUMBS', title: 'BreadcrumbList does not match the visible breadcrumb on products',
      summary: 'Schema lists Home › Products › X; visible trail shows Home › Collection › X.', impact: 'Inconsistent hierarchy signal.',
      pages: take(t2p, 15, 300), template: 'product', status: 'NEW', delta: 'new', daysAgo: 2,
      evidence: [{ kind: 'jsonld', label: 'BreadcrumbList', content: '[Home, Products, …]' }],
    },
    {
      key: 'alt', checkId: 'ONP-IMAGES', title: 'Missing ALT text on 64 Tier 1 product images',
      summary: 'ALT empty or "IMG_xxxx".', impact: 'Image search + accessibility loss on money pages.',
      pages: take(t1p, 32, 100), template: 'product', status: 'IN_PROGRESS', delta: 'unchanged', daysAgo: 5, allocateTo: 'content', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'metric', label: 'ALT audit', content: '64 images · 51 empty · 13 filename-only' }],
    },
    {
      key: 'og', checkId: 'ONP-OG', title: 'og:image missing on blog articles',
      summary: 'Blog template omits og:image when no featured image.', impact: 'Share CTR.', pages: take(blogs, 9), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 10,
      evidence: [{ kind: 'html_snippet', label: 'Head', content: 'og:title present · og:image absent' }],
    },
    {
      key: 'tpl-home', checkId: 'ONP-TPL-HOME', title: 'Homepage does not link to 4 Tier 1 collections',
      summary: 'Homepage audit: 6/7 items pass; Tier 1 collection links incomplete.', impact: 'Money collections lose homepage equity.',
      pages: [cat.home], template: 'home', status: 'NEW', delta: 'new', daysAgo: 1,
      evidence: [{ kind: 'note', label: 'Checklist', content: '✓ H1 ✓ keyword coverage ✓ value prop ✗ Tier 1 links (16/20) ✓ Organization+WebSite ✓ new arrivals ✓ link count 212' }],
    },
    {
      key: 'tpl-collection', checkId: 'ONP-TPL-COLLECTION', title: 'FAQ block missing on 12 Tier 1 collections',
      summary: 'Collection audit fails the FAQ item.', impact: 'Lost AEO extraction surface.',
      pages: take(t1c, 12), template: 'collection', status: 'NEW', delta: 'unchanged', daysAgo: 4,
      evidence: [{ kind: 'note', label: 'Checklist', content: 'Description ✓ · H1 ✓ · canonical ✓ · interlinks ✓ · FAQ ✗ · ItemList ✓ · SSR first row ✓' }],
    },
    {
      key: 'tpl-product', checkId: 'ONP-TPL-PRODUCT', title: 'Specification table missing on 22 products',
      summary: 'Product audit fails the spec-table item.', impact: 'Weaker product understanding and trust.',
      pages: take(t2p, 22, 400), template: 'product', status: 'NEW', delta: 'unchanged', daysAgo: 3,
      evidence: [{ kind: 'note', label: 'Checklist', content: 'Spec table ✗ (22/22)' }],
    },
    {
      key: 'kw-map', checkId: 'ONP-KEYWORD-MAP', title: 'Primary keyword drifted out of H1 on 5 Tier 1 collections',
      summary: 'Assigned keyword missing from H1 after a merchandising rename.', impact: 'Relevance signal weakened.',
      pages: take(t1c, 5, 10), template: 'collection', status: 'NEW', delta: 'new', daysAgo: 1,
      evidence: [{ kind: 'note', label: 'Positions', content: 'Title ✓ · H1 ✗ · URL ✓ · first 100 words ✓' }],
    },
    {
      key: 'low-ctr', checkId: 'ONP-LOW-CTR', title: '4 top-5 queries with CTR below position benchmark',
      summary: 'E.g. "wholesale water bottles" at position 3 with 2.1% CTR (benchmark ~10%).', impact: 'Lost clicks without a ranking change.',
      pages: take(bottlePages, 2), template: 'product', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'metric', label: 'GSC (DEMO)', content: 'pos 3.1 · 18,400 impr · 2.1% CTR' }],
    },
    {
      key: 'serp-feature', checkId: 'ONP-SERP-FEATURE', title: 'Lost featured snippet for "dropshipping products india"',
      summary: 'Snippet held for 41 days, lost yesterday to a competitor guide.', impact: 'Tier 1 money keyword.',
      pages: [cat.home], template: 'home', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'note', label: 'SERP feature history (DEMO)', content: 'Featured snippet: held 41d → lost' }],
    },
    {
      key: 'lost-links', checkId: 'OFF-BACKLINKS', title: 'Lost 3 backlinks from DR>40 domains',
      summary: 'Links removed during a partner site redesign.', impact: 'Reclaimable equity.',
      pages: [cat.home, t1c[0]].filter(Boolean) as SitePage[], status: 'ASSIGNED', delta: 'new', daysAgo: 2, allocateTo: 'seo', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'note', label: 'Backlink diff (DEMO)', content: 'news-site.example (DR 58), blog.example (DR 44), directory.example (DR 41)' }],
    },
    {
      key: 'toxic', checkId: 'OFF-TOXIC', title: '23 new toxic referring domains this week',
      summary: 'Foreign-language spam domains with exact-match anchors.', impact: 'Below the 50/week critical threshold — monitor.',
      pages: [cat.home], status: 'NEW', delta: 'worsening', daysAgo: 1, ctx: { metric: 23 },
      evidence: [{ kind: 'metric', label: 'Toxic domains', content: '23 this week (threshold 50)' }],
    },
    {
      key: 'anchor', checkId: 'OFF-ANCHOR', title: 'Exact-match anchors at 17% of new links',
      summary: '"wholesale products india" anchors from 9 of 53 new links.', impact: 'Over-optimization risk.',
      pages: [cat.home], status: 'NEW', delta: 'new', daysAgo: 3,
      evidence: [{ kind: 'metric', label: 'Anchor distribution', content: 'Exact 17% · Branded 41% · URL 28% · Other 14%' }],
    },
    {
      key: 'nap', checkId: 'OFF-LOCAL', title: 'NAP inconsistent on 3 directories',
      summary: 'Old warehouse address on 3 citation sites.', impact: 'Local/brand trust.', pages: [cat.home], status: 'NEW', delta: 'unchanged', daysAgo: 6,
      evidence: [{ kind: 'note', label: 'Directories', content: 'Directory A, B, C list an outdated address (DEMO)' }],
    },
    {
      key: 'answer-block', checkId: 'AEO-ANSWER-BLOCK', title: '28 Tier 1–2 pages lack a direct answer block',
      summary: 'No question-formatted H2 with a 40–60 word answer.', impact: 'Not quotable by AI Overviews.',
      pages: [...take(t1c, 10), ...take(t2c, 18)], template: 'collection', status: 'NEW', delta: 'unchanged', daysAgo: 4,
      evidence: [{ kind: 'metric', label: 'Coverage', content: '28 of 64 Tier 1–2 collections lack an answer block' }],
    },
    {
      key: 'faq', checkId: 'AEO-FAQ', title: 'FAQ present but no FAQPage markup on 9 collections',
      summary: 'Visible FAQ without structured data; 3 answers exceed 120 words.', impact: 'Reduced extractability.',
      pages: take(t2c, 9, 30), template: 'collection', status: 'NEW', delta: 'new', daysAgo: 2,
      evidence: [{ kind: 'note', label: 'Markup', content: 'FAQ section found · FAQPage JSON-LD absent' }],
    },
    {
      key: 'entity', checkId: 'AEO-ENTITY', title: 'Organization schema missing sameAs, founder and address',
      summary: 'Only name + logo present.', impact: 'Weak entity clarity for knowledge graphs.', pages: [cat.home], template: 'home', status: 'NEW', delta: 'unchanged', daysAgo: 7,
      evidence: [{ kind: 'jsonld', label: 'Organization', content: '{"@type":"Organization","name":"DeoDap","logo":"…"}' }],
    },
    {
      key: 'ai-crawlers', checkId: 'AEO-AI-CRAWLERS', title: 'GPTBot blocked by bot-protection rule (not in AI-crawler policy)',
      summary: 'robots.txt allows GPTBot, but the firewall/bot app returns 403 to its user agent.', impact: 'DeoDap cannot be cited by ChatGPT browsing.',
      pages: [cat.home], template: 'home', ctx: { unintentional: true }, status: 'NEW', delta: 'new', daysAgo: 1,
      evidence: [{ kind: 'http_response', label: 'Response to GPTBot UA', content: 'HTTP/2 403 (bot-protection)' }],
    },
    {
      key: 'ai-vis', checkId: 'AEO-AI-VISIBILITY', title: 'DeoDap dropped out of answers for 4 buyer-intent prompts',
      summary: 'Weekly panel: mention rate fell from 34% to 28%.', impact: 'Competitors recommended instead.',
      pages: [cat.home], status: 'NEW', delta: 'worsening', daysAgo: 1,
      evidence: [{ kind: 'metric', label: 'AI panel (DEMO)', content: 'Mention rate 34% → 28%' }],
    },
    {
      key: 'eeat', checkId: 'GEO-EEAT', title: 'Blog posts have no named author or bio',
      summary: '24/24 posts by "DeoDap Team".', impact: 'Weak E-E-A-T on advice content.',
      pages: take(blogs, 10), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 9,
      evidence: [{ kind: 'note', label: 'Bylines', content: 'All posts: "DeoDap Team"' }],
    },
    {
      key: 'cluster', checkId: 'GEO-CLUSTER', title: 'Kitchen cluster: 6 posts do not link to the pillar',
      summary: 'Cluster interlink integrity 57%.', impact: 'Topical authority diluted.',
      pages: take(blogs, 6, 8), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 6,
      evidence: [{ kind: 'metric', label: 'Integrity', content: '8/14 links present (57%)' }],
    },
    {
      key: 'semantic', checkId: 'GEO-SEMANTIC', title: '"Water Bottles" collection missing 5 subtopics vs top rankers',
      summary: 'Missing: insulation duration, BPA testing, capacity guide, cleaning, bulk branding.', impact: 'Less complete than ranking pages.',
      pages: cat.collections.filter((c) => c.collectionHandle === 'water-bottles'), template: 'collection', status: 'NEW', delta: 'new', daysAgo: 5,
      evidence: [{ kind: 'note', label: 'Missing subtopics', content: 'insulation duration · BPA testing · capacity guide · cleaning · bulk branding' }],
    },
    {
      key: 'geo-fresh', checkId: 'GEO-FRESHNESS', title: 'Blog posts show no "last updated" date',
      summary: 'dateModified absent from Article schema.', impact: 'Weak freshness signal.', pages: take(blogs, 12), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 11,
      evidence: [{ kind: 'jsonld', label: 'Article', content: 'datePublished present · dateModified absent' }],
    },
    {
      key: 'brand-facts', checkId: 'GEO-BRAND-FACTS', title: 'Founding year differs between site and LinkedIn',
      summary: 'About page vs LinkedIn company page disagree (DEMO).', impact: 'Conflicting facts confuse knowledge graphs.',
      pages: [cat.pages.find((p) => p.path === '/pages/about-us') ?? cat.home], status: 'NEW', delta: 'unchanged', daysAgo: 8,
      evidence: [{ kind: 'note', label: 'Facts', content: 'Site: year A · LinkedIn: year B (DEMO values)' }],
    },
    {
      key: 'structure', checkId: 'GEO-STRUCTURE', title: 'Long guides without headings every 300 words',
      summary: '3 guides have 600+ word stretches without a heading.', impact: 'Poor chunking for retrieval.',
      pages: take(blogs, 3, 1), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 12,
      evidence: [{ kind: 'metric', label: 'Longest unbroken section', content: '640 / 710 / 820 words' }],
    },
    {
      key: 'aic-01', checkId: 'AIC-01', title: '34 near-identical water-bottle pages published in 5 days',
      summary: 'Same paragraph structure with only the product name swapped.', impact: 'Scaled content abuse risk.',
      pages: bottlePages.slice(0, 34), template: 'product', ctx: { metric: 34 }, status: 'ASSIGNED', delta: 'new', daysAgo: 1, allocateTo: 'content', allocatedBy: 'system',
      evidence: [{ kind: 'text_passage', label: 'Shared template', content: '"Stay hydrated in style with the {PRODUCT}. Whether you\'re a student or a professional, the {PRODUCT} is perfect for…"' }],
    },
    {
      key: 'aic-02', checkId: 'AIC-02', title: 'Unedited AI boilerplate on a Tier 1 product',
      summary: 'Contains "In today\'s fast-paced world" and "In conclusion," with no product facts.', impact: 'Helpful-content risk on a money page.',
      pages: take(t1p, 1, 7), template: 'product', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'text_passage', label: 'Offending passage', content: "In today's fast-paced world, every kitchen deserves the best. In conclusion, this chopper will elevate your kitchen experience." }],
    },
    {
      key: 'aic-03', checkId: 'AIC-03', title: '"Waterproof" claim not supported by product specs',
      summary: 'Description claims waterproof; Shopify spec metafield says "splash resistant".', impact: 'Merchant Center misrepresentation risk.',
      pages: cat.products.filter((p) => p.collectionHandle === 'electronics-gadgets').slice(0, 1), template: 'product', ctx: { isProductClaim: true }, status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'text_passage', label: 'Claim vs data', content: 'Copy: "100% waterproof" · Spec: "IPX4 splash resistant"' }],
    },
    {
      key: 'aic-05', checkId: 'AIC-05', title: 'Buying guide with no first-hand experience signals',
      summary: 'No photos, testing notes or named author.', impact: 'E-E-A-T gap.', pages: take(blogs, 1, 5), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 6,
      evidence: [{ kind: 'note', label: 'Signals', content: 'Photos 0 · tester attribution none · author anonymous' }],
    },
    {
      key: 'aic-06', checkId: 'AIC-06', title: 'AggregateRating markup on 8 products with no visible reviews',
      summary: 'Templated 4.8★ rating emitted by a theme snippet.', impact: 'Structured-data spam risk.',
      pages: take(t2p, 8, 250), template: 'product', status: 'VERIFIED', delta: 'resolved', daysAgo: 9, allocateTo: 'development', allocatedBy: 'emp-ritesh',
      evidence: [{ kind: 'jsonld', label: 'AggregateRating', content: '{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"120"}' }],
    },
    {
      key: 'aic-07', checkId: 'AIC-07', title: '"BPA-free" and "child-safe" claims without verified source (QA hold)',
      summary: 'New Kids Sipper Bottle page claims BPA-free and child-safe; no certificate in product data.', impact: 'Publish blocked in QA gate until human sign-off.',
      pages: cat.products.filter((p) => p.title.startsWith('Kids Sipper Bottle')).slice(0, 1), template: 'product', status: 'NEW', delta: 'new', daysAgo: 0,
      evidence: [{ kind: 'text_passage', label: 'Claims', content: '"100% BPA-free and child-safe for toddlers"' }],
    },
    {
      key: 'aic-09', checkId: 'AIC-09', title: 'Keyword density 6.2% for "wholesale toys" on a collection',
      summary: 'Exact-match phrase repeated 14 times in 225 words.', impact: 'Keyword-stuffing signal.',
      pages: cat.collections.filter((c) => c.collectionHandle === 'toys-games-wholesale'), template: 'collection', status: 'NEW', delta: 'new', daysAgo: 2,
      evidence: [{ kind: 'metric', label: 'Density', content: '6.2% (14 occurrences / 225 words)' }],
    },
    {
      key: 'aic-10', checkId: 'AIC-10', title: '5 descriptions identical to a marketplace listing',
      summary: 'Text matches a marketplace seller\'s listing verbatim.', impact: 'Copied-content signal.',
      pages: take(t2p, 5, 330), template: 'product', status: 'NEW', delta: 'new', daysAgo: 3,
      evidence: [{ kind: 'text_passage', label: 'Match', content: '"Premium quality product, best for daily use…"' }],
    },
    {
      key: 'aic-11', checkId: 'AIC-11', title: '"Tested by our team" claim on an AI-drafted guide without author',
      summary: 'Claim of testing with no named tester.', impact: 'Disclosure mismatch.', pages: take(blogs, 1, 12), template: 'blog_article', status: 'NEW', delta: 'new', daysAgo: 4,
      evidence: [{ kind: 'text_passage', label: 'Passage', content: '"We tested 12 bottles for a month…"' }],
    },
    {
      key: 'aic-12', checkId: 'AIC-12', title: 'Stale "as of 2023" reference and literal **asterisks**',
      summary: 'Leftover AI artifacts in published copy.', impact: 'Low-effort signal.', pages: take(t3p, 3, 5), template: 'product', status: 'NEW', delta: 'new', daysAgo: 2,
      evidence: [{ kind: 'text_passage', label: 'Artifacts', content: '"**Key Features:** As of 2023, this is the most popular…"' }],
    },
    {
      key: 'nai', checkId: 'TECH-NOINDEX', title: 'noindex on /pages/track-order',
      summary: 'Track-order page carries noindex.', impact: 'Intentional (account/utility page).',
      pages: [cat.pages.find((p) => p.path === '/pages/track-order') ?? cat.home], template: 'page', status: 'NOT_AN_ISSUE', delta: 'unchanged', daysAgo: 14,
      evidence: [{ kind: 'html_snippet', label: 'Meta', content: '<meta name="robots" content="noindex">' }],
    },
    {
      key: 'escalated', checkId: 'TECH-CANONICAL', title: 'og:url does not match canonical on 11 blog posts',
      summary: 'og:url includes ?view= parameter; canonical is clean.', impact: 'Mixed signals to crawlers and AI surfaces.',
      pages: take(blogs, 11, 2), template: 'blog_article', status: 'NEW', delta: 'unchanged', daysAgo: 9,
      evidence: [{ kind: 'html_snippet', label: 'Tags', content: 'canonical: /blogs/news/x · og:url: /blogs/news/x?view=amp' }],
    },
    {
      key: 'watch', checkId: 'ONP-BREADCRUMBS', title: 'Visible breadcrumb missing on blog articles',
      summary: 'Blog template has no breadcrumb.', impact: 'Weaker hierarchy for working pages.', pages: take(blogs, 10, 10), template: 'blog_article',
      status: 'ASSIGNED', delta: 'unchanged', daysAgo: 6, allocateTo: 'development', allocatedBy: 'emp-karan',
      evidence: [{ kind: 'note', label: 'Template', content: 'article.liquid renders no breadcrumb snippet' }],
    },
  ];
}

let issueCounter = 0;

export function buildIssue(spec: IssueSpec, cfg: SentinelConfig, now: Date, r: Rng): Issue {
  const check = getCheck(spec.checkId);
  const urls = [...spec.pages.map((p) => p.url), ...(spec.extraUrls ?? [])];
  const tiers: Record<PageTier, number> = { 1: 0, 2: 0, 3: 0 };
  for (const p of spec.pages) tiers[p.tier] += 1;
  tiers[3] += spec.extraUrls?.length ?? 0;
  const highestTier: PageTier = tiers[1] ? 1 : tiers[2] ? 2 : 3;
  const decision = classifySeverity({ checkId: spec.checkId, highestTier, affectsIndexablePaths: true, ...spec.ctx }, cfg);
  const detected = addHours(addDays(now, -(spec.daysAgo ?? 0)), -r.int(1, 5));
  const id = `ISS-${pad(++issueCounter)}`;
  const evidence: Evidence[] = (spec.evidence ?? []).map((e, i) => ({
    ...e, id: `${id}-ev${i + 1}`, capturedAt: detected.toISOString(), source: 'demo',
  }));
  if (!evidence.length) evidence.push({ id: `${id}-ev1`, kind: 'note', label: 'Detection', content: check.detects, capturedAt: detected.toISOString(), source: 'demo' });
  const module: AuditModule = check.module;
  return {
    id, checkId: spec.checkId, module, title: spec.title, summary: spec.summary,
    severity: decision.severity, severityRationale: decision.rationale,
    issueClass: check.issueClass === 'opportunity' ? 'opportunity' : decision.severity,
    status: spec.status ?? 'NEW', delta: spec.delta ?? 'new', template: spec.template,
    affectedUrls: urls, affectedCount: urls.length, highestTier, tierBreakdown: tiers,
    businessImpact: spec.impact, detectedAt: detected.toISOString(),
    firstSeenAt: addDays(detected, -((spec.occurrences ?? 1) - 1) * 14).toISOString(), lastSeenAt: addHours(now, -2).toISOString(),
    slaDueAt: slaDueAt(decision.severity, detected, cfg).toISOString(), occurrences: spec.occurrences ?? 1,
    recommendedTeam: check.ownerTeam, allocation: [], severityHistory: [], evidence, source: 'demo',
  };
}

export function resetIssueCounter() {
  issueCounter = 0;
}
