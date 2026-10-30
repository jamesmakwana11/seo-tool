# Roles and access

| Role | Sidebar sections | Notes |
|---|---|---|
| **Super Admin** | Overview, SEO operations, Audit modules, Opportunities, Reporting, Team, Configuration | Always has every permission; the Roles & permissions screen cannot take any away. |
| **Admin** | Overview, SEO operations | Dashboard, websites, health score, issues board, all pages, verification, Crawl Center, Image Audit, SEO editor, SEO optimization. |
| SEO Specialist, Developer | as before | Unchanged. |

Access is enforced three times, from one permission matrix (`packages/shared/src/config.ts`): the sidebar hides what the role
cannot use, each page's route refuses it ("You don't have access to this page"), and every API call checks the permission on
the server (403). Typing a Super Admin page's URL as an Admin shows the refusal; the API answers 403.

Admin's permissions: `ADMIN_PERMISSIONS` in `packages/shared/src/config.ts`. Two pages that used the issue permission now
belong to their sections: Allocation history needs `employees.view` (Team) and Exclusions needs `issues.manage_exclusions`
(Configuration). Admin still sees employee names on the issue board (`GET /api/employees` returns names and roles only
to roles without `employees.view`).

## Accounts

- `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`: the first account, created as **Super Admin**.
- `SITE_ADMIN_EMAIL` / `SITE_ADMIN_INITIAL_PASSWORD` (optional `SITE_ADMIN_NAME`): an **Admin** account created at start-up
  when no employee has that email. The password is hashed like every other account's and never logged. An existing account
  is never changed, so a password changed under Profile stays changed.
- A Super Admin can also invite people and set roles under Team → Employees.

## Upgrading a server started before the Super Admin role

At the first start: the stored matrix gains the Super Admin role and Admin is limited to its two sections. The `ADMIN_EMAIL`
account becomes Super Admin (without `ADMIN_EMAIL`, the oldest active Admin does). This runs once.

Tests: `apps/api/test/api/rbac.test.ts`.
