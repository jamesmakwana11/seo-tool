import { PREVIEW_USER_BY_ROLE, ROLE_LABELS, type AuthResult, type Role, type SessionUser } from '@sentinel/shared';
import { ApiError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { hashPassword, passwordPolicyError, randomToken, sha256, signToken, verifyPassword, verifyToken } from '../lib/passwords';
import { emailTransportReady } from '../notifications/adapters';
import { actorFromEmployee, audit, toSessionUser, SYSTEM_ACTOR, type Actor, type Ctx } from './context';

interface TokenPayload { sid: string; sub: string; exp: number }

/**
 * TEMPORARY development authentication (Phase 2): credentials and sessions live in the in-memory
 * repositories and are lost on restart. Passwords are scrypt-hashed; sessions are HMAC-signed tokens
 * backed by a revocable session record. Not production SSO.
 */
export function createAuthService(ctx: Ctx) {
  const r = ctx.repos;
  /** Attach server data provenance so every screen can label DEMO data honestly. */
  const withEnv = async (u: SessionUser): Promise<SessionUser> => ({ ...u, serverDemoData: (await r.metrics.get()).source === 'demo' });

  async function issue(employeeId: string, demo: boolean): Promise<AuthResult> {
    const e = (await r.employees.get(employeeId))!;
    const now = ctx.clock();
    const expiresAt = new Date(now.getTime() + ctx.env.SESSION_TTL_HOURS * 3600_000);
    const sid = randomToken(18);
    await r.sessions.insert({ id: sid, employeeId, demo, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
    const token = signToken({ sid, sub: employeeId, exp: expiresAt.getTime() } satisfies TokenPayload, ctx.sessionSecret);
    e.lastActiveAt = now.toISOString();
    await r.employees.update(e);
    return { token, user: await withEnv(toSessionUser(e, await r.permissions.get(), demo)), expiresAt: expiresAt.toISOString() };
  }

  return {
    async login(email: string, password: string): Promise<AuthResult> {
      if (!email || !password) throw badRequest('Email and password are required.');
      const cred = await r.credentials.get(email.trim().toLowerCase());
      const ok = cred ? await verifyPassword(password, cred.hash, cred.salt) : false;
      if (!cred || !ok) {
        await audit(ctx, SYSTEM_ACTOR, 'auth.login_failed', 'auth', email.trim().toLowerCase(), 'Failed sign-in attempt');
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      }
      const e = await r.employees.get(cred.employeeId);
      if (!e) throw unauthorized();
      if (e.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', `This account is ${e.status}. Ask an admin to activate it.`);
      const res = await issue(e.id, false);
      await audit(ctx, actorFromEmployee(e, await r.permissions.get(), false), 'auth.login', 'auth', e.id, `${e.name} signed in`);
      return res;
    },

    /** DEVELOPMENT ONLY role preview (prompt §4.3). Refused unless ALLOW_DEV_ROLE_PREVIEW and not production. */
    async previewAs(role: Role): Promise<AuthResult> {
      if (!ctx.env.ALLOW_DEV_ROLE_PREVIEW || ctx.env.NODE_ENV === 'production') throw forbidden('Development role preview is disabled on this server.');
      if (!ROLE_LABELS[role]) throw badRequest('Unknown role.');
      const e = await r.employees.get(PREVIEW_USER_BY_ROLE[role]);
      if (!e || e.status !== 'active') throw conflict(`No active preview user for ${ROLE_LABELS[role]} (DEMO data not loaded?).`, 'PREVIEW_USER_MISSING');
      const res = await issue(e.id, true);
      await audit(ctx, actorFromEmployee(e, await r.permissions.get(), true), 'auth.preview', 'auth', e.id, `DEVELOPMENT role preview as ${ROLE_LABELS[role]} (${e.name})`);
      return res;
    },

    async logout(token: string | undefined) {
      if (!token) return;
      const p = verifyToken<TokenPayload>(token, ctx.sessionSecret);
      if (!p) return;
      const sess = await r.sessions.get(p.sid);
      if (sess && !sess.revokedAt) await r.sessions.update({ ...sess, revokedAt: ctx.clock().toISOString() });
    },

    /** Resolve a bearer token to an Actor; throws 401 when invalid/expired/revoked/inactive. */
    async authenticate(token: string | undefined): Promise<{ actor: Actor; user: SessionUser }> {
      if (!token) throw unauthorized();
      const p = verifyToken<TokenPayload>(token, ctx.sessionSecret);
      if (!p || p.exp < ctx.clock().getTime()) throw unauthorized('Your session has expired. Sign in again.');
      const sess = await r.sessions.get(p.sid);
      if (!sess || sess.revokedAt || sess.employeeId !== p.sub) throw unauthorized('Your session is no longer valid.');
      const e = await r.employees.get(p.sub);
      if (!e || e.status !== 'active') throw unauthorized('Your account is not active.');
      const matrix = await r.permissions.get();
      return { actor: actorFromEmployee(e, matrix, sess.demo), user: await withEnv(toSessionUser(e, matrix, sess.demo)) };
    },

    async requestPasswordReset(email: string) {
      const key = (email ?? '').trim().toLowerCase();
      const cred = key ? await r.credentials.get(key) : undefined;
      // Known and unknown emails get the same answer, so the response never reveals which accounts exist.
      const emailReady = emailTransportReady(ctx.env);
      const generic = { sent: false, emailConfigured: true, note: 'If an account exists for this email, a reset link has been sent to it.' };
      const noEmail = { sent: false, emailConfigured: false, note: 'This server cannot send email yet (SMTP is not configured), so no reset link was sent. Contact your administrator.' };
      if (!cred) return emailReady ? generic : noEmail;
      const token = randomToken(24);
      await r.resetTokens.upsert({ id: sha256(token), email: key, expiresAt: new Date(ctx.clock().getTime() + 3600_000).toISOString() });
      await audit(ctx, SYSTEM_ACTOR, 'auth.reset_requested', 'auth', cred.employeeId, 'Password reset requested');
      if (emailReady) {
        const link = ctx.env.APP_BASE_URL ? `${ctx.env.APP_BASE_URL.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}` : undefined;
        // Sent to the account owner ONLY — never to the digest list.
        const attempts = await ctx.delivery.deliver('allocation', ['email'], {
          to: [key],
          subject: 'Reset your DeoDap SEO Sentinel password',
          text: link ? 'Use the link below within 1 hour to choose a new password. If you did not ask for this, ignore this email.' : `Use this one-time reset token within 1 hour: ${token}`,
          links: link ? [{ label: 'Choose a new password', url: link }] : undefined,
        });
        return { ...generic, sent: attempts.some((a) => a.outcome === 'delivered') };
      }
      if (ctx.env.DEV_EXPOSE_RESET_TOKEN && ctx.env.NODE_ENV !== 'production') {
        return { ...noEmail, devResetToken: token, note: 'Email is not configured on this server. DEVELOPMENT ONLY: use the reset link below.' };
      }
      return noEmail;
    },

    async resetPassword(token: string, newPassword: string) {
      const rec = token ? await r.resetTokens.get(sha256(token)) : undefined;
      if (!rec || rec.usedAt || new Date(rec.expiresAt) < ctx.clock()) throw badRequest('This reset link is invalid or has expired.', undefined, 'INVALID_TOKEN');
      const err = passwordPolicyError(newPassword ?? '');
      if (err) throw badRequest(err, undefined, 'WEAK_PASSWORD');
      const cred = (await r.credentials.get(rec.email))!;
      const { hash, salt } = await hashPassword(newPassword);
      await r.credentials.update({ ...cred, hash, salt, updatedAt: ctx.clock().toISOString() });
      await r.resetTokens.update({ ...rec, usedAt: ctx.clock().toISOString() });
      // Revoke existing sessions for this user.
      for (const sess of await r.sessions.where({ employeeId: cred.employeeId })) if (!sess.revokedAt) await r.sessions.update({ ...sess, revokedAt: ctx.clock().toISOString() });
      await audit(ctx, SYSTEM_ACTOR, 'auth.reset', 'auth', cred.employeeId, 'Password reset completed; sessions revoked');
      return { ok: true as const };
    },

    async updateProfile(actor: Actor, input: { name?: string; title?: string; currentPassword?: string; newPassword?: string }, demo: boolean): Promise<SessionUser> {
      const e = await r.employees.get(actor.id);
      if (!e) throw unauthorized();
      if (input.newPassword !== undefined) {
        const cred = (await r.credentials.get(e.email.toLowerCase()))!;
        if (!input.currentPassword || !(await verifyPassword(input.currentPassword, cred.hash, cred.salt))) throw badRequest('Current password is incorrect.', undefined, 'INVALID_CREDENTIALS');
        const err = passwordPolicyError(input.newPassword);
        if (err) throw badRequest(err, undefined, 'WEAK_PASSWORD');
        const { hash, salt } = await hashPassword(input.newPassword);
        await r.credentials.update({ ...cred, hash, salt, updatedAt: ctx.clock().toISOString() });
      }
      if (input.name !== undefined) {
        if (input.name.trim().length < 2) throw badRequest('Name is required.');
        e.name = input.name.trim();
      }
      if (input.title !== undefined) e.title = input.title.trim();
      await r.employees.update(e);
      await audit(ctx, actor, 'employee.profile_update', 'employee', e.id, 'Updated own profile');
      return withEnv(toSessionUser(e, await r.permissions.get(), demo));
    },

    /** Create credentials for a newly invited employee and send (or expose in dev) a set-password token. */
    async provisionCredential(employeeId: string, email: string) {
      const { hash, salt } = await hashPassword(randomToken(24));
      await r.credentials.upsert({ id: email.toLowerCase(), employeeId, hash, salt, updatedAt: ctx.clock().toISOString() });
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;
