import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * The issue-allocation section ("Allocate this fix" + "Fix with … Team" buttons) is gone from every screen that showed
 * it — issue detail, template-level issues, daily digest — while Acknowledge, Not an issue, status, recommendations and
 * the estimated time stay. Rendered against the test fixture API (fixed sample data).
 */
const holder = vi.hoisted(() => ({ api: undefined as unknown as Record<string, unknown> }));
vi.mock('@/api/client', () => ({ api: new Proxy({}, { get: (_t, k) => holder.api[k as string] }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: { id: 'EMP-0001', name: 'Admin', role: 'admin', teamIds: [] } }) }));

import { FIXTURE_PASSWORD } from '@sentinel/shared';
import { createMockApi } from './support/fixtureApi';
import { ToastProvider } from '../src/components/ui/Toast';
import IssueDetailPage from '../src/pages/issues/IssueDetailPage';
import IssueGroupsPage from '../src/pages/issues/IssueGroupsPage';
import DailyDigestPage from '../src/pages/reports/DailyDigestPage';

beforeAll(async () => {
  // Charts measure their container; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  sessionStorage.clear();
  const api = createMockApi({ latencyMs: [0, 0], now: () => new Date('2026-10-12T06:00:00Z') });
  await api.login('aarav.admin@team.deodap.local', FIXTURE_PASSWORD);
  holder.api = api as unknown as Record<string, unknown>;
});
afterEach(cleanup);

function show(ui: ReactNode, at: string, route: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><MemoryRouter initialEntries={[at]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Routes><Route path={route} element={ui} /></Routes></MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}
const noAllocation = () => {
  expect(screen.queryByText(/Allocate this fix|Allocate the template fix/)).toBeNull();
  expect(screen.queryAllByRole('button', { name: /^Fix with/ })).toHaveLength(0);
};

describe('issue-allocation section removed', () => {
  it('issue detail: no allocation section; title, id, severity, Acknowledge, Not an issue, status, fix time stay', async () => {
    show(<IssueDetailPage />, '/issues/ISS-0001', '/issues/:id');
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    noAllocation();
    expect(screen.getAllByText('ISS-0001').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not an issue' })).toBeInTheDocument();
    expect(screen.getAllByText(/Critical/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('fix-time')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How to fix it, step by step' })).toBeInTheDocument();
  });

  it('template-level issues and the daily digest: no allocation buttons', async () => {
    show(<IssueGroupsPage />, '/issues/groups', '/issues/groups');
    expect(await screen.findByText('Why issues are grouped')).toBeInTheDocument();
    await screen.findAllByText(/Child issues/);
    noAllocation();
    cleanup();
    show(<DailyDigestPage />, '/reports/daily', '/reports/daily');
    await screen.findAllByText(/Allocation status/);
    noAllocation();
  });

  it('no screen of the web app renders the allocation buttons any more', () => {
    const root = path.resolve(__dirname, '../src');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f.name) && /AllocationButtons|Allocate this fix|Fix with \$\{|>Fix with /.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
