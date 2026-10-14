import { describe, expect, it } from 'vitest';
import { DEMO, makeHarness } from './helpers';

/** Allocation → task creation → lifecycle → honest verification (PDF §11, §12.3, §16). */
describe('issue allocation & task workflow', () => {
  async function firstNewIssue(admin: ReturnType<ReturnType<typeof makeHarness> extends Promise<infer H> ? H extends { as: infer A } ? A : never : never>) {
    const list = await admin.get('/api/issues?status=NEW&sort=severity&dir=asc&pageSize=50');
    return list.body.items.find((i: { isTemplateGroup?: boolean }) => !i.isTemplateGroup);
  }

  it('allocating an issue assigns it to the team with the SLA due date; no external task sync is attempted', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const issue = await firstNewIssue(admin);
    const res = await admin.post(`/api/issues/${issue.id}/allocate`, { team: issue.recommendedTeam, reason: 'triaged' });
    expect(res.status).toBe(200);
    expect(res.body.task).toBeUndefined();
    expect(res.body.issue).toMatchObject({ status: 'ASSIGNED', allocatedTeam: issue.recommendedTeam });
    const deliveries = (await admin.get('/api/deliveries')).body as { kind: string }[];
    expect(deliveries.some((d) => d.kind === 'task_sync')).toBe(false);
  });

  it('start → mark fixed never verifies; a DEMO issue re-check returns pending_data and stays FIXED', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const issue = await firstNewIssue(admin);
    expect((await admin.post(`/api/issues/${issue.id}/status`, { action: 'start' })).body.error.code).toBe('NOT_ALLOCATED');
    await admin.post(`/api/issues/${issue.id}/allocate`, { team: 'development' });
    const dev = h.as(await h.token(DEMO.developer));
    const start = await dev.post(`/api/issues/${issue.id}/status`, { action: 'start' });
    expect(start.status).toBe(200);
    expect(start.body.issue.status).toBe('IN_PROGRESS');
    expect((await dev.post(`/api/issues/${issue.id}/status`, { action: 'start' })).status).toBe(409);
    const fixed = await dev.post(`/api/issues/${issue.id}/status`, { action: 'mark_fixed', note: 'Patched the theme' });
    expect(fixed.body.issue.status).toBe('FIXED');
    expect((await admin.post(`/api/issues/${issue.id}/status`, { action: 'verify' })).status).toBe(400);
    const verify = await admin.post(`/api/issues/${issue.id}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.attempt.outcome).toBe('pending_data');
    expect(verify.body.detail.issue.status).toBe('FIXED');
  });

  it('mark-not-an-issue cancels the linked task and (optionally) writes an exclusion', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(DEMO.admin));
    const issue = await firstNewIssue(admin);
    await admin.post(`/api/issues/${issue.id}/allocate`, { team: issue.recommendedTeam });
    const res = await admin.post(`/api/issues/${issue.id}/not-an-issue`, { reason: 'Intentional for this template', addExclusion: true });
    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('NOT_AN_ISSUE');
    const excl = (await admin.get('/api/issues/exclusions')).body as unknown[];
    expect(excl.length).toBeGreaterThan(0);
  });
});
