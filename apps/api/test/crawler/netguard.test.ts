import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertAllowedUrl, blockedAddressReason, createGuardedFetch } from '../../src/crawler/netguard';

const open = { allowLoopback: false };
const local = { allowLoopback: true };
const fakeDns = (map: Record<string, string[]>) => async (h: string) => {
  if (!(h in map)) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return map[h];
};

describe('blockedAddressReason', () => {
  it.each([
    ['127.0.0.1', 'loopback'], ['10.1.2.3', 'private'], ['172.20.0.1', 'private'], ['192.168.1.1', 'private'], ['169.254.169.254', 'metadata'],
    ['100.64.0.1', 'carrier-grade'], ['0.0.0.0', 'this network'], ['224.0.0.1', 'multicast'], ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'], ['fd00::1', 'private'], ['fe80::1', 'link-local'], ['::ffff:10.0.0.1', 'private'], ['::ffff:169.254.169.254', 'metadata'],
    ['64:ff9b::a9fe:a9fe', 'metadata'], ['2002:a9fe:a9fe::1', 'metadata'], ['::', 'unspecified'],
  ])('blocks %s', (ip, word) => {
    expect(blockedAddressReason(ip, open)).toMatch(new RegExp(word));
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '23.227.38.65'])('allows public %s', (ip) => {
    expect(blockedAddressReason(ip, open)).toBeUndefined();
  });

  it('allows only loopback (never private or metadata) when the local-fixture policy is on', () => {
    expect(blockedAddressReason('127.0.0.1', local)).toBeUndefined();
    expect(blockedAddressReason('::1', local)).toBeUndefined();
    expect(blockedAddressReason('10.0.0.1', local)).toMatch(/private/);
    expect(blockedAddressReason('169.254.169.254', local)).toMatch(/metadata/);
  });
});

describe('assertAllowedUrl', () => {
  const dnsMap = fakeDns({ 'shop.example': ['93.184.216.34'], 'rebind.example': ['93.184.216.34', '10.0.0.7'], 'meta.example': ['169.254.169.254'] });
  it('accepts a public host', async () => {
    await expect(assertAllowedUrl('https://shop.example/a', open, dnsMap)).resolves.toBeUndefined();
  });
  it.each([
    ['ftp://shop.example/', /only http and https/],
    ['file:///etc/passwd', /only http and https/],
    ['https://user:pw@shop.example/', /credentials/],
    ['http://169.254.169.254/latest/meta-data/', /metadata/],
    ['http://[::1]:8080/', /loopback/],
    ['http://localhost:4000/', /internal host name/],
    ['http://metadata.google.internal/', /internal host name/],
    ['http://printer.local/', /internal host name/],
    ['https://rebind.example/', /resolves to 10\.0\.0\.7/],
    ['https://meta.example/', /resolves to 169\.254\.169\.254/],
    ['https://nowhere.example/', /could not resolve/],
  ])('refuses %s', async (url, msg) => {
    await expect(assertAllowedUrl(url, open, dnsMap)).rejects.toThrow(msg);
  });
});

describe('guarded fetch against a real local server', () => {
  let server: http.Server;
  let origin = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
      if (req.url === '/to-private') { res.writeHead(301, { location: 'http://10.0.0.5/admin' }); return res.end(); }
      if (req.url === '/to-ok') { res.writeHead(302, { location: '/ok' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses loopback when the policy does not allow it', async () => {
    await expect(createGuardedFetch(open)(`${origin}/ok`)).rejects.toThrow(/loopback/);
  });
  it('follows a same-host redirect when loopback fixtures are allowed', async () => {
    const res = await createGuardedFetch(local)(`${origin}/to-ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
  it('revalidates redirects: a redirect to the metadata endpoint or a private IP is refused', async () => {
    await expect(createGuardedFetch(local)(`${origin}/to-metadata`)).rejects.toThrow(/metadata/);
    await expect(createGuardedFetch(local)(`${origin}/to-private`)).rejects.toThrow(/private/);
  });
  it('returns the redirect response untouched with redirect: manual (the crawler then checks the next hop itself)', async () => {
    const res = await createGuardedFetch(local)(`${origin}/to-metadata`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });
});
