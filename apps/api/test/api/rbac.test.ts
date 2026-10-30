import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, ALL_PERMISSIONS, type Permission } from '@sentinel/shared';
import { FIXTURE, makeHarness } from './helpers';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createInMemoryRepositories } from '../../src/repositories/memory/inMemory';
import type { Persistence } from '../../src/repositories/postgres/persistence';

/** Admin = Overview + SEO operations only; Super Admin = everything. Enforced by the API, not only by the sidebar. */
const SITE_ADMIN = { SITE_ADMIN_EMAIL: 'site.admin@example.com', SITE_ADMIN_INITIAL_PASSWORD: '24681357' };
const SUPER_ONLY: Permission[] = ALL_PERMISSIONS.filter((p) => !ADMIN_PERMISSIONS.includes(p));

async function setup() {
  const h = await makeHarness(SITE_ADMIN);
  const admin = h.as(await h.token(SITE_ADMIN.SITE_ADMIN_EMAIL, SITE_ADMIN.SITE_ADMIN_INITIAL_PASSWORD));
  const superAdmin = h.as(await h.token(FIXTURE.admin));
  // Parameter-free GET endpoints with the permission each one is documented under.
  const gets = h.container.diagnostics.endpoints.filter((e) => e.method === 'GET' && e.permission && !e.path.includes(':'));
  return { h, admin, superAdmin, gets };
}

describe('role-based access: Admin and Super Admin', () => {
  it('creates the Admin account from SITE_ADMIN_* with a hashed password, once', async () => {
    const { h, admin } = await setup();
    const me = (await admin.get('/api/auth/me')).body;
    expect(me).toMatchObject({ role: 'admin', email: SITE_ADMIN.SITE_ADMIN_EMAIL });
    expect([...me.permissions].sort()).toEqual([...ADMIN_PERMISSIONS].sort());
    const cred = await h.container.repos.credentials.get(SITE_ADMIN.SITE_ADMIN_EMAIL);
    expect(cred?.hash).toBeTruthy();
    expect(JSON.stringify(cred)).not.toContain(SITE_ADMIN.SITE_ADMIN_INITIAL_PASSWORD);
    expect((await h.agent.post('/api/auth/login').send({ email: SITE_ADMIN.SITE_ADMIN_EMAIL, password: 'wrong-password' })).status).toBe(401);
  });

  it('Super Admin has every permission', async () => {
    const { superAdmin } = await setup();
    const me = (await superAdmin.get('/api/auth/me')).body;
    expect(me.role).toBe('super_admin');
    expect([...me.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('refuses Admin every Audit modules / Opportunities / Reporting / Team / Configuration API; Super Admin gets them', async () => {
    const { admin, superAdmin, gets } = await setup();
    const restricted = gets.filter((e) => SUPER_ONLY.includes(e.permission as Permission) && e.path !== '/api/employees');
    expect(restricted.length).toBeGreaterThan(20);
    for (const e of restricted) {
      const a = await admin.get(e.path);
      expect(a.status, `admin ${e.path}`).toBe(403);
      const s = await superAdmin.get(e.path);
      expect(s.status, `super admin ${e.path}`).not.toBe(403);
    }
    // Writes too.
    expect((await admin.patch('/api/config', { site: {} })).status).toBe(403);
    expect((await admin.put('/api/permissions', {})).status).toBe(403);
    expect((await admin.post('/api/employees', { name: 'X', email: 'x@example.com', role: 'super_admin', teamIds: [] })).status).toBe(403);
  });

  it('lets Admin use the Overview and SEO operations APIs', async () => {
    const { admin, gets } = await setup();
    const allowed = gets.filter((e) => ADMIN_PERMISSIONS.includes(e.permission as Permission));
    expect(allowed.length).toBeGreaterThan(15);
    for (const e of allowed) expect((await admin.get(e.path)).status, `admin ${e.path}`).not.toBe(403);
    // The issue board's employee names: names and roles only, without the Team page's details.
    const emp = await admin.get('/api/employees');
    expect(emp.status).toBe(200);
    expect(emp.body[0].name).toBeTruthy();
    expect(emp.body[0].email).toBeUndefined();
  });

  it('allows a role manager to read the permission matrix without granting employee-directory access', async () => {
    const { h } = await setup();
    const matrix = await h.container.repos.permissions.get();
    matrix.seo_specialist = matrix.seo_specialist
      .filter((p) => p !== 'employees.view')
      .concat('roles.manage');
    await h.container.repos.permissions.set(matrix);

    const seoManager = h.as(await h.token(FIXTURE.seoLead));
    expect((await seoManager.get('/api/employees')).status).toBe(403);
    const permissions = await seoManager.get('/api/permissions');
    expect(permissions.status).toBe(200);
    expect(permissions.body.seo_specialist).toContain('roles.manage');
  });

  it('keeps Super Admin from losing permissions or demoting themself', async () => {
    const { superAdmin } = await setup();
    const m = (await superAdmin.get('/api/permissions')).body;
    const saved = (await superAdmin.put('/api/permissions', { ...m, super_admin: [] })).body;
    expect(saved.super_admin.length).toBe(ALL_PERMISSIONS.length);
    const me = (await superAdmin.get('/api/auth/me')).body;
    expect((await superAdmin.patch(`/api/employees/${me.id}`, { role: 'admin' })).status).toBe(409);
  });

  it('upgrades a stored server: the old matrix gains Super Admin, Admin is limited, the ADMIN_EMAIL owner keeps full access', async () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const repos = createInMemoryRepositories(now);
    // As stored before the Super Admin role existed.
    const old = await repos.permissions.get();
    await repos.permissions.set({ admin: [...ALL_PERMISSIONS], seo_specialist: old.seo_specialist, developer: old.developer } as never);
    const base = { teamIds: [], title: '', status: 'active' as const, capacityHoursPerWeek: 40, source: 'live' as const };
    await repos.employees.insert({ ...base, id: 'EMP-001', name: 'Owner', email: 'owner@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00Z' });
    await repos.employees.insert({ ...base, id: 'EMP-002', name: 'Other', email: 'other@example.com', role: 'admin', createdAt: '2026-02-01T00:00:00Z' });
    const persistence = { hasData: async () => true, repositories: async () => repos } as unknown as Persistence;
    const env = loadEnv({ NODE_ENV: 'test', SESSION_SECRET: 'u'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: 'owner@example.com', ADMIN_INITIAL_PASSWORD: 'Owner-pass-2026' });
    await createContainer({ env, persistence });
    const m = await repos.permissions.get();
    expect(m.super_admin.length).toBe(ALL_PERMISSIONS.length);
    expect([...m.admin].sort()).toEqual([...ADMIN_PERMISSIONS].sort());
    expect((await repos.employees.get('EMP-001'))!.role).toBe('super_admin');
    expect((await repos.employees.get('EMP-002'))!.role).toBe('admin');
    // A second start changes nothing.
    await createContainer({ env, persistence });
    expect((await repos.employees.list()).filter((e) => e.role === 'super_admin')).toHaveLength(1);
  });
});
