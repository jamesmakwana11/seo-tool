/**
 * PostgreSQL integration-test helpers. Tests run only when TEST_DATABASE_URL points at a database the tests may write to
 * (each test gets its own schema, so nothing else in that database is touched). Example (local PostgreSQL):
 *
 *   TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/sentinel_test npm test -w @sentinel/api
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import supertest from 'supertest';
import { WEBSITE_HEADER } from '@sentinel/shared';
import { loadEnv } from '../../src/config/env';
import { createContainer, type Container } from '../../src/container';
import { createApp } from '../../src/http/app';
import { createLogger } from '../../src/lib/logger';
import { openPersistence, type Persistence } from '../../src/repositories/postgres/persistence';

export const DB_URL = process.env.TEST_DATABASE_URL;
export const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };

/** A new, empty schema in the test database; returns a connection URL that uses it. */
export async function freshDatabase(): Promise<{ url: string; schema: string; drop: () => Promise<void> }> {
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const pool = new Pool({ connectionString: DB_URL });
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.end();
  const u = new URL(DB_URL!);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return {
    url: u.toString(), schema,
    async drop() { const p = new Pool({ connectionString: DB_URL }); await p.query(`DROP SCHEMA ${schema} CASCADE`); await p.end(); },
  };
}

export async function sql(url: string, text: string, params: unknown[] = []) {
  const pool = new Pool({ connectionString: url });
  try { return await pool.query(text, params); } finally { await pool.end(); }
}

export interface Booted {
  container: Container;
  persistence: Persistence;
  agent: ReturnType<typeof supertest>;
  auth: Record<string, string>;
  /** Headers for one website (the X-Website-Id the web app sends). */
  site: (id: string) => Record<string, string>;
  /** Like an API process stopping (SIGTERM): crawls finish, queued writes are stored, the pool closes. */
  stop: () => Promise<void>;
}

/**
 * Starts the API the way server.ts does — database first, then every saved website — with an EMPTY disk each time
 * (new work and change-history folders), as on Render after a restart or redeploy.
 */
export async function boot(url: string, primaryUrl: string, extra: Record<string, string> = {}): Promise<Booted> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-boot-'));
  const env = loadEnv({
    NODE_ENV: 'test', SEED_DEMO_DATA: 'false', SESSION_SECRET: 'p'.repeat(40), LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password,
    CRAWLER_BASE_URL: primaryUrl, CRAWLER_ENGINE: 'go', CRAWLER_REQUEST_DELAY_MS: '0', CRAWLER_RETRIES: '0',
    CHANGE_SNAPSHOT_DIR: path.join(tmp, 'changes'), CRAWLER_WORK_DIR: path.join(tmp, 'work'), DATABASE_URL: url, ...extra,
  });
  const persistence = await openPersistence({ url, log: createLogger('silent'), waitMs: 2000 });
  const container = await createContainer({ env, persistence });
  const app = createApp(container);
  await (app.locals.ready as () => Promise<void>)();
  const agent = supertest(app);
  const login = await agent.post('/api/auth/login').send(ADMIN);
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const auth = { Authorization: `Bearer ${login.body.token}` };
  return {
    container, persistence, agent, auth,
    site: (id) => ({ ...auth, [WEBSITE_HEADER]: id }),
    async stop() {
      await container.services.crawls.idle();
      container.scheduler.stop();
      await persistence.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Waits until a crawl of one website has finished (any website, through the API like the web app). */
export async function waitForCrawl(b: Booted, siteId: string, runId: string, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await b.agent.get(`/api/crawls/${runId}`).set(b.site(siteId));
    const st = r.body?.run?.status;
    if (st && st !== 'running' && st !== 'queued') {
      // The crawl's last writes (run, issues, findings) are stored when it ends; wait for them too.
      await b.persistence.flush();
      return r.body.run;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`crawl ${runId} did not finish`);
    await new Promise((res) => setTimeout(res, 200));
  }
}

/** The API as a real separate process (`tsx src/server.ts`), as on Render: started, stopped with a signal, started again. */
export interface ServerProcess {
  port: number;
  /** Fetch an /api path with an optional bearer token. */
  api: (p: string, init?: RequestInit, token?: string) => Promise<Response>;
  /** Stop it: SIGTERM = redeploy / restart / idle stop (graceful), SIGKILL = crash. Resolves with the exit code. */
  stop: (signal?: NodeJS.Signals) => Promise<number | null>;
  output: () => string;
}

export async function startServerProcess(env: Record<string, string>, port: number): Promise<ServerProcess> {
  const { spawn } = await import('node:child_process');
  const root = path.resolve(__dirname, '../..');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: root, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise<number | null>((res) => child.once('exit', (c) => res(c)));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${out}`);
    if (i > 150) { child.kill('SIGKILL'); throw new Error(`server did not start: ${out}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    port,
    api: (p, init = {}, token) => fetch(`http://127.0.0.1:${port}/api${p}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers as Record<string, string> | undefined) } }),
    stop: async (signal = 'SIGTERM') => { if (child.exitCode === null) child.kill(signal); return exited; },
    output: () => out,
  };
}
