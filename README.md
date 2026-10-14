# DeoDap SEO Sentinel

Internal daily SEO audit, recommendation and task-operations platform for deodap.in (Shopify).
Specification: `docs/seotooldocs.pdf` · Build brief: `docs/MASTER_BUILD_PROMPT.md`.

| Package | What |
|---|---|
| `packages/shared` | Domain types, PDF check library, severity/SLA/escalation/scoring/task-workflow rules, Fix Card engine + playbook, read models, API contract, DEMO seed |
| `apps/web` | React frontend — talks to the API (`VITE_API_MODE=http`) or to an in-browser DEMO adapter (`VITE_API_MODE=mock`, default) |
| `apps/api` | Express backend (Phase 2): auth, permissions, issues/tasks workflow, real HTTP crawler + 54 analyzers, connectors + GA4/GSC/CrUX syncs, delivery, scheduler. **Temporary in-memory storage** |

Deployment (Docker, env vars, production checks, PostgreSQL status): `DEPLOYMENT.md`.

Status documents: `FEATURE_TRACEABILITY.md` (generated: `npm run traceability`), `FRONTEND_STATUS.md`, `BACKEND_STATUS.md`.

**Database: not implemented.** Phase 3 starts only on explicit authorization.

```bash
npm install
npm run dev:api                          # API on http://localhost:4000 (DEMO data loaded, dev role preview on)
VITE_API_MODE=http npm run dev:web       # http://localhost:5173 against the API — use the Development role preview buttons
npm run dev:web                          # …or the frontend alone on the in-browser DEMO adapter
npm test --workspaces --if-present
```

A hosted review build (DEMO adapter, no backend) can be packaged with `apps/web/scripts/package-review.mjs` — see `BACKEND_STATUS.md`.

API configuration: `apps/api/.env.example` (variable names only — secrets are never committed). Nothing contacts deodap.in or any
third-party API until you set the credentials and pass a connection test.
