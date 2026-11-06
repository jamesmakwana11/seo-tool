# Google integrations — Analytics, Search Console, Core Web Vitals

Admins connect Google from **Settings → Integrations → Google**. Nothing is configured on the server for routine work:
the OAuth client, Google accounts, per-website properties and the PageSpeed Insights key are all entered on that screen.
Reports are under **Google insights** in the sidebar (Analytics, Search Console, Core Web Vitals) for the selected website.

Who: `google.manage` (Admin, Super Admin) connects and maps; `analytics.view` (Admin, Super Admin, SEO Specialist by
default) sees the reports. Developers see neither unless an Admin grants it (Development team → Roles & permissions).

## One-time setup in Google Cloud (cannot be avoided)

Google only signs users in to an OAuth client that the site owner registered in a Google Cloud project, and only
redirects to addresses registered on that client. Sentinel cannot do this step for you. Once, in
[Google Cloud Console](https://console.cloud.google.com/):

1. **APIs & Services → Library** — enable *Google Analytics Admin API*, *Google Analytics Data API*,
   *Google Search Console API* and *PageSpeed Insights API* (and *Chrome UX Report API* if you use the CrUX data sync).
2. **OAuth consent screen** — Internal (Google Workspace) or External **and published**. An app left in *Testing*
   loses access after 7 days (Sentinel then shows “Access expired — Reconnect”).
3. **Credentials → Create credentials → OAuth client ID → Web application** — under *Authorized redirect URIs* add the
   exact URI shown on the Integrations screen: `<Sentinel address>/api/google/oauth/callback`
   (e.g. `https://apps.deodap.info/seo-tool/api/google/oauth/callback`).
4. **Credentials → Create credentials → API key** — restrict it to the PageSpeed Insights API (and Chrome UX Report API).

Then, in Sentinel, enter the Client ID and Client secret, click **Connect Google account**, and choose the GA4 property
and Search Console property for each website. Enter the API key on the Core Web Vitals card.

## What is stored, and where

| Item | Stored as | Where |
|---|---|---|
| OAuth Client ID, Sentinel address | plain (not secret) | `googleConnections` (primary website) |
| OAuth Client secret | AES-256-GCM (`security/secretBox`) | same |
| Each Google account's refresh token | AES-256-GCM, bound to the account record | same, `acct:<google id>` |
| PageSpeed Insights API key | AES-256-GCM | same, `psi` |
| Access tokens | memory only (≈1 hour) | — |
| Website → account + GA4 property / Search Console property | plain | that website's integration settings (`ga4`, `gsc`) |
| Core Web Vitals runs (400 days, ≤ 3,000 per website) | plain | `cwvRuns` per website |
| Daily GA4 / Search Console totals from every report | plain | `googleHistory` per website |

The encryption key is derived from `CREDENTIALS_ENCRYPTION_KEY`, or `SESSION_SECRET` when that is not set. With
`DATABASE_URL`, everything above survives restarts and redeploys. If the secret changes, the screen says the stored
credentials could not be decrypted and asks for them again — they are never used half-working.

Secrets are never returned by the API, never written to logs, audit entries or exports (tests check rows, logs, audit
and responses). Google error messages are passed through `redact()` before they are shown or stored.

## Connections

- **Connect Google account** — Google sign-in with `access_type=offline` and `prompt=consent` (always a refresh token),
  read-only scopes `analytics.readonly` and `webmasters.readonly` plus `openid email profile`. The `state` is random,
  single-use and expires after 10 minutes; the callback checks it before anything else.
- **Reconnect** — the same flow with `login_hint` for that account; refuses a different Google account.
- **Test connection** — per account (lists the properties it can read) and per website (GA4: a one-row report;
  Search Console: the property is visible and verified).
- **Disconnect** — revokes the refresh token at Google and deletes it. Websites that used the account show “no longer
  connected” until another account is chosen; other websites are unaffected.
- **Expired access** — when Google answers `invalid_grant` (password changed, access removed, Testing-mode expiry), the
  account and every website using it show “Reconnect needed”; reports answer 409 `GOOGLE_RECONNECT`.
- **Rate limits** — 429 / quota errors and 5xx are retried with backoff (Retry-After honoured), then reported in plain
  words. Google calls are limited server-wide (4 at a time; PageSpeed Insights 2 at a time). Reports are cached for
  15 minutes per website, range and comparison (Refresh bypasses the cache).

The older service-account route (`GSC_SERVICE_ACCOUNT_JSON`, `GA4_SERVICE_ACCOUNT_JSON`, `GOOGLE_API_KEY`) keeps
working; its cards are under “More integrations”. A website mapped to a Google account uses that account for the
existing nightly GA4 / Search Console data syncs too.

## Reports

- **Analytics (GA4 Data API, one `batchRunReports` call)** — users, new users, sessions, engaged sessions, engagement
  rate, average session duration, views, conversions (*key events*; *conversions* on older properties), daily trend,
  channels, source / medium, top pages. 7 / 28 / 90 days, compared with the previous period or the same days last year
  (364 days earlier so weekdays line up). Windows end yesterday (IST).
- **Search Console (Search Analytics API)** — clicks, impressions, CTR, average position (lower is better), daily trend,
  top queries, pages, countries, devices; the Sitemaps report (submitted / indexed counts where Google still reports
  them); URL inspection of one page. Windows end two days ago (Search Console data lag). Google's API does not expose the
  Page indexing report totals, so they are not shown.
- **Core Web Vitals (PageSpeed Insights v5)** — per page and per device: field data (real Chrome users, 28-day p75) for
  the page, or for the whole origin when the page has too little traffic, and a Lighthouse lab run. LCP, INP, CLS, FCP,
  TTFB rated with Google's thresholds (LCP 2.5 s / 4 s, INP 200 / 500 ms, CLS 0.1 / 0.25, FCP 1.8 / 3 s,
  TTFB 0.8 / 1.8 s). INP cannot be measured in the lab, so the lab shows TBT. Up to 5 pages per website (homepage by
  default); **Run test now** and an automatic run every day at 01:30 IST; history chart of the last 180 days.

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/api/google/status` | google.manage |
| PUT / DELETE | `/api/google/oauth-client` | google.manage |
| POST | `/api/google/oauth/start` · GET `/api/google/oauth/callback` (public, state-checked) | google.manage |
| POST | `/api/google/accounts/:id/test` · DELETE `/api/google/accounts/:id` | google.manage |
| GET | `/api/google/accounts/:id/ga4-properties` · `/gsc-sites` | google.manage |
| PUT / DELETE / POST test | `/api/google/mapping/:product` (`ga4` / `gsc`) | google.manage |
| PUT / DELETE | `/api/google/psi-key` · POST `/api/google/psi/test` · PUT `/api/google/cwv/settings` | google.manage |
| GET | `/api/insights/ga4`, `/api/insights/gsc`, `/api/insights/history`, `/api/insights/cwv` | analytics.view |
| POST | `/api/insights/gsc/inspect`, `/api/insights/cwv/run` | analytics.view |

Tests: `apps/api/test/google/google.test.ts` (in-memory Google in `mockGoogle.ts` — no network),
`apps/api/test/persistence/googleTeam.test.ts` (PostgreSQL, restart). Not verified against the live Google APIs from
this environment: that needs your OAuth client and API key.
