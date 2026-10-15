import http from 'node:http';
import { it } from 'vitest';
import { defaultConfig } from '@sentinel/shared';
import { createCrawlEngine } from '../src/crawler/engine';

/**
 * Opt-in performance test of an "All pages" crawl + analysis on a generated site:
 *   STRESS_PAGES=16000 npx vitest run test/stress.test.ts      (skipped in the normal test run)
 */
const N = Number(process.env.STRESS_PAGES ?? 0);
it.skipIf(!N)(`all-pages crawl of a ${N}-page site`, async () => {
  const nav = Array.from({ length: 40 }, (_, i) => `<li><a href="/collections/c${i}">Category number ${i} with a long menu label</a></li>`).join('');
  const foot = Array.from({ length: 20 }, (_, i) => `<li><a href="/pages/info-${i}">Footer link ${i} — policies and help</a></li>`).join('');
  const page = (i: number) => {
    const rel = Array.from({ length: 8 }, (_, k) => `<a href="/products/p${(i * 7 + k * 13) % N}">Related ${k}</a>`).join('');
    const imgs = Array.from({ length: 20 }, (_, k) => `<img src="/cdn/shop/files/img-${(i + k) % 500}.jpg" alt="${k % 3 ? 'Product photo' : ''}" width="400" height="400">`).join('');
    return `<!doctype html><html lang="en"><head><title>Product ${i} – Store</title><meta name="description" content="Buy product ${i} at the best wholesale price. Free shipping."><link rel="canonical" href="/products/p${i}"></head><body><header><nav><ul>${nav}</ul></nav></header><main><h1>Product ${i}</h1><h2>Details</h2><p>${'Lorem ipsum dolor sit amet, product description text. '.repeat(30)}</p>${imgs}${rel}<a href="/products/p${(i + 1) % N}">Next</a></main><footer><ul>${foot}</ul></footer></body></html>`;
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nSitemap: http://${req.headers.host}/sitemap.xml`); }
    if (u.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: N }, (_, i) => `<url><loc>http://${req.headers.host}/products/p${i}</loc></url>`).join('')}</urlset>`);
    }
    const m = u.pathname.match(/^\/products\/p(\d+)$/);
    if (u.pathname === '/' || m) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page(m ? Number(m[1]) : 0)); }
    if (/^\/(collections|pages)\//.test(u.pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<html><head><title>${u.pathname}</title></head><body><main><h1>${u.pathname}</h1><a href="/products/p1">p1</a></main></body></html>`); }
    res.writeHead(404, { 'content-type': 'image/jpeg', 'content-length': '0' }); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const config = defaultConfig(new Date());
  const engine = createCrawlEngine({ baseUrl: origin, allowLive: false, userAgent: 'stress', timeoutMs: 15000, concurrency: 8, respectRobots: true, thresholds: config.thresholds, config, requestDelayMs: 0,
    log: { info: (...a: unknown[]) => { if (a[1] === 'analysis finished') console.log('ANALYSIS', JSON.stringify(a[0])); }, warn: () => undefined, error: () => undefined } });
  global.gc?.();
  const base = process.memoryUsage().heapUsed;
  let peak = 0;
  let last = 0;
  let lastProgressAt = Date.now();
  const t0 = Date.now();
  const out = await engine.run({ type: 'full', baseUrl: `${origin}/`, startUrl: `${origin}/`, maxPages: Infinity, tierOf: () => 2 }, (c) => {
    lastProgressAt = Date.now();
    if (c - last >= 500) { last = c; global.gc?.(); peak = Math.max(peak, process.memoryUsage().heapUsed); }
  });
  console.log(`collection ~${((lastProgressAt - t0) / 1000).toFixed(1)}s, analysis ~${((Date.now() - lastProgressAt) / 1000).toFixed(1)}s, heap after ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`);
  const collectedMs = Date.now() - t0;
  console.log(`crawled ${out.stats.urlsCrawled} pages (planned ${out.stats.urlsPlanned}) in ${(collectedMs / 1000).toFixed(1)}s incl. analysis; findings ${out.findings.length}; memoryStopped ${!!out.memoryStopped}`);
  console.log(`retained heap during crawl: peak ${((peak - base) / 1048576).toFixed(0)} MB => ${((peak - base) / 1024 / Math.max(1, last)).toFixed(0)} KB/page`);
  await new Promise<void>((r) => server.close(() => r()));
}, 1_800_000);
