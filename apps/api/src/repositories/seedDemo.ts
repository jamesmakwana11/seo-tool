import { createSeed } from '@sentinel/shared';
import type { Repositories } from './types';
import { hashPassword, sha256 } from '../lib/passwords';

/**
 * Loads the deterministic DEMO seed into repositories. Every record carries `source: 'demo'`, so it can never be
 * mistaken for live connector or crawler results. Live crawls/connectors write `source: 'live'` records.
 * Controlled by SEED_DEMO_DATA (default true in development, set false for a clean live start).
 */
export async function seedDemoData(repos: Repositories, now = new Date()): Promise<{ issues: number; tasks: number; employees: number }> {
  const s = createSeed(now);
  const all = async <T extends { id: string }>(repo: { insert: (x: T) => Promise<T> }, items: T[]) => {
    for (const it of items) await repo.insert(it);
  };
  await repos.config.set(s.config);
  await repos.permissions.set(s.permissions);
  await all(repos.employees, s.employees);
  for (const e of s.employees) {
    const { hash, salt } = await hashPassword(s.passwords[e.email], sha256(`demo-salt:${e.email.toLowerCase()}`).slice(0, 32)); // DEMO accounts: stable across restarts
    await repos.credentials.insert({ id: e.email.toLowerCase(), employeeId: e.id, hash, salt, updatedAt: now.toISOString() });
  }
  await all(repos.sitePages, s.catalog.pages);
  await all(repos.pageTexts, s.pageTexts.map((p) => ({ ...p, id: p.url, source: 'sample' as const })));
  await all(repos.issues, s.issues);
  await all(repos.groups, s.groups);
  await all(repos.exclusions, s.exclusions);
  await all(repos.tasks, s.tasks);
  await all(repos.verifications, s.verifications);
  await all(repos.crawls, s.crawls);
  for (const [id, urls] of Object.entries(s.crawlUrls)) await repos.crawlUrls.insert({ id, urls });
  for (const [id, d] of Object.entries(s.sitemapDiffs)) await repos.sitemapDiffs.insert({ ...d, id });
  await all(repos.schedules, s.schedules);
  await all(repos.notifications, s.notifications);
  await all(repos.deliveries, s.deliveries);
  await all(repos.audit, s.audit);
  await all(repos.rules, s.rules);
  await all(repos.aiFlags, s.aiFlags);
  await all(repos.briefs, s.briefs);
  await all(repos.keywordGaps, s.keywordGaps);
  await all(repos.opportunities, s.opportunities);
  await all(repos.mentions, s.mentions);
  await all(repos.prospects, s.prospects);
  await all(repos.disavow, s.disavow);
  await repos.metrics.set({
    source: 'sample', siteSize: s.siteSize, healthHistory: s.healthHistory, cwv: s.cwv, indexation: s.indexation, visibility: s.visibility,
    aiTrend: s.aiTrend, aiPrompts: s.aiPrompts, backlinks: s.backlinks, refTrend: s.refTrend, competitors: s.competitors, localHealth: s.localHealth,
    striking: s.striking, ctrRewrites: s.ctrRewrites, clusters: s.clusters, contentScores: s.contentScores, criticalAlerts: s.criticalAlerts, errors: s.errors,
  });
  return { issues: s.issues.length, tasks: s.tasks.length, employees: s.employees.length };
}
