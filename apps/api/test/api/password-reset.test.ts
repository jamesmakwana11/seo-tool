import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env';
import { createContainer } from '../../src/container';
import { createApp } from '../../src/http/app';
import { FIXTURE, failingFetch } from './helpers';

const SMTP = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'sentinel@example.com' };

async function harness(extra: Record<string, string>) {
  const sent: { to: string; text: string; html?: string }[] = [];
  const env = loadEnv({ NODE_ENV: 'test', SEED_TEST_FIXTURES: 'true', SESSION_SECRET: 'test-secret-value-at-least-32-chars-long!!', LOG_LEVEL: 'silent', ...extra });
  const container = await createContainer({
    env, fetchImpl: failingFetch,
    mailTransport: () => ({ verify: async () => true, sendMail: async (m: { to: string; text: string; html?: string }) => { sent.push(m); return { messageId: '<id@x>', accepted: [m.to] }; } }),
  });
  return { agent: supertest(createApp(container)), sent };
}

describe('password reset delivery', () => {
  it('emails the reset link to the account owner only — never to the digest recipients', async () => {
    const h = await harness({ ...SMTP, DIGEST_RECIPIENTS: 'digest-reader@example.com', APP_BASE_URL: 'https://sentinel.example.com' });
    const res = await h.agent.post('/api/auth/request-reset').send({ email: FIXTURE.developer });
    expect(res.body).toMatchObject({ sent: true, emailConfigured: true });
    expect(res.body.devResetToken).toBeUndefined();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(FIXTURE.developer);
    expect(h.sent[0].to).not.toContain('digest-reader');
    expect(h.sent[0].html).toContain('https://sentinel.example.com/reset-password?token=');
  });

  it('works without a digest list configured', async () => {
    const h = await harness(SMTP);
    const res = await h.agent.post('/api/auth/request-reset').send({ email: FIXTURE.admin });
    expect(res.body.sent).toBe(true);
    expect(h.sent.map((m) => m.to)).toEqual([FIXTURE.admin]);
  });

  it('gives the same answer for unknown emails and sends nothing', async () => {
    const h = await harness(SMTP);
    const known = await h.agent.post('/api/auth/request-reset').send({ email: FIXTURE.admin });
    const unknown = await h.agent.post('/api/auth/request-reset').send({ email: 'nobody@example.com' });
    expect(unknown.body.note).toBe(known.body.note);
    expect(unknown.body.emailConfigured).toBe(true);
    expect(h.sent.map((m) => m.to)).toEqual([FIXTURE.admin]);
  });

  it('says plainly that no email was sent when SMTP is not configured (production)', async () => {
    const h = await harness({ NODE_ENV: 'production', SEED_TEST_FIXTURES: 'false', ALLOW_EPHEMERAL_STORAGE: 'true', ADMIN_EMAIL: 'owner@example.com', ADMIN_INITIAL_PASSWORD: 'Initial-Pass-2026' });
    const known = await h.agent.post('/api/auth/request-reset').send({ email: 'owner@example.com' });
    const unknown = await h.agent.post('/api/auth/request-reset').send({ email: 'nobody@example.com' });
    for (const r of [known, unknown]) {
      expect(r.body).toMatchObject({ sent: false, emailConfigured: false });
      expect(r.body.note).toMatch(/no reset link was sent/);
      expect(r.body.devResetToken).toBeUndefined();
    }
  });
});
