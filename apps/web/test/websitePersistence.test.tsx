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
