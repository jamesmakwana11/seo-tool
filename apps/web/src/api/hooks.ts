import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError } from '@sentinel/shared';
import { useToast } from '@/components/ui/Toast';
import { websiteScope } from './websiteScope';

/** The selected website. Every cached query is keyed by it, so two websites can never share cached data. */
export function useWebsiteId(): string {
  return useSyncExternalStore(websiteScope.subscribe, websiteScope.get);
}

export const WEBSITES_KEY = ['websites'] as const;

/** Prefixes a query key with the selected website (for direct QueryClient use). */
export function useSiteKey(): (k: QueryKey) => QueryKey {
  const site = useWebsiteId();
  return (k) => ['site', site, ...k];
}

/**
 * When crawls of the selected website finish (running / queued → completed, cancelled or failed), every screen's data
 * of that website (Health Score, Dashboard, Issues Board, audit modules, reports) and the website list are fetched
 * again — no browser reload needed.
 */
export function useRefreshWhenCrawlsFinish(activeIds: string[] | undefined) {
  const qc = useQueryClient();
  const site = useWebsiteId();
  const prev = useRef<{ site: string; ids: Set<string> }>();
  useEffect(() => {
    if (!activeIds) return;
    const now = new Set(activeIds);
    const before = prev.current?.site === site ? prev.current.ids : undefined;
    prev.current = { site, ids: now };
    if (before && [...before].some((id) => !now.has(id))) {
      void qc.invalidateQueries({ queryKey: ['site', site] });
      void qc.invalidateQueries({ queryKey: WEBSITES_KEY });
    }
  }, [activeIds?.join(','), site, qc]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Thin query wrapper so every screen gets loading / error / retry states the same way. */
export function useApiQuery<T>(key: QueryKey, fn: () => Promise<T>, opts: { enabled?: boolean; refetchInterval?: number } = {}) {
  const siteKey = useSiteKey();
  return useQuery({ queryKey: siteKey(key), queryFn: fn, enabled: opts.enabled, refetchInterval: opts.refetchInterval, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1 });
}

/**
 * Mutation wrapper: shows a success toast, surfaces API validation errors in a toast,
 * and invalidates the listed query-key prefixes (state stays consistent across screens).
 */
export function useApiMutation<V = void, R = unknown>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); invalidate?: QueryKey[]; onSuccess?: (r: R) => void; silentError?: boolean } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const siteKey = useSiteKey();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate ?? [[]]) void qc.invalidateQueries({ queryKey: siteKey(k) });
      // The website list / All-websites overview summarises every site — refresh it after any change.
      void qc.invalidateQueries({ queryKey: WEBSITES_KEY });
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success);
      opts.onSuccess?.(r);
    },
    onError: (e) => {
      if (!opts.silentError) toast.error(errorMessage(e));
    },
  });
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
