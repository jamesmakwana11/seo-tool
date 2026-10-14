import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { failingFetch } from './helpers';
import type { CrawlOutcome } from '../../src/services/ports';

/** Direct test of the crawl→issue pipeline (delta detection, severity, auto-resolution) on a clean live store. */
async function liveContainer() {
  const env = loadEnv({ NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'x'.repeat(40), LOG_LEVEL: 'silent' });
  const c = await createContainer({ env, fetchImpl: failingFetch });
  // A small site inventory so tier lookup and auto-resolution have URLs to reason about.
  for (const path of ['/', '/collections/diwali', '/products/led-lamp']) {
    await c.repos.sitePages.insert({ id: `page:${path}`, url: `https://deodap.in${path}`, path, template: path === '/' ? 'home' : path.includes('product') ? 'product' : 'collection', title: path, tier: path === '/' ? 1 : 3, tierReason: 'test', indexable: true, source: 'live' });
  }
  return c;
}

function outcome(partial: Partial<CrawlOutcome>): Pick<CrawlOutcome, 'findings' | 'evaluatedChecks' | 'evaluatedTemplates' | 'urls' | 'pageTexts'> {
  return { findings: [], evaluatedChecks: [], evaluatedTemplates: {}, urls: [], pageTexts: [], ...partial };
}

const noindexFinding = (urls: string[]) => ({
  checkId: 'TECH-NOINDEX', title: 'New noindex on indexed URLs', summary: 'noindex added', urls,
  evidence: [{ kind: 'html_snippet' as const, label: 'meta', content: '<meta name="robots" content="noindex">' }],
});

describe('ingestFindings: delta detection, severity by tier, auto-resolution', () => {
  it('creates a NEW issue with severity derived from page tier and an SLA due date', async () => {
    const c = await liveContainer();
    const stats = await c.services.issues.ingestFindings('CRL-1', outcome({
      findings: [noindexFinding(['https://deodap.in/'])],
      evaluatedChecks: ['TECH-NOINDEX'], urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage' }],
    }));
    expect(stats.newIssues).toBe(1);
    const issues = await c.repos.issues.list();
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('critical'); // Tier-1 noindex
    expect(issues[0].highestTier).toBe(1);
    expect(issues[0].source).toBe('live');
    expect(new Date(issues[0].slaDueAt).getTime()).toBeGreaterThan(0);
  });

  it('second run with the same finding does not duplicate — it updates the existing open issue', async () => {
    const c = await liveContainer();
    const o = outcome({ findings: [noindexFinding(['https://deodap.in/'])], evaluatedChecks: ['TECH-NOINDEX'], urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage' }] });
    await c.services.issues.ingestFindings('CRL-1', o);
    const s2 = await c.services.issues.ingestFindings('CRL-2', o);
    expect(s2.newIssues).toBe(0);
    expect(await c.repos.issues.count()).toBe(1);
  });

  it('auto-resolves an open issue when a later run evaluates the check and no longer finds it', async () => {
    const c = await liveContainer();
    await c.services.issues.ingestFindings('CRL-1', outcome({ findings: [noindexFinding(['https://deodap.in/'])], evaluatedChecks: ['TECH-NOINDEX'], urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage' }] }));
    const stats = await c.services.issues.ingestFindings('CRL-2', outcome({ findings: [], evaluatedChecks: ['TECH-NOINDEX'], urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage' }] }));
    expect(stats.resolvedIssues).toBe(1);
    const issue = (await c.repos.issues.list())[0];
    expect(['VERIFIED', 'CLOSED']).toContain(issue.status);
  });

  it('does NOT auto-resolve when the check was not evaluated in the run', async () => {
    const c = await liveContainer();
    await c.services.issues.ingestFindings('CRL-1', outcome({ findings: [noindexFinding(['https://deodap.in/'])], evaluatedChecks: ['TECH-NOINDEX'], urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage' }] }));
    const stats = await c.services.issues.ingestFindings('CRL-2', outcome({ findings: [], evaluatedChecks: [], urls: [] }));
    expect(stats.resolvedIssues).toBe(0);
    expect((await c.repos.issues.list())[0].status).toBe('NEW');
  });

  it('respects an exclusion: an excluded URL produces no issue', async () => {
    const c = await liveContainer();
    await c.repos.exclusions.insert({ id: 'EXC-1', checkId: 'TECH-NOINDEX', urlPattern: '/', reason: 'homepage noindex is intentional in staging', createdById: 'system', createdByName: 'system', createdAt: new Date().toISOString() });
    const stats = await c.services.issues.ingestFindings('CRL-1', outcome({ findings: [noindexFinding(['https://deodap.in/'])], evaluatedChecks: ['TECH-NOINDEX'], urls: [{ url: 'https://deodap.in/', status: 200, reason: 'homepage' }] }));
    expect(stats.newIssues).toBe(0);
    expect(stats.excludedUrls).toBe(1);
  });

  it('groups ≥3 Medium issues on one template into a Critical template-level issue', async () => {
    const c = await liveContainer();
    for (const n of [1, 2, 3]) await c.repos.sitePages.insert({ id: `p${n}`, url: `https://deodap.in/products/p${n}`, path: `/products/p${n}`, template: 'product', title: `p${n}`, tier: 3, tierReason: 't', indexable: true, source: 'live' });
    const findings = [1, 2, 3].map((n) => ({ checkId: 'TECH-SCHEMA-PRESENCE', template: 'product' as const, key: `TECH-SCHEMA-PRESENCE::product::p${n}`, title: `Missing offers schema p${n}`, summary: 'no offers', urls: [`https://deodap.in/products/p${n}`], evidence: [] }));
    await c.services.issues.ingestFindings('CRL-1', outcome({ findings, evaluatedChecks: ['TECH-SCHEMA-PRESENCE'], urls: findings.map((f) => ({ url: f.urls[0], status: 200, reason: 'top_product' as const })) }));
    const groups = await c.repos.groups.list();
    expect(groups).toHaveLength(1);
    const parent = (await c.repos.issues.list()).find((i) => i.isTemplateGroup);
    expect(parent?.severity).toBe('critical');
    expect(parent?.childIssueIds).toHaveLength(3);
    // PDF §11.2.4: the template-level card supersedes the page-level ones.
    const children = (await c.repos.issues.list()).filter((i) => !i.isTemplateGroup);
    expect(children.every((i) => i.supersededById === parent!.id && i.status === 'SUPERSEDED')).toBe(true);
  });

  it('the template-level parent resolves as a unit once no child is detected', async () => {
    const c = await liveContainer();
    for (const n of [1, 2, 3]) await c.repos.sitePages.insert({ id: `p${n}`, url: `https://deodap.in/products/p${n}`, path: `/products/p${n}`, template: 'product', title: `p${n}`, tier: 3, tierReason: 't', indexable: true, source: 'live' });
    const urls = [1, 2, 3].map((n) => ({ url: `https://deodap.in/products/p${n}`, status: 200, reason: 'top_product' as const }));
    const findings = [1, 2, 3].map((n) => ({ checkId: 'TECH-SCHEMA-PRESENCE', template: 'product' as const, key: `TECH-SCHEMA-PRESENCE::product::p${n}`, title: `p${n}`, summary: 's', urls: [`https://deodap.in/products/p${n}`], evidence: [] }));
    await c.services.issues.ingestFindings('CRL-1', outcome({ findings, evaluatedChecks: ['TECH-SCHEMA-PRESENCE'], evaluatedTemplates: { 'TECH-SCHEMA-PRESENCE': ['product'] }, urls }));
    // Run 2: two pages still fail → parent stays open and tracks only the failing URLs.
    await c.services.issues.ingestFindings('CRL-2', outcome({ findings: findings.slice(1), evaluatedChecks: ['TECH-SCHEMA-PRESENCE'], evaluatedTemplates: { 'TECH-SCHEMA-PRESENCE': ['product'] }, urls }));
    let parent = (await c.repos.issues.list()).find((i) => i.isTemplateGroup)!;
    expect(parent.status).toBe('NEW');
    expect(parent.affectedUrls.sort()).toEqual(['https://deodap.in/products/p2', 'https://deodap.in/products/p3']);
    // Run 3: fixed everywhere → parent verified by the crawler.
    await c.services.issues.ingestFindings('CRL-3', outcome({ findings: [], evaluatedChecks: ['TECH-SCHEMA-PRESENCE'], evaluatedTemplates: { 'TECH-SCHEMA-PRESENCE': ['product'] }, urls }));
    parent = (await c.repos.issues.get(parent.id))!;
    expect(parent.status).toBe('VERIFIED');
    // Children are verified with their parent and no standalone duplicates were created along the way.
    const all = await c.repos.issues.list();
    expect(all).toHaveLength(4);
    expect(all.filter((i) => !i.isTemplateGroup).every((i) => i.status === 'VERIFIED')).toBe(true);
  });

  it('keeps one issue per finding key (e.g. one per blocked AI bot) and resolves them independently', async () => {
    const c = await liveContainer();
    const bot = (name: string) => ({ checkId: 'AEO-AI-CRAWLERS', key: `AEO-AI-CRAWLERS::site::${name}`, title: `${name} is blocked`, summary: 's', urls: ['https://deodap.in/robots.txt'], severityContext: { unintentional: true }, evidence: [] });
    const urls = [{ url: 'https://deodap.in/robots.txt', status: 200, reason: 'homepage' as const }];
    await c.services.issues.ingestFindings('CRL-1', outcome({ findings: [bot('GPTBot'), bot('PerplexityBot')], evaluatedChecks: ['AEO-AI-CRAWLERS'], urls }));
    expect(await c.repos.issues.count()).toBe(2);
    // GPTBot unblocked; PerplexityBot still blocked.
    const s2 = await c.services.issues.ingestFindings('CRL-2', outcome({ findings: [bot('PerplexityBot')], evaluatedChecks: ['AEO-AI-CRAWLERS'], urls }));
    expect(s2.newIssues).toBe(0);
    const issues = await c.repos.issues.list();
    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.title.startsWith('GPTBot'))?.status).toBe('VERIFIED');
    const perplexity = issues.find((i) => i.title.startsWith('PerplexityBot'))!;
    expect(perplexity.status).toBe('NEW');
  });

  it('PDF §16 acceptance: a FIXED task closes automatically when the next crawl finds 0 failing URLs, and returns to work otherwise', async () => {
    const c = await liveContainer();
    const o = (present: boolean) => outcome({
      findings: present ? [noindexFinding(['https://deodap.in/products/led-lamp'])] : [], evaluatedChecks: ['TECH-NOINDEX'],
      urls: [{ url: 'https://deodap.in/products/led-lamp', status: 200, reason: 'top_product' }],
    });
    await c.services.issues.ingestFindings('CRL-1', o(true));
    const issue = (await c.repos.issues.list())[0];
    const { SYSTEM_ACTOR } = await import('../../src/services/context');
    await c.services.issues.allocateWithTask(SYSTEM_ACTOR, issue, 'development');
    const taskId = (await c.repos.issues.get(issue.id))!.taskId!;
    const setFixed = async () => { const t = (await c.repos.tasks.get(taskId))!; await c.repos.tasks.update({ ...t, status: 'FIXED' }); };

    // Still detected → verification fails, task returns to IN_PROGRESS with an activity entry.
    await setFixed();
    await c.services.issues.ingestFindings('CRL-2', o(true));
    let t = (await c.repos.tasks.get(taskId))!;
    expect(t.status).toBe('IN_PROGRESS');
    expect(t.verification.at(-1)).toMatchObject({ outcome: 'failed', method: 'automated_recrawl', failingUrls: 1 });
    expect(t.activity.some((a) => a.type === 'verification_run' && /FAILED/.test(a.message))).toBe(true);

    // Fixed for real → 0 failing → VERIFIED → CLOSED, issue VERIFIED (only the system can do this).
    await setFixed();
    await c.services.issues.ingestFindings('CRL-3', o(false));
    t = (await c.repos.tasks.get(taskId))!;
    expect(t.status).toBe('CLOSED');
    expect(t.verification.at(-1)).toMatchObject({ outcome: 'passed', failingUrls: 0, triggeredBy: 'system' });
    // The issue mirrors the task: VERIFIED by the system, then CLOSED (taskWorkflow.issueStatusForTask).
    expect((await c.repos.issues.get(issue.id))?.status).toBe('CLOSED');
    expect(t.activity.some((a) => /VERIFIED → CLOSED automatically/.test(a.message))).toBe(true);

    // Regression: the problem comes back → task reopened to the same team.
    await c.services.issues.ingestFindings('CRL-4', o(true));
    t = (await c.repos.tasks.get(taskId))!;
    expect(t.status).toBe('ASSIGNED');
    expect(t.reopenCount).toBe(1);
    expect((await c.repos.issues.get(issue.id))?.delta).toBe('recurring');
  });
});
