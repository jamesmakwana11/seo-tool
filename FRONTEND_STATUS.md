# FRONTEND_STATUS — DeoDap SEO Sentinel (Phase 1)

> **Update 30 Oct 2026.** The web app now always talks to the API server. The in-browser adapter, its sample data, the
> development role preview and all sample-data labels were removed at the owner's request. The web tests use a fixture
> adapter (`apps/web/test/support/fixtureApi.ts`). New: **Website sync** in the Crawl Center and on the Dashboard (Sync Now,
> Auto Sync every 12 hours, last and next sync, history) — see `docs/WEBSITE_SYNC.md`. The sections below record Phase 1 as
> it was evaluated.

_Last updated: 14 Oct 2026 · Phase 1 gate evaluated: **PASS with documented limitations** · Phase 2 backend now exists (see `BACKEND_STATUS.md`); no database._

> **Phase 2 update.** The UI now also runs against the real API (`VITE_API_MODE=http`, HTTP client in `apps/web/src/api/http/`): the same
> 540-visit smoke passes with 0 failures against the server. Added since the Phase 1 gate: a server sample-data banner (`server sample-data flag`),
> the development role preview in dev builds of http mode, and **Sync data now** on GA4 / Search Console / CrUX integration cards (failed
> or skipped syncs are shown as errors, never as success). The http build excludes the mock adapter and sample seed (main chunk 386 kB).

## 1. What Phase 1 is (and is not)

`apps/web` is a complete React/TypeScript single-page app running against an **in-browser sample adapter**
(`apps/web/src/api/mock/mockApi.ts`) that implements the full `SentinelApi` contract (`packages/shared/src/api.ts`).

- All data is **deterministic sample data** (`packages/shared/src/seed/*`), labelled sample/SIMULATED on every screen.
- State lives **in browser memory only** — reloading the page restores the seed. Nothing is persisted.
- Nothing is connected to live analytics, Search Console, Shopify, backlink APIs, AI engines or notification channels.
  Crawls started from the UI are **SIMULATED** (no HTTP requests). Deliveries report `skipped_not_configured`.
  Integrations never report "connected".
- The mock enforces the same permission matrix and task-transition rules the backend will, so workflows can be exercised
  end-to-end. The backend (Phase 2) must enforce them independently server-side.

Run it: `npm install` at the repo root, then `npm run dev:web` (http://localhost:5173). Sign in with the **Development role preview**
buttons (Admin / SEO Specialist / Developer) or any sample account email with password `<fixture password>`.

## 2. Screens implemented

All 83 screens from prompt §4.2 are implemented (requirements `CUS-SCR-01…83` in `FEATURE_TRACEABILITY.md` map each to a route).
60 routes plus dynamic detail routes:

- Added 16 Oct 2026 (Phase 2): **All pages** `/pages` (site and template scores, to-do list, page list with scores, CSV export) and **Page report** `/pages/report?run=&url=` — see `docs/PAGE_AUDIT.md`.
- Added 17 Oct 2026: **Image Audit** `/images` (start / cancel, progress, results by state and problem, image details with the pages showing it, CSV / JSON export) — see `docs/IMAGE_AUDIT.md`; Smart Crawl budget (1,000 pages) and pending URLs on the Crawl Center and run pages.

| Area | Routes |
|---|---|
| Auth & shell | `/login`, `/forgot-password`, `/reset-password`, app shell (collapsible sidebar, breadcrumbs, global search Ctrl K, notifications bell, account menu, DEV role preview), `/search`, `/notifications` (+ delivery log), `/profile` |
| Dashboard & health | `/` (health dial, today's changes, critical alerts, SLA watchlist, issue counts by severity×module, CWV by template, indexation, visibility, AI-mention share, crawl activity; developer variant leads with assigned tasks), `/health` (formula, module contributions, 30/60/90-day + per-module trends) |
| Audit modules | `/modules/technical` + `/crawlability` `/responses` `/canonicals` `/security` `/structured-data`, `/modules/performance`, `/content`, `/onpage`, `/offpage`, `/offpage/backlinks`, `/aeo`, `/geo`, `/ai-compliance` (flags, passages, rewrites, publish QA gate), `/ai-visibility` |
| Crawl & issue ops | `/crawls` (full/smart/re-verify controls, schedules, history), `/crawls/:id` (scope, URLs changed/failed, sitemap diff, re-verification), `/verification`, `/issues` (board with all PDF §12.3 filters), `/issues/:id` (Fix Card, evidence & URLs, history, child issues, allocation, not-an-issue, reopen), `/issues/groups`, `/issues/exclusions` |
| Tasks & team | `/tasks` (overview + new task), `/tasks/my`, `/tasks/board` (Kanban, drag + keyboard "Move to…"), `/tasks/list` (10 views: all, mine, team, overdue, SLA watch, review, verification, blocked, completed, reopened), `/tasks/:id` (full task record), `/workload`, `/team/allocations`, `/team/employees`, `/team/roles` |
| Opportunities | `/opportunities`, `/opportunities/keywords`, `/gaps`, `/briefs`, `/briefs/:id` (editor), `/clusters`, `/seasonal`, `/link-building`, `/mentions`, `/competitors` |
| Reports & config | `/reports/daily` (all 8 PDF §12.1 sections + one-tap allocation on each issue line), `/weekly`, `/monthly`, `/history`, `/settings/notifications`, `/settings/integrations`, `/settings/thresholds`, `/settings/crawl`, `/ai-compliance/rules` (rule builder + 30-day dry run), `/audit`, `/system`, `/diagnostics` |

**Added in October 2026 (Go/Rust crawler, Lighthouse, Shopify):**

| Screen | What |
|---|---|
| `/crawls/:id` | Server-paged Pages table (search, filters by status / crawl state / indexability / problem / found via / template, sort), page drawer (crawl state, found via/on, inlinks, heading outline, **Fix in SEO editor**), Issues tab filtered to the run, Coverage tab (URL accounting, exclusions by reason, sitemap vs links, duplicates — confirmed vs candidates), Run diagnostics (engine, outcome, speed, memory per process) |
| `/crawls` | Engine status (Go crawler / Rust text core installed, memory budget), exclude patterns, live coverage counters, Lighthouse panel (mobile / desktop audits and rendered-vs-raw check with results drawer) |
| `/optimize/:field` | SEO optimization lists (titles, meta-descriptions, h1, image-alt, tags): current value, problems, suggestion; filters; select and bulk-fix |
| `/seo-editor` | Shopify SEO editor: open a page by URL or browse resources, drafts with current vs proposed values, reason, validation, mutation used, manual edits, H1 source; field assessments and suggestions (keep / use suggestion); batch review with live values, conflicts, selectable changes and one Apply button (no typed phrase); per-field results and storefront re-check; H1 “Change in theme”; **Theme changes** tab (file editor, diff proposals; live theme only after backup download + live-theme phrase) |
| `/settings/shopify` | Connect with Shopify (OAuth), granted / missing scopes, capabilities, disconnect, where the token is kept |

**Added 16 Oct 2026 (crawl reliability + Change Monitor):**

| Screen | What |
|---|---|
| `/crawls` (live progress) | phase, queue (queued / active), gap between requests, requests per minute now + total, 429 / 503 answers and slow-downs, retries, time since the last answer (red after 60 s while running), post-crawl checks done / total per group; pages per minute is the last minute's rate, not an average since the start |
| `/crawls` → Change Monitor panel | baseline (crawl, date, URLs, merged smart crawls), what each recorded crawl changed (changed / new / removed / failed), effect on the baseline, storage folder with the "temporary unless persistent disk" warning, retention |
| `/crawls/:id?tab=changes` | counts per type (clickable), baseline effect and notes, server-paged list (50 per page) with search over URL and old / new values, filters (type, field, evidence), open issues per row, CSV / JSON export of the filtered list; drawer with old → new values per field, added / removed lists, evidence, both observation times, open issues with links, **Capture screenshots** and **Compare versions** |
| `/crawls/compare?url=` | capture now (desktop / mobile), watch a page after every crawl, browser / memory availability; previous / current capture pickers; **Visual** (side by side, pixel-difference image, % changed, cut-height note), **Rendered HTML** (line diff with both line numbers; download either version), **SEO fields** (rendered title / meta / H1 / canonical / robots + the crawler's raw-HTML comparison), **CSS / JS** (added / removed / changed files, line diff per file), **Theme source** (Shopify, read-only snapshots, files added / removed / changed, line diff) — each view says why it is empty instead of showing anything made up |

**Screens pending:** none. **Screens intentionally absent:** none — log-file ingestion (PDF §2, marked optional) has no screen.

## 3. Role experiences (DEVELOPMENT preview — not production auth)

| Role | Preview user | Highlights | Denied (verified by smoke test) |
|---|---|---|---|
| Admin | Aarav Mehta | Everything incl. roles matrix, integrations, automation opt-ins, system health, diagnostics | — |
| SEO Specialist | Ritesh Patel (SEO lead) | Modules, findings, Fix Cards, allocation, task assignment/review, verification trigger, opportunities, rules, reports, thresholds | `/team/roles`, `/system`, `/diagnostics` |
| Developer | Ankit Sharma | Development dashboard (assigned tasks first), technical/on-page/performance modules, task detail with root cause, exact fix + code, evidence, acceptance criteria, SLA countdown, progress, blockers, before/after evidence, submit for review, verification outcome | Opportunities, rules, settings, audit, roles; other teams' tasks (API 403 → "belongs to another team") |

Teams (1into2 SEO / Content / Development) are separate from roles throughout.

## 4. Functional interactions tested

| Evidence | What it proves |
|---|---|
| `packages/shared/test/rules.test.ts` — **62/62 pass** | Check library transcription counts per PDF table; severity matrix (check × tier, thresholds from config); SLA (same-day IST / 7 / 30); escalation (Tier-1 promotion, SLA breach, ≥3 template grouping, 24h unallocated clock); priority formula + tier tie-break; health score weights/normalisation/Tier-1 5×; task transitions & role rules (dev can't self-review, only system verifies); every sample issue yields a complete Fix Card; root-cause inference; CTR draft variants; AI-content heuristics; all PDF §10.2 example rules; seed integrity |
| `apps/web/test/mockApi.test.ts` — **20/20 pass** | Auth (bad creds, inactive accounts, reset round trip, no account enumeration); permission enforcement (developer blocked from allocate/settings/crawl/roles, team-scoped task visibility, admin lock-out protection); one-tap allocation → task with Fix Card description, P1 from Critical, SLA due date, trail + audit; reallocation notifies both team leads; bulk template allocation; full lifecycle with invalid transitions, required notes, developer submit ≠ verified, SEO review, simulated verification fail → back to work; connector checks stay `pending_data`; manual attestation never verifies; not-an-issue requires reason + exclusion; report delivery never claimed; integrations never "connected", secrets rejected; dry run required before enabling, LLM rules need provider; weights must sum to 100%; simulated crawl labelled; brief only from approved gap |
| `apps/web/test/components.test.tsx` — **4/4 pass** | Health dial renders 7 weighted arcs; badges carry text; SLA breach label; Fix Card renders every PDF §11.1 section incl. root cause and human-approval notice |
| `apps/web/e2e/smoke.mjs` — **540 visits, 0 failures** | 60 routes × 3 roles × widths 1440/768/390: no page errors, no console errors, no horizontal overflow, every page has a heading or an explicit access-denied/other-team message, every page shows a sample/SIMULATED indicator. Interactions: one-tap allocation creates a task; keyboard focus visible; global search finds an issue; developer denied Roles page and nav entry hidden |
| `apps/web/e2e/a11y.mjs` — **0 violations** | axe-core WCAG 2.0/2.1 A + AA on 19 key screens (login, dashboard, health, issues, issue detail, kanban, task list, task detail, modules, crawls, opportunities, brief editor, daily digest, rule builder, thresholds, employees, notifications) |

Additional manual verification during build: agents exercised disavow approval, QA-gate approval (note validation), opportunity
conversion, crawl start/poll, cron edit validation, mark-all-read, password reset flow, brief editing, rule dry run in a real browser.

**Not covered by automated tests:** Kanban HTML5 drag-and-drop gesture (the same transition logic is covered via the keyboard
"Move to…" path and MOCK tests); per-field behaviour of every settings form (validation is server-side in the mock and covered for
weights/alerts); print layout of the monthly report.

## 5. Build / lint / type-check

| Check | Command | Result |
|---|---|---|
| Type-check (shared) | `npm run typecheck -w @sentinel/shared` | ✅ 0 errors |
| Type-check (web) | `npm run typecheck -w @sentinel/web` | ✅ 0 errors (TS 5.6.3, strict) |
| Lint | `npm run lint -w @sentinel/web` | ✅ 0 errors, 0 warnings (`--max-warnings 0`) |
| Unit/component tests | `npm test -w @sentinel/shared`, `npm test -w @sentinel/web` | ✅ 62 + 24 pass |
| Production build | `npm run build -w @sentinel/web` | ✅ builds; route-level code splitting. Warning: main chunk 568 kB (177 kB gzip), charts chunk 397 kB |
| Route smoke | `npm run e2e -w @sentinel/web` (needs `npm run preview` on :4173) | ✅ 540/540 |
| Accessibility | `node apps/web/e2e/a11y.mjs` | ✅ 0 violations |

## 6. Responsive checks

Automated at 390px (phone), 768px (tablet) and 1440px (desktop) for every route and role (no document or `main` horizontal overflow).
Fixed during the gate: grid items defaulting to `min-width:auto`, absolutely-positioned `sr-only` labels leaking out of horizontal
scroll containers (Kanban/tables), and a negative-margin overflow on the Kanban board. Screenshots reviewed for dashboard (390/1440),
issue detail, task detail, Kanban.

## 7. Known issues & limitations (frontend)

- **sample data only.** Health history, CWV, indexation, visibility, backlinks, AI visibility, keyword gaps and competitors are sample
  data. Health history does not change when you fix issues during a session (the current score does).
- **Persistence:** none. Reload resets all changes. By design until the database phase is authorised.
- Only the latest completed smart crawl carries URL-level results and a sitemap diff; older runs show empty states.
- Simulated re-verification passes only when "after" evidence is attached (documented rule); checks that need connectors return
  `pending_data` and never pass.
- API gaps noted while building (to address in Phase 2 API design): no task title/description edit endpoint; no per-view task
  count endpoint (overview pages several queries); link-prospect status is read-only; past report snapshots are not stored (exports
  regenerate from current data); weekly report `backlinkDelta` for competitors is 0 (no competitor link series); digest lines don't
  carry template-group flags; `listBacklinks/getAiVisibility/getLocalHealth` return `available:true` with a sample note in mock mode.
- Main JS chunk > 500 kB (recharts + seed in the mock adapter). Acceptable for an internal tool; the seed moves server-side in Phase 2.

## 8. Phase 1 completion gate (prompt §8)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Entire PDF + additional requirements inventoried | ✅ | `FEATURE_TRACEABILITY.md` — 330 requirements (88 check-table rows, 83 screens) generated with validation |
| 2 | Every required screen implemented | ✅ | §2 above; CUS-SCR-01…83 TESTED (SMOKE) |
| 3 | Necessary nested detail screens | ✅ | issue, task, crawl run, brief editor, technical sub-groups, backlinks |
| 4 | Navigation and routes work | ✅ | SMOKE 540/540 |
| 5 | Admin / SEO Specialist / Developer previewable | ✅ | DEV role preview; SMOKE runs all three |
| 6 | Role-aware UI permissions | ✅ | nav filtering + route guards + disabled controls; SMOKE denied list |
| 7 | Temporary task assignment & progress interactions | ✅ | MOCK (assign, reassign, progress, blockers, evidence, comments) |
| 8 | Task lifecycle & transition validation | ✅ | SHARED + MOCK |
| 9 | Issue filtering, sorting, search, status controls | ✅ | Issues board (URL-synced filters incl. allocator), MOCK |
| 10 | Fix Cards with required details + allocation | ✅ | COMP, SHARED completeness, SMOKE interaction |
| 11 | Sample data clearly labelled | ✅ | SMOKE asserts on every route |
| 12 | Loading, empty, error, success states | ✅ | `Async` + toasts on all screens; SMOKE asserts no error state renders |
| 13 | Responsive layouts checked | ✅ | §6 |
| 14 | Build and frontend checks pass | ✅ | §5 |
| 15 | Broken links/controls/errors corrected | ✅ | SMOKE 0 console/page errors; a11y 0 violations |
| 16 | FRONTEND_STATUS.md complete | ✅ | this file |
| 17 | FEATURE_TRACEABILITY.md updated with evidence | ✅ | regenerated after the gate |
| 18 | Unimplemented/blocked frontend requirements identified | ✅ | §7; traceability lists every P1+P2 item as PARTIAL with its Phase 2 / credential dependency |

**Gate decision:** Phase 1 complete for the frontend scope. Every requirement that also needs a server or live data is recorded as
PARTIAL, not done. Proceeding to Phase 2 (backend with in-memory repositories). **No database work has started.**
