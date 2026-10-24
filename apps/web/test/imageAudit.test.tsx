import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ImageAuditItem, ImageAuditJob, ImageAuditListResponse, ImageAuditQuery, ImageAuditStatusResponse } from '@sentinel/shared';

/** Image Audit screen against a mocked API: start, progress, cancel, state / problem filters, export, details drawer. */
const fake = vi.hoisted(() => ({
  job: undefined as unknown as ImageAuditJob,
  started: [] as string[],
  cancelled: [] as string[],
  resumed: [] as string[],
  exported: [] as { format: string; query: ImageAuditQuery }[],
  lastQuery: undefined as ImageAuditQuery | undefined,
}));

const item = (url: string, over: Partial<ImageAuditItem>): ImageAuditItem => ({
  url, state: 'ok', pageCount: 1, pages: ['https://shop.test/products/a'], refs: 1, altMissing: 0, altEmpty: 0, noDimensions: 0, lazy: 0, eagerBelowFold: 0, inMain: true, issues: [], recommendations: [], ...over,
});
const ITEMS: ImageAuditItem[] = [
  item('https://shop.test/cdn/a.webp', { status: 206, finalStatus: 206, format: 'webp', bytes: 40_000, width: 800, height: 800, altText: 'Steel chopper' }),
  item('https://shop.test/cdn/missing.webp', { state: 'broken', status: 404, finalStatus: 404, reason: 'HTTP 404', issues: ['broken'], recommendations: ['Fix the file or its URL, or remove the <img> from the 1 page that show it (HTTP 404).'] }),
  item('https://shop.test/cdn/big.jpg', { status: 206, format: 'jpeg', bytes: 307_200, issues: ['heavy', 'legacy-format'], recommendations: ['Compress or resize: 300 KB (aim for under 200 KB).'], altMissing: 1 }),
  item('https://shop.test/cdn/later.webp', { state: 'pending' }),
];

vi.mock('@/api/client', () => ({
  API_MODE: 'http',
  api: {
    getImageAuditStatus: async (): Promise<ImageAuditStatusResponse> => ({
      runs: [{ runId: 'CRL-0007', type: 'full', startedAt: '2026-10-17T03:00:00Z', outcome: 'completed', pages: 120 }],
      jobs: fake.job ? [fake.job] : [], running: fake.job?.status === 'running' ? fake.job : undefined, available: true,
      limits: { maxImages: 50000, budgetMinutes: 10, concurrency: 4, probeKb: 64, maxHours: 12 }, storage: 'memory',
    }),
    startImageAudit: async (runId: string) => { fake.started.push(runId); return fake.job; },
    getImageAudit: async () => fake.job,
    resumeImageAudit: async (id: string) => { fake.resumed.push(id); fake.job = { ...fake.job, status: 'running', resumable: false }; return fake.job; },
    cancelImageAudit: async (id: string) => { fake.cancelled.push(id); fake.job = { ...fake.job, status: 'cancelled' }; return fake.job; },
    listImageAudit: async (_id: string, q: ImageAuditQuery): Promise<ImageAuditListResponse> => {
      fake.lastQuery = q;
      const rows = ITEMS.filter((i) => (!q.state || i.state === q.state) && (!q.issue || i.issues.includes(q.issue)));
      return { job: fake.job, total: rows.length, offset: 0, limit: 50, rows, facets: { state: { ok: 2, broken: 1, pending: 1 }, issue: { broken: 1, heavy: 1, 'legacy-format': 1 } } };
    },
    exportImageAudit: async (_id: string, format: string, query: ImageAuditQuery) => { fake.exported.push({ format, query }); return { filename: `x.${format}`, mimeType: 'text/csv', content: 'a' }; },
  },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/components/crawls/LiveCrawl', () => ({ saveFile: () => undefined }));

import { ToastProvider } from '../src/components/ui/Toast';
import ImageAuditPage from '../src/pages/crawls/ImageAuditPage';

afterEach(cleanup);

function show() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><ImageAuditPage /></MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}

const job = (status: ImageAuditJob['status']): ImageAuditJob => ({
  id: 'IMG-ABC123', runId: 'CRL-0007', status, startedAt: '2026-10-17T03:10:00Z', startedBy: 'Owner', pages: 120, references: 380, images: 4, inlineImages: 2, overLimit: 0,
  budgetMs: 600_000, heavyKb: 200, rounds: 1, resumable: status !== 'running',
  counts: { total: 4, pending: status === 'running' ? 1 : 0, checked: 3, finished: 3, ok: 2, broken: 1, failed: 0, unverified: 0, deferred: status === 'running' ? 0 : 1, reused: 0, requests: 3 },
});

describe('Image Audit screen', () => {
  it('starts an audit only on request and shows progress with a cancel button', async () => {
    fake.job = job('running');
    show();
    expect(await screen.findByText(/IMG-ABC123 · crawl CRL-0007/)).toBeTruthy();
    expect(screen.getByText(/4 unique images from 380 references on 120 pages/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Images with a final answer' }).getAttribute('aria-valuenow')).toBe('75');
    expect(screen.getByTestId('image-audit-progress').textContent).toMatch(/3 of 4 images answered \(75%\) · 1 pending · 0 deferred/);
    fireEvent.click(screen.getByRole('button', { name: /Cancel audit/ }));
    await waitFor(() => expect(fake.cancelled).toEqual(['IMG-ABC123']));
    // Start is disabled while one runs; nothing was started by just opening the page.
    expect(fake.started).toEqual([]);
  });

  it('filters by state and problem, explains an image and exports the filtered list', async () => {
    fake.job = job('completed');
    fake.exported = [];
    show();
    const table = await screen.findByRole('table');
    await within(table).findByText('/cdn/missing.webp');
    // State card → only broken images.
    fireEvent.click(screen.getByRole('button', { name: /^1\s*Broken$/ }));
    await waitFor(() => expect(fake.lastQuery?.state).toBe('broken'));
    await waitFor(() => expect(within(screen.getByRole('table')).queryByText('/cdn/a.webp')).toBeNull());
    fireEvent.click(within(screen.getByRole('table')).getByText('/cdn/missing.webp'));
    expect(await screen.findByText(/remove the <img> from the 1 page/)).toBeTruthy();
    expect(screen.getAllByText('HTTP 404').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(fake.exported).toEqual([{ format: 'csv', query: expect.objectContaining({ state: 'broken' }) }]));
  });

  it('never shows 100 % while images are deferred, and resumes with only those', async () => {
    fake.job = { ...job('partial'), counts: { ...job('partial').counts, total: 200, finished: 199, checked: 199, ok: 199, broken: 0, deferred: 1 } };
    fake.resumed = [];
    show();
    expect(await screen.findByText(/199 of 200 images answered \(99%\)/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Images with a final answer' }).getAttribute('aria-valuenow')).toBe('99');
    expect(screen.getByText('Partly done — resume to finish')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Resume \(1 left\)/ }));
    await waitFor(() => expect(fake.resumed).toEqual(['IMG-ABC123']));
  });

  it('shows 100 % only when every image is answered', async () => {
    fake.job = { ...job('completed'), resumable: false, counts: { ...job('completed').counts, finished: 4, checked: 4, ok: 3, deferred: 0 } };
    show();
    expect(await screen.findByText(/4 of 4 images answered \(100%\) · every image is answered/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull();
  });
});
