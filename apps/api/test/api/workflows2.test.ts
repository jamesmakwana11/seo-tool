import { describe, expect, it } from 'vitest';
import { FIXTURE, makeHarness } from './helpers';

/** Server-side coverage for workflows previously exercised only through the browser mock adapter. */
describe('issue detail, allocation trail and bulk allocation', () => {
  it('issue detail carries a complete Fix Card; the allocation trail records reallocation', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const issue = (await seo.get('/api/issues?status=NEW&pageSize=50')).body.items.find((i: { isTemplateGroup?: boolean }) => !i.isTemplateGroup);
    const detail = (await seo.get(`/api/issues/${issue.id}`)).body;
    expect(detail.fixCard.whatsWrong).toBeTruthy();
    expect(detail.fixCard.whyItMatters).toBeTruthy();
    expect(detail.fixCard.acceptanceCriteria.length).toBeGreaterThan(0);
    const alloc = (await seo.post(`/api/issues/${issue.id}/allocate`, { team: 'content', reason: 'copy fix' })).body;
    expect(alloc.issue.allocation.at(-1)).toMatchObject({ toTeam: 'content', allocatedByName: 'Ritesh Patel', reason: 'copy fix', automatic: false });
    expect(alloc.issue.allocatedTeam).toBe('content');
    // Reallocation records the previous team on the issue's allocation trail.
    const re = (await seo.post(`/api/issues/${issue.id}/allocate`, { team: 'development', reason: 'theme change needed' })).body;
    expect(re.issue.allocation.at(-1)).toMatchObject({ fromTeam: 'content', toTeam: 'development', reason: 'theme change needed' });
    expect(re.audit.some((a: { action: string }) => a.action === 'issue.reallocate')).toBe(true);
  });

  it('bulk (re)allocation of a template-level group moves every child with the parent', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const [g] = (await admin.get('/api/issues/groups')).body as { id: string; parent: { id: string; allocatedTeam?: string; taskId?: string } }[];
    expect(g.parent.taskId).toBeTruthy();
    const target = g.parent.allocatedTeam === 'seo' ? 'development' : 'seo';
    const res = await admin.post(`/api/issues/groups/${g.id}/allocate`, { team: target, reason: 'schema decision belongs to SEO' });
    expect(res.status).toBe(200);
    expect(res.body.issue.allocatedTeam).toBe(target);
    const open = (res.body.children as { status: string; allocatedTeam?: string; taskId?: string; allocation: { bulkGroupId?: string }[] }[])
      .filter((c) => !['NOT_AN_ISSUE', 'CLOSED', 'VERIFIED'].includes(c.status));
    expect(open.length).toBeGreaterThan(0);
    for (const c of open) {
      expect(c).toMatchObject({ allocatedTeam: target, taskId: g.parent.taskId });
      expect(c.allocation.at(-1)?.bulkGroupId).toBe(g.id);
    }
    // Allocating to the team it already has is rejected rather than silently duplicated.
    expect((await admin.post(`/api/issues/groups/${g.id}/allocate`, { team: target })).status).toBe(409);
  });
});

describe('opportunities and content planning', () => {
  it('a brief can only be generated from an approved keyword gap (PDF §13)', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const gap = (await seo.get('/api/keyword-gaps')).body.items.find((g: { status: string }) => g.status === 'new');
    expect((await seo.post(`/api/briefs/from-gap/${gap.id}`)).body.error.code).toBe('NOT_APPROVED');
    await seo.patch(`/api/keyword-gaps/${gap.id}`, { status: 'approved' });
    const brief = await seo.post(`/api/briefs/from-gap/${gap.id}`);
    expect(brief.status).toBe(200);
    expect(brief.body).toMatchObject({ targetKeyword: gap.keyword, origin: 'keyword_gap', status: 'draft' });
    expect((await seo.get('/api/keyword-gaps')).body.items.find((g: { id: string }) => g.id === gap.id).status).toBe('brief_created');
  });

  it('keyword gaps are labelled FIXTURE when the backlink API is not connected', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const res = (await seo.get('/api/keyword-gaps')).body;
    expect(res.note).toMatch(/sample data/);
  });
});

describe('human approvals (PDF §17: proposals, never silent changes)', () => {
  it('disavow decisions are recorded once and never submitted to Google', async () => {
    const h = await makeHarness();
    const admin = h.as(await h.token(FIXTURE.admin));
    const cand = (await admin.get('/api/disavow')).body.find((d: { approval: string }) => d.approval === 'pending');
    const res = await admin.post(`/api/disavow/${cand.id}/decide`, { decision: 'approved' });
    expect(res.body.approval).toBe('approved');
    expect((await admin.post(`/api/disavow/${cand.id}/decide`, { decision: 'rejected' })).status).toBe(409);
    const audit = (await admin.get('/api/audit?q=disavow')).body.items[0];
    expect(audit.summary).toMatch(/does not submit to Google/);
  });

  it('a developer cannot decide a QA-gate hold; a reviewer must record what they verified', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const held = (await seo.get('/api/ai-flags')).body.find((f: { qaHold: boolean; qaHoldStatus?: string }) => f.qaHold && f.qaHoldStatus === 'held');
    const dev = h.as(await h.token(FIXTURE.developer));
    expect((await dev.post(`/api/ai-flags/${held.id}/decide`, { decision: 'approved', note: 'looks fine to me ok' })).status).toBe(403);
    expect((await seo.post(`/api/ai-flags/${held.id}/decide`, { decision: 'approved', note: 'short' })).status).toBe(400);
    const ok = await seo.post(`/api/ai-flags/${held.id}/decide`, { decision: 'approved', note: 'Checked the BPA-free claim against the supplier certificate on file.' });
    expect(ok.body).toMatchObject({ qaHoldStatus: 'approved', qaDecision: { byName: 'Ritesh Patel' } });
  });

  it('approving a Fix Card proposal records an audit entry and changes nothing on the live site', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const issue = (await seo.get('/api/issues?pageSize=1')).body.items[0];
    const before = (await seo.get(`/api/issues/${issue.id}`)).body.issue;
    const res = await seo.post(`/api/issues/${issue.id}/approve-proposal`, { note: 'redirect /old to /new' });
    expect(res.body.issue.status).toBe(before.status);
    expect(res.body.audit.some((a: { action: string; summary: string }) => a.action === 'fixcard.approve_proposal' && /does not apply live-site changes/.test(a.summary))).toBe(true);
  });
});

describe('custom rules run inside the crawl pipeline (PDF §10.2)', () => {
  it('an enabled rule flags matching page text; block_qa_gate holds the page for a human', async () => {
    const h = await makeHarness();
    const rules = h.container.services.rules;
    const now = new Date().toISOString();
    await h.container.repos.rules.insert({
      id: 'RULE-T1', name: 'No delivery promises', description: 'Ops has not approved delivery promises', method: 'phrase_list', phrases: ['delivered in 24 hours'], phraseMode: 'banned',
      scope: { templates: [], collections: [], tiers: [], newlyPublishedOnly: true, fullSite: true }, severity: 'medium', defaultTeam: 'content', action: 'block_qa_gate', schedule: 'on_publish',
      enabled: true, createdById: 'emp-aarav', createdAt: now, updatedAt: now, source: 'manual',
    });
    const page = { id: 'https://deodap.in/products/new-lamp', url: 'https://deodap.in/products/new-lamp', template: 'product' as const, tier: 2 as const, text: 'Bright lamp, delivered in 24 hours anywhere in India.', publishedAt: now, source: 'live' as const };
    const res = await rules.applyToPages([page]);
    expect(res.flagged).toBeGreaterThanOrEqual(1);
    const flag = (await h.container.repos.aiFlags.where({ checkId: 'RULE-T1' }))[0];
    expect(flag).toMatchObject({ url: page.url, qaHold: true, qaHoldStatus: 'held', source: 'live' });
    expect(flag.passage).toMatch(/delivered in 24 hours/i);
    // Idempotent: the same page is not flagged twice.
    await rules.applyToPages([page]);
    expect(await h.container.repos.aiFlags.where({ checkId: 'RULE-T1' })).toHaveLength(1);
  });
});

describe('reports & notifications', () => {
  it('the daily digest carries every PDF §12.1 section', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const d = (await seo.get('/api/reports/daily')).body;
    for (const k of ['health', 'newCriticals', 'newMediumsByModule', 'aiCompliance', 'verifiedFixed', 'opportunities', 'allocation', 'watchlist']) expect(d).toHaveProperty(k);
    expect(d.health.trend7d.length).toBeGreaterThan(0);
    expect(d.allocation).toHaveProperty('unallocatedPast24h');
    expect(d.meta.dataNotes.join(' ')).toMatch(/not connected/);
  });

  it('notifications belong to their recipient; mark-all-read only touches mine', async () => {
    const h = await makeHarness();
    const seo = h.as(await h.token(FIXTURE.seoLead));
    const admin = h.as(await h.token(FIXTURE.admin));
    const unread = async (who: typeof seo) => ((await who.get('/api/notifications')).body as { readAt?: string }[]).filter((n) => !n.readAt).length;
    const mine = (await seo.get('/api/notifications')).body as { recipientId: string }[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((n) => n.recipientId === 'emp-ritesh')).toBe(true);
    const adminBefore = await unread(admin);
    expect(adminBefore).toBeGreaterThan(0);
    await seo.post('/api/notifications/all/read');
    expect(await unread(seo)).toBe(0);
    expect(await unread(admin)).toBe(adminBefore); // Ritesh's mark-all never touches the admin's notifications
  });
});
