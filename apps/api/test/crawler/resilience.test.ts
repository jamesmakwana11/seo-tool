import { describe, expect, it } from 'vitest';
import { createHttpClient, createThrottle, retryAfterMs } from '../../src/crawler/http';
import { groupFor, parseRobots } from '../../src/crawler/robots';
import { makeEngine, tier2 } from './helpers';

/** A fake network: routes return a Response; every request is logged with its time. */
function net(routes: Record<string, (n: number, init?: RequestInit) => Response>) {
  const log: { url: string; at: number; ua: string }[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    log.push({ url, at: Date.now(), ua: String((init?.headers as Record<string, string>)?.['user-agent'] ?? '') });
    const r = routes[url];
    return r ? r(n, init) : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  return { fetchImpl, log, count: (u: string) => counts.get(u) ?? 0 };
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const go = (status: number, location: string) => new Response(null, { status, headers: { location } });
const page = (title: string, links: string[]) => `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title} description"></head><body><main><h1>${title}</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join('')}</main></body></html>`;

describe('robots.txt Crawl-delay', () => {
  it('is read per user-agent group, falling back to *', () => {
    const r = parseRobots('User-agent: *\nCrawl-delay: 2\nDisallow: /cart\n\nUser-agent: DeoDapSEOSentinel\nCrawl-delay: 0.5\nAllow: /\n');
    expect(groupFor(r, 'DeoDapSEOSentinel/1.0 (+x)').crawlDelay).toBe(0.5);
    expect(groupFor(r, 'OtherBot/2').crawlDelay).toBe(2);
    expect(groupFor(parseRobots('User-agent: *\nDisallow:\n'), 'x').crawlDelay).toBeUndefined();
  });
});

describe('Retry-After and the adaptive throttle', () => {
  it('parses delta-seconds and HTTP dates', () => {
    expect(retryAfterMs('7')).toBe(7000);
    const now = Date.parse('2026-10-15T00:00:00Z');
    expect(retryAfterMs('Thu, 15 Oct 2026 00:00:30 GMT', now)).toBe(30000);
    expect(retryAfterMs('soon')).toBeUndefined();
  });

  it('widens the gap on 429 / 503, narrows it after a run of normal answers, never below the floor', () => {
    const t = createThrottle(100);
    expect(t.intervalMs).toBe(100);
    t.slowDown();
    expect(t.intervalMs).toBe(1000);
    t.slowDown(5000);
    expect(t.intervalMs).toBe(5000);
    for (let i = 0; i < 20; i++) t.relax();
    expect(t.intervalMs).toBe(2500);
    for (let i = 0; i < 200; i++) t.relax();
    expect(t.intervalMs).toBe(100);
    t.setFloor(400);
    expect(t.intervalMs).toBe(400);
    expect(t.slowDowns).toBe(2);
  });
});

describe('retries', () => {
  const client = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => createHttpClient({ userAgent: 'test', timeoutMs: 2000, fetchImpl, retries: 2, ...extra });

  it('retries 429 after Retry-After and 503 / 502 with backoff, then records the success', async () => {
    const n = net({
      'https://s.example/a': (k) => (k === 1 ? html('busy', 429, { 'retry-after': '0' }) : html('ok')),
      'https://s.example/b': (k) => (k <= 2 ? html('down', k === 1 ? 503 : 502) : html('ok')),
    });
    const retries: number[] = [];
    const c = client(n.fetchImpl, { onRetry: (i: { attempt: number }) => retries.push(i.attempt) });
    expect((await c.request('https://s.example/a')).finalStatus).toBe(200);
    expect(n.count('https://s.example/a')).toBe(2);
    const b = await c.request('https://s.example/b');
    expect(b.finalStatus).toBe(200);
    expect(n.count('https://s.example/b')).toBe(3);
    expect(retries).toEqual([1, 1, 2]);
  }, 15000);

  it('gives up after the retry budget and records the failure honestly', async () => {
    const n = net({ 'https://s.example/x': () => html('down', 503, { 'retry-after': '0' }) });
    const r = await client(n.fetchImpl).request('https://s.example/x');
    expect(r.finalStatus).toBe(503);
    expect(n.count('https://s.example/x')).toBe(3);
  });

  it('does not wait for a Retry-After longer than the maximum, and never retries when asked not to or on 404', async () => {
    const n = net({ 'https://s.example/long': () => html('later', 429, { 'retry-after': '3600' }), 'https://s.example/gone': () => html('gone', 404) });
    const c = client(n.fetchImpl, { maxRetryWaitMs: 1000 });
    expect((await c.request('https://s.example/long')).finalStatus).toBe(429);
    expect(n.count('https://s.example/long')).toBe(1);
    expect((await c.request('https://s.example/gone')).finalStatus).toBe(404);
    expect(n.count('https://s.example/gone')).toBe(1);
    const m = net({ 'https://s.example/p': () => html('busy', 429, { 'retry-after': '0' }) });
    expect((await client(m.fetchImpl).request('https://s.example/p', { retry: false })).finalStatus).toBe(429);
    expect(m.count('https://s.example/p')).toBe(1);
  });

  it('retries a dropped connection but not a DNS failure', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
      return html('ok');
    }) as unknown as typeof fetch;
    expect((await client(flaky).request('https://s.example/')).finalStatus).toBe(200);
    expect(calls).toBe(2);
    let dns = 0;
    const missing = (async () => { dns++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } }); }) as unknown as typeof fetch;
    expect((await client(missing).request('https://nowhere.example/')).finalStatus).toBeNull();
    expect(dns).toBe(1);
  }, 10000);
});

describe('site address resolution (www / https)', () => {
  const site = () => net({
    'http://shop.example/': () => go(301, 'https://shop.example/'),
    'https://shop.example/': () => go(301, 'https://www.shop.example/'),
    'https://www.shop.example/robots.txt': () => new Response('User-agent: *\nDisallow: /cart\nSitemap: https://www.shop.example/sitemap.xml\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
    'https://www.shop.example/sitemap.xml': () => new Response('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.shop.example/pages/orphan</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } }),
    'https://www.shop.example/': () => html(page('Home', ['/collections/all', 'https://shop.example/pages/about', '/products/a'])),
    'https://www.shop.example/collections/all': () => html(page('All', ['/products/a', '/products/b'])),
    'https://www.shop.example/products/a': () => html(page('A', ['/products/b'])),
    'https://www.shop.example/products/b': () => html(page('B', ['/'])),
    'https://shop.example/pages/about': () => go(301, 'https://www.shop.example/pages/about'),
    'https://www.shop.example/pages/about': () => html(page('About', ['/'])),
    'https://www.shop.example/pages/orphan': () => html(page('Orphan', ['/'])),
  });

  it('crawls the whole site when the entered address redirects to https://www (it used to stop after one page)', async () => {
    const n = site();
    const engine = makeEngine('https://shop.example', { allowLive: true, fetchImpl: n.fetchImpl });
    const out = await engine.run({ type: 'full', baseUrl: 'http://shop.example/', startUrl: 'http://shop.example/', maxPages: Infinity, tierOf: tier2 });
    expect(out.stats.resolvedFrom).toBe('http://shop.example/');
    expect(out.stats.resolvedStartUrl).toBe('https://www.shop.example/');
    const ok = out.urls.filter((u) => u.status === 200).map((u) => new URL(u.url).pathname).sort();
    expect(ok).toEqual(['/', '/collections/all', '/pages/about', '/pages/orphan', '/products/a', '/products/b']);
    // The non-www link was fetched once and recorded as a redirect to the www page (an internal-link redirect).
    const about = out.urls.find((u) => u.url === 'https://shop.example/pages/about');
    expect(about).toMatchObject({ status: 301, finalUrl: 'https://www.shop.example/pages/about' });
    // Each page fetched once.
    expect(n.count('https://www.shop.example/products/b')).toBe(1);
  });

  it('refuses a start URL that redirects to a different website', async () => {
    const n = net({ 'https://shop.example/': () => go(302, 'https://other-store.example/') });
    const engine = makeEngine('https://shop.example', { allowLive: true, fetchImpl: n.fetchImpl });
    await expect(engine.run({ type: 'full', baseUrl: 'https://shop.example/', startUrl: 'https://shop.example/', maxPages: 10, tierOf: tier2 })).rejects.toThrow(/different website/);
  });
});

describe('politeness during a crawl', () => {
  it('honours robots.txt Crawl-delay, retries a transient 503 and reports both', async () => {
    const n = net({
      'https://slow.example/robots.txt': () => new Response('User-agent: *\nCrawl-delay: 0.3\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'https://slow.example/': () => html(page('Home', ['/a', '/b'])),
      'https://slow.example/a': (k) => (k === 1 ? html('busy', 503, { 'retry-after': '0' }) : html(page('A', ['/']))),
      'https://slow.example/b': () => html(page('B', ['/'])),
    });
    const engine = makeEngine('https://slow.example', { allowLive: true, fetchImpl: n.fetchImpl, concurrency: 4, retries: 2 });
    let last: { delayMs: number; crawlDelayMs?: number; retries: number; slowDowns: number } | undefined;
    const out = await engine.run({ type: 'full', baseUrl: 'https://slow.example/', startUrl: 'https://slow.example/', maxPages: 3, tierOf: tier2 }, (_c, _f, _d, _s, p) => { last = p; });
    expect(out.urls.find((u) => u.url === 'https://slow.example/a')?.status).toBe(200);
    expect(out.stats.politeness).toMatchObject({ crawlDelayMs: 300 });
    expect(out.stats.politeness!.retries).toBeGreaterThanOrEqual(1);
    expect(out.stats.politeness!.slowDowns).toBeGreaterThanOrEqual(1);
    expect(last?.crawlDelayMs).toBe(300);
    // Every request after robots.txt starts at least ~300 ms after the previous one, even with 4 parallel workers.
    const after = n.log.slice(n.log.findIndex((l) => l.url.endsWith('robots.txt')));
    expect(after.length).toBeGreaterThan(3);
    for (let i = 1; i < after.length; i++) expect(after[i].at - after[i - 1].at).toBeGreaterThanOrEqual(280);
  }, 30000);
});
