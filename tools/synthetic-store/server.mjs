#!/usr/bin/env node
/**
 * Synthetic Shopify-like store for crawl stress tests — serves ONLY on 127.0.0.1, generates every page on request
 * (nothing external is ever contacted).
 *
 *   node tools/synthetic-store/server.mjs --products 50000 [--port 0] [--seed 7] [--rate 4 --burst 8 --retry-after 30]
 *
 * Prints one JSON line {"ready":true,"url":"http://127.0.0.1:PORT/","pages":…} when listening.
 *
 * Shape (deterministic for a given --products and --seed):
 *  - home with a mega menu, collections (24 products per page, ?page=N pagination, sort / filter / tag links),
 *    products, a blog with articles, content pages and policies;
 *  - robots.txt like Shopify's, a sitemap index with gzip product sitemaps (5,000 URLs per file, as Shopify does);
 *  - realistic defects: ~0.5% links to deleted products (404), ~0.5% old product handles (301), duplicate titles,
 *    missing meta descriptions, a noindexed section, multiple H1s, images without alt, and a large share of products
 *    whose description is the same template with the product name swapped (near-duplicate copy).
 *  - HTML ~20–30 KB per page (theme chrome, JSON-LD, inline scripts), like a real Shopify theme.
 */
import http from 'node:http';
import zlib from 'node:zlib';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const N = Number(arg('products', '1000'));
const PORT = Number(arg('port', '0'));
const SEED = Number(arg('seed', '7'));
const PER_PAGE = 24;
const COLLECTIONS = Math.max(5, Math.round(N / 100));
const ARTICLES = Math.max(10, Math.round(N / 250));
const PAGES = ['about-us', 'contact', 'shipping-policy', 'return-policy', 'faq', 'wholesale', 'track-order', 'bulk-orders', 'careers', 'press'];

// ---------------------------------------------------------------- deterministic text
function rnd(i, salt = 0) {
  let x = (i + 1) * 2654435761 + SEED * 97 + salt * 1013904223;
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
const ADJ = ['Premium', 'Compact', 'Stainless', 'Foldable', 'Portable', 'Heavy Duty', 'Multipurpose', 'Electric', 'Manual', 'Silicone', 'Wooden', 'LED', 'Magnetic', 'Waterproof', 'Adjustable', 'Mini', 'Smart', 'Classic', 'Rechargeable', 'Eco'];
const NOUN = ['Vegetable Chopper', 'Storage Box', 'Water Bottle', 'Wall Hook', 'Lunch Box', 'Desk Organiser', 'Kitchen Scale', 'Night Lamp', 'Phone Stand', 'Cleaning Brush', 'Spice Rack', 'Shoe Rack', 'Hair Dryer', 'Toy Car', 'Yoga Mat', 'Mixing Bowl', 'Cutting Board', 'Ice Tray', 'Laundry Bag', 'Plant Pot'];
const WORDS = 'durable lightweight sturdy ergonomic washable reusable versatile handy elegant colourful practical efficient strong smooth safe easy quick neat tidy fresh bright soft firm gentle tough sleek modern rustic minimal vivid warm cool long short wide narrow deep shallow round square oval flat curved hollow solid hybrid premium budget family travel office garden kitchen bathroom bedroom balcony festival gifting wedding party school picnic camping'.split(' ');
const COLORS = ['red', 'blue', 'green', 'black', 'white', 'pink'];

const productName = (i) => `${ADJ[Math.floor(rnd(i, 1) * ADJ.length)]} ${NOUN[Math.floor(rnd(i, 2) * NOUN.length)]} ${100 + (i % 900)}`;
const handleOf = (i) => `${productName(i).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`;
const collectionOf = (i) => i % COLLECTIONS;
const collectionName = (c) => `${NOUN[c % NOUN.length]}s ${c >= NOUN.length ? `Series ${Math.floor(c / NOUN.length)}` : ''}`.trim();
const collectionHandle = (c) => collectionName(c).toLowerCase().replace(/[^a-z0-9]+/g, '-') + `-${c}`;
const isDeleted = (i) => i % 200 === 17; // linked but 404
const isMoved = (i) => i % 200 === 99; // old handle 301 → new handle
const sentences = (i, n, salt) => Array.from({ length: n }, (_, k) => {
  const w = Array.from({ length: 9 + Math.floor(rnd(i, salt + k) * 8) }, (_, j) => WORDS[Math.floor(rnd(i * 31 + j, salt + k * 7) * WORDS.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
}).join(' ');
// 60% of products share one description template (name swapped) — near-duplicate copy at scale.
const templated = (i) => rnd(i, 5) < 0.6;
function description(i) {
  const name = productName(i);
  if (templated(i)) {
    return `<p>The ${name} is a reliable everyday essential for homes, offices and resellers across India. Made from quality materials and checked before dispatch, it is easy to use, easy to clean and built to last through daily use.</p>
<p>Buy the ${name} at wholesale price with no minimum order quantity. Resellers and dropshippers can order a single piece to test demand, then reorder by the carton at slab prices. Cash on delivery is available on most pin codes and orders ship within one working day.</p>
<p>Every ${name} is packed in a retail-ready box with a barcode, so it is ready to list on your marketplace store or sell in a physical shop.</p>`;
  }
  return `<p>${sentences(i, 4, 10)}</p><p>${sentences(i, 5, 20)}</p><p>${sentences(i, 3, 30)}</p>`;
}

// ---------------------------------------------------------------- HTML
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let ORIGIN = '';
const MENU = Array.from({ length: Math.min(60, COLLECTIONS) }, (_, c) => `<li><a href="/collections/${collectionHandle(c)}">${esc(collectionName(c))}</a></li>`).join('');
const FOOTER = PAGES.map((p) => `<a href="/pages/${p}">${p.replace(/-/g, ' ')}</a>`).join(' ') + ' <a href="/policies/privacy-policy">Privacy</a> <a href="/policies/terms-of-service">Terms</a> <a href="/blogs/news">Blog</a> <a href="/cart">Cart</a> <a href="/account/login">Account</a>';
const THEME_JS = `window.Shopify=window.Shopify||{};Shopify.theme={name:"Dawn",id:1};${'var a=1;'.repeat(400)}`;
function layout({ title, meta, canonical, body, jsonld = [], robots, h1 }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${meta === undefined ? '' : `<meta name="description" content="${esc(meta)}">`}${robots ? `<meta name="robots" content="${robots}">` : ''}
<link rel="canonical" href="${ORIGIN}${canonical}"><meta property="og:title" content="${esc(title)}"><meta property="og:url" content="${ORIGIN}${canonical}"><meta property="og:image" content="${ORIGIN}/cdn/shop/files/og.jpg"><meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/cdn/shop/t/1/assets/base.css"><script src="/cdn/shop/t/1/assets/global.js" defer></script>
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('')}
<script>${THEME_JS}</script></head><body>
<header><a href="/">DeoShop</a><nav aria-label="Main"><ul>${MENU}</ul></nav><form action="/search"><input name="q"></form></header>
<main id="MainContent">${h1 ?? ''}${body}</main>
<footer>${FOOTER}<p>Questions? Call +91 90000 00000 · Rajkot, Gujarat</p></footer></body></html>`;
}

function productPage(i) {
  const name = productName(i);
  const c = collectionOf(i);
  const rel = [1, 2, 3, 4].map((k) => (i + k * 37) % N).map((j) => `<li><a href="/products/${handleOf(j)}">${esc(productName(j))}</a></li>`).join('');
  const dupTitle = i % 97 === 3; // shares a generic title
  const missingMeta = i % 41 === 5;
  const twoH1 = i % 113 === 7;
  const price = 99 + Math.floor(rnd(i, 3) * 900);
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'Product', name, image: `${ORIGIN}/cdn/shop/products/${i}.jpg`, description: `${name} at wholesale price`, sku: `SKU-${i}`, brand: { '@type': 'Brand', name: 'DeoShop' }, offers: { '@type': 'Offer', price: String(price), priceCurrency: 'INR', availability: 'https://schema.org/InStock' } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` }, { '@type': 'ListItem', position: 2, name: collectionName(c), item: `${ORIGIN}/collections/${collectionHandle(c)}` }, { '@type': 'ListItem', position: 3, name, item: `${ORIGIN}/products/${handleOf(i)}` }] },
  ];
  return layout({
    title: dupTitle ? 'Buy Online at Best Price | DeoShop' : `${name} – Wholesale Price | DeoShop`,
    meta: missingMeta ? undefined : `Buy ${name} at wholesale price with no MOQ. COD available and fast shipping across India.`,
    canonical: `/products/${handleOf(i)}`,
    jsonld,
    h1: `<nav aria-label="breadcrumb" class="breadcrumb"><a href="/">Home</a> / <a href="/collections/${collectionHandle(c)}">${esc(collectionName(c))}</a></nav><h1>${esc(name)}</h1>${twoH1 ? `<h1>${esc(name)} offer</h1>` : ''}`,
    body: `<div class="price">₹${price}</div><img src="/cdn/shop/products/${i}.jpg" ${i % 23 === 0 ? '' : `alt="${esc(name)}"`} width="800" height="800">
<img src="/cdn/shop/products/${i}-2.jpg" alt="${esc(name)} detail" width="800" height="800" loading="lazy">
<div class="product__description">${description(i)}</div>
<h2>Specifications</h2><table><tr><th>Material</th><td>ABS</td></tr><tr><th>Pack</th><td>1 piece</td></tr><tr><th>Weight</th><td>${100 + (i % 400)} g</td></tr></table>
<h2>Shipping and returns</h2><p>Orders ship within one working day. Returns accepted within 7 days of delivery for damaged items.</p>
<h2>You may also like</h2><ul>${rel}</ul>
${isDeleted((i + 5) % N) ? `<a href="/products/${handleOf((i + 5) % N)}">Also popular</a>` : ''}`,
  });
}

function collectionPage(c, page, extra = '') {
  const members = [];
  for (let i = c; i < N; i += COLLECTIONS) members.push(i);
  const pages = Math.max(1, Math.ceil(members.length / PER_PAGE));
  const slice = members.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const handle = collectionHandle(c);
  const grid = slice.map((i) => {
    const h = isMoved(i) ? `${handleOf(i)}-old` : handleOf(i);
    return `<li class="card"><a href="/collections/${handle}/products/${h}">${esc(productName(i))}</a><span>₹${99 + Math.floor(rnd(i, 3) * 900)}</span></li>`;
  }).join('');
  const pag = `${page > 1 ? `<a rel="prev" href="/collections/${handle}${page > 2 ? `?page=${page - 1}` : ''}">Previous</a>` : ''}${page < pages ? `<a rel="next" href="/collections/${handle}?page=${page + 1}">Next</a>` : ''}`;
  const facets = COLORS.map((col) => `<a href="/collections/${handle}?filter.v.option.color=${col}">${col}</a>`).join(' ') + ` <a href="/collections/${handle}?sort_by=price-ascending">Price, low to high</a> <a href="/collections/${handle}/tag-bestseller">Bestsellers</a>`;
  const own = c % 9 === 4 ? '' : `<div class="collection-description"><p>${sentences(c + 100000, 6, 40)}</p><p>${sentences(c + 100000, 6, 50)}</p></div>`;
  return layout({
    title: `${collectionName(c)}${page > 1 ? ` – Page ${page}` : ''} | DeoShop`,
    meta: `Shop ${collectionName(c)} at wholesale prices. No MOQ, COD and fast shipping.`,
    canonical: `/collections/${handle}${page > 1 ? `?page=${page}` : ''}`,
    h1: `<h1>${esc(collectionName(c))}</h1>`,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: collectionName(c) }],
    body: `${own}<div class="facets">${facets}</div><ul class="grid">${grid}</ul><nav class="pagination">${pag}</nav>${extra}`,
  });
}

function articlePage(a) {
  return layout({
    title: `Guide ${a}: ${sentences(a + 200000, 1, 60).slice(0, 50)} | DeoShop Blog`,
    meta: `Reseller guide ${a} from the DeoShop team.`,
    canonical: `/blogs/news/guide-${a}`,
    h1: `<h1>Guide ${a}</h1>`,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: `Guide ${a}`, datePublished: '2026-05-01', dateModified: '2026-06-01', author: { '@type': 'Person', name: 'Team DeoShop' } }],
    body: `<p class="author">By Team DeoShop</p>${Array.from({ length: 5 }, (_, k) => `<h2>Section ${k + 1}: how to sell more</h2><p>${sentences(a + 300000 + k, 6, 70)}</p>`).join('')}<a href="/collections/${collectionHandle(a % COLLECTIONS)}">Shop the collection</a>`,
  });
}

function contentPage(p) {
  return layout({
    title: `${p.replace(/-/g, ' ')} | DeoShop`, meta: `${p.replace(/-/g, ' ')} — DeoShop wholesale store.`, canonical: `/pages/${p}`,
    robots: p === 'careers' ? 'noindex' : undefined,
    h1: `<h1>${p.replace(/-/g, ' ')}</h1>`, body: `<p>${sentences(p.length * 1000, 8, 80)}</p>`,
  });
}

function homePage() {
  const all = Array.from({ length: COLLECTIONS }, (_, c) => `<li><a href="/collections/${collectionHandle(c)}">${esc(collectionName(c))}</a></li>`).join('');
  const featured = Array.from({ length: 24 }, (_, k) => `<li><a href="/products/${handleOf((k * 131) % N)}">${esc(productName((k * 131) % N))}</a></li>`).join('');
  return layout({
    title: 'DeoShop – Wholesale & Dropshipping Store India', meta: 'Wholesale and dropshipping products with no MOQ, COD and fast shipping across India.', canonical: '/',
    h1: '<h1>Wholesale and dropshipping products, no MOQ</h1>',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'DeoShop', logo: `${ORIGIN}/logo.png`, sameAs: ['https://www.instagram.com/deoshop'], address: 'Rajkot' }, { '@context': 'https://schema.org', '@type': 'WebSite', name: 'DeoShop', url: `${ORIGIN}/` }],
    body: `<section><h2>New arrivals</h2><ul>${featured}</ul></section><section><h2>All collections</h2><ul>${all}</ul></section>`,
  });
}

// ---------------------------------------------------------------- sitemaps
const SM_SIZE = 5000;
const xmlUrls = (urls) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${ORIGIN}${u}</loc><lastmod>2026-09-${String(1 + (u.length % 28)).padStart(2, '0')}</lastmod></url>`).join('')}</urlset>`;
function sitemapIndex() {
  const parts = [];
  for (let k = 0; k * SM_SIZE < N; k++) parts.push(`/sitemap_products_${k + 1}.xml.gz`);
  parts.push('/sitemap_collections_1.xml', '/sitemap_pages_1.xml', '/sitemap_blogs_1.xml');
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${parts.map((p) => `<sitemap><loc>${ORIGIN}${p}</loc></sitemap>`).join('')}</sitemapindex>`;
}
function productSitemap(k) {
  const urls = [];
  for (let i = k * SM_SIZE; i < Math.min(N, (k + 1) * SM_SIZE); i++) if (!isDeleted(i)) urls.push(`/products/${handleOf(i)}`);
  return urls;
}

const ROBOTS = `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nDisallow: /collections/*sort_by*\nDisallow: /*/collections/*sort_by*\nDisallow: /search\nSitemap: {ORIGIN}/sitemap.xml\n`;

// ---------------------------------------------------------------- server
let served = 0;
// Optional rate limiting like a storefront's bot protection: --rate R requests/s with a burst of --burst B (token
// bucket, all paths); over the limit the answer is 429 with Retry-After: --retry-after seconds.
const RATE = Number(arg('rate', '0'));
const BURST = Number(arg('burst', String(Math.max(1, RATE * 2))));
const RETRY_AFTER = arg('retry-after', '');
let tokens = BURST;
let refilled = Date.now();
let limited = 0;
const server = http.createServer((req, res) => {
  served++;
  if (RATE > 0) {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - refilled) / 1000) * RATE);
    refilled = now;
    if (tokens < 1) {
      limited++;
      res.writeHead(429, { 'content-type': 'text/plain', ...(RETRY_AFTER ? { 'retry-after': RETRY_AFTER } : {}) });
      res.end('Too Many Requests');
      return;
    }
    tokens -= 1;
  }
  const u = new URL(req.url, ORIGIN);
  const p = u.pathname;
  const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (p === '/') return send(200, homePage());
  if (p === '/robots.txt') return send(200, ROBOTS.replace('{ORIGIN}', ORIGIN), 'text/plain');
  if (p === '/sitemap.xml') return send(200, sitemapIndex(), 'application/xml');
  let m = /^\/sitemap_products_(\d+)\.xml\.gz$/.exec(p);
  if (m) return send(200, zlib.gzipSync(xmlUrls(productSitemap(Number(m[1]) - 1))), 'application/x-gzip');
  if (p === '/sitemap_collections_1.xml') return send(200, xmlUrls(Array.from({ length: COLLECTIONS }, (_, c) => `/collections/${collectionHandle(c)}`)), 'application/xml');
  if (p === '/sitemap_pages_1.xml') return send(200, xmlUrls(PAGES.map((x) => `/pages/${x}`)), 'application/xml');
  if (p === '/sitemap_blogs_1.xml') return send(200, xmlUrls(Array.from({ length: ARTICLES }, (_, a) => `/blogs/news/guide-${a}`)), 'application/xml');
  m = /^\/products\/(.+)-(\d+)(-old)?$/.exec(p);
  if (m) {
    const i = Number(m[2]);
    if (i >= N || isDeleted(i)) return send(404, layout({ title: 'Page not found | DeoShop', canonical: p, body: '<p>Not found</p>', h1: '<h1>404 Page not found</h1>' }));
    if (m[3]) return send(301, '', 'text/html', { location: `/products/${handleOf(i)}` });
    return send(200, productPage(i));
  }
  m = /^\/collections\/([^/]+)\/products\/(.+)-(\d+)(-old)?$/.exec(p);
  if (m) {
    const i = Number(m[3]);
    if (i >= N || isDeleted(i)) return send(404, '<h1>Not found</h1>');
    if (m[4]) return send(301, '', 'text/html', { location: `/products/${handleOf(i)}` });
    return send(200, productPage(i)); // canonical points to /products/…
  }
  m = /^\/collections\/(.+)-(\d+)(\/tag-[a-z]+)?$/.exec(p);
  if (m) {
    const c = Number(m[2]);
    if (c >= COLLECTIONS) return send(404, '<h1>Not found</h1>');
    const page = Math.max(1, Number(u.searchParams.get('page') ?? 1) || 1);
    return send(200, collectionPage(c, page));
  }
  if (p === '/blogs/news') return send(200, layout({ title: 'Blog | DeoShop', meta: 'Guides for resellers.', canonical: '/blogs/news', h1: '<h1>Blog</h1>', body: `<ul>${Array.from({ length: ARTICLES }, (_, a) => `<li><a href="/blogs/news/guide-${a}">Guide ${a}</a></li>`).join('')}</ul>` }));
  m = /^\/blogs\/news\/guide-(\d+)$/.exec(p);
  if (m && Number(m[1]) < ARTICLES) return send(200, articlePage(Number(m[1])));
  m = /^\/pages\/(.+)$/.exec(p);
  if (m && PAGES.includes(m[1])) return send(200, contentPage(m[1]));
  if (p.startsWith('/policies/')) return send(200, layout({ title: 'Policy | DeoShop', meta: 'Store policy.', canonical: p, h1: '<h1>Policy</h1>', body: `<p>${sentences(p.length, 12, 90)}</p>` }));
  if (p.startsWith('/cdn/')) return send(200, p.endsWith('.css') ? 'body{}' : p.endsWith('.js') ? 'void 0' : Buffer.alloc(12000), p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'application/javascript' : 'image/jpeg');
  if (p === '/logo.png') return send(200, Buffer.alloc(2000), 'image/png');
  return send(404, layout({ title: 'Page not found | DeoShop', canonical: p, body: '<p>Not found</p>', h1: '<h1>404</h1>' }));
});
server.keepAliveTimeout = 30_000;
server.listen(PORT, /^127\.\d+\.\d+\.\d+$/.test(arg('host', '')) ? arg('host', '') : '127.0.0.1', () => {
  ORIGIN = `http://${arg('host', '127.0.0.1')}:${server.address().port}`; // --host localhost: a second, distinct website on this machine
  const collectionPages = Array.from({ length: COLLECTIONS }, (_, c) => Math.max(1, Math.ceil(Math.ceil((N - c) / COLLECTIONS) / PER_PAGE))).reduce((a, b) => a + b, 0);
  process.stdout.write(`${JSON.stringify({ ready: true, url: `${ORIGIN}/`, products: N, collections: COLLECTIONS, collectionPages, articles: ARTICLES })}\n`);
});
setInterval(() => process.stderr.write(`${JSON.stringify({ served, limited })}\n`), 30_000).unref();
process.on('SIGTERM', () => { process.stderr.write(`${JSON.stringify({ final: true, served, limited })}\n`); process.exit(0); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
