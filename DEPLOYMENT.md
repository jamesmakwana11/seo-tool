# Deploying DeoDap SEO Sentinel

One container runs everything: the Express API serves the built React app from the same origin, runs the crawler and
(optionally) the in-process scheduler. HTTPS is terminated by the hosting platform.

> **Storage: PostgreSQL.** With `DATABASE_URL` set, websites, crawls, page results, issues, findings, Health Score inputs,
> settings, users and sessions are stored in PostgreSQL and survive restarts and redeploys (see
> [PostgreSQL on Render](#postgresql-on-render) and `docs/DATABASE.md`). Without it, everything is kept in memory and
> lost on every restart; in production the server then refuses to start unless `ALLOW_EPHEMERAL_STORAGE=true` is set.

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Web app (React/Vite) | `apps/web/dist`, served by the API at `/` | `npm run build:prod`; SPA fallback for deep links |
| API (Express) | `apps/api/dist/server.js` | `/api/*`, JSON errors, structured JSON logs (pino) on stdout |
| Crawler | `bin/sentinel-crawler` (Go) started by the API per crawl, with `bin/sentinel-textcore` (Rust) for duplicate analysis | Only requests `CRAWLER_BASE_URL` / registered website hosts, and only when `CRAWLER_ALLOW_LIVE=true`. Falls back to the built-in Node.js crawler when the binaries are missing |
| Lighthouse / rendered checks | a separate Node process driving Chromium, one at a time | Only in images built with `INSTALL_CHROMIUM=true`; refused when memory is short |
| Shopify SEO editor | in the API process | Writes only after confirmation; see `docs/SHOPIFY_SEO_EDITOR.md` |
| Scheduler | in the API process | Off unless `SCHEDULER_ENABLED=true`: daily smart crawl 02:00 IST, weekly full crawl, 00:30 IST escalations, 08:00 IST digest |
| Health | `GET /healthz` (liveness), `GET /api/health` (storage + crawler readiness) | |

Because data and the scheduler live in one process, run **exactly one always-on instance** (no autoscaling, no
spin-down-when-idle tier: an idle shutdown erases data and skips scheduled crawls).

## Recommended platform

Any Docker host with HTTPS, env vars and a managed PostgreSQL offering works. Recommended: **Render** (Docker web
service, Singapore region for India, managed PostgreSQL available later in the same region). Equivalent alternatives:
Railway, Fly.io, Google Cloud Run (min-instances=1, max-instances=1, CPU always allocated).

Service requirements: 1 instance, ~0.5 vCPU / 512 MB RAM is enough for full crawls of 50,000+ pages (measured: peak
383 MB for the API + 92 MB crawler + 35 MB text core on a 53,000-page synthetic store, see
`docs/measurements/go-crawl-50k.json`). Lighthouse needs Chromium and ~1 GB RAM in total. Health-check path
`/healthz`, port from `PORT` (image default 8080).

The image sets `NODE_OPTIONS=--max-old-space-size=288` for a 512 MB plan. **Never set an 8 GB heap on a 512 MB
service** — Node would try to use memory the container does not have and be killed. On a larger plan raise it to
about 55 % of the plan's RAM (1 GB plan → 560). The crawl memory budget defaults to 85 % of the container limit and
covers the API, crawler and text core together; a crawl that reaches it ends as “Stopped for memory” instead of
crashing the service.

## Steps (Render, Docker)

1. Push this repository to GitHub (the `Dockerfile` is at the repo root).
2. Render → New → Web Service → connect the repo → Runtime **Docker**, region **Singapore**, an always-on paid
   instance type, instances = 1, health check path `/healthz`.
3. Add the environment variables below (mark secrets as secret). Do not add `DATABASE_URL` — it is not used yet.
4. Deploy. Render builds the image and gives you `https://<service>.onrender.com`.
5. Verify:
   ```bash
   curl -s https://<service>.onrender.com/healthz            # {"ok":true}
   curl -s https://<service>.onrender.com/api/health          # storage.kind = "in_memory", crawler readiness
   cd apps/web && npx playwright install chromium             # once, locally
   BASE_URL=https://<service>.onrender.com ADMIN_EMAIL=… ADMIN_PASSWORD=… node e2e/prod-smoke.mjs
   ```
6. Sign in with `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD`, change the password under Profile, then invite people.
   (Invitation and reset emails are only sent when SMTP is configured.)
7. Optional custom domain: add it in Render, create the CNAME at your DNS provider, then set `APP_BASE_URL` to it.

### Any other Docker host

```bash
docker build -t deodap-seo-sentinel .
docker run -d --name sentinel -p 8080:8080 --env-file sentinel.env --restart unless-stopped deodap-seo-sentinel
```
Put a TLS-terminating proxy (Caddy/nginx/the platform load balancer) in front; keep `TRUST_PROXY=1` for one proxy hop.

### Without Docker

```bash
npm ci
npm run build:native               # Go crawler + Rust text core → bin/ (needs Go 1.22+ and Rust 1.75+)
npm run build:prod                 # web (http mode) + API bundle
NODE_ENV=production WEB_DIST_DIR=$PWD/apps/web/dist PORT=8080 … npm start
```

## Environment variables

Required in production:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` (set by the image) |
| `SESSION_SECRET` | random, ≥ 32 chars — `openssl rand -hex 32` |
| `DATABASE_URL` | the PostgreSQL connection string (Render: the database's **Internal Database URL**) — see below |
| `DATABASE_SSL` | optional: `auto` (default — no TLS for a Render-internal or local host, verified TLS otherwise), `require`, `no-verify`, `disable` |
| `DATABASE_WAIT_SECONDS` | optional: how long start-up waits for the database (default 60) |
| `ALLOW_EPHEMERAL_STORAGE` | only without a database: `true` acknowledges that all data is lost on restart (staging only) |
| `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` | first account, a **Super Admin** (password ≥ 10 chars, letters + numbers); optional `ADMIN_NAME`. On a server started before the Super Admin role, this account becomes Super Admin |
| `SITE_ADMIN_EMAIL`, `SITE_ADMIN_INITIAL_PASSWORD` | optional **Admin** account (Overview and SEO operations only), created at start-up when no employee has that email; never changed afterwards (at least 8 characters; a warning is logged when it is simpler than the rule above). Optional `SITE_ADMIN_NAME` |
| `APP_BASE_URL` | the public HTTPS URL, used in alert/digest links |

Crawling and scheduling (needed for real audits):

| Variable | Value |
| --- | --- |
| `CRAWLER_ALLOW_LIVE` | `true` — **the switch for live crawling of every registered website** (off by default) |
| `CRAWLER_BASE_URL` | `https://deodap.in` — the primary website. The primary website's crawler only requests this host (www and non-www), and Start URLs entered for the primary website must be on it. It does **not** limit other websites: each website added under **Manage websites** is crawled on its own registered URL. Without it the primary website cannot be crawled (the Crawl Center says why), the others still can. Use the full `https://` address, no quotes, no path needed |
| `CRAWLER_USER_AGENT` | optional; allow-list it in Shopify bot protection |
| `SCHEDULER_ENABLED` | `true` for the daily/weekly crawls, escalations and digest |
| `CRAWLER_MAX_PAGES`, `CRAWLER_REQUEST_DELAY_MS`, `CRAWLER_MAX_BODY_BYTES` | crawl limits: optional page cap (unset = no limit) / 250 ms / 5 MB — see `LOCAL_CRAWLING.md` |
| `SEED_WEBSITES` | websites that are always in the website selector: added at start-up when missing, never changed or removed afterwards (stored in PostgreSQL like any added website). Entries `Name\|https://url/\|platform`, comma-separated. **Production default:** DeoDap (deodap.in), Grabnix (grabnix.in), Oblivion (oblivion.co.in), Natation (natation.in), all Shopify. `none` = off. Websites added in the app are kept as well — **with `DATABASE_URL`**; without a database every added website (and all data) is lost on each restart |
| `CRAWLER_MAX_CONCURRENT_JOBS`, `CRAWLER_JOB_RESERVE_MB` | crawls **running** at the same time across all websites (default 3) and the memory one more crawl needs before it may start (default 90 MB). More can be started — up to 11 websites in one batch — the rest are queued and start in order (see `docs/BATCH_CRAWLS.md`, measured on 512 MB) |
| `IMAGE_AUDIT_BUDGET_MINUTES`, `IMAGE_AUDIT_MAX_HOURS`, `IMAGE_AUDIT_CHECKPOINT_SECONDS`, `IMAGE_AUDIT_RATE_LIMIT_ROUNDS`, `IMAGE_AUDIT_RATE_LIMIT_PAUSE_SECONDS`, `IMAGE_AUDIT_REUSE_HOURS`, `IMAGE_AUDIT_MAX_CONCURRENT` | Image Audit: round length (10 min; it continues round after round until every image is answered), total limit (12 h), checkpoint interval (10 s; stored in PostgreSQL with `DATABASE_URL`), rate-limited retries (3, 60 s pause), reuse of recent answers (24 h), audits at once (2) — see `docs/IMAGE_AUDIT.md` |
| `CRAWLER_RESUME_INTERRUPTED`, `CRAWLER_RESUME_MAX_ATTEMPTS` | with a database: start a crawl interrupted by a restart again automatically (default `true`), at most this many times (default 2) — see [Crawls are background jobs](#crawls-are-background-jobs) |
| `CRAWL_KEEP_AWAKE`, `KEEP_AWAKE_URL`, `KEEP_AWAKE_INTERVAL_SECONDS` | while a crawl runs, request the server's own `/healthz` (default on; address `KEEP_AWAKE_URL`, else Render's `RENDER_EXTERNAL_URL`; every 300 s) so an idle-stopping host does not stop it |
| `CRAWLER_ENGINE` | `auto` (default: Go crawler when installed — always in the Docker image) / `go` / `node` |
| `CRAWLER_MEMORY_BUDGET_MB` | optional; default 85 % of the container memory limit (API + crawler + text core) |
| `CRAWLER_SMART_MAX_PAGES` | pages a Smart crawl fetches, highest priority first (default and maximum 10,000; Full crawls have no such budget) |
| `MONITOR_INTERVAL_MINUTES` | Auto Sync interval (default `720` = every 12 hours; `0` turns Auto Sync off on the server). Each website can switch Auto Sync on or off in the Crawl Center — see `docs/WEBSITE_SYNC.md` |
| `MONITOR_MAX_CHECKS` | pages checked for changes per sync with conditional requests (default 300, least recently checked first) |
| `SYNC_MAX_URLS` | URLs crawled per sync at most (default 2000); the rest are synced next time |
| `IMAGE_AUDIT_MAX_IMAGES` / `IMAGE_AUDIT_CONCURRENCY` | Image Audit: unique images per audit (50,000), images checked at once per audit (4, max 8) — see `docs/IMAGE_AUDIT.md` |
| `CRAWLER_KEEP_RESULTS` | recent crawls whose page rows stay browsable (default 3, temporary files) |
| `CRAWLER_GO_BIN`, `TEXTCORE_BIN`, `CRAWLER_WORK_DIR` | set by the image (`/app/bin/…`, `/tmp/sentinel-crawls`) |
| `CRAWLER_STALL_MINUTES` | stop a crawl as *partial* (results kept) when no request was answered for this long (default 20) |
| `CHANGE_SNAPSHOT_DIR` | Change Monitor history (crawl snapshots, baseline, screenshots, theme snapshots). Default: the temp folder — **lost on every Render restart / redeploy**. Point it at a persistent disk to keep it, e.g. `/var/data/sentinel-changes` — see `docs/CHANGE_MONITOR.md` |
| `CHANGE_SNAPSHOT_KEEP`, `CHANGE_CAPTURE_*` | retention and screenshot settings (`docs/CHANGE_MONITOR.md`); screenshots need Chromium like Lighthouse |
| `LIGHTHOUSE_ENABLED`, `LIGHTHOUSE_CHROME_FLAGS` | Lighthouse on/off (default on, but it needs Chromium: build with `--build-arg INSTALL_CHROMIUM=true`); in the container Chromium runs as a non-root user and usually needs `LIGHTHOUSE_CHROME_FLAGS=--no-sandbox` |

Shopify SEO editor (optional — `docs/SHOPIFY_SEO_EDITOR.md`):

| Variable | Value |
| --- | --- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | the Shopify app's client id and secret (OAuth “Connect with Shopify”) |
| `APP_BASE_URL` | also the OAuth redirect base: register `<APP_BASE_URL>/api/shopify/oauth/callback` in the app |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | alternative: a custom-app token for the primary website |

The OAuth token is held in memory only, so after every redeploy an admin clicks **Connect with Shopify** again
(or use `SHOPIFY_ADMIN_TOKEN`).

With `CRAWLER_ALLOW_LIVE=true` and no `CRAWLER_BASE_URL`, the server starts, logs a warning, and only the primary
website is not crawlable (its Crawl Center shows what to set); every other registered website is. The crawler never
falls back to a built-in website: the name and Start URL shown before configuration are display defaults only.

### Self-hosted server: live crawling for every registered website

**Where the API reads its settings.** The API process reads **only its own process environment** (`process.env`, parsed
by `apps/api/src/config/env.ts` once at start-up). It does not read a `.env` file by itself. Depending on how you start it:

| How the API is started | Where to put the settings |
| --- | --- |
| `npm run start:api:env` (from the repo root) | `apps/api/.env` — this runs `node --env-file=.env dist/server.js` inside `apps/api` (copy `apps/api/.env.example`) |
| `npm start` / `node apps/api/dist/server.js` | the shell / service environment (e.g. systemd `EnvironmentFile=`) — `.env` files are **not** read |
| systemd | `EnvironmentFile=/etc/deodap-sentinel.env` in the unit's `[Service]` section |
| PM2 | the `env` block of `ecosystem.config.cjs` (or `node_args: '--env-file=apps/api/.env'`) |
| Docker | `docker run --env-file sentinel.env …` (or `env_file:` in docker compose) |

**Settings for live crawling** (add to that file; values without quotes):

```bash
NODE_ENV=production
CRAWLER_ALLOW_LIVE=true                 # the switch: live crawling of every registered website
CRAWLER_BASE_URL=https://deodap.in      # the primary website (other websites use their own registered URL)
SESSION_SECRET=<openssl rand -hex 32>
DATABASE_URL=postgres://…               # keeps websites, crawls and results across restarts
APP_BASE_URL=https://<your domain>
WEB_DIST_DIR=/path/to/repo/apps/web/dist  # when not using the Docker image
PORT=8080
# Render-only settings are not needed on your own server: leave KEEP_AWAKE_URL / RENDER_EXTERNAL_URL unset.
```

**Served under a sub-path** (`https://apps.deodap.info/seo-tool`): set `APP_BASE_URL=https://apps.deodap.info/seo-tool`.
The API then accepts every request with or without the `/seo-tool` prefix (so the reverse proxy may strip it or not),
and the web app (built with `npm run build:prod`) loads its files, pages and API calls under that path — no rebuild per
path. Proxy example (nginx): `location /seo-tool/ { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }`.

**Shopify ("Connect with Shopify")** — one-time setup, no environment variables needed:
1. Shopify Dev Dashboard → your app → Configuration: App URL `https://apps.deodap.info/seo-tool`, **Allowed redirection URL**
   `https://apps.deodap.info/seo-tool/api/shopify/oauth/callback` (exactly), access scopes `read_products, write_products,
   read_content, write_content` (optional `read_themes, write_themes, write_files`). Release the version.
2. Sentinel → Settings → Shopify → **Shopify app credentials**: Client ID, Client secret (Dev Dashboard → your app →
   Settings) and App URL `https://apps.deodap.info/seo-tool` → Save. The Client secret is encrypted (AES-256-GCM) on the
   server and stored in the database; it is never shown again or sent to the browser.
3. Enter `<store>.myshopify.com` → **Connect with Shopify** → approve in Shopify. The access token is stored encrypted in
   the database too, so the connection survives restarts. **Disconnect** deletes it.

What the server must already have (it does on every production install): `SESSION_SECRET` (the encryption key is
derived from it — or set a separate `CREDENTIALS_ENCRYPTION_KEY`, ≥ 32 characters, to rotate sessions independently)
and `DATABASE_URL` (without a database, saved credentials last until the API restarts). If `SESSION_SECRET` /
`CREDENTIALS_ENCRYPTION_KEY` changes, the stored secret and token cannot be decrypted: the Shopify page says so — enter
the Client secret again and connect again. `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `APP_BASE_URL` still work as a
fallback; credentials saved in the app take precedence for that website. If your reverse proxy does **not** strip
`/seo-tool`, also set `APP_BASE_URL=https://apps.deodap.info/seo-tool` so the web app itself loads under that path
(otherwise the saved App URL is enough).

**Google Search Console / GA4** — one-time setup: create a Google Cloud service account, enable the *Search Console API*
and the *Google Analytics Data API* in its project, download its JSON key and set it (single line) as
`GSC_SERVICE_ACCOUNT_JSON` / `GA4_SERVICE_ACCOUNT_JSON` in the API environment (the same key may be used for both).
Add the service-account e-mail as an **Owner** in Search Console (Settings → Users and permissions) and as **Viewer** in
GA4 (Admin → Property access management). Then, per website, enter the property under Settings → Integrations
(`sc-domain:deodap.in` or `https://deodap.in/`; GA4: the numeric Property ID) and press **Test connection** — the card
shows Connected only after Google answered. `GSC_PROPERTY` / `GA4_PROPERTY_ID` in the environment remain a fallback.

**Crawler User-Agent:** `CRAWLER_USER_AGENT` is optional; without it the crawler sends
`DeoDapSEOSentinel/1.0 (+internal audit)`.

**Restart / reload.** Settings are read once at start-up, so restart the API after every change (a reload of nginx or
the browser is not enough):

```bash
sudo systemctl restart deodap-sentinel          # systemd (after editing the EnvironmentFile)
pm2 restart sentinel --update-env               # PM2 (--update-env picks up changed variables)
docker compose up -d --force-recreate sentinel  # docker compose (a plain "docker restart" keeps the old env)
# started by hand: stop it (Ctrl+C) and run "npm run start:api:env" again
```

A restart is graceful: running crawls are suspended and continue after the restart (with `DATABASE_URL`).

**Websites.** No code change, rebuild or restart is needed for a new website: add it under **Manage websites** (name,
public `https://` address, platform); it is checked (public address only — private, loopback, link-local / cloud
metadata and internal host names are refused) and can be crawled at once. The website selected in Sentinel decides
which host is crawled: the server resolves it from the website id, the Start URL must be on that website (www-insensitive),
results are stored under that website only, and a Start URL that redirects to another website is refused without
requesting it. Unregistered websites cannot be crawled. Every request is still checked against private / internal
addresses (each DNS answer and redirect hop), robots.txt, retries with back-off and adaptive throttling apply as before.

**Check after the restart:**

```bash
curl -s https://<your domain>/api/health     # "crawler": {"ready": true, "baseUrl": "https://deodap.in"}
journalctl -u deodap-sentinel -n 50          # "Live crawling is ON for every registered website …"
```
In the app: select each website → Crawl Center → the "Start crawl" button is enabled (if not, the reason shown names
the setting to change).

### Render: environment settings for live crawling

Render → your web service → **Environment** → add (then **Save, rebuild and deploy**; Render restarts the service):

| Key | Value |
| --- | --- |
| `CRAWLER_BASE_URL` | `https://deodap.in` |
| `CRAWLER_ALLOW_LIVE` | `true` |
| `SESSION_SECRET` | a random value of at least 32 characters (keep it secret) |
| `DATABASE_URL` | the Internal Database URL of your Render PostgreSQL (see [PostgreSQL on Render](#postgresql-on-render)); then remove `ALLOW_EPHEMERAL_STORAGE` |
| `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` | your admin sign-in (password: at least 10 characters, letters and numbers) |
| `APP_BASE_URL` | `https://<service>.onrender.com` (or your custom domain) |
| optional: `CRAWLER_REQUEST_DELAY_MS`, `CRAWLER_MAX_PAGES`, `CRAWLER_MAX_CONCURRENT_JOBS` | see the table above; leave `CRAWLER_MAX_PAGES` unset for no page limit |

Change history (optional): Render's filesystem is ephemeral, so the Change Monitor baseline and screenshots are lost on
every restart or redeploy. To keep them, add a **Disk** to the service (paid plans; e.g. mount path `/var/data`, 1 GB is
plenty) and set `CHANGE_SNAPSHOT_DIR=/var/data/sentinel-changes`. Without a disk the Crawl Center says that the history
is temporary.

Do not set `NODE_ENV`, `PORT` or `WEB_DIST_DIR` (the image sets them) and do not bake `CRAWLER_BASE_URL` into the
Dockerfile — the image stays the same for every website, and the environment decides which website it may crawl.
After the deploy, `https://<service>.onrender.com/api/health` shows `"crawler": {"ready": true, "baseUrl": "https://deodap.in"}`.
To crawl another website, add it under **Manage websites** (its crawler is restricted to that site's own host).

**Sign-in sessions** last until the user selects *Sign out* — they do not expire on their own and survive restarts,
redeploys and Render spin-downs, as long as `SESSION_SECRET` stays the same (changing it signs everyone out). A session
ends when the user signs out, their password is changed or reset, or their account is deactivated. Do not set
`SESSION_TTL_HOURS` (or set it to `0`); a positive number of hours would cap every session again. With `DATABASE_URL`, sessions and
sign-outs are stored in the database. Without a database they are kept in memory, so a token signed out *before* a
restart is no longer on the server's revoked list after it — changing the password ends every session for sure.

Set by the image, override only if needed: `PORT=8080`, `WEB_DIST_DIR=/app/apps/web/dist`. Optional: `LOG_LEVEL`,
`SESSION_TTL_HOURS` (default `0` = until sign-out), `TRUST_PROXY` (default 1 in production), `AUTH_RATE_LIMIT` (default 20 per IP per 15 min),
`CORS_ORIGIN` (only if the web app is hosted on another origin — not needed with this setup).

Integrations (each stays "Not connected" until its credentials are set **and** its connection test passes in
Settings → Integrations): Google Search Console, GA4, PageSpeed/CrUX, Ahrefs or Semrush, Shopify Admin + webhook,
Google Business Profile, OpenAI/Gemini/Perplexity, SMTP email, WhatsApp Cloud API, Slack. Variable names are listed in
`apps/api/.env.example`. Never commit real values; set them only in the hosting platform's secret store.

Forced off in production regardless of env: exposing reset tokens in API responses. The test fixtures
(`SEED_TEST_FIXTURES`) load only when `NODE_ENV=test`; a server never starts with sample data or sample accounts.

## PostgreSQL on Render

1. **Create the database.** Render dashboard → **New → PostgreSQL**. Name e.g. `sentinel-db`, database `sentinel`,
   **the same region as the web service**, PostgreSQL 15 or newer. Use a paid instance type for real data: Render's free
   databases are removed after a limited time and have no backups (check Render's current plan terms and backup options).
2. **Connect the API.** Open the database → **Connections** → copy the **Internal Database URL**
   (`postgresql://…@dpg-…-a/sentinel`). Web service → **Environment** → add `DATABASE_URL` = that value (the value is a
   secret; Render stores it encrypted and the API never logs it — logs show only host and database name). Remove
   `ALLOW_EPHEMERAL_STORAGE`. Save → Render redeploys.
   - The internal URL stays inside Render's private network: no TLS is needed (`DATABASE_SSL=auto` detects it). If you
     use the **External** URL instead (e.g. another provider), TLS is used and verified automatically.
3. **First start.** The API connects (waiting up to `DATABASE_WAIT_SECONDS` for the database), creates its tables
   (`sentinel_websites`, `sentinel_records`, `sentinel_documents`, `sentinel_crawl_rows`, `sentinel_files`,
   `sentinel_schema_migrations`) and logs `PostgreSQL storage ready`. Migrations only ever add tables / columns; they
   never delete data, and two instances starting together are safe (advisory lock). System health → Storage shows
   *PostgreSQL … kept across restarts*.
4. **Check it.** Add a website, run a crawl, then **Manual Deploy → Restart service**: the websites, the crawl, its
   Pages list, issues and Health Score are still there.

If the database cannot be reached at start-up, the API does not start (the log says why) — it never silently runs on
temporary memory with `DATABASE_URL` set. If it becomes unreachable while running, changes answer **503 — not saved
yet**, System health shows *Storage: down* with the error, and queued changes are written as soon as it is back.

### Crawls are background jobs

A crawl runs on the server until it finishes or someone selects **Cancel crawl** (an explicit `POST /api/crawls/:id/cancel`).
Closing or refreshing the browser, signing in from another browser or shutting down the laptop does not stop it; any
browser that opens the Crawl Center shows the same crawl and its live progress. A second **Start** while a crawl of that
website runs (double click, another tab or browser) is refused with `409 CRAWL_ALREADY_RUNNING` and the running crawl's id.

- **Idle stop.** Render's free instances spin down after 15 minutes without *incoming* requests, however busy the
  server is — that used to cut off crawls nobody was watching. While a crawl runs, the server therefore requests its own
  public `/healthz` every 5 minutes (`RENDER_EXTERNAL_URL`, set by Render; or `KEEP_AWAKE_URL`). Nothing is requested
  when no crawl runs. Turn it off with `CRAWL_KEEP_AWAKE=false`. A paid instance (Starter or above) never spins down
  and is the dependable choice for long crawls.
- **Restart / redeploy / crash.** With `DATABASE_URL`, the crawl's job record (type, start URL, limits, exclusions,
  trigger, progress) is in PostgreSQL. On `SIGTERM` a running crawl is left as *running* (never recorded as failed or
  completed because of the shutdown); when the server is back it is **started again automatically under the same id
  with the same settings**, at most `CRAWLER_RESUME_MAX_ATTEMPTS` (2) times. It starts **from the beginning**: the crawler
  keeps no page-level checkpoint, so pages fetched before the restart are fetched again, and issues are updated only
  when the restarted crawl finishes. The crawl shows *Started again automatically after a server restart*. A crawl that
  cannot be started again (restarted too often, `CRAWLER_RESUME_INTERRUPTED=false`, crawler not ready) is marked
  **failed** with the reason — never completed. Without a database the job exists only in memory and a restart loses it.

Data that is still not kept across restarts (by design, see `docs/DATABASE.md`): Change Monitor screenshots / captured HTML / theme snapshots (only the crawl comparison history
is stored), Lighthouse runs, and the Shopify OAuth token.

