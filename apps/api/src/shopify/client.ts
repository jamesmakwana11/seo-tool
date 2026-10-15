/**
 * Shopify Admin GraphQL client with Shopify's rate limits handled:
 *  - cost-based throttling: waits when the bucket runs low, and retries THROTTLED errors after the restore time;
 *  - HTTP 429 (Retry-After), 5xx and network errors: bounded retries with back-off;
 *  - 401/403: no retry, a clear message (token revoked / scope missing).
 * The access token is only ever placed in the X-Shopify-Access-Token header and is scrubbed from every error message.
 */
import type { FetchLike } from '../connectors/http';
import { redact } from '../connectors/http';

export class ShopifyApiError extends Error {
  constructor(message: string, readonly info: { status?: number; code?: string; retryable?: boolean; userErrors?: { field?: string[] | null; message: string }[] } = {}) {
    super(message);
  }
}

export interface AdminClientOptions {
  shop: string;
  token: string;
  apiVersion: string;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
  /** Extra values to scrub from error text (e.g. the app secret). */
  secrets?: string[];
}

export interface AdminClientStats { requests: number; retries: number; throttledWaits: number; lastAvailable?: number; restoreRate?: number }

interface CostExt {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number };
}

export function createAdminClient(o: AdminClientOptions) {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 4;
  const url = `https://${o.shop}/admin/api/${o.apiVersion}/graphql.json`;
  const stats: AdminClientStats = { requests: 0, retries: 0, throttledWaits: 0 };
  const scrub = (s: string) => redact(s, [o.token, ...(o.secrets ?? [])]);
  /** Points to keep in the bucket before sending (a typical query here costs 10–60). */
  const RESERVE = 100;

  async function request<T = Record<string, unknown>>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      // Proactive: when the last response left the bucket low, wait for it to refill instead of being throttled.
      if (stats.lastAvailable !== undefined && stats.restoreRate && stats.lastAvailable < RESERVE) {
        const ms = Math.min(10_000, Math.ceil(((RESERVE - stats.lastAvailable) / stats.restoreRate) * 1000));
        stats.throttledWaits++;
        await sleep(ms);
        stats.lastAvailable = RESERVE;
      }
      stats.requests++;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await o.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': o.token },
          body: JSON.stringify({ query, variables }),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < maxRetries) { stats.retries++; await sleep(backoff(attempt)); continue; }
        throw new ShopifyApiError(scrub(`Shopify did not answer (${(e as Error).name === 'AbortError' ? 'timeout' : 'network error'}) after ${attempt + 1} attempts.`), { retryable: true, code: 'NETWORK' });
      }
      clearTimeout(timer);
      if (res.status === 429) {
        if (attempt < maxRetries) {
          stats.retries++;
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : backoff(attempt));
          continue;
        }
        throw new ShopifyApiError('Shopify rate limit: still refused (HTTP 429) after retries. Try again in a minute.', { status: 429, retryable: true, code: 'RATE_LIMITED' });
      }
      if (res.status >= 500) {
        if (attempt < maxRetries) { stats.retries++; await sleep(backoff(attempt)); continue; }
        throw new ShopifyApiError(`Shopify server error (HTTP ${res.status}) after ${attempt + 1} attempts.`, { status: res.status, retryable: true, code: 'SERVER' });
      }
      if (res.status === 401) throw new ShopifyApiError('Shopify rejected the access token (HTTP 401). Connect the store again.', { status: 401, code: 'UNAUTHORIZED' });
      if (res.status === 403) throw new ShopifyApiError('Shopify refused the request (HTTP 403): the app is missing an access scope or the staff account lacks permission.', { status: 403, code: 'FORBIDDEN' });
      if (res.status === 404) throw new ShopifyApiError(`Shopify Admin API not found for ${o.shop} (HTTP 404) — check the shop and API version ${o.apiVersion}.`, { status: 404, code: 'NOT_FOUND' });
      if (!res.ok) throw new ShopifyApiError(`Shopify answered HTTP ${res.status}.`, { status: res.status, code: 'HTTP' });
      let body: { data?: T; errors?: { message?: string; extensions?: { code?: string } }[]; extensions?: { cost?: CostExt } };
      try { body = (await res.json()) as typeof body; } catch { throw new ShopifyApiError('Shopify answered with something that is not JSON.', { code: 'BAD_RESPONSE' }); }
      const cost = body.extensions?.cost;
      if (cost?.throttleStatus) {
        stats.lastAvailable = cost.throttleStatus.currentlyAvailable;
        stats.restoreRate = cost.throttleStatus.restoreRate;
      }
      const errs = body.errors ?? [];
      if (errs.some((e) => e.extensions?.code === 'THROTTLED')) {
        if (attempt < maxRetries) {
          stats.retries++;
          stats.throttledWaits++;
          const need = (cost?.requestedQueryCost ?? 50) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
          const rate = cost?.throttleStatus?.restoreRate || 50;
          await sleep(Math.min(20_000, Math.max(1000, Math.ceil((need / rate) * 1000))));
          continue;
        }
        throw new ShopifyApiError('Shopify throttled the request (query cost) after retries.', { code: 'THROTTLED', retryable: true });
      }
      if (errs.length) {
        const code = errs.find((e) => e.extensions?.code)?.extensions?.code;
        const msg = errs.map((e) => e.message ?? 'error').slice(0, 3).join('; ');
        if (code === 'ACCESS_DENIED') throw new ShopifyApiError(scrub(`Access denied by Shopify: ${msg}. The app needs the matching access scope.`), { code });
        throw new ShopifyApiError(scrub(`Shopify GraphQL error: ${msg}`), { code: code ?? 'GRAPHQL' });
      }
      if (!body.data) throw new ShopifyApiError('Shopify returned no data.', { code: 'BAD_RESPONSE' });
      return body.data;
    }
  }

  return { request, stats, shop: o.shop };
}
export type AdminClient = ReturnType<typeof createAdminClient>;

const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt);

/** Throws when a mutation payload has userErrors (field-level validation from Shopify). */
export function checkUserErrors(payload: { userErrors?: { field?: string[] | null; message: string }[] } | null | undefined, what: string) {
  const ue = payload?.userErrors ?? [];
  if (ue.length) throw new ShopifyApiError(`${what}: ${ue.map((u) => `${u.field?.join('.') ?? ''} ${u.message}`.trim()).join('; ')}`, { code: 'USER_ERRORS', userErrors: ue });
  if (!payload) throw new ShopifyApiError(`${what}: Shopify returned no result.`, { code: 'BAD_RESPONSE' });
}
