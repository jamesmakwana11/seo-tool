import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';

/**
 * Sign-in sessions last until the user signs out: no automatic expiry, and a server restart (in-memory sessions lost)
 * does not sign anyone out. Sign-out, a password change, a different SESSION_SECRET or a different account still end it.
 */
const ADMIN = { email: 'owner@example.com', password: 'Fixture-Pass-2026' };
const SECRET = 's'.repeat(40);

async function server(over: Record<string, string> = {}, start = new Date('2026-10-16T06:00:00Z')) {
  let now = start.getTime();
  const container = await createContainer({
    env: loadEnv({ NODE_ENV: 'test', SEED_TEST_FIXTURES: 'false', SESSION_SECRET: SECRET, LOG_LEVEL: 'silent', ADMIN_EMAIL: ADMIN.email, ADMIN_INITIAL_PASSWORD: ADMIN.password, ...over }),
    clock: () => new Date(now),
  });
  return { agent: supertest(createApp(container)), advance: (ms: number) => { now += ms; } };
}
const me = (s: { agent: supertest.Agent }, token: string) => s.agent.get('/api/auth/me').set({ Authorization: `Bearer ${token}` });
const DAY = 24 * 3600_000;

describe('sign-in sessions', () => {
  it('do not expire on their own', async () => {
    const s = await server();
    const login = await s.agent.post('/api/auth/login').send(ADMIN);
    expect(login.status).toBe(200);
    expect(login.body.expiresAt).toBeUndefined();
    s.advance(400 * DAY);
    expect((await me(s, login.body.token)).status).toBe(200);
  });

  it('survive a server restart and end at sign-out', async () => {
    const a = await server();
    const token = (await a.agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    // A new process: empty memory, same configuration.
    const b = await server({}, new Date('2026-10-20T06:00:00Z'));
    const r = await me(b, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.email).toBe(ADMIN.email);
    expect((await b.agent.post('/api/auth/logout').set({ Authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await me(b, token)).status).toBe(401);
    // Signed out on a restarted server without the session in memory: also refused.
    const c = await server();
    const t2 = (await c.agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    const d = await server();
    await d.agent.post('/api/auth/logout').set({ Authorization: `Bearer ${t2}` });
    expect((await me(d, t2)).status).toBe(401);
  });

  it('end when the password changes, the secret changes or the account is a different one', async () => {
    const a = await server();
    const token = (await a.agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    const changed = await a.agent.patch('/api/auth/profile').set({ Authorization: `Bearer ${token}` }).send({ currentPassword: ADMIN.password, newPassword: 'Another-Pass-2027' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await me(a, token)).status).toBe(401);

    const b = await server();
    const t2 = (await b.agent.post('/api/auth/login').send(ADMIN)).body.token as string;
    expect((await me(await server({ SESSION_SECRET: 'x'.repeat(40) }), t2)).status).toBe(401);
    // Same employee id after a restart, but set up with another password: not the same account.
    expect((await me(await server({ ADMIN_INITIAL_PASSWORD: 'Different-Pass-2026' }), t2)).status).toBe(401);
    expect((await me(b, 'not-a-token')).status).toBe(401);
  });

  it('can still be capped with SESSION_TTL_HOURS', async () => {
    const s = await server({ SESSION_TTL_HOURS: '2' });
    const login = await s.agent.post('/api/auth/login').send(ADMIN);
    expect(login.body.expiresAt).toBe('2026-10-16T08:00:00.000Z');
    s.advance(3 * 3600_000);
    expect((await me(s, login.body.token)).status).toBe(401);
  });
});
