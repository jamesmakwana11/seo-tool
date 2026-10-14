import type { IssueStatus, Role, TaskStatus } from '../types';

/**
 * Task lifecycle (prompt §6):
 *   NEW → TRIAGED → ASSIGNED → IN_PROGRESS → BLOCKED → READY_FOR_REVIEW → FIXED → VERIFIED → CLOSED
 * plus review rejection, failed verification, regression/reopen, and reasoned cancellation.
 *
 * VERIFIED can only be set by the verification engine (`system`) — never by a person selecting
 * "Fixed" (prompt §5.13, PDF §12.3 "Nothing closes without automated re-verification").
 */
export type Actor =
  | { kind: 'system' }
  | { kind: 'user'; id: string; role: Role; isAssignee: boolean; isCreator?: boolean };

export interface TransitionRule {
  from: TaskStatus[];
  to: TaskStatus;
  action: TransitionAction;
  label: string;
  /** Who may perform it. 'assignee' = the assigned employee (any role). */
  allowed: Array<Role | 'assignee' | 'system'>;
  requiresNote?: boolean;
  description: string;
}

export type TransitionAction =
  | 'triage'
  | 'assign'
  | 'start'
  | 'block'
  | 'unblock'
  | 'submit_review'
  | 'approve_review'
  | 'reject_review'
  | 'verify_pass'
  | 'verify_fail'
  | 'close'
  | 'reopen_regression'
  | 'cancel';

export const TRANSITIONS: TransitionRule[] = [
  { action: 'triage', from: ['NEW'], to: 'TRIAGED', label: 'Triage', allowed: ['admin', 'seo_specialist'], description: 'Confirm the finding is real and in scope.' },
  { action: 'assign', from: ['NEW', 'TRIAGED'], to: 'ASSIGNED', label: 'Assign', allowed: ['admin', 'seo_specialist', 'system'], description: 'Assign to a team/employee.' },
  { action: 'start', from: ['ASSIGNED'], to: 'IN_PROGRESS', label: 'Start work', allowed: ['assignee', 'admin', 'seo_specialist'], description: 'Work has started.' },
  { action: 'block', from: ['ASSIGNED', 'IN_PROGRESS'], to: 'BLOCKED', label: 'Mark blocked', allowed: ['assignee', 'admin', 'seo_specialist'], requiresNote: true, description: 'Raise a blocker; describe what is needed.' },
  { action: 'unblock', from: ['BLOCKED'], to: 'IN_PROGRESS', label: 'Resume', allowed: ['assignee', 'admin', 'seo_specialist'], description: 'Blocker resolved; resume work.' },
  { action: 'submit_review', from: ['IN_PROGRESS'], to: 'READY_FOR_REVIEW', label: 'Submit for review', allowed: ['assignee', 'admin', 'seo_specialist'], description: 'Implementation complete — request review. Does NOT verify the SEO issue.' },
  { action: 'approve_review', from: ['READY_FOR_REVIEW'], to: 'FIXED', label: 'Approve (mark Fixed)', allowed: ['admin', 'seo_specialist'], description: 'Reviewer accepts the fix. Issue moves to Fixed and awaits automated re-verification.' },
  { action: 'reject_review', from: ['READY_FOR_REVIEW'], to: 'IN_PROGRESS', label: 'Request changes', allowed: ['admin', 'seo_specialist'], requiresNote: true, description: 'Reviewer rejects; returns to the assignee.' },
  { action: 'verify_pass', from: ['FIXED'], to: 'VERIFIED', label: 'Verification passed', allowed: ['system'], description: 'Automated re-check found 0 failing URLs.' },
  { action: 'verify_fail', from: ['FIXED'], to: 'IN_PROGRESS', label: 'Verification failed', allowed: ['system'], description: 'Automated re-check still fails — returned to work.' },
  { action: 'close', from: ['VERIFIED'], to: 'CLOSED', label: 'Close', allowed: ['system', 'admin', 'seo_specialist'], description: 'Close a verified task.' },
  { action: 'reopen_regression', from: ['VERIFIED', 'CLOSED'], to: 'ASSIGNED', label: 'Reopen (regression)', allowed: ['system', 'admin', 'seo_specialist'], requiresNote: true, description: 'The problem regressed; reopen to the same team.' },
  { action: 'cancel', from: ['NEW', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'READY_FOR_REVIEW'], to: 'CANCELLED', label: 'Cancel', allowed: ['admin', 'seo_specialist'], requiresNote: true, description: 'Cancel with a reason (e.g. not an issue, duplicate).' },
];

export interface TransitionCheck {
  ok: boolean;
  rule?: TransitionRule;
  error?: string;
  code?: 'INVALID_TRANSITION' | 'FORBIDDEN' | 'NOTE_REQUIRED';
}

export function canTransition(from: TaskStatus, action: TransitionAction, actor: Actor, note?: string): TransitionCheck {
  const rule = TRANSITIONS.find((r) => r.action === action);
  if (!rule) return { ok: false, code: 'INVALID_TRANSITION', error: `Unknown action ${action}` };
  if (!rule.from.includes(from)) {
    return { ok: false, rule, code: 'INVALID_TRANSITION', error: `Cannot "${rule.label}" a task in ${from}. Allowed from: ${rule.from.join(', ')}.` };
  }
  if (!actorAllowed(rule, actor)) {
    return { ok: false, rule, code: 'FORBIDDEN', error: forbiddenMessage(rule, actor) };
  }
  if (rule.requiresNote && actor.kind === 'user' && !(note && note.trim().length >= 3)) {
    return { ok: false, rule, code: 'NOTE_REQUIRED', error: `"${rule.label}" requires a reason.` };
  }
  return { ok: true, rule };
}

function actorAllowed(rule: TransitionRule, actor: Actor): boolean {
  if (actor.kind === 'system') return rule.allowed.includes('system');
  if (rule.allowed.includes(actor.role)) return true;
  if (rule.allowed.includes('assignee') && actor.isAssignee) return true;
  return false;
}

function forbiddenMessage(rule: TransitionRule, actor: Actor): string {
  if (rule.allowed.length === 1 && rule.allowed[0] === 'system') {
    return `"${rule.label}" can only be set by the automated verification engine.`;
  }
  if (actor.kind === 'user' && actor.role === 'developer' && (rule.action === 'approve_review' || rule.action === 'reject_review')) {
    return 'Developers cannot review their own work — an SEO Specialist or Admin must review.';
  }
  return `Your role is not permitted to "${rule.label}".`;
}

/** Actions available to an actor for a task in `from` (for UI buttons). */
export function availableActions(from: TaskStatus, actor: Actor): TransitionRule[] {
  return TRANSITIONS.filter((r) => r.from.includes(from) && actorAllowed(r, actor));
}

/** Map task status → PDF issue status (§12.3 New → Assigned → In Progress → Fixed → Verified → Closed). */
export function issueStatusForTask(s: TaskStatus): IssueStatus | null {
  switch (s) {
    case 'NEW':
    case 'TRIAGED':
      return 'NEW';
    case 'ASSIGNED':
      return 'ASSIGNED';
    case 'IN_PROGRESS':
    case 'BLOCKED':
    case 'READY_FOR_REVIEW':
      return 'IN_PROGRESS';
    case 'FIXED':
      return 'FIXED';
    case 'VERIFIED':
      return 'VERIFIED';
    case 'CLOSED':
      return 'CLOSED';
    case 'CANCELLED':
      return null; // cancellation does not change issue status by itself
  }
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  NEW: 'New', TRIAGED: 'Triaged', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', BLOCKED: 'Blocked',
  READY_FOR_REVIEW: 'Ready for review', FIXED: 'Fixed', VERIFIED: 'Verified', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  NEW: 'New', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', FIXED: 'Fixed', VERIFIED: 'Verified', CLOSED: 'Closed',
  NOT_AN_ISSUE: 'Not an issue', SUPERSEDED: 'Superseded',
};

export const KANBAN_COLUMNS: TaskStatus[] = ['NEW', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'READY_FOR_REVIEW', 'FIXED', 'VERIFIED', 'CLOSED'];

export const DONE_TASK_STATUSES: TaskStatus[] = ['VERIFIED', 'CLOSED', 'CANCELLED'];
export const isTaskDone = (s: TaskStatus) => DONE_TASK_STATUSES.includes(s);

/** Find the action that moves `from` → `to` (used by Kanban drag). */
export function actionFor(from: TaskStatus, to: TaskStatus): TransitionAction | undefined {
  return TRANSITIONS.find((r) => r.from.includes(from) && r.to === to)?.action;
}
