# Backend status — Phase 2

_Last updated: 21 Oct 2026 · Storage: **PostgreSQL** with `DATABASE_URL` (temporary in-memory without it) · see the dated sections below._

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
| Shopify SEO editor | OAuth (HMAC, single-use state, scope check; token in memory only) or env token; URL → product / collection / page / article; drafts from existing text only, validation, manual edits; preview with live values + conflicts, confirmation phrase, batch apply with rate-limit handling and per-field results, read-back verification, storefront re-audit; H1 source detection; field assessments + suggestions (configurable guidelines); review token instead of a typed phrase; bulk SEO fixes (crawl pages / issues / chosen URLs → plan → apply with read-back, page re-check, issue closure only after a passed re-verification) and SEO Optimization lists (`src/shopify/bulk.ts`); H1 field written to its source (title, content, or theme file); collection/article image alt; theme proposals (diff, backup; live theme only after backup + separate phrase; never publishes) | `src/shopify/` |
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

### 27 Oct 2026 (second pass) — Shopify app credentials entered in the app, stored encrypted

**Inspected:** the project had no encrypted credential storage — integration settings refuse secrets by design and
the Shopify OAuth token lived in memory only, so "Connect with Shopify" required SHOPIFY_API_KEY / SHOPIFY_API_SECRET /
APP_BASE_URL in the server environment. **Added:** `security/secretBox.ts` (AES-256-GCM, random IV, associated data =
website + field, key = HKDF-SHA256 of CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET) and a per-website
`integrationSecrets` collection (stored in PostgreSQL like every other collection). Settings → Shopify has a "Shopify app
credentials" form (Client ID, write-only Client secret, App URL); `PUT/DELETE /api/shopify/app-credentials`
(integrations.manage) validate and store them, never returning the secret. OAuth uses them: the authorize URL carries
the saved Client ID and the callback URL of the saved App URL; the public callback finds the website from the
(unconsumed) state, verifies the HMAC with that website's secret, then shop / timestamp / single-use state, exchanges
the code with the saved credentials and stores the token encrypted (restored at start-up; Disconnect deletes it). The
saved App URL's sub-path (`/seo-tool`) is recognised like APP_BASE_URL's. A changed key is reported ("could not be
decrypted — enter the Client secret again and connect again") instead of failing silently. Env variables remain a
fallback. **Tests:** `apps/api/test/shopify/app-credentials.test.ts`, `apps/api/test/persistence/shopifyCredentials.test.ts`
(PostgreSQL: ciphertext only in the rows, connection back after a restart), web `integrationsPage.test.tsx`.

### 27 Oct 2026 — Crawler default User-Agent, GSC / GA4 properties from the UI, integrations dropdown, Shopify OAuth under /seo-tool

**Crawler:** the Site crawler card reported `CRAWLER_USER_AGENT` as a missing setting (and its test sent no
User-Agent) although the engine already fell back to the configured default. Now `CRAWLER_USER_AGENT` is optional
everywhere (`crawlerUserAgent()` → `DEFAULT_CRAWLER_USER_AGENT`), only `CRAWLER_BASE_URL` / `CRAWLER_ALLOW_LIVE` are
reported as missing. **GSC / GA4:** the property (GSC) and property ID (GA4) can be saved per website from the card;
they are validated (`sc-domain:` / URL-prefix; numeric ID, Measurement IDs refused), used by the connection test and by
the data syncs (saved value first, env var as fallback), and a test passed for another property no longer counts as
connected. Missing service-account keys, missing Google permissions and a disabled API are reported in plain words; the
GA4 test now calls the Data API (the API the sync uses). **Integrations screen:** Site crawler, GSC and GA4 always
shown; every other integration chosen one at a time from a dropdown (nothing shown until chosen). **Shopify:** the
flow (start endpoint → authorize URL → callback with HMAC, single-use state, shop and timestamp checks → token
exchange → scope check) was correct but only worked at a site root: with `APP_BASE_URL=https://apps.deodap.info/seo-tool`
the callback under `/seo-tool` reached the SPA, and the web app could not load under a sub-path. The API now accepts
the prefix (stripped by the proxy or not) and serves index.html with `<base href>` + the base path; the production web
build uses relative asset URLs, the router basename and API base come from it. A missing `SHOPIFY_API_KEY` /
`SHOPIFY_API_SECRET` / `APP_BASE_URL`, an http `APP_BASE_URL` in production or `SHOPIFY_SCOPES` without the required
scopes now show one actionable message next to the (disabled) button, with the exact redirection URL to register; the
store field validates the `.myshopify.com` domain. Token storage unchanged: server memory only.

**Tests:** `apps/api/test/connectors/integration-properties.test.ts`, `apps/api/test/shopify/oauth-subpath.test.ts`,
`apps/web/test/integrationsPage.test.tsx`.

### 26 Oct 2026 — Self-hosted live crawling for every registered website

**Findings.** Each website under Manage websites already had its own crawler bound to its own URL, and live crawling
is switched on by `CRAWLER_ALLOW_LIVE=true` in the API process environment. What blocked or weakened it: (1) in
production, `CRAWLER_ALLOW_LIVE=true` without `CRAWLER_BASE_URL` stopped the whole server at start-up, so a missing
primary address blocked every registered website; (2) both engines let any loopback host through their "only this
website" guard (test-only, but another local website could be crawled from the wrong workspace); (3) a Start URL that
redirected to another website was followed — that website's page was requested before the crawl was refused;
(4) a website could be registered with a private / metadata IP or internal host name (it was blocked only at request
time); (5) error texts and docs only described Render. **Fix:** the start-up refusal is removed (warning logged; the
primary website reports the missing setting, the others crawl); the guard compares the exact host (www-insensitive,
port included) in both engines; the Start URL is resolved hop by hop and a redirect to another host is refused without
requesting it (Go and Node); registration refuses private, loopback (production), link-local / metadata and internal
addresses and credentials; start-up logs whether live crawling is on; DEPLOYMENT.md has a self-hosted section (where
the API reads its environment, the settings, restart commands). SSRF checks per DNS answer and redirect hop, robots.txt,
retries / back-off, adaptive throttling and per-website storage are unchanged.

**Tests:** `apps/api/test/api/registered-websites-crawl.test.ts` (Go and Node engines: three local websites crawled at
the same time, each only on its own host with its own results; Start URL of another registered or an unregistered site
→ 400; unknown website id → 404; engine refuses another host; a cross-site start redirect fails without contacting the
other website; production config without `CRAWLER_BASE_URL`: a registered website is ready, private / metadata /
loopback / internal addresses cannot be registered; live crawling off → every website names the setting; DNS answers
in private ranges blocked at crawl time), `crawler-config.test.ts` updated for the new start-up rule.

### 24 Oct 2026 (second pass) — Exact details for every finding; repeated images on the same page

**What was missing.** The Image Audit said "Shown more than once on the same page" without saying where, and listed
only the first 5 pages; page-audit findings showed a label ("Same title as other pages in this crawl", "5 of 9 images
without ALT text") with at most 5 image addresses and 10 duplicate pages; issue evidence said "duplicate of N other
page(s)" without the pages; broken links had no status or error type; duplicate H1s were not detected crawl-wide.
**Fix:** the crawlers (Go and Node, same rules) record each image's HTML location; page rows keep every image without
ALT, each image repeated on the page with every copy, and each broken link with its status and error type; a new
crawl-wide *Same H1 as other pages* finding; the page report's duplicates return the shared text and every other page
(up to 10,000, exact total); issue evidence lists each duplicate group once with all its pages; the Image Audit counts
pages showing an image more than once separately from reuse across pages, and a new occurrences endpoint lists every
page and copy from the stored image references. UI: every finding expands in the drawer and page report (values,
lengths and ranges, clickable pages, previews, locations, link table, crawl-wide count with a link); the Image Audit has
thumbnails, a "Repeated on the same page" section and the full, paged page list. Missing data says *could not be
identified* (crawls made before this change, until re-crawled).

**Tests:** `apps/api/test/gocrawl/issue-details.test.ts` (fixture store, Go and Node engines: the repeated badge with both
copies and locations, the badge once on other pages not flagged, duplicate title with every page and one evidence group,
broken link 404 with error type, Image Audit `repeatedPages` / `maxPerPage`, occurrences over HTTP with paging and 404),
`services/crawler-go/location_test.go`, `apps/api/test/gocrawl/store.test.ts` (title / meta / H1 groups in memory and on
disk, all pages listed), `packages/shared/test/issueDetails.test.ts`, web `issueDetails.test.tsx` and `imageAudit.test.tsx`.

### 24 Oct 2026 — Fix guidance with location and time for every issue; DeoDap group websites always saved

**Recommendations — what was missing.** Issues had Fix Cards with steps, but 11 checks (striking-distance queries,
extractability, PAA, featured snippets, new-page QA gate, citation-worthiness, brand mentions, digital PR, disavow,
backlink gap, referring domains) fell back to generic steps ("apply the remediation appropriate to …"); effort was a bare
"~N h"; the place to make the change was only on some steps; the Issues board showed no fix information; page-audit
findings and Image Audit problems had a sentence but no location, time or verification; and every text and draft said
"DeoDap" (with DeoDap's No MOQ / wholesale / COD selling points) on every website, with Shopify paths regardless of
platform. **Fix** (`packages/shared/src/fixGuide.ts`, `fixcards/playbook.ts`, `fixcards/generate.ts`, `pageAudit.ts`,
`imageAudit.ts`): 11 specific playbooks (every check now has its own); each Fix Card has **Where to fix** (Shopify admin
path, theme file, app, Search Console, SEO Sentinel section) and an **estimated time range** (per page / link / image
for page-by-page work — e.g. one meta description 10–15 min, 120 pages with a bulk-edit hint — otherwise the playbook
effort as a range, template fixes counted once); verification is always shown. Wording uses the selected website's name;
drafts for other websites claim no DeoDap selling points; for a non-Shopify platform every location is translated
(WooCommerce / WordPress / Magento / BigCommerce / custom) with a note. Issue lists carry time, where and the first step
(new *Fix time & where* column). Page-audit findings and Image Audit problems show time, where and how to verify.

**Websites — root cause.** Websites are kept only with `DATABASE_URL` (PostgreSQL, since 17 Oct): without it the list
lives in the API's memory, so a Render restart, redeploy or free-plan idle spin-down leaves only the primary website
(DeoDap). The code path with a database keeps every website (tested again below). **Added:** `SEED_WEBSITES` — in
production DeoDap, Grabnix, Oblivion and Natation are created at start-up when missing (never duplicated, edited or
removed); each website's name and platform are kept in its settings so recommendations follow the selected website.

**Tests:** `packages/shared/test/fixGuide.test.ts` (every check has a specific playbook with where / time / verification;
time ranges; brand and platform wording; page-audit and image fixes), `apps/api/test/api/seed-websites.test.ts`,
`apps/api/test/persistence/savedWebsites.test.ts` (real API process in production mode with PostgreSQL: the four
websites present, a fifth added, an edit kept, sign-out / sign-in and two restarts → same five websites, same ids, 5 rows),
web: Fix Card summary, platform note, Issues table column, page-report fix hints.

### 21 Oct 2026 — Image Audit completion (checkpoints, resume) and crawl batches of up to 11 websites

**Image Audit — why it stopped.** One checker process ran with one time budget (`IMAGE_AUDIT_BUDGET_MINUTES`, 30); when
it ran out, every image not reached was marked *deferred* and the job ended *partial*. Nothing continued it, a new audit
started over, progress counted deferred images as processed (the bar could show 100 % with images unchecked), and the
results lived only in memory.

**Fix** (`apps/api/src/images/audit.ts`, no Go change): the audit runs in **rounds** — the images a round did not reach
stay *pending* and the next round checks only them — until every image is answered (`IMAGE_AUDIT_MAX_HOURS`, 12, then
*Partly done* + Resume). Rate-limited images are tried again after a pause honouring Retry-After (up to 3 rounds).
**Checkpoints** every 10 s and after each round: in PostgreSQL (`sentinel_files`, a gzip snapshot of all images + small
files with only the answers since) or, without a database, in memory (stated in the UI). After a restart the running
audit continues automatically; on SIGTERM the last answers are stored first. **Resume** (`POST /api/image-audits/:id/resume`)
checks only pending / deferred images. New audits reuse available / broken answers of recent audits of the website
(24 h) and the crawl's own 4xx link answers. Image references are stored with the crawl's results, so a recent crawl
can be audited after a restart. Progress = images with a final answer; 100 % only when nothing is pending or deferred.
At most `IMAGE_AUDIT_MAX_CONCURRENT` (2) audits run at once. Crawls still make no image request (ALT from the HTML).

**Batches — the two-website limit.** `CRAWLER_MAX_CONCURRENT_JOBS` (default 2) made a third crawl on the server fail
with `429 CRAWL_CAPACITY` ("2 crawls already running"), so only two websites could be crawled together and nothing
queued. **Fix:** `jobs/crawlSlots.ts` — every crawl is stored as a job and queued; a server-wide FIFO starts it when a slot
is free (`CRAWLER_MAX_CONCURRENT_JOBS`, now default 3, max 11) **and** API + crawler memory + `CRAWLER_JOB_RESERVE_MB`
fits the memory budget and the Node heap has room; post-crawl analyses of different websites run one at a time
(`gocrawl/engine.ts`). `batches.ts` + `/api/crawl-batches`: one start for up to 11 websites, a job per website in its
own workspace (`batchId` on each crawl), Running / Queued (position, reason) / Completed / Failed / Cancelled / Not
started, cancel one website or all remaining. Web: *Crawl several websites* (`/websites/batch`). Queued jobs survive a
restart (queued again, not counted as a restart attempt).

**Tests:** `test/gocrawl/image-audit-resume.test.ts` (rounds until done with each image requested once; cancel + resume
requests only unanswered images; 429 retried after Retry-After; reuse across crawls; PostgreSQL: real API process
stopped with SIGTERM and SIGKILL mid-audit continues after restart without re-requesting answered images, and a new audit
after the restart reuses everything); `test/persistence/batchCrawl.test.ts` (11 local websites on 127.0.0.2–12: one job
each, ≤ 3 running, queue positions, cancel one queued + one running → 9 completed / 2 cancelled, pages and findings of
each site only on its own origin; 12 refused, duplicates / unknown refused, already-running site followed; PostgreSQL:
SIGTERM with 1 running + 4 queued → all 5 complete after the restart). Web: batch screen, Image Audit progress / resume.
Measurements: `docs/measurements/batch-11-sites.json`, `docs/BATCH_CRAWLS.md`.

### 17 Oct 2026 (third pass) — Background crawls: independent of the browser, restarted after a server restart

**Root cause.** A crawl was already started as a server-side job (a detached promise driving the Go crawler process;
nothing in the web app or the HTTP request stopped it). What stopped crawls nobody was watching was the server itself:
1. Render stops idle services by *incoming* traffic — free instances spin down 15 minutes after the last request. While
   the Crawl Center was open, its progress polling kept the server up; after the browser or laptop was closed nothing did,
   so the process (and the crawl with it) was stopped mid-run.
2. A crawl cut off by any restart (spin-down, redeploy, crash) was then marked *failed* at the next start, and its
   settings were never used again: nothing resumed it.
3. Two Start requests arriving together (double click, two tabs) could both pass the "already running?" check, which
   ran before several awaits; a second crawl of the same website could start.

**Fix** (`apps/api/src/services/crawls.ts`, `jobs/keepAwake.ts`, `server.ts`, `container.ts`, `config/env.ts`):
crawls run through one `launch()` that owns the job (no request, tab or session involved); one start at a time per
website (a lock taken before any await) and `409 CRAWL_ALREADY_RUNNING` with the running crawl's id; on `SIGTERM` a
running crawl is left *running* in the database instead of being finalised as failed / cancelled; at start-up
`resumeInterrupted()` starts each interrupted crawl again under the same id with its stored type and settings (waiting
for a free slot), at most `CRAWLER_RESUME_MAX_ATTEMPTS` times, otherwise marks it failed with the reason — never
completed; while a crawl runs or waits, the server requests its own public `/healthz` every 5 minutes
(`RENDER_EXTERNAL_URL` / `KEEP_AWAKE_URL`, `CRAWL_KEEP_AWAKE`). Web: a 409 reloads the crawl list so the running crawl and
its progress appear; a restarted crawl says so; the progress panel says closing the page does not stop the crawl.

**Tests** (`apps/api/test/persistence/backgroundCrawl.test.ts`; local fixture site, Go crawler): the browser's start
request is destroyed before the answer → the crawl still runs, progress grows, a second sign-in sees the same job, it
completes; 5 simultaneous Start requests from two sessions → one crawl, four `409 CRAWL_ALREADY_RUNNING`; cancel from
another session → cancelled, no request reaches the site after it, no job left; keep-awake requests only while a
crawl is busy. With PostgreSQL, real API process (`tsx src/server.ts`): SIGTERM and SIGKILL mid-crawl → stored as
*running* while down → after the restart the same crawl id is running again with `resume.attempts = 1`, the same
options, no second crawl, a new Start is refused, and it completes with issues; restarted too often or restarting off →
failed with the reason; a restarted crawl can be cancelled. Built bundle check: SIGTERM at 54 pages → same crawl
resumed and finished.

**Limits.** Restarted crawls begin again from the first page (no page-level checkpoint in the Go crawler: its results,
link graph and duplicate analysis need the whole crawl in one process). Without `DATABASE_URL` a restart loses a running
crawl. Image Audits are not restarted. The keep-awake ping cannot help when the host stops the service for other reasons
(redeploys, the free plan's monthly hours, out-of-memory restarts) — those are covered by the restart.

### 17 Oct 2026 (second pass) — PostgreSQL persistence: websites, crawls, results, Health Score

**Root cause of "websites disappear" and "no audit data yet".**
1. All data lived in the API process's memory (`createInMemoryRepositories`), and the website list was an in-memory
   array in `websites.ts`. Every Render restart — redeploys, the free plan's spin-down after inactivity, crashes —
   started with only the primary website and no crawls, issues or scores. A browser refresh after such a restart
   showed the loss; the web app then switched the selection back to the primary website because the remembered one
   no longer existed.
2. After a crawl finished, the web app did not fetch the website list again (it is fetched on page load; the crawl's
   start invalidated it, its completion did not). The audit gate reads `hasAuditData` from that list, so Health Score and
   the other scored screens kept saying "no audit data yet" until a reload — or, after a restart, for good.
3. The selected website was remembered in `sessionStorage` (per tab), not across tabs / new windows.

**Fix.** PostgreSQL storage behind the existing repository interfaces (`apps/api/src/repositories/postgres/`,
`docs/DATABASE.md`); websites are rows of `sentinel_websites` and all their data is keyed by the website id; page rows
of recent crawls, coverage reports and the Change Monitor history are stored too and restored after a restart;
changes are answered only once stored, a crawl stores everything before it ends, SIGTERM flushes; database failures
answer 503 and show on System health (no silent fallback); crawls interrupted by a restart are marked failed (since
replaced: they are started again — see "Background crawls" below); the
latest page report never uses a cancelled crawl. Web: website list refetched when a crawl finishes and every minute,
site screens refreshed on crawl completion, selection kept in `localStorage`; storage notices follow the server.

**Tests** (`apps/api/test/persistence/persistence.test.ts`, real PostgreSQL 16 via `TEST_DATABASE_URL`, local
fixture stores only): websites, crawls (counts, outcome, timestamps), page rows / page report / coverage / CSV export,
issues with evidence, per-website Health Score and Change Monitor history identical after an API restart with an empty
disk; two websites never share findings or rows; a cancelled crawl leaves issues, Health Score and the latest audit
unchanged, before and after a restart; a crawl interrupted by a restart is marked failed and does not block the next;
unreadable / unwritable database → 503 + System health "down", stored once it is back; unreachable database at
start-up → clear error, no start; production without `DATABASE_URL` refuses to start unless explicitly allowed; a real
process restart with SIGTERM keeps added websites and the sign-in. Web: selection survives a reload; crawl completion
refreshes the website's screens and the website list. Browser check against the built server with PostgreSQL: two
websites crawled, server restarted, page reloaded → "grab" still selected with its own Health Score (43.4 vs 49.2).

**Measured** (25,000-product synthetic store, 53,491 URLs, 256 MB heap, local PostgreSQL;
`docs/measurements/go-crawl-25k-postgres.json`): crawl 110 s (105–111 s without a database); peak API memory 327 MB
RSS / 170 MB heap (304–308 / 158–161 MB without); stored 53,491 page rows (66 MB) + 27,810 records (23 MB); a new API
process loads the website in 0.5 s and rebuilds the crawl's 53,491 page rows from the database in 3.1 s.

### 17 Oct 2026 — Smart Crawl budget 1,000 pages; Image Audit separated from crawling

**Smart Crawl page budget: 1,000** (`SMART_CRAWL_PAGE_BUDGET`; `CRAWLER_SMART_MAX_PAGES` default and maximum 1,000,
previously 500 and could be exceeded by a long evidence list). Priority order unchanged. When eligible URLs remain, the
run ends *partial* with "The Smart Crawl budget of 1000 pages was reached; N eligible URLs were not fetched"; the run
diagnostics and the live panel show the budget, pages processed and the pending eligible URLs. Pending URLs have no
status, no title and no audit score and are never listed by a page-content finding. A Full Crawl has no page budget.
Test (`test/gocrawl/smart-budget.test.ts`, local synthetic store, ~2,400 eligible pages): Smart → exactly 1,000
processed, outcome partial, 1,000+ pending reported; Full → completed, more than 1,500 pages, 0 page-limited.

**Normal crawls request no image.** `CRAWL_NEEDS` (Go and built-in crawler) drops the image checks; ALT text, width /
height and lazy-loading come from the HTML (ONP-IMAGES, PERF-IMAGES markup checks and the page audit unchanged). Image
weight / format are no longer claimed by a crawl. Every crawl writes the image references of its HTML pages
(`images.ndjson.gz`, with its results) for a later audit. Measured on the rate-limited synthetic store (150 products,
3 req/s, burst 6, Retry-After 30; `docs/measurements/rate-limited-150-products-no-image-checks.json`):

| | Before (image checks in the crawl) | Now |
| --- | --- | --- |
| Pages | 206 | 206 |
| Whole run | 398 s | 114 s |
| Post-crawl checks | 292 s | 8.7 s |
| Requests to the store | 840 | 243 |
| 429 answers | 5 | 3 |

**Image Audit** (`docs/IMAGE_AUDIT.md`): started by a user for one finished crawl; deduplicated images, reuse of the
crawl's 4xx link answers and of an earlier audit, the Go binary's new `images` mode (separate process) with a 64 KB
`Range` read per image, format / pixel-size sniffing, robots.txt, Retry-After, per-host pacing and the SSRF guard;
states ok / broken / failed / unverified / deferred / pending; progress, cancellation, filters, CSV / JSON export.
Tests: Go `imageaudit_test.go` (each image once, Range read only, sizes from Content-Range / Content-Length, redirects,
404 / 500 / HTML-as-image, robots, 429 + Retry-After, third-party host, cancel and time budget, format sniffing);
API `test/gocrawl/image-audit.test.ts` (no image request and no audit during a crawl; ALT found from HTML; each
image requested once; broken / heavy / legacy / duplicate / empty-ALT reported; filters; HTTP CSV / JSON export;
re-run reuses all answers with no new request; cancellation on 3,000 images defers the rest, progress reported);
web `test/imageAudit.test.tsx`. Checked in Chromium against a running server: Smart Crawl budget in the run diagnostics,
Image Audit start → 596 images checked, drawer, re-run reused 596 answers, no horizontal overflow at 390 px.

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
