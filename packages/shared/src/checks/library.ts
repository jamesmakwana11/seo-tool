import type { CheckDefinition } from '../types';

/**
 * Complete check library transcribed from seotooldocs.pdf §4–§10.
 * One entry per table row. `pdfRef.page` is the PDF page where the row appears.
 *
 * Owner team follows PDF §11.1a: theme/Liquid/app/server → development;
 * copy, metadata, FAQs, briefs → content; strategy, schema decisions,
 * redirects, links, keyword work → seo.
 */
export const CHECKS: CheckDefinition[] = [
  // ---------------------------------------------------------------- 4.1
  {
    id: 'TECH-ROBOTS', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Robots.txt monitor',
    detects: "Any change vs. yesterday's robots.txt snapshot; accidental Disallow of /collections/, /products/, /blogs/; blocked CSS/JS.",
    defaultSeverityText: 'Critical on change affecting indexable paths', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-NOINDEX', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Noindex sweep',
    detects: 'New noindex meta or X-Robots-Tag on previously indexed URLs.',
    defaultSeverityText: 'Critical (Tier 1–2)', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-INDEX-COVERAGE', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Index coverage delta',
    detects: 'GSC: pages dropping from "Indexed" to "Crawled – not indexed" / "Discovered – not indexed"; spikes in excluded pages.',
    defaultSeverityText: 'Critical if >2% of indexed pages drop in 24h', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['gsc'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'TECH-SITEMAP', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Sitemap integrity',
    detects: 'XML sitemap reachable, valid, <50k URLs per file, no 404/redirected/noindexed URLs inside it, lastmod accuracy, sitemap vs. crawl orphan diff.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'TECH-ORPHAN', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Orphan pages',
    detects: 'Indexable URLs receiving no internal links (found only via sitemap/GSC).',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['crawler', 'gsc'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'TECH-CRAWL-DEPTH', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Crawl depth',
    detects: 'Any Tier 1–2 page deeper than 3 clicks from homepage.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'TECH-CRAWL-BUDGET', module: 'technical', group: '4.1 Crawlability & Indexability', name: 'Crawl budget waste',
    detects: 'Parameterized/faceted URLs (?sort_by=, ?page=, filter combinations) getting crawled and indexed; Shopify collection tag pages (/collections/x/tag) creating near-duplicates.',
    defaultSeverityText: 'Medium, Critical if indexed duplicates >500', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 4, section: '4.1' }, dataSources: ['crawler', 'gsc'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 4.2
  {
    id: 'TECH-4XX', module: 'technical', group: '4.2 Response Codes, Redirects & Links', name: '4xx sweep',
    detects: 'New 404/410s, especially on URLs with backlinks or internal links; soft 404s; 429 (Too Many Requests) responses — including 429s served to Googlebot/Bingbot by rate-limiting or bot-protection apps.',
    defaultSeverityText: 'Critical if Tier 1, has backlinks, or 429s hit search-engine crawlers; else Medium', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 4, section: '4.2' }, dataSources: ['crawler', 'backlinks'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'TECH-5XX', module: 'technical', group: '4.2 Response Codes, Redirects & Links', name: '5xx & timeout monitor',
    detects: 'Server errors, response time >3s at server level.',
    defaultSeverityText: 'Critical', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 5, section: '4.2' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-REDIRECTS', module: 'technical', group: '4.2 Response Codes, Redirects & Links', name: 'Redirect audit',
    detects: '302s that should be 301, redirect chains (>1 hop), redirect loops, redirects to 404.',
    defaultSeverityText: 'Medium; Critical for chains on Tier 1', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 5, section: '4.2' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'TECH-BROKEN-INTERNAL', module: 'technical', group: '4.2 Response Codes, Redirects & Links', name: 'Broken internal links',
    detects: 'Every internal <a href> resolving to non-200.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 5, section: '4.2' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'TECH-BROKEN-OUTBOUND', module: 'technical', group: '4.2 Response Codes, Redirects & Links', name: 'Broken outbound links',
    detects: 'External links to dead pages (trust/UX signal).',
    defaultSeverityText: 'Low', issueClass: 'low', cadence: 'daily',
    pdfRef: { page: 5, section: '4.2' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'TECH-DISCONTINUED', module: 'technical', group: '4.2 Response Codes, Redirects & Links', name: 'Discontinued-product handling',
    detects: 'Shopify products set to draft/deleted leaving live 404s instead of 301 to parent collection.',
    defaultSeverityText: 'Medium (auto-suggests redirect target)', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 5, section: '4.2' }, dataSources: ['crawler', 'shopify'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 4.3
  {
    id: 'TECH-CANONICAL', module: 'technical', group: '4.3 Canonicals & Duplication', name: 'Canonical validity',
    detects: 'Missing, self-conflicting, canonicals pointing to redirects/404s/noindexed URLs; canonical vs. og:url mismatch.',
    defaultSeverityText: 'Critical if template-wide', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 5, section: '4.3' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-SHOPIFY-DUP-PATHS', module: 'technical', group: '4.3 Canonicals & Duplication', name: 'Shopify duplicate paths',
    detects: '/collections/{c}/products/{p} vs /products/{p} canonicalization correctness (a classic Shopify issue).',
    defaultSeverityText: 'Critical if broken', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 5, section: '4.3' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-DUPLICATE', module: 'technical', group: '4.3 Canonicals & Duplication', name: 'Duplicate content',
    detects: 'Near-duplicate titles/descriptions/body across products (variant-style listings and reseller copy); duplicate H1s.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 5, section: '4.3' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'TECH-THIN', module: 'technical', group: '4.3 Canonicals & Duplication', name: 'Thin content',
    detects: 'Indexable pages <150 words of unique content (collection pages with zero description are the usual offenders).',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 6, section: '4.3' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'TECH-HOST', module: 'technical', group: '4.3 Canonicals & Duplication', name: 'www / protocol / trailing-slash',
    detects: 'Only one canonical host resolving 200; others 301.',
    defaultSeverityText: 'Critical if split', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 6, section: '4.3' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 4.4
  {
    id: 'PERF-CRUX', module: 'performance', group: '4.4 Performance & Core Web Vitals', name: 'CrUX field data',
    detects: 'LCP >2.5s, INP >200ms, CLS >0.1 at origin and per-template (home, collection, product).',
    defaultSeverityText: 'Critical if "Poor" on any template; Medium if "Needs improvement"', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 6, section: '4.4' }, dataSources: ['crux'], ownerTeam: 'development', crawlerEvaluable: false,
  },
  {
    id: 'PERF-PSI', module: 'performance', group: '4.4 Performance & Core Web Vitals', name: 'Lab PSI runs',
    detects: 'Daily mobile+desktop PSI on homepage, top 5 collections, top 5 products; regression >10 points vs. 7-day average.',
    defaultSeverityText: 'Medium (regression alert)', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 6, section: '4.4' }, dataSources: ['psi'], ownerTeam: 'development', crawlerEvaluable: false,
  },
  {
    id: 'PERF-RENDER-BLOCKING', module: 'performance', group: '4.4 Performance & Core Web Vitals', name: 'Render-blocking & app bloat',
    detects: 'New render-blocking scripts — on Shopify almost always a newly installed app; the tool diffs the script list daily and names the app.',
    defaultSeverityText: 'Medium, Critical if LCP degrades >0.5s', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 6, section: '4.4' }, dataSources: ['crawler', 'crux'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'PERF-IMAGES', module: 'performance', group: '4.4 Performance & Core Web Vitals', name: 'Image weight',
    detects: 'Images >200KB, not WebP/AVIF, missing lazy-load, missing width/height (CLS), oversized hero images.',
    defaultSeverityText: 'Medium (Tier 1), Low (Tier 3)', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 6, section: '4.4' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'PERF-THIRD-PARTY', module: 'performance', group: '4.4 Performance & Core Web Vitals', name: 'Third-party payload',
    detects: 'Total JS/third-party bytes per template, trend line.',
    defaultSeverityText: 'Medium on upward trend >15%/week', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 6, section: '4.4' }, dataSources: ['crawler', 'psi'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 4.5
  {
    id: 'TECH-HTTPS', module: 'technical', group: '4.5 Security, Mobile & Rendering', name: 'HTTPS & certificate',
    detects: 'Cert expiry <21 days, mixed content, HSTS.',
    defaultSeverityText: 'Critical', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 6, section: '4.5' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-MOBILE', module: 'technical', group: '4.5 Security, Mobile & Rendering', name: 'Mobile usability',
    detects: 'Viewport, tap-target, font-size, content-wider-than-screen failures (crawler renders at 390px).',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 6, section: '4.5' }, dataSources: ['renderer'], ownerTeam: 'development', crawlerEvaluable: false,
  },
  {
    id: 'TECH-JS-RENDER', module: 'technical', group: '4.5 Security, Mobile & Rendering', name: 'JS rendering diff',
    detects: 'Content/links present in rendered DOM but absent in raw HTML (menus, product grids injected by apps) — flags reliance on client-side rendering.',
    defaultSeverityText: 'Medium; Critical if primary content/links only render client-side', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 7, section: '4.5' }, dataSources: ['crawler', 'renderer'], ownerTeam: 'development', crawlerEvaluable: false,
  },
  {
    id: 'TECH-PAGINATION', module: 'technical', group: '4.5 Security, Mobile & Rendering', name: 'Pagination',
    detects: '?page=N handling: self-canonical + indexable follow pattern; no canonical-to-page-1 mistakes; reasonable pagination depth.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 7, section: '4.5' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 4.6
  {
    id: 'TECH-SCHEMA-PRESENCE', module: 'technical', group: '4.6 Structured Data', name: 'Schema presence by template',
    detects: 'Product (with offers, price, availability, aggregateRating), BreadcrumbList, Organization, WebSite+SearchAction, CollectionPage/ItemList, FAQPage, Article on blog.',
    defaultSeverityText: 'Medium if missing', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 7, section: '4.6' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-SCHEMA-ERRORS', module: 'technical', group: '4.6 Structured Data', name: 'Schema errors',
    detects: 'GSC rich-result errors + inline validation (missing required fields, price mismatch vs. visible price, review markup without visible reviews).',
    defaultSeverityText: 'Critical (errors risk rich-result loss / manual action), Medium (warnings)', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 7, section: '4.6' }, dataSources: ['crawler', 'gsc'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'TECH-SCHEMA-SYNC', module: 'technical', group: '4.6 Structured Data', name: 'Schema guideline sync (monthly)',
    detects: "Monitors Google's structured-data documentation changelog and Search Central announcements monthly, diffs against live markup: newly deprecated types/rich results, newly required/recommended fields on used types, property renames/format changes. Each change → Fix Card with exact Liquid/JSON-LD update.",
    defaultSeverityText: 'Medium; Critical if a type in use is deprecated or a newly required field is missing', issueClass: 'medium', cadence: 'monthly',
    pdfRef: { page: 7, section: '4.6' }, dataSources: ['google_docs_feed', 'crawler'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'TECH-RICH-COVERAGE', module: 'technical', group: '4.6 Structured Data', name: 'Rich result coverage delta',
    detects: 'GSC: drop in valid rich-result items >5% day-over-day.',
    defaultSeverityText: 'Critical', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 7, section: '4.6' }, dataSources: ['gsc'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  // ---------------------------------------------------------------- 5
  {
    id: 'CONT-QA-GATE', module: 'content', group: '5 Content Audit', name: 'New-page QA gate',
    detects: 'Every newly published product/collection/blog is audited within 24h against the full on-page checklist before it accumulates bad history.',
    defaultSeverityText: 'Report section', issueClass: 'report', cadence: 'on_publish',
    pdfRef: { page: 8, section: '5' }, dataSources: ['crawler', 'shopify'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'CONT-QUALITY', module: 'content', group: '5 Content Audit', name: 'Content quality score',
    detects: 'Per-page score (0–100): uniqueness, depth vs. top-10 SERP average word count, readability, media use, freshness.',
    defaultSeverityText: 'Medium if Tier 1–2 scores <50', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['crawler', 'backlinks'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'CONT-INTENT', module: 'content', group: '5 Content Audit', name: 'Search-intent mismatch',
    detects: 'Page ranking for queries whose SERP is dominated by a different page type (e.g. product page ranking for an informational query that needs a guide).',
    defaultSeverityText: 'Medium + content suggestion', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['gsc', 'backlinks'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'CONT-DECAY', module: 'content', group: '5 Content Audit', name: 'Content decay',
    detects: 'Pages with ≥20% organic-click decline over 28 days vs. prior 28 (GSC).',
    defaultSeverityText: 'Medium, Critical for Tier 1', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['gsc'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'CONT-FRESHNESS', module: 'content', group: '5 Content Audit', name: 'Freshness',
    detects: 'Tier 1 collections/blogs not updated in 180 days.',
    defaultSeverityText: 'Low→Medium', issueClass: 'low', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['shopify', 'crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'CONT-CANNIBAL', module: 'content', group: '5 Content Audit', name: 'Cannibalization',
    detects: 'Two+ URLs alternating rankings for the same query cluster (GSC query-URL analysis).',
    defaultSeverityText: 'Medium + consolidation suggestion', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['gsc'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'CONT-AI-RISK', module: 'content', group: '5 Content Audit', name: 'AI-content risk',
    detects: 'Pages that are pure boilerplate/spun text with no experience signals (E-E-A-T risk under helpful-content systems).',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['crawler', 'llm'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'CONT-PLAGIARISM', module: 'content', group: '5 Content Audit', name: 'Plagiarism/scraper check',
    detects: 'DeoDap descriptions duplicated from supplier feeds found verbatim on competitor sites — flags where DeoDap is not the canonical source.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 8, section: '5' }, dataSources: ['crawler', 'backlinks'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  // ---------------------------------------------------------------- 6.1
  {
    id: 'ONP-TITLE', module: 'onpage', group: '6.1 Metadata & structure', name: 'Title tags',
    detects: 'Missing, duplicate, >60 chars (truncation), <30 chars (wasted), missing primary keyword, missing brand pattern, template artifacts ("Untitled", raw Liquid variables).',
    defaultSeverityText: 'Medium; Critical if template-wide', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'ONP-META', module: 'onpage', group: '6.1 Metadata & structure', name: 'Meta descriptions',
    detects: "Missing, duplicate, >160/<70 chars, no CTA/USP (No MOQ, wholesale price, COD, fast shipping are DeoDap's CTR levers).",
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'ONP-H1', module: 'onpage', group: '6.1 Metadata & structure', name: 'H1',
    detects: 'Missing, multiple, duplicate across pages, H1 ≠ topic of title.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'ONP-HEADINGS', module: 'onpage', group: '6.1 Metadata & structure', name: 'Heading hierarchy',
    detects: 'Skipped levels, headings used for styling, zero H2s on long pages.',
    defaultSeverityText: 'Low', issueClass: 'low', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'ONP-BREADCRUMBS', module: 'onpage', group: '6.1 Metadata & structure', name: 'Breadcrumbs',
    detects: 'Visible breadcrumb + BreadcrumbList schema on every product/collection; matches actual hierarchy.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'ONP-IMAGES', module: 'onpage', group: '6.1 Metadata & structure', name: 'Image SEO',
    detects: 'Missing/empty/keyword-stuffed ALT; filenames like IMG_1234.jpg on Tier 1; missing product ALT pattern ({product} – {key attribute} – DeoDap).',
    defaultSeverityText: 'Medium (Tier 1), Low', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'ONP-OG', module: 'onpage', group: '6.1 Metadata & structure', name: 'Open Graph/Twitter',
    detects: 'Missing og:title/og:image (affects share CTR and some AI surfaces).',
    defaultSeverityText: 'Low', issueClass: 'low', cadence: 'daily',
    pdfRef: { page: 9, section: '6.1' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 6.2
  {
    id: 'ONP-TPL-HOME', module: 'onpage', group: '6.2 Template-level audits', name: 'Homepage template audit',
    detects: 'One clear H1; primary keyword coverage ("wholesale shopping India", "dropshipping products India" cluster); above-fold value proposition; links to all Tier 1 collections; Organization + WebSite schema; freshness block (new arrivals); internal-link count sanity (not 500+ links).',
    defaultSeverityText: 'Medium (per failed item); Critical if template-wide blocker', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.2' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'ONP-TPL-COLLECTION', module: 'onpage', group: '6.2 Template-level audits', name: 'Collection template audit',
    detects: 'Unique 200–400 word description (top + expandable bottom copy); H1 = collection keyword; filtered/sorted URLs canonicalized; subcollection interlinking; FAQ block; ItemList schema; first product row server-rendered.',
    defaultSeverityText: 'Medium (per failed item)', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.2' }, dataSources: ['crawler', 'renderer'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'ONP-TPL-PRODUCT', module: 'onpage', group: '6.2 Template-level audits', name: 'Product template audit',
    detects: 'Unique description (not supplier boilerplate); specification table; wholesale/bulk pricing clarity; Product schema completeness; reviews visible + marked up; related-products and "frequently bought together" links; Q&A section; shipping/return info; video where available.',
    defaultSeverityText: 'Medium (per failed item)', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 9, section: '6.2' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 6.3
  {
    id: 'ONP-KEYWORD-MAP', module: 'onpage', group: '6.3 Keyword targeting & CTR', name: 'Keyword map enforcement',
    detects: 'Every Tier 1–2 page has one assigned primary keyword; verifies presence in title/H1/URL/first 100 words and flags drift.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 10, section: '6.3' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'ONP-STRIKING', module: 'onpage', group: '6.3 Keyword targeting & CTR', name: 'Striking-distance queries',
    detects: 'Queries ranking positions 5–20 with meaningful impressions — the daily quick-win list.',
    defaultSeverityText: 'Opportunity (daily section)', issueClass: 'opportunity', cadence: 'daily',
    pdfRef: { page: 10, section: '6.3' }, dataSources: ['gsc'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'ONP-LOW-CTR', module: 'onpage', group: '6.3 Keyword targeting & CTR', name: 'Low-CTR alerts',
    detects: 'Queries ranking top 5 with CTR below position benchmark → rewrite title/description suggestion generated automatically.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 10, section: '6.3' }, dataSources: ['gsc'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'ONP-SERP-FEATURE', module: 'onpage', group: '6.3 Keyword targeting & CTR', name: 'SERP feature loss',
    detects: 'Lost featured snippet / sitelinks / rich results vs. yesterday.',
    defaultSeverityText: 'Medium; Critical for Tier 1 keyword', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 10, section: '6.3' }, dataSources: ['gsc', 'backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  // ---------------------------------------------------------------- 7.1
  {
    id: 'OFF-BACKLINKS', module: 'offpage', group: '7.1 Daily', name: 'New/lost backlinks',
    detects: 'Daily diff via Ahrefs/Semrush API; lost links from DR>40 domains flagged for reclamation.',
    defaultSeverityText: 'Medium (lost quality link)', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 10, section: '7.1' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-TOXIC', module: 'offpage', group: '7.1 Daily', name: 'Toxic-link spike',
    detects: 'Sudden influx of spammy referring domains (link-farm patterns, foreign-language spam, exact-match commercial anchors) — negative SEO early warning.',
    defaultSeverityText: 'Critical if >50 toxic domains/week', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 10, section: '7.1' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-ANCHOR', module: 'offpage', group: '7.1 Daily', name: 'Anchor-text distribution drift',
    detects: 'Over-optimization risk: exact-match commercial anchors exceeding ~15% of new links.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 10, section: '7.1' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-BRAND-MENTION', module: 'offpage', group: '7.1 Daily', name: 'Brand-mention monitor',
    detects: 'New unlinked mentions of "DeoDap" across web/news → outreach queue for link reclamation.',
    defaultSeverityText: 'Opportunity', issueClass: 'opportunity', cadence: 'daily',
    pdfRef: { page: 10, section: '7.1' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-REFDOMAINS', module: 'offpage', group: '7.1 Daily', name: 'Referring-domain trend',
    detects: '7/30-day trend of referring domains vs. top 3 competitors.',
    defaultSeverityText: 'Dashboard metric', issueClass: 'metric', cadence: 'daily',
    pdfRef: { page: 11, section: '7.1' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  // ---------------------------------------------------------------- 7.2
  {
    id: 'OFF-GAP', module: 'offpage', group: '7.2 Weekly deep-dive', name: 'Competitor backlink gap',
    detects: 'Domains linking to ≥2 top competitors but not DeoDap, sorted by DR × relevance → prioritized outreach list with suggested pitch angle per domain.',
    defaultSeverityText: 'Opportunity (weekly report)', issueClass: 'opportunity', cadence: 'weekly',
    pdfRef: { page: 11, section: '7.2' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-DIGITAL-PR', module: 'offpage', group: '7.2 Weekly deep-dive', name: 'Digital PR opportunity scan',
    detects: "Trending queries in DeoDap's niches (home, kitchen, toys, gadgets, festival/seasonal buying in India) where data-driven content could earn coverage; festival calendar surfaced 60 days ahead.",
    defaultSeverityText: 'Opportunity (weekly report)', issueClass: 'opportunity', cadence: 'weekly',
    pdfRef: { page: 11, section: '7.2' }, dataSources: ['backlinks', 'gsc'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-LOCAL', module: 'offpage', group: '7.2 Weekly deep-dive', name: 'Local citations & GBP',
    detects: 'NAP consistency across directories, Google Business Profile health, review velocity.',
    defaultSeverityText: 'Medium (inconsistency) / report', issueClass: 'medium', cadence: 'weekly',
    pdfRef: { page: 11, section: '7.2' }, dataSources: ['gbp'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'OFF-DISAVOW', module: 'offpage', group: '7.2 Weekly deep-dive', name: 'Disavow candidate list',
    detects: 'Maintained continuously, human-approved before any disavow submission.',
    defaultSeverityText: 'Governance list (human approval)', issueClass: 'report', cadence: 'continuous',
    pdfRef: { page: 11, section: '7.2' }, dataSources: ['backlinks'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  // ---------------------------------------------------------------- 8 AEO
  {
    id: 'AEO-ANSWER-BLOCK', module: 'aeo', group: '8 AEO', name: 'Answer-block coverage',
    detects: 'Tier 1–2 pages lacking a direct 40–60 word answer under a question-formatted H2 for their primary query.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 11, section: '8' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AEO-FAQ', module: 'aeo', group: '8 AEO', name: 'FAQ coverage & markup',
    detects: 'Collections/products missing FAQ blocks; FAQ present but no FAQPage schema; answers too long/vague for extraction.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 11, section: '8' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AEO-PAA', module: 'aeo', group: '8 AEO', name: 'PAA gap analysis',
    detects: '"People Also Ask" questions for target keywords not answered anywhere on the site → content brief auto-generated.',
    defaultSeverityText: 'Opportunity', issueClass: 'opportunity', cadence: 'weekly',
    pdfRef: { page: 11, section: '8' }, dataSources: ['backlinks', 'crawler'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'AEO-SNIPPET', module: 'aeo', group: '8 AEO', name: 'Featured-snippet targets',
    detects: 'Queries where DeoDap ranks 2–10 and a snippet exists → paragraph/list/table formatting suggestion per query.',
    defaultSeverityText: 'Opportunity', issueClass: 'opportunity', cadence: 'weekly',
    pdfRef: { page: 11, section: '8' }, dataSources: ['gsc', 'backlinks'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'AEO-EXTRACTABILITY', module: 'aeo', group: '8 AEO', name: 'Extractability score',
    detects: 'Per page: presence of definition sentences, comparison tables, numbered steps, spec tables — formats AI engines quote.',
    defaultSeverityText: 'Metric', issueClass: 'metric', cadence: 'daily',
    pdfRef: { page: 12, section: '8' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AEO-ENTITY', module: 'aeo', group: '8 AEO', name: 'Entity clarity',
    detects: 'Organization schema completeness (sameAs → social profiles, logo, founder, address), consistent brand description across site/profiles, Wikipedia/Wikidata presence gap.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'weekly',
    pdfRef: { page: 12, section: '8' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'AEO-AI-CRAWLERS', module: 'aeo', group: '8 AEO', name: 'AI-crawler access',
    detects: 'robots.txt / firewall not blocking GPTBot, Google-Extended, PerplexityBot, CCBot, Bingbot (deliberate policy decision surfaced, not silently assumed).',
    defaultSeverityText: 'Critical if unintentionally blocked', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 12, section: '8' }, dataSources: ['crawler'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'AEO-AI-VISIBILITY', module: 'aeo', group: '8 AEO', name: 'AI-visibility sampling',
    detects: 'Weekly: fixed panel of ~50 buyer-intent prompts run against major AI engines via API; logs whether DeoDap is mentioned/cited vs. competitors.',
    defaultSeverityText: 'Trend metric + Medium on losses', issueClass: 'metric', cadence: 'weekly',
    pdfRef: { page: 12, section: '8' }, dataSources: ['ai_engines'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  // ---------------------------------------------------------------- 9 GEO
  {
    id: 'GEO-EEAT', module: 'geo', group: '9 GEO', name: 'E-E-A-T surface audit',
    detects: 'About page depth, author bios on blog (real people, credentials), visible policies (shipping/returns/contact/phone), trust badges, review authenticity.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'weekly',
    pdfRef: { page: 12, section: '9' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'GEO-CITATION', module: 'geo', group: '9 GEO', name: 'Citation-worthiness',
    detects: 'Does the site publish anything an AI would cite? Original stats, price benchmarks, buying guides with unique data — gap flagged with content brief.',
    defaultSeverityText: 'Opportunity', issueClass: 'opportunity', cadence: 'weekly',
    pdfRef: { page: 12, section: '9' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'GEO-CLUSTER', module: 'geo', group: '9 GEO', name: 'Topic-cluster integrity',
    detects: 'Pillar → cluster internal-link graph per category; orphan cluster pages; missing pillars for high-volume topics.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'weekly',
    pdfRef: { page: 12, section: '9' }, dataSources: ['crawler', 'backlinks'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'GEO-SEMANTIC', module: 'geo', group: '9 GEO', name: 'Semantic coverage',
    detects: 'Per money page: entity/term coverage vs. top-ranking pages (TF-IDF/embedding comparison); missing subtopics listed.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'weekly',
    pdfRef: { page: 13, section: '9' }, dataSources: ['crawler', 'backlinks', 'llm'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'GEO-FRESHNESS', module: 'geo', group: '9 GEO', name: 'Freshness signals',
    detects: 'Visible "last updated" dates, dateModified schema, stale statistics detection.',
    defaultSeverityText: 'Low→Medium', issueClass: 'low', cadence: 'weekly',
    pdfRef: { page: 13, section: '9' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'GEO-BRAND-FACTS', module: 'geo', group: '9 GEO', name: 'Brand-authority signals',
    detects: 'Consistency of brand facts (founding, location, USPs) across site, GBP, LinkedIn, marketplaces; conflicting facts confuse knowledge graphs.',
    defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'weekly',
    pdfRef: { page: 13, section: '9' }, dataSources: ['crawler', 'gbp'], ownerTeam: 'seo', crawlerEvaluable: false,
  },
  {
    id: 'GEO-STRUCTURE', module: 'geo', group: '9 GEO', name: 'Content structure for retrieval',
    detects: 'Chunk-friendly formatting: descriptive H2/H3 every ~150–300 words, self-contained sections, summary boxes on long guides.',
    defaultSeverityText: 'Low', issueClass: 'low', cadence: 'weekly',
    pdfRef: { page: 13, section: '9' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  // ---------------------------------------------------------------- 10.1 AI compliance
  {
    id: 'AIC-01', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Scaled content abuse detector',
    detects: 'Bulk-published pages (many URLs/day) sharing near-identical AI phrasing, structure, or "fill-in-the-blank" patterns with only the product/keyword swapped.',
    policy: 'Spam policy: scaled content abuse', defaultSeverityText: 'Critical if >30 near-identical pages published in 7 days', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 13, section: '10.1' }, dataSources: ['crawler', 'shopify'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-02', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Unedited AI boilerplate scan',
    detects: 'Tell-tale unreviewed AI output: "As an AI language model…", "In conclusion, …" stacks, generic filler ("In today\'s fast-paced world"), placeholder text, repeated sentence rhythms, zero product-specific facts.',
    policy: 'Helpful content guidance: content must show effort, originality, and value-add', defaultSeverityText: 'Medium; Critical on Tier 1', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 14, section: '10.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-03', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Factual-accuracy / hallucination check',
    detects: 'AI-written claims contradicting structured product data (wrong material, size, wattage, count, "waterproof" not in specs), invented certifications or awards, fabricated statistics without a source.',
    policy: 'Misleading content / misrepresentation policies; Merchant Center misrepresentation rules', defaultSeverityText: 'Critical (product claims), Medium (blog claims)', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 14, section: '10.1' }, dataSources: ['crawler', 'shopify', 'llm'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-04', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'People-first value test',
    detects: "Per-page LLM evaluation against Google's helpful-content questions: original information? substantial value vs. SERP? would a reader feel satisfied? summary-of-other-pages-only content flagged.",
    policy: 'Helpful content self-assessment; "search-engine-first" content signals', defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 14, section: '10.1' }, dataSources: ['crawler', 'llm'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'AIC-05', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'E-E-A-T / experience-signal absence',
    detects: 'AI content with no first-hand experience markers where they matter — no real usage notes, photos, tester attribution on reviews/buying guides; anonymous authorship on advice content.',
    policy: 'E-E-A-T in Search Quality Rater Guidelines; product-reviews guidance', defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 14, section: '10.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-06', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Fake review & testimonial markup',
    detects: 'AI-generated or templated reviews, review schema without genuine user reviews behind it, incentivized-review patterns.',
    policy: 'Structured data spam policy; review-snippet guidelines', defaultSeverityText: 'Critical', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 14, section: '10.1' }, dataSources: ['crawler', 'shopify'], ownerTeam: 'development', crawlerEvaluable: true,
  },
  {
    id: 'AIC-07', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'YMYL caution gate',
    detects: 'AI-drafted claims touching health/safety (baby products, kitchen appliances, electrical goods — "BPA-free", "child-safe", "shockproof") without a verified source in product data.',
    policy: 'Higher E-E-A-T bar for YMYL-adjacent claims', defaultSeverityText: 'Critical — blocks publish in the QA gate, requires human sign-off', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 15, section: '10.1' }, dataSources: ['crawler', 'shopify'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-08', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Doorway-page pattern',
    detects: 'AI-generated near-duplicate location/keyword landing pages funnelling to the same destination.',
    policy: 'Spam policy: doorway pages', defaultSeverityText: 'Critical', issueClass: 'critical', cadence: 'daily',
    pdfRef: { page: 15, section: '10.1' }, dataSources: ['crawler'], ownerTeam: 'seo', crawlerEvaluable: true,
  },
  {
    id: 'AIC-09', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Keyword-stuffing & unnatural language',
    detects: 'Keyword density abuse, unnatural exact-match repetition typical of over-prompted AI copy.',
    policy: 'Spam policy: keyword stuffing', defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 15, section: '10.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-10', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Cross-site duplication',
    detects: 'AI content identical to supplier feeds or other marketplaces (DeoDap not the original source).',
    policy: 'Copied/unoriginal content signals', defaultSeverityText: 'Medium', issueClass: 'medium', cadence: 'daily',
    pdfRef: { page: 15, section: '10.1' }, dataSources: ['crawler', 'backlinks'], ownerTeam: 'content', crawlerEvaluable: false,
  },
  {
    id: 'AIC-11', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Disclosure & authorship hygiene',
    detects: 'Blog/advice content missing author attribution; where AI assistance is material to trust (e.g. "tested by our team" claims that are AI-written), flags the mismatch.',
    policy: 'Accurate authorship and honest presentation ("who, how, and why")', defaultSeverityText: 'Low → Medium', issueClass: 'low', cadence: 'daily',
    pdfRef: { page: 15, section: '10.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
  {
    id: 'AIC-12', module: 'ai_compliance', group: '10.1 Built-in compliance checks', name: 'Outdated-model artifacts',
    detects: 'Stale AI references ("as of 2023"), broken formatting (markdown asterisks rendered literally), prompt-leak fragments in published copy.',
    policy: 'Quality/effort signals', defaultSeverityText: 'Low', issueClass: 'low', cadence: 'daily',
    pdfRef: { page: 15, section: '10.1' }, dataSources: ['crawler'], ownerTeam: 'content', crawlerEvaluable: true,
  },
];

export const CHECKS_BY_ID: Record<string, CheckDefinition> = Object.fromEntries(CHECKS.map((c) => [c.id, c]));

export function getCheck(id: string): CheckDefinition {
  const c = CHECKS_BY_ID[id];
  if (!c) throw new Error(`Unknown check id: ${id}`);
  return c;
}

export const MODULE_LABELS: Record<import('../types').AuditModule, string> = {
  technical: 'Technical SEO',
  performance: 'Performance & CWV',
  content: 'Content',
  onpage: 'On-Page SEO',
  offpage: 'Off-Page SEO',
  aeo: 'AEO',
  geo: 'GEO',
  ai_compliance: 'AI Content Compliance',
};
