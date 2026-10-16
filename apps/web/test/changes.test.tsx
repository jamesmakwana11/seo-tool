import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CaptureStatus, PageCapture, PageComparison, TextDiffView } from '@sentinel/shared';

/** Comparison views: diff rendering, side-by-side screenshots, and the "no previous screenshot" state (API mocked). */
const fake = vi.hoisted(() => ({
  compare: undefined as unknown as PageComparison,
  captures: [] as PageCapture[],
}));
vi.mock('@/api/client', () => ({
  API_MODE: 'http',
  api: {
    getCaptureStatus: async (): Promise<CaptureStatus> => ({
      available: false, problems: ['No Chrome / Chromium found on the API server.'], memoryNeededMB: 300,
      afterCrawl: { enabled: false, changedPages: 0, viewports: [] }, watch: [], jobs: [], limits: { keepPerPage: 3, maxPages: 200, maxHeight: 6000, concurrency: 1 },
    }),
    listCapturePages: async () => [],
    listCaptures: async () => fake.captures,
    compareCaptures: async () => fake.compare,
    getCaptureImage: async (id: string, kind: string) => new Blob([`${id}-${kind}`], { type: 'image/png' }),
    getMe: async () => { throw new Error('no session'); },
  },
}));

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

import { ToastProvider } from '../src/components/ui/Toast';
import { DiffView } from '../src/components/crawls/DiffView';
import ComparePage from '../src/pages/crawls/ComparePage';

afterEach(cleanup);
beforeEach(() => {
  let n = 0;
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => `blob:test/${++n}`, revokeObjectURL: () => undefined }));
});

function wrap(ui: ReactNode, path = '/') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes><Route path="/crawls/compare" element={ui} /><Route path="*" element={ui} /></Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const cap = (id: string, at: string): PageCapture => ({
  id, url: 'https://shop.test/', viewport: 'desktop', at, ok: true, status: 200, width: 1366, height: 1800, docHeight: 1800, trigger: 'manual',
  hasImage: true, hasHtml: true, hasDiffImage: id === 'CAP-2', fields: { title: id === 'CAP-2' ? 'New title' : 'Old title' }, diff: null,
});

describe('DiffView', () => {
  it('marks added and removed lines with both line numbers and collapses unchanged runs', () => {
    const diff: TextDiffView = {
      added: 1, removed: 1, truncated: false, coarse: false,
      lines: [{ op: ' ', text: '<head>', a: 0, b: 0 }, { op: '-', text: '<title>Old</title>', a: 1 }, { op: '+', text: '<title>New</title>', b: 1 }, { op: '…', text: '' }],
    };
    wrap(<DiffView diff={diff} label="Rendered HTML differences" />);
    const table = screen.getByRole('table', { name: 'Rendered HTML differences' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('2−<title>Old</title>');
    expect(rows[2]).toHaveTextContent('2+<title>New</title>');
    expect(rows[3]).toHaveTextContent('unchanged lines');
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('says so when nothing differs', () => {
    wrap(<DiffView diff={{ added: 0, removed: 0, truncated: false, coarse: false, lines: [] }} label="x" />);
    expect(screen.getByText('No line differs.')).toBeInTheDocument();
  });
});

describe('Compare page', () => {
  it('shows the previous and current screenshots side by side, and the pixel difference on request', async () => {
    fake.captures = [cap('CAP-2', '2026-10-16T08:00:00Z'), cap('CAP-1', '2026-10-15T08:00:00Z')];
    fake.compare = {
      url: 'https://shop.test/', viewport: 'desktop', from: fake.captures[1], to: { ...fake.captures[0], diff: { previousId: 'CAP-1', previousAt: '2026-10-15T08:00:00Z', ratio: 0.083, changedPixels: 1000, sizeChanged: false } },
      visual: { available: true, ratio: 0.083, sizeChanged: false, diffOf: ['CAP-1', 'CAP-2'] }, dom: { available: false, note: '' }, seoFields: [], assets: { available: true, items: [] }, change: null,
    };
    wrap(<ComparePage />, '/crawls/compare?url=https%3A%2F%2Fshop.test%2F');
    expect(await screen.findByAltText('Previous screenshot of https://shop.test/')).toHaveAttribute('src', expect.stringMatching(/^blob:/));
    expect(await screen.findByAltText('Current screenshot of https://shop.test/')).toBeInTheDocument();
    expect(screen.getByText(/8\.3 % of pixels differ/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Difference' }));
    expect(await screen.findByAltText('Difference (red = changed pixels) screenshot of https://shop.test/')).toBeInTheDocument();
    // The browser is not available on this server: the page says so.
    expect(screen.getByText('Screenshots are not available on this server')).toBeInTheDocument();
  });

  it('never makes up a previous screenshot', async () => {
    fake.captures = [cap('CAP-1', '2026-10-15T08:00:00Z')];
    fake.compare = {
      url: 'https://shop.test/', viewport: 'desktop', from: null, to: fake.captures[0],
      visual: { available: false, reason: 'Only one desktop capture of this page. No earlier screenshot exists, so there is nothing to compare with — a previous screenshot is never made up.' },
      dom: { available: false, reason: 'x', note: '' }, seoFields: [], assets: { available: false, reason: 'x', items: [] }, change: null,
    };
    wrap(<ComparePage />, '/crawls/compare?url=https%3A%2F%2Fshop.test%2F');
    expect(await screen.findByText(/a previous screenshot is never made up/)).toBeInTheDocument();
    expect(screen.getByText('No earlier screenshot of this page and viewport. None is made up.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1));
    expect(screen.queryByRole('radio', { name: 'Difference' })).toBeNull();
  });
});
