import {
  CHECKS_BY_ID, TEAMS, canTransition, canViewTask, generateFixCard, issueStatusForTask, taskPriorityFromSeverity, type ActivityEvent, type Issue, type IssueAction, type Task, type TeamId,
  type TransitionAction, type VerificationAttempt,
} from '@sentinel/shared';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit, need, notify, teamLead, SYSTEM_ACTOR, type Actor, type Ctx } from './context';

/** Task Ops sync is off: the task-management workflow it served was removed. */
const TASK_OPS_SYNC = false as boolean;

export function createTaskService(ctx: Ctx) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();


  function act(t: Task, actor: Actor, type: ActivityEvent['type'], message: string, meta?: Record<string, unknown>) {
    t.activity.push({ id: `${t.id}-a${t.activity.length + 1}-${Date.now().toString(36)}`, type, actorId: actor.id, actorName: actor.name, at: iso(), message, meta });
    t.updatedAt = iso();
  }

  async function loadVisible(actor: Actor, id: string): Promise<Task> {
    const t = await r.tasks.get(id);
    if (!t) throw notFound(`Task ${id}`);
    if (!actor.system && !canViewTask(await r.permissions.get(), actor, t)) throw forbidden('You can only view tasks for your team or assigned to you.');
    return t;
  }

  /** Mirror task status onto the linked issue (and template-group children) — PDF §12.3 mapping. */
  async function syncIssue(t: Task) {
    if (!t.issueId) return;
    const st = issueStatusForTask(t.status);
    const iss = await r.issues.get(t.issueId);
    if (!iss || !st) return;
    iss.status = st;
    await r.issues.update(iss);
    for (const cid of iss.childIssueIds ?? []) {
      const c = await r.issues.get(cid);
      if (c && (st === 'VERIFIED' || st === 'CLOSED')) await r.issues.update({ ...c, status: st });
    }
  }

  /**
   * External Task Ops sync belonged to the removed task-management workflow: issues are now worked directly in Sentinel,
   * so nothing is pushed (and no delivery attempt is recorded). The adapter remains for a possible future integration.
   */
  async function syncTaskOps(t: Task, issue?: Issue, comment?: string) {
    if (!TASK_OPS_SYNC) return;
    const base = { channel: 'email' as const, kind: 'task_sync' as const, subject: `Task Ops sync ${t.id}`, at: iso(), taskId: t.id, issueId: t.issueId };
    if (!ctx.taskOps.isConfigured()) {
      await r.deliveries.insert({ ...base, id: await r.deliveries.nextId('DLV', 5), outcome: 'skipped_not_configured', retryable: false, error: 'TASK_OPS_BASE_URL / TASK_OPS_TOKEN not configured — task kept in Sentinel\'s internal task store only.' });
      return;
    }
    try {
      if (comment && t.externalTaskOpsId) {
        const res = await ctx.taskOps.comment(t.externalTaskOpsId, comment);
        await r.deliveries.insert({ ...base, id: await r.deliveries.nextId('DLV', 5), outcome: res.ok ? 'delivered' : 'failed', retryable: res.ok ? false : res.retryable, error: res.ok ? undefined : res.error, providerMessageId: res.ok ? res.providerMessageId : undefined });
        return;
      }
      const res = await ctx.taskOps.upsertTask(t, issue);
      if (res.ok) {
        t.externalTaskOpsId = res.externalId;
        await r.tasks.update(t);
      }
      await r.deliveries.insert({ ...base, id: await r.deliveries.nextId('DLV', 5), outcome: res.ok ? 'delivered' : 'failed', retryable: res.ok ? false : res.retryable, error: res.ok ? undefined : res.error, providerMessageId: res.ok ? res.externalId : undefined });
    } catch (e) {
      ctx.log.error({ err: (e as Error).message, taskId: t.id }, 'task ops sync failed');
      await r.deliveries.insert({ ...base, id: await r.deliveries.nextId('DLV', 5), outcome: 'failed', retryable: true, error: (e as Error).message });
    }
  }


  const svc = {
    loadVisible,
    syncIssue,
    syncTaskOps,

    async createForIssue(actor: Actor, issue: Issue, team: TeamId, automatic = false): Promise<Task> {
      const cfg = await r.config.get();
      const fc = generateFixCard(issue, cfg, { now: ctx.clock() });
      const now = iso();
      const t: Task = {
        id: await r.tasks.nextId('TSK'), title: `Fix: ${issue.title}`, description: `${fc.whatsWrong}\n\nWhy it matters: ${fc.whyItMatters}\n\nFix Card: /issues/${issue.id}`,
        issueId: issue.id, module: issue.module, severity: issue.severity, priority: taskPriorityFromSeverity(issue.severity), priorityScore: fc.priorityScore,
        pageTier: issue.highestTier, affectedUrls: issue.affectedUrls.slice(0, 50), status: 'ASSIGNED', team, recommendedTeam: issue.recommendedTeam,
        creatorId: actor.id, creatorName: actor.name, createdAt: now, updatedAt: now, dueAt: issue.slaDueAt, progress: 0, estimatedHours: fc.effortHours,
        actualHours: 0, acceptanceCriteria: fc.acceptanceCriteria, comments: [], blockers: [], evidence: [], verification: [], activity: [],
        assignmentHistory: [{ at: now, byId: actor.id, byName: actor.name, toTeam: team }], relatedIssueIds: issue.childIssueIds ?? [], reopenCount: 0,
        source: issue.source === 'demo' ? 'demo' : 'live',
      };
      act(t, actor, 'created', `Task created from Fix Card ${issue.id} via "Fix with ${TEAMS[team].name}"${automatic ? ' (automatic: Critical unallocated past threshold, PDF §12.4)' : ''}. Priority ${t.priority} (from ${issue.severity}); due ${t.dueAt} (SLA).`);
      await r.tasks.insert(t);
      await syncTaskOps(t, issue);
      return (await r.tasks.get(t.id))!;
    },

    async transition(actor: Actor, id: string, action: TransitionAction, note?: string): Promise<Task> {
      const t = await loadVisible(actor, id);
      const chk = canTransition(t.status, action, actor.system ? { kind: 'system' } : { kind: 'user', id: actor.id, role: actor.role, isAssignee: t.assigneeId === actor.id }, note);
      if (!chk.ok) throw new ApiError(chk.code === 'FORBIDDEN' ? 403 : chk.code === 'NOTE_REQUIRED' ? 400 : 409, chk.code!, chk.error!);
      const from = t.status;
      t.status = chk.rule!.to;
      switch (action) {
        case 'block':
          t.blockers.push({ id: `${t.id}-b${t.blockers.length + 1}`, description: note!.trim(), raisedById: actor.id, raisedByName: actor.name, raisedAt: iso() });
          act(t, actor, 'blocker_added', `Blocked: ${note}`);
          await notify(ctx, [await teamLead(ctx, t.team)], { type: 'system', title: `Blocked: ${t.title}`, body: note!, link: t.issueId ? `/issues/${t.issueId}` : '/issues' });
          break;
        case 'unblock':
          for (const b of t.blockers) if (!b.resolvedAt) { b.resolvedAt = iso(); b.resolution = note || 'Resumed work'; }
          act(t, actor, 'blocker_resolved', `Resumed${note ? `: ${note}` : ''}`);
          break;
        case 'submit_review':
          t.progress = 100;
          act(t, actor, 'review_submitted', `Submitted for review${note ? `: ${note}` : ''}. The SEO issue is NOT verified until automated re-verification passes.`);
          await notify(ctx, [await teamLead(ctx, 'seo'), t.team === 'content' ? await teamLead(ctx, 'content') : undefined], { type: 'review', title: `Review requested: ${t.title}`, body: `${actor.name} submitted work for review.`, link: t.issueId ? `/issues/${t.issueId}` : '/issues' });
          break;
        case 'approve_review': {
          act(t, actor, 'review_approved', `Review approved → FIXED${note ? `: ${note}` : ''}. Queued for automated re-verification.`);
          const pending: VerificationAttempt = { id: await r.verifications.nextId('VER'), taskId: t.id, issueId: t.issueId ?? '-', at: iso(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: 'Queued: the issue URLs are re-checked on the next crawl or when "Run re-verification" is used.', source: 'live' };
          t.verification.push(pending);
          await r.verifications.insert(pending);
          break;
        }
        case 'reject_review':
          t.comments.push({ id: `${t.id}-c${t.comments.length + 1}`, authorId: actor.id, authorName: actor.name, body: `Changes requested: ${note}`, at: iso() });
          act(t, actor, 'review_rejected', `Changes requested: ${note}`);
          if (t.assigneeId) await notify(ctx, [t.assigneeId], { type: 'review', title: `Changes requested: ${t.title}`, body: note!, link: t.issueId ? `/issues/${t.issueId}` : '/issues' });
          break;
        case 'cancel':
          t.cancelReason = note;
          act(t, actor, 'status_changed', `Cancelled: ${note}`);
          break;
        case 'reopen_regression':
          t.reopenCount += 1;
          act(t, actor, 'reopened', `Reopened (regression): ${note}`);
          break;
        default:
          act(t, actor, 'status_changed', `${from} → ${t.status}${note ? `: ${note}` : ''}`);
      }
      await r.tasks.update(t);
      await syncIssue(t);
      await audit(ctx, actor, `task.${action}`, 'task', t.id, `${from} → ${t.status}${note ? ` (${note})` : ''}`);
      return t;
    },

    async runVerification(actor: Actor, id: string): Promise<{ task: Task; attempt: VerificationAttempt }> {
      await need(ctx, actor, 'tasks.verify_trigger');
      return verifyTask(actor, await loadVisible(actor, id));
    },

    /** Issue workflow (no task UI): start work / mark fixed on the issue's internal work record. Fixed never means Verified. */
    async issueAction(actor: Actor, issueId: string, action: IssueAction, note?: string) {
      await need(ctx, actor, 'issues.update_status');
      const i = await r.issues.get(issueId);
      if (!i) throw notFound(`Issue ${issueId}`);
      if (actor.role === 'developer' && !(i.allocatedTeam && actor.teamIds.includes(i.allocatedTeam))) throw forbidden('You can only update issues allocated to your team.');
      const t = i.taskId ? await r.tasks.get(i.taskId) : undefined;
      if (!i.allocatedTeam || !t) throw conflict('Allocate this issue to a team before updating its status.', 'NOT_ALLOCATED');
      const from = i.status;
      if (action === 'start') {
        if (i.status !== 'ASSIGNED') throw conflict(`Only Assigned issues can be started (this one is ${i.status}).`);
        t.status = 'IN_PROGRESS';
        act(t, actor, 'status_changed', `Work started by ${actor.name}.`);
      } else if (action === 'mark_fixed') {
        if (!['ASSIGNED', 'IN_PROGRESS'].includes(i.status)) throw conflict(`Only Assigned or In-progress issues can be marked fixed (this one is ${i.status}).`);
        t.status = 'FIXED';
        t.progress = 100;
        if (note?.trim()) t.evidence.push({ id: `${t.id}-e${t.evidence.length + 1}`, phase: 'after', kind: 'text', label: 'Fix note', content: note.trim(), addedById: actor.id, addedByName: actor.name, at: iso() });
        act(t, actor, 'status_changed', `Marked fixed by ${actor.name}${note?.trim() ? `: ${note.trim()}` : ''}. Not verified until a system re-check passes.`);
        const pending: VerificationAttempt = { id: await r.verifications.nextId('VER'), taskId: t.id, issueId: i.id, at: iso(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: 'Queued: the issue URLs are re-checked on the next crawl or when "Run re-verification" is used.', source: 'live' };
        t.verification.push(pending);
        await r.verifications.insert(pending);
        await notify(ctx, [await teamLead(ctx, 'seo')], { type: 'review', title: `Fixed, awaiting verification: ${i.title}`, body: `${actor.name} marked this issue fixed.`, link: `/issues/${i.id}`, severity: i.severity });
      } else {
        throw badRequest('Unknown action.');
      }
      await r.tasks.update(t);
      await syncIssue(t);
      await audit(ctx, actor, `issue.${action}`, 'issue', i.id, `${from} → ${t.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'FIXED'}${note?.trim() ? ` (${note.trim()})` : ''}`);
    },

    /** System re-check of a FIXED issue — the outcome is decided by the reverifier, never by a person. */
    async verifyIssue(actor: Actor, issueId: string): Promise<VerificationAttempt> {
      await need(ctx, actor, 'issues.verify');
      const i = await r.issues.get(issueId);
      if (!i) throw notFound(`Issue ${issueId}`);
      const t = i.taskId ? await r.tasks.get(i.taskId) : undefined;
      if (i.status !== 'FIXED' || !t) throw conflict('Re-verification runs on issues marked Fixed.');
      return (await verifyTask(actor, t)).attempt;
    },
  };

  async function verifyTask(actor: Actor, t: Task): Promise<{ task: Task; attempt: VerificationAttempt }> {
    {
      if (t.status !== 'FIXED') throw conflict('Re-verification runs on tasks in FIXED (approved, awaiting verification).');
      const issue = t.issueId ? await r.issues.get(t.issueId) : undefined;
      const check = issue ? CHECKS_BY_ID[issue.checkId] : undefined;
      let attempt: VerificationAttempt;
      const base = { id: await r.verifications.nextId('VER'), taskId: t.id, issueId: issue?.id ?? '-', at: iso(), triggeredBy: actor.id };
      if (!issue || !check) {
        attempt = { ...base, method: 'manual_attestation', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: 'Task has no linked check — verify manually and record an attestation.', source: 'live' };
      } else if (issue.source === 'demo') {
        attempt = { ...base, method: 'automated_recrawl', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: `Issue ${issue.id} is DEMO data — its URLs were never crawled, so there is nothing real to re-check. Status stays FIXED.`, source: 'live' };
      } else {
        const cv = ctx.reverifier.canVerify(issue.checkId);
        if (!cv.ok) {
          attempt = { ...base, method: check.crawlerEvaluable ? 'automated_recrawl' : 'connector_check', outcome: 'pending_data', checkedUrls: 0, failingUrls: 0, details: `Cannot verify "${check.name}" yet: ${cv.reason ?? 'required data source not connected'}. Status stays FIXED — no false pass.`, source: 'live' };
        } else {
          try {
            const res = await ctx.reverifier.verify(issue);
            attempt = { ...base, method: 'automated_recrawl', outcome: res.outcome === 'error' ? 'error' : res.outcome, checkedUrls: res.checkedUrls, failingUrls: res.failingUrls, details: res.details, source: 'live' };
          } catch (e) {
            attempt = { ...base, method: 'automated_recrawl', outcome: 'error', checkedUrls: 0, failingUrls: 0, details: `Re-check failed to run: ${(e as Error).message}`, source: 'live' };
          }
        }
      }
      return applyVerification(t, attempt);
    }
  }

  /** Apply a verification attempt to a FIXED task: pass → VERIFIED → CLOSED; fail → IN_PROGRESS; else stays FIXED. */
  async function applyVerification(t: Task, attempt: VerificationAttempt) {
    t.verification.push(attempt);
    await r.verifications.insert(attempt);
    act(t, SYSTEM_ACTOR, 'verification_run', `Verification ${attempt.outcome.toUpperCase()}: ${attempt.details}`, { outcome: attempt.outcome, triggeredBy: attempt.triggeredBy });
    if (attempt.outcome === 'passed') {
      t.status = 'VERIFIED';
      await r.tasks.update(t);
      await syncIssue(t);
      t.status = 'CLOSED';
      act(t, SYSTEM_ACTOR, 'status_changed', 'VERIFIED → CLOSED automatically (re-verification passed, PDF §16).');
      if (t.assigneeId) await notify(ctx, [t.assigneeId], { type: 'verification', title: `Verified: ${t.title}`, body: 'Re-verification found 0 failing URLs. Task closed.', link: t.issueId ? `/issues/${t.issueId}` : '/issues' });
    } else if (attempt.outcome === 'failed') {
      t.status = 'IN_PROGRESS';
      act(t, SYSTEM_ACTOR, 'status_changed', `FIXED → IN PROGRESS (verification failed: ${attempt.failingUrls} URLs still failing).`);
      if (t.assigneeId) await notify(ctx, [t.assigneeId], { type: 'verification', title: `Verification failed: ${t.title}`, body: attempt.details, link: t.issueId ? `/issues/${t.issueId}` : '/issues' });
    }
    await r.tasks.update(t);
    await syncIssue(t);
    await audit(ctx, SYSTEM_ACTOR, 'verification.run', 'verification', attempt.id, `${attempt.outcome.toUpperCase()} — ${attempt.details}`);
    if (t.externalTaskOpsId) await syncTaskOps(t, undefined, `Sentinel verification ${attempt.outcome}: ${attempt.details}`);
    return { task: (await r.tasks.get(t.id))!, attempt };
  }

  return { ...svc, applyVerification };
}
export type TaskService = ReturnType<typeof createTaskService>;
