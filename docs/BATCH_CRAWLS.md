# Crawling several websites (batches)

**Crawl several websites** (navigation → Overview, or *All websites* → *Crawl several websites*) starts crawls of up to
**11 websites** with one click. Choose the websites, Smart or Full crawl (and a page limit for Full), then **Start**.

## What happens

- **One crawl job per website.** Each website's crawl is created in that website's own workspace, with its own id,
  progress, page results, issues, findings, errors and Cancel. Nothing is shared or mixed between websites; the batch
  only groups the jobs (`batchId` on each crawl).
- **Every job is stored at once.** All chosen websites get a job immediately — none is dropped. A website that already
  has a crawl running is not crawled twice: the batch follows that crawl (*already running*). A website whose crawl
  cannot be created (for example the crawler is not ready) is listed as **Not started** with the reason.
- **A few run at the same time, the rest queue.** The server runs at most `CRAWLER_MAX_CONCURRENT_JOBS` crawls at once
  (all websites, batches and single crawls together; default **3**). A queued crawl starts automatically, in the order it
  was queued, when a slot is free **and** the memory in use leaves room for another crawl:
  API process + every running crawler / text-core process + `CRAWLER_JOB_RESERVE_MB` (default 90) must stay within the
  memory budget (`CRAWLER_MEMORY_BUDGET_MB`, else 85 % of the container limit), and the API's Node.js heap must have
  room too. One crawl can always run.
- **One analysis at a time.** Fetching happens in each website's own Go crawler process; the analysis after a crawl
  (findings, duplicates, page rows) needs the API's memory, so analyses of different websites run one after another.
- **States:** Running, Queued (with its position and why it waits), Completed, Failed, Cancelled, Not started.
- **Cancel one website** (row button): only that crawl stops — queued ones leave the queue without ever starting, a
  running one stops its workers and requests. **Cancel all remaining** cancels every queued and running crawl of the
  batch. Nothing else is affected.
- **Per-website protections are unchanged:** each crawl requests only its own website (URL restriction), respects that
  site's robots.txt and Crawl-delay, its own rate limiting, retries and Retry-After, and the SSRF guard.
- **Background jobs:** closing the browser does not stop them. With `DATABASE_URL`, queued jobs stay queued across a
  restart / redeploy and start afterwards; a crawl that was running is started again (see `DEPLOYMENT.md`).

## Memory on a ~500 MB service (measured)

`docs/measurements/batch-11-sites.json`: 11 local synthetic stores, built API with a 288 MB Node.js heap and a 435 MB
budget (85 % of 512 MB). Peak = API process + all crawler processes.

| Crawls | Running at once | Pages (all 11) | Time | Peak memory |
| --- | --- | --- | --- | --- |
| Smart, ~900 pages each | 1 | 9,820 | 34 s | 390 MB |
| Smart, ~900 pages each | 2 | 9,820 | 27 s | 382 MB |
| Smart, ~900 pages each | 3 | 9,815 | 28 s | 420 MB |
| Smart, ~900 pages each | 4 | 9,813 | 28 s | 401 MB |
| Full, ~2,700 pages each | 2 | 29,645 | 87 s | 438 MB |
| Full, ~2,700 pages each | 3 | 29,645 | 77 s | 432 MB |

The peak hardly depends on how many crawls run at once (the analyses take turns), so **3** is the default. All 11
websites completed in every run. Very large full crawls (tens of thousands of pages) need more of the API's memory;
the per-crawl memory budget then stops a crawl as *Stopped for memory* instead of letting the server run out. On a
1 GB+ plan raise `NODE_OPTIONS=--max-old-space-size` (about 55 % of RAM) and `CRAWLER_MAX_CONCURRENT_JOBS` (4–6).

## API

`POST /api/crawl-batches` (body `websiteIds` (1–11), `type` smart|full, `maxPages` (full; null = no limit),
`requestDelayMs`; needs `crawls.run`) · `GET /api/crawl-batches` · `GET /api/crawl-batches/:id` ·
`POST /api/crawl-batches/:id/jobs/:websiteId/cancel` · `POST /api/crawl-batches/:id/cancel`. Each website's crawl is
also available as usual under `/api/crawls/:id` with that website's `X-Website-Id`.
