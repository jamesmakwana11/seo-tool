/**
 * Development Team: members (app accounts invited from the Development Team screen), the tasks assigned to them
 * (SEO issues and development work across every website), reminders and in-app notifications.
 * Stored once for the whole server (like people and sign-in), so one board covers every website.
 */
import type { AccountStatus, Permission, Role } from './types';

export type DevTaskStatus = 'pending' | 'in_progress' | 'completed';
/** What the board shows: an open task past its due date is Overdue. */
export type DevTaskDisplayStatus = DevTaskStatus | 'overdue';
export type DevTaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export type DevTaskKind = 'seo_issue' | 'development';

export const DEV_TASK_STATUS_LABELS: Record<DevTaskDisplayStatus, string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', overdue: 'Overdue' };
export const DEV_TASK_PRIORITY_LABELS: Record<DevTaskPriority, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
export const DEV_TASK_PRIORITIES: DevTaskPriority[] = ['urgent', 'high', 'medium', 'low'];
export const DEV_TASK_KIND_LABELS: Record<DevTaskKind, string> = { seo_issue: 'SEO issue', development: 'Development task' };

export interface DevTaskComment { id: string; authorId: string; authorName: string; at: string; text: string }
export interface DevTaskEvent { at: string; actorName: string; message: string }

export interface DevTask {
  id: string;
  title: string;
  description: string;
  kind: DevTaskKind;
  priority: DevTaskPriority;
  status: DevTaskStatus;
  /** Due date (YYYY-MM-DD, end of that day in IST). */
  dueDate: string;
  assigneeId?: string;
  websiteId?: string;
  websiteName?: string;
  issueId?: string;
  issueTitle?: string;
  url?: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  comments: DevTaskComment[];
  history: DevTaskEvent[];
  /** Automatic reminders already sent (so each is sent once). */
  dueSoonRemindedAt?: string;
  overdueRemindedOn?: string;
}

export interface DevTaskView extends DevTask {
  displayStatus: DevTaskDisplayStatus;
  overdue: boolean;
  assigneeName?: string;
  /** Whole days until due (negative when overdue). */
  daysLeft: number;
}

export interface DevTaskInput {
  title: string;
  description?: string;
  kind: DevTaskKind;
  priority: DevTaskPriority;
  dueDate: string;
  assigneeId?: string;
  websiteId?: string;
  issueId?: string;
  url?: string;
}

export interface DevTaskFilter {
  status?: DevTaskDisplayStatus | 'open' | 'all';
  assigneeId?: string;
  priority?: DevTaskPriority;
  kind?: DevTaskKind;
  websiteId?: string;
  q?: string;
}

export interface DevWorkCounts { open: number; pending: number; inProgress: number; completed: number; overdue: number }

export interface DevTeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  status: AccountStatus;
  createdAt: string;
  lastActiveAt?: string;
  /** Invited but has not set a password yet. */
  invitePending: boolean;
  inviteExpiresAt?: string;
  work: DevWorkCounts;
}

export type TeamMemberRole = 'developer' | 'seo_specialist';
export interface DevTeamMemberInput { name: string; email: string; role: TeamMemberRole; title?: string }

export interface DevInviteResult {
  member: DevTeamMember;
  activation: {
    emailed: boolean;
    expiresAt: string;
    /**
     * The one-time activation link, returned only when it could not be emailed — show it once so the Admin can share
     * it privately. Only its hash is stored on the server.
     */
    link?: string;
    note: string;
  };
}

export interface DevTeamOverview {
  members: DevTeamMember[];
  counts: DevWorkCounts;
  overdue: DevTaskView[];
  dueSoon: DevTaskView[];
  /** Email delivery is configured (invites and reminders are also emailed). */
  emailConfigured: boolean;
}

export type TeamReminderKind = 'manual' | 'due_soon' | 'overdue' | 'assignment';
export interface TeamReminder {
  id: string;
  at: string;
  kind: TeamReminderKind;
  sentById?: string;
  sentByName: string;
  recipientIds: string[];
  recipientNames: string[];
  taskId?: string;
  taskTitle?: string;
  message: string;
}
export interface TeamReminderInput {
  /** One member, or every active member when "all". */
  to: string | 'all';
  message: string;
  taskId?: string;
}

export interface TeamRolePermissions {
  role: TeamMemberRole;
  label: string;
  permissions: Permission[];
  /** Permissions the current user may grant or remove for this role (never more than they hold). */
  grantable: Permission[];
}
