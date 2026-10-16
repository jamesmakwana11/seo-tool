# Backend status — Phase 2

_Last updated: 16 Oct 2026 · Phase 2 gate evaluated: **PASS with documented limitations** · Storage: **temporary in-memory** · **No database work has been started** — Phase 3 waits for your explicit authorization._

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
| Crawler + analysis | **Go crawler** (`services/crawler-go`, child process, NDJSON protocol v1): sitemaps incl. index + gzip, URL normalisation and dedup, bounded queues, retries, adaptive throttle, robots, SSRF guard, cancellation, progress; **Rust text core** (`services/textcore-rs`, binary frame protocol v1): fingerprints, duplicate titles / meta / content, near-duplicate candidates. Node streams the crawl files through 54 analyzers in batches (identical findings to the Node pipeline, parity-tested), memory budget across all three processes, outcomes completed / partial / cancelled / failed / resource-stopped, server-side paged results and streamed exports. The built-in Node crawler remains for re-verification and as a fallback | `src/gocrawl/`, `src/crawler/`, `src/analysis/`, `src/results/`, `src/services/crawls.ts` |
| Lighthouse | Real Lighthouse 13 mobile / desktop lab audits and a rendered-vs-raw HTML check of one URL, in a separate process, one at a time, memory-gated, own-site URLs only; reports what is missing (package, browser) | `src/lighthouse/`, `runtime/lighthouse-runner.mjs` |
| Change Monitor | Every crawl compared with the baseline (last valid crawl) in a streamed, memory-bounded diff: new / removed (confirmed 404·410, suspected when only no longer found) / failed (never "removed") / changed / unchanged / unchecked, 14 fields with old / new values and evidence; partial / cancelled / resource-stopped crawls never replace the baseline; versioned gzip NDJSON snapshots on disk with retention; server-paged lists, streamed CSV / JSON | `src/changes/` (`snapshot.ts`, `diff.ts`, `store.ts`, `service.ts`) |
| Page comparisons | Screenshots desktop / mobile in Playwright + Chromium (separate process, one browser per server, memory-gated, own-site URLs, private addresses blocked), pixel diff, rendered-DOM diff, CSS / JS files as downloaded, after-crawl captures of watched + changed pages; read-only Shopify theme source snapshots and diffs | `src/changes/capture.ts`, `runtime/capture-runner.mjs`, `src/lib/diff.ts`, `src/shopify/themeSnapshots.ts` |
| Shopify SEO editor | OAuth (HMAC, single-use state, scope check; token in memory only) or env token; URL → product / collection / page / article; drafts from existing text only, validation, manual edits; preview with live values + conflicts, confirmation phrase, batch apply with rate-limit handling and per-field results, read-back verification, storefront re-audit; H1 source detection; theme proposals (diff, backup, unpublished themes only, never publishes) | `src/shopify/` |
| Connectors | Connection tests for all 14 PDF §15 sources + delivery channels; honest states (not configured / credentials missing / failed / connected / partial / rate limited / sync failed) | `src/connectors/` |
| Data syncs | GA4 → page value + PDF §3.1 tiers; Search Console → visibility, page impressions/clicks, striking distance; CrUX → Core Web Vitals + PERF-CRUX issues. Run only after a passed connection test | `src/sync/` |
| Delivery | Email (SMTP), WhatsApp Cloud API, Slack webhook with retries; every attempt recorded; never "delivered" without provider confirmation | `src/notifications/` |
| Custom rules & QA gate | Rule builder validation (ReDoS guard), 30-day dry run required before enabling, LLM-judged rules only with a provider, rules applied to crawled page text, QA-gate holds with human sign-off | `src/services/rules.ts` |
| Reports | Daily digest / weekly / monthly from live state, export (JSON/CSV/Markdown), send through configured channels | `src/services/reports.ts` |
| Jobs | In-process IST scheduler: crawl schedules, 00:30 escalations + 24h auto-allocation + SLA notices, 01:00 connector syncs, 08:00 digest, Monday weekly, monthly | `src/jobs/` |
| HTTP | 135 routes, request ids, consistent error body `{ error: { code, message, details }, requestId }`, Shopify webhook with HMAC check, diagnostics ring buffer | `src/http/` |

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

## 3. Verification

### 16 Oct 2026 (fourth pass) — Phase 2: All pages and the page audit

Done and tested (details, checks, score rules and limits: `docs/PAGE_AUDIT.md`):
- Each crawl row now also records the first 5 images without ALT text, links to other websites, internal nofollow
  links and repeated title / meta description / canonical tags (Go and built-in crawler, same code path).
- Page audit (`packages/shared/src/pageAudit.ts`): 29 to-do checks with recommendations across response, title, meta
  description, H1–H3, canonical, indexability, content, links and images; one scoring rule shared by the server,
  the page list and the page report.
- Server: score / check filters and sort, site average and per-template average, same-title / same-meta pages for the
  page report, `audit_score` / `audit_to_do` in CSV / JSON exports.
- Screens: All pages (`/pages`), page report (`/pages/report`), audit in the page drawer.
- Tests: shared audit rules, memory / file store / shared reference agree, HTTP API (filters, summary, duplicates,
  export), Go crawl of the local fixture store (planted missing ALT and canonical are reported with the HTML evidence).
- Measured on the 25,000-product synthetic store: crawl 105 s → 109–111 s, peak RSS 304 → 308 MB, page report 35–59 ms.

### 16 Oct 2026 (third pass) — sign-in sessions; page audit groundwork

**Sessions no longer expire on their own.** Before: every session ended after 8 hours (`SESSION_TTL_HOURS=8`), every
server restart (Render redeploy / spin-down / memory restart) forgot all sessions because they are kept in memory, and the
browser signed the user out whenever `/api/auth/me` failed for any reason — including the server still starting up.
Now:
- `SESSION_TTL_HOURS` defaults to `0` = signed in until *Sign out* (a positive value still caps sessions).
- The signed token carries the account id and a fingerprint of the password hash. After a restart a correctly signed
  token for the same active account with the same password is accepted again; the first admin and DEMO accounts get the
  same password hash at every start (salt keyed with `SESSION_SECRET`), so their sessions survive restarts.
- A session still ends at sign-out, password change or reset, account deactivation, or a changed `SESSION_SECRET`.
- The browser signs out only on a 401; while the server is unreachable or answers 5xx it keeps the session and retries
  for up to 3 minutes ("Waiting for the server to start — you are still signed in"), then offers *Try again*.
- Limit (no database): the revoked-session list is in memory, so a token signed out *before* a restart is not on it
  afterwards. The browser deletes its token at sign-out; changing the password ends every session for certain.
- Tests: `apps/api/test/api/sessions.test.ts` (no expiry after 400 days, survives restart, sign-out, password change,
  other secret, other account, optional cap) and `apps/web/test/authSession.test.tsx` (retries on network error / 502,
  signs out only on 401).

**Page audit groundwork (Phase 2, partly done, working and tested):** per-page audit score and checks with
recommendations (`packages/shared/src/pageAudit.ts`), score / to-do filters in the page list API,
`GET /api/crawls/:id/page?url=` and `GET /api/changes/for-url?url=`, the *All pages* screen (`/pages`) and the page
report (`/pages/report`). Phases 3 (Shopify edit verification from the page report) and 4 (change-history integration)
are not continued in this pass.

Results of this pass: Go + Rust tests pass · API 441 passed, 1 skipped · shared 92 · web 42 · typecheck, lint and
`build:prod` clean. The full 3-role × 3-width route smoke was not completed in the sandbox time limit; `/pages`,
`/pages/report` and a reload while signed in were checked in Chromium at 1440 px and 390 px (no errors, no overflow).

### 16 Oct 2026 (second pass) — crawl performance under rate limiting

Causes found in the code and fixed:
1. **Retry-After became the permanent gap.** A 429 with `Retry-After: 30` set the gap between *all* later requests to 30 s,
   and normal answers took dozens of requests to bring it down. Now it is a one-time pause; the gap doubles at most once per burst.
2. **The crawl sped straight back into the limit.** After a 429 the gap relaxed below the pace that triggered it, causing the next
   429 and pause. The crawler now remembers that pace (×1.5) and decays it by 10 % per 100 normal answers.
3. **Image and asset checks ignored 429s.** They used `NoRetry`, which also skipped the slow-down, and then repeated each limited
   HEAD as a GET. A 429 on any request now slows the shared per-host queue; a limited HEAD is not repeated.
4. **Rate-limited link / image targets were reported as broken.** A link target answering 429 counted as a "4xx internal link".
   Answers that are still 429 / 503 after the retries are now *deferred* (not checked) and never written as results.
5. **Post-crawl checks had no bound** and ran in discovery order. They now get a time budget (as long as the page crawl, 5–20 min,
   `CRAWLER_CHECKS_BUDGET_MINUTES`), the most-linked targets and images on the most pages go first, and the rest is *deferred*.
6. **No accounting.** Each group (links, images, external, scripts, host, TLS, bot probes, samples) now reports checked, failed,
   deferred, excluded (robots.txt, your exclusions, filter variants beyond the sample) and reused (already answered by the crawl),
   live and in Run diagnostics. Image ALT / dimensions / lazy-loading come from the HTML; each image file is requested once.
7. A 429 to the Googlebot / Bingbot probe is no longer reported as "search bots blocked" when the crawl itself was being rate limited.

Measured on a rate-limited synthetic store (150 products, token bucket 3 req/s burst 6, `429 + Retry-After: 30`; same job:
8 workers, 250 ms delay; `docs/measurements/rate-limited-150-products-*.json`):

| | Previous crawler (this morning's build) | Current |
|---|---|---|
| Page crawl (206 pages) | 1,185 s | 98 s |
| Whole run | stopped by the 25-min measurement limit | 398 s, completed |
| 429 answers from the store | 7 (each made the gap 30 s) | 5 (each a 30 s pause, gap ≤ 450 ms) |
| Images reported failed / not checked | — | 0 failed, 1 deferred (an intermediate build that ignored image 429s: 50 × 429, 24 "failed") |

25,000-product crawl (no rate limit, 288 MB heap): 26,634 pages, ~5,400 pages/min, peak API RSS 305 MB / heap 154 MB, Go 64 MB —
unchanged from before. Tests: Go 25 tests (new: Retry-After pause, deferral over the budget, link accounting, rate-limited image
checks) · API 436 · shared 85 · web 38 — all pass; typecheck and lint clean.

### 16 Oct 2026 — crawl speed / reliability, Change Monitor, visual and code comparison

| Suite | Result |
|---|---|
| Go crawler: `go vet`, `go test -count=1 ./...` — 21 tests, incl. new: coalesced 429/503 back-off, per-host pacing of other hosts, a rate-limited site settling on a moderate gap, capped facet probes + per-group check progress, stall warning in every phase, auxiliary checks done once per target, built-in fallback roots, certificate errors not retried | ✅ all pass (108 s) |
| Rust text core: `cargo test` | ✅ all pass |
| `apps/api` — 43 files, 435 tests, incl. new: bridge stall → partial; Change Monitor end to end on the Go **and** the Node engine (title, meta, H1, canonical, indexability, structured data, content, images / alt, 404 → removed, 503 → failed not removed, carry-over of the last good record); partial / cancelled / failed crawls preserving the baseline; smart-crawl merge; suspected removals; robots / redirect / status changes; truncated pages → suspected; retention and a deleted baseline file; HTTP API paging, page-size cap, filters, CSV / JSON exports, issues per URL; real-Chromium captures (no previous screenshot → said so, pixel diff, DOM diff, SEO fields, CSS diff, after-crawl captures, files served only signed in, HTML served as text, other sites refused), no-browser state; read-only theme snapshots and diffs (no write / publish calls, token not on disk); line-diff bounds | ✅ 434 pass, 1 skipped (opt-in in-process stress test) |
| `packages/shared` 85 tests · `apps/web` 38 tests (incl. diff rendering, side-by-side + difference view, "never made up" state) | ✅ all pass |
| Typecheck api / web / shared · ESLint web (0 warnings) · `npm run build:prod` (bundle syntax-checked, started with `NODE_ENV=production`: `/healthz` 200, change APIs 401 without sign-in) | ✅ clean |
| Route smoke (in-browser DEMO adapter): 59 routes × 3 roles × 3 widths = 531 visits + 5 interaction checks | ✅ 0 failures |

Measured on this sandbox (synthetic store on 127.0.0.1, `node --max-old-space-size=288` as in the Docker image, 450 MB budget):

| Run | Result |
|---|---|
| 25,000 products, two full crawls in one process (`docs/measurements/go-crawl-25k-twice-change-monitor.json`) | 26,633 pages / 53,491 URL rows, 111 s, ~5,700 pages/min; peaks: API RSS 303 MB (heap 159), Go 59 MB, Rust 19 MB. First crawl became the baseline in 6.6 s. The second crawl stopped at 25,077 pages (*resource-stopped*, see limitations): compared in 5.5 s (53,402 URLs, 1,556 unreached pages *unchecked*, none *removed*), baseline kept. Change list page 100: 215 ms; search 217 ms; CSV export of all records 329 ms. History on disk 31 MB |
| 50,000 products (`go-crawl-50k-change-monitor.json`) vs the same run with `CHANGE_MONITOR_ENABLED=false` (`…-off.json`) | 53,234 pages / 106,966 rows, completed, ~4,060 pages/min both; peak API RSS 398 vs 412 MB, heap 238 vs 239 MB (no measurable memory cost); analysis 109.8 vs 102.4 s (+7 %, snapshot writing); baseline written 12.7 s after the crawl; 40 MB on disk |
| Change comparison alone, 50,000 URLs with 5,000 changed, `--max-old-space-size=160` (`test/changes/scale.bench.ts`) | 25 s, peak heap 69 MB, RSS 179 MB; list page 58 ms, full search 269 ms, CSV export (15 MB) 440 ms |

### 15 Oct 2026 — after the Go/Rust crawler, Lighthouse and Shopify SEO editor

| Suite | Result |
|---|---|
| `apps/api` — 37 files, 413 tests (Go bridge: crash / silence / protocol mismatch / cancel → kill / memory stop / no secrets to children; Node vs Go+Rust parity; result store; real Lighthouse + Chromium; Shopify OAuth / drafts / apply / rate limits / conflicts / partial failures / theme safety / no token leaks, against a mock Shopify) | ✅ 412 pass, 1 skipped (opt-in in-process stress test) |
| Go crawler (`go vet`, `go test ./...`, 13 tests incl. sitemaps, gzip, robots, retries, throttle, SSRF, cancellation) · Rust text core (`cargo test`) | ✅ all pass (`npm run test:native`) |
| `packages/shared` — 85 tests · `apps/web` — 34 tests | ✅ all pass |
| Typecheck api, web, shared · ESLint web (0 warnings) · `npm run build:prod` (bundle syntax-checked, started in production mode) | ✅ clean |
| Windows build path: Go cross-compiled to a Windows PE executable; Rust `cargo check --target x86_64-pc-windows-gnu` | ✅ (not run on a Windows machine) |
| Route smoke against the in-browser DEMO adapter: 58 routes × 3 roles × 3 widths = 522 visits | ✅ 0 failures; 5 interaction checks pass |
| Stress, synthetic store on 127.0.0.1: 25,000 products (26,633 pages, 53,491 URL rows) and 50,000 products (53,235 pages, 106,966 rows) | ✅ completed within a 450 MB budget — `docs/measurements/` |

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
- **Shopify writes have never touched a real store.** OAuth, reads, writes, rate limits and theme writes are tested against an
  in-memory mock Shopify (`test/shopify/mockShopify.ts`) whose operations follow the Admin GraphQL schema (checked against the
  2026 schema); the first real use should be a single draft on a test product.
- **DeoDap Task Ops** — sync is switched off with the removal of task management; the adapter code remains but is not called or shown.
- **< 5% false positives on Criticals** (PDF §16) needs production feedback data.
- **Digest arrives by 08:00 IST** can only be confirmed with real SMTP / WhatsApp / Slack credentials.

**Not implemented (PARTIAL):**
- Crawls fetch raw HTML only: TECH-JS-RENDER and TECH-MOBILE are reported as "not evaluated" in crawl results. A rendered-vs-raw
  check and Lighthouse mobile/desktop audits run on demand per URL (Crawl Center → Lighthouse) when Chromium is installed.
- Data syncs for Ahrefs/Semrush (backlinks, keyword gaps, competitors, toxic links), Google Business Profile, a bulk Shopify
  product-data sync (the SEO editor reads resources one by one) and AI-engine visibility sampling are not built — those screens show labelled DEMO data, or "not available" on a clean start.
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

**Change Monitor / comparisons (16 Oct 2026):**
- History lives in `CHANGE_SNAPSHOT_DIR` (default: temp folder). On Render it is lost on every restart / redeploy unless a persistent
  disk is mounted and the variable points at it; the UI says so. Run ids restart with the server, so snapshots are keyed by start time + id.
- Screenshots need Chromium (`INSTALL_CHROMIUM=true`, ≥ 1 GB RAM). On a 512 MB plan without it, every visual view says
  "not available on this server" and why. The pixel-difference image exists only for consecutive captures of one page / viewport.
- A previous screenshot exists only if the page was captured before the change (watched pages are captured after every crawl).
- CSS / JS comparison covers the files a capture downloaded (≤ 25 files, ≤ 1.5 MB each) from the site and `cdn.shopify.com`.
- Theme source is compared only through an authorised connection; it has never been run against a real store (mock Shopify only).
- Internal-link added / removed lists cover the first 150 links of each version in page order (counts and change detection cover all).
- Memory between crawls: after a 26,000-page crawl about 105–115 MB of heap stays in use (in-memory site inventory, issues, crawl
  state — temporary storage, unchanged by this work). With the 288 MB heap of the Docker image, a second 26,000-page crawl in the same
  process completed in 1 of 4 runs and stopped 0.2–8 % early as *resource-stopped* in 3 (one of those with the Change Monitor off);
  such a crawl is compared but never replaces the baseline. Raise `NODE_OPTIONS=--max-old-space-size` with the plan size for repeated
  large crawls.

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
