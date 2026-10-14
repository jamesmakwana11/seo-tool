/** Technical SEO sub-areas (PDF §4.1–§4.6). Performance (§4.4) is its own module and screen. */
export const TECH_GROUPS = [
  { slug: 'crawlability', prefix: '4.1', title: 'Crawlability & indexability', text: 'robots.txt, noindex sweep, index coverage, sitemap, orphans, crawl depth and budget.' },
  { slug: 'responses', prefix: '4.2', title: 'Response codes, redirects & links', text: '4xx/429, 5xx and timeouts, redirect chains, broken links, discontinued products.' },
  { slug: 'canonicals', prefix: '4.3', title: 'Canonicals & duplication', text: 'Canonical validity, Shopify duplicate paths, duplicate and thin content, host policy.' },
  { slug: 'performance', prefix: '4.4', title: 'Performance & Core Web Vitals', text: 'CrUX field data, daily PSI runs, render-blocking apps, images, third-party payload.' },
  { slug: 'security', prefix: '4.5', title: 'Security, mobile & rendering', text: 'HTTPS and certificate, mobile usability at 390px, JS rendering diff, pagination.' },
  { slug: 'structured-data', prefix: '4.6', title: 'Structured data', text: 'Schema presence by template, schema errors, monthly guideline sync, rich-result coverage.' },
] as const;

export type TechGroupSlug = (typeof TECH_GROUPS)[number]['slug'];
