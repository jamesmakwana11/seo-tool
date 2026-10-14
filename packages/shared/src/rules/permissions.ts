import type { Permission, PermissionMatrix, Role, Task, TeamId } from '../types';

export function hasPermission(matrix: PermissionMatrix, role: Role, perm: Permission): boolean {
  return matrix[role]?.includes(perm) ?? false;
}

/** Can this user see this task? (all / team / own) */
export function canViewTask(matrix: PermissionMatrix, user: { id: string; role: Role; teamIds: TeamId[] }, task: Pick<Task, 'team' | 'assigneeId' | 'creatorId'>): boolean {
  if (hasPermission(matrix, user.role, 'tasks.view_all')) return true;
  if (task.assigneeId === user.id || task.creatorId === user.id) return true;
  if (hasPermission(matrix, user.role, 'tasks.view_team') && user.teamIds.includes(task.team)) return true;
  return false;
}

/** Route → required permission (frontend guards + backend route map share this). */
export const ROUTE_PERMISSIONS: Record<string, Permission> = {
  '/': 'dashboard.view',
  '/health': 'dashboard.view',
  '/modules': 'modules.view',
  '/crawls': 'crawls.view',
  '/issues': 'issues.view',
  '/tasks': 'tasks.view_team',
  '/workload': 'tasks.view_team',
  '/opportunities': 'opportunities.view',
  '/competitors': 'opportunities.view',
  '/reports': 'reports.view',
  '/ai-compliance/rules': 'rules.view',
  '/team/employees': 'employees.view',
  '/team/roles': 'roles.manage',
  '/team/allocations': 'issues.view',
  '/settings/integrations': 'integrations.view',
  '/settings/thresholds': 'settings.view',
  '/settings/crawl': 'settings.view',
  '/settings/notifications': 'notifications.configure',
  '/audit': 'audit.view',
  '/system': 'system.view',
  '/diagnostics': 'diagnostics.view',
};
