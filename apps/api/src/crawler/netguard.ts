/**
 * SSRF protection for every request the crawler makes.
 *
 * - Only http(s) URLs without embedded credentials.
 * - Host names that point inside the network (localhost, *.internal, *.local, cloud metadata names) are refused.
 * - IP literals and EVERY address a host name resolves to must be public: loopback, private (RFC 1918, ULA),
 *   link-local (incl. the 169.254.169.254 cloud metadata endpoint), CGNAT, multicast, documentation and reserved
 *   ranges are refused — including IPv4 embedded in IPv6 (mapped, NAT64, 6to4).
 * - The check runs again at connect time (undici `connect.lookup`), so a DNS answer that changes between the
 *   pre-check and the connection (DNS rebinding) is still refused, and on every redirect hop.
 * - Loopback can be allowed ONLY for local fixture crawls outside production (policy.allowLoopback); private,
 *   link-local and metadata addresses stay blocked even then.
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export interface NetPolicy {
  /** Allow 127.0.0.0/8 and ::1 (local test fixtures, never in production). */
  allowLoopback: boolean;
}

export class BlockedDestinationError extends Error {
  readonly code = 'BLOCKED_DESTINATION';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedDestinationError';
  }
}

type Range = [address: string, prefix: number, label: string];
const V4: Range[] = [
  ['0.0.0.0', 8, '"this network" range'], ['10.0.0.0', 8, 'a private address'], ['100.64.0.0', 10, 'a carrier-grade NAT address'],
  ['127.0.0.0', 8, 'a loopback address'], ['169.254.0.0', 16, 'a link-local / cloud metadata address'], ['172.16.0.0', 12, 'a private address'],
  ['192.0.0.0', 24, 'an IETF protocol address'], ['192.0.2.0', 24, 'a documentation address'], ['192.88.99.0', 24, 'a 6to4 relay address'],
  ['192.168.0.0', 16, 'a private address'], ['198.18.0.0', 15, 'a benchmarking address'], ['198.51.100.0', 24, 'a documentation address'],
  ['203.0.113.0', 24, 'a documentation address'], ['224.0.0.0', 4, 'a multicast address'], ['240.0.0.0', 4, 'a reserved address'],
];
const V6: Range[] = [
  ['::', 128, 'the unspecified address'], ['::1', 128, 'a loopback address'], ['100::', 64, 'a discard address'], ['2001:db8::', 32, 'a documentation address'],
  ['fc00::', 7, 'a private (unique local) address'], ['fe80::', 10, 'a link-local address'], ['fec0::', 10, 'a site-local address'], ['ff00::', 8, 'a multicast address'],
];

function v4Reason(ip: string): string | undefined {
  for (const [a, p, label] of V4) {
    const bl = new net.BlockList();
    bl.addSubnet(a, p, 'ipv4');
    if (bl.check(ip, 'ipv4')) return label;
  }
  return undefined;
}

/** IPv4 address embedded in an IPv6 address (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16), if any. */
function embeddedV4(ip6: string): string | undefined {
  const full = expandV6(ip6);
  if (!full) return undefined;
  const g = full.split(':').map((x) => parseInt(x, 16));
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return undefined;
}

function expandV6(ip: string): string | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(fill).fill('0'), ...t];
  if (parts.length !== 8) return undefined;
  return parts.map((x) => x.padStart(4, '0')).join(':');
}

/** Why an IP address may not be contacted, or undefined when it is a public address. */
export function blockedAddressReason(ip: string, policy: NetPolicy): string | undefined {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const r = v4Reason(ip);
    if (r && policy.allowLoopback && r === 'a loopback address') return undefined;
    return r;
  }
  if (kind === 6) {
    const inner = embeddedV4(ip);
    if (inner) return blockedAddressReason(inner, policy);
    for (const [a, p, label] of V6) {
      const bl = new net.BlockList();
      bl.addSubnet(a, p, 'ipv6');
      if (bl.check(ip, 'ipv6')) return policy.allowLoopback && label === 'a loopback address' ? undefined : label;
    }
    return undefined;
  }
  return 'not an IP address';
}

const INTERNAL_NAME = /(^|\.)(localhost|internal|local|localdomain|home\.arpa|intranet|lan)$|^metadata(\.google\.internal)?$|^instance-data$/i;

/**
 * Why a website address may not be registered for crawling (Manage websites, SEED_WEBSITES), or undefined. No DNS lookup
 * here — a name that resolves to a blocked address is still refused on every request (assertAllowedUrl + connect-time
 * check) — but IP literals in blocked ranges, internal host names and embedded credentials are refused up front.
 */
export function registrationBlockReason(raw: string, policy: NetPolicy): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'it is not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https websites can be crawled';
  if (u.username || u.password) return 'URLs with a user name or password are not accepted';
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return 'the URL has no host';
  if (net.isIP(host)) {
    const why = blockedAddressReason(host, policy);
    return why ? `${host} is ${why}` : undefined;
  }
  if (INTERNAL_NAME.test(host) && !(policy.allowLoopback && /(^|\.)localhost$/.test(host))) return `${host} is an internal host name`;
  return undefined;
}

/** Rejects a URL that the crawler must never request. Resolves the host and checks every address. */
export async function assertAllowedUrl(raw: string, policy: NetPolicy, resolve: (host: string) => Promise<string[]> = resolveAll): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedDestinationError(`blocked: not a valid URL (${raw.slice(0, 120)})`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedDestinationError(`blocked: only http and https URLs can be crawled (${u.protocol})`);
  if (u.username || u.password) throw new BlockedDestinationError('blocked: URLs with embedded credentials are not crawled');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new BlockedDestinationError('blocked: URL has no host');
  if (net.isIP(host)) {
    const why = blockedAddressReason(host, policy);
    if (why) throw new BlockedDestinationError(`blocked: ${host} is ${why}`);
    return;
  }
  if (INTERNAL_NAME.test(host) && !(policy.allowLoopback && /(^|\.)localhost$/.test(host))) {
    throw new BlockedDestinationError(`blocked: ${host} is an internal host name`);
  }
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch (e) {
    throw new BlockedDestinationError(`could not resolve ${host}: ${(e as { code?: string }).code ?? (e as Error).message}`);
  }
  if (!addrs.length) throw new BlockedDestinationError(`could not resolve ${host}`);
  for (const a of addrs) {
    const why = blockedAddressReason(a, policy);
    if (why) throw new BlockedDestinationError(`blocked: ${host} resolves to ${a}, ${why}`);
  }
}

async function resolveAll(host: string): Promise<string[]> {
  const r = await dns.promises.lookup(host, { all: true, verbatim: true });
  return r.map((x) => x.address);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

/** net.connect `lookup` that refuses blocked addresses at connect time (defeats DNS rebinding). */
function guardedLookup(policy: NetPolicy) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = addresses as dns.LookupAddress[];
      const bad = list.find((a) => blockedAddressReason(a.address, policy));
      if (bad || !list.length) {
        const e = new BlockedDestinationError(bad ? `blocked: ${hostname} resolves to ${bad.address}, ${blockedAddressReason(bad.address, policy)}` : `could not resolve ${hostname}`) as unknown as NodeJS.ErrnoException;
        return cb(e);
      }
      if (options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

/**
 * fetch() that enforces the policy on the first URL, on every redirect hop (redirects are followed manually unless the
 * caller asked for `redirect: 'manual'`) and again at connect time.
 */
export function createGuardedFetch(policy: NetPolicy, maxRedirects = 5): typeof fetch {
  const agent = new Agent({ connect: { lookup: guardedLookup(policy) as never }, connections: 16 });
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const follow = init.redirect !== 'manual';
    let method = init.method ?? 'GET';
    for (let hop = 0; ; hop++) {
      await assertAllowedUrl(url, policy);
      const res = (await undiciFetch(url, { ...(init as object), method, redirect: 'manual', dispatcher: agent } as never)) as unknown as Response;
      const loc = res.headers.get('location');
      if (!follow || res.status < 300 || res.status >= 400 || !loc) return res;
      await res.body?.cancel().catch(() => undefined);
      if (hop >= maxRedirects) throw new BlockedDestinationError(`more than ${maxRedirects} redirects`);
      url = new URL(loc, url).toString();
      if (res.status === 303) method = 'GET';
    }
  }) as typeof fetch;
}
