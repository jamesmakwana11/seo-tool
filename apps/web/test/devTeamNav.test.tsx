import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, type Permission } from '@sentinel/shared';
import { visibleNav } from '../src/layout/nav';

/** Sidebar per role: Admin gets Google insights, the Development team and the Google part of Integrations; members see their own tasks. */
describe('sidebar for the Google and Development Team sections', () => {
  const sections = (role: 'admin' | 'developer', perms: Permission[]) => visibleNav(role, (p) => perms.includes(p)).map((s) => [s.id, s.items.map((i) => i.label)] as const);

  it('Admin: Overview, SEO operations, Google insights, Development team and Integrations — nothing else', () => {
    const nav = Object.fromEntries(sections('admin', ADMIN_PERMISSIONS));
    expect(Object.keys(nav)).toEqual(['overview', 'operations', 'insights', 'devteam', 'configuration']);
    expect(nav.insights).toEqual(['Analytics', 'Search Console', 'Core Web Vitals']);
    expect(nav.devteam).toEqual(['Team overview', 'Tasks', 'My tasks', 'Reminders']);
    expect(nav.configuration).toEqual(['Integrations']);
  });

  it('Developer: My tasks only in the Development team section, no Google insights by default', () => {
    const nav = Object.fromEntries(sections('developer', DEFAULT_PERMISSIONS.developer));
    expect(nav.devteam).toEqual(['My tasks']);
    expect(nav.insights).toBeUndefined();
  });
});
