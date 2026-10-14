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
| Crawler | in the API process | Only requests `CRAWLER_BASE_URL` / registered website hosts, and only when `CRAWLER_ALLOW_LIVE=true` |
| Scheduler | in the API process | Off unless `SCHEDULER_ENABLED=true`: daily smart crawl 02:00 IST, weekly full crawl, 00:30 IST escalations, 08:00 IST digest |
| Health | `GET /healthz` (liveness), `GET /api/health` (storage + crawler readiness) | |

Because data and the scheduler live in one process, run **exactly one always-on instance** (no autoscaling, no
spin-down-when-idle tier: an idle shutdown erases data and skips scheduled crawls).

## Recommended platform

Any Docker host with HTTPS, env vars and a managed PostgreSQL offering works. Recommended: **Render** (Docker web
service, Singapore region for India, managed PostgreSQL available later in the same region). Equivalent alternatives:
Railway, Fly.io, Google Cloud Run (min-instances=1, max-instances=1, CPU always allocated).

Service requirements: 1 instance, ~0.5 vCPU / 512 MB–1 GB RAM (full crawls of ~5,000 pages keep page data in memory —
prefer 1 GB), health-check path `/healthz`, port from `PORT` (image default 8080).

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
| `CRAWLER_BASE_URL` | `https://deodap.in` — the primary website |
| `CRAWLER_ALLOW_LIVE` | `true` once you approve live crawling of that site |
| `CRAWLER_USER_AGENT` | optional; allow-list it in Shopify bot protection |
| `SCHEDULER_ENABLED` | `true` for the daily/weekly crawls, escalations and digest |

Set by the image, override only if needed: `PORT=8080`, `WEB_DIST_DIR=/app/apps/web/dist`. Optional: `LOG_LEVEL`,
`SESSION_TTL_HOURS`, `TRUST_PROXY` (default 1 in production), `AUTH_RATE_LIMIT` (default 20 per IP per 15 min),
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
