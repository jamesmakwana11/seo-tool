import type { Role } from '@sentinel/shared';

/** Roles in display order. Roles are permission sets; 1into2 teams are allocation groups. */
export const ROLES: Role[] = ['admin', 'seo_specialist', 'developer'];

export const ROLE_HELP: Record<Role, string> = {
  admin: 'Full access, including roles, integrations and employee management.',
  seo_specialist: 'Allocates issues, reviews work, triggers re-verification.',
  developer: 'Works issues allocated to their team: start work and mark fixed; cannot allocate or verify.',
};
