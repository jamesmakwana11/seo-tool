import { describe, it, expect, beforeEach } from 'vitest';
import { ApiError, DEMO_PASSWORD } from '@sentinel/shared';
import { createMockApi } from '../src/api/mock/mockApi';

const NOW = new Date('2026-10-12T06:00:00Z');
type Api = ReturnType<typeof createMockApi>;

async function asRole(role: 'admin' | 'seo_specialist' | 'developer'): Promise<Api> {
  sessionStorage.clear();
  const api = createMockApi({ latencyMs: [0, 0], now: () => NOW });
  await api.previewAs(role);
  return api;
}

async function expectApiError(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    if (code) expect((e as ApiError).code).toBe(code);
    return e as ApiError;
  }
  throw new Error(`expected ApiError ${status}`);
}

describe('mock adapter — auth', () => {
  beforeEach(() => sessionStorage.clear());
  it('rejects bad credentials and unauthenticated calls', async () => {
    const api = createMockApi({ latencyMs: [0, 0], now: () => NOW });
    await expectApiError(api.getDashboard(), 401);
    await expectApiError(api.login('ritesh.seo@demo.deodap.local', 'wrong'), 401, 'INVALID_CREDENTIALS');
    const r = await api.login('ritesh.seo@demo.deodap.local', DEMO_PASSWORD);
    expect(r.user.role).toBe('seo_specialist');
    expect(r.user.demo).toBe(false);
  });
  it('blocks suspended / invited accounts', async () => {
    const api = createMockApi({ latencyMs: [0, 0], now: () => NOW });
    await expectApiError(api.login('sameer.content@demo.deodap.local', DEMO_PASSWORD), 403, 'ACCOUNT_INACTIVE');
  });
  it('role preview is flagged as demo', async () => {
    const api = await asRole('developer');
    expect((await api.me()).demo).toBe(true);
  });
  it('password reset round trip, without revealing unknown accounts', async () => {
    const api = createMockApi({ latencyMs: [0, 0], now: () => NOW });
    const unknown = await api.requestPasswordReset('nobody@example.com');
    expect(unknown.devResetToken).toBeUndefined();
    const r = await api.requestPasswordReset('neha.seo@demo.deodap.local');
    await expectApiError(api.resetPassword(r.devResetToken!, 'short'), 400, 'WEAK_PASSWORD');
    await api.resetPassword(r.devResetToken!, 'NewPassword123');
    await expectApiError(api.resetPassword(r.devResetToken!, 'NewPassword123'), 400, 'INVALID_TOKEN');
    expect((await api.login('neha.seo@demo.deodap.local', 'NewPassword123')).user.name).toBe('Neha Shah');
  });
});

describe('mock adapter — permissions (frontend-phase enforcement)', () => {
  it('developer cannot allocate, change settings, run crawls or manage roles', async () => {
    const api = await asRole('developer');
    await expectApiError(api.allocateIssue('ISS-0001', 'development'), 403, 'FORBIDDEN');
    await expectApiError(api.updateConfig({}), 403);
    await expectApiError(api.startCrawl('smart'), 403);
    await expectApiError(api.getPermissionMatrix().then(() => api.updatePermissionMatrix({ admin: [], seo_specialist: [], developer: [] })), 403);
  });
  it('developer can only update the status of issues allocated to their team', async () => {
    const api = await asRole('seo_specialist');
    await api.allocateIssue('ISS-0001', 'seo');
    sessionStorage.clear();
    await api.previewAs('developer');
    await expectApiError(api.updateIssueStatus('ISS-0001', 'start'), 403, 'FORBIDDEN');
    await expectApiError(api.verifyIssue('ISS-0001'), 403, 'FORBIDDEN');
  });
  it('admin cannot remove roles.manage from Admin (lock-out protection)', async () => {
    const api = await asRole('admin');
    const m = await api.getPermissionMatrix();
    await expectApiError(api.updatePermissionMatrix({ ...m, admin: m.admin.filter((p) => p !== 'roles.manage') }), 409);
  });
});

describe('mock adapter — one-tap allocation (PDF §11.1a)', () => {
  it('allocating assigns the issue to the team and records the trail', async () => {
    const api = await asRole('seo_specialist');
    const before = await api.getIssue('ISS-0001');
    expect(before.issue.allocatedTeam).toBeUndefined();
    const d = await api.allocateIssue('ISS-0001', 'development');
    expect(d.issue.status).toBe('ASSIGNED');
    expect(d.issue.allocation.at(-1)).toMatchObject({ toTeam: 'development', allocatedByName: 'Ritesh Patel', automatic: false });
    expect(d.issue.allocatedTeam).toBe('development');
    const audit = await api.listAuditLog({ q: 'ISS-0001' });
    expect(audit.items.some((a) => a.action === 'issue.allocate')).toBe(true);
  });
  it('reallocation notifies both teams and records the previous team', async () => {
    const api = await asRole('seo_specialist');
    await api.allocateIssue('ISS-0001', 'development');
    const d = await api.allocateIssue('ISS-0001', 'content', 'Copy issue, not theme');
    expect(d.issue.allocation.at(-1)).toMatchObject({ fromTeam: 'development', toTeam: 'content', reason: 'Copy issue, not theme' });
    expect(d.issue.allocatedTeam).toBe('content');
    const leads = api.__state.notifications.filter((n) => n.title.startsWith('Reallocated: '));
    expect(new Set(leads.map((n) => n.recipientId))).toEqual(new Set(['emp-vikram', 'emp-pooja']));
  });
  it('bulk allocation of a template-level group allocates every child', async () => {
    const api = await asRole('seo_specialist');
    const [g] = await api.listIssueGroups();
    const target = g.parent.allocatedTeam === 'seo' ? 'development' : 'seo';
    const d = await api.bulkAllocate(g.id, target);
    expect(d.children!.length).toBe(4);
    for (const c of d.children!) {
      expect(c.allocatedTeam).toBe(target);
      expect(c.allocation.at(-1)?.bulkGroupId).toBe(g.id);
    }
  });
});

describe('mock adapter — issue workflow & honest verification', () => {
  it('start → mark fixed never verifies; only the system re-check can', async () => {
    const api = await asRole('seo_specialist');
    await expectApiError(api.updateIssueStatus('ISS-0001', 'start'), 409, 'NOT_ALLOCATED');
    await api.allocateIssue('ISS-0001', 'development');
    sessionStorage.clear();
    await api.previewAs('developer');
    await expectApiError(api.verifyIssue('ISS-0001'), 403);
    let d = await api.updateIssueStatus('ISS-0001', 'start');
    expect(d.issue.status).toBe('IN_PROGRESS');
    await expectApiError(api.updateIssueStatus('ISS-0001', 'start'), 409);
    d = await api.updateIssueStatus('ISS-0001', 'mark_fixed');
    expect(d.issue.status).toBe('FIXED');
    await api.previewAs('seo_specialist');
    // No fix note → simulated re-crawl fails and the issue returns to In progress
    const fail = await api.verifyIssue('ISS-0001');
    expect(fail.attempt.outcome).toBe('failed');
    expect(fail.attempt.source).toBe('simulated');
    expect(fail.detail.issue.status).toBe('IN_PROGRESS');
    await api.updateIssueStatus('ISS-0001', 'mark_fixed', 'Removed duplicate canonical in theme.liquid');
    const pass = await api.verifyIssue('ISS-0001');
    expect(pass.attempt.outcome).toBe('passed');
    expect(pass.detail.issue.status).toBe('VERIFIED');
  });

  it('checks that need a connector stay FIXED with pending_data (no false pass)', async () => {
    const api = await asRole('seo_specialist');
    const i = api.__state.issues.find((x) => x.checkId === 'PERF-CRUX')!; // CrUX, not crawler-evaluable
    const task = api.__state.tasks.find((t) => t.id === i.taskId)!;
    task.status = 'FIXED';
    i.status = 'FIXED';
    const r = await api.verifyIssue(i.id);
    expect(r.attempt.outcome).toBe('pending_data');
    expect(r.detail.issue.status).toBe('FIXED');
  });
});

describe('mock adapter — websites', () => {
  it('adds a website with validation and duplicate-domain protection; new sites start empty', async () => {
    const api = await asRole('seo_specialist');
    await expectApiError(api.createWebsite({ name: 'X', url: 'not a url', platform: 'shopify' }), 400);
    await expectApiError(api.createWebsite({ name: 'DeoDap again', url: 'https://www.DeoDap.in/collections', platform: 'shopify' }), 409, 'DUPLICATE_DOMAIN');
    await expectApiError(api.createWebsite({ name: 'Shop', url: 'shop.example.com', platform: 'shopify', sitemapUrl: 'https://other.example.org/sitemap.xml' }), 400);
    const w = await api.createWebsite({ name: 'Example Shop', url: 'shop.example.com', platform: 'woocommerce' });
    expect(w.url).toBe('https://shop.example.com/');
    const list = await api.listWebsites();
    const sum = list.find((x) => x.id === w.id)!;
    expect(sum).toMatchObject({ hasAuditData: false, healthScore: undefined, integrationsConnected: 0, openIssues: { critical: 0, medium: 0, low: 0 } });
    expect(list.find((x) => x.domain === 'deodap.in')!.hasAuditData).toBe(true);
    await expectApiError(api.updateWebsite(w.id, { name: 'Dup', url: 'https://deodap.in', platform: 'shopify' }), 409);
    const renamed = await api.updateWebsite(w.id, { name: 'Example Store', url: 'https://shop.example.com', platform: 'woocommerce' });
    expect(renamed.name).toBe('Example Store');
  });

  it('isolates data per website, including calls in flight while the selection changes', async () => {
    sessionStorage.clear();
    let site = 'site-deodap';
    const api = createMockApi({ latencyMs: [5, 5], now: () => NOW, websiteId: () => site });
    await api.previewAs('seo_specialist');
    const w = await api.createWebsite({ name: 'Second', url: 'https://second.example.com', platform: 'custom' });
    const demoIssues = api.listIssues({ pageSize: 5 }); // started on deodap.in
    site = w.id;
    expect((await demoIssues).total).toBeGreaterThan(0);
    expect((await api.listIssues({})).total).toBe(0);
    const dash = await api.getDashboard();
    expect(dash.hasAuditData).toBe(false);
    await api.updateConfig({ thresholds: { ...(await api.getConfig()).thresholds, titleMaxChars: 55 } });
    site = 'site-deodap';
    expect((await api.getConfig()).thresholds.titleMaxChars).not.toBe(55);
    await expectApiError(api.getIssue('ISS-0001').then(() => { site = w.id; return api.getIssue('ISS-0001'); }), 404);
    expect((await api.getConfig()).site.canonicalHost).toBe('second.example.com');
    site = 'site-missing';
    await expectApiError(api.listIssues({}), 404, 'WEBSITE_NOT_FOUND');
  });
});

describe('mock adapter — governance & honesty', () => {
  it('Not an issue requires a reason and adds exclusions', async () => {
    const api = await asRole('seo_specialist');
    await expectApiError(api.markNotAnIssue('ISS-0008', 'no', true), 400);
    const d = await api.markNotAnIssue('ISS-0008', 'Orphans are intentional landing pages', true);
    expect(d.issue.status).toBe('NOT_AN_ISSUE');
    expect((await api.listExclusions()).some((e) => e.reason.includes('intentional landing'))).toBe(true);
  });
  it('report delivery is never claimed when adapters are not configured', async () => {
    const api = await asRole('seo_specialist');
    const r = await api.sendReport('daily');
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((d) => d.outcome === 'skipped_not_configured')).toBe(true);
  });
  it('integrations never report connected in mock mode and reject secrets in settings', async () => {
    const api = await asRole('admin');
    const list = await api.listIntegrations();
    expect(list.every((i) => i.state !== 'connected')).toBe(true);
    const t = await api.testIntegration('gsc');
    expect(t.state).toBe('not_configured');
    await expectApiError(api.updateIntegration('slack', { webhookToken: 'x' }), 400, 'SECRET_IN_SETTINGS');
  });
  it('data sync never claims success in mock mode and needs integrations.manage', async () => {
    const admin = await asRole('admin');
    const r = await admin.syncIntegration('ga4');
    expect(r.ran).toBe(false);
    const dev = await asRole('developer');
    await expectApiError(dev.syncIntegration('gsc'), 403);
  });

  it('custom rules: dry run required before enabling; LLM rules need a provider', async () => {
    const api = await asRole('seo_specialist');
    const rules = await api.listRules();
    const llm = rules.find((r) => r.method === 'llm_judged')!;
    await expectApiError(api.setRuleEnabled(llm.id, true), 409, 'PROVIDER_REQUIRED');
    const regex = await api.saveRule({ ...rules[0], id: undefined, name: 'Test regex rule', enabled: false, lastDryRun: undefined });
    await expectApiError(api.setRuleEnabled(regex.id, true), 409, 'DRY_RUN_REQUIRED');
    const dry = await api.dryRunRule({ ...regex });
    expect(dry.evaluated).toBe(true);
    expect(dry.pagesScanned).toBeGreaterThan(0);
    expect(dry.pagesFlagged).toBeGreaterThan(0);
    expect((await api.setRuleEnabled(regex.id, true)).enabled).toBe(true);
    const llmDry = await api.dryRunRule({ ...llm });
    expect(llmDry.evaluated).toBe(false);
  });
  it('config validation: weights must sum to 100%', async () => {
    const api = await asRole('admin');
    const cfg = await api.getConfig();
    await expectApiError(api.updateConfig({ scoring: { ...cfg.scoring, weights: { ...cfg.scoring.weights, technical: 0.5 } } }), 400);
  });
  it('simulated crawl is labelled and produces no findings', async () => {
    const api = await asRole('seo_specialist');
    const run = await api.startCrawl('smart');
    expect(run.source).toBe('simulated');
    expect(run.scope[0].label).toMatch(/SIMULATED/);
    await expectApiError(api.startCrawl('full'), 409);
  });
  it('generating a brief requires an approved keyword gap', async () => {
    const api = await asRole('seo_specialist');
    const gaps = (await api.listKeywordGaps()).items;
    const fresh = gaps.find((g) => g.status === 'new')!;
    await expectApiError(api.generateBriefFromGap(fresh.id), 409, 'NOT_APPROVED');
    await api.updateKeywordGap(fresh.id, 'approved');
    const b = await api.generateBriefFromGap(fresh.id);
    expect(b.targetKeyword).toBe(fresh.keyword);
  });
});
