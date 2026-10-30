import { describe, expect, it } from 'vitest';
import { FIXTURE, makeHarness } from './helpers';

describe('permission enforcement (server-side)', () => {
  it('a developer cannot allocate issues or view the audit log', async () => {
    const h = await makeHarness();
    const dev = h.as(await h.token(FIXTURE.developer));
    const issues = await dev.get('/api/issues?pageSize=1');
    expect(issues.status).toBe(200);
    const issueId = issues.body.items[0].id;
    const alloc = await dev.post(`/api/issues/${issueId}/allocate`, { team: 'development' });
    expect(alloc.status).toBe(403);
    expect((await dev.get('/api/audit')).status).toBe(403);
    expect((await dev.get('/api/employees')).status).toBe(200); // developers have employees.view
  });

  it('a developer can only update the status of issues allocated to their own team, and cannot verify', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const issue = (await admin.get('/api/issues?status=NEW&pageSize=50')).body.items.find((i: { isTemplateGroup?: boolean }) => !i.isTemplateGroup);
    await admin.post(`/api/issues/${issue.id}/allocate`, { team: 'seo' });
    const dev = h.as(await h.token(FIXTURE.developer));
    expect((await dev.post(`/api/issues/${issue.id}/status`, { action: 'start' })).status).toBe(403);
    expect((await dev.post(`/api/issues/${issue.id}/verify`)).status).toBe(403);
  });

  it('the task-management API is gone', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    expect((await admin.get('/api/tasks')).status).toBe(404);
    expect((await admin.get('/api/tasks/workload')).status).toBe(404);
  });

  it('config automation opt-ins require the Admin role', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const res = await seo.patch('/api/config', { automation: { autoRedirectDeletedProducts: true, autoApplySchemaUpdates: false } });
    expect(res.status).toBe(403);
  });
});
