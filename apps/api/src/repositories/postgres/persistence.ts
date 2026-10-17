/**
 * PostgreSQL persistence (DATABASE_URL).
 *
 * The services keep working on the existing repository interfaces. With a database, every repository is still served
 * from memory (fast reads, no service changes), but each write is also stored in PostgreSQL and the whole state is
 * loaded back at start-up — so websites, crawls, page results, issues, findings and Health Score inputs survive browser
 * refreshes, sign-out / sign-in, API restarts and redeploys.
 *
 * Writes are queued and sent in batches (one multi-row statement per table, at most every 200 ms); a mutating API
 * request waits for its writes to be stored before it answers, a finished crawl waits for its results, and shutdown
 * (SIGTERM on redeploy) flushes the queue. If the database cannot be written, the queue is kept and retried, the error
 * is shown on System health, and mutating requests answer 503 — the server never quietly continues as if the data were
 * saved. All statements are parameterised; credentials are never logged.
 */
import pg, { type Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import type { Logger } from '../../lib/logger';
import { ApiError } from '../../lib/errors';
import type { Repositories } from '../types';
import { InMemoryDocument, InMemoryRepository, createInMemoryRepositories, type RepositoryFactory } from '../memory/inMemory';
import { MIGRATIONS } from './migrations';

/** People, sign-in and permissions are shared by every website: stored once, under this scope. */
export const SHARED_SCOPE = '_shared';
export const SHARED_COLLECTIONS = new Set(['employees', 'credentials', 'resetTokens', 'sessions', 'permissions']);

type Op =
  | { t: 'rec'; scope: string; coll: string; id: string; doc: string | null }
  | { t: 'doc'; scope: string; name: string; doc: string };

export interface PersistenceStatus {
  kind: 'postgres';
  connected: boolean;
  database: string;
  pending: number;
  lastError?: string;
  lastErrorAt?: string;
  lastFlushAt?: string;
}

/** JSON for jsonb: NUL characters are not allowed in PostgreSQL text / jsonb. */
const json = (v: unknown) => JSON.stringify(v).replace(/\\u0000/g, '');

/** Where the database is, without credentials (for logs and messages). */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return 'an invalid DATABASE_URL';
  }
}

/** TLS for the connection: none for a local / Render-internal host, verified TLS otherwise (DATABASE_SSL overrides). */
export function sslFor(url: string, mode: 'auto' | 'require' | 'no-verify' | 'disable' = 'auto'): PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'require') return { rejectUnauthorized: true };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* invalid: the connection attempt reports it */ }
  const internal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || !host.includes('.');
  if (/[?&]sslmode=disable/.test(url) || internal) return false;
  return { rejectUnauthorized: true };
}

export class DatabaseUnavailableError extends ApiError {
  constructor(message: string) {
    super(503, 'DATABASE_UNAVAILABLE', message);
  }
}

export class Persistence {
  /** Reads: a database error becomes a clear 503 (never an empty result that looks like "no data"). */
  private async read<R extends QueryResultRow>(text: string, params: unknown[]) {
    try {
      const r = await this.pool.query<R>(text, params);
      if (this.readFailed && !this.queue.size) { this.readFailed = false; this.st.connected = true; this.st.lastError = undefined; }
      return r;
    } catch (e) {
      this.readFailed = true;
      this.st.connected = false;
      this.st.lastError = (e as Error).message;
      this.st.lastErrorAt = new Date().toISOString();
      throw new DatabaseUnavailableError(`The database could not be read (${(e as Error).message}).`);
    }
  }
  private readFailed = false;
  private queue = new Map<string, Op>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private st: PersistenceStatus;
  private retryMs = 1000;

  constructor(readonly pool: Pool, private readonly log: Logger, database: string) {
    this.st = { kind: 'postgres', connected: true, database, pending: 0 };
  }

  status(): PersistenceStatus { return { ...this.st, pending: this.queue.size }; }

  // ------------------------------------------------------------------------------------------- writes (queued)
  putRecord(scope: string, coll: string, id: string, doc: unknown | null) {
    this.enqueue(`r\u0001${scope}\u0001${coll}\u0001${id}`, { t: 'rec', scope, coll, id, doc: doc === null ? null : json(doc) });
  }
  putDocument(scope: string, name: string, doc: unknown) {
    this.enqueue(`d\u0001${scope}\u0001${name}`, { t: 'doc', scope, name, doc: json(doc) });
  }
  private enqueue(key: string, op: Op) {
    this.queue.delete(key); // re-insert: order follows the latest write
    this.queue.set(key, op);
    if (!this.timer && !this.flushing) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, 200);
  }

  /**
   * Back-pressure for bulk work (a crawl updating 50,000 pages): once many writes are queued, the writer waits for them
   * to be stored, so the queue never holds a whole crawl in memory. Errors are recorded and retried, not thrown here.
   */
  async drain() {
    if (this.queue.size >= 2000) await this.flush().catch(() => undefined);
  }

  /** Store every queued write. Rejects with DatabaseUnavailableError when the database cannot be written (writes stay queued). */
  async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing.catch(() => undefined);
      if (!this.queue.size) return;
    }
    if (!this.queue.size) {
      if (this.st.lastError && !this.st.connected) throw new DatabaseUnavailableError(this.unavailableMessage());
      return;
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const batch = [...this.queue.entries()];
    this.queue.clear();
    this.flushing = this.write(batch.map(([, op]) => op)).then(
      () => {
        this.st.connected = true;
        this.st.lastError = undefined;
        this.st.lastFlushAt = new Date().toISOString();
        this.retryMs = 1000;
      },
      (e: Error) => {
        // Put back what was not written, unless a newer write for the same record came in meanwhile.
        for (const [k, op] of batch) if (!this.queue.has(k)) this.queue.set(k, op);
        this.st.connected = false;
        this.st.lastError = e.message;
        this.st.lastErrorAt = new Date().toISOString();
        this.log.error({ err: e.message, pending: this.queue.size, database: this.st.database }, 'database write failed; writes are kept and retried');
        if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, this.retryMs);
        this.retryMs = Math.min(30_000, this.retryMs * 2);
        throw new DatabaseUnavailableError(this.unavailableMessage());
      },
    ).finally(() => { this.flushing = undefined; });
    await this.flushing;
    if (this.queue.size) return this.flush();
  }

  private unavailableMessage() {
    return `The database could not be written (${this.st.lastError ?? 'unknown error'}). The change is kept in memory and retried, but it is not saved yet — it would be lost if the server restarted now.`;
  }

  private async write(ops: Op[]) {
    const recs = ops.filter((o): o is Extract<Op, { t: 'rec' }> => o.t === 'rec');
    const ups = recs.filter((o) => o.doc !== null);
    const dels = recs.filter((o) => o.doc === null);
    const docs = ops.filter((o): o is Extract<Op, { t: 'doc' }> => o.t === 'doc');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < ups.length; i += 500) {
        const c = ups.slice(i, i + 500);
        await client.query(
          `INSERT INTO sentinel_records (website_id, collection, id, doc, updated_at)
           SELECT w, c, i, d::jsonb, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(w, c, i, d)
           ON CONFLICT (website_id, collection, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
          [c.map((o) => o.scope), c.map((o) => o.coll), c.map((o) => o.id), c.map((o) => o.doc)],
        );
      }
      for (let i = 0; i < dels.length; i += 1000) {
        const c = dels.slice(i, i + 1000);
        await client.query(
          `DELETE FROM sentinel_records r USING unnest($1::text[], $2::text[], $3::text[]) AS t(w, c, i)
           WHERE r.website_id = t.w AND r.collection = t.c AND r.id = t.i`,
          [c.map((o) => o.scope), c.map((o) => o.coll), c.map((o) => o.id)],
        );
      }
      for (const d of docs) {
        await client.query(
          `INSERT INTO sentinel_documents (website_id, name, doc, updated_at) VALUES ($1, $2, $3::jsonb, now())
           ON CONFLICT (website_id, name) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
          [d.scope, d.name, d.doc],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------------------------------- repositories
  /** True when the database already holds data for this website (start-up: do not seed or reset it). */
  async hasData(scope: string): Promise<boolean> {
    const r = await this.read('SELECT 1 FROM sentinel_documents WHERE website_id = $1 LIMIT 1', [scope]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Repositories of one website, loaded from the database and written through to it. Shared collections (people,
   * credentials, sessions, permissions) use the shared scope.
   */
  async repositories(scope: string, now: Date, opts: { shared?: boolean } = {}): Promise<Repositories> {
    const self = this;
    const scopeOf = (name: string) => (SHARED_COLLECTIONS.has(name) ? SHARED_SCOPE : scope);
    const repos: InMemoryRepository<{ id: string }>[] = [];
    const docs: PersistentDocument<unknown>[] = [];
    const factory: RepositoryFactory = {
      repo<T extends { id: string }>(name: string) {
        const r = new PersistentRepository<T>(name, self, scopeOf(name));
        repos.push(r as unknown as InMemoryRepository<{ id: string }>);
        return r;
      },
      doc<T>(name: string, initial: T) {
        const d = new PersistentDocument<T>(initial, self, scopeOf(name), name);
        docs.push(d as unknown as PersistentDocument<unknown>);
        return d;
      },
      storage: { kind: 'postgres', persistent: true, note: `PostgreSQL (${this.st.database}): websites, crawls, page results, issues and settings are kept across restarts and redeploys.` },
    };
    const set = createInMemoryRepositories(now, factory);
    // Load: one query per collection (bounded memory per step).
    for (const r of repos) {
      if (opts.shared === false && SHARED_COLLECTIONS.has(r.name)) continue; // replaced by the primary website's shared repositories
      const res = await this.read<{ doc: { id: string } }>('SELECT doc FROM sentinel_records WHERE website_id = $1 AND collection = $2', [scopeOf(r.name), r.name]);
      r.hydrate(res.rows.map((x) => x.doc));
    }
    for (const d of docs) {
      if (opts.shared === false && SHARED_COLLECTIONS.has(d.name)) continue;
      const res = await this.read<{ doc: unknown }>('SELECT doc FROM sentinel_documents WHERE website_id = $1 AND name = $2', [d.scope, d.name]);
      if (res.rows[0]) d.hydrate(res.rows[0].doc);
    }
    return set;
  }

  // ------------------------------------------------------------------------------------------- websites
  async listWebsites<T>(): Promise<T[]> {
    const r = await this.read<{ doc: T }>('SELECT doc FROM sentinel_websites ORDER BY created_at, id', []);
    return r.rows.map((x) => x.doc);
  }
  async saveWebsite(w: { id: string }) {
    await this.pool.query(
      `INSERT INTO sentinel_websites (id, doc, created_at, updated_at) VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`,
      [w.id, json(w)],
    ).catch((e: Error) => { throw new DatabaseUnavailableError(`The website could not be saved: ${e.message}`); });
  }

  // ------------------------------------------------------------------------------------------- crawl page rows
  /** Replace a crawl's page rows (streamed in batches; never the whole crawl in one statement). */
  async saveCrawlRows(scope: string, runId: string, rows: AsyncIterable<unknown>): Promise<number> {
    const client = await this.pool.connect();
    let n = 0;
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM sentinel_crawl_rows WHERE website_id = $1 AND run_id = $2', [scope, runId]);
      let batch: string[] = [];
      const send = async (c: PoolClient) => {
        if (!batch.length) return;
        const start = n - batch.length;
        await c.query(
          `INSERT INTO sentinel_crawl_rows (website_id, run_id, seq, row)
           SELECT $1, $2, $3::int + o - 1, r::jsonb FROM unnest($4::text[]) WITH ORDINALITY AS t(r, o)`,
          [scope, runId, start, batch],
        );
        batch = [];
      };
      for await (const row of rows) {
        batch.push(json(row));
        n++;
        if (batch.length >= 1000) await send(client);
      }
      await send(client);
      await client.query('COMMIT');
      return n;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new DatabaseUnavailableError(`The page results of crawl ${runId} could not be saved: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  async hasCrawlRows(scope: string, runId: string): Promise<boolean> {
    const r = await this.read('SELECT 1 FROM sentinel_crawl_rows WHERE website_id = $1 AND run_id = $2 LIMIT 1', [scope, runId]);
    return (r.rowCount ?? 0) > 0;
  }
  /** A crawl's page rows in order, read in chunks. */
  async *crawlRows<T>(scope: string, runId: string): AsyncGenerator<T> {
    for (let from = 0; ; from += 2000) {
      const r = await this.read<{ row: T }>('SELECT row FROM sentinel_crawl_rows WHERE website_id = $1 AND run_id = $2 AND seq >= $3 AND seq < $4 ORDER BY seq', [scope, runId, from, from + 2000]);
      for (const x of r.rows) yield x.row;
      if (r.rows.length < 2000) return;
    }
  }
  /** Keep the page rows of these runs only (older crawls keep their summary, issues and findings). */
  async pruneCrawlRows(scope: string, keep: string[]) {
    await this.pool.query('DELETE FROM sentinel_crawl_rows WHERE website_id = $1 AND NOT (run_id = ANY($2::text[]))', [scope, keep]);
  }

  // ------------------------------------------------------------------------------------------- files
  async saveFile(scope: string, path: string, content: Buffer) {
    await this.pool.query(
      `INSERT INTO sentinel_files (website_id, path, content, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (website_id, path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [scope, path, content],
    );
  }
  async listFiles(scope: string, prefix: string): Promise<string[]> {
    const r = await this.read<{ path: string }>('SELECT path FROM sentinel_files WHERE website_id = $1 AND starts_with(path, $2)', [scope, prefix]);
    return r.rows.map((x) => x.path);
  }
  async readFile(scope: string, path: string): Promise<Buffer | undefined> {
    const r = await this.read<{ content: Buffer }>('SELECT content FROM sentinel_files WHERE website_id = $1 AND path = $2', [scope, path]);
    return r.rows[0]?.content;
  }
  async deleteFiles(scope: string, paths: string[]) {
    if (paths.length) await this.pool.query('DELETE FROM sentinel_files WHERE website_id = $1 AND path = ANY($2::text[])', [scope, paths]);
  }

  async close() {
    try { await this.flush(); } finally { await this.pool.end(); }
  }
}

class PersistentRepository<T extends { id: string }> extends InMemoryRepository<T> {
  constructor(name: string, private readonly p: Persistence, readonly scope: string) { super(name); }
  async insert(item: T) { const v = await super.insert(item); this.p.putRecord(this.scope, this.name, item.id, item); await this.p.drain(); return v; }
  async update(item: T) { const v = await super.update(item); this.p.putRecord(this.scope, this.name, item.id, item); await this.p.drain(); return v; }
  async upsert(item: T) { const v = await super.upsert(item); this.p.putRecord(this.scope, this.name, item.id, item); await this.p.drain(); return v; }
  async delete(id: string) { const had = await super.delete(id); if (had) { this.p.putRecord(this.scope, this.name, id, null); await this.p.drain(); } return had; }
}

class PersistentDocument<T> extends InMemoryDocument<T> {
  constructor(initial: T, private readonly p: Persistence, readonly scope: string, readonly name: string) { super(initial); }
  hydrate(v: T) { this.value = v; }
  async set(v: T) { const r = await super.set(v); this.p.putDocument(this.scope, this.name, v); return r; }
}

/**
 * Connects, waits for the database for up to `waitMs` (a sleeping / restarting database), and applies the migrations.
 * Throws a clear error instead of starting without the database.
 */
export async function openPersistence(o: { url: string; ssl?: 'auto' | 'require' | 'no-verify' | 'disable'; log: Logger; waitMs?: number; poolMax?: number }): Promise<Persistence> {
  const where = describeDatabaseUrl(o.url);
  const pool = new pg.Pool({ connectionString: o.url, ssl: sslFor(o.url, o.ssl), max: o.poolMax ?? 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, application_name: 'deodap-seo-sentinel' });
  pool.on('error', (e) => o.log.error({ err: e.message, database: where }, 'idle database connection error'));
  const deadline = Date.now() + (o.waitMs ?? 30_000);
  let last: Error | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      last = e as Error;
      if (Date.now() >= deadline) {
        await pool.end().catch(() => undefined);
        throw new Error(`Cannot connect to the PostgreSQL database at ${where}: ${last.message}. The API does not start without its database (it never falls back to temporary memory when DATABASE_URL is set). Check DATABASE_URL and DATABASE_SSL.`);
      }
      o.log.warn({ attempt, database: where, err: last.message }, 'database not reachable yet; retrying');
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * attempt)));
    }
  }
  await migrate(pool, o.log);
  o.log.info({ database: where }, 'PostgreSQL storage ready');
  return new Persistence(pool, o.log, where);
}

/** Applies pending migrations in order, once, under an advisory lock (two instances starting together are safe). */
export async function migrate(pool: Pool, log: Logger) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274001)');
    await client.query('CREATE TABLE IF NOT EXISTS sentinel_schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: number }>('SELECT version FROM sentinel_schema_migrations')).rows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        for (const sql of m.statements) await client.query(sql);
        await client.query('INSERT INTO sentinel_schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
        log.info({ version: m.version, name: m.name }, 'database migration applied');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Database migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274001)').catch(() => undefined);
    client.release();
  }
}
