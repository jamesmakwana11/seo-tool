import { describe, expect, it } from 'vitest';
import { findingsFor, makeEngine, tier2 } from './helpers';

/**
 * Real-domain-only checks (TECH-HOST, TECH-HTTPS, firewall bot probes) cannot run against a loopback fixture,
 * so they are exercised with an injected fetch + TLS probe (no network).
 */
const HOME = (extra = '') => `<!doctype html><html><head><title>DeoDap – Wholesale Shopping &amp; Dropshipping India</title>
<link rel="canonical" href="https://deodap.example/"><script src="http://insecure.example/tracker.js"></script>${extra}</head>
<body><main><h1>Wholesale</h1><img src="http://deodap.example/cdn/x.jpg" alt="x"></main></body></html>`;

function mockFetch(routes: Record<string, (init?: RequestInit) => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const r = routes[url];
    if (!r) {
      if (url.includes('www.deodap.example')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND www.deodap.example' } });
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    return r(init);
  }) as typeof fetch;
}

const html = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });

describe('real-domain checks (mocked network)', () => {
  it('TECH-HOST split, TECH-HTTPS cert expiry + mixed content + missing HSTS, 429 to Googlebot', async () => {
    const routes: Record<string, (init?: RequestInit) => Response> = {
      'https://deodap.example/robots.txt': () => new Response('User-agent: *\nDisallow: /cart\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'https://deodap.example/': (init) => {
        const ua = String((init?.headers as Record<string, string>)?.['user-agent'] ?? '');
        if (/Googlebot/.test(ua)) return new Response('slow down', { status: 429 });
        return html(HOME())();
      },
      'http://deodap.example/': html(HOME()), // split: plain http answers 200 instead of 301
      'https://deodap.example/sitemap.xml': () => new Response('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://deodap.example/</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } }),
    };
    const engine = makeEngine('https://deodap.example', {
      allowLive: true, fetchImpl: mockFetch(routes),
      tlsCheck: async (host) => ({ host, validTo: '2026-10-20T00:00:00.000Z', daysLeft: 8, authorized: true }),
    });
    expect(engine.readiness().ready).toBe(true);
    const out = await engine.run({ type: 'smart', baseUrl: 'https://deodap.example', maxPages: 5, tierOf: tier2, urls: [] });

    const host = findingsFor(out.findings, 'TECH-HOST')[0];
    expect(host.urls).toEqual(['http://deodap.example/']);
    expect(host.title).toContain('canonical host split');
    expect(out.evaluatedChecks).toContain('TECH-HOST');

    const https = findingsFor(out.findings, 'TECH-HTTPS')[0];
    expect(https.title).toMatch(/certificate expires in 8 days/);
    expect(https.title).toMatch(/HSTS/);
    expect(https.title).toMatch(/mixed content/);
    expect(https.evidence.some((e) => e.content?.includes('http://insecure.example/tracker.js'))).toBe(true);

    const bot = findingsFor(out.findings, 'TECH-4XX').find((f) => f.severityContext?.searchCrawlerAffected);
    expect(bot?.title).toContain('Googlebot');
  });

  it('host variants that 301 to the canonical homepage pass; HSTS present passes', async () => {
    const routes: Record<string, (init?: RequestInit) => Response> = {
      'https://deodap.example/robots.txt': () => new Response('User-agent: *\nDisallow: /cart\n', { status: 200, headers: { 'content-type': 'text/plain' } }),
      'https://deodap.example/': html(HOME().replace(/http:\/\//g, 'https://'), { 'strict-transport-security': 'max-age=31536000' }),
      'http://deodap.example/': redirect(301, 'https://deodap.example/'),
      'https://www.deodap.example/': redirect(301, 'https://deodap.example/'),
      'http://www.deodap.example/': redirect(301, 'https://deodap.example/'),
    };
    const out = await makeEngine('https://deodap.example', {
      allowLive: true, fetchImpl: mockFetch(routes), tlsCheck: async (host) => ({ host, validTo: '2027-06-01T00:00:00.000Z', daysLeft: 232, authorized: true }),
    }).run({ type: 'smart', baseUrl: 'https://deodap.example', maxPages: 5, tierOf: tier2, urls: [] });
    expect(findingsFor(out.findings, 'TECH-HOST')).toEqual([]);
    expect(findingsFor(out.findings, 'TECH-HTTPS')).toEqual([]);
    expect(out.evaluatedChecks).toEqual(expect.arrayContaining(['TECH-HOST', 'TECH-HTTPS']));
  });

  it('refuses to crawl a host other than CRAWLER_BASE_URL', async () => {
    const engine = makeEngine('https://deodap.example', { allowLive: true, fetchImpl: mockFetch({}) });
    await expect(engine.run({ type: 'smart', baseUrl: 'https://evil.example', maxPages: 1, tierOf: tier2 })).rejects.toThrow(/only this website's own host/);
  });
});
