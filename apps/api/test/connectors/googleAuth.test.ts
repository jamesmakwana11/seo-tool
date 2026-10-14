import { createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoogleAuth, GOOGLE_TOKEN_URL, parseServiceAccount, signServiceAccountJwt } from '../../src/connectors/googleAuth';
import { json, mockFetch, rsaKeys, serviceAccountJson } from './helpers';

describe('Google service-account JWT', () => {
  it('signs a verifiable RS256 JWT with the right claims', () => {
    const sa = parseServiceAccount(serviceAccountJson());
    if ('error' in sa) throw new Error(sa.error);
    const jwt = signServiceAccountJwt(sa, 'https://www.googleapis.com/auth/webmasters.readonly', 1_760_000_000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: 'sentinel@deodap-seo.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
      aud: GOOGLE_TOKEN_URL,
      iat: 1_760_000_000,
      exp: 1_760_003_600,
    });
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${c}`);
    expect(v.verify(rsaKeys().publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('accepts base64-encoded JSON; rejects JSON without key material', () => {
    expect('client_email' in parseServiceAccount(Buffer.from(serviceAccountJson()).toString('base64'))).toBe(true);
    expect(parseServiceAccount('{"client_email":"a@b"}')).toEqual({ error: expect.stringMatching(/private_key/) });
  });

  it('posts the assertion to the token endpoint and caches the token until expiry', async () => {
    let now = new Date('2026-10-12T00:00:00Z');
    const f = mockFetch(() => json(200, { access_token: 'tok-1', expires_in: 3600 }));
    const auth = createGoogleAuth({ fetchImpl: f, clock: () => now });
    const sa = parseServiceAccount(serviceAccountJson()) as { client_email: string; private_key: string };
    expect(await auth.serviceAccountToken(sa, 'scope-a')).toEqual({ ok: true, accessToken: 'tok-1' });
    expect(f.calls[0].url).toBe(GOOGLE_TOKEN_URL);
    expect(f.calls[0].init?.method).toBe('POST');
    expect(f.calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(f.calls[0].body);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')?.split('.')).toHaveLength(3);

    await auth.serviceAccountToken(sa, 'scope-a');
    expect(f.calls).toHaveLength(1); // cached
    await auth.serviceAccountToken(sa, 'scope-b');
    expect(f.calls).toHaveLength(2); // different scope
    now = new Date(now.getTime() + 3600_000);
    await auth.serviceAccountToken(sa, 'scope-a');
    expect(f.calls).toHaveLength(3); // expired
  });

  it('a malformed private key fails without a request', async () => {
    const f = mockFetch(() => json(200, {}));
    const r = await createGoogleAuth({ fetchImpl: f }).serviceAccountToken({ client_email: 'x@y', private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }, 's');
    expect(r).toMatchObject({ ok: false });
    expect(f.calls).toHaveLength(0);
  });

  it('token response without access_token is a failure', async () => {
    const f = mockFetch(() => json(200, { token_type: 'Bearer' }));
    const r = await createGoogleAuth({ fetchImpl: f }).refreshTokenAccess('id', 'secret', 'rt');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no access_token/) });
  });
});
