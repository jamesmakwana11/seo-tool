# Backend status — Phase 2

_Last updated: 14 Oct 2026 · Phase 2 gate evaluated: **PASS with documented limitations** · Storage: **temporary in-memory** · **No database work has been started** — Phase 3 waits for your explicit authorization._

## 1. What exists

`apps/api` is a Node 22 / Express 4 / TypeScript service that implements every method of the single `SentinelApi` contract
(`packages/shared/src/api.ts`). The web app talks to it with `VITE_API_MODE=http`; the in-browser DEMO adapter (`mock`) still works.

| Area | What it does | Where |
|---|---|---|
| Composition root | Wires repositories → adapters → services; no storage implementation leaks into business logic | `src/container.ts` |
| Repositories | Interfaces for every collection + a labelled in-memory implementation (lost on restart) | `src/repositories/` |
| Auth | Email + password (scrypt), HMAC session tokens backed by revocable sessions, password reset without account enumeration, profile, account status, DEV role preview (refused in production) | `src/services/auth.ts` |
| Websites | Multi-website workspaces: each website has its own repositories and crawler (issues, Fix Cards, crawls, reports, settings, integration configuration); people, sessions and permissions are shared. Requests are bound to one website by the `X-Website-Id` header (AsyncLocalStorage); unknown ids get 404. New websites start empty with schedules off | `src/websites.ts`, `src/http/app.ts` |
| Permissions | Every endpoint checks the role permission matrix server-side; developers may only update the status of issues allocated to their team | `src/services/context.ts`, each service |
| Issues | Ingestion from crawls and connector syncs: exclusions, delta detection, severity = check × page tier, SLA, regression reopen, auto-resolution only when re-checked, template grouping that supersedes page-level cards, real-time alerts, one-tap allocation, bulk allocation, Not-an-issue → exclusions | `src/services/issues.ts` |
| Issue workflow | Task management was removed (14 Oct 2026). Issues move Assigned → In progress → Fixed via `POST /api/issues/:id/status`; only `POST /api/issues/:id/verify` (a system re-check) can verify. An internal work record per issue still carries SLA, verification history and regression reopen — it has no API or UI | `src/services/tasks.ts` |
| Crawler + analysis | Real HTTP crawler (robots, sitemaps, redirects, TLS, host variants, parameter/pagination samples, outbound links, third-party scripts); 54 analyzers; smart / full / re-verify plans; refuses any non-loopback site unless `CRAWLER_ALLOW_LIVE=true` | `src/crawler/`, `src/analysis/`, `src/services/crawls.ts` |
| Connectors | Connection tests for all 14 PDF §15 sources + delivery channels; honest states (not configured / credentials missing / failed / connected / partial / rate limited / sync failed) | `src/connectors/` |
| Data syncs | GA4 → page value + PDF §3.1 tiers; Search Console → visibility, page impressions/clicks, striking distance; CrUX → Core Web Vitals + PERF-CRUX issues. Run only after a passed connection test | `src/sync/` |
| Delivery | Email (SMTP), WhatsApp Cloud API, Slack webhook with retries; every attempt recorded; never "delivered" without provider confirmation | `src/notifications/` |
| Custom rules & QA gate | Rule builder validation (ReDoS guard), 30-day dry run required before enabling, LLM-judged rules only with a provider, rules applied to crawled page text, QA-gate holds with human sign-off | `src/services/rules.ts` |
| Reports | Daily digest / weekly / monthly from live state, export (JSON/CSV/Markdown), send through configured channels | `src/services/reports.ts` |
| Jobs | In-process IST scheduler: crawl schedules, 00:30 escalations + 24h auto-allocation + SLA notices, 01:00 connector syncs, 08:00 digest, Monday weekly, monthly | `src/jobs/` |
| HTTP | 101 routes, request ids, consistent error body `{ error: { code, message, details }, requestId }`, Shopify webhook with HMAC check, diagnostics ring buffer | `src/http/` |

Configuration: every variable is documented in `apps/api/.env.example` (names only, no values). Secrets are read from the
environment only, refused as UI settings, redacted from logs, errors and stored results.

## 2. How to run it

```bash
npm install
npm run dev:api                          # http://localhost:4000 — DEMO data loaded, role preview enabled
VITE_API_MODE=http npm run dev:web       # http://localhost:5173 — proxies /api to :4000
```

For a clean live start: `SEED_DEMO_DATA=false`, set `CRAWLER_BASE_URL=https://deodap.in`, `CRAWLER_ALLOW_LIVE=true`, the connector
credentials you have, and `SCHEDULER_ENABLED=true`. Then run **Test connection** for each integration in Settings → Integrations;
data syncs only start after a passed test.

### Hosted review build

A private review link (published 14 Oct 2026) runs the full web app on the in-browser DEMO adapter: every screen and workflow,
the same permission and issue-workflow rules, nothing persisted (websites you add are lost on reload). It does **not** include this API server — hosting a long-running
Node process needs a hosting account, which this workspace does not have. Differences from a normal build: in-memory routing (the
URL does not change), Print hidden, and exports are copied to the clipboard because the host blocks downloads. Rebuild with:

```bash
cd apps/web
VITE_API_MODE=mock VITE_ROUTER=memory VITE_HOSTED_REVIEW=true npx vite build --outDir <dir>
node scripts/package-review.mjs <dir>
```

## 3. Verification (last run 14 Oct 2026, after the multi-website / task-removal change)

| Suite | Result |
|---|---|
| `apps/api` — 22 files, 260 tests (incl. new website isolation and issue-workflow tests) | ✅ all pass |
| `packages/shared` — 62 tests | ✅ all pass |
| `apps/web` — 28 tests (incl. website isolation with a call in flight while switching) | ✅ all pass |
| Typecheck (`tsc --noEmit`) api, web, shared · ESLint web (0 warnings) | ✅ clean |
| Route smoke, 56 routes × 3 roles × 3 widths = 504 visits, against the real API **and** the in-browser DEMO adapter | ✅ 0 failures in both; 5 interaction checks pass (allocation, focus, search, new website starts empty, developer denied) |

Notable server behaviours covered by tests: developers get 403 on allocation/audit and on updating another team's issue; only the
system can verify; a FIXED issue closes automatically when the next crawl finds 0 failing URLs and returns to work otherwise;
regressions reopen to the same team; DEMO issues never "pass" verification; integrations are never "connected" without a passed
test; reports sent with no configured channel claim no delivery; crawls refuse to start without an allowed site.

## 4. Bugs found and fixed during the gate

- **Issue identity across runs.** Analyzers emit several findings per check × template (one per blocked AI bot, one per near-duplicate
  cluster), but ingestion matched only on check × template, so later runs updated the first issue and left the others stale.
  Issues now carry a `findingKey`; tests cover independent tracking and resolution.
- **Template grouping.** Server-created groups did not supersede their children (PDF §11.2.4) and bulk allocation skipped superseded
  children. Children are now `SUPERSEDED` (same model as the DEMO seed), allocated with the parent, and verified with it.
- **Audit gaps.** Real-time alerts were not in the audit log (PDF §17.5); they are now, with the provider outcome per channel.
- The route smoke assumed a fresh DEMO dataset (fixed issue and crawl ids). Against a long-lived API, an earlier run's allocation
  persists and the seed's crawl count depends on the date; the smoke now picks an unallocated Critical from the board, taps its
  engine-suggested team, and uses a crawl id that exists on every date.
- Several tests were found to be vacuous during review (an early `return`, a `≥ 0` check, a tautology) and were rewritten to assert
  real behaviour.

## 5. Not done / limitations (each is also in `FEATURE_TRACEABILITY.md`)

**Needs your input or credentials (BLOCKED / unverified):**
- **Nothing has been run against deodap.in or any live third-party API.** All connector code is tested against stubbed responses only.
- **DeoDap Task Ops** — sync is switched off with the removal of task management; the adapter code remains but is not called or shown.
- **< 5% false positives on Criticals** (PDF §16) needs production feedback data.
- **Digest arrives by 08:00 IST** can only be confirmed with real SMTP / WhatsApp / Slack credentials.

**Not implemented (PARTIAL):**
- No headless JS renderer: TECH-JS-RENDER and TECH-MOBILE are reported as "not evaluated"; the weekly full crawl has no JS sample.
- Data syncs for Ahrefs/Semrush (backlinks, keyword gaps, competitors, toxic links), Google Business Profile, Shopify product data
  and AI-engine visibility sampling are not built — those screens show labelled DEMO data, or "not available" on a clean start.
- Search Console analysis beyond visibility / impressions / striking distance (cannibalization, decay, low CTR, rich results) is not
  built; index-coverage counts are not available from the public API and are never fabricated.
- LLM-written rewrite drafts; title/meta variants are template-based with a heuristic CTR score.
- Custom-rule hits become AI-compliance flags (digest section), not full Issues with Fix Cards and re-verification. Rule schedules
  (weekly / on-publish) are stored but all enabled rules run on every crawl.
- Built-in YMYL findings (AIC-07) are not yet turned into held QA-gate flags.
- Email/WhatsApp digests link to the app; signed one-tap allocation links are not implemented.
- Optional opt-in automations (auto-301, schema updates) have switches (Admin-only, off by default) but no implementation.
- Log-file ingestion (optional in the PDF) is not built.
- API gaps carried from Phase 1: no task title/description edit endpoint, no per-view task count endpoint, link-prospect status is
  read-only, report history is regenerated rather than snapshotted.

**Multi-website limits:** websites added through the API live in memory and disappear on restart (with all their data); the primary
website's domain comes from server configuration; a website's domain cannot be changed after it is added; crawling any non-loopback
website still needs `CRAWLER_ALLOW_LIVE=true`; connector credentials are server-wide environment variables, but each website keeps its
own connection-test results and settings.

**By design until Phase 3:** all data lives in memory and is lost when the API restarts. System health says so.

## 6. Phase 2 gate checklist

| # | Criterion | Result |
|---|---|---|
| 1 | Every `SentinelApi` method has a server endpoint with validation and consistent errors | ✅ |
| 2 | Business logic depends only on repository interfaces; in-memory implementation is labelled | ✅ |
| 3 | Roles and permissions enforced server-side, independent of the UI | ✅ API permissions tests |
| 4 | Task lifecycle, verification and regression enforced on the server | ✅ |
| 5 | Crawler makes real requests and reports failures honestly; refuses unapproved sites | ✅ |
| 6 | Connectors report accurate states; no synthetic success | ✅ |
| 7 | Deliveries recorded with real outcomes; nothing claimed without provider confirmation | ✅ |
| 8 | No secrets in code, logs or responses; `.env.example` documents every variable | ✅ |
| 9 | Unit + API tests with deterministic fixtures | ✅ 350 tests across the repo |
| 10 | Frontend runs against the real backend | ✅ http-mode smoke, 0 failures |
| 11 | Unimplemented and blocked items documented | ✅ §5 and traceability |
| 12 | No database, schema, ORM, migration or connection string | ✅ none exist |

**Verdict:** Phase 2 passes. The remaining work is either connector data syncs for sources without credentials, or depends on
inputs listed in §5.

## 7. Resuming

- Last build: all suites green on 14 Oct 2026 (see §3). No outstanding errors.
- Next action: **waiting for your decision** — authorize Phase 3 (database), and/or provide credentials (GA4, Search Console, CrUX key,
  Shopify, SMTP/WhatsApp/Slack, Task Ops API details) so the integrations can be verified live.
- **Database: not started.**
