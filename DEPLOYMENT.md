# Deploying DeoDap SEO Sentinel

One container runs everything: the Express API serves the built React app from the same origin, runs the crawler and
(optionally) the in-process scheduler. HTTPS is terminated by the hosting platform.

> **Storage is still TEMPORARY in-memory.** There is no PostgreSQL integration yet. Every restart, redeploy or platform
> maintenance event erases all websites, crawls, issues, users (except the env-bootstrapped admin) and settings.
> In production the server refuses to start unless `ALLOW_EPHEMERAL_STORAGE=true` is set, so this is an explicit choice.
> Use such a deployment only as a staging/pilot environment until PostgreSQL is authorized and implemented.

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| Web app (React/Vite) | `apps/web/dist`, served by the API at `/` | Built with `VITE_API_MODE=http`; SPA fallback for deep links |
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
| `ALLOW_EPHEMERAL_STORAGE` | `true` — acknowledges that all data is lost on restart (no database yet) |
| `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD` | first admin (password ≥ 10 chars, letters + numbers); optional `ADMIN_NAME` |
| `APP_BASE_URL` | the public HTTPS URL, used in alert/digest links |

Crawling and scheduling (needed for real audits):

| Variable | Value |
| --- | --- |
| `CRAWLER_BASE_URL` | `https://deodap.in` — the primary website. **Required for live crawling.** It is also the security boundary: the primary website's crawler only requests this host (www and non-www), and every Start URL entered in the Crawl Center must be on it. Use the full `https://` address, no quotes, no path needed |
| `CRAWLER_ALLOW_LIVE` | `true` once you approve live crawling of that site |
| `CRAWLER_USER_AGENT` | optional; allow-list it in Shopify bot protection |
| `SCHEDULER_ENABLED` | `true` for the daily/weekly crawls, escalations and digest |
| `CRAWLER_MAX_PAGES`, `CRAWLER_REQUEST_DELAY_MS`, `CRAWLER_MAX_BODY_BYTES`, `CRAWLER_MAX_CONCURRENT_JOBS` | crawl limits: optional page cap (unset = no limit) / 250 ms / 5 MB / 2 — see `LOCAL_CRAWLING.md` |
| `CRAWLER_ENGINE` | `auto` (default: Go crawler when installed — always in the Docker image) / `go` / `node` |
| `CRAWLER_MEMORY_BUDGET_MB` | optional; default 85 % of the container memory limit (API + crawler + text core) |
| `CRAWLER_SMART_MAX_PAGES` | pages a Smart crawl fetches, highest priority first (default 500) |
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

With `CRAWLER_ALLOW_LIVE=true` and no `CRAWLER_BASE_URL`, the production server refuses to start and says so in the
log, rather than starting with a Crawl Center that shows "Live crawling is not available for this website". The
crawler never falls back to a built-in website: the name and Start URL shown before configuration are display
defaults only.

### Render: environment settings for live crawling

Render → your web service → **Environment** → add (then **Save, rebuild and deploy**; Render restarts the service):

| Key | Value |
| --- | --- |
| `CRAWLER_BASE_URL` | `https://deodap.in` |
| `CRAWLER_ALLOW_LIVE` | `true` |
| `SESSION_SECRET` | a random value of at least 32 characters (keep it secret) |
| `ALLOW_EPHEMERAL_STORAGE` | `true` |
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
`SESSION_TTL_HOURS` (or set it to `0`); a positive number of hours would cap every session again. Limit: sessions and
sign-outs are kept in memory (no database), so a token signed out *before* a restart is no longer on the server's
revoked list after it — the browser deletes its token at sign-out, and changing the password ends every session for sure.

Set by the image, override only if needed: `PORT=8080`, `WEB_DIST_DIR=/app/apps/web/dist`. Optional: `LOG_LEVEL`,
`SESSION_TTL_HOURS` (default `0` = until sign-out), `TRUST_PROXY` (default 1 in production), `AUTH_RATE_LIMIT` (default 20 per IP per 15 min),
`CORS_ORIGIN` (only if the web app is hosted on another origin — not needed with this setup).

Integrations (each stays "Not connected" until its credentials are set **and** its connection test passes in
Settings → Integrations): Google Search Console, GA4, PageSpeed/CrUX, Ahrefs or Semrush, Shopify Admin + webhook,
Google Business Profile, OpenAI/Gemini/Perplexity, SMTP email, WhatsApp Cloud API, Slack. Variable names are listed in
`apps/api/.env.example`. Never commit real values; set them only in the hosting platform's secret store.

Forced off in production regardless of env: DEMO seed (its preview accounts have published passwords), DEV role
preview, exposing reset tokens in API responses.

## PostgreSQL (not implemented — needs authorization)

The data layer is already behind storage-agnostic async interfaces (`apps/api/src/repositories/types.ts`:
`Repository<T>` with get/list/where/insert/update/upsert/delete/count/nextId, and `DocumentStore<T>`), so services do
not change. Minimum work once authorized:

1. Add the `pg` driver and a `DATABASE_URL` env var (TLS required).
2. One migration creating a document table keyed by `(website_id, collection, id)` with a `jsonb` payload plus a
   singleton-document table, and a `websites` table (website list is currently an in-memory array in `websites.ts`).
3. A PostgreSQL implementation of `Repositories`, selected when `DATABASE_URL` is set; run migrations on start.
4. Persist the website list; keep people/credentials/sessions shared across websites as today.
5. Then drop `ALLOW_EPHEMERAL_STORAGE`, and the scheduler/crawler could later move to a separate worker service.

Needed from you: approval, a PostgreSQL 15+ instance (e.g. Render PostgreSQL in the same region, Neon, Supabase or
RDS) and its connection string for a role that can create tables in one database, plus a backup policy.
