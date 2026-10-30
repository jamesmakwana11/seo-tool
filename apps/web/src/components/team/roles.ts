import type { Role } from '@sentinel/shared';

/** Roles in display order. Roles are permission sets; 1into2 teams are allocation groups. */
export const ROLES: Role[] = ['super_admin', 'admin', 'seo_specialist', 'developer'];

export const ROLE_HELP: Record<Role, string> = {
  super_admin: 'Full access, including audit modules, opportunities, reporting, team, roles and configuration.',
  admin: 'Overview and SEO operations: dashboard, websites, issues, pages, verification, crawls, image audit and the SEO editor.',
  seo_specialist: 'Allocates issues, reviews work, triggers re-verification.',
  developer: 'Works issues allocated to their team: start work and mark fixed; cannot allocate or verify.',
};
