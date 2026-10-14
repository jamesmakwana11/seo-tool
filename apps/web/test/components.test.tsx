import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createSeed, generateFixCard, type ModuleScore } from '@sentinel/shared';
import { ToastProvider } from '../src/components/ui/Toast';
import { HealthScoreSummary, ModulePerformanceBars } from '../src/components/domain/HealthScore';
import { SeverityBadge, SlaCountdown } from '../src/components/domain/badges';
import type { ReactNode } from 'react';

// Components that call useAuth need the provider; FixCardView is rendered through a minimal stub context.
import { AuthProvider } from '../src/auth/AuthContext';
import { FixCardView } from '../src/components/domain/FixCardView';

function wrap(ui: ReactNode) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthProvider>{ui}</AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const NOW = new Date('2026-10-12T06:00:00Z');

const MODULES: ModuleScore[] = (['technical', 'onpage', 'content_ai', 'performance', 'offpage', 'aeo', 'geo'] as const).map((m, i) => ({
  module: m, label: `Module ${m}`, weight: [0.3, 0.2, 0.15, 0.1, 0.1, 0.08, 0.07][i], score: [62.4, 80, 71.5, 90, 55, 77, 68][i], contribution: 0,
  openIssues: { critical: i, medium: 2, low: 3 }, penalty: 0,
}));

describe('HealthScoreSummary', () => {
  it('shows the score out of 100 and no change chip without history', () => {
    wrap(<HealthScoreSummary score={70.7} modules={MODULES} />);
    expect(screen.getByText('SEO Health Score')).toBeInTheDocument();
    expect(screen.getByLabelText('SEO Health Score 70.7 out of 100')).toBeInTheDocument();
    expect(screen.queryByText(/vs 7 days ago/)).not.toBeInTheDocument();
  });
  it('shows the change only when a delta is supplied', () => {
    wrap(<HealthScoreSummary score={70.7} modules={MODULES} delta={-1.25} />);
    expect(screen.getByText(/vs 7 days ago/).parentElement).toHaveTextContent('−1.3');
  });
});

describe('ModulePerformanceBars', () => {
  it('renders one linked row per module with its real score and issue counts', () => {
    wrap(<ModulePerformanceBars modules={MODULES} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(7);
    expect(links[0]).toHaveAccessibleName(/Module technical: 62\.4 out of 100, weight 30%, 0 critical, 2 medium, 3 low/);
    expect(within(links[4]).getByText('55.0')).toBeInTheDocument();
    expect(within(links[2]).getByText('2 critical')).toBeInTheDocument();
  });
});

describe('badges', () => {
  it('SeverityBadge renders text, not just colour', () => {
    render(<SeverityBadge severity="critical" />);
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });
  it('SlaCountdown shows breach', () => {
    render(<SlaCountdown dueAt={new Date(Date.now() - 3 * 3600000).toISOString()} />);
    expect(screen.getByText(/SLA breached/)).toBeInTheDocument();
  });
});

describe('FixCardView', () => {
  it('renders every required Fix Card section for a seeded issue', () => {
    const s = createSeed(NOW);
    const issue = s.issues.find((i) => i.checkId === 'TECH-4XX')!;
    const card = generateFixCard(issue, s.config, { now: NOW });
    wrap(<FixCardView card={card} issue={issue} />);
    const art = screen.getByRole('article', { name: /Fix Card/ });
    for (const h of ["What's wrong", 'Why it matters', 'Affected URLs & page value', 'Evidence', 'Root cause (inferred)', 'Exact fix', 'Ownership, effort & impact', 'Verification']) {
      expect(within(art).getByRole('heading', { name: h })).toBeInTheDocument();
    }
    expect(within(art).getByText(/catalog cleanup without redirects/)).toBeInTheDocument();
    expect(within(art).getByText('Complete Fix Card')).toBeInTheDocument();
    expect(within(art).getByText(/Human approval required/)).toBeInTheDocument();
  });
});

describe('DetailError (detail pages: issue, task, crawl run, brief)', () => {
  const back = { to: '/crawls', label: 'Back to the Crawl Center' };
  it('404: the page heading names what is missing, explains it, and offers no pointless Retry', async () => {
    const { DetailError } = await import('../src/components/domain/DetailError');
    const { ApiError } = await import('@sentinel/shared');
    wrap(<DetailError error={new ApiError(404, 'NOT_FOUND', 'Crawl CRL-9 not found.')} what="Crawl run" id="CRL-9" back={back} onRetry={() => undefined} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Crawl run CRL-9 not found' })).toBeTruthy();
    expect(screen.getByText(/doesn't exist/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.getByRole('link', { name: back.label })).toBeTruthy();
  });
  it('403 uses the caller-supplied explanation; other failures offer Retry', async () => {
    const { DetailError } = await import('../src/components/domain/DetailError');
    const { ApiError } = await import('@sentinel/shared');
    const { unmount } = wrap(<DetailError error={new ApiError(403, 'FORBIDDEN', 'No.')} what="Task" id="TSK-1" back={back} onRetry={() => undefined} forbidden={{ title: 'This task belongs to another team', detail: 'Ask the team lead.' }} />);
    expect(screen.getByRole('heading', { level: 1, name: 'This task belongs to another team' })).toBeTruthy();
    unmount();
    wrap(<DetailError error={new ApiError(500, 'INTERNAL', 'Boom.')} what="Issue" id="ISS-1" back={back} onRetry={() => undefined} />);
    expect(screen.getByRole('heading', { level: 1, name: 'This issue could not load' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
