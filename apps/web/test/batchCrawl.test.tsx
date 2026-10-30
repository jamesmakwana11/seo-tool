import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CrawlBatch, CrawlBatchInput, CrawlBatchJob, WebsiteSummary } from '@sentinel/shared';

/** "Crawl several websites": choose up to 11 websites, start one batch, follow each website's crawl and cancel one. */
const fake = vi.hoisted(() => ({ started: [] as CrawlBatchInput[], cancelled: [] as string[], batch: undefined as CrawlBatch | undefined }));

const SITES: WebsiteSummary[] = Array.from({ length: 12 }, (_, i) => ({
  id: `site-${i + 1}`, name: `Store ${i + 1}`, url: `https://store${i + 1}.test/`, domain: `store${i + 1}.test`, platform: 'shopify', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  createdByName: 'Owner', source: 'manual', hasAuditData: false, openIssues: { critical: 0, medium: 0, low: 0 }, integrationsConnected: 0, integrationsTotal: 0,
} as WebsiteSummary));

function batchOf(ids: string[]): CrawlBatch {
  const jobs: CrawlBatchJob[] = ids.map((id, i) => {
    const status = i < 3 ? 'running' : 'queued';
    return {
      websiteId: id, websiteName: SITES.find((s) => s.id === id)!.name, domain: `${id}.test`, runId: 'CRL-0001', status,
      run: { id: 'CRL-0001', type: 'smart', status, trigger: 'manual', urlsPlanned: 0, urlsCrawled: i < 3 ? 12 : 0, urlsFailed: 0, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], source: 'live', ...(i >= 3 ? { phase: 'waiting', queue: { position: i - 2, waiting: ids.length - 3, reason: '3 of 3 crawl slots are in use (CRAWLER_MAX_CONCURRENT_JOBS)' } } : { phase: 'crawling' }) },
    };
  });
  return {
    id: 'BAT-ABC123', createdAt: '2026-10-21T04:00:00Z', createdBy: 'Owner', type: 'smart', jobs, finished: false,
    counts: { scheduled: 0, running: 3, queued: ids.length - 3, completed: 0, failed: 0, cancelled: 0, not_started: 0 },
    server: { running: 3, waiting: ids.length - 3, maxRunning: 3, blockedBy: '3 of 3 crawl slots are in use (CRAWLER_MAX_CONCURRENT_JOBS)' },
  };
}

vi.mock('@/api/client', () => ({
  api: {
    listCrawlBatches: async () => (fake.batch ? [fake.batch] : []),
    startCrawlBatch: async (input: CrawlBatchInput) => { fake.started.push(input); fake.batch = batchOf(input.websiteIds); return fake.batch; },
    getCrawlBatch: async () => fake.batch,
    cancelCrawlBatch: async () => fake.batch,
    cancelCrawlBatchJob: async (_id: string, websiteId: string) => { fake.cancelled.push(websiteId); return fake.batch; },
  },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/websites/WebsiteContext', () => ({ useWebsites: () => ({ websites: SITES, loading: false, error: undefined, select: () => undefined, websiteId: 'site-1' }) }));

import { ToastProvider } from '../src/components/ui/Toast';
import BatchCrawlPage from '../src/pages/websites/BatchCrawlPage';

afterEach(() => { cleanup(); fake.batch = undefined; fake.started = []; fake.cancelled = []; });

function show() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><BatchCrawlPage /></MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Crawl several websites', () => {
  it('selects at most 11 websites, starts one batch and shows each website with its own status', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Select the first 11' }));
    expect(screen.getByText('11 of at most 11 selected')).toBeTruthy();
    const twelfth = screen.getByRole('checkbox', { name: /Store 12/ }) as HTMLInputElement;
    expect(twelfth.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Start 11 crawls/ }));
    await waitFor(() => expect(fake.started).toEqual([{ websiteIds: SITES.slice(0, 11).map((s) => s.id), type: 'smart' }]));
    expect(await screen.findByText(/Batch BAT-ABC123/)).toBeTruthy();
    expect(screen.getByTestId('batch-count-running').textContent).toBe('3');
    expect(screen.getByTestId('batch-count-queued').textContent).toBe('8');
    expect(screen.getByTestId('batch-server').textContent).toMatch(/at most 3 crawls at the same time/);
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Running').length).toBe(3);
    expect(within(table).getAllByText('Queued').length).toBe(8);
    expect(within(table).getByText('Position 1 of 8')).toBeTruthy();
  });

  it('cancels one website\'s crawl only', async () => {
    fake.batch = batchOf(SITES.slice(0, 11).map((s) => s.id));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the crawl of Store 5' }));
    await waitFor(() => expect(fake.cancelled).toEqual(['site-5']));
  });
});
