import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** The selected website survives a browser refresh; finished crawls refresh that website's screens without a reload. */
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetModules(); });

describe('website selection', () => {
  it('is remembered across a page reload (new module instance), not reset to the primary website', async () => {
    const a = await import('../src/api/websiteScope');
    expect(a.websiteScope.get()).toBe('site-deodap');
    a.websiteScope.set('site-grab');
    expect(localStorage.getItem('sentinel.website')).toBe('site-grab');
    vi.resetModules(); // like a browser refresh: the module state is gone, the browser storage is not
    const b = await import('../src/api/websiteScope');
    expect(b.websiteScope.get()).toBe('site-grab');
  });
});

describe('after a crawl finishes', () => {
  it('fetches the website\'s screens and the website list again', async () => {
    const { useRefreshWhenCrawlsFinish } = await import('../src/api/hooks');
    const { websiteScope } = await import('../src/api/websiteScope');
    websiteScope.set('site-grab');
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { rerender } = renderHook(({ ids }: { ids: string[] | undefined }) => useRefreshWhenCrawlsFinish(ids), { wrapper, initialProps: { ids: undefined as string[] | undefined } });
    rerender({ ids: ['CRL-0002'] }); // running
    rerender({ ids: ['CRL-0002'] });
    expect(spy).not.toHaveBeenCalled();
    rerender({ ids: [] }); // finished
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([['site', 'site-grab'], ['websites']]);
  });
});

describe('starting a crawl that is already running', () => {
  it('reloads the crawl list so the running crawl (started in another tab or browser) and its progress are shown', async () => {
    const { useApiMutation } = await import('../src/api/hooks');
    const { ToastProvider } = await import('../src/components/ui/Toast');
    const { ApiError } = await import('@sentinel/shared');
    const { act, waitFor } = await import('@testing-library/react');
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
    const { result } = renderHook(() => useApiMutation(async () => { throw new ApiError(409, 'CRAWL_ALREADY_RUNNING', 'Crawl CRL-0004 is already running', { runId: 'CRL-0004' }); }, { invalidate: [['crawls']], silentError: true }), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([['site', 'site-deodap', 'crawls']]);
  });
});
