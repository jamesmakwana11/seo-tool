# DeoDap SEO Sentinel

Internal daily SEO audit, recommendation and task-operations platform for deodap.in (Shopify).
Specification: `docs/seotooldocs.pdf` · Build brief: `docs/MASTER_BUILD_PROMPT.md`.

| Package | What |
|---|---|
| `packages/shared` | Domain types, PDF check library, severity/SLA/escalation/scoring/task-workflow rules, Fix Card engine + playbook, read models, API contract, test fixtures |
| `apps/web` | React frontend — always talks to the API server |
| `apps/api` | Express backend (Phase 2): auth, permissions, issues/tasks workflow, crawl orchestration + 54 analyzers (streamed in batches), Lighthouse runner, Shopify OAuth + SEO editor, connectors + GA4/GSC/CrUX syncs, delivery, scheduler. **PostgreSQL storage** with `DATABASE_URL` (`docs/DATABASE.md`); temporary in-memory storage without it |
| `services/crawler-go` | Go production crawler (`bin/sentinel-crawler`): sitemaps (index, gzip), URL normalisation, bounded queues, retries, adaptive throttling, robots, SSRF guard; NDJSON protocol v1 with the API |
| `services/textcore-rs` | Rust text core (`bin/sentinel-textcore`): fingerprints, duplicate titles / meta / content, near-duplicate candidates (MinHash/LSH) |

Native binaries: `npm run build:native` (Go 1.22+, Rust 1.75+) · tests: `npm run test:native`.
Shopify connection and SEO editor: `docs/SHOPIFY_SEO_EDITOR.md`.

Change Monitor (crawl-to-crawl changes, screenshots, rendered HTML / CSS / JS / theme source differences): `docs/CHANGE_MONITOR.md`.
Website sync (Sync Now, Auto Sync every 12 hours — crawl only new and changed pages after the first crawl): `docs/WEBSITE_SYNC.md`.
Roles (Super Admin: every section; Admin: Overview and SEO operations): `docs/ROLES.md`.
Run locally with live crawling: `LOCAL_CRAWLING.md`. Deployment (Docker, env vars, production checks, PostgreSQL status): `DEPLOYMENT.md`.

Status documents: `FEATURE_TRACEABILITY.md` (generated: `npm run traceability`), `FRONTEND_STATUS.md`, `BACKEND_STATUS.md`.

**Database: not implemented.** Phase 3 starts only on explicit authorization.

```bash
npm install
npm run dev:api                          # API on http://localhost:4000 — set ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD (apps/api/.env.example)
npm run dev:web                          # http://localhost:5173 against the API — sign in with that admin account
npm test --workspaces --if-present
```

API configuration: `apps/api/.env.example` (variable names only — secrets are never committed). Nothing contacts deodap.in or any
third-party API until you set the credentials and pass a connection test.
