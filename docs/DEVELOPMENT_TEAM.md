# Development Team

Sidebar → **Development team**. Admins and the Super Admin (`devteam.manage`) manage the team from the app; every
member (`devteam.view`, given to Developers and SEO Specialists by default) sees **My tasks**. Nothing is added through
the server or the database.

## Members

- **Invite member** — name, email, role (Developer or SEO Specialist), job title. Sentinel creates the account with
  status *Invitation sent* and a random password nobody knows, plus a one-time activation link valid for 72 hours.
  Only the link's SHA-256 hash is stored. With SMTP configured the link is emailed to the member; otherwise it is shown
  **once** to the Admin to share privately. Opening it, the member chooses a password and the account becomes active.
  **Send a new activation link** replaces the previous one.
- **Edit** — name, email (also the sign-in email), role, job title.
- **Deactivate** — the member is signed out everywhere at once and cannot sign in; **Activate** restores access.
- **Remove from team** — removes the member from the Development Team, deactivates the account (history and audit trail
  are kept) and unassigns their open tasks.
- An Admin cannot change its own account here, and cannot change or create Admin / Super Admin accounts (that stays on
  Team → Employees, Super Admin only).

**Roles & permissions** tab — the permissions of the Developer and SEO Specialist roles. An Admin may grant or remove
only permissions it holds itself, never admin rights (`roles.manage`, `employees.manage`, `devteam.manage`,
`google.manage`, `integrations.manage`, `settings.manage`, `websites.manage`). Enforced by the API.

## Tasks

SEO issues and development tasks, across every website (one board for the server): title, description, type, priority
(Urgent / High / Medium / Low), due date, assignee, website, page address, linked SEO issue. Status: **Pending →
In progress → Completed**; an open task past the end of its due day (IST) shows as **Overdue**. The Admin edits
everything; the assignee changes the status and comments; members see only their own tasks (API-enforced). Each task
keeps its comments and a history of changes.

## Notifications and reminders

In-app notifications (bell / Notifications page, read and unread, mark unread):

- assignment and re-assignment → the assignee;
- completed by the assignee → the Admin who created the task;
- comments → the other party;
- **automatic reminders** (scheduler, every 15 minutes, primary website only): once when a task is due within 24 hours,
  and once a day while it is overdue (the creator also hears about the first overdue day);
- **manual reminders** from Development team → Reminders, a member's ⋯ menu or a task: to one member or the whole team,
  optionally about a task.

Every reminder (manual, automatic and assignment) is kept in the **Reminders** history.

## Storage

Members are the existing accounts (`employees`, `credentials`, hashed with the existing password hashing); activation
links use the existing reset-token store (hash only). Tasks, reminders and team notifications are shared collections
(`devTasks`, `teamReminders`, `teamNotifications`, scope `_shared`) — with `DATABASE_URL` they are in PostgreSQL and
survive restarts and redeploys.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/api/dev-team/overview` | devteam.manage |
| GET · POST | `/api/dev-team/members` | devteam.view · devteam.manage |
| PATCH · DELETE | `/api/dev-team/members/:id` · POST `/status`, `/resend-invite` | devteam.manage |
| GET · PUT | `/api/dev-team/roles` · `/api/dev-team/roles/:role` | devteam.manage |
| GET · POST | `/api/dev-team/tasks` | devteam.view (own tasks) · devteam.manage |
| GET · PATCH | `/api/dev-team/tasks/:id` | devteam.view (assignee: status only) |
| POST · DELETE | `/api/dev-team/tasks/:id/comments` · `/api/dev-team/tasks/:id` | devteam.view · devteam.manage |
| GET · POST | `/api/dev-team/reminders` | devteam.manage |
| POST | `/api/notifications/:id/read` · `/api/notifications/:id/unread` | signed in |

Tests: `apps/api/test/team/devteam.test.ts`, `apps/web/test/devTeamPages.test.tsx`, `apps/web/test/devTeamNav.test.tsx`,
`apps/api/test/persistence/googleTeam.test.ts` (PostgreSQL).
