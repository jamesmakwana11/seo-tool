import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { cronMatches, istParts, nextRun } from '../../src/jobs/scheduler';
import { failingFetch } from './helpers';

async function liveC(now: Date) {
  const env = loadEnv({ NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'z'.repeat(40), LOG_LEVEL: 'silent' });
  return createContainer({ env, fetchImpl: failingFetch, clock: () => now });
}

describe('cron (IST)', () => {
  it('matches 08:00 IST = 02:30 UTC for "0 8 * * *"', () => {
    expect(cronMatches('0 8 * * *', new Date('2026-03-10T02:30:00Z'))).toBe(true);
    expect(cronMatches('0 8 * * *', new Date('2026-03-10T08:00:00Z'))).toBe(false);
  });
  it('matches Monday in IST for "30 2 * * 1"', () => {
    // 2026-03-09 is a Monday; 02:30 IST = 2026-03-08T21:00Z (Sunday UTC) — IST evaluation must still say Monday.
    const d = new Date('2026-03-08T21:00:00Z');
    expect(istParts(d).dow).toBe(1);
    expect(cronMatches('30 2 * * 1', d)).toBe(true);
  });
  it('computes a plausible next run', () => {
    const n = nextRun('0 8 * * *', new Date('2026-03-10T05:00:00Z'));
    expect(n && istParts(n).hour).toBe(8);
  });
});

describe('nightly escalation job', () => {
  it('auto-allocates a Critical that has been unallocated past the threshold and creates its task', async () => {
    const detectedAt = '2026-03-01T00:00:00.000Z';
    const now = new Date('2026-03-03T00:00:00.000Z'); // > 24h later
    const c = await liveC(now);
    const cfg = await c.repos.config.get();
    await c.repos.issues.insert({
      id: 'ISS-9001', checkId: 'TECH-5XX', module: 'technical', title: 'Sitewide 5xx', summary: 'server errors', severity: 'critical', severityRationale: 'all 5xx critical',
      issueClass: 'critical', status: 'NEW', delta: 'new', affectedUrls: ['https://deodap.in/'], affectedCount: 1, highestTier: 1, tierBreakdown: { 1: 1, 2: 0, 3: 0 },
      businessImpact: 'down', detectedAt, firstSeenAt: detectedAt, lastSeenAt: detectedAt, slaDueAt: detectedAt, occurrences: 1, recommendedTeam: 'development',
      allocation: [], severityHistory: [], evidence: [], source: 'live',
    });
    const summary = await c.runEscalations();
    expect(summary.autoAllocated).toBe(1);
    const issue = await c.repos.issues.get('ISS-9001');
    expect(issue?.allocatedTeam).toBe('development');
    expect(issue?.taskId).toBeTruthy();
    expect(issue?.allocation[0].automatic).toBe(true);
    void cfg;
  });

  it('escalates a Medium issue breached past its SLA to Critical and re-alerts', async () => {
    const now = new Date('2026-03-10T00:00:00.000Z');
    const c = await liveC(now);
    const past = '2026-03-01T00:00:00.000Z';
    await c.repos.issues.insert({
      id: 'ISS-9002', checkId: 'ONP-TITLE', module: 'onpage', title: 'Missing titles', summary: 'x', severity: 'medium', severityRationale: 'medium', issueClass: 'medium',
      status: 'ASSIGNED', delta: 'unchanged', template: 'product', affectedUrls: ['https://deodap.in/products/a'], affectedCount: 1, highestTier: 3, tierBreakdown: { 1: 0, 2: 0, 3: 1 },
      businessImpact: 'x', detectedAt: past, firstSeenAt: past, lastSeenAt: past, slaDueAt: past, occurrences: 1, recommendedTeam: 'content', allocatedTeam: 'content',
      allocation: [], severityHistory: [], evidence: [], source: 'live',
    });
    const summary = await c.runEscalations();
    expect(summary.escalated).toBe(1);
    expect((await c.repos.issues.get('ISS-9002'))?.severity).toBe('critical');
  });
});

describe('scheduler wiring (IST)', () => {
  it('fires the smart crawl, nightly escalation and 08:00 digest at their IST minutes — each once', async () => {
    const c = await liveC(new Date('2026-10-12T21:00:00.000Z'));
    // 02:00 IST on 13 Oct = 20:30Z on 12 Oct → smart crawl schedule. No crawler configured → an honest failed run is recorded.
    await c.scheduler.tick(new Date('2026-10-12T20:30:00.000Z'));
    await c.scheduler.tick(new Date('2026-10-12T20:30:20.000Z')); // same minute → not fired twice
    const crawls = await c.repos.crawls.list();
    expect(crawls).toHaveLength(1);
    expect(crawls[0]).toMatchObject({ type: 'smart', trigger: 'schedule', status: 'failed' });
    expect(crawls[0].error).toMatch(/Crawler not ready/);
    // 00:30 IST = 19:00Z → nightly escalation job.
    await c.scheduler.tick(new Date('2026-10-12T19:00:00.000Z'));
    expect((await c.repos.audit.list()).some((a) => a.action === 'job.escalation')).toBe(true);
    // 08:00 IST = 02:30Z → daily digest through the configured channels; nothing is claimed delivered without a provider.
    await c.scheduler.tick(new Date('2026-10-13T02:30:00.000Z'));
    const digest = (await c.repos.deliveries.list()).filter((d) => d.kind === 'daily_digest');
    expect(digest.length).toBeGreaterThan(0);
    expect(digest.every((d) => d.outcome === 'skipped_not_configured')).toBe(true);
  });
});

