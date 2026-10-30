# Update notes — 30 October 2026

## Changes applied

1. **RBAC permission-matrix read access**
   - `GET /api/permissions` now requires `roles.manage`, matching the Roles & Permissions page guard.
   - The admin service enforces the same permission. A custom role can manage the role matrix without also receiving employee-directory access (`employees.view`).
   - Added a regression test in `apps/api/test/api/rbac.test.ts` for that exact permission combination.

2. **Render/PostgreSQL deployment instructions**
   - Corrected the Render deployment steps: create a PostgreSQL database and set its Internal Database URL as the web service's `DATABASE_URL`.
   - Production verification now expects `storage.kind = "postgres"`.
   - Clarified that `ALLOW_EPHEMERAL_STORAGE=true` is only a staging/pilot escape hatch and must not be used for production data.
   - Updated stale environment and composition-root comments that incorrectly described storage as in-memory-only.

## Validation

- Changed TypeScript files passed TypeScript transpilation/syntax checks.
- Full `npm ci`, typecheck, and automated tests could not be completed in this environment because the npm registry request timed out and the required package tarballs were not available in the local npm cache. Run the commands below after extracting the ZIP in an environment with npm registry access:

```bash
npm ci
npm run typecheck
npm test
npm run build:prod
```

The existing Go crawler, Rust text core, React/Vite frontend, Express API, Shopify functionality, and other project modules were left intact.
