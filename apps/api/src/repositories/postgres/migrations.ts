/**
 * Database schema, as ordered migrations. Applied once each (sentinel_schema_migrations) under an advisory lock.
 * Rules: only add — never drop or rewrite tables or columns that hold data; a later change is a new migration.
 */
export interface Migration { version: number; name: string; statements: string[] }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'websites, records, documents, crawl page rows, files',
    statements: [
      // Websites of this workspace (stable id, domain, settings).
      `CREATE TABLE IF NOT EXISTS sentinel_websites (
        id text PRIMARY KEY,
        doc jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      // Every repository record of a website (crawls, issues, findings, tasks, page inventory, snapshots …), keyed by
      // website so data of different websites can never mix. Shared people / sign-in data use website_id '_shared'.
      `CREATE TABLE IF NOT EXISTS sentinel_records (
        website_id text NOT NULL,
        collection text NOT NULL,
        id text NOT NULL,
        doc jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (website_id, collection, id)
      )`,
      // Single documents per website: configuration (thresholds, crawl settings), metrics (Health Score history,
      // site size), permission matrix.
      `CREATE TABLE IF NOT EXISTS sentinel_documents (
        website_id text NOT NULL,
        name text NOT NULL,
        doc jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (website_id, name)
      )`,
      // Page-level results of recent crawls (one row per URL, in crawl order).
      `CREATE TABLE IF NOT EXISTS sentinel_crawl_rows (
        website_id text NOT NULL,
        run_id text NOT NULL,
        seq integer NOT NULL,
        row jsonb NOT NULL,
        PRIMARY KEY (website_id, run_id, seq)
      )`,
      // Files a website needs after a restart: Change Monitor baseline and crawl snapshots, coverage reports.
      `CREATE TABLE IF NOT EXISTS sentinel_files (
        website_id text NOT NULL,
        path text NOT NULL,
        content bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (website_id, path)
      )`,
    ],
  },
];
