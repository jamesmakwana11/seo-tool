import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, type Permission, type SessionUser } from '@sentinel/shared';
import { api } from '@/api/client';

interface AuthCtx {
  user: SessionUser | null;
  ready: boolean;
  /** Set while the server cannot be reached (starting up, redeploying, offline): the session is kept, not ended. */
  unreachable?: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const [unreachable, setUnreachable] = useState<string>();
  const qc = useQueryClient();

  /**
   * Only the server saying "not signed in" (401) ends the session in the browser. A server that is starting up,
   * redeploying or briefly unreachable (network error, 5xx) is retried — the user stays signed in.
   */
  const refresh = useCallback(async () => {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        setUser(await api.me());
        setUnreachable(undefined);
        setReady(true);
        return;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          setUser(null);
          setUnreachable(undefined);
          setReady(true);
          return;
        }
        setUnreachable(e instanceof Error ? e.message : 'The server could not be reached.');
        // Give up waiting after 3 minutes; the screen then offers to try again (still without signing out).
        if (Date.now() - started > 180_000) { setReady(true); return; }
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1500 * 2 ** attempt)));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthCtx>(() => ({
    user,
    ready,
    unreachable,
    login: async (email, password) => {
      const r = await api.login(email, password);
      qc.clear();
      setUser(r.user);
    },
    logout: async () => {
      await api.logout();
      qc.clear();
      setUser(null);
    },
    refresh,
    can: (p) => !!user?.permissions.includes(p),
  }), [user, ready, unreachable, qc, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

/** Convenience: returns the signed-in user (only use inside authenticated routes). */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('useUser requires an authenticated route');
  return user;
}
