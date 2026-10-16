import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { auditPage, type CrawledUrl } from '@sentinel/shared';
import { AuditChecks, ScoreBadge } from '../src/components/crawls/PageAudit';

const row: CrawledUrl = {
  url: 'https://store.example/products/chopper', status: 200, finalStatus: 200, reason: 'full', template: 'product', contentType: 'text/html',
  title: 'Chopper', metaDescription: undefined, h1: ['Chopper'], canonical: 'https://store.example/products/chopper', indexable: true, wordCount: 300, internalLinks: 20, inlinks: 2, brokenLinks: [], images: 3, imagesMissingAlt: 1,
};

describe('page audit view', () => {
  it('lists the problems with their recommendations, and everything by area in the full view', () => {
    const audit = auditPage(row);
    const { unmount } = render(<AuditChecks audit={audit} only="problems" />);
    expect(screen.getByText('Meta description missing')).toBeTruthy();
    expect(screen.getByText('Title too short')).toBeTruthy();
    expect(screen.getByText(/1 of 3 images without ALT text/)).toBeTruthy();
    expect(screen.getByText(/Write a 70–160 character summary/)).toBeTruthy();
    expect(screen.queryByText('One H1')).toBeNull(); // passing checks are left out of the problem list
    unmount();
    render(<AuditChecks audit={audit} />);
    expect(screen.getByText('One H1')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Images' })).toBeTruthy();
  });

  it('shows the score, or a dash when the page is not scored', () => {
    render(<><ScoreBadge score={65} /><ScoreBadge /></>);
    expect(screen.getByTitle('Page audit score 65 / 100').textContent).toBe('65');
    expect(screen.getByText('—')).toBeTruthy();
  });
});
