import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ShopifyThemeProposal } from '@sentinel/shared';

/** A theme proposal for the live theme: download the original first, then type the live-theme phrase; the storefront H1 check is shown. */
const fake = vi.hoisted(() => ({ applied: [] as string[], backups: 0 }));
const proposal: ShopifyThemeProposal = {
  id: 'TP-1', themeId: 't1', themeName: 'Dawn (live)', themeRole: 'MAIN', filename: 'sections/main-collection-banner.liquid', reason: 'H1 change',
  diff: [{ op: '-', text: '<h1>Shop Our Range</h1>' }, { op: '+', text: '<h1>Kitchen Tools</h1>' }], added: 1, removed: 1,
  createdBy: 'Dev', createdAt: '2026-10-27T10:00:00Z', status: 'proposed', confirmPhrase: 'WRITE TO LIVE THEME Dawn (live)', live: true,
} as ShopifyThemeProposal;

vi.mock('@/api/client', () => ({
  api: {
    downloadShopifyThemeBackup: async () => { fake.backups++; return { filename: 'x.liquid', mimeType: 'text/plain', content: 'x' }; },
    applyShopifyThemeProposal: async (_id: string, phrase: string) => {
      fake.applied.push(phrase);
      return { ...proposal, status: 'applied', backupTakenAt: '2026-10-27T10:01:00Z', result: { at: '', by: 'Dev', verified: true, message: 'Written to the live theme', liveCheck: { url: 'https://shop.example/collections/kitchen-tools', expected: 'Kitchen Tools', found: ['Kitchen Tools'], ok: true } } };
    },
  },
}));
vi.mock('@/components/crawls/LiveCrawl', () => ({ saveFile: () => undefined }));

import { ToastProvider } from '../src/components/ui/Toast';
import { ProposalDialog } from '../src/components/shopify/ThemeWork';

afterEach(cleanup);

describe('live theme proposal', () => {
  it('requires the backup download and the live-theme phrase, then shows the storefront check', async () => {
    render(<QueryClientProvider client={new QueryClient()}><ToastProvider><ProposalDialog p={proposal} onClose={() => undefined} /></ToastProvider></QueryClientProvider>);
    expect(screen.getByText(/customers see the change immediately/)).toBeTruthy();
    const write = screen.getByRole('button', { name: /Write to Dawn \(live\)/ }) as HTMLButtonElement;
    const input = screen.getByLabelText(/to write the file/) as HTMLInputElement;
    expect(write.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Download original file/ }));
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: 'APPLY TO Dawn (live)' } });
    expect(write.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'WRITE TO LIVE THEME Dawn (live)' } });
    expect(write.disabled).toBe(false);
    fireEvent.click(write);
    await screen.findByText('Storefront shows the new H1');
    expect(fake.backups).toBe(1);
    expect(fake.applied).toEqual(['WRITE TO LIVE THEME Dawn (live)']);
  });
});
