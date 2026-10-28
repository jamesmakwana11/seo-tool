import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Issue, SeoBulkItem, SeoBulkJob, ShopifyApplyPreview } from '@sentinel/shared';

/**
 * Bulk SEO fixes and the review step, with a mocked API: the bulk dialog shows a summary before anything is written,
 * lets changes be excluded, applies once (double clicks ignored) and reports per change; the SEO editor's review has
 * no typed phrase — selectable changes and one "Apply changes" button; the Issues board has no SLA column and a
 * Fix all action beside Detected.
 */
const fake = vi.hoisted(() => ({ calls: [] as string[], applyArgs: [] as unknown[], selects: [] as unknown[], state: 'ready' as string }));

const item = (done = false): SeoBulkItem => ({
  url: 'https://shop.example/products/chopper', title: 'Vegetable Chopper', pageType: 'product', kind: 'product', resourceId: 'gid://shopify/Product/1', included: true, issueIds: ['ISS-1'], status: done ? 'done' : 'planned',
  changes: [
    { key: 'seoTitle', field: 'seoTitle', label: 'SEO title (meta title)', current: 'x'.repeat(90), proposed: 'Vegetable Chopper', reason: 'Shortened.', problems: ['Too long'], included: true, confidence: 'high', ...(done ? { result: { status: 'verified' as const } } : {}) },
    { key: 'title', field: 'h1', label: 'H1 heading (the theme prints the title)', current: 'VEGETABLE CHOPPER', proposed: 'Vegetable Chopper', reason: 'Changed from all capitals.', problems: ['All capitals'], included: false, confidence: 'review' },
  ],
  ...(done ? { score: { before: 40, after: 75 } } : {}),
});
const job = (state: SeoBulkJob['state']): SeoBulkJob => ({
  id: 'SBF-1', scope: 'issues', fields: ['seoTitle', 'h1'], createdBy: 'Ritesh', createdAt: '', updatedAt: '', state,
  progress: { phase: state === 'scanning' ? 'Reading open issues' : 'Ready for review', done: 1, total: 2 },
  scan: { pagesScanned: 2, candidates: 1, capped: false, cap: 2000 },
  summary: { pages: 1, changes: 2, selectedPages: 1, selectedChanges: 1, reviewChanges: 1, byField: { seoTitle: { pages: 1, changes: 1 }, h1: { pages: 1, changes: 1 } }, manual: 1 },
  manual: [{ reason: 'Theme code or app settings: not something the Admin API can change safely.', detail: 'Review markup without visible reviews', count: 344, urls: [], issueId: 'ISS-2' }],
  ...(state === 'done' ? { result: { finishedAt: '', verified: 1, unverified: 0, failed: 0, conflicts: 0, skipped: 0, pagesRechecked: 1, issues: [{ issueId: 'ISS-1', title: 'Long titles', outcome: 'resolved' as const, details: 'Re-checked 1 URL(s): 0 failing.' }], message: 'Finished.' } } : {}),
});
const preview: ShopifyApplyPreview = {
  previewId: 'PV-1', expiresAt: '', total: 2, conflicts: 0,
  drafts: [{ id: 'SHD-1', resourceTitle: 'Shipment Tracking', kind: 'page', problems: [], changes: [
    { key: 'seoTitle', label: 'SEO title (meta title)', live: '', proposed: 'Shipment Tracking – Oblivion', conflict: false, mutation: 'metafieldsSet (global.title_tag)' },
    { key: 'seoDescription', label: 'Meta description', live: '', proposed: 'Track your order.', conflict: false, mutation: 'metafieldsSet (global.description_tag)' },
  ] }],
};

vi.mock('@/api/client', () => ({
  API_MODE: 'http',
  api: {
    startSeoBulkFix: async () => { fake.calls.push('start'); return job('scanning'); },
    getSeoBulkFix: async () => job(fake.state as SeoBulkJob['state']),
    listSeoBulkFixItems: async () => ({ total: 1, offset: 0, limit: 20, items: [item(fake.state === 'done')] }),
    selectSeoBulkFix: async (x: unknown) => { fake.selects.push(x); return { ...job('ready'), summary: { ...job('ready').summary, selectedChanges: 0, selectedPages: 0 } }; },
    applySeoBulkFix: async () => { fake.calls.push('apply'); await new Promise((r) => setTimeout(r, 30)); fake.state = 'done'; return job('applying'); },
    cancelSeoBulkFix: async () => job('cancelled'),
    previewShopifyApply: async () => preview,
    applyShopifyDrafts: async (ids: string[], review: unknown) => { fake.applyArgs.push({ ids, review }); await new Promise((r) => setTimeout(r, 30)); return { applied: 1, failed: 0, skipped: 0, drafts: [] }; },
    downloadShopifyBackup: async () => ({ filename: 'x.json', mimeType: 'application/json', content: '{}' }),
    listIssues: async () => ({ items: [{ id: 'ISS-1', checkId: 'ONP-TITLE', module: 'onpage', title: 'Long titles', severity: 'medium', highestTier: 3, affectedCount: 1, affectedUrls: [], delta: 'new', status: 'NEW', allocation: [], severityHistory: [], detectedAt: new Date().toISOString(), slaDueAt: new Date().toISOString() } as unknown as Issue], page: 1, pageSize: 25, total: 1 }),
    listEmployees: async () => [],
  },
}));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }), useUser: () => ({ name: 'Ritesh', role: 'seo_specialist' }) }));
vi.mock('@/components/crawls/LiveCrawl', () => ({ saveFile: () => undefined }));
vi.mock('@/hooks/lookups', () => ({ useEmployees: () => ({ list: [] }) }));

import { ToastProvider } from '../src/components/ui/Toast';
import { BulkFixDialog } from '../src/components/seo/BulkFixDialog';
import { ApplyDialog } from '../src/pages/shopify/SeoEditorPage';
import IssuesBoardPage from '../src/pages/issues/IssuesBoardPage';

const wrap = (ui: React.ReactNode) => render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ToastProvider>{ui}</ToastProvider></QueryClientProvider></MemoryRouter>);
afterEach(() => { cleanup(); fake.calls = []; fake.applyArgs = []; fake.selects = []; fake.state = 'ready'; });

describe('bulk fix dialog', () => {
  it('shows the review summary, lets a change be excluded, applies once and reports per change', async () => {
    wrap(<BulkFixDialog title="Fix all eligible issues" start={{ scope: 'issues' }} onClose={() => undefined} />);
    expect(await screen.findByText('Reading open issues')).toBeInTheDocument(); // preparing: nothing written
    await waitFor(() => expect(screen.getByTestId('bulk-summary')).toBeInTheDocument(), { timeout: 3000 });
    const summary = within(screen.getByTestId('bulk-summary'));
    expect(summary.getByText('Pages to fix')).toBeInTheDocument();
    expect(await screen.findByLabelText('Include Vegetable Chopper')).toBeChecked();
    expect(screen.getByText('Review wording')).toBeInTheDocument();
    expect(within(screen.getByTestId('bulk-manual')).getByText(/Theme code or app settings/)).toBeInTheDocument();
    // The wording change is listed but not selected.
    expect((screen.getByLabelText('Apply H1 heading (the theme prints the title) on Vegetable Chopper') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Apply SEO title (meta title) on Vegetable Chopper'));
    await waitFor(() => expect(fake.selects).toEqual([{ jobId: 'SBF-1', url: 'https://shop.example/products/chopper', key: 'seoTitle', included: false }]));
    expect(await screen.findByRole('button', { name: /^Apply 0 changes/ })).toBeDisabled();
  });

  it('a double click applies once, then shows verified results and closed issues', async () => {
    wrap(<BulkFixDialog title="Fix all SEO issues" onClose={() => undefined} />);
    const btn = await screen.findByRole('button', { name: /^Apply 1 change on 1 page/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(fake.calls.filter((c) => c === 'apply')).toHaveLength(1);
    expect(await screen.findByTestId('bulk-result', {}, { timeout: 3000 })).toHaveTextContent('1 change(s) written and verified');
    expect(screen.getByText('Closed — re-check passed')).toBeInTheDocument();
    expect(await screen.findByText('Written and verified')).toBeInTheDocument();
    expect(screen.getByText(/score 40 →/)).toBeInTheDocument();
  });
});

describe('SEO editor review step', () => {
  it('has no typed phrase: changes are selectable and one click applies the reviewed selection once', async () => {
    wrap(<ApplyDialog ids={['SHD-1']} onClose={() => undefined} onDone={() => undefined} />);
    const apply = await screen.findByRole('button', { name: 'Apply 2 changes' });
    expect(screen.queryByText(/Type/)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Apply Meta description'));
    const one = await screen.findByRole('button', { name: 'Apply 1 change' });
    fireEvent.click(one);
    fireEvent.click(one);
    await waitFor(() => expect(fake.applyArgs).toHaveLength(1));
    expect(fake.applyArgs[0]).toEqual({ ids: ['SHD-1'], review: { previewId: 'PV-1', exclude: { 'SHD-1': ['seoDescription'] } } });
    void apply;
  });
});

describe('Issues board', () => {
  it('has no SLA column and offers Fix all beside Detected', async () => {
    wrap(<IssuesBoardPage />);
    expect(await screen.findByText('Long titles')).toBeInTheDocument();
    expect(screen.queryByText('SLA')).not.toBeInTheDocument();
    const header = screen.getByText('Detected').closest('th')!;
    fireEvent.click(within(header).getByRole('button', { name: 'Fix all' }));
    expect(await screen.findByText('Fix all eligible issues')).toBeInTheDocument();
    await waitFor(() => expect(fake.calls).toContain('start'));
  });
});
