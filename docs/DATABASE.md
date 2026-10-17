# Database (PostgreSQL)

Set `DATABASE_URL` and the API keeps its data in PostgreSQL: websites and everything that belongs to them survive
browser refreshes, sign-out / sign-in, API restarts and Render redeploys. Render setup: `DEPLOYMENT.md` →
*PostgreSQL on Render*.

## How it works

The services did not change: they still use the repository interfaces (`apps/api/src/repositories/types.ts`). With a
database each repository is served from memory and written through to PostgreSQL
(`apps/api/src/repositories/postgres/persistence.ts`):

- **Start-up:** connect (wait up to `DATABASE_WAIT_SECONDS`), apply migrations, load every website and its records.
  A website that already has data is loaded as it is — never re-seeded, reset or given new default schedules. If the
  database cannot be reached, the API does not start; it never falls back to temporary memory when `DATABASE_URL` is set.
- **Writes:** queued and stored in batches (multi-row, parameterised `INSERT … ON CONFLICT` / `DELETE`, at most every
  200 ms; bulk work such as a 50,000-page crawl waits whenever 2,000 writes are queued). An API request that changes
  something answers only after its changes are stored; a finished crawl stores its run, findings, issues, page inventory
  and page rows before it ends; on `SIGTERM` (Render redeploy / restart) the queue is written before the process exits.
- **Failures:** a write that fails stays queued and is retried (1 s → 30 s); the request answers **503
  DATABASE_UNAVAILABLE — "not saved yet"**, System health shows *Storage: down* with the error, `/api/health` reports
  `ok: false`. A read that fails answers 503 instead of an empty result.
- **Isolation:** every row carries its website's id (`site-…`); a request is bound to one website (X-Website-Id) and only
  ever reads and writes that website's rows. People, credentials, sessions and the permission matrix are stored once
  under `_shared`, as one sign-in works across websites.

## Schema (migration 1)

| Table | Key | Holds |
| --- | --- | --- |
| `sentinel_websites` | `id` | each website: stable id, name, URL, domain, platform, sitemap, timestamps |
| `sentinel_records` | `website_id, collection, id` | every record as `jsonb`: crawl runs (status, outcome, completeness, discovered / processed / failed / excluded / pending counts, timestamps, Smart budget), issues with evidence, Fix Card inputs and history, findings' page inventory (`sitePages`), previous-crawl state, page snapshots, tasks, verifications, exclusions, rules, notifications, audit log, integrations …; shared people / sessions under `_shared` |
| `sentinel_documents` | `website_id, name` | configuration (thresholds, crawl settings, site), metrics (Health Score history, site size …), permission matrix |
| `sentinel_crawl_rows` | `website_id, run_id, seq` | the page-level results (one row per URL) of the `CRAWLER_KEEP_RESULTS` most recent crawls of each website |
| `sentinel_files` | `website_id, path` | Change Monitor history (`changes/index.json`, the baseline, each crawl's change lists) and crawl coverage reports |
| `sentinel_schema_migrations` | `version` | applied migrations |

Migrations (`apps/api/src/repositories/postgres/migrations.ts`) run in a transaction under an advisory lock and only
add tables or columns — never drop or rewrite data. Health Score is computed from the stored issues, site size and
configuration, so the score after a restart is the same as before it.

## What is kept, what is not

Kept: websites; crawl runs and their completeness; page-level results, page reports, coverage and exports of recent
crawls; issues, evidence, Fix Card inputs, findings; Health Score inputs and history; Change Monitor baseline and change
lists; users, sessions, settings, schedules, rules.

A **cancelled or failed** crawl is stored as such but never replaces the last valid audit: it creates or resolves no
issue, the Health Score is unchanged, the latest page report stays on the last completed crawl, and the Change Monitor
baseline is kept.

Not kept across restarts: Image Audit jobs and the image references of crawls, Change Monitor screenshots / rendered
HTML / theme snapshots, Lighthouse runs, the Shopify OAuth token, the progress of a crawl running during a restart (it is started again
automatically from its stored settings — from the beginning, see "Crawls are background jobs" in `DEPLOYMENT.md`), and the page rows of crawls older than the `CRAWLER_KEEP_RESULTS` most recent ones (their run,
issues and findings stay).

## Local setup and tests

```
# PostgreSQL 15+ locally (example: Ubuntu / Debian)
sudo service postgresql start
sudo -u postgres psql -c "CREATE ROLE sentinel LOGIN PASSWORD 'choose-a-local-password';"
sudo -u postgres psql -c "CREATE DATABASE sentinel OWNER sentinel;"
sudo -u postgres psql -c "CREATE DATABASE sentinel_test OWNER sentinel;"

# API with the database (apps/api/.env or the shell)
DATABASE_URL=postgresql://sentinel:choose-a-local-password@127.0.0.1:5432/sentinel npm run dev:api

# Tests: every persistence test creates and drops its own schema in the test database
TEST_DATABASE_URL=postgresql://sentinel:choose-a-local-password@127.0.0.1:5432/sentinel_test npm test -w @sentinel/api
```

Without `TEST_DATABASE_URL` the database tests are skipped (the rest of the suite runs on memory as before).
