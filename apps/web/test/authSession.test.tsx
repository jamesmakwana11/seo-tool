import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, type SessionUser } from '@sentinel/shared';
import { api } from '../src/api/client';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';

function Probe() {
  const { user, ready, unreachable } = useAuth();
  return <p>{!ready ? `waiting${unreachable ? ' (unreachable)' : ''}` : user ? `signed in as ${user.email}` : 'signed out'}</p>;
}
const show = () => render(<QueryClientProvider client={new QueryClient()}><AuthProvider><Probe /></AuthProvider></QueryClientProvider>);
afterEach(() => vi.restoreAllMocks());

describe('session in the browser', () => {
  it('stays signed in while the server is starting up (network error / 502), instead of signing out', async () => {
    const user = { email: 'owner@example.com', permissions: [] } as unknown as SessionUser;
    const me = vi.spyOn(api, 'me')
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK', 'Could not reach the API server.'))
      .mockRejectedValueOnce(new ApiError(502, 'ERROR', 'Bad gateway'))
      .mockResolvedValue(user);
    show();
    await waitFor(() => expect(screen.getByText('waiting (unreachable)')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('signed in as owner@example.com')).toBeTruthy(), { timeout: 8000 });
    expect(me).toHaveBeenCalledTimes(3);
  }, 10000);

  it('signs out only when the server says the session is not valid (401)', async () => {
    vi.spyOn(api, 'me').mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    show();
    await waitFor(() => expect(screen.getByText('signed out')).toBeTruthy());
  });
});
