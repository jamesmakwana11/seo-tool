import { createHash } from 'node:crypto';
/**
 * Shopify-like fixture store served by node:http on a random loopback port. Templates mirror a Dawn-style theme:
 * home, 3 collections, 8 products, blog index + 2 articles, about/contact/shipping/returns pages, robots.txt, sitemap.xml.
 * `opts` is mutable: tests inject defects (or fix them) between crawls without restarting the server.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureOptions {
  /** Paths that get <meta name="robots" content="noindex">. */
  noindex: string[];
  /** Paths answering X-Robots-Tag: noindex. */
  xRobotsNoindex: string[];
  /** Product handles that are deleted (404) but still linked from their collection. */
  deletedProducts: string[];
  /** Paths whose <link rel=canonical> is removed. */
  missingCanonical: string[];
  /** Paths that all get the same title. */
  duplicateTitle: string[];
  /** Collection handles with no description copy. */
  thinCollections: string[];
  /** Path → long title override. */
  longTitle: string[];
  missingMeta: string[];
  multipleH1: string[];
  /** Product handles whose images lose their alt attribute. */
  missingAlt: string[];
  /** Product handles whose main image is a 300 KB JPEG. */
  largeImage: string[];
  /** Product handles whose main image answers 404. */
  brokenImages: string[];
  /** Every page shows the same decorative banner (alt="", no width / height); the homepage also a second URL of it. */
  sharedBanner: boolean;
  /** Host name in the site's own links; 'localhost' or another loopback address (127.0.0.2 …) gives a further distinct website. */
  host: string;
  /** Product handles whose Product JSON-LD has no offers. */
  noOffers: string[];
  /** Template-level bug: EVERY product's JSON-LD loses `offers`. */
  productTemplateNoOffers: boolean;
  /** Product handle → JSON-LD price that differs from the visible price. */
  priceMismatch: Record<string, string>;
  /** Product handles with aggregateRating markup but no visible reviews. */
  reviewMarkupWithoutReviews: string[];
  robotsDisallowCollections: boolean;
  robotsBlockGptBot: boolean;
  /** Product handles whose description contains unedited AI boilerplate. */
  aiBoilerplate: string[];
  /** Product handles claiming "BPA-free". */
  ymylClaim: string[];
  /** Adds a synchronous third-party-style script to <head> on product pages. */
  newHeadScriptOnProducts: boolean;
  /** Footer links to /pages/slow (timeout) and /pages/broken (500). */
  linkErrorRoutes: boolean;
  /** Delay of /pages/slow in ms. */
  slowMs: number;
  /** Footer link to /pages/internal, which redirects to the cloud metadata endpoint (SSRF probe). */
  ssrfRedirect: boolean;
  /** Footer link to a page that answers 200 with a malformed (unclosed, binary-ish) HTML body. */
  malformedPage: boolean;
  /** Sitemap lists an extra product page that no page links to. */
  orphanInSitemap: boolean;
  /** /collections/x/products/y pages canonicalize to themselves instead of /products/y. */
  scopedSelfCanonical: boolean;
  /** Paths answering 503 Service Unavailable (a temporary failure, not a removal). */
  unavailable: string[];
  /** Theme stylesheet version: above 1, base.css gets ?v=N and a different background colour (visual / asset changes). */
  themeVersion: number;
  /** Extra gallery images per product page (/cdn/img/<handle>-g<n>.webp), for Image Audit tests. */
  galleryImages: number;
  /** Image path → how many times it answers 429 (Retry-After: 1) before it answers normally. */
  limitImages: Record<string, number>;
  /** Every page shows a trust badge in the footer; these paths show the same badge a second time in a main-content section. */
  repeatedBadge: string[];
  /** Path → absolute URL on another website that it 302-redirects to (cross-site redirect tests). */
  offsiteRedirects: Record<string, string>;
  /** Products added to the store after the first crawl (handle; listed in the sitemap and in their collection). */
  newProducts: string[];
  /** Collections added after the first crawl (handle; listed in the sitemap and the navigation). */
  newCollections: string[];
  /** Path → sitemap <lastmod> override (a page edited in Shopify gets a new date). */
  lastmod: Record<string, string>;
}

export const defaultFixtureOptions = (): FixtureOptions => ({
  noindex: [], xRobotsNoindex: [], deletedProducts: [], missingCanonical: [], duplicateTitle: [], thinCollections: [], longTitle: [], missingMeta: [],
  multipleH1: [], missingAlt: [], largeImage: [], brokenImages: [], sharedBanner: false, host: '127.0.0.1', noOffers: [], productTemplateNoOffers: false, priceMismatch: {}, reviewMarkupWithoutReviews: [],
  robotsDisallowCollections: false, robotsBlockGptBot: false, aiBoilerplate: [], ymylClaim: [], newHeadScriptOnProducts: false, linkErrorRoutes: false,
  slowMs: 1500, ssrfRedirect: false, malformedPage: false, orphanInSitemap: false, scopedSelfCanonical: false, unavailable: [], themeVersion: 1, galleryImages: 0, limitImages: {}, repeatedBadge: [], offsiteRedirects: {}, newProducts: [], newCollections: [], lastmod: {},
});

interface Product { handle: string; name: string; price: number; collection: string; material: string; size: string; use: string; detail: string; more: string; review: string }
interface Collection { handle: string; name: string; blurb: string[] }

export const COLLECTIONS: Collection[] = [
  {
    handle: 'kitchen-tools', name: 'Kitchen Tools',
    blurb: [
      'Stock your shop with practical kitchen tools sourced directly from manufacturers in Rajkot and Ahmedabad. Every vegetable chopper, peeler and storage jar in this range is checked for finish, packing strength and carton labelling before it leaves our warehouse, so resellers receive goods that are ready to list.',
      'Retailers buy from this collection because there is no minimum order quantity: you can test a single piece of a new gadget, watch how it sells on your marketplace listing and then reorder by the carton at the slab price. Cash on delivery is available on most pin codes and dispatch normally happens within one working day.',
      'Bulk buyers often ask how we price this range. Slab discounts start at ten units of a single design, and prices already include GST, so the figure on the page is what you pay before shipping. For orders above one hundred units, our wholesale desk can arrange a dedicated pickup from the Rajkot warehouse within forty-eight hours.',
      'Popular picks include manual choppers with stainless blades, silicone spatulas rated for high heat, airtight grain containers and space-saving drawer organisers. Seasonal demand peaks before Diwali and the wedding season, so plan inventory roughly six weeks ahead of each festival.',
    ],
  },
  {
    handle: 'home-decor', name: 'Home Decor',
    blurb: [
      'Our home decor range covers fairy lights, artificial plants, wall hooks, cushion covers and festive torans that sell steadily throughout the year and spike sharply in October and November. Each listing shows the exact pack size, the carton quantity and the dimensions so you can compare landed cost against your marketplace fees.',
      'Dropshippers like this category because products are light, ship flat and rarely break in transit. We photograph every item on a plain background and in a styled room so you can reuse the images on Instagram, Meesho or your own Shopify store without extra shoots.',
      'Every decor SKU is photographed under warm and cool light so buyers can judge colour accurately, and we keep spare stock of fast movers through the festive peak. If an item is damaged in transit, record an unboxing video and our team ships a replacement within two working days without asking you to return the broken piece.',
      'Resellers who bundle decor with gifting items such as candles and photo frames usually see a higher order value during Raksha Bandhan and Diwali. Wholesale slab pricing applies automatically in the cart once you cross ten, fifty or one hundred units of the same design.',
    ],
  },
  {
    handle: 'toys', name: 'Toys',
    blurb: [
      'Educational toys, pull-back cars, building blocks and soft toys make up this collection, all chosen for strong repeat demand from small retailers and school stationery shops. Age suitability is written on every product page and on the retail box so customers can choose quickly.',
      'Because toys are an impulse purchase, we keep popular designs in stock all year and update the range before the summer holidays and the Christmas season. Mix and match designs freely: the wholesale price is based on total quantity in the cart, not on a single design.',
      'Safety matters with children\'s products, so each batch is checked for sharp edges, loose parts and paint quality before it is listed. Small parts warnings are printed on the box where relevant, and age labels follow the guidance on the retail packaging supplied by the manufacturer.',
      'Every toy ships in its original retail packaging with a barcode, which makes it easy to sell in physical stores as well as online. Our support team on WhatsApp can share live stock levels and carton photos before you place a bulk order.',
    ],
  },
];

export const PRODUCTS: Product[] = [
  { handle: 'vegetable-chopper', name: 'Manual Vegetable Chopper 5 Blade', price: 249, collection: 'kitchen-tools', material: 'food-safe ABS body with stainless steel blades', size: '900 ml bowl', use: 'chopping onions, tomatoes and green chillies in seconds', detail: 'The pull-cord mechanism spins five blades; ten pulls give a coarse chop and twenty a fine mince suitable for chutneys.', more: 'Resellers tell us the chopper is their most demonstrated item at weekly haats because a ten-second video of onions turning into an even dice sells it better than any description. The lid locks with a twist, the base has an anti-slip ring, and spare blade sets are stocked separately so customers come back for refills.', review: 'The pull cord still works smoothly after three months of daily use in my tiffin service.' },
  { handle: 'silicone-spatula-set', name: 'Silicone Spatula Set of 3', price: 199, collection: 'kitchen-tools', material: 'heat-resistant silicone over a steel core', size: '28 cm, 25 cm and 21 cm', use: 'scraping batter bowls and stirring non-stick pans', detail: 'Each head is moulded in one piece so dough never collects in a joint, and the set withstands temperatures up to 230 degrees.', more: 'Home bakers prefer this trio because the narrow spatula reaches jar corners, the medium one folds whipped cream without deflating it and the wide one lifts dosas cleanly. Colours rotate between teal, grey and coral each batch, so mention mixed colours in your listing to avoid returns.', review: 'Bakers in my Instagram community love the narrow one for scraping Nutella jars.' },
  { handle: 'airtight-container-1200', name: 'Airtight Grain Container 1200 ml', price: 149, collection: 'kitchen-tools', material: 'transparent PET with a locking lid', size: '1200 ml', use: 'storing rice, pulses and dry fruits', detail: 'Four side clips press a rubber gasket onto the rim, keeping moisture out during the monsoon months.', more: 'Kitchen-organisation sellers bundle six of these containers with printed labels as a pantry starter kit, which lifts order value well above a single unit. The square footprint stacks neatly on narrow shelves, and the clear body lets shoppers see stock levels at a glance.', review: 'Sold forty sets as a pantry combo during the monsoon sale; zero leakage complaints.' },
  { handle: 'led-fairy-lights-10m', name: 'LED Fairy Lights 10m Warm White', price: 179, collection: 'home-decor', material: 'copper wire with 100 micro LEDs', size: '10 metre string', use: 'decorating balconies, mandirs and party backdrops', detail: 'A USB plug runs the string from any phone charger or power bank, and eight flash modes are selected with a single button.', more: 'During Diwali week this string is reordered more than any other decor product in our catalogue, so place festive stock early. Customers also use it year-round for wedding mehendi décor, terrarium jars and photo walls, which keeps demand steady after the festival rush ends.', review: 'My Diwali stall sold out of these lights two days before Dhanteras.' },
  { handle: 'artificial-money-plant', name: 'Artificial Money Plant with Pot', price: 299, collection: 'home-decor', material: 'UV-treated polyester leaves in a ceramic-finish pot', size: '45 cm tall', use: 'adding greenery to offices and living rooms without watering', detail: 'Leaves are wired individually so you can shape the plant, and the colour stays fresh near sunny windows for many months.', more: 'Corporate gifting buyers order this plant in bulk for office openings because it needs no care and looks identical in every unit. The pot base is weighted with sand so it does not tip over on reception desks, and each plant ships in a rigid box that protects the leaves.', review: 'Gifted twenty-five of these at our new branch inauguration and they still look fresh.' },
  { handle: 'adhesive-wall-hooks', name: 'Adhesive Wall Hooks Pack of 10', price: 99, collection: 'home-decor', material: 'transparent acrylic with a waterproof adhesive pad', size: '6 cm hook, holds up to 3 kg', use: 'hanging keys, towels and kitchen ladles without drilling', detail: 'Peel the backing, press for thirty seconds and wait an hour before loading; the pad comes off cleanly with a hair dryer.', more: 'Renters buy these hooks because they leave no marks on painted walls, which makes them a reliable add-on product for any home-utility store. Suggest them alongside towel racks and key holders; shoppers often add two packs to reach the free-shipping threshold.', review: 'Holds my heavy kadai ladles without slipping even in the humid kitchen.' },
  { handle: 'pull-back-racing-car', name: 'Pull Back Racing Car Toy', price: 129, collection: 'toys', material: 'shatter-resistant plastic body with rubber tyres', size: '12 cm long', use: 'indoor play for children aged three and above', detail: 'Pull the car back a few inches, release it and the friction motor sends it across the room; no batteries are needed.', more: 'Stationery and gift shops keep these cars near the billing counter because parents add them as a last-minute treat. Four colours ship in every carton of forty-eight pieces, and the compact retail box fits easily on peg hooks or in return-gift hampers for birthday parties.', review: 'Perfect return gift for my son\'s birthday party, all the kids raced them in the hall.' },
  { handle: 'building-blocks-100', name: 'Building Blocks Set 100 Pieces', price: 349, collection: 'toys', material: 'smooth-edged plastic bricks in eight colours', size: '100 pieces with a storage bucket', use: 'developing motor skills and creativity in kids aged four to ten', detail: 'Bricks are compatible with most popular block brands, and the bucket lid doubles as a building base plate.', more: 'Play schools and activity centres order this set in quantity because the bucket keeps pieces together between sessions. Parents appreciate that the pieces are large enough for small hands yet detailed enough for older children building houses, vehicles and animals.', review: 'Our play school bought ten buckets and the bricks have survived a whole term of use.' },
];

export const ARTICLES = [
  {
    handle: 'how-to-start-dropshipping-in-india', title: 'How to Start Dropshipping in India in 2026', author: 'Priya Shah', bio: 'Priya Shah has run DeoDap\'s reseller onboarding team since 2019 and has helped over two thousand small sellers launch their first online store.', published: '2026-09-01', modified: '2026-09-28',
    sections: [
      ['What is dropshipping?', 'Dropshipping is a retail model where you list products online and the supplier ships each order directly to your customer, so you never hold stock. You earn the difference between your selling price and the wholesale price, minus marketplace fees and shipping, which makes it a low-risk way to test demand.'],
      ['How much money do you need to start?', 'Most of our resellers start with less than five thousand rupees: enough for a domain, a basic Shopify plan or a marketplace seller account, and a few sample pieces to photograph. Because there is no minimum order quantity, you only pay for products after your own customer has paid you, which keeps working capital low.'],
      ['Choosing your first products', 'We tested the top fifty products in our catalogue with a group of new sellers over three months. Kitchen gadgets and home decor converted best because they are light, cheap to ship and easy to explain in a short video. Avoid fragile glassware until your packing process is reliable.'],
    ],
  },
  {
    handle: 'diwali-gifting-guide-for-resellers', title: 'Diwali Gifting Guide for Resellers', author: 'Rahul Mehta', bio: 'Rahul Mehta manages seasonal buying at DeoDap and plans festive inventory with more than three hundred suppliers across Gujarat and Delhi.', published: '2026-08-20', modified: '2026-09-15',
    sections: [
      ['Which products sell best before Diwali?', 'Fairy lights, torans, diyas, gift hampers and dry-fruit boxes sell fastest in the six weeks before Diwali. In our experience the strongest week is the one before Dhanteras, when corporate gifting orders and household decoration overlap and marketplace traffic is at its peak.'],
      ['When should you order stock?', 'Place your first bulk order at least forty-five days before the festival so you can photograph products, publish listings and run ads before competitors. Reorder bestsellers weekly rather than buying everything at once, because courier capacity tightens in the final fortnight.'],
      ['Pricing festive bundles', 'Bundles of decor and gifting items raise average order value without discounting individual products. We found that a three-item bundle priced about fifteen percent below the separate prices converts best for first-time buyers on Instagram.'],
    ],
  },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface FixtureSite {
  url: string;
  origin: string;
  opts: FixtureOptions;
  requests: { method: string; path: string; ua: string }[];
  /** Paths answered 304 Not Modified (conditional requests). */
  notModified: string[];
  close(): Promise<void>;
  productUrls(): string[];
  collectionUrls(): string[];
}

export async function startFixtureSite(initial?: Partial<FixtureOptions>): Promise<FixtureSite> {
  const opts: FixtureOptions = { ...defaultFixtureOptions(), ...(initial ?? {}) };
  const titleCase = (h: string) => h.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const allCollections = (): Collection[] => [...COLLECTIONS, ...opts.newCollections.map((h) => ({ ...COLLECTIONS[0], handle: h, name: titleCase(h) }))];
  const allProducts = (): Product[] => [...PRODUCTS, ...opts.newProducts.map((h) => ({ ...PRODUCTS[0], handle: h, name: `${titleCase(h)} for Kitchen Use`, price: 299 }))];
  const requests: FixtureSite['requests'] = [];
  let origin = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    requests.push({ method: req.method ?? 'GET', path: `${u.pathname}${u.search}`, ua: String(req.headers['user-agent'] ?? '') });
    ifNoneMatch = typeof req.headers['if-none-match'] === 'string' ? req.headers['if-none-match'] : undefined;
    currentPath = `${u.pathname}${u.search}`;
    try {
      route(req, res, u);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e));
    }
  });
  server.keepAliveTimeout = 1000;

  /** Last request's If-None-Match (conditional requests: a matching ETag answers 304 without a body). */
  let ifNoneMatch: string | undefined;
  const send = (res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}, method = 'GET') => {
    const etag = status === 200 ? `"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"` : undefined;
    if (etag && ifNoneMatch === etag) {
      notModified.push(currentPath);
      res.writeHead(304, { etag });
      return res.end();
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)), ...(etag ? { etag } : {}), ...headers });
    res.end(method === 'HEAD' ? undefined : body);
  };
  let currentPath = '';
  const notModified: string[] = [];
  const redirect = (res: http.ServerResponse, status: number, to: string) => {
    res.writeHead(status, { location: to, 'content-length': '0' });
    res.end();
  };

  function layout(p: { path: string; title: string; description?: string; canonical?: string; h1: string; body: string; jsonld: unknown[]; ogType?: string; headExtra?: string }): string {
    const { path } = p;
    const title = opts.duplicateTitle.includes(path) ? 'Wholesale Products Online at Best Price | DeoDap' : opts.longTitle.includes(path) ? `${p.title} – Buy Wholesale Online in India with No MOQ, COD and Fast Shipping | DeoDap` : p.title;
    const canonical = opts.missingCanonical.includes(path) ? '' : `<link rel="canonical" href="${origin}${p.canonical ?? path}">`;
    const meta = opts.missingMeta.includes(path) || !p.description ? '' : `<meta name="description" content="${esc(p.description)}">`;
    const robots = opts.noindex.includes(path) ? '<meta name="robots" content="noindex,follow">' : '';
    const headScripts = [
      `<script src="/cdn/shop/t/1/assets/theme.js" defer></script>`,
      `<script src="/cdn/shop/t/1/assets/global.js" defer></script>`,
      ...(opts.newHeadScriptOnProducts && path.startsWith('/products/') ? ['<script src="/apps/upsell-pro/widget.js"></script>'] : []),
    ].join('\n');
    const errorLinks = (opts.linkErrorRoutes ? '<li><a href="/pages/slow">Track order</a></li><li><a href="/pages/broken">Bulk enquiry</a></li>' : '')
      + (opts.ssrfRedirect ? '<li><a href="/pages/internal">Internal</a></li>' : '')
      + (opts.malformedPage ? '<li><a href="/pages/malformed">Malformed</a></li>' : '');
    const extraH1 = opts.multipleH1.includes(path) ? `<h1>${esc(p.h1)} – Wholesale</h1>` : '';
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${meta}
${canonical}
${robots}
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:url" content="${origin}${p.canonical ?? path}">
<meta property="og:type" content="${p.ogType ?? 'website'}">
<meta property="og:image" content="${origin}/cdn/img/og-default.webp">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/cdn/shop/t/1/assets/base.css${opts.themeVersion > 1 ? `?v=${opts.themeVersion}` : ''}">
${headScripts}
${p.headExtra ?? ''}
${p.jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head><body>
<header class="header"><a href="/" class="header__heading-link">DeoDap</a>${opts.sharedBanner ? `<img src="/cdn/img/banner.webp?v=1" alt="">${path === '/' ? '<img src="/cdn/img/banner.webp?v=2" alt="Festive sale">' : ''}` : ''}
<nav class="header__menu" aria-label="Main"><ul>
<li><a href="/">Home</a></li>${allCollections().map((c) => `<li><a href="/collections/${c.handle}">${c.name}</a></li>`).join('')}<li><a href="/blogs/news">Blog</a></li>
</ul></nav></header>
<main id="MainContent">
<h1>${esc(p.h1)}</h1>${extraH1}
${p.body}${opts.repeatedBadge.includes(path) ? '\n<div id="shopify-section-template--1__trust"><div class="trust-badge"><img src="/cdn/img/secure-badge.webp" alt="Secure checkout"></div></div>' : ''}
</main>
<footer class="footer">${opts.repeatedBadge.length ? '<div id="shopify-section-sections--1__footer"><div class="footer__payment"><img src="/cdn/img/secure-badge.webp" alt=""></div></div>' : ''}<ul>
<li><a href="/pages/about-us">About us</a></li><li><a href="/pages/contact">Contact</a></li><li><a href="/pages/shipping-policy">Shipping policy</a></li><li><a href="/pages/return-policy">Return policy</a></li>${errorLinks}
</ul><p>Call us: <a href="tel:+919876543210">+91 98765 43210</a></p></footer>
</body></html>`;
  }

  const orgLd = () => ({
    '@context': 'https://schema.org', '@type': 'Organization', name: 'DeoDap', url: `${origin}/`, logo: `${origin}/cdn/img/logo.webp`,
    sameAs: ['https://www.instagram.com/deodap', 'https://www.facebook.com/deodap'], foundingDate: '2018',
    address: { '@type': 'PostalAddress', addressLocality: 'Rajkot', addressRegion: 'Gujarat', addressCountry: 'IN' },
  });
  const crumbs = (items: [string, string][]) => ({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${origin}${path}` })),
  });
  const visibleCrumbs = (items: [string, string][]) => `<nav class="breadcrumb" aria-label="Breadcrumb">${items.map(([n, pth]) => `<a href="${pth}">${esc(n)}</a>`).join(' / ')}</nav>`;

  function productHtml(p: Product, path: string, canonicalPath: string): string {
    const col = COLLECTIONS.find((c) => c.handle === p.collection)!;
    const jsonPrice = opts.priceMismatch[p.handle] ?? p.price.toFixed(2);
    const noOffers = opts.productTemplateNoOffers || opts.noOffers.includes(p.handle);
    const showReviews = !opts.reviewMarkupWithoutReviews.includes(p.handle);
    const product: Record<string, unknown> = {
      '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: `DD-${p.handle.toUpperCase()}`, brand: { '@type': 'Brand', name: 'DeoDap' },
      image: [`${origin}/cdn/img/${p.handle}.webp`], description: `${p.name} made of ${p.material}.`,
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.4', reviewCount: '2' },
    };
    if (!noOffers) product.offers = { '@type': 'Offer', price: jsonPrice, priceCurrency: 'INR', availability: 'https://schema.org/InStock', url: `${origin}/products/${p.handle}` };
    const imgName = opts.brokenImages.includes(p.handle) ? `missing-${p.handle}.webp` : opts.largeImage.includes(p.handle) ? 'big-photo.jpg' : `${p.handle}.webp`;
    const alt = opts.missingAlt.includes(p.handle) ? '' : ` alt="${esc(p.name)} – ${esc(p.material.split(' ')[0])} – DeoDap"`;
    const boiler = opts.aiBoilerplate.includes(p.handle) ? `<p>In today's fast-paced world, every kitchen deserves the best tools. Unlock the power of effortless cooking with this amazing product.</p>` : '';
    const ymyl = opts.ymylClaim.includes(p.handle) ? `<p>This product is completely BPA-free and safe for the whole family.</p>` : '';
    const idx = PRODUCTS.findIndex((x) => x.handle === p.handle);
    const related = [PRODUCTS[(idx + 1) % PRODUCTS.length], PRODUCTS[(idx + 2) % PRODUCTS.length]];
    const reviews = showReviews
      ? `<div class="reviews"><h2>Customer reviews</h2>
<div class="jdgm-rev"><p>${esc(p.review)}</p><span>– Meena, Surat</span></div>
<div class="jdgm-rev"><p>Ordered ${p.price > 200 ? 'twelve' : 'thirty'} units of the ${esc(p.size)} version and the carton matched the listing exactly.</p><span>– Arjun, Pune</span></div></div>`
      : '';
    return layout({
      path, canonical: canonicalPath, title: `${p.name} – Wholesale Price | DeoDap`, h1: p.name, ogType: 'product',
      description: `Buy ${p.name} at wholesale price with No MOQ. COD available and fast shipping across India from DeoDap.`,
      jsonld: [product, { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Can I order a single piece?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, there is no minimum order quantity.' } }] }, crumbs([['Home', '/'], [col.name, `/collections/${col.handle}`], [p.name, `/products/${p.handle}`]])],
      body: `${visibleCrumbs([['Home', '/'], [col.name, `/collections/${col.handle}`], [p.name, `/products/${p.handle}`]])}
<div class="product__media"><img src="/cdn/img/${imgName}"${alt} width="800" height="800">${Array.from({ length: opts.galleryImages }, (_, k) => `<img src="/cdn/img/${p.handle}-g${k + 1}.webp" alt="${esc(p.name)} view ${k + 2}" width="400" height="400" loading="lazy">`).join('')}</div>
<div class="product__info">
<div class="price"><span class="price-item price-item--regular">₹ ${p.price.toFixed(2)}</span></div>
<p>Wholesale slab pricing: 10+ units save 5%, 50+ units save 10%. No minimum order quantity.</p>
<div class="product__description rte">
<p>The ${esc(p.name)} is made of ${esc(p.material)} and measures ${esc(p.size)}. It is ideal for ${esc(p.use)}.</p>
<p>${esc(p.detail)}</p>
<p>${esc(p.more)}</p>
<h2>Who buys the ${esc(p.name)}?</h2>
<p>Most orders for the ${esc(p.name.toLowerCase())} come from resellers who need ${esc(p.use)} covered in their catalogue. Pair it with other ${esc(COLLECTIONS.find((c) => c.handle === p.collection)!.name.toLowerCase())} items, list the ${esc(p.size)} size clearly and mention the ${esc(p.material)} build in your first line, because shoppers compare those details before price. Restock alerts are available for this item.</p>
${boiler}${ymyl}
</div>
<h2>Specifications</h2>
<table class="specs"><tr><th>Material</th><td>${esc(p.material)}</td></tr><tr><th>Size</th><td>${esc(p.size)}</td></tr><tr><th>Pack of</th><td>1</td></tr></table>
<h2>Questions &amp; answers</h2>
<h3>Can I order a single piece?</h3><p>Yes, there is no minimum order quantity; slab discounts apply automatically.</p>
<h2>Shipping and returns</h2>
<p>Orders are dispatched within one working day. Delivery takes three to seven days depending on your pin code, and damaged items can be returned for a replacement within seven days of delivery.</p>
</div>
${reviews}
<div class="related-products"><h2>You may also like</h2>${related.map((r) => `<div class="product-card"><a href="/products/${r.handle}">${esc(r.name)}</a><span class="price">₹ ${r.price}</span></div>`).join('')}</div>`,
    });
  }

  function collectionHtml(c: Collection, path: string): string {
    const prods = allProducts().filter((p) => p.collection === c.handle);
    const deleted = opts.deletedProducts.filter((h) => !PRODUCTS.some((p) => p.handle === h));
    const extra = c.handle === 'toys' ? deleted : [];
    const desc = opts.thinCollections.includes(c.handle) ? '' : `<div class="collection-description rte">${c.blurb.map((b) => `<p>${esc(b)}</p>`).join('')}</div>`;
    // kitchen-tools uses collection-scoped product links (classic Shopify theme behaviour).
    const link = (h: string) => (c.handle === 'kitchen-tools' ? `/collections/${c.handle}/products/${h}` : `/products/${h}`);
    const others = COLLECTIONS.filter((x) => x.handle !== c.handle);
    return layout({
      path, title: `${c.name} Wholesale – Buy in Bulk Online | DeoDap`, h1: c.name,
      description: `Shop ${c.name.toLowerCase()} at wholesale price with No MOQ, COD and fast shipping across India. Bulk discounts for resellers.`,
      jsonld: [
        { '@context': 'https://schema.org', '@type': 'CollectionPage', name: c.name, url: `${origin}${path}` },
        { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: prods.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/products/${p.handle}` })) },
        crumbs([['Home', '/'], [c.name, path]]),
        { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [
          { '@type': 'Question', name: 'Is there a minimum order quantity?', acceptedAnswer: { '@type': 'Answer', text: 'No.' } },
          { '@type': 'Question', name: 'Do you offer cash on delivery?', acceptedAnswer: { '@type': 'Answer', text: 'Yes.' } },
        ] },
      ],
      body: `${visibleCrumbs([['Home', '/'], [c.name, path]])}
${desc}
<p><a href="${path}?sort_by=price-ascending">Sort by price</a></p>
<ul class="product-grid">${[...prods.map((p) => p.handle), ...extra].map((h) => {
        const p = allProducts().find((x) => x.handle === h);
        return `<li class="grid__item"><div class="card-wrapper product-card"><a href="${link(h)}">${esc(p?.name ?? h)}</a><span class="price">₹ ${p?.price ?? 199}</span></div></li>`;
      }).join('')}</ul>
<p>Explore more: ${others.map((o) => `<a href="/collections/${o.handle}">${o.name}</a>`).join(', ')}</p>
<h2>Frequently asked questions</h2>
<h3>Is there a minimum order quantity?</h3><p>No. You can order a single piece of any ${esc(c.name.toLowerCase())} product and switch to bulk slabs once it sells.</p>
<h3>Do you offer cash on delivery?</h3><p>Yes, cash on delivery is available on most pin codes in India for orders up to fifty thousand rupees.</p>`,
    });
  }

  function homeHtml(): string {
    return layout({
      path: '/', title: 'DeoDap – Wholesale Shopping & Dropshipping Products India', h1: 'Wholesale Shopping and Dropshipping Products in India',
      description: 'DeoDap is India\'s wholesale marketplace for resellers: No MOQ, wholesale price, COD and fast shipping on 5,000+ dropshipping products.',
      jsonld: [orgLd(), { '@context': 'https://schema.org', '@type': 'WebSite', name: 'DeoDap', url: `${origin}/`, potentialAction: { '@type': 'SearchAction', target: `${origin}/search?q={search_term_string}`, 'query-input': 'required name=search_term_string' } }],
      body: `<p class="hero">No MOQ wholesale prices on kitchen, home decor and toys — perfect for resellers and dropshipping stores across India.</p>
<h2>Shop by category</h2><ul>${allCollections().map((c) => `<li><a href="/collections/${c.handle}">${c.name}</a></li>`).join('')}</ul>
<h2>New arrivals</h2><ul>${PRODUCTS.slice(0, 4).map((p) => `<li><a href="/products/${p.handle}">${esc(p.name)}</a></li>`).join('')}</ul>
<h2>What is DeoDap?</h2><p>DeoDap is a wholesale marketplace where small retailers, resellers and dropshippers buy everyday products at factory prices with no minimum order quantity. Orders ship from our Rajkot warehouse within one working day, cash on delivery is available on most pin codes, and every product comes with reusable photos for your listings.</p>
<h2>Why resellers choose DeoDap</h2><p>We ship from our own warehouse in Rajkot, publish real product photos you can reuse, and support cash on delivery for your customers. Thousands of small sellers use DeoDap to run their dropshipping business without holding inventory.</p>
<h2>How ordering works</h2><p>Browse more than five thousand products, add any quantity to your cart and pay online or choose cash on delivery. We pack orders on camera, dispatch within one working day and share tracking on WhatsApp, so you can update your own customers in real time. GST invoices are issued for every order.</p>
<p><a href="/blogs/news">Read our reseller guides</a></p>`,
    });
  }

  function articleHtml(a: (typeof ARTICLES)[number], path: string): string {
    return layout({
      path, title: `${a.title} | DeoDap Blog`, h1: a.title, ogType: 'article',
      description: `${a.title}: practical advice for Indian resellers on products, pricing and stock planning.`,
      jsonld: [{ '@context': 'https://schema.org', '@type': 'Article', headline: a.title, author: { '@type': 'Person', name: a.author }, datePublished: a.published, dateModified: a.modified, publisher: { '@type': 'Organization', name: 'DeoDap' } }],
      body: `<p class="article__meta">By <span class="article__author">${esc(a.author)}</span> · Published <time datetime="${a.published}">${a.published}</time> · Last updated <time datetime="${a.modified}">${a.modified}</time></p>
${a.sections.map(([h, t]) => `<h2>${esc(h)}</h2><p>${esc(t)}</p>`).join('\n')}
<div class="author-bio"><p>${esc(a.bio)}</p></div>
<p>Related: <a href="/collections/home-decor">Home Decor</a> · <a href="/collections/kitchen-tools">Kitchen Tools</a></p>`,
    });
  }

  const PAGES: Record<string, { title: string; h1: string; body: string }> = {
    'about-us': {
      title: 'About DeoDap – Wholesale Marketplace for Resellers', h1: 'About DeoDap',
      body: `<p>DeoDap started in 2018 in Rajkot, Gujarat, as a small wholesale counter supplying kitchen gadgets to local shops. Today we run a 60,000 square foot warehouse and ship to more than nineteen thousand pin codes across India every week.</p>
<h2>What we do</h2><p>We buy directly from over three hundred manufacturers, inspect every batch, photograph each product in-house and sell at wholesale prices with no minimum order quantity. Resellers, dropshippers and small retailers use our catalogue to run their own online and offline stores without large upfront investment.</p>
<h2>Our team</h2><p>A team of one hundred and twenty people handles sourcing, quality checks, packing, customer support and reseller onboarding. Our support desk answers WhatsApp queries in Hindi, Gujarati and English from 9 AM to 7 PM, Monday to Saturday.</p>
<h2>Why sellers trust us</h2><p>Every order is packed on camera, returns for transit damage are accepted within seven days, and GST invoices are issued for every purchase so business customers can claim input credit. We publish real stock levels so you never sell what we cannot ship.</p>`,
    },
    contact: { title: 'Contact DeoDap – Wholesale Support Team', h1: 'Contact us', body: '<p>Email support@deodap.example or call +91 98765 43210, Monday to Saturday, 9 AM to 7 PM. Our warehouse is at Rajkot, Gujarat 360002.</p>' },
    'shipping-policy': { title: 'Shipping Policy – Delivery Times and Charges | DeoDap', h1: 'Shipping policy', body: '<p>Orders are dispatched within one working day. Delivery takes three to seven working days depending on the pin code. Shipping is free on prepaid orders above 999 rupees; cash on delivery orders carry a flat fee of 49 rupees.</p>' },
    'return-policy': { title: 'Return and Replacement Policy | DeoDap Wholesale', h1: 'Return policy', body: '<p>Products damaged in transit can be returned within seven days of delivery with an unboxing video. Replacements are dispatched within forty-eight hours of approval, and refunds for prepaid orders are processed to the original payment method.</p>' },
  };

  function pageHtml(handle: string, path: string): string | undefined {
    const pg = PAGES[handle];
    if (!pg) return undefined;
    return layout({ path, title: pg.title, h1: pg.h1, description: `${pg.title}. DeoDap wholesale: No MOQ, COD and fast shipping for resellers across India.`, jsonld: [], body: pg.body });
  }

  function blogIndexHtml(path: string): string {
    return layout({
      path, title: 'DeoDap Blog – Reseller and Dropshipping Guides', h1: 'Reseller guides',
      description: 'Guides for Indian resellers and dropshippers: product ideas, festive planning and wholesale pricing tips from the DeoDap team.',
      jsonld: [{ '@context': 'https://schema.org', '@type': 'Blog', name: 'DeoDap Blog' }],
      body: `<ul>${ARTICLES.map((a) => `<li><a href="/blogs/news/${a.handle}">${esc(a.title)}</a></li>`).join('')}</ul>`,
    });
  }

  function robotsTxt(): string {
    const lines = ['User-agent: *', 'Disallow: /cart', 'Disallow: /checkout', 'Disallow: /account', 'Disallow: /search', 'Disallow: /*?*sort_by*'];
    if (opts.robotsDisallowCollections) lines.push('Disallow: /collections/');
    lines.push('');
    if (opts.robotsBlockGptBot) lines.push('User-agent: GPTBot', 'Disallow: /', '');
    lines.push(`Sitemap: ${origin}/sitemap.xml`);
    return lines.join('\n');
  }

  function sitemapXml(): string {
    const entries: [string, string][] = [
      ['/', '2026-10-10'],
      ...allCollections().map((c, i) => [`/collections/${c.handle}`, `2026-10-0${(i % 9) + 1}`] as [string, string]),
      ...allProducts().map((p, i) => [`/products/${p.handle}`, `2026-09-${String(10 + (i % 18)).padStart(2, '0')}`] as [string, string]),
      ['/blogs/news', '2026-09-28'],
      ...ARTICLES.map((a) => [`/blogs/news/${a.handle}`, a.modified] as [string, string]),
      ...Object.keys(PAGES).map((h, i) => [`/pages/${h}`, `2026-08-0${i + 1}`] as [string, string]),
    ];
    if (opts.orphanInSitemap) entries.push(['/pages/wholesale-price-list', '2026-10-01']);
    for (const e of entries) if (opts.lastmod[e[0]]) e[1] = opts.lastmod[e[0]];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map(([pth, lm]) => `<url><loc>${origin}${pth}</loc><lastmod>${lm}</lastmod></url>`).join('\n')}\n</urlset>`;
  }

  function route(req: http.IncomingMessage, res: http.ServerResponse, u: URL) {
    const method = req.method ?? 'GET';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const xr = (p: string): Record<string, string> => (opts.xRobotsNoindex.includes(p) ? { 'x-robots-tag': 'noindex' } : {});
    if (opts.unavailable.includes(path)) return send(res, 503, '<h1>Service Unavailable</h1>', {}, method);
    if (path === '/robots.txt') return send(res, 200, robotsTxt(), { 'content-type': 'text/plain' }, method);
    if (path === '/sitemap.xml') return send(res, 200, sitemapXml(), { 'content-type': 'application/xml' }, method);
    if (path.startsWith('/cdn/img/missing-')) return send(res, 404, 'Not found', { 'content-type': 'text/plain' }, method);
    if (path.startsWith('/cdn/img/') && (opts.limitImages[path] ?? 0) > 0) {
      opts.limitImages[path]--;
      return send(res, 429, 'Too Many Requests', { 'content-type': 'text/plain', 'retry-after': '1' }, method);
    }
    if (path.startsWith('/cdn/img/')) {
      const big = path.endsWith('big-photo.jpg');
      const size = big ? 300 * 1024 : 18 * 1024;
      res.writeHead(200, { 'content-type': big ? 'image/jpeg' : 'image/webp', 'content-length': String(size) });
      return res.end(method === 'HEAD' ? undefined : Buffer.alloc(size, 1));
    }
    if (path === '/cdn/shop/t/1/assets/base.css' && opts.themeVersion > 1) {
      const css = `body{margin:0;font-family:sans-serif;background:${['#ffffff', '#fff6d6', '#e8f4ff'][opts.themeVersion % 3]}}h1{color:#1d2b3a;font-size:2rem}.price{font-weight:700;color:#0a6b3d}`;
      res.writeHead(200, { 'content-type': 'text/css', 'content-length': String(Buffer.byteLength(css)) });
      return res.end(method === 'HEAD' ? undefined : css);
    }
    if (path.startsWith('/cdn/shop/') || path.startsWith('/apps/')) {
      const body = '/* asset */'.padEnd(4000, ' ');
      res.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'application/javascript', 'content-length': String(body.length) });
      return res.end(method === 'HEAD' ? undefined : body);
    }
    if (path === '/') return send(res, 200, homeHtml(), xr(path), method);
    if (path === '/pages/slow') {
      const t = setTimeout(() => send(res, 200, layout({ path, title: 'Slow page – DeoDap order tracking', h1: 'Track order', body: '<p>slow</p>', jsonld: [] }), {}, method), opts.slowMs);
      res.on('close', () => clearTimeout(t));
      return;
    }
    if (path === '/pages/broken') return send(res, 500, '<h1>Internal Server Error</h1>', {}, method);
    if (path === '/pages/internal') return redirect(res, 302, 'http://169.254.169.254/latest/meta-data/');
    if (opts.offsiteRedirects[path]) return redirect(res, 302, opts.offsiteRedirects[path]);
    if (path === '/pages/malformed') return send(res, 200, '<html><head><title>Broken <b>markup<div><<<\u0000\u0001 <a href="/pages/nowhere"', {}, method);
    if (path === '/old-chopper') return redirect(res, 301, '/products/old-chopper-v2');
    if (path === '/products/old-chopper-v2') return redirect(res, 301, '/products/vegetable-chopper');
    if (path === '/promo') return redirect(res, 302, '/collections/toys');
    if (path === '/loop-a') return redirect(res, 301, '/loop-b');
    if (path === '/loop-b') return redirect(res, 301, '/loop-a');
    let m = path.match(/^\/collections\/([^/]+)\/products\/([^/]+)$/);
    if (m) {
      const p = allProducts().find((x) => x.handle === m![2]);
      if (!p || opts.deletedProducts.includes(p.handle)) return send(res, 404, '<h1>404 Page not found</h1>', {}, method);
      return send(res, 200, productHtml(p, path, opts.scopedSelfCanonical ? path : `/products/${p.handle}`), xr(path), method);
    }
    m = path.match(/^\/products\/([^/]+)$/);
    if (m) {
      const p = allProducts().find((x) => x.handle === m![1]);
      if (!p || opts.deletedProducts.includes(p.handle)) return send(res, 404, layout({ path, title: '404 Not Found | DeoDap', h1: 'Page not found', body: '<p>The page you were looking for does not exist.</p>', jsonld: [] }), {}, method);
      return send(res, 200, productHtml(p, path, path), xr(path), method);
    }
    m = path.match(/^\/collections\/([^/]+)$/);
    if (m) {
      const c = allCollections().find((x) => x.handle === m![1]);
      if (!c) return send(res, 404, '<h1>Not found</h1>', {}, method);
      const html = collectionHtml(c, path);
      // Sorted variants: Shopify serves the same page; the canonical stays on the clean collection URL.
      return send(res, 200, html, xr(path), method);
    }
    if (path === '/blogs/news') return send(res, 200, blogIndexHtml(path), xr(path), method);
    m = path.match(/^\/blogs\/news\/([^/]+)$/);
    if (m) {
      const a = ARTICLES.find((x) => x.handle === m![1]);
      if (a) return send(res, 200, articleHtml(a, path), xr(path), method);
    }
    m = path.match(/^\/pages\/([^/]+)$/);
    if (m) {
      const html = m[1] === 'wholesale-price-list'
        ? layout({ path, title: 'Wholesale Price List 2026 – All Categories | DeoDap', h1: 'Wholesale price list', description: 'Download the DeoDap wholesale price list: No MOQ, COD and fast shipping on every category for resellers.', jsonld: [], body: '<p>Our complete wholesale price list covers kitchen tools, home decor and toys with slab pricing for ten, fifty and one hundred units. Prices are updated every Monday and include GST.</p>' })
        : pageHtml(m[1], path);
      if (html) return send(res, 200, html, xr(path), method);
    }
    return send(res, 404, layout({ path, title: '404 Not Found | DeoDap', h1: 'Page not found', body: '<p>Not found.</p>', jsonld: [] }), {}, method);
  }

  // A 127.x.y.z host (all loopback) listens on that address: several distinct local websites on one machine.
  await new Promise<void>((r) => server.listen(0, /^127\.\d+\.\d+\.\d+$/.test(opts.host) ? opts.host : '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  origin = `http://${opts.host}:${port}`;
  return {
    url: `${origin}/`, origin, opts, requests, notModified,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
    productUrls: () => PRODUCTS.map((p) => `${origin}/products/${p.handle}`),
    collectionUrls: () => COLLECTIONS.map((c) => `${origin}/collections/${c.handle}`),
  };
}
