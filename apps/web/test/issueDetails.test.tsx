import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { auditPage, type CrawledUrl, type CrawlPageReport } from '@sentinel/shared';

/** Every page-audit finding expands to the exact page, values and related pages / images / links (mocked API). */
const fake = vi.hoisted(() => ({ duplicates: undefined as unknown as CrawlPageReport['duplicates'], pageCalls: 0 }));
vi.mock('@/api/client', () => ({
  API_MODE: 'http',
  api: {
    getCrawlPage: async () => { fake.pageCalls++; return { runId: 'CRL-1', row: {}, audit: {}, limits: {}, duplicates: fake.duplicates }; },
    getCrawlPages: async () => ({ total: 0, offset: 0, limit: 1, rows: [], facets: { status: {}, problem: {}, crawlState: {}, source: {}, template: {}, indexable: {}, check: { 'title-duplicate': 4, 'meta-missing': 12, 'alt-missing': 30, 'images-repeated': 7, 'broken-links': 2 } } }),
  },
}));

import { ToastProvider } from '../src/components/ui/Toast';
import { AuditChecks } from '../src/components/crawls/PageAudit';

afterEach(cleanup);
const O = 'https://oblivion.test';
const row = (over: Partial<CrawledUrl> = {}): CrawledUrl => ({
  url: `${O}/policies/shipping-policy`, status: 200, finalStatus: 200, reason: 'full', template: 'page', contentType: 'text/html',
  title: 'Shipping policy – Oblivion', metaDescription: undefined, h1: ['Shipping policy'], canonical: `${O}/policies/shipping-policy`, indexable: true, wordCount: 300,
  internalLinks: 40, inlinks: 3, images: 9, imagesMissingAlt: 2, imagesMissingAltSrc: ['https://cdn.shopify.com/s/files/1/x/logo.png', 'https://cdn.shopify.com/s/files/1/x/badge.png'],
  flags: ['dup-title'], brokenLinks: [`${O}/products/gone`], brokenLinkDetails: [{ url: `${O}/products/gone`, status: 404, error: 'Not found (404)' }],
  repeatedImages: [{ src: 'https://cdn.shopify.com/s/files/1/x/oblivion-google-play-badge.png', count: 2, instances: [
    { position: 3, alt: null, inMain: false, location: 'header › section "header" › .header__badge' },
    { position: 8, alt: '', inMain: false, location: 'footer › section "footer" › .footer__app-badge' },
  ] }],
  ...over,
});

function show(r: CrawledUrl, duplicates?: CrawlPageReport['duplicates']) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuditChecks audit={auditPage(r)} only="problems" template={r.template} context={{ row: r, runId: 'CRL-1', duplicates }} />
      </MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}

describe('expandable issue details', () => {
  it('duplicate title: the shared text, its length, every other page (clickable) and the crawl-wide count', async () => {
    fake.duplicates = { title: { text: 'Shipping policy – Oblivion', urls: [`${O}/policies/refund-policy`, `${O}/policies/privacy-policy`, `${O}/policies/terms-of-service`], total: 3 }, meta: { urls: [], total: 0 }, h1: { urls: [], total: 0 } };
    show(row());
    expect(screen.queryByTestId('details-title-duplicate')).toBeNull(); // collapsed until opened
    fireEvent.click(screen.getByTestId('details-toggle-title-duplicate'));
    const d = await screen.findByTestId('dup-title');
    expect(d.textContent).toMatch(/"Shipping policy – Oblivion" \(26 characters\)/);
    expect(d.textContent).toMatch(/4 pages — this one and 3 others/);
    const list = within(d).getByTestId('dup-title-urls');
    for (const p of ['refund-policy', 'privacy-policy', 'terms-of-service']) {
      expect(within(list).getByText(`/policies/${p}`).closest('a')?.getAttribute('href')).toBe(`/pages/report?run=CRL-1&url=${encodeURIComponent(`${O}/policies/${p}`)}`);
    }
    const wide = await screen.findByText(/List all 4/);
    expect(wide.closest('a')?.getAttribute('href')).toBe('/pages?run=CRL-1&check=title-duplicate');
    expect(screen.getByTestId('crawl-wide-title-duplicate').textContent).toMatch(/4 pages of this crawl have this finding/);
  });

  it('missing meta, missing ALT, repeated images and broken links each show the exact elements', async () => {
    fake.duplicates = { title: { urls: [], total: 0 }, meta: { urls: [], total: 0 } };
    show(row());
    fireEvent.click(screen.getByTestId('details-all'));
    const meta = screen.getByTestId('details-meta-missing');
    expect(meta.textContent).toMatch(/None on the page/);
    expect(meta.textContent).toMatch(/recommended 70–160/);
    expect(within(meta).getByText(`${O}/policies/shipping-policy`).closest('a')?.getAttribute('href')).toBe(`${O}/policies/shipping-policy`);

    const alt = screen.getByTestId('alt-images');
    expect(alt.textContent).toMatch(/2 of 9 images on this page without ALT text/);
    const thumbs = within(alt).getAllByTestId('thumb');
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0].getAttribute('src')).toBe('https://cdn.shopify.com/s/files/1/x/logo.png?width=80'); // Shopify CDN thumbnail, not the full image
    expect(thumbs[0].getAttribute('referrerpolicy')).toBe('no-referrer');

    const rep = screen.getByTestId('repeated-images');
    expect(rep.textContent).toMatch(/Shown 2× on this page/);
    expect(within(rep).getByText('header › section "header" › .header__badge')).toBeTruthy();
    expect(within(rep).getByText('footer › section "footer" › .footer__app-badge')).toBeTruthy();
    expect(within(rep).getByText('https://cdn.shopify.com/s/files/1/x/oblivion-google-play-badge.png').closest('a')).toBeTruthy();

    const broken = screen.getByTestId('broken-links-table');
    expect(broken.textContent).toMatch(/Source page/);
    expect(broken.textContent).toMatch(/404/);
    expect(broken.textContent).toMatch(/Not found \(404\)/);
    expect(within(broken).getByText('/products/gone').closest('a')?.getAttribute('href')).toBe(`${O}/products/gone`);
  });

  it('says what could not be identified on an older crawl instead of inventing it', async () => {
    fake.duplicates = { title: { urls: [], total: 0 }, meta: { urls: [], total: 0 } };
    show(row({ imagesMissingAlt: 5, imagesMissingAltSrc: ['https://cdn.shopify.com/s/files/1/x/logo.png'], repeatedImages: undefined, brokenLinkDetails: undefined }));
    fireEvent.click(screen.getByTestId('details-all'));
    expect((await screen.findByTestId('dup-title')).textContent).toMatch(/could not be identified/i);
    expect(screen.getByTestId('alt-images').textContent).toMatch(/4 image addresses could not be identified/);
    expect(screen.getByTestId('broken-links-table').textContent).toMatch(/not recorded/);
  });
});

import { EvidenceList } from '../src/components/domain/lists';

describe('issue evidence', () => {
  it('a duplicate-title issue lists the shared title and every page of the group, clickable', () => {
    const urls = Array.from({ length: 14 }, (_, i) => `${O}/pages/p${i}`);
    render(<ToastProvider><EvidenceList evidence={[{ id: 'e1', kind: 'html_snippet', label: '14 pages share this title', url: urls[0], content: '<title>Same</title>', data: { duplicateOf: 'title', text: 'Same', urls, total: 14 }, capturedAt: '2026-10-24T06:00:00Z', source: 'live' }]} /></ToastProvider>);
    const box = screen.getByTestId('evidence-urls');
    expect(box.textContent).toMatch(/Shared title: "Same" \(4 characters\)/);
    expect(box.textContent).toMatch(/14 pages/);
    fireEvent.click(within(box).getByText('Show all 14'));
    expect(within(box).getByText('/pages/p13').closest('a')?.getAttribute('href')).toBe(`${O}/pages/p13`);
  });
});
