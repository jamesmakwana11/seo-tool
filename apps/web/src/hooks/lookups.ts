import { useMemo } from 'react';
import type { Employee } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';

/** Employee directory + id→name helper (cached by react-query). */
export function useEmployees() {
  const { can } = useAuth();
  const q = useApiQuery(['employees'], () => api.listEmployees(), { enabled: can('employees.view') });
  const byId = useMemo(() => new Map<string, Employee>((q.data ?? []).map((e) => [e.id, e])), [q.data]);
  return { ...q, list: q.data ?? [], byId, name: (id?: string) => (id ? byId.get(id)?.name ?? id : 'Unassigned') };
}
