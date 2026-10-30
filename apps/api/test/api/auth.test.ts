import { describe, expect, it } from 'vitest';
import { FIXTURE, makeHarness } from './helpers';

describe('auth & sessions', () => {
  it('rejects bad credentials with 401 INVALID_CREDENTIALS', async () => {
    const h = await makeHarness();
    const res = await h.agent.post('/api/auth/login').send({ email: FIXTURE.admin, password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.body.requestId).toBeTruthy();
  });

  it('signs in and returns a usable bearer token', async () => {
    const h = await makeHarness();
    const tok = await h.token(FIXTURE.admin);
    const me = await h.as(tok).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('super_admin');
    // The session carries the account only (no preview or sample-data flags).
    for (const k of Object.keys(me.body)) expect(['id', 'name', 'email', 'role', 'teamIds', 'isSeoLead', 'permissions']).toContain(k);
  });

  it('never exposes a password hash or salt in any response', async () => {
    const h = await makeHarness();
    const tok = await h.token(FIXTURE.admin);
    const res = await h.as(tok).get('/api/employees');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/"hash"|"salt"/);
  });

  it('revokes the session on logout', async () => {
    const h = await makeHarness();
    const tok = await h.token(FIXTURE.admin);
    await h.as(tok).post('/api/auth/logout');
    const after = await h.as(tok).get('/api/auth/me');
    expect(after.status).toBe(401);
  });

  it('password reset: dev token issued when no email provider, and it rotates the password', async () => {
    const h = await makeHarness();
    const req = await h.agent.post('/api/auth/request-reset').send({ email: FIXTURE.developer });
    expect(req.body.sent).toBe(false);
    expect(req.body.devResetToken).toBeTruthy();
    const reset = await h.agent.post('/api/auth/reset').send({ token: req.body.devResetToken, newPassword: 'NewPass123!' });
    expect(reset.status).toBe(200);
    expect((await h.agent.post('/api/auth/login').send({ email: FIXTURE.developer, password: FIXTURE.password })).status).toBe(401);
    expect((await h.agent.post('/api/auth/login').send({ email: FIXTURE.developer, password: 'NewPass123!' })).status).toBe(200);
  });

  it('request-reset gives the same response for an unknown email (no account enumeration)', async () => {
    const h = await makeHarness();
    const res = await h.agent.post('/api/auth/request-reset').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(false);
    expect(res.body.devResetToken).toBeUndefined();
  });

  it('has no role-preview sign-in (password sign-in only)', async () => {
    const h = await makeHarness();
    const res = await h.agent.post('/api/auth/preview').send({ role: 'admin' });
    expect(res.status).toBe(404);
    expect(res.body.token).toBeUndefined();
  });
});
