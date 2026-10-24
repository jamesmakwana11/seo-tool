import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { WebsiteSummary } from '@sentinel/shared';
import { api } from '@/api/client';
import { WEBSITES_KEY, useWebsiteId } from '@/api/hooks';
import { demoScope, websiteScope } from '@/api/websiteScope';

interface WebsiteCtx {
  websiteId: string;
  websites: WebsiteSummary[] | undefined;
  current: WebsiteSummary | undefined;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  /** Switches the workspace. Detail pages (one issue, one crawl…) belong to a single website, so they fall back to their list. */
  select: (id: string, to?: string) => void;
}

const Ctx = createContext<WebsiteCtx | null>(null);

/** Detail routes whose id only exists inside one website. */
const DETAIL = /^\/(issues|crawls|opportunities\/briefs|modules\/technical)\/[^/]+/;
const DETAIL_KEEP = new Set(['/issues/groups', '/issues/exclusions']);

export function WebsiteProvider({ children }: { children: ReactNode }) {
  const websiteId = useWebsiteId();
  const nav = useNavigate();
  const { pathname } = useLocation();
  // Loaded from the server on every page load, again after a website is added (mutations invalidate it), when a crawl
  // finishes (useRefreshWhenCrawlsFinish), and every minute (scheduled crawls).
  const q = useQuery({ queryKey: WEBSITES_KEY, queryFn: () => api.listWebsites(), staleTime: 15000, refetchInterval: 60_000 });
  const websites = q.data;

  // The remembered selection may point at a website that no longer exists (e.g. in-memory data reset on restart).
  // (Skipped while the list is refetching — a just-added website is not in the stale list yet.)
  useEffect(() => {
    if (!q.isFetching && websites?.length && !websites.some((w) => w.id === websiteId)) websiteScope.set(websites[0].id);
  }, [websites, websiteId, q.isFetching]);

  const currentSource = websites?.find((w) => w.id === websiteId)?.source;
  useEffect(() => { demoScope.set(currentSource === undefined || currentSource === 'demo'); }, [currentSource]);

  const select = useCallback((id: string, to?: string) => {
    websiteScope.set(id);
    if (to) nav(to);
    else if (DETAIL.test(pathname) && !DETAIL_KEEP.has(pathname)) nav(`/${pathname.split('/')[1]}`);
  }, [nav, pathname]);

  const value = useMemo<WebsiteCtx>(() => ({
    websiteId, websites, current: websites?.find((w) => w.id === websiteId), loading: q.isLoading, error: q.error,
    refetch: () => void q.refetch(), select,
  }), [websiteId, websites, q, select]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWebsites(): WebsiteCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useWebsites must be used inside WebsiteProvider');
  return c;
}

/** The selected website's platform, or Shopify outside the website provider (tests, login). */
export function useSitePlatform(): WebsiteSummary['platform'] {
  return useContext(Ctx)?.current?.platform ?? 'shopify';
}

export function platformLabel(id: WebsiteSummary['platform']): string {
  return { shopify: 'Shopify', woocommerce: 'WooCommerce', magento: 'Magento', bigcommerce: 'BigCommerce', wordpress: 'WordPress', custom: 'Custom' }[id];
}
