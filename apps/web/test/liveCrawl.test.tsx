import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(cleanup);
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CrawlerStatus, CrawlRun } from '@sentinel/shared';
import type { ReactNode } from 'react';
import { ToastProvider } from '../src/components/ui/Toast';
import { AuthProvider } from '../src/auth/AuthContext';
import { CrawlProgress, LiveCrawlForm } from '../src/components/crawls/LiveCrawl';

function wrap(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>{ui}</AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const status: CrawlerStatus = { ready: true, siteUrl: 'https://deodap.in/', maxPagesCap: 500, temporaryStorage: true, schedulerEnabled: false, respectsRobots: true, requestDelayMs: 250, maxBodyBytes: 5242880 };

describe('LiveCrawlForm', () => {
  it('defaults to All pages and No depth limit when the server has no page cap', () => {
    wrap(<LiveCrawlForm status={{ ...status, maxPagesCap: null }} onStarted={() => undefined} />);
    expect(screen.getByLabelText(/All pages \(no limit\)/)).toBeChecked();
    expect(screen.getByLabelText(/No depth limit/)).toBeChecked();
    expect(screen.queryByRole('spinbutton', { name: /Maximum pages/ })).toBeNull();
    expect(screen.getByText(/every page found through links and the sitemap is fetched/)).toBeInTheDocument();
  });

  it('prefills the selected website and shows inline errors for another host and out-of-range limits', () => {
    wrap(<LiveCrawlForm status={status} onStarted={() => undefined} />);
    const start = screen.getByLabelText(/Start URL/) as HTMLInputElement;
    expect(start.value).toBe('https://deodap.in/');
    fireEvent.change(start, { target: { value: 'https://evil.example/' } });
    fireEvent.change(screen.getByLabelText(/Maximum pages/), { target: { value: '501' } });
    fireEvent.change(screen.getByLabelText(/Request timeout/), { target: { value: '1' } });
    fireEvent.submit(start.closest('form')!);
    expect(screen.getByText(/must be on deodap\.in/)).toBeInTheDocument();
    expect(screen.getByText(/limits a crawl to 500 pages/)).toBeInTheDocument();
    expect(screen.getByText(/Request timeout must be between 2 and 60 seconds/)).toBeInTheDocument();
  });

  it('explains why live crawling is unavailable and disables Start', () => {
    wrap(<LiveCrawlForm status={{ ...status, ready: false, reason: 'CRAWLER_ALLOW_LIVE is not "true".' }} onStarted={() => undefined} />);
    expect(screen.getByText(/Live crawling is not available/)).toBeInTheDocument();
    expect(screen.getByText(/CRAWLER_ALLOW_LIVE is not/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start crawl/ })).toBeDisabled();
  });
});

describe('CrawlProgress', () => {
  it('shows the real counts reported by the server', () => {
    const run: CrawlRun = {
      id: 'CRL-0007', type: 'full', status: 'running', trigger: 'manual', startedAt: new Date().toISOString(), urlsPlanned: 40, urlsCrawled: 12, urlsFailed: 1,
      urlsDiscovered: 40, urlsSucceeded: 10, jsRenderedSample: 0, newIssues: 0, resolvedIssues: 0, recurringIssues: 0, scope: [], source: 'live',
      options: { startUrl: 'https://deodap.in/', maxPages: 50, maxDepth: 3, timeoutMs: 15000, concurrency: 2 },
    };
    wrap(<CrawlProgress run={run} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(screen.getByText('Discovered').nextSibling).toHaveTextContent('40');
    expect(screen.getByText('Successful').nextSibling).toHaveTextContent('10');
    expect(screen.getByText('Errors / no response').nextSibling).toHaveTextContent('2');
  });
});
