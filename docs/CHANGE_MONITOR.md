# Change Monitor, visual comparison and code differences

What changed on the website between two crawls, how each page looks now compared with before, and what differs in its
rendered HTML, its public CSS / JS and (with an authorised Shopify connection) its theme source. No database: everything
is kept as compact files on disk.

## Where to find it

| Screen | What it shows |
| --- | --- |
| Crawl Center → **Change Monitor** | the baseline, what each recorded crawl changed, where the history is kept and how long |
| Crawl run → **Changes** tab | every URL of that crawl compared with the baseline: search, filters (type, field, evidence), server-side pages of 50, CSV / JSON export of the filtered list; a row opens old / new values, evidence, observation times and the open issues on that page |
| Crawl Center → **Compare page versions** (`/crawls/compare?url=…`) | screenshots (desktop / mobile) previous vs current and a pixel-difference image; rendered HTML diff; SEO fields of the rendered page; CSS / JS files that changed; theme source (Shopify) |

## How a crawl is compared

The **baseline** is the last valid crawl, one record per URL:

| This crawl | Compared? | Effect on the baseline |
| --- | --- | --- |
| completed **full** crawl | yes | **replaces** it. URLs that failed this time (5xx, 429, timeout) or were not fetched keep their last good record |
| completed **smart** crawl | yes | the URLs it fetched are **updated** in the baseline; all others keep their earlier data |
| **partial**, **cancelled**, **resource-stopped** crawl | yes | **never** changes it — URLs it did not reach are *unchecked*, never *removed* |
| failed crawl, re-verification | no | none |
| first valid crawl | no (nothing to compare with) | **becomes** the baseline |

Every URL gets one of these:

| Type | Meaning | Confidence |
| --- | --- | --- |
| **changed** | fetched both times; at least one field differs | confirmed; *suspected* when a response was cut at the size limit |
| **new** | not in the baseline | confirmed when fetched; *suspected* when only found, not fetched |
| **removed** | answered 404 / 410 now | confirmed |
| **removed** | missing from a *complete full* crawl (no link or sitemap entry led to it) — it was not requested | *suspected* |
| **failed** | 5xx, 429, timeout or network error now | a failure is **never** treated as a removal |
| **unchecked** | in the baseline, not fetched this time (partial / smart crawl, excluded, limit reached) | — |
| **unchanged** | fetched both times, same fields | confirmed |

Fields compared (old and new value shown for each): HTTP status, redirect target, title, meta description, H1, H2, H3,
canonical, indexability (meta robots, X-Robots-Tag, robots.txt), main content (hash of the whole text; the first 600
characters are kept to show), internal links (hash of all; added / removed list of the first 150), images and alt text,
structured data (JSON-LD types and content), CSS / JS assets (with "new version of …" when only the `?v=` query changed).
Each change record carries the URL, when this crawl and the baseline observed it, both statuses, the evidence in words,
and — in the detail view — the open issues on that URL.

## Visual comparison (screenshots)

- A real headless Chromium (Playwright, `apps/api/runtime/capture-runner.mjs`) runs **in its own process**, one browser
  at a time for the whole server (shared with Lighthouse), 1–2 pages at once (`CHANGE_CAPTURE_CONCURRENCY`).
- Before it starts, the free memory inside the crawl memory budget is checked (`CHANGE_CAPTURE_MIN_FREE_MB`, default
  300 MB); below it the job is refused with the numbers, not started.
- Captures are taken only for **selected or changed pages**, never for every URL: on request (Compare page, or
  *Capture screenshots* in a change record), and after each crawl for the **watched pages** (default: the homepage) plus
  the most important changed pages (`CHANGE_CAPTURE_CHANGED_PAGES`, default 5).
- Desktop is 1366 px wide, mobile 390 px (touch, mobile user agent flag). Pages are cut at `CHANGE_CAPTURE_MAX_HEIGHT`
  (default 6000 px) and the cut is shown.
- The pixel-difference image is made when a capture is taken, against the capture just before it of the same page and
  viewport. Other pairs are shown side by side.
- **A previous screenshot is never made up.** With one capture the "Previous" side says that no earlier screenshot
  exists; with none, every view says why it is empty. A first capture becomes the "before" of the next change — this is
  why watched pages are captured after every crawl.
- The browser may load the page's own third-party resources (as any browser does); requests to private, loopback and
  link-local addresses are blocked. Only URLs of the selected website can be captured.

## HTML and code differences

| View | Source of each version | Note shown |
| --- | --- | --- |
| Rendered HTML | the DOM Chromium built at each capture (time shown) | inline script / style bodies are reduced to size + hash; nonces / tokens removed. A DOM difference does **not** prove that the theme code changed — apps, content, settings, prices and scripts change the DOM too |
| SEO fields | title, meta description, H1, canonical, meta robots of each rendered capture; plus the crawler's raw-HTML comparison | — |
| CSS / JS | the stylesheet and script files of the website and its CDN (`CHANGE_CAPTURE_ASSET_HOSTS`, default `cdn.shopify.com`) the browser actually downloaded at each capture (≤ 25 files, ≤ 1.5 MB each) | minified files are re-flowed one rule / statement per line; they are public files, not the theme source |
| Theme source | Shopify Admin API through the authorised connection (`read_themes`), read-only snapshots of text files (layout, templates, sections, snippets, blocks, config, locales, text assets; ≤ 512 KB each, ≤ 1500 files) | compare two snapshots of one theme over time, or two themes (e.g. live vs a draft copy). The viewer cannot edit or publish theme code; theme changes go through the separate, confirmed proposal flow of the SEO editor |

## Storage, retention and Render

```
<CHANGE_SNAPSHOT_DIR>/<website host>/
  index.json                         recorded crawls, baseline pointer, format version
  baseline-<snapshot>.ndjson.gz      the baseline (one compact record per URL)
  runs/<snapshot>.snap.ndjson.gz     each crawl's snapshot
  runs/<snapshot>.notable.ndjson.gz  its new / removed / failed / changed URLs
  runs/<snapshot>.quiet.ndjson.gz    its unchanged / unchecked URLs
  captures/                          screenshots, rendered HTML, diff images, CSS / JS (content-addressed)
  themes/                            theme source snapshots (content-addressed)
```

Files are written incrementally (streamed gzip NDJSON), under a temporary name, then renamed; `index.json` is written
last, so a crash leaves the previous state intact. Retention: `CHANGE_SNAPSHOT_KEEP` crawls (default 5) and
`CHANGE_SNAPSHOT_MAX_AGE_DAYS` (default 90) — the baseline is always kept; `CHANGE_CAPTURE_KEEP` captures per page and
viewport (default 3), `CHANGE_CAPTURE_MAX_PAGES` pages (default 200); 20 theme snapshots. Unreferenced files are deleted.

> **Render's filesystem is ephemeral.** By default the history is kept in the system temp folder and is **lost on every
> restart and redeploy** (the screen says so). To keep it, add a Render **persistent disk** (paid plans), mount it, for
> example at `/var/data`, and set `CHANGE_SNAPSHOT_DIR=/var/data/sentinel-changes`. A missing or deleted baseline file
> is handled as "no baseline yet": the next completed crawl starts a new one.

Disk use measured (synthetic store): a 53,491-URL crawl snapshot ≈ 10 MB, so ≈ 20 MB after the first crawl (snapshot +
baseline) and ≈ 31 MB after the second (plus its change lists); a 106,966-URL crawl ≈ 40 MB after the first crawl. Comparing
53,000 URLs took 5–12 s after the crawl finished. Measurements: `BACKEND_STATUS.md` §3.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `CHANGE_MONITOR_ENABLED` | `true` | compare crawls and keep snapshots |
| `CHANGE_SNAPSHOT_DIR` | `<tmp>/sentinel-changes` | storage folder (point it at a persistent disk) |
| `CHANGE_SNAPSHOT_KEEP` / `CHANGE_SNAPSHOT_MAX_AGE_DAYS` | `5` / `90` | retention of recorded crawls |
| `CHANGE_CAPTURE_ENABLED` | `true` | screenshots (need Chromium: Docker `--build-arg INSTALL_CHROMIUM=true`, ≥ 1 GB RAM) |
| `CHANGE_CAPTURE_AFTER_CRAWL` | on (off in tests) | capture watched + changed pages after each crawl |
| `CHANGE_CAPTURE_CHANGED_PAGES` | `5` | changed pages captured after a crawl |
| `CHANGE_CAPTURE_VIEWPORTS` | `desktop` | after-crawl viewports: `desktop`, `mobile` or both |
| `CHANGE_CAPTURE_KEEP` / `CHANGE_CAPTURE_MAX_PAGES` | `3` / `200` | capture retention |
| `CHANGE_CAPTURE_MAX_HEIGHT` | `6000` | screenshot height limit (px) |
| `CHANGE_CAPTURE_CONCURRENCY` | `1` | pages at once in the one browser (max 2) |
| `CHANGE_CAPTURE_MIN_FREE_MB` | `300` | free memory a capture job needs |
| `CHANGE_CAPTURE_TIMEOUT_MS` | `45000` | per page |
| `CHANGE_CAPTURE_ASSET_HOSTS` | `cdn.shopify.com` | hosts besides the website whose CSS / JS are kept |
| `LIGHTHOUSE_CHROME_PATH`, `LIGHTHOUSE_CHROME_FLAGS` | auto | the Chromium used (shared with Lighthouse) |

On a 512 MB Render plan without Chromium the Change Monitor (crawl comparison) works; screenshots report "not available
on this server" with the reason.

## API

`GET /api/changes/status` · `GET /api/changes/runs/:id` (`latest`, crawl id or snapshot id) ·
`GET /api/changes/runs/:id/urls?kind&field&confidence&q&template&page&pageSize` (≤ 200 per page) ·
`GET /api/changes/runs/:id/url?url=` · `GET /api/changes/runs/:id/export?format=csv|json&…filters` (streamed) ·
`POST /api/changes/issues` · `GET /api/changes/captures/status` · `POST /api/changes/captures` ·
`GET /api/changes/captures/jobs/:id` · `PUT /api/changes/captures/watch` · `GET /api/changes/captures?url=` ·
`GET /api/changes/captures/pages` · `GET /api/changes/captures/:id/image|diff|html` ·
`GET /api/changes/compare?url&viewport&from&to` · `GET /api/changes/compare/asset?url&from&to&key` ·
`POST|GET /api/shopify/theme-snapshots` · `GET /api/shopify/theme-snapshots/diff?from&to&file`.
All require sign-in; captures need `crawls.run`, the watch list `crawls.configure`, theme source `shopify.theme`.
