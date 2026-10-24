# Image Audit

Smart and Full crawls do **not** request images. They read every `<img>` from the HTML they already fetched — address,
ALT text, `width` / `height` attributes, `loading`, main content or not — so missing / empty ALT text is found without
any image request and stays in the page audit (All pages) and on the Issues Board (`ONP-IMAGES`). Width / height and
lazy-loading problems are still reported by `PERF-IMAGES` from the HTML. A crawl never waits for image checks.

Whether the images load, their HTTP status, redirects, format, file size and pixel size are checked by an **Image
Audit**, which runs only when you start it (**Image Audit** in the navigation, or the card in the Crawl Center).

## What it does

1. **Collect** — reads the chosen crawl's image references (`images.ndjson.gz`, written with the crawl's results) and
   deduplicates the image URLs (fragment removed, scheme / host lower-cased). `data:` images are counted, not checked.
2. **Reuse** — an image URL the crawl's own link check already answered with a 4xx is reported as broken from that
   answer; when you audit the same crawl again, images that were available or broken are taken over (marked *reused*).
   They are not requested again.
3. **Check** — the rest go to the Go crawler binary in its `images` mode (a separate process, so a long audit never
   blocks a crawl). Each unique image is requested **once**, most-shown first:
   - one `GET` with `Range: bytes=0-65535`: at most 64 KB are read — enough for the format and pixel size (PNG, JPEG,
     GIF, WebP, AVIF / HEIF, BMP, SVG). The file size comes from `Content-Range` / `Content-Length`; a server that
     ignores `Range` is cut off after 64 KB. A whole image file is never downloaded;
   - redirects are followed hop by hop, each hop re-checked by the SSRF guard (no private, loopback or link-local
     addresses, only http / https);
   - robots.txt of the image's host is read once and respected; the website's `Crawl-delay` applies;
   - the website's own host keeps the crawl's pace (`CRAWLER_REQUEST_DELAY_MS`); other hosts get a 150 ms per-host gap;
   - 429 / 503 slow the host down, `Retry-After` is honoured (up to `CRAWLER_MAX_RETRY_WAIT_MS`) and the request is
     retried `CRAWLER_RETRIES` times;
   - timeouts per request (`requestTimeoutMs` of the crawl settings); `IMAGE_AUDIT_CONCURRENCY` images at once (4);
   - only the website and image CDNs (cdn.shopify.com, imgix, Cloudinary, CloudFront, `cdn.*`) are requested.
4. **Rounds until done** — one checker process runs for at most `IMAGE_AUDIT_BUDGET_MINUTES` (10). The images it did
   not reach stay *pending* and the next round checks them — only them — so the audit continues until every image has
   an answer (at most `IMAGE_AUDIT_MAX_HOURS`, 12; then it stops as *Partly done* and can be resumed). An image answered
   *rate limited* (429 / 503 after the retries) is tried again after a pause (`IMAGE_AUDIT_RATE_LIMIT_PAUSE_SECONDS`, 60;
   a longer Retry-After is honoured up to 15 minutes), at most `IMAGE_AUDIT_RATE_LIMIT_ROUNDS` (3) rounds; after that it
   stays *unverified*.
5. **Checkpoints** — every `IMAGE_AUDIT_CHECKPOINT_SECONDS` (10) and after each round the answers so far are stored.
   With `DATABASE_URL` they are stored in PostgreSQL (`sentinel_files`: one compressed snapshot of every image, then
   small files with only the images answered since), so an audit running during a restart or redeploy **continues
   afterwards** and never requests an image already answered (on `SIGTERM` the last answers are stored before the
   process exits; after a crash at most the last few seconds of answers are lost and those images are asked again).
   Without a database the checkpoint is the server's memory: Resume works until the server restarts, not after.
6. **Resume** — a cancelled, stopped or failed audit shows **Resume (N left)**: it checks only the images still pending or
   deferred. Answered images are never requested again.
7. **Report** — results stream in while it runs (progress, counts, the list). It runs on the server: closing the page
   does not stop it. Cancel at any time.

**No repeated requests.** Within an audit each unique image is requested once. A new audit takes over *available* and
*broken* answers of earlier audits — of the same crawl at any age, of other crawls of the website from the last
`IMAGE_AUDIT_REUSE_HOURS` (24) — and the crawl's own 4xx link answers (marked *reused*).

**Progress** counts images with a final answer (available, broken, failed, unverified). It shows **100 %** only when no
image is pending or deferred. At most `IMAGE_AUDIT_MAX_CONCURRENT` (2) audits run on the server at once (all websites).

## Results

| Result | Meaning |
| --- | --- |
| Available | answered 2xx with image content |
| Broken | 4xx (not 429), a redirect loop / too many redirects, or a 2xx that is not an image (e.g. an HTML error page) |
| Failed (inaccessible) | 5xx, timeout, network or TLS error — may be temporary |
| Unverified | not requested: robots.txt disallows it or could not be read, still rate limited after the retries, or a third-party host |
| Deferred | not checked yet: the audit was cancelled or stopped (time limit, checker failure) — **Resume** checks these |
| Pending | waiting while the audit runs |

**An image is never shown as available without an actual answer.** Problems per image, each with what to do: broken,
could not be loaded, ALT missing, empty ALT (fine only for decorative images), no width / height, below the fold without
`loading="lazy"`, heavy file (over the `imageMaxKb` threshold, 200 KB), legacy format (JPEG / PNG / GIF although
WebP / AVIF were accepted), much larger than displayed (pixel width ≥ 2× the HTML width), redirects, the same file
under several URLs (same host + path, different query strings), repeated on the same page. Each image lists the pages
that show it (first 5, with a link to their page report) and the number of pages and references.

Filters: result, problem, search (image URL, page URL, ALT text); sort by pages, size, URL or result. **CSV / JSON**
export of the filtered list (streamed).

## Limits and storage

- One audit at a time per website; up to `IMAGE_AUDIT_MAX_IMAGES` (50,000) unique images — references to further images
  are counted and shown, not checked.
- The last 5 audits per website are kept: in PostgreSQL with `DATABASE_URL` (kept across restarts), otherwise in the API's
  memory (lost on a restart). The image references are stored with the crawl's results (`CRAWLER_KEEP_RESULTS` most
  recent crawls; in PostgreSQL too), so a recent crawl can be audited after a restart; an older crawl cannot.
- Needs the Go crawler binary (included in the Docker image). The browser-only demo cannot run it.
- Pixel size is unknown when the image header is beyond the first 64 KB (e.g. a JPEG with a large EXIF block).

## API

`GET /api/image-audits/status` · `POST /api/image-audits` (body `runId`; needs `crawls.run`) ·
`GET /api/image-audits/:id` · `POST /api/image-audits/:id/cancel` · `POST /api/image-audits/:id/resume` (`crawls.run`) ·
`GET /api/image-audits/:id/images?state&issue&q&sort&dir&offset&limit` ·
`GET /api/image-audits/:id/export?format=csv|json&…filters`. All need sign-in and `crawls.view`.
