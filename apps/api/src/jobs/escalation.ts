import { TEAMS, evaluateEscalations, isTaskDone, unallocatedPastThreshold, type PageTier } from '@sentinel/shared';
import { audit, notify, seoLead, teamLead, SYSTEM_ACTOR, type Ctx } from '../services/context';
import type { IssueService } from '../services/issues';

/**
 * Nightly escalation job (PDF §3.3, §12.4):
 *  1. Recompute each issue's highest page tier from the current page inventory.
 *  2. Medium → Critical when a page enters Tier 1, or when unresolved past its SLA (re-alert).
 *  3. Criticals unallocated past the threshold → automatically allocated to the recommended team (task created).
 *  4. Template grouping (≥3 related Medium on one template → one Critical).
 *  5. In-app SLA-breach notifications for overdue tasks (once per task per day).
 */
export async function runEscalations(ctx: Ctx, issues: IssueService) {
  const r = ctx.repos;
  const cfg = await r.config.get();
  const now = ctx.clock();
  const tierOf = await issues.tierLookup();
  const previousTier: Record<string, PageTier | undefined> = {};
  const summary = { tierChanges: 0, escalated: 0, autoAllocated: 0, slaNotices: 0 };

  for (const i of await r.issues.list()) {
    if (i.source === 'sample' || !i.affectedUrls.length) continue;
    const tier = Math.min(...i.affectedUrls.map(tierOf)) as PageTier;
    if (tier !== i.highestTier) {
      previousTier[i.id] = i.highestTier;
      await r.issues.update({ ...i, highestTier: tier });
      summary.tierChanges++;
    }
  }

  for (const a of evaluateEscalations(await r.issues.list(), now, cfg, previousTier)) {
    const i = (await r.issues.get(a.issueId))!;
    i.severityHistory.push({ at: now.toISOString(), from: a.from, to: a.to, reason: a.reason, rule: a.rule });
    i.severity = a.to;
    i.issueClass = a.to;
    i.severityRationale = a.reason;
    i.slaDueAt = a.newSlaDueAt;
    await r.issues.update(i);
    summary.escalated++;
    if (i.taskId) {
      const t = await r.tasks.get(i.taskId);
      if (t && !isTaskDone(t.status)) {
        t.severity = a.to;
        t.priority = 'P1';
        t.dueAt = a.newSlaDueAt;
        t.activity.push({ id: `${t.id}-a${t.activity.length + 1}`, type: 'sla_escalated', actorId: 'system', actorName: SYSTEM_ACTOR.name, at: now.toISOString(), message: `Escalated ${a.from} → ${a.to}: ${a.reason}` });
        await r.tasks.update(t);
      }
    }
    await audit(ctx, SYSTEM_ACTOR, 'issue.escalate', 'issue', i.id, `${a.from} → ${a.to} (${a.rule}): ${a.reason}`);
    if (a.realert) {
      const lead = i.allocatedTeam ? await teamLead(ctx, i.allocatedTeam) : await seoLead(ctx);
      await notify(ctx, [lead, await seoLead(ctx)], { type: 'escalation', title: `Escalated to Critical: ${i.title}`, body: a.reason, link: `/issues/${i.id}`, severity: 'critical' });
      await ctx.delivery.deliver('escalation', ['slack'], { subject: `[Escalated → Critical] ${i.title}`, text: a.reason }, { issueId: i.id, taskId: i.taskId });
    }
  }

  for (const u of unallocatedPastThreshold(await r.issues.list(), now, cfg)) {
    const i = (await r.issues.get(u.id))!;
    if (i.source === 'sample') continue;
    try {
      await issues.allocateWithTask(SYSTEM_ACTOR, i, i.recommendedTeam, `Critical unallocated for ${u.hours}h (threshold ${cfg.escalation.unallocatedCriticalHours}h) — auto-assigned to the engine's recommended team.`, undefined, true);
      summary.autoAllocated++;
      await notify(ctx, [await seoLead(ctx)], { type: 'escalation', title: `Auto-allocated to ${TEAMS[i.recommendedTeam].name}: ${i.title}`, body: `Unallocated Critical for ${u.hours}h.`, link: `/issues/${i.id}`, severity: 'critical' });
    } catch (e) {
      ctx.log.warn({ issueId: i.id, err: (e as Error).message }, 'auto-allocation skipped');
    }
  }

  const today = now.toISOString().slice(0, 10);
  const notes = await r.notifications.list();
  for (const t of await r.tasks.list()) {
    if (t.source === 'sample' || isTaskDone(t.status) || new Date(t.dueAt).getTime() >= now.getTime()) continue;
    const link = t.issueId ? `/issues/${t.issueId}` : '/issues';
    if (notes.some((n) => n.type === 'sla' && n.link === link && n.createdAt.slice(0, 10) === today)) continue;
    await notify(ctx, [t.assigneeId, await teamLead(ctx, t.team)], { type: 'sla', title: `SLA breached: ${t.title}`, body: `Due ${t.dueAt}`, link, severity: t.severity });
    summary.slaNotices++;
  }

  await audit(ctx, SYSTEM_ACTOR, 'job.escalation', 'system', 'escalation', `Nightly escalation: ${summary.tierChanges} tier changes, ${summary.escalated} escalated, ${summary.autoAllocated} auto-allocated, ${summary.slaNotices} SLA notices`);
  return summary;
}
