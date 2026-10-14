import {
  ApiError, ROLE_LABELS, TEAMS, hasPermission,
  type AuditLogEntry, type Employee, type IntegrationId, type Notification, type Permission, type PermissionMatrix,
  type SentinelView, type SessionUser, type TeamId,
} from '@sentinel/shared';
import type { Env } from '../config/env';
import type { Logger } from '../lib/logger';
import type { Repositories } from '../repositories/types';
import type { CrawlEngine, DeliveryService, IntegrationRegistry, LlmAdapter, Reverifier, TaskOpsAdapter } from './ports';

/** Everything a service needs. Services never import a storage implementation. */
export interface Ctx {
  env: Env;
  repos: Repositories;
  log: Logger;
  clock: () => Date;
  integrations: IntegrationRegistry & { recordSync?: (id: IntegrationId, o: { ok: true } | { ok: false; error: string }) => Promise<unknown> };
  delivery: DeliveryService;
  taskOps: TaskOpsAdapter;
  llm: LlmAdapter;
  engine: CrawlEngine;
  reverifier: Reverifier;
  sessionSecret: string;
}

/** The authenticated caller (or the system for scheduled jobs). */
export interface Actor {
  id: string;
  name: string;
  role: SessionUser['role'];
  teamIds: TeamId[];
  permissions: Permission[];
  demo: boolean;
  system?: boolean;
}

export const SYSTEM_ACTOR: Actor = { id: 'system', name: 'Sentinel (system)', role: 'admin', teamIds: [], permissions: [], demo: false, system: true };

export function requirePerm(matrix: PermissionMatrix, actor: Actor, perm: Permission) {
  if (actor.system) return;
  if (!hasPermission(matrix, actor.role, perm)) {
    throw new ApiError(403, 'FORBIDDEN', `Your role (${ROLE_LABELS[actor.role]}) does not have permission "${perm}".`);
  }
}

export async function can(ctx: Ctx, actor: Actor, perm: Permission) {
  if (actor.system) return true;
  return hasPermission(await ctx.repos.permissions.get(), actor.role, perm);
}

export async function need(ctx: Ctx, actor: Actor, perm: Permission) {
  requirePerm(await ctx.repos.permissions.get(), actor, perm);
}

export async function audit(ctx: Ctx, actor: Actor, action: string, entityType: AuditLogEntry['entityType'], entityId: string, summary: string, extra: Partial<AuditLogEntry> = {}) {
  const entry: AuditLogEntry = {
    id: await ctx.repos.audit.nextId('AUD', 6), at: ctx.clock().toISOString(), actorId: actor.id, actorName: actor.name, action, entityType, entityId, summary, ...extra,
  };
  await ctx.repos.audit.insert(entry);
  ctx.log.info({ audit: { action, entityType, entityId, actor: actor.id } }, 'audit');
  return entry;
}

export async function notify(ctx: Ctx, recipientIds: (string | undefined)[], n: Omit<Notification, 'id' | 'recipientId' | 'createdAt'>) {
  for (const r of new Set(recipientIds.filter(Boolean) as string[])) {
    await ctx.repos.notifications.insert({ ...n, id: await ctx.repos.notifications.nextId('NTF', 6), recipientId: r, createdAt: ctx.clock().toISOString() });
  }
}

export async function teamLead(ctx: Ctx, team: TeamId): Promise<string | undefined> {
  const emps = await ctx.repos.employees.list();
  const active = emps.filter((e) => e.status === 'active' && e.teamIds.includes(team));
  const lead = active.find((e) => e.isSeoLead && team === 'seo') ?? active.find((e) => /lead/i.test(e.title)) ?? active[0];
  return lead?.id ?? TEAMS[team].leadId;
}

export async function seoLead(ctx: Ctx): Promise<string | undefined> {
  return (await ctx.repos.employees.list()).find((e) => e.isSeoLead && e.status === 'active')?.id ?? (await teamLead(ctx, 'seo'));
}

export function toSessionUser(e: Employee, matrix: PermissionMatrix, demo: boolean): SessionUser {
  return { id: e.id, name: e.name, email: e.email, role: e.role, teamIds: e.teamIds, isSeoLead: e.isSeoLead, permissions: matrix[e.role], demo };
}

export function actorFromEmployee(e: Employee, matrix: PermissionMatrix, demo: boolean): Actor {
  return { id: e.id, name: e.name, role: e.role, teamIds: e.teamIds, permissions: matrix[e.role], demo };
}

/** Assemble the read-model view the shared query functions operate on. */
export async function loadView(ctx: Ctx): Promise<SentinelView> {
  const r = ctx.repos;
  const [config, issues, tasks, employees, verifications, crawls, briefs, aiFlags, opportunities, deliveries, audit, prospects, m] = await Promise.all([
    r.config.get(), r.issues.list(), r.tasks.list(), r.employees.list(), r.verifications.list(), r.crawls.list(), r.briefs.list(), r.aiFlags.list(),
    r.opportunities.list(), r.deliveries.list(), r.audit.list(), r.prospects.list(), r.metrics.get(),
  ]);
  const live = async (id: IntegrationId) => ctx.integrations.isConnected(id);
  const [gsc, ga4, crux, backlinks, openai, gemini, perplexity, shopify, gbp] = await Promise.all(['gsc', 'ga4', 'psi_crux', 'backlinks', 'openai', 'gemini', 'perplexity', 'shopify', 'gbp'].map((i) => live(i as IntegrationId)));
  crawls.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return {
    config, siteSize: m.siteSize || (await r.sitePages.count()), issues, tasks, employees, verifications, crawls, healthHistory: m.healthHistory, cwv: m.cwv,
    indexation: m.indexation, visibility: m.visibility, aiTrend: m.aiTrend, aiPrompts: m.aiPrompts, backlinks: m.backlinks, prospects, striking: m.striking,
    ctrRewrites: m.ctrRewrites, briefs, aiFlags, opportunities, deliveries, criticalAlerts: m.criticalAlerts, audit, competitors: m.competitors,
    liveSources: {
      gsc, ga4, crux, backlinks, ai_engines: openai || gemini || perplexity, shopify, gbp,
      crawler: crawls.some((c) => c.source === 'live' && c.status === 'completed'),
    },
  };
}
