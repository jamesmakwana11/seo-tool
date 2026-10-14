# FINAL MASTER BUILD PROMPT — DEODAP SEO SENTINEL

## COMPLETE PDF COVERAGE + CUSTOM REQUIREMENTS

### Mandatory execution order: Frontend → Backend → Database

You are the lead software architect, senior frontend engineer, senior backend engineer, SEO systems engineer, UI/UX designer, and QA engineer responsible for completing **DeoDap SEO Sentinel**.

Your task is to build the complete DeoDap SEO Sentinel application using:

1. The attached original `seotooldocs.pdf`.
2. All requirements in this master prompt.
3. The existing project repository, framework, architecture, components, and code wherever reusable.

This is an implementation assignment, not merely a planning or design assignment.

**Start by inspecting the existing repository and the complete PDF. Implement the application in the actual project files. Do not stop after giving me a plan, creating a wireframe, designing one dashboard, or producing static mockups.**

---

# 1. NON-NEGOTIABLE RULES

## 1.1 The original PDF is mandatory

Treat `seotooldocs.pdf` as the authoritative functional specification for the SEO platform.

Inspect the entire 22-page document, including:

- Every page and section.
- Every subsection.
- Every table and row.
- Every SEO audit check.
- All issue severity definitions and thresholds.
- All workflows and business rules.
- Every scoring formula.
- All integration requirements.
- Every recommendation and Fix Card requirement.
- Every reporting and alerting requirement.
- All governance and safety restrictions.
- The build and rollout requirements.
- Appendix A and all acceptance criteria.

Do not rely on the PDF title, summary, first few pages, or the screen list in this prompt as a substitute for reading the complete specification.

If a table, heading, or section is not extracted correctly, inspect the relevant PDF page directly. Do not silently omit content that is difficult to extract.

## 1.2 My additional requirements are equally mandatory

All the additional requirements in this prompt must be added to the original PDF scope, including:

- Complete modern enterprise SaaS frontend.
- All requested screens and detailed views.
- Admin, SEO Specialist, and Developer experiences.
- Role-aware navigation and permissions.
- Employee and team management.
- SEO task assignment and tracking.
- Progress percentage, comments, blockers, evidence, and activity history.
- Kanban, My Tasks, workload views, and task verification.
- Backend APIs and business logic.
- Temporary in-memory development storage before database authorization.
- Explicit frontend and backend completion reports.
- Database integration only after my separate, explicit authorization.

The original PDF and my extra requirements are cumulative. Neither replaces the other.

Where the PDF's internal delivery timeline differs from my requested implementation sequence, preserve all PDF functionality but follow my implementation sequence:

**Phase 1: Frontend complete → Phase 2: Backend complete → Phase 3: Database only after authorization.**

Do not remove an original feature merely because it belongs to a later rollout stage in the PDF.

## 1.3 Never claim unsupported completion

A screen being present does not mean its underlying feature is implemented.

A button being clickable does not mean its business operation is complete.

Sample metrics do not mean live analytics are connected.

A task marked FIXED does not mean its SEO problem has been verified.

An integration configuration screen does not mean the external service is connected.

Always distinguish between:

- Designed.
- Implemented.
- Tested.
- Connected to real external data.
- Temporarily simulated using labelled development data.
- Blocked by missing credentials or dependencies.

---

# 2. INITIAL REPOSITORY AND DOCUMENT INSPECTION

Before implementation:

1. Inspect the complete repository structure.
2. Identify the existing frontend framework, programming language, build tools, routing, UI libraries, styling system, and reusable components.
3. Identify the existing backend, API conventions, and service architecture.
4. Identify existing authentication, permissions, integrations, tests, and configuration.
5. Find the attached PDF and read all 22 pages.
6. Identify existing features that must be preserved.
7. Identify missing features and broken implementations.
8. Create a requirement inventory and implementation traceability matrix.

Preserve the current framework and reusable code wherever practical. Do not unnecessarily rewrite the entire project or introduce a different framework simply because you prefer it.

Do not delete existing working features to make the new design easier.

If a required architectural decision is straightforward, make a sensible engineering decision and continue without asking me to approve routine choices.

Create the initial tracking file:

`FEATURE_TRACEABILITY.md`

It must contain one entry for every requirement extracted from the PDF and every additional requirement in this prompt.

For each entry, include:

- Requirement ID.
- Original PDF page and section, where applicable.
- Requirement description.
- Required frontend screen or component.
- Required API, service, or business logic.
- Relevant role and permissions.
- Implementation phase.
- Current status.
- Test evidence or test reference.
- Dependency or blocker, if any.

Use these statuses:

`NOT STARTED`, `IN PROGRESS`, `IMPLEMENTED`, `TESTED`, `BLOCKED`, `PARTIAL`.

Do not mark a requirement TESTED without corresponding test or verification evidence.

---

# 3. STRICT IMPLEMENTATION PHASES

## Phase 1 — Complete frontend

Finish the entire frontend scope and evaluate every frontend completion criterion.

Only after the frontend passes its completion evaluation may you begin Phase 2.

## Phase 2 — Backend

After Phase 1 is complete, implement and test the backend using repository interfaces and temporary non-database storage.

Do not introduce a database in this phase.

## Phase 3 — Database integration

Wait until I explicitly instruct you to start database integration.

Until then, do not create or configure:

- A PostgreSQL, MySQL, SQLite, SQL Server, or other database.
- Database schemas or database tables.
- ORM/database models intended for persistence.
- Database migrations.
- Database connection strings or connection infrastructure.
- Database containers or persistent database services.
- Database integration hidden inside an alternative package.

Normal application TypeScript interfaces, API contracts, business-domain types, and in-memory repository objects are allowed. They must not become a reason to start database work early.

---

# 4. PHASE 1 — MODERN ENTERPRISE FRONTEND

Build the complete internal DeoDap SEO Sentinel application.

## 4.1 Design direction

The application must look like a premium enterprise SaaS product comparable in quality to professional SEO analytics, monitoring, and project-management platforms.

Design principles:

- Modern, clean, professional, information-dense interface.
- Consistent typography, sizing, spacing, colors, and design tokens.
- Responsive desktop, tablet, and mobile layouts.
- Collapsible sidebar navigation.
- Clear application header, breadcrumbs, account menu, and global actions.
- Consistent cards, charts, data tables, filters, dialogs, drawers, tabs, and badges.
- Clear visual hierarchy for critical issues and urgent tasks.
- Readable analytics and useful drill-downs.
- Accessible forms, visible keyboard focus, keyboard navigation, and sufficient contrast.
- Appropriate skeleton loaders, empty states, error states, confirmation dialogs, and success feedback.
- Subtle, purposeful transitions.
- Reusable UI components rather than duplicated page-specific markup.
- Functional search, filtering, sorting, pagination, and date ranges where appropriate.

Avoid excessive gradients, unnecessary animations, oversized empty spaces, decorative widgets, and generic templates that do not serve the SEO workflow.

Do not build just a landing page. This is an internal operating application.

## 4.2 Required frontend screens

Implement all of these screens and any additional screens or detail views needed by the PDF.

### Authentication and application shell

1. Login.
2. Password recovery.
3. Password-reset experience where supported by the development authentication flow.
4. Application shell and primary navigation.
5. Global search.
6. Notifications center.
7. User profile and account settings.

### Dashboard and SEO health

8. Main SEO dashboard.
9. SEO Health Score overview.
10. Historical SEO Health Score trends.
11. Module-wise health scores.
12. Issue counts by severity and module.
13. Crawl and indexation trends.
14. Core Web Vitals by template.
15. Organic visibility trends.
16. AI-visibility and brand-mention trends.
17. Today’s changes and daily digest preview.
18. Critical alerts and SLA watchlist.

### SEO audit modules

19. Technical SEO audit.
20. Crawlability and indexability.
21. Response codes, redirects, and internal/external links.
22. Canonicalization and duplication.
23. Performance and Core Web Vitals.
24. Security, mobile usability, and JavaScript rendering.
25. Structured data and rich-result validation.
26. Content audit.
27. On-page SEO audit.
28. Off-page SEO dashboard.
29. Backlink analysis.
30. Answer Engine Optimization (AEO).
31. Generative Engine Optimization (GEO).
32. AI-generated-content compliance.
33. AI visibility monitoring.
34. Keyword and content opportunities.

### Crawl and issue operations

35. Crawl Center.
36. Full-crawl and smart-crawl controls.
37. Crawl scheduling.
38. Crawl history and run details.
39. Sitemap-difference view.
40. Changed URLs and failed URLs.
41. Re-verification crawl results.
42. Issues board.
43. Issue details.
44. Issue evidence and affected URLs.
45. Fix Card details.
46. False-positive feedback and exclusions.
47. Issue grouping and template-level issues.

### Task management and team operations

48. Task management overview.
49. My Tasks.
50. Kanban board.
51. Task list with filtering, sorting, and search.
52. Task details.
53. Task comments.
54. Task activity timeline.
55. Before-and-after evidence.
56. Blocker tracking.
57. Review and verification workflow.
58. Team workload dashboard.
59. Team assignment and reallocation history.
60. Employee management.
61. Role and permission management.

### Opportunities and content workflow

62. Keyword research.
63. Competitor keyword gaps.
64. Content opportunity board.
65. Content brief editor.
66. Topic-cluster tracker.
67. Seasonal planning.
68. Competitor analysis.
69. Digital PR and backlink opportunities.
70. Unlinked brand-mention opportunities.

### Reporting, configuration, and operations

71. Daily report and digest view.
72. Weekly report.
73. Monthly executive report.
74. Report history and export controls.
75. Notification and alert configuration.
76. Audit log viewer.
77. Integration configuration.
78. SEO thresholds and scoring settings.
79. Crawl configuration.
80. Custom AI-content rule builder.
81. Verification results.
82. System health and error monitoring.
83. Developer/API diagnostic views where appropriate.

This numbered screen inventory is not permission to omit a PDF feature that does not appear as a separate item above. Add all missing views, sub-pages, tables, and detail panels that the complete specification requires.

## 4.3 Role-based user experiences

Implement reusable role-aware navigation, UI permissions, and route guards appropriate to the frontend phase.

### ADMIN

Admin views must include:

- Overall SEO operations dashboard.
- All users and employees.
- Team and employee assignments.
- Role and permission management.
- All issues and tasks.
- All modules and reports.
- Integration settings.
- Crawl configuration.
- Severity and SLA settings.
- Scoring configuration.
- Custom rules.
- System health.
- Audit logs.

### SEO SPECIALIST

SEO Specialist views must include:

- SEO health and module dashboards.
- Technical, on-page, content, off-page, AEO, GEO, and AI-compliance findings.
- Keyword opportunities and competitor gaps.
- Fix Cards.
- Team allocation and task assignment.
- SEO task progress.
- Re-verification results.
- Personal and team workloads.
- Content briefs and opportunity management.
- SEO reports and relevant configuration settings.

### DEVELOPER

Developer views must include:

- Assigned development tasks.
- Technical SEO findings.
- Affected URLs.
- Evidence, HTTP responses, screenshots, and reproduction details where available.
- Probable root cause.
- Shopify implementation guidance.
- Exact fix instructions and acceptance criteria.
- Relevant code snippets or configuration instructions.
- Estimated effort and SLA countdown.
- Progress updates.
- Blocker reporting.
- Before-and-after evidence.
- Review submission.
- Verification outcome.

### Development-only role preview

During Phase 1, allow authorized development users to preview Admin, SEO Specialist, and Developer experiences using clearly labelled mock users.

This must be labelled as DEVELOPMENT/DEMO role preview. Do not claim it is production authentication.

The backend must eventually enforce roles and permissions independently of the frontend.

The PDF also requires allocation to the SEO, Content, and Development teams. Preserve these team-level workflows alongside the three user roles above. Do not confuse user roles with assignment teams.

Use the original team's labels where specified, including the 1into2 SEO Team, 1into2 Content Team, and 1into2 Development Team.

---

# 5. COMPLETE PDF FUNCTIONAL REQUIREMENTS

The following inventory summarizes the mandatory functional areas. Use it together with the full PDF page-by-page; it does not replace the original wording or authorize the omission of any additional check found in the document.

## 5.1 Purpose and system architecture

The platform must be developed as a complete daily SEO auditing and recommendation system for DeoDap's Shopify-based wholesale e-commerce store.

It must answer:

1. What broke or degraded?
2. How serious is it, taking business impact into account?
3. What exact DeoDap-specific action should the team take?

Preserve the six cooperating subsystems from the original specification:

- Crawler and Renderer.
- Data Connectors.
- Analysis Engine.
- Severity Classifier.
- Smart Recommendation Engine.
- Reporting and Workflow Layer.

Do not reduce the application to a dashboard that merely mirrors Google Search Console.

## 5.2 Crawl strategy and change detection

Support the original crawl strategy:

**Weekly full crawl**

- Crawl all indexable URLs.
- Include JavaScript-rendered sampling as specified.

**Daily smart crawl**

- Homepage.
- All category and collection pages.
- Top 500 products by revenue/traffic.
- URLs changed during the preceding 48 hours.
- Changes detected using sitemap `lastmod` and Shopify webhooks for product, collection, and page changes.
- All URLs with issues from the previous day for re-verification.

**Delta detection**

- Compare each check with the previous result.
- Highlight changes rather than repeating the complete inventory every day.
- Preserve sufficient historical data through an abstract service/repository layer.
- Distinguish newly detected, recurring, resolved, worsening, and unchanged issues.

Also represent crawl failures, crawl history, failed URLs, changed URLs, sitemap differences, scheduling, and re-verification.

Do not falsely claim a scheduled crawl ran when no crawler execution occurred.

## 5.3 Page-value tiers and severity classification

Implement the PDF's business-value model.

**Tier 1 — Money pages**

- Homepage.
- Top 20 collections.
- Top 200 products based on last-90-day revenue or organic sessions.

**Tier 2 — Working pages**

- Other indexable collections.
- Products with organic impressions.
- Blog posts with clicks.

**Tier 3 — Long-tail pages**

- Other indexable pages.

Severity must be derived from issue type and page value, not issue type alone.

Preserve the documented rules:

- **Critical:** same-day SLA.
- **Medium:** seven-day SLA.
- **Low:** 30-day batch SLA.

Implement escalation rules:

- A Medium issue becomes Critical if its page enters Tier 1.
- An unresolved Medium issue escalates one severity level after its SLA and triggers another alert.
- Three or more related Medium issues on one template can be grouped into one Critical template-level issue according to the original rule.

Display severity, rationale, business impact, page tier, SLA deadline, and escalation history.

Do not invent new thresholds as replacements for the values specified in the PDF. Configurable values should be stored in application configuration appropriate to the current phase.

## 5.4 Module 1 — Technical SEO audit

Implement the complete check library in PDF Section 4, including the following groups.

### A. Crawlability and indexability

- Robots.txt change monitoring.
- Accidental blocking of important indexable paths, including collections, products, and blogs.
- Blocked CSS/JavaScript.
- New noindex meta directives or X-Robots-Tag directives on previously indexed URLs.
- Google Search Console index coverage changes.
- Growth in excluded, crawled-not-indexed, or discovered-not-indexed URLs.
- XML sitemap reachability and validity.
- Sitemap URL limits and invalid URLs.
- Last-modified accuracy.
- Sitemap-versus-crawl orphan-page comparison.
- Orphan pages discovered through sitemaps or Search Console.
- Crawl depth for Tier 1 and Tier 2 pages.
- Parameterized and faceted URL crawl waste.
- Shopify collection-tag near-duplicates and unexpected indexing.

### B. Response codes, redirects, and links

- New 404 and 410 errors.
- Soft 404s.
- 429 rate limits affecting search-engine crawlers.
- New 5xx errors.
- Server response timeouts and responses exceeding the specified threshold.
- 302-versus-301 audit.
- Redirect chains and loops.
- Redirects to broken destinations.
- Broken internal links.
- Broken outbound links.
- Discontinued Shopify products creating live 404s.
- Suggested redirect targets for discontinued products.

### C. Canonicals and duplication

- Missing or conflicting canonicals.
- Canonicals pointing to redirects, 404s, or noindexed URLs.
- Canonical and Open Graph URL mismatches.
- Shopify product-versus-collection product URL canonicalization.
- Near-duplicate titles, descriptions, body content, and H1s.
- Thin content on indexable pages.
- Canonical-host consistency across www/non-www and protocol variants.
- Trailing-slash consistency and redirect behavior.

### D. Performance and Core Web Vitals

- CrUX field data for LCP, INP, and CLS.
- Origin-level and template-level measurements.
- Core Web Vitals status.
- Daily mobile and desktop PageSpeed Insights runs on the homepage, top collections, and top products.
- PageSpeed regressions compared with the preceding seven-day average.
- New render-blocking scripts.
- Shopify app bloat and daily script-list differences.
- Identification of potentially implicated applications where evidence permits.
- Images exceeding the PDF's specified weight threshold.
- WebP/AVIF usage checks.
- Lazy-loading issues.
- Missing image dimensions and CLS risk.
- Oversized hero images.
- Third-party JavaScript payload trends.

### E. Security, mobile, and rendering

- HTTPS and certificate expiry monitoring.
- Mixed-content issues.
- HSTS checks.
- Mobile viewport problems.
- Tap-target and font-size problems.
- Content wider than the mobile viewport.
- Raw HTML versus JavaScript-rendered DOM differences.
- Important content or links missing from raw HTML.
- Content dependent on client-side rendering.
- Pagination behavior, indexability, canonicals, and pagination depth.

### F. Structured data and rich results

- Product schema.
- Offer, price, availability, and aggregate rating fields.
- BreadcrumbList.
- Organization.
- WebSite and SearchAction.
- CollectionPage and ItemList.
- FAQPage.
- Article schema for blog content.
- Google rich-result errors and warnings.
- Missing required fields.
- Product schema price mismatch versus visible prices.
- Review markup without corresponding visible reviews.
- Daily changes in valid rich-result coverage.
- Monthly structured-data guideline synchronization with official Google documentation and Search Central announcements.
- Detection of deprecated types, newly required properties, property renames, and format changes.
- Fix Cards showing the necessary Liquid/JSON-LD changes.
- Re-validation after fixes.

Preserve all conditions and severity rules documented for these checks. Do not silently assume that a crawler result or schema check is available without the relevant implementation or data source.

## 5.5 Module 2 — Content audit

Implement daily content auditing, with newly created or changed pages prioritized and new-page QA handled within the PDF's specified timeframe.

Include:

- New-page QA gate for products, collections, and blogs.
- Per-page content quality score from 0–100.
- Content uniqueness.
- Content depth against top-ranking search results.
- Readability.
- Media usage.
- Freshness.
- Search-intent mismatch.
- Organic content decay based on the specified comparison periods and decline thresholds.
- Stale Tier 1 collections and blog content.
- Keyword cannibalization using query-to-URL history.
- AI-content boilerplate and missing experience signals.
- Supplier-description duplication.
- Competitor-page duplication and canonical-source concerns.

Include the relevant evidence, affected URLs, score explanation, severity, recommendations, and task-conversion workflow.

## 5.6 Module 3 — On-page SEO audit

### Metadata and structure

Implement every documented check for:

- Missing, duplicate, excessively long, and excessively short title tags.
- Missing primary keywords in title tags.
- Brand-pattern violations.
- Template artifacts such as raw Liquid variables or unintended “Untitled” text.
- Missing or duplicate meta descriptions.
- Meta description length limits.
- Missing calls to action or wholesale selling points.
- Missing, multiple, duplicate, or mismatched H1s.
- Heading hierarchy and skipped levels.
- Missing H2 structure on long content.
- Visible breadcrumbs and BreadcrumbList consistency.
- Missing, empty, or keyword-stuffed image ALT attributes.
- Generic image filenames.
- DeoDap's product ALT naming pattern.
- Open Graph and Twitter metadata issues.

### Template-level audits

Cover the homepage, collection pages, and product pages separately.

**Homepage**

- Main H1.
- Target keyword coverage.
- Above-the-fold value proposition.
- Links to Tier 1 collections.
- Organization and WebSite schema.
- Freshness/new-arrivals section.
- Internal-link-count sanity checks.

**Collection pages**

- Unique collection descriptions.
- Short and expandable descriptions where relevant.
- Collection H1 and keyword alignment.
- Filter/sort URL canonicalization.
- Subcollection interlinking.
- FAQ coverage.
- ItemList schema.
- Server-rendered first product row.

**Product pages**

- Unique descriptions versus supplier boilerplate.
- Product specification tables.
- Wholesale/bulk pricing clarity.
- Product schema completeness.
- Visible reviews and corresponding markup.
- Related-products and frequently-bought-together links.
- Q&A sections.
- Shipping and return information.
- Video availability where relevant.

### Keyword targeting and CTR

- Tier 1/Tier 2 page-to-primary-keyword mapping.
- Keyword presence in title, H1, URL, and first 100 words.
- Keyword drift detection.
- Striking-distance queries ranking in positions 5–20 with meaningful impressions.
- Low-CTR alerts for high-ranking queries.
- Suggested title and meta-description rewrites.
- Lost featured snippets, sitelinks, and rich results.
- SEO opportunities generated from these findings.

## 5.7 Module 4 — Off-page SEO audit

Implement daily changes and weekly deep analysis.

Include:

- New backlinks.
- Lost backlinks.
- Recovery opportunities for valuable lost links.
- Toxic-link spikes and suspicious referring domains.
- Link-farm patterns.
- Foreign-language spam signals.
- Exact-match commercial anchor-text over-optimization.
- Referring-domain trend comparisons over 7- and 30-day periods.
- Competitor domain comparisons.
- Unlinked DeoDap brand mentions.
- Link reclamation outreach lists.
- Competitor backlink gaps.
- Domains linking to multiple competitors but not to DeoDap.
- Prioritization using domain rating and topical relevance.
- Suggested outreach pitch angle.
- Digital PR opportunities.
- Seasonal PR opportunities for DeoDap's categories.
- Festival opportunities surfaced ahead of the relevant dates.
- Local citations and NAP consistency.
- Google Business Profile health.
- Review velocity.
- Disavow-candidate monitoring with human approval required before submission.

Do not invent backlink data, toxicity scores, competitor rankings, or connected Ahrefs/Semrush results when the relevant connection is unavailable.

## 5.8 Module 5 — AEO audit

Implement Answer Engine Optimization coverage for Google AI Overviews, ChatGPT, Gemini, Perplexity, and Bing Copilot.

Include:

- Answer-block coverage.
- Direct answers under question-formatted headings.
- FAQ coverage and markup.
- Missing or weak FAQ answers.
- People Also Ask question gaps.
- Automatically proposed content briefs for unanswered questions.
- Featured-snippet opportunities.
- Suggested paragraph, list, or table formatting.
- Per-page extractability scoring.
- Definition sentences, comparison tables, numbered steps, and specification tables.
- Organization entity clarity.
- `sameAs`, social profiles, logo, founder, and address coverage where supported by known facts.
- Brand-description consistency.
- Wikipedia/Wikidata presence gaps.
- AI crawler accessibility checks for GPTBot, Google-Extended, PerplexityBot, CCBot, and Bingbot.
- Detection and transparent reporting of intentional crawler-blocking choices.
- Weekly buyer-intent prompt panel of approximately 50 prompts.
- Brand mentions/citations across supported AI engines.
- Visibility trends and competitor comparisons.

## 5.9 Module 6 — GEO audit

Implement Generative Engine Optimization checks covering:

- E-E-A-T signals.
- About-page depth.
- Real author biographies and credentials.
- Visible shipping, returns, contact, and phone information.
- Trust badges and review authenticity.
- Citation-worthy original statistics.
- Price benchmarks and unique buying guides.
- Missing original research/content opportunities.
- Topic-cluster and pillar-to-cluster integrity.
- Orphan topic-cluster pages.
- Missing high-volume topic pillars.
- Semantic/entity coverage versus ranking competitors.
- Missing subtopics for money pages.
- Freshness signals.
- Visible last-updated dates and `dateModified` schema.
- Stale statistics.
- Brand fact consistency across the website, Google Business Profile, LinkedIn, and marketplaces.
- Descriptive H2/H3 organization, self-contained sections, and chunk-friendly formatting for AI retrieval.

Include trend tracking, opportunities, recommendations, and task creation.

## 5.10 Module 7 — AI-generated-content compliance

Implement all 12 built-in checks described in Section 10.1 of the PDF:

1. Scaled content abuse detector.
2. Unedited AI boilerplate scan.
3. Factual accuracy and hallucination check.
4. People-first value test.
5. E-E-A-T and first-hand experience-signal absence.
6. Fake review and testimonial markup.
7. YMYL caution gate.
8. Doorway-page pattern detection.
9. Keyword stuffing and unnatural-language detection.
10. Cross-site content duplication.
11. Disclosure and authorship hygiene.
12. Outdated-model artifacts.

Preserve the original detection descriptions and severity rules. In particular, the YMYL caution gate must support blocking the publication QA process and requiring human approval where the PDF requires it.

Each flag must support:

- Exact offending passage.
- Affected URL and page template.
- Evidence and explanation.
- Severity and reason.
- A rewritten human-quality draft suggestion.
- Fix Card generation.
- Assigned team and task creation.
- Verification and audit history.

Do not claim AI-generated copy is safe simply because it passes a generic grammar or similarity check.

### Custom AI-content rule builder

Create a configurable, usable rule builder with:

**Detection methods**

- Pattern and regex.
- Banned or required phrase lists.
- Threshold rules for word count, keyword density, duplication, and AI-likelihood score.
- LLM-judged instructions written in plain language.

**Rule scope**

- Product, collection, and blog templates.
- Selected collections.
- Page tiers.
- Newly published pages.
- Full-site scans.

**Severity and routing**

- Critical, Medium, and Low.
- Default team: SEO, Content, or Development.

**Actions**

- Flag only.
- Flag and draft rewrite.
- Block in the publication QA gate for applicable new pages.

**Scheduling**

- Daily.
- On publication.
- Weekly.

Include rule testing and a dry-run mode against the previous 30 days of pages before enabling a rule. Integrate custom checks into the normal severity, Fix Card, alert, and verification workflow.

The rule builder must accommodate the PDF's sample rules, including unsupported lowest-price claims, missing No-MOQ messaging, machine-translated Hindi/Hinglish copy, and expired festival-offer copy.

## 5.11 Smart Recommendation Engine and Fix Cards

Every failed SEO check must generate a complete Fix Card, not just a bare error or generic recommendation.

The recommendation logic must account for:

- Issue type.
- Affected URLs.
- Page tier.
- Template type.
- Historical recurrence.
- Relevant Shopify theme, template, or application context.
- Available evidence.
- Probable root cause.
- Suggested remediation.
- Effort estimate.
- Expected impact.
- Confidence.
- Recommended owner.
- Verification conditions.

Implement root-cause grouping when evidence supports it. For example, multiple product 404s caused by catalog changes should not automatically produce unrelated individual fixes.

Preserve the prioritization formula from the PDF:

`Priority = Impact × Confidence × inverse Effort`

Use page tier to break ties as specified in the original document. Define consistent score scales in configuration instead of inventing unexplained numbers.

### Every Fix Card must support

- Severity and title.
- Problem description.
- Why the issue matters.
- Affected URLs.
- Page-value tier.
- Evidence.
- Extracted technical data or screenshots when available.
- Root-cause inference and confidence.
- Exact step-by-step remediation.
- Shopify Admin navigation and theme/app guidance where applicable.
- Code snippets or configuration instructions when appropriate.
- Alternative fixes where useful.
- Owner recommendation.
- Team assignment.
- Estimated effort.
- Expected impact.
- SLA and deadline.
- Verification procedure.
- Historical recurrence.
- Comments and audit history.
- Not-an-issue feedback with reason.
- Reopening and regression handling.

Content-related Fix Cards should support ready-to-edit recommendations, including three title/meta-description variants scored or compared for expected CTR, collection-content outlines, target entities, and drafted FAQ answers where applicable.

Template-level remediation must be capable of superseding redundant page-level Fix Cards.

## 5.12 Mandatory one-tap allocation workflow

Preserve the PDF's exact team-allocation concept.

Every relevant Fix Card must support:

- Fix with 1into2 SEO Team.
- Fix with 1into2 Content Team.
- Fix with 1into2 Development Team.

The recommended team must be preselected based on the inferred type of work where sufficient evidence exists. A user can override that recommendation.

Record the full allocation trail:

- Who allocated the issue.
- Which team received it.
- Timestamp.
- Previous and new team when reallocated.
- Reason where provided.

The allocation trail must appear in relevant Fix Card views, the issue board, the task history, and audit logs.

An allocation action must create or update the associated task with:

- Fix Card description.
- Selected team.
- Priority derived from severity.
- SLA deadline.
- Issue reference.
- Acceptance and verification criteria.

Reallocation must update the task assignment and notify the relevant teams through configured notification adapters.

Support bulk allocation for grouped template-level issues.

The daily digest must show the previous day's allocations, issues unallocated beyond the specified threshold, automatic escalation where applicable, and open workloads by SEO/Content/Development team.

## 5.13 Reporting, notifications, and workflows

### Daily digest

Implement the complete daily digest specified in the PDF, scheduled for 8:00 AM IST when scheduling and the relevant delivery adapters are operational.

It must contain:

1. SEO Health Score and seven-day trend.
2. New Critical issues, each with a Fix Card reference.
3. Medium issues grouped by module.
4. AI-content compliance flags, evidence, and rewrite suggestions.
5. Issues verified as fixed since the previous report.
6. Daily opportunities: striking-distance keywords, CTR rewrites, and content briefs.
7. Team-allocation status.
8. Unallocated issues and open team workload.
9. Approaching SLA deadlines and watchlist items.
10. Applicable one-tap team-allocation actions.

### Real-time critical alerts

Support high-priority alert routing for:

- Sitewide 5xx errors.
- Robots.txt changes affecting indexing.
- Homepage or Tier 1 noindex problems.
- SSL failures.
- Indexed-page collapses.
- Toxic-link spikes.
- A Core Web Vitals template turning Poor.

Do not claim an alert has actually been sent unless its configured delivery adapter confirms success.

### Dashboard and issue board

Provide:

- SEO health score.
- Issue counts by severity and module.
- CWV by template.
- Indexation trend.
- Search visibility and AI-mention trend.
- Filtering by severity, module, allocation team, allocator, and status.
- Issue drill-down.
- Links between issues, Fix Cards, and tasks.

Preserve the original issue status concepts, including New, Assigned, In Progress, Fixed, Verified, and Closed. Extend them using the lifecycle specified in Section 6 of this prompt.

Nothing may be marked verified merely because someone manually selected Fixed.

### Weekly rollup

Include:

- Off-page deep dive.
- AI-visibility results.
- Competitor movement.
- SLA compliance.
- The ten highest-priority actions for the week.

### Monthly executive report

Include:

- Organic traffic/revenue compared with the previous month and year-over-year period where data is available.
- SEO Health Score trend.
- Issues opened and closed.
- Money-keyword ranking movement.
- AI-mention share versus competitors.
- Three recommended strategic actions.

All reports must identify the source, reporting period, and any missing or demo data.

## 5.14 Keyword and content opportunity engine

Implement:

- Competitor keyword-gap discovery.
- Keywords where at least two competitors rank in the top ten but DeoDap does not, where the necessary data is available.
- Relevance filtering against live categories.
- Informational, commercial, and transactional intent classification.
- Low-keyword-difficulty quick wins where a supported source supplies that metric.
- Content brief generation from approved keyword gaps.
- Target keyword and cluster.
- Search intent.
- Suggested URL and page type.
- SERP-based outline.
- Entities and subtopics.
- FAQ suggestions.
- Internal-link recommendations.
- Seasonal planner.
- India-specific festival and season planning with appropriate advance prompts.
- Topic-cluster completeness.
- Pillar status and internal-linking integrity.
- Combined cluster traffic trends.

Every approved opportunity must be convertible into a task.

Competitor data and keyword difficulty must not be fabricated when their source is unavailable.

## 5.15 SEO Health Score

Preserve the PDF's exact weighted composite model:

- Technical SEO: 30%.
- On-Page SEO: 20%.
- Content and AI Compliance: 15%.
- Performance/Core Web Vitals: 10%.
- Off-Page SEO: 10%.
- AEO: 8%.
- GEO: 7%.

The score must be on a 0–100 scale.

Implement each module's score using the PDF's severity-weighted open-issue model, normalized against site size, with Tier 1 issues weighted five times as specified.

Show module contributions, historical trends, and the effect of verified remediation.

Make the calculation transparent and consistent. Do not show fabricated live scores as real site health.

## 5.16 Integrations and data sources

Provide appropriate configuration, connection-status, access-requirement, error, and testing interfaces for all original PDF data sources:

1. Site crawler, including supported crawler APIs or tools.
2. Google Search Console API.
3. Google Analytics 4 API.
4. PageSpeed Insights API and CrUX field data.
5. Ahrefs or Semrush API.
6. Shopify Admin API and webhooks.
7. Google Business Profile API.
8. AI-engine API integrations for supported providers such as OpenAI, Gemini, and Perplexity.
9. Configured email, WhatsApp, and Slack notification adapters.
10. DeoDap Task Ops integration, or a documented internal task interface when a real existing API is unavailable.

Preserve the access requirements in PDF Section 15.

Build connectors behind interfaces so they can be implemented and tested independently.

Never hard-code secrets into source code. Use appropriate environment configuration and document required variables using an `.env.example` file without real credentials.

Use explicit integration states such as:

- Not configured.
- Credentials missing.
- Connection test failed.
- Connected.
- Partial functionality.
- Rate limited.
- Last sync failed.
- Last successful sync.

Do not claim the connected state without a successful connection test.

Keep external-source data distinct from mock, sample, and temporary in-memory data.

If a service requires paid API units, a subscription, account permissions, or credentials, document the requirement accurately.

## 5.17 Original rollout plan and acceptance criteria

Preserve the functional deliverables represented in PDF Section 16, including the foundation checks, on-page and content functionality, Fix Card playbook, team allocation, off-page monitoring, AEO/GEO, AI compliance, AI visibility, custom rules, root-cause analysis, grouped issues, CTR rewrite suggestions, seasonal planning, SLA automation, and executive reporting.

The rollout sequence in the PDF must not override the frontend-first, backend-second, database-last order explicitly required in this prompt.

Track these original acceptance criteria:

- Daily digest delivered by 8:00 AM IST when production scheduling and delivery integrations are operational.
- Fewer than 5% false positives on Critical issues as a validation target.
- Every detected issue has a complete Fix Card.
- Re-verification closes issues automatically when its successful conditions are satisfied.
- A template-level bug introduced in staging is detected within one daily crawl cycle.

Do not mark an acceptance criterion passed simply because its UI exists. Implement tests or an operational validation procedure and document actual results.

---

# 6. SEO TASK MANAGEMENT — COMPLETE WORKFLOW

The task-management functionality requested in this prompt is mandatory in addition to PDF Section 12.

Use this lifecycle:

`NEW → TRIAGED → ASSIGNED → IN PROGRESS → BLOCKED → READY FOR REVIEW → FIXED → VERIFIED → CLOSED`

Support valid transitions, review rejection, failed verification, regression, reopening, reassignment, and reasoned cancellation where appropriate.

Maintain the original PDF's simpler issue-status representation through a clear mapping if necessary. Do not lose the distinction between task progress and issue status.

Every task should support:

- Task ID and title.
- Description and linked Fix Card.
- SEO module.
- Severity.
- Affected URLs.
- Page tier.
- Priority.
- Creator.
- Assignment history.
- Assigned role, employee, and team.
- Recommended and actual owner.
- Creation and modification timestamps.
- Due date.
- SLA countdown and breach state.
- Progress percentage.
- Estimated and actual effort.
- Status and status-transition history.
- Comments.
- Blockers and dependency references.
- Evidence and attachments where supported.
- Before-and-after comparison.
- Acceptance criteria.
- Review submission.
- Verification attempts and outcomes.
- Related issues.
- Activity timeline.

Use these views:

- My Tasks.
- Team Tasks.
- All Tasks.
- Kanban Board.
- List View.
- Task Detail View.
- Team Workload.
- Overdue Tasks.
- SLA Watchlist.
- Review Queue.
- Verification Queue.
- Completed and Reopened Tasks.

Every status transition must validate the requested action and permitted role.

A Developer must be able to submit a completed implementation for review. That action must not automatically mark the SEO issue Verified.

Verification must evaluate the relevant condition, evidence, or result. Where real data is unavailable, show a clearly labelled pending/manual verification status rather than a false pass.

Failed or regressed verification must support reopening or returning the task to the relevant work state.

---

# 7. PHASE 1 FRONTEND IMPLEMENTATION RULES

## 7.1 Functional interactions

All visible controls must have meaningful behavior:

- Sidebar links and route navigation.
- Filters, search, sorting, pagination, and date ranges.
- Buttons, menus, tabs, forms, dialogs, and drawers.
- Form validation and helpful validation feedback.
- Task assignment and reallocation.
- Task status transitions.
- Progress updates.
- Comments and activity events.
- Role preview.
- Issue acknowledgement and false-positive feedback.
- Fix Card expansion and task creation.
- Table row detail navigation.
- Report filter and export UI where the export function is actually implemented.
- Integration configuration and connection-test UI with honest status.

Do not create decorative buttons that do nothing.

## 7.2 Data and API architecture

- Define TypeScript interfaces and API contracts.
- Use a clean API/service layer.
- Separate components from the sample-data source.
- Use reusable hooks and feature services where appropriate.
- Create a temporary mock-data adapter for the frontend.
- Keep the future backend integration behind the API layer.
- Avoid hard-coded demo data scattered across components.
- Provide a clear development mode.
- Label sample metrics, sample reports, simulated crawler results, and mock integrations with DEMO/SAMPLE indicators.
- Include loading, empty, error, retry, and success states.
- Keep sample data deterministic and realistic enough to validate the workflow.

Use temporary in-memory or local development state if necessary. Do not imply that the state will persist across browser sessions or server restarts unless a real persistence mechanism is authorized and implemented.

## 7.3 Frontend quality

Check:

- Desktop, tablet, and mobile responsiveness.
- Keyboard navigation and focus states.
- Color contrast.
- Form accessibility.
- Broken links and routes.
- Missing screen states.
- Console errors.
- Type errors.
- Build and lint errors.
- Reusable component consistency.
- Navigation and role-specific access.
- Task workflow validation.
- Every requirement in `FEATURE_TRACEABILITY.md`.

Do not start backend implementation until Phase 1 is complete or the remaining gaps are honestly identified and resolved.

## 7.4 Phase 1 required artifacts

Create and maintain:

### `FRONTEND_STATUS.md`

Include:

- Screens implemented.
- Screens pending.
- Functional interactions tested.
- Build/lint/type-check results.
- Responsive checks.
- Known issues.
- Demo/sample-data limitations.
- Frontend completion checklist.

### `FEATURE_TRACEABILITY.md`

Update the master requirement matrix for every PDF requirement and custom requirement. Reference relevant source pages and sections, actual files/components/routes, and validation evidence.

---

# 8. PHASE 1 COMPLETION GATE

Before starting Phase 2, confirm that:

1. The entire PDF and all additional requirements have been inventoried.
2. Every required screen has been implemented.
3. All necessary nested detail screens are included.
4. Navigation and routes work.
5. Admin, SEO Specialist, and Developer views can be previewed.
6. All applicable role-aware UI permissions are implemented.
7. Temporary task assignment and progress interactions work.
8. The task lifecycle and transition validation work.
9. Issue filtering, sorting, search, and status controls work.
10. Fix Cards support the required details and allocation interactions.
11. Sample data is clearly labelled.
12. All applicable loading, empty, error, and success states exist.
13. Responsive layouts have been checked.
14. Build and relevant frontend checks pass.
15. Broken links, controls, and frontend errors have been corrected.
16. `FRONTEND_STATUS.md` is complete.
17. `FEATURE_TRACEABILITY.md` is updated with evidence.
18. Every unimplemented or blocked frontend requirement is explicitly identified.

Do not silently proceed past incomplete frontend work.

---

# 9. PHASE 2 — BACKEND IMPLEMENTATION

Only after the Phase 1 completion gate has been evaluated, implement the backend.

Inspect the actual existing backend and use the current technology stack wherever practical.

If no backend exists, select a suitable framework compatible with the existing project and document the decision. Do not use framework changes as an excuse to rewrite working frontend code.

## 9.1 Authentication and authorization

Implement the appropriate authentication and authorization architecture.

Support:

- Login and password recovery flows as appropriate to the existing environment.
- User identity and account status.
- Admin, SEO Specialist, and Developer roles.
- Permission-aware API endpoints.
- Team assignment and membership.
- Server-side authorization on every protected operation.
- Request validation.
- Authentication failure handling.
- Secure configuration for secrets.

Because database integration is forbidden at this stage, any user store must be clearly temporary and in-memory, or use an already existing non-database development mechanism.

Do not represent temporary development authentication as production-ready, persistent authentication.

Frontend role hiding is not sufficient: the backend must reject unauthorized requests even when they are sent directly.

## 9.2 API contracts and business logic

Implement and test the APIs needed for:

- Dashboard metrics and module summaries.
- Issues and findings.
- Fix Cards and recommendations.
- Crawls and crawl history.
- Verification and re-verification.
- Tasks and task lifecycle transitions.
- Employee and team management.
- Role and permission checks.
- Assignment and reallocation history.
- Comments and activity timelines.
- Progress, effort, blockers, and evidence metadata.
- SLA calculations and escalation.
- Notifications and alert status.
- Keyword opportunities.
- Content briefs.
- Competitor and backlink data.
- AI-visibility sampling.
- Custom AI-content checks.
- Reports and exports.
- Integration configuration and connection status.
- Structured audit logs.
- System health and error monitoring.
- SEO thresholds and scoring configuration.

Use well-defined HTTP methods, status codes, request validation, response contracts, and consistent error responses.

Do not introduce endpoints that claim unsupported operations succeeded.

## 9.3 Task and issue services

Implement:

- Validated issue and task state transitions.
- Assignment and reassignment logic.
- Creator and allocation attribution.
- Activity history.
- SLA deadlines and overdue escalation.
- Role/team-based permissions.
- Review and verification workflow.
- Failed verification and regression handling.
- Relationship between issue, Fix Card, task, crawl result, evidence, and verification event.
- Bulk allocation and grouped template issues where supported.
- Automatic task creation when the applicable allocation or escalation rule fires.

Preserve the full allocation trail and produce appropriate notification events.

## 9.4 Crawler and analysis services

Implement service boundaries and working code for the applicable crawler and analysis functions, including:

- HTTP crawling.
- Sitemap discovery and comparison.
- Crawl scheduling logic.
- Raw HTML and JavaScript-rendered analysis as supported by the selected crawler.
- HTTP response analysis.
- Metadata, canonical, redirect, links, images, and schema checks.
- Mobile and rendering checks where supported.
- Technical and on-page finding generation.
- Content and AI-compliance evaluation services.
- Off-page, AEO, GEO, keyword, and opportunity analysis adapters.
- Historical comparison through repository interfaces.
- Severity and page-tier calculations.
- Recommendation generation.
- Evidence collection.
- Re-verification.
- Structured logging and errors.

Make limitations explicit. Do not pretend that every SEO analysis can be performed using HTML crawling alone. Use the appropriate connectors and service interfaces for Search Console, GA4, CrUX, backlink intelligence, AI engines, and Shopify-specific change events.

When credentials are missing, the corresponding connector must return an accurate unavailable/unconfigured state rather than synthetic successful data.

## 9.5 Fix Card and recommendation services

Implement the recommendation pipeline defined in the PDF:

1. Assemble issue context and evidence.
2. Determine affected URLs, template, page tier, and historical recurrence.
3. Infer the likely root cause when evidence supports it.
4. Select a DeoDap/Shopify-specific remediation playbook.
5. Estimate impact, confidence, and effort.
6. Prioritize using the defined formula.
7. Recommend the appropriate owner and team.
8. Record the proposed fix and acceptance criteria.
9. Initiate verification after implementation.
10. Close the issue only when the applicable verification conditions pass.

Keep recommendation generation separate from the connector, crawler, and task-management implementation.

## 9.6 Reports, notifications, and audit logs

Implement the report-generation and notification services for the original daily, weekly, and monthly deliverables.

Implement provider adapters for configured email/WhatsApp/Slack channels and the Task Ops integration where supported.

Record:

- Attempts.
- Delivery outcomes.
- Failures.
- Retryable errors.
- Timestamps.
- Relevant issue/task references.

The application must not claim that an alert, report, or task was externally delivered unless the configured provider confirms the result.

Use structured application logging and useful error diagnostics. Protect secrets and sensitive configuration from log output.

## 9.7 Temporary non-database storage — mandatory

Until database integration is explicitly approved:

- Use repository interfaces.
- Provide a clearly labelled in-memory repository implementation or suitable non-database adapter.
- Seed development examples separately from real connector results.
- Keep business logic independent of the storage mechanism.
- Make data flow through service and repository abstractions.
- Avoid coupling routes/controllers directly to in-memory collections.
- Do not claim data survives process restarts.
- Document the temporary storage limitations.
- Keep the future persistence replacement straightforward without implementing it now.

Do not implement database schema planning as a hidden backend task.

## 9.8 Backend tests

Create unit and API tests for the implemented functionality, including:

- Request validation.
- Authentication and authorization.
- Role and team restrictions.
- Invalid task transitions.
- Valid task transitions.
- Assignment and reallocation.
- SLA calculation and escalation.
- Fix Card generation.
- Severity classification.
- SEO Health Score calculations.
- Issue grouping.
- Verification success and failure.
- Issue reopening on regression.
- Repository behavior.
- Report generation.
- Notification success and failure handling.
- Integration states when credentials are absent.
- API error handling.
- Audit-log generation.

Use deterministic test fixtures. Keep test/sample data clearly distinguished from live external results.

## 9.9 Phase 2 required artifacts

Create and maintain:

### `BACKEND_STATUS.md`

Include:

- Implemented API endpoints.
- Request/response contracts.
- Implemented business logic.
- Permissions enforced server-side.
- Implemented crawlers, checks, and analysis services.
- Fix Card and task workflows.
- Notification and integration adapters.
- Unit and API test results.
- Temporary repository implementation.
- Data-loss-on-restart limitation.
- Integrations requiring credentials.
- Partial or blocked features.
- Remaining acceptance tests.

Update `FEATURE_TRACEABILITY.md` for each backend requirement with actual implementation files and test evidence.

---

# 10. PHASE 2 COMPLETION GATE

Before reporting backend completion, evaluate:

1. The defined APIs exist and are testable.
2. Backend permission checks are enforced.
3. Business logic is separated from temporary storage.
4. Issue/task relationships work correctly.
5. Task transitions, comments, activity, and assignment history work.
6. Fix Cards contain relevant issue context and remediation details.
7. Verification and reopening behavior work.
8. Severity, page tiers, SLAs, and escalation follow the specified rules.
9. Scoring logic follows the PDF.
10. External connectors report accurate statuses.
11. Unavailable credentials are documented rather than simulated as successful.
12. Error handling and structured logging are present.
13. Relevant unit and API tests have been run.
14. `BACKEND_STATUS.md` is accurate.
15. `FEATURE_TRACEABILITY.md` records the true implementation status.
16. Remaining limitations and unimplemented features are explicitly listed.

Do not claim every module is operational merely because its service interface exists.

---

# 11. PHASE 3 — DATABASE INTEGRATION IS FORBIDDEN UNTIL AUTHORIZED

This phase must remain pending.

Do not start it automatically when Phase 2 is complete.

Do not create a database, schema, model, migration, connection, or persistent database infrastructure.

When I explicitly authorize this phase in a later instruction, review the completed frontend/backend architecture and then:

1. Select and document the appropriate database.
2. Design the production data model.
3. Create constraints, indexes, and migrations.
4. Connect the repository interfaces to persistent storage.
5. Preserve API contracts wherever possible.
6. Implement transactions and appropriate concurrency handling.
7. Test data persistence, access controls, task history, crawl history, and verification workflows.
8. Document environment variables, backup, recovery, and deployment.

Until that explicit authorization is received, the database remains out of scope.

---

# 12. GOVERNANCE AND SAFETY GUARDRAILS

Preserve all PDF Section 17 requirements:

- No silent automatic changes to the live site.
- Redirects, metadata rewrites, schema updates, and disavow actions are proposals requiring human approval, except for explicitly configured and approved exceptions allowed by the specification.
- SEO leads can edit relevant thresholds, page tiers, SLA rules, and alert channels without modifying application source code.
- Users can mark a finding as Not an Issue and provide a reason.
- Store exclusions and feedback in the current development adapter as applicable.
- Preserve the evidence behind alerts, tasks, and verification attempts.
- Build monthly reporting from recorded evidence and activity rather than invented summaries.
- Maintain an auditable history of relevant operations.

Do not expose secrets or fabricate external data, API success, verified SEO improvements, or production persistence.

Any optional live-site automation must be separately configurable, disabled by default unless already explicitly approved, and guarded by human authorization.

---

# 13. STRICT FEATURE TRACEABILITY AND NO-OMISSION AUDIT

`FEATURE_TRACEABILITY.md` is a mandatory project deliverable, not optional documentation.

Before declaring the project complete:

1. Re-read the complete original PDF page by page.
2. Compare every section, subsection, table, row, rule, and appendix entry against the implemented project.
3. Compare every custom requirement in this prompt against the actual screens, code, APIs, tests, and workflows.
4. Identify duplicated, conflicting, partial, missing, and blocked requirements.
5. Confirm that user-provided additions have not replaced original PDF functionality.
6. Confirm that the frontend-first/backend-second/database-last order has been followed.
7. Verify that all completion claims are supported by actual implementation or test evidence.

Every requirement must have a traceability result, even if the result is:

- Implemented and tested.
- Implemented but not fully tested.
- Partially implemented.
- Pending.
- Blocked by credentials, access, external subscription, or infrastructure.
- Deferred because it requires explicit database authorization.

Do not omit hard or time-consuming requirements just to make the matrix appear complete.

A module with five implemented checks and two missing checks must not be reported as fully implemented.

A screen with sample data must not be reported as connected to live analytics.

A configured integration page must not be reported as an operational integration without connection evidence.

A Fix Card must not be reported as complete if it lacks the required evidence, fix steps, ownership, or verification conditions.

---

# 14. EXECUTION INSTRUCTIONS

Start working immediately.

Follow this exact operational order:

1. Inspect the existing repository and all project configuration.
2. Read the entire `seotooldocs.pdf`.
3. Build the full feature inventory.
4. Create or update `FEATURE_TRACEABILITY.md`.
5. Inspect and understand the existing application architecture.
6. Implement the complete frontend.
7. Test and fix the frontend.
8. Update `FRONTEND_STATUS.md`.
9. Evaluate the frontend completion gate.
10. Implement the backend only after the frontend gate is evaluated.
11. Test backend APIs, services, workflows, and permissions.
12. Update `BACKEND_STATUS.md`.
13. Update traceability and acceptance-test evidence.
14. Perform a final comparison against the complete PDF.
15. Report actual completion and remaining work.
16. **Stop before database integration and wait for my explicit authorization.**

Do not repeatedly return plans instead of making code changes.

Do not stop after a single screen, a few routes, or a static mockup.

Do not ask me to approve routine UI decisions, component choices, naming conventions, or other implementation details that can reasonably be inferred from the existing repository and this specification.

If execution limits interrupt the work, update the relevant status and traceability files with:

- Exact completed requirements.
- Exact incomplete requirements.
- Files changed.
- Last successful build/test.
- Current errors.
- Next specific action.
- Confirmation that the database phase has not started.

Resume from the last incomplete requirement instead of restarting or generating a replacement plan.

Preserve working code and avoid destructive changes that are not required.

---

# 15. FINAL DELIVERY REPORT

At the end, provide a clear report with:

## A. Frontend

- Screens actually implemented.
- Features and workflows tested.
- Role-specific experiences.
- Build, lint, and type-check results.
- Responsive checks.
- Remaining frontend issues.

## B. Backend

- APIs actually implemented.
- Business logic completed.
- Authorization and role enforcement.
- Crawl and audit functionality implemented.
- Fix Card and task-management functionality.
- Verification and SLA behavior.
- Unit and API test results.
- Temporary in-memory repository limitations.

## C. PDF and custom-requirement coverage

- Total requirements identified.
- Implemented and tested requirements.
- Implemented but untested requirements.
- Partial requirements.
- Missing requirements.
- Blocked requirements.
- Integrations requiring credentials or paid API access.

Use counts only when derived from the actual traceability file.

## D. Project files

Identify:

- `FRONTEND_STATUS.md`.
- `BACKEND_STATUS.md`.
- `FEATURE_TRACEABILITY.md`.
- Other relevant documentation and test artifacts.

## E. Database status

Explicitly confirm:

**No database setup or database integration was performed. Phase 3 remains pending my explicit authorization.**

## FINAL DIRECTIVE

Build the complete DeoDap SEO Sentinel system.

My extra instructions and the complete original PDF must both be satisfied. The screen checklist is not the entire specification. No original requirement may be silently omitted.

**Frontend first. Complete and test it. Backend second. Implement and test it using temporary non-database storage. Database last, only after I explicitly authorize it.**