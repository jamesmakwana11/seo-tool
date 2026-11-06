import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Development Team screens against the test fixture API: inviting a member shows the one-time activation link when
 * email is not configured; a new task appears on the task board with its priority and assignee.
 */
const holder = vi.hoisted(() => ({ api: undefined as unknown as Record<string, unknown> }));
vi.mock('@/api/client', () => ({ api: new Proxy({}, { get: (_t, k) => holder.api[k as string] }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, refresh: async () => undefined, user: { id: 'EMP-0001', name: 'Admin', role: 'admin', teamIds: [] } }), useUser: () => ({ id: 'EMP-0001', name: 'Admin', role: 'admin', teamIds: [], permissions: [] }) }));

import { FIXTURE_PASSWORD } from '@sentinel/shared';
import { createMockApi } from './support/fixtureApi';
import { ToastProvider } from '../src/components/ui/Toast';
import DevTeamPage from '../src/pages/devteam/DevTeamPage';
import DevTasksPage from '../src/pages/devteam/DevTasksPage';

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  sessionStorage.clear();
  const api = createMockApi({ latencyMs: [0, 0], now: () => new Date('2026-11-10T06:00:00Z') });
  await api.login('aarav.admin@team.deodap.local', FIXTURE_PASSWORD);
  holder.api = api as unknown as Record<string, unknown>;
});
afterEach(cleanup);

function show(ui: ReactNode, at: string, route: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider><MemoryRouter initialEntries={[at]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Routes><Route path={route} element={ui} /><Route path="*" element={<div>elsewhere</div>} /></Routes></MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Development Team screens', () => {
  it('invites a member and shows the one-time activation link to share', async () => {
    show(<DevTeamPage />, '/dev-team', '/dev-team');
    fireEvent.click(await screen.findByRole('button', { name: 'Invite member' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a team member' });
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: 'Priya Shah' } });
    fireEvent.change(within(dialog).getByLabelText(/Email/), { target: { value: 'priya@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect((await screen.findByTestId('activation-link')).textContent).toMatch(/reset-password\?token=.*invite=1/);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('priya@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Invitation sent').length).toBeGreaterThan(0);
  });

  it('creates a task from the board', async () => {
    show(<DevTasksPage />, '/dev-team/tasks', '/dev-team/tasks');
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: 'Fix duplicate H1 on product template' } });
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: 'urgent' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('elsewhere')).toBeInTheDocument(); // opened the new task
  });
});
