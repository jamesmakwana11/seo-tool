/**
 * Current status per requirement, with evidence. Updated at each phase gate.
 * Resolution order: exact id in STATUS → CHECK_STATUS for check rows → DEFAULT_BY_PHASE.
 *
 * Status rules used here:
 *  - TESTED   implemented and covered by an automated test that would fail if it broke (evidence key named).
 *  - IMPLEMENTED  built and wired, exercised manually / by smoke rendering, but no dedicated assertion.
 *  - PARTIAL  part of the requirement exists; the rest is named in "Blocker / remaining".
 *  - BLOCKED  cannot progress without something external (credentials, an API spec, production data).
 *  Anything that talks to a third-party API is at most PARTIAL until verified against the real provider —
 *  stub-tested code is not evidence that the live integration works.
 */
export const PHASE_NOTE = `**Current phase:** Phase 1 (frontend) complete; **Phase 2 (backend with temporary in-memory storage) complete and gate-evaluated** — see \`FRONTEND_STATUS.md\` and \`BACKEND_STATUS.md\`. **No database work has been started** (Phase 3 awaits explicit authorization).

Evidence keys: **SHARED** = \`packages/shared/test/rules.test.ts\` (62 tests) · **MOCK** = \`apps/web/test/mockApi.test.ts\` (21) · **COMP** = \`apps/web/test/components.test.tsx\` (6) · **API** = \`apps/api/test/api/*\` (57 HTTP/service tests over the in-memory repositories) · **CRAWL** = \`apps/api/test/crawler/*\` (63 tests; real crawls of loopback fixture stores, every one of the 54 crawler analyzers has an asserting test) · **CONN** = \`apps/api/test/connectors/*\` (128 tests; connector tests, registry states, delivery, Google auth, LLM, Task Ops, webhook HMAC, redaction — network stubbed) · **SYNC** = \`apps/api/test/sync/sync.test.ts\` (13; GA4/GSC/CrUX data syncs, network stubbed) · **SMOKE** = \`apps/web/e2e/smoke.mjs\` in mock mode (540 visits, 0 failures) · **HTTP-SMOKE** = the same smoke against the real API (\`VITE_API_MODE=http\`, 540 visits, 0 failures, 4 interaction checks) · **A11Y** = \`apps/web/e2e/a11y.mjs\` (axe WCAG 2.1 AA, 19 screens, 0 violations).

Nothing has been run against deodap.in or any live third-party API: no credentials were provided. Every connector-dependent requirement is therefore at most **PARTIAL**, with the remaining step named.`;

const s = (status, evidence = '', blocker = '') => ({ status, evidence, blocker });
const CREDS = 'Not verified against the live provider — needs credentials';
const BACKLINK = 'Backlink/keyword data sync not implemented (connection test only); needs an Ahrefs or Semrush subscription';
const TASKOPS = 'No Task Ops API specification or credentials were provided; the adapter payload is an assumption — tasks live in Sentinel\'s internal task store';
const RENDER = 'No headless JS renderer in the crawler (raw HTML only)';

export const STATUS = {
  // ---- PDF §1 purpose
  'PDF-1.1': s('PARTIAL', '54 crawler checks across technical/on-page/content/AEO/GEO — CRAWL; daily scheduler — API "scheduler wiring"', `Off-page deltas: ${BACKLINK}`),
  'PDF-1.2': s('TESTED', 'classifySeverity — SHARED; tier-weighted severity + business impact on ingested live issues — API ingest'),
  'PDF-1.3': s('TESTED', 'generateFixCard + DeoDap playbook — SHARED; served with every issue — API workflows2 "complete Fix Card"'),
  'PDF-1.4': s('TESTED', 'In-process scheduler (crawls, 00:30 escalations, 01:00 syncs, 08:00 digest, weekly/monthly) — API "scheduler wiring", cron unit tests', 'Enable with SCHEDULER_ENABLED=true in deployment'),
  'PDF-1.1.1': s('TESTED', 'Real HTTP crawler + analyzers — CRAWL; full crawl → live issues — API crawl-e2e', 'Not yet run against deodap.in (needs CRAWLER_BASE_URL + CRAWLER_ALLOW_LIVE=true)'),
  'PDF-1.1.2': s('TESTED', 'Content/on-page analyzers — CRAWL coverage; changed pages (Shopify webhook) prioritised in the smart crawl — API crawl-e2e "webhook → smart crawl"'),
  'PDF-1.1.3': s('PARTIAL', 'Off-page screens over DEMO data — SMOKE/HTTP-SMOKE; backlink connector test — CONN', BACKLINK),
  'PDF-1.1.4': s('PARTIAL', 'AEO crawler checks (answer block, FAQ, extractability, entity, AI crawlers) — CRAWL', 'AI-engine visibility sampling (ChatGPT/Gemini/Perplexity) not implemented — connection tests only'),
  'PDF-1.1.5': s('PARTIAL', 'GEO-EEAT, GEO-FRESHNESS, GEO-STRUCTURE — CRAWL', 'GEO-CITATION/CLUSTER need SERP data and a topic map; GEO-SEMANTIC/BRAND-FACTS need backlink/GBP/LLM data'),
  'PDF-1.1.6': s('PARTIAL', '9 of 12 built-in AI-compliance checks evaluated (AIC-01/02/05/06/07/08/09/11/12) — CRAWL; custom rules run in the crawl pipeline — API workflows2', 'AIC-03 needs Shopify product data + LLM; AIC-04 needs an LLM; AIC-10 needs third-party content sources'),
  'PDF-1.1.7': s('TESTED', 'Fix Card owner, effort, impact, priority — SHARED; server detail — API'),
  'PDF-1.1.8': s('TESTED', 'Allocation creates a task — API workflow; 24h auto-allocation — API jobs; real-time alerts with audited delivery outcome — SYNC CrUX test', 'External delivery needs SMTP/WhatsApp/Slack credentials'),
  // ---- PDF §2 architecture
  'PDF-2.A': s('PARTIAL', 'HTML crawler, robots, sitemap diffing, redirects, TLS, host variants — CRAWL', `${RENDER}; log-file ingestion (optional) not built`),
  'PDF-2.B': s('PARTIAL', 'All 14 integrations: connection tests + honest states — CONN; GA4/GSC/CrUX data syncs — SYNC', `Shopify product data, GBP and backlink data syncs not implemented; ${CREDS}`),
  'PDF-2.C': s('TESTED', 'Analyzers run per crawl; delta vs previous run (new/worsening/improving/recurring/resolved) — CRAWL, API ingest'),
  'PDF-2.D': s('TESTED', 'classifySeverity — SHARED (13 tests); applied to every ingested finding — API ingest'),
  'PDF-2.E': s('TESTED', 'generateFixCard + PLAYBOOKS — SHARED; server issue detail — API workflows2'),
  'PDF-2.F': s('PARTIAL', 'Digest, dashboard, alerting, lifecycle — API, HTTP-SMOKE', `Task Ops auto-task: ${TASKOPS}`),
  'PDF-2.1.1': s('PARTIAL', 'Weekly full crawl (discovery from homepage + sitemap) — API crawl-e2e, CRAWL', RENDER),
  'PDF-2.1.2': s('TESTED', 'Smart plan: homepage + collections + top products by tier/value + changed in 48h (Shopify webhook) + re-verify set — API crawl-e2e', 'Top-product ranking uses GA4 values once that sync runs live'),
  'PDF-2.1.3': s('TESTED', 'Delta detection, de-duplication per finding key, auto-resolution only when re-checked — API ingest (9 tests)'),
  'PDF-2.1.4': s('NOT STARTED', 'Optional per PDF §2', 'Optional; needs server log access'),
  // ---- PDF §3 severity, tiers, escalation
  'PDF-3.1.1': s('TESTED', 'computeTiers (homepage + top 20 collections + top 200 products by revenue, sessions as fallback) — SYNC; recomputed nightly after the GA4 sync', CREDS),
  'PDF-3.1.2': s('TESTED', 'Tier 2: other indexable collections, products with organic impressions, blog posts with clicks — SYNC', CREDS),
  'PDF-3.1.3': s('TESTED', 'Tier 3 long tail — SYNC'),
  'PDF-3.2.1': s('TESTED', 'Severity = check × tier — SHARED; Tier-1 noindex Critical on live ingest — API ingest'),
  'PDF-3.2.2': s('TESTED', 'Critical SLA = end of IST day — SHARED; SLA set on ingest — API ingest'),
  'PDF-3.2.3': s('TESTED', 'Medium SLA 7 days — SHARED'),
  'PDF-3.2.4': s('TESTED', 'Low SLA 30 days — SHARED'),
  'PDF-3.3.1': s('TESTED', 'Tier-1 promotion rule — SHARED; nightly tier recomputation + escalation job — API jobs'),
  'PDF-3.3.2': s('TESTED', 'SLA-breach escalation + re-alert — SHARED, API jobs'),
  'PDF-3.3.3': s('TESTED', '≥3 related Medium on one template → Critical template-level issue that supersedes them — SHARED, API ingest'),
  'PDF-4.0': s('TESTED', 'Every finding carries URLs, severity inputs and evidence (HTTP response, HTML, JSON-LD, field data, passages) — CRAWL'),
  // ---- PDF §10 AI compliance
  'PDF-10.1.F': s('PARTIAL', 'Offending passages captured as evidence — CRAWL (AIC-02/07/12); heuristic content drafts — SHARED', 'LLM-written rewrite drafts not implemented (the LLM adapter only judges rules)'),
  'PDF-10.1.G': s('PARTIAL', 'YMYL claims detected (AIC-07) — CRAWL; QA-gate hold + human sign-off with note — API workflows2', 'Built-in AIC-07 findings are not yet converted into held QA-gate flags; a publish gate needs Shopify publish events'),
  'PDF-10.2.1': s('TESTED', 'regex / phrase list / threshold / LLM-judged — SHARED validateRule; LLM via adapter — CONN; ReDoS guard — API config-rules'),
  'PDF-10.2.2': s('TESTED', 'Scope (templates, collections, tiers, newly published, full site) — SHARED ruleAppliesTo; API workflows2'),
  'PDF-10.2.3': s('TESTED', 'Severity + default team stored on the rule and on flags — API workflows2'),
  'PDF-10.2.4': s('TESTED', 'flag / flag + rewrite / block in QA gate (new pages only) — SHARED validation; held flag — API workflows2'),
  'PDF-10.2.5': s('PARTIAL', 'Schedule (daily / on-publish / weekly) stored and validated — SHARED', 'All enabled rules currently run on every crawl; weekly and on-publish cadences are not differentiated'),
  'PDF-10.2.6': s('TESTED', 'Day-one example rules — SHARED "supports all PDF §10.2 example rules"'),
  'PDF-10.2.7': s('PARTIAL', 'Custom-rule hits become AI-compliance flags in the digest section — API workflows2', 'Custom-rule hits do not yet create Issues with Fix Cards and re-verification'),
  'PDF-10.2.8': s('TESTED', 'Dry run over last 30 days required before enabling; LLM rules need a provider — API config-rules, MOCK'),
  // ---- PDF §11 Fix Cards & allocation
  'PDF-11.0': s('TESTED', 'Complete Fix Card for every issue — SHARED; generated for live issues on the server — API'),
  'PDF-11.S1': s('TESTED', 'Context assembly — SHARED'),
  'PDF-11.S2': s('TESTED', 'Root-cause inference, null when evidence is insufficient — SHARED'),
  'PDF-11.S3': s('TESTED', 'DeoDap playbook coverage for every defect check — SHARED'),
  'PDF-11.S4': s('TESTED', 'Impact × Confidence × 1/Effort, tier tie-break — SHARED'),
  'PDF-11.1': s('TESTED', 'Fix Card format — SHARED, COMP'),
  'PDF-11.1a.1': s('PARTIAL', 'The one-tap "Fix with …" allocation buttons were removed from the app at the owner\'s request (24 Oct 2026); allocation remains in the API and in the automatic rule for unallocated Criticals — API workflows2; absence checked — COMP allocationRemoved', 'No allocation buttons in the app or in alert messages (owner decision)'),
  'PDF-11.1a.2': s('IMPLEMENTED', 'Recommended team inferred per issue (shown as "Recommended team" in the issue summary) — SHARED; the one-tap confirm went with the allocation buttons (owner decision, 24 Oct 2026)'),
  'PDF-11.1a.3': s('TESTED', 'Who → team → when on the issue, task activity and audit log — API workflows2'),
  'PDF-11.1a.4': s('PARTIAL', 'Tap creates the internal task (Fix Card description, team, priority from severity, SLA due date); reallocation notifies both teams — API workflow/workflows2', TASKOPS),
  'PDF-11.1a.5': s('TESTED', 'Digest allocation status (yesterday, unallocated >24h, open load) — API workflows2 digest sections'),
  'PDF-11.1a.6': s('TESTED', 'Bulk (re)allocation of a template group through the API moves every child onto the parent task — API workflows2 (no button in the app since 24 Oct 2026)'),
  'PDF-11.2.1': s('TESTED', 'Stack-specific instructions (Shopify admin paths, theme files, apps) — SHARED playbook test'),
  'PDF-11.2.2': s('PARTIAL', '3 scored title/meta variants — SHARED', 'Variants are template-based with a heuristic CTR score; LLM drafts not implemented'),
  'PDF-11.2.3': s('PARTIAL', 'Recurring issues produce a process (SOP) recommendation — SHARED', 'Filing the SOP suggestion to ops (Task Ops) is blocked: ' + TASKOPS),
  'PDF-11.2.4': s('TESTED', 'Template-level card supersedes page-level cards; parent resolves as a unit — API ingest'),
  // ---- PDF §12 reporting
  'PDF-12.1.0': s('PARTIAL', '08:00 IST digest job through configured channels with recorded outcomes — API "scheduler wiring", CONN delivery', 'Live delivery needs SMTP / WhatsApp / Slack credentials'),
  ...Object.fromEntries(['PDF-12.1.1', 'PDF-12.1.2', 'PDF-12.1.3', 'PDF-12.1.4', 'PDF-12.1.5', 'PDF-12.1.6', 'PDF-12.1.7', 'PDF-12.1.8'].map((k) => [k, s('TESTED', 'Digest section built from server state — API workflows2 "every PDF §12.1 section"; rendered — HTTP-SMOKE')])),
  'PDF-12.1.9': s('PARTIAL', 'In-app digest lines carry the three allocation buttons — HTTP-SMOKE', 'Emailed digest is a Markdown summary with a link to the app, not per-line one-tap buttons'),
  'PDF-12.2': s('PARTIAL', 'Real-time alerts for sitewide 5xx, robots.txt change, Tier-1 noindex, SSL failure, CWV Poor — routing, audit, honest delivery outcomes — API/SYNC/CONN', 'Indexed-page collapse needs index-coverage counts (not exposed by the GSC API); toxic-link spike needs backlink data'),
  'PDF-12.3.1': s('TESTED', 'Overview dashboard from server state — HTTP-SMOKE'),
  'PDF-12.3.2': s('TESTED', 'Issues board filters (severity/module/team/allocator/status) — API list filters, HTTP-SMOKE'),
  'PDF-12.3.3': s('TESTED', 'Opportunity → task in one click (once only) — API workflows2'),
  'PDF-12.3.4': s('PARTIAL', 'Competitor view over DEMO data — HTTP-SMOKE', BACKLINK),
  'PDF-12.4.1': s('BLOCKED', 'Adapter + payload builder — CONN (stubbed)', TASKOPS),
  'PDF-12.4.2': s('TESTED', 'Unallocated Critical >24h auto-allocated to the recommended team with a task — API jobs'),
  'PDF-12.4.3': s('TESTED', 'Allocation trail written into task activity — API workflows2'),
  'PDF-12.4.4': s('TESTED', 'Verification result written to the task activity (and to Task Ops when linked) — API ingest verification loop'),
  'PDF-12.5.1': s('PARTIAL', 'Weekly rollup builder + Monday job — API scheduler, HTTP-SMOKE', `AI-visibility panel and off-page deep-dive need AI-engine and backlink data (${CREDS})`),
  'PDF-12.5.2': s('PARTIAL', 'Monthly 1-pager builder + monthly job — HTTP-SMOKE', 'Organic traffic/revenue vs last month & YoY needs a monthly GA4 series (not synced yet)'),
  // ---- PDF §13 opportunity engine
  'PDF-13.1': s('PARTIAL', 'Keyword-gap workflow (approve/reject) over DEMO data — API workflows2', BACKLINK),
  'PDF-13.2': s('PARTIAL', 'Brief generated only from an approved gap — API workflows2', 'SERP-based outline needs SERP/backlink data; current outline is a template'),
  'PDF-13.3': s('IMPLEMENTED', 'Seasonal planner (festival calendar, 60-day lead, collections to refresh) — rendered HTTP-SMOKE'),
  'PDF-13.4': s('PARTIAL', 'Cluster tracker over DEMO data — HTTP-SMOKE', 'Needs a pillar → cluster topic map and per-cluster GSC traffic'),
  // ---- PDF §14 health score
  'PDF-14.1': s('TESTED', 'Weights exactly per PDF — SHARED'),
  'PDF-14.2': s('TESTED', 'Severity-weighted, size-normalised, Tier 1 × 5 — SHARED'),
  'PDF-14.3': s('TESTED', 'Verifying an issue raises the score — SHARED'),
  // ---- PDF §15 data sources
  'PDF-15.1': s('TESTED', 'Self-hosted crawler; refuses non-loopback sites unless CRAWLER_ALLOW_LIVE=true; configurable user agent — CRAWL readiness', 'Bot protection on deodap.in must allow the crawler user agent'),
  'PDF-15.2': s('PARTIAL', 'Connection test — CONN; visibility, page impressions/clicks and striking-distance sync — SYNC', `Index coverage is not available from the API; rich-result, cannibalization and decay analysis not implemented; ${CREDS}`),
  'PDF-15.3': s('PARTIAL', 'Connection test — CONN; revenue/organic sessions → tiers sync — SYNC', CREDS),
  'PDF-15.4': s('PARTIAL', 'Connection test — CONN; CrUX field data → CWV + PERF-CRUX issues — SYNC', `PSI lab runs not synced; ${CREDS}`),
  'PDF-15.5': s('PARTIAL', 'Connection test (Ahrefs/Semrush) — CONN', BACKLINK),
  'PDF-15.6': s('PARTIAL', 'Connection test — CONN; webhook HMAC verification → changed pages in the smart crawl — API crawl-e2e', 'Product data (factual-accuracy check), theme/app diffing and redirect automation not implemented'),
  'PDF-15.7': s('PARTIAL', 'Connection test (OAuth refresh token) — CONN', 'GBP data sync not implemented'),
  'PDF-15.8': s('PARTIAL', 'Connection tests — CONN; LLM judge used by custom rules — CONN', 'Weekly AI-visibility sampling not implemented'),
  // ---- PDF §16 rollout & acceptance
  'PDF-16.P1': s('PARTIAL', 'Crawler, GSC/GA4/CrUX connectors + syncs, Technical 4.1–4.3 & 4.6, classifier, digest — CRAWL, SYNC, API', CREDS),
  'PDF-16.P2': s('TESTED', 'Modules 2–3 analyzers, Fix Card engine, dashboard + issues board, allocation buttons — CRAWL, SHARED, API, HTTP-SMOKE'),
  'PDF-16.P3': s('PARTIAL', 'AEO/GEO crawler checks, Module 7 + QA gate — CRAWL, API', 'Backlink deltas/toxic links and the AI-visibility panel need data syncs not yet built'),
  'PDF-16.P4': s('PARTIAL', 'Root-cause inference, template grouping, custom rule builder, seasonal planner — SHARED, API', 'CTR rewrite generator is heuristic (no LLM drafts)'),
  'PDF-16.AC1': s('PARTIAL', '08:00 IST digest job — API scheduler', 'Arrival can only be verified with real email/WhatsApp/Slack credentials'),
  'PDF-16.AC2': s('BLOCKED', 'Exclusions + Not-an-issue feedback loop — API', 'False-positive rate needs production feedback data'),
  'PDF-16.AC3': s('TESTED', 'Every issue has a complete Fix Card — SHARED, API workflows2'),
  'PDF-16.AC4': s('TESTED', 'Next crawl with 0 failing URLs → VERIFIED → CLOSED automatically; still failing → back to work — API ingest; on-demand re-check — CRAWL reverifier'),
  'PDF-16.AC5': s('TESTED', 'Template-level bug injected into a staging-like fixture store detected in one smart crawl — CRAWL acceptance'),
  // ---- PDF §17 governance
  'PDF-17.1': s('TESTED', 'Proposals recorded for human approval only; disavow never submitted; automation off by default — API workflows2, permissions'),
  'PDF-17.2': s('PARTIAL', 'Opt-in switches exist, off by default, Admin-only — API permissions', 'The automated actions themselves (auto-301, schema updates) are not implemented — they need Shopify write scope'),
  'PDF-17.3': s('TESTED', 'Thresholds, SLA, weights, alerts editable with validation + audit — API config-rules'),
  'PDF-17.4': s('TESTED', 'Not an issue with reason → exclusions honoured by later crawls — API workflow, ingest'),
  'PDF-17.5': s('TESTED', 'Audit entries for allocations, tasks, verifications, config and every real-time alert — API, SYNC; monthly report built from the log — HTTP-SMOKE'),
  // ---- Appendix A
  'PDF-A.1': s('TESTED', 'Critical class taxonomy in the check library — SHARED'),
  'PDF-A.2': s('TESTED', 'Medium class taxonomy — SHARED'),
  'PDF-A.3': s('TESTED', 'Low class, batched 30-day SLA — SHARED'),
  'PDF-A.4': s('IMPLEMENTED', 'Opportunity class separate from defects; opportunity board — HTTP-SMOKE'),
  'PDF-A.5': s('TESTED', 'Workshop placeholders configurable — API config-rules', 'Final values to be set in the kickoff workshop'),
  // ---- UX (P1, carried)
  'CUS-UX-01': s('IMPLEMENTED', 'Design tokens in tailwind.config.js; FRONTEND_CONVENTIONS.md; visual review screenshots'),
  'CUS-UX-02': s('TESTED', 'SMOKE + HTTP-SMOKE: 0 horizontal overflow at 390/768/1440 on all 60 routes'),
  'CUS-UX-03': s('IMPLEMENTED', 'AppShell header: breadcrumbs, global search, notifications, account menu'),
  'CUS-UX-04': s('IMPLEMENTED', 'components/ui/* and components/domain/* reused across all screens'),
  'CUS-UX-05': s('TESTED', 'A11Y: 0 axe WCAG 2.1 AA violations on 19 screens; keyboard focus interaction — SMOKE'),
  'CUS-UX-06': s('IMPLEMENTED', 'Async (skeleton/error+retry/empty), ConfirmDialog, toasts; sync failures shown as errors, never as success'),
  'CUS-UX-07': s('IMPLEMENTED', 'DataTable sort/search/pagination; URL-synced filters'),
  'CUS-UX-08': s('TESTED', 'Every control calls a SentinelApi method; HTTP-SMOKE drives the UI against the real API with 0 errors'),
  'CUS-UX-09': s('TESTED', 'DEMO/SIMULATED/role-preview indicator on every route in both modes — SMOKE, HTTP-SMOKE; server reports DEMO provenance (serverDemoData)'),
  'CUS-UX-10': s('TESTED', 'One SentinelApi contract, two adapters (mock + HTTP) — MOCK, HTTP-SMOKE'),
  'CUS-UX-11': s('TESTED', 'VITE_API_MODE=mock|http; Diagnostics shows mode and live request log — HTTP-SMOKE'),
  // ---- Roles
  'CUS-ROLE-01': s('TESTED', 'Admin experience against the real API — HTTP-SMOKE (60 routes × 3 widths)'),
  'CUS-ROLE-02': s('TESTED', 'SEO Specialist experience + one-tap allocation creating a server task — HTTP-SMOKE interaction'),
  'CUS-ROLE-03': s('TESTED', 'Developer experience; team-scoped tasks enforced server-side — HTTP-SMOKE, API permissions'),
  'CUS-ROLE-04': s('TESTED', 'Labelled DEV role preview; refused in production — API auth, SMOKE'),
  'CUS-ROLE-05': s('TESTED', 'Role-aware nav + route guards — SMOKE (denied list, nav hidden interaction)'),
  'CUS-ROLE-06': s('IMPLEMENTED', 'TeamBadge vs RoleBadge; Employees page separates roles and teams'),
  'CUS-ROLE-07': s('TESTED', 'Every endpoint checks the permission matrix server-side — API permissions (developer 403s, team-scoped tasks, Admin-only automation)'),
  // ---- Tasks
  'CUS-TASK-01': s('TESTED', 'Lifecycle rules — SHARED; enforced by the API — API workflow/ingest'),
  'CUS-TASK-02': s('TESTED', 'Rejection, failed verification, regression reopen, reassignment, reasoned cancellation — SHARED, API ingest/workflow'),
  'CUS-TASK-03': s('TESTED', 'Task → issue status mapping — SHARED; mirrored on the server — API ingest'),
  'CUS-TASK-04': s('TESTED', 'Task fields populated from the Fix Card on allocation — API workflows2'),
  'CUS-TASK-05': s('TESTED', 'Views (My/Team/All/Kanban/List/Workload/Overdue/SLA/Review/Verification) — SHARED filterTasks, HTTP-SMOKE'),
  'CUS-TASK-06': s('TESTED', 'Server validates action, role and required notes — API workflow ("block" without a note → 400)'),
  'CUS-TASK-07': s('TESTED', 'Developer can submit; cannot approve or verify — SHARED; API permissions "only the system may verify"'),
  'CUS-TASK-08': s('TESTED', 'pending_data when the data cannot be checked (DEMO issues, missing connectors, CrUX insufficient data) — API workflow, SYNC'),
  'CUS-TASK-09': s('TESTED', 'Failed verification → IN_PROGRESS; regression → reopened — API ingest'),
  // ---- Backend (Phase 2)
  'CUS-BE-01': s('TESTED', 'Login, logout/revocation, reset (no account enumeration), profile, account status, scrypt hashes — API auth'),
  'CUS-BE-02': s('TESTED', 'REST endpoint for every SentinelApi method; consistent {error:{code,message,details},requestId} — API, HTTP-SMOKE'),
  'CUS-BE-03': s('TESTED', 'Transitions, reassignment, attribution, history, SLA escalation, review/verification, regression — API'),
  'CUS-BE-04': s('TESTED', 'HTTP crawl, robots, sitemap, scheduling, HTML/response analysis — CRAWL, API', RENDER),
  'CUS-BE-05': s('TESTED', 'Unconfigured / credentials missing / failed / untested states; never "connected" without a passed test — CONN registry, API honesty'),
  'CUS-BE-06': s('IMPLEMENTED', 'Recommendation pipeline in packages/shared/src/fixcards, independent of crawler, connectors and task services'),
  'CUS-BE-07': s('TESTED', 'Delivery attempts with outcome, retryability, timestamps; never "delivered" without provider confirmation — CONN delivery, API honesty'),
  'CUS-BE-08': s('TESTED', 'pino JSON logs with redaction; secrets stripped from results and errors — CONN redact, SYNC secrecy'),
  'CUS-BE-09': s('TESTED', 'Repository interfaces + labelled in-memory implementation; System health reports non-persistent storage — API honesty'),
  'CUS-BE-10': s('TESTED', '261 API tests + 62 shared + 27 web, deterministic fixtures, network stubbed'),
  'CUS-BE-11': s('TESTED', 'apps/api/.env.example and apps/web/.env.example; source scan for key patterns found none; secrets refused as settings — API honesty'),
  'CUS-BE-12': s('TESTED', 'not configured, credentials missing, connection failed, connected, partial, rate limited, sync failed — CONN registry, SYNC'),
  // ---- Docs
  'CUS-DOC-01': s('TESTED', 'Generated by tools/traceability/generate.mjs (validates ids, 83 screens, sections)'),
  'CUS-DOC-02': s('IMPLEMENTED', 'FRONTEND_STATUS.md'),
  'CUS-DOC-03': s('IMPLEMENTED', 'BACKEND_STATUS.md'),
  'CUS-DOC-04': s('IMPLEMENTED', 'Frontend gate → backend gate; no database; status files resumable'),
  'CUS-DB-01': s('NOT STARTED', 'Intentionally not started', 'Awaiting explicit authorization (prompt §3, §11)'),
};

/** Check-library rows (PDF §4–§10), resolved per check from what the backend actually evaluates. */
const CRAWLER_ONLY_TESTED = new Set([
  'AEO-AI-CRAWLERS', 'AEO-ANSWER-BLOCK', 'AEO-ENTITY', 'AEO-EXTRACTABILITY', 'AEO-FAQ', 'AIC-02', 'AIC-05', 'AIC-08', 'AIC-09', 'AIC-11', 'AIC-12',
  'GEO-EEAT', 'GEO-FRESHNESS', 'GEO-STRUCTURE', 'ONP-BREADCRUMBS', 'ONP-H1', 'ONP-HEADINGS', 'ONP-IMAGES', 'ONP-META', 'ONP-OG', 'ONP-TITLE', 'ONP-TPL-HOME',
  'ONP-TPL-PRODUCT', 'PERF-IMAGES', 'TECH-5XX', 'TECH-BROKEN-INTERNAL', 'TECH-BROKEN-OUTBOUND', 'TECH-CANONICAL', 'TECH-CRAWL-DEPTH', 'TECH-DUPLICATE',
  'TECH-HOST', 'TECH-HTTPS', 'TECH-NOINDEX', 'TECH-PAGINATION', 'TECH-REDIRECTS', 'TECH-ROBOTS', 'TECH-SCHEMA-PRESENCE', 'TECH-SHOPIFY-DUP-PATHS', 'TECH-SITEMAP', 'TECH-THIN',
]);
/** Crawler analyzer tested; part of the PDF definition needs another source. */
const CRAWLER_PART = {
  'AIC-01': 'Publish-date window (7 days) needs Shopify product data',
  'AIC-06': 'Shopify review-app data not connected; crawler-visible signals only',
  'AIC-07': 'Verification against Shopify metafields not implemented; JSON-LD product data only',
  'CONT-AI-RISK': 'Heuristic only — no LLM classifier',
  'CONT-FRESHNESS': 'Pages without a visible/structured modified date need Shopify updated_at',
  'CONT-QUALITY': 'Depth vs. top-10 SERP average needs SERP data (excluded from the score)',
  'ONP-TPL-COLLECTION': `Server-rendered check only (${RENDER})`,
  'PERF-RENDER-BLOCKING': 'LCP impact needs PSI/CrUX per-template correlation; new blocking scripts detected from HTML',
  'PERF-THIRD-PARTY': 'Script weight from HTTP size, not PSI main-thread cost',
  'TECH-4XX': 'Backlink-weighted severity needs backlink data',
  'TECH-CRAWL-BUDGET': 'Indexed duplicate counts need GSC index data (estimate from crawl only)',
  'TECH-DISCONTINUED': 'Shopify draft/archived status needs Shopify product data',
  'TECH-ORPHAN': 'GSC-known URLs not merged into orphan detection',
  'TECH-SCHEMA-ERRORS': 'GSC rich-result errors not synced; crawler validation only',
};
const NOT_EVALUATED = {
  'AIC-03': 'Needs structured Shopify product data and an LLM to compare claims',
  'CONT-QA-GATE': 'Needs Shopify publish events to know which pages are new',
  'GEO-CITATION': 'Needs SERP/competitor data',
  'GEO-CLUSTER': 'Needs the pillar → cluster topic map',
  'ONP-KEYWORD-MAP': 'Needs a keyword map (one primary keyword per Tier 1–2 page)',
  'TECH-JS-RENDER': RENDER,
  'TECH-MOBILE': RENDER,
};

export function CHECK_STATUS(id) {
  if (CRAWLER_ONLY_TESTED.has(id)) return s('TESTED', 'Crawler analyzer with an asserting test (detection + URL) — CRAWL; findings flow into live issues — API crawl-e2e', 'Not yet run against deodap.in');
  if (CRAWLER_PART[id]) return s('PARTIAL', 'Crawler analyzer with an asserting test — CRAWL', CRAWLER_PART[id]);
  if (NOT_EVALUATED[id]) return s('PARTIAL', 'Defined with severity rule + Fix Card playbook — SHARED; reported as "not evaluated" with the reason, never faked', NOT_EVALUATED[id]);
  if (id === 'PERF-CRUX') return s('PARTIAL', 'CrUX sync raises PERF-CRUX issues (Poor = Critical, insufficient data never resolves) — SYNC', CREDS);
  if (id === 'ONP-STRIKING') return s('PARTIAL', 'Striking-distance queries synced from Search Console into opportunities and the digest — SYNC', CREDS);
  if (/^OFF-/.test(id) || ['AIC-10', 'AEO-PAA', 'CONT-PLAGIARISM', 'GEO-SEMANTIC'].includes(id)) return s('PARTIAL', 'Defined + playbook — SHARED; screens over DEMO data — HTTP-SMOKE', BACKLINK);
  if (id === 'OFF-LOCAL' || id === 'GEO-BRAND-FACTS') return s('PARTIAL', 'Defined + playbook — SHARED; DEMO data — HTTP-SMOKE', 'GBP data sync not implemented');
  if (id === 'AEO-AI-VISIBILITY') return s('PARTIAL', 'Defined — SHARED; panel over DEMO data — HTTP-SMOKE', 'AI-engine sampling not implemented');
  if (id === 'AIC-04') return s('PARTIAL', 'Defined + playbook — SHARED', 'Needs an LLM evaluation pass (not implemented)');
  if (id === 'TECH-SCHEMA-SYNC') return s('PARTIAL', 'Defined + playbook — SHARED', 'Needs a schema.org / Google docs change feed');
  if (id === 'PERF-PSI') return s('PARTIAL', 'Defined + playbook — SHARED', 'PSI lab runs not synced (CrUX field data is)');
  // Remaining GSC-derived checks (index coverage, rich results, cannibalization, decay, intent, low CTR, SERP features, snippets).
  return s('PARTIAL', 'Defined with severity rule + playbook — SHARED; screens over DEMO data — HTTP-SMOKE', 'Analysis over Search Console data not implemented (sync covers visibility, page impressions and striking distance only)');
}

export function DEFAULT_BY_PHASE(r) {
  if (r.id.startsWith('CUS-SCR-')) return s('TESTED', 'SMOKE + HTTP-SMOKE: renders for each permitted role at 390/768/1440 with no page/console errors or overflow');
  if (r.phase === 'P1') return s('IMPLEMENTED', 'apps/web');
  // Anything not listed explicitly above is flagged so it gets reviewed, never silently promoted.
  return s('IN PROGRESS', '', 'Status not yet reviewed at the Phase 2 gate');
}
