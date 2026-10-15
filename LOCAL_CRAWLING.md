# Running DeoDap SEO Sentinel locally with live crawling

This runs the real API server and the web app on your computer, so the Crawl Center can crawl a real website.
Commands work the same in Windows Command Prompt, PowerShell, macOS and Linux.

> **Results are temporary.** Crawl jobs, results, issues, users and websites are kept in the API server's memory
> only. Stopping or restarting the server erases them. Use **Export CSV / Export JSON** on a crawl to keep a copy.
> There is no database.

## 1. Requirements

- Node.js **20.12 or newer** (Node 22 LTS recommended) — `node -v`
- npm (comes with Node)

## 2. Install

From the project folder (the one containing `package.json` and `apps/`):

```bash
npm ci
```

## 3. Configure the API

Copy the local template to `apps/api/.env`:

| Shell | Command |
| --- | --- |
| Windows Command Prompt | `copy apps\api\local-crawl.env.example apps\api\.env` |
| PowerShell | `Copy-Item apps/api/local-crawl.env.example apps/api/.env` |
| macOS / Linux | `cp apps/api/local-crawl.env.example apps/api/.env` |

Open `apps/api/.env` in a text editor and fill in:

- `ADMIN_EMAIL` — any email address you will sign in with, e.g. `you@example.com`
- `ADMIN_INITIAL_PASSWORD` — at least 10 characters with letters and numbers (a new password, not one you use elsewhere)
- `CRAWLER_BASE_URL` — the website to crawl (default `https://deodap.in`)

`apps/api/.env` stays on your computer: `.env` files are excluded from the ZIP and ignored by Git.

What the template sets (all variables are documented in `apps/api/.env.example`):

| Variable | Local value | Meaning |
| --- | --- | --- |
| `SEED_DEMO_DATA` | `false` | Clean start — no DEMO data mixed with crawl results |
| `CRAWLER_ALLOW_LIVE` | `true` | Allows crawling a real (non-localhost) website. Off by default everywhere else |
| `SCHEDULER_ENABLED` | `false` | Nothing is crawled automatically — every crawl starts from the Start crawl button |
| `CRAWLER_REQUEST_DELAY_MS` | `250` | Minimum gap between requests to the site |
| `CRAWLER_MAX_BODY_BYTES` | `5242880` | Largest page body read (5 MB); bigger pages are truncated |
| `CRAWLER_MAX_CONCURRENT_JOBS` | `2` | Crawls that may run at the same time on the server |
| `CRAWLER_RETRIES` | `2` | Retries after 429 / 502 / 503 / 504, a timeout or a dropped connection |
| `CRAWLER_MAX_SITEMAP_FILES` | `1000` | Most sitemap files read (sitemap index files included) |
| `CRAWLER_MAX_SITEMAP_MB` | `50` | Largest sitemap file read, after unzipping (the sitemaps.org limit is 50 MB) |

## 4. Start

Open **two terminals** in the project folder.

Terminal 1 — API server (port 4000):

```bash
npm run dev:api:env
```

Wait for `DeoDap SEO Sentinel API listening on :4000`.

Terminal 2 — web app (port 5173, talks to the API):

```bash
npm run dev:web:http
```

Open <http://localhost:5173> and sign in with your `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD`.

> `npm run dev:web` (without `:http`) starts the in-browser DEMO version instead. It cannot crawl websites.

## 5. Crawl

1. Go to **SEO operations → Crawl Center**.
2. **Crawl a website**: the start URL is filled with your website. Adjust if needed:
   - **Start URL** — any page on the selected website (other hosts are refused).
   - **Maximum pages** — **All pages (no limit)** is selected by default: every page found through links and the
     sitemap is fetched, however many the site has. Untick it to set a number instead (useful for a quick test, e.g. 50).
   - **Crawl depth** — **No depth limit** by default. Untick it to follow links only a set number of steps from the
     start URL (0 = start URL only). Sitemap URLs are always included.
   - **Request timeout** — per request, 2–60 seconds.
   - **Delay between requests** — minimum gap between requests to the site (0–10,000 ms; default from
     `CRAWLER_REQUEST_DELAY_MS`). The crawler raises it by itself when the site asks (see below).
   - **Concurrency** — parallel requests, 1–8.
3. Press **Start crawl**. Progress (discovered / processed / successful / errors, pages per minute, pages found and
   waiting) refreshes every 2 seconds. After the last page is fetched the panel shows **Analysing** and then
   **Saving** — on a very large crawl these steps take a few minutes.
   **Cancel crawl** stops all requests; the pages fetched so far stay viewable, and no issues are created from a
   partial crawl.
4. Open **View results**:
   - **Pages** — every URL with status, indexability, issues and links; filter by status, indexability or problem
     (broken links, missing / duplicate titles and meta descriptions, H1 problems, images without alt text, not
     indexable) and search by URL or title. Select a row for full details.
   - **Issues** — tracked issues found in this crawl, each linked to its Fix Card (explanation and suggested fix).
   - **Export CSV / Export JSON** — download the current results.

To crawl another website, add it under **Website management → Manage websites**, select it in the website switcher,
then use the Crawl Center. Each website's crawl is restricted to its own host.

## What the crawler does

- **Finds the site's real address first.** If the address you enter redirects (for example `http://www.example.com`
  → `https://example.com/`), the crawl uses the final address, and links to either the www or non-www form count as
  the same website. Links to the other form are fetched once and reported as redirects. An address that redirects to a
  different website is refused with a message.
- **Polite and resilient over long runs.** Requests that fail with 429, 502, 503, 504, a timeout or a dropped
  connection are retried up to `CRAWLER_RETRIES` times with increasing waits, following the site's `Retry-After`. When
  the site answers 429 / 503 the gap between requests is widened, then narrowed again after a run of normal answers.
  The robots.txt `Crawl-delay` for the crawler (or `*`) is honoured, capped at `CRAWLER_MAX_CRAWL_DELAY_MS`. A page
  still failing after its retries is recorded as failed. Links to other websites are checked once, without retries.
  The progress panel shows the current gap, the Crawl-delay, retries and slow-downs.

- Reads `robots.txt` and respects it; discovers pages from the sitemap (declared in robots.txt or `/sitemap.xml`)
  and from internal links (same host, www/non-www both accepted).
- **Sitemaps of any size:** sitemap index files are followed (up to `CRAWLER_MAX_SITEMAP_FILES` files, read 4 at a
  time), files up to `CRAWLER_MAX_SITEMAP_MB` are read in full, and gzip sitemaps (`.xml.gz`) are unzipped. A file
  larger than the limit is read up to the limit and marked as cut off.
- **Link discovery:** breadth-first from the start URL, so each page's recorded depth is its shortest click path.
  Plain pagination links (`?page=2`, `?page=3` …) are followed, so products listed only on later pages are found
  even without a sitemap. Sitemap pages that no link reaches are fetched too, and — when no depth limit is set — the
  links on them are followed as well.
- **No endless crawls:** each distinct URL is fetched once (URLs are normalised before comparing), and links that look
  like a crawl trap are not followed: URLs longer than 2,048 characters, more than 25 path segments, the same path
  segment repeated 3 or more times (e.g. `/a/b/a/b/a`, typical of a broken relative link), or `?page=` above 10,000.
  Their count appears in the crawl's scope as "Links not followed (likely crawl traps …)".
- Fetches pages with real HTTP requests (raw HTML — JavaScript is not executed, so content that only appears
  after JavaScript runs is not seen).
- Checks HTTP status, redirect chains and loops, titles, meta descriptions, H1/H2, canonical tags, meta robots and
  `X-Robots-Tag`, indexability, internal links and broken links, image alt text, duplicate titles and meta
  descriptions, plus the rest of Sentinel's technical, on-page, content, schema, AEO/GEO checks.
- Findings become tracked issues with severity, affected URLs and a Fix Card.
- Normalises and deduplicates URLs and skips query-string (filter / sort — except plain `?page=N`), cart / account and
  non-HTML URLs, so even an "All pages" crawl always ends: every distinct page is fetched once. A page cap or depth
  limit, when you set one, stops it earlier.
- **Large sites:** see [Crawling 50,000+ pages](#crawling-50000-pages) below. To cap crawls on a small server, set
  `CRAWLER_MAX_PAGES` in `apps/api/.env`.
- Timeouts, failed requests, malformed HTML and missing sitemaps are recorded per URL; they do not stop the crawl.

## Crawling 50,000+ pages

The crawler has no page limit, and every step after fetching (link checks, analysis, issue tracking, result storage)
grows in proportion to the number of pages, so a single run can cover 50,000 pages or more. Two things decide whether
a run of that size completes on your computer: **time** and **memory**.

**Time.** Requests to the site are spaced by the delay between requests, whatever the concurrency:

| Delay between requests | Fastest possible rate | 50,000 pages take at least |
| --- | --- | --- |
| 250 ms (default) | 4 pages / s | about 3.5 hours |
| 100 ms | 10 pages / s | about 1.5 hours |
| 0 ms, concurrency 8 | limited by the site's response time (e.g. 0.5 s → ~16 pages / s) | about 1 hour |

The site's robots.txt `Crawl-delay` and its 429 / 503 answers slow the crawl further — that is intended. Only lower
the delay for a site you own and whose server can take the load.

**Memory.** All pages stay in the API server's memory until the crawl is analysed. Node.js normally limits its memory
to about 2–4 GB, which may not be enough for 50,000 pages. Start the API with a larger limit (8 GB below; use a value
below your computer's free RAM):

```bash
npm run build -w @sentinel/api     # once, after each code change
npm run start:api:large            # API with an 8 GB memory limit, reading apps/api/.env
```

Then start the web app as usual (`npm run dev:web:http`). Alternatively set the limit for `npm run dev:api:env`:

| Shell | Command |
| --- | --- |
| Windows Command Prompt | `set NODE_OPTIONS=--max-old-space-size=8192` then `npm run dev:api:env` |
| PowerShell | `$env:NODE_OPTIONS="--max-old-space-size=8192"; npm run dev:api:env` |
| macOS / Linux | `NODE_OPTIONS=--max-old-space-size=8192 npm run dev:api:env` |

If memory still runs low, the crawl does not crash the server: it stops taking new pages at 80 % of the limit,
analyses what it has, and says so in the crawl result. Memory use per page depends on the site (page size, number of
links), so measure on your own site: watch the API process in Task Manager / Activity Monitor during a capped run
(e.g. 5,000 pages) and scale up.

**Results.** The Pages table loads all rows of a crawl into the browser and shows 25 per page; filtering and search
work on all of them. **Export CSV / Export JSON** downloads every row. Results stay in memory until the API stops
(several 50,000-page crawls in one session add up — restart the API between very large test runs if memory is tight).

**Suggested test sequence:**

1. A capped crawl (Maximum pages 500) to check the setup and the speed in pages per minute.
2. A capped crawl of 5,000 pages, watching the API's memory.
3. An all-pages crawl started with `npm run start:api:large`.

## Security

- **SSRF protection:** every request — including each redirect hop — is checked. Hosts that are or resolve to
  localhost, private networks (10/8, 172.16/12, 192.168/16, fc00::/7), link-local and cloud metadata
  (169.254.169.254), carrier-grade NAT, multicast or reserved addresses are refused. The check is repeated when the
  connection is opened, so a DNS answer that changes in between is also refused.
- Only `http` and `https` URLs without embedded credentials.
- Throttling (`CRAWLER_REQUEST_DELAY_MS`), per-request timeout, response-size cap, concurrency limits per crawl and
  per server, and cancellation that aborts in-flight requests.
- No secrets are needed for crawling, and nothing server-side is exposed to the browser.

## Tests

```bash
npm test            # all packages (API, shared, web)
npm run typecheck
npm run lint
npm run build:prod  # production build of web (http mode) + API
```

The crawler tests run against a local fixture website started by the tests themselves, or against simulated sites
inside the test process (no internet needed).

An optional synthetic stress test of the analysis pipeline (no network; a simulated site inside the test process) is
skipped by default. Run it with, for example, `STRESS_PAGES=20000` set in the environment:
`npx vitest run test/stress.test.ts` from `apps/api`.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `CRAWLER_ALLOW_LIVE is not "true"` | Set `CRAWLER_ALLOW_LIVE=true` in `apps/api/.env` and restart the API |
| `CRAWLER_BASE_URL is not set` | The API was started without it. Locally: copy `apps/api/local-crawl.env.example` (not `.env.example`) to `apps/api/.env`, keep `CRAWLER_BASE_URL=https://deodap.in`, and start the API with `npm run dev:api:env` (plain `npm run dev:api` does not read `.env`). On Render: add `CRAWLER_BASE_URL` under Environment — see DEPLOYMENT.md |
| `Invalid environment configuration: CRAWLER_BASE_URL` | Use the full address with `https://`, e.g. `https://deodap.in` — no quotes, no user name or password |
| `This website holds the labelled DEMO dataset` | Use `SEED_DEMO_DATA=false`, or add the site under Manage websites |
| `Refusing to crawl …: blocked: … resolves to …` | The site resolves to a private / internal address — such sites are never crawled |
| `Could not reach the API server` | Terminal 1 is not running, or not on port 4000 |
| `ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD must be set together` | Fill in both in `apps/api/.env` |
| `ADMIN_INITIAL_PASSWORD is too weak` | Use at least 10 characters with letters and numbers |
| `node: bad option: --env-file` | Update Node.js to 20.12 or newer |
