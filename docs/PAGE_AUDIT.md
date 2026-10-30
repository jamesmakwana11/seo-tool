# All pages and the page audit

Every URL of a crawl with an audit score, a site-wide to-do list, and a report per page that says what was found and
what to change. Everything comes from what the crawler read in that crawl — nothing is estimated.

## Where to find it

| Screen | What it shows |
| --- | --- |
| **All pages** (`/pages`) | crawl picker; site average score and average per template; pages per score band (click to filter); the to-do list — every failing check with its number of pages (click to list them); the page list with a Score column, search, filters, sort by score; **Export CSV** |
| Page list row → drawer | the page's problems with recommendations and a link to the full report |
| **Page report** (`/pages/report?run=&url=`) | score; every check grouped by element with the value found and what to do; what the crawler read; heading outline; other pages with the same title / meta description; issues on the page; the latest Change Monitor record; **Fix in SEO editor** (products, collections, pages, articles — needs `shopify.edit`) and **Compare versions** |

## Score

Each audited page starts at 100: **−15** per check to fix (fail), **−5** per check to improve (warning). Poor < 50,
fair 50–79, good ≥ 80. A page that answered 4xx / 5xx or not at all scores 0. Redirects, files that are not HTML,
URLs blocked by robots.txt and URLs the crawl did not fetch are **not scored** (shown as "—") and are left out of the
averages. Length limits come from Settings → Thresholds (defaults: title 30–60, meta description 70–160 characters,
thin content under 150 words, slow response over 2 s).

## Checks

| Element | Checks (fail = to fix, warn = to improve, info = note) |
| --- | --- |
| Response | no response (fail), 4xx / 5xx (fail), redirect (warn), slow response (warn) |
| Title | missing (fail), too long / too short (warn), same as other pages (warn), several `<title>` tags (warn) |
| Meta description | missing (fail), too long / too short (warn), same as other pages (warn), several tags (warn) |
| Headings | no H1 (fail), several H1s (warn), empty H1 (warn), same H1 as other pages (warn), no H2 on a long product / collection / article (warn), skipped levels with the headings listed (warn), H2 / H3 counts (info) |
| Canonical | conflicting canonical tags (fail), none (warn), points to another URL (info), self-referencing (pass) |
| Indexability | noindex but listed in the sitemap (fail), noindex (info), page links set to nofollow (warn), not in the sitemap (info) |
| Content | thin content (warn) with the word count and words unique to the page |
| Links | broken internal links, listed (fail), no internal links (warn), nothing links here (warn), internal links with rel="nofollow" (warn), links to other websites (info) |
| Images | images without ALT text, with every image address (fail when ≥ 3 or all, else warn); the same image shown more than once on this page (warn) — the same image on several different pages is not flagged |

Duplicate titles, descriptions and H1s are worked out over the whole crawl (pages answering 200).

**Details of every finding.** In the page drawer (All pages) and the page report each finding opens (*Details*, or
*Expand all details*) to show, without leaving the report: the affected page; the detected values (title / description
text with its character count and the recommended range, the H1s, response time, word count, redirect target, error,
indexability reason, canonical); for duplicates the shared text, **every** other page with it (each opens its page
report; copy all) and the exact count; images without ALT with a preview of each; each image repeated on the page with a
preview, how many times, and every copy with its position, HTML location (landmark › Shopify section › theme component,
e.g. `footer › section "footer" › .footer__payment`), ALT and loading; broken links as source page → destination, HTTP
status and error type; and how many pages of the crawl have the same finding, linked to that list. What a crawl did not
record says *could not be identified* — crawls made before 24 Oct 2026 have no image list, repeated-image locations or
link statuses, so they show that until the website is crawled again. Duplicate lists are complete up to 10,000 other
pages (the count is always exact); a page keeps up to 500 broken links. The CSV / JSON export
has `audit_score` and `audit_to_do` columns for every URL.

## Measured cost (synthetic store, 25,000 products, 53,491 URLs, 256 MB Node heap)

| | Before the extra page details | After |
| --- | --- | --- |
| Whole crawl | 105 s | 109–111 s |
| Peak API memory (RSS / heap) | 304 / 161 MB | 308 / 160 MB |
| CSV export of 53,492 rows | 1.25 s, 39.1 MB | 1.0 s, 39.6 MB |
| To-do filter / sort by score | — | 36 ms / 27 ms |
| Page report (incl. same-title / meta lookup) | — | 35–59 ms |

Files: `docs/measurements/go-crawl-25k-before-page-audit-details.json`, `docs/measurements/go-crawl-25k-page-audit.json`.

## Limits

- Results of a crawl live in the server's temporary folder and memory (no database): after a restart, crawls run
  before it have no page list until the next crawl.
- The report shows the page as the crawler fetched it (raw HTML). Content added later by JavaScript is not audited.
- Up to 20 broken links and 5 images without ALT text are listed per page (the counts are complete).
- Sample crawls (test fixtures) carry few page fields, so most checks cannot be judged there.

## API

`GET /api/crawls/:id/pages?score=poor|fair|good|none&check=<id>&sort=score` (plus the existing filters) — rows carry
`auditScore` and `auditTodo`; the response has `facets.score`, `facets.check`, `scoreSummary` and `auditLimits`.
`GET /api/crawls/:id/page?url=` (`id` may be `latest`) — the page report, with `duplicates.title / meta / h1`
(`text`, every other page in `urls`, exact `total`). `GET /api/changes/for-url?url=` — latest change
record of a URL. All need sign-in and `crawls.view`.
