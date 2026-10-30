# Website sync (Sync Now and Auto Sync)

Crawl the website once with a **Full** or **Smart** crawl. After that, a sync keeps those results current: it finds new,
changed and removed pages and crawls only those. Everything else keeps its stored results.

Where: **Crawl Center → Website sync** (Sync Now, Auto Sync on/off, last and next sync, recent syncs) and the
**Website sync** card on the Dashboard.

## What a sync does

1. **Reads the latest finished crawl** of the website (Full, Smart or an earlier sync). Without one, Sync Now answers
   `409 NO_BASELINE_CRAWL`.
2. **Looks for changes**, cheapest signals first. Each URL is counted once, under the first reason found.

   | Reason | How it is found |
   |---|---|
   | New in the sitemap | A sitemap URL that is not in the stored crawl. Sitemaps are fetched with `If-None-Match` / `If-Modified-Since`, so an unchanged sitemap answers 304 and is not downloaded. |
   | Sitemap date changed | A `<lastmod>` that changed since the last sync (on the first sync: later than the crawl's start). |
   | Removed from the sitemap | A URL that left the sitemap — crawled again so the results show its 404 / redirect. |
   | Updated in Shopify | Products and collections updated since the last sync (when Shopify is connected). |
   | Shopify webhook | Pages a Shopify webhook reported as updated. |
   | Content changed | Stored pages are requested with their ETag / Last-Modified. A 304 means unchanged and nothing is downloaded. Otherwise the page's SEO fingerprint is compared: status, title, meta description, canonical, meta robots, H1, image count and missing alt text, and links in the main content (header, nav and footer links are left out, so a menu change does not flag every page). At most `MONITOR_MAX_CHECKS` pages per sync, least recently checked first, plus the homepage. |
   | New link found | A same-site link on a checked page that the stored crawl does not have (a new product in a collection grid, a new menu item). At most 200 per sync. |
   | Error re-check | A page the check found broken while the stored results still show it working. |
   | Left from the last sync | URLs over the last sync's `SYNC_MAX_URLS` limit. |
   | Not crawled yet (page budget) | URLs the crawl found but did not fetch because its page budget ran out (a Smart crawl of a site larger than 10,000 pages). They fill whatever is left of the sync's limit after the changes above, so the whole site gets covered over the following syncs. |

3. **Crawls only those URLs** (no link following) with the built-in crawler, at most `SYNC_MAX_URLS` per sync.
4. **Merges the results**: each crawled page replaces its row, new pages are added and every other page keeps its row.
   The sync is saved as a crawl of type *Sync* holding the whole, updated result set. Its rows are streamed from disk, so
   memory does not grow with the number of pages. The earlier crawls stay in the crawl history unchanged.
5. **Updates the SEO audit** for the crawled pages only:
   - Page-level checks (HTTP status, redirects, broken links, canonical, schema, Open Graph, breadcrumbs, images,
     answer blocks…) and the on-page checks judged page by page (title, meta description, H1, headings, image alt
     text).
   - An open issue keeps its URLs that were not crawled, gains the crawled URLs that fail, and loses the crawled URLs
     that now pass. It is resolved only when none of its URLs fails any more.
   - A duplicate title, meta description or H1 is checked against every page of the merged results. A crawled page
     whose value another page still shares keeps that issue.
   - Checks that compare whole templates or the site (thin or duplicate content, orphan pages, crawl depth, crawl
     budget, site-wide checks) need every page. The next Full or Smart crawl updates them.

Two syncs never run at once, and a sync does not start while another crawl of the website is running.

## Auto Sync

- Runs every `MONITOR_INTERVAL_MINUTES` (default `720` = 12 hours) when the API server runs with
  `SCHEDULER_ENABLED=true`. The scheduler looks every minute; the next sync is due 12 hours after the later of the last
  sync and the latest crawl. With the scheduler off, the Crawl Center says so and shows no next sync time.
- Turn it on or off per website in the Crawl Center (needs the `crawls.configure` permission). It is on by default.
  `MONITOR_INTERVAL_MINUTES=0` turns it off on the whole server; Sync Now still works.
- The Crawl Center shows the last sync, the next scheduled sync, and the last 20 syncs with their reasons, the pages
  checked and crawled, and new and resolved issues.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_INTERVAL_MINUTES` | `720` | Auto Sync interval; `0` = off on this server |
| `MONITOR_MAX_CHECKS` | `300` | Stored pages checked for changes per sync (conditional requests) |
| `SYNC_MAX_URLS` | `2000` | URLs crawled per sync; the rest go to the next sync |

## API

| Method | Path | Permission | |
|---|---|---|---|
| `GET` | `/api/monitor` | `crawls.view` | Sync status: settings, last and next sync, history, recent changes |
| `POST` | `/api/monitor/run` | `crawls.run` | Sync Now |
| `PATCH` | `/api/monitor/settings` | `crawls.configure` | `{ "autoSync": true \| false }` |

## Limits

- Sync crawls use the built-in Node.js crawler (they fetch a short list of URLs). Full and Smart crawls keep using the
  Go crawler.
- Changes that leave every signal untouched are found only when the page comes up in the rotating check. Examples: body
  text edits on a page whose sitemap date does not change and whose server sends no ETag. With 300 checks per sync and
  two syncs a day, a 3,000-page site is fully re-checked every 5 days. Raise `MONITOR_MAX_CHECKS` to shorten that.
- Template- and site-level checks, and the Change Monitor's crawl-to-crawl comparison, run on Full and Smart crawls only.
