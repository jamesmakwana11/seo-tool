import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Permission, Role, SessionUser } from '@sentinel/shared';
import { api } from '@/api/client';

interface AuthCtx {
  user: SessionUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  previewAs: (role: Role) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (p: Permission) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      setUser(await api.me());
    } catch {
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthCtx>(() => ({
    user,
    ready,
    login: async (email, password) => {
      const r = await api.login(email, password);
      qc.clear();
      setUser(r.user);
    },
    previewAs: async (role) => {
      const r = await api.previewAs(role);
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
  }), [user, ready, qc, refresh]);

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
