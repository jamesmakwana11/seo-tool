import { describe, expect, it } from 'vitest';
import type { IntegrationId } from '@sentinel/shared';
import { createConnectors, type MailTransportFactory } from '../../src/connectors/connectors';
import { createGoogleAuth } from '../../src/connectors/googleAuth';
import { emptyEnv, expectNoSecrets, json, makeEnv, mockFetch, networkError, text, type Responder } from './helpers';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const googleToken = () => json(200, { access_token: 'ya29.access-token-SECRET', expires_in: 3600, token_type: 'Bearer' });

/** Successful provider responses per connector (URL-matched). */
const SUCCESS: Record<Exclude<IntegrationId, 'email'>, Responder> = {
  crawler: () => text(200, 'User-agent: *\nDisallow: /cart\nSitemap: https://deodap.in/sitemap.xml\n'),
  gsc: (url) => (url === TOKEN_URL ? googleToken() : json(200, { siteEntry: [{ siteUrl: 'https://deodap.in/', permissionLevel: 'siteOwner' }] })),
  ga4: (url) => (url === TOKEN_URL ? googleToken() : json(200, { name: 'properties/123456789', displayName: 'DeoDap Web' })),
  psi_crux: () => json(200, { record: { key: { origin: 'https://deodap.in' }, metrics: {} } }),
  backlinks: () => json(200, { limits_and_usage: { subscription: 'Advanced', units_limit_api_key: 100000, units_usage_api_key: 2500 } }),
  shopify: () => json(200, { shop: { name: 'DeoDap', myshopify_domain: 'deodap.myshopify.com' } }),
  gbp: (url) => (url === TOKEN_URL ? googleToken() : json(200, { accounts: [{ name: 'accounts/1', accountName: 'DeoDap' }] })),
  openai: () => json(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }),
  gemini: () => json(200, { models: [{ name: 'models/gemini-1.5-flash' }] }),
  perplexity: () => json(200, { id: 'x', choices: [{ message: { content: 'p' } }] }),
  whatsapp: () => json(200, { id: '1098765432', display_phone_number: '+91 90000 00000', verified_name: 'DeoDap', quality_rating: 'GREEN' }),
  slack: () => text(200, 'ok'),
  task_ops: () => json(200, { data: [] }),
};

const GOOGLE_OAUTH = new Set<IntegrationId>(['gsc', 'ga4', 'gbp']);

/** Same response for the API call; Google token endpoint still succeeds so the API call itself is exercised. */
const always = (id: IntegrationId, res: () => Response): Responder => (url) => (GOOGLE_OAUTH.has(id) && url === TOKEN_URL ? googleToken() : res());

function connector(id: IntegrationId, responder: Responder, env = makeEnv(), mail?: MailTransportFactory) {
  const f = mockFetch(responder);
  const c = createConnectors(env, f, { mailTransport: mail, googleAuth: createGoogleAuth({ fetchImpl: f }) }).find((x) => x.id === id)!;
  return { c, f };
}

const HTTP_IDS = Object.keys(SUCCESS) as Exclude<IntegrationId, 'email'>[];

describe('connectors — common contract', () => {
  it('exposes all 14 catalog integrations', () => {
    expect(createConnectors(emptyEnv()).map((c) => c.id).sort()).toEqual([...HTTP_IDS, 'email'].sort());
  });

  for (const id of [...HTTP_IDS, 'email' as const]) {
    describe(id, () => {
      it('is not configured with an empty env and test() makes no request', async () => {
        const f = mockFetch(() => json(200, {}));
        const c = createConnectors(emptyEnv(), f).find((x) => x.id === id)!;
        expect(c.isConfigured()).toBe(false);
        const r = await c.test();
        expect(r.ok).toBe(false);
        expect(r.result).toMatch(/Not configured/);
        expect(f.calls).toHaveLength(0);
      });
    });
  }

  for (const id of HTTP_IDS) {
    describe(id, () => {
      it('success → ok (real response parsed)', async () => {
        const { c, f } = connector(id, SUCCESS[id]);
        expect(c.isConfigured()).toBe(true);
        const r = await c.test();
        expect(r).toMatchObject({ ok: true });
        expect(r.partial).toBeFalsy();
        expect(r.rateLimited).toBeFalsy();
        expect(f.calls.length).toBeGreaterThan(0);
        expectNoSecrets(r.result);
      });

      it('401 → not ok "credentials rejected"', async () => {
        const { c } = connector(id, always(id, () => json(401, { error: { message: `Invalid token sk-SECRET-openai-abcdef` } })));
        const r = await c.test();
        expect(r.ok).toBe(false);
        expect(r.result).toMatch(/credentials rejected/);
        expectNoSecrets(r.result);
      });

      it('429 → rateLimited', async () => {
        const { c } = connector(id, always(id, () => json(429, { error: { message: 'Too many requests' } })));
        const r = await c.test();
        expect(r.ok).toBe(false);
        expect(r.rateLimited).toBe(true);
        expectNoSecrets(r.result);
      });

      it('network error → failed "could not reach host", no secrets from the URL', async () => {
        const { c } = connector(id, (url) => networkError(url));
        const r = await c.test();
        expect(r.ok).toBe(false);
        expect(r.result).toMatch(/could not reach host|token exchange/);
        expectNoSecrets(r.result);
      });
    });
  }
});

describe('connector specifics', () => {
  it('crawler sends the crawler UA to /robots.txt and reports 403 bot-protection blocks clearly', async () => {
    const { c, f } = connector('crawler', () => text(403, 'Forbidden'));
    const r = await c.test();
    expect(f.calls[0].url).toBe('https://deodap.in/robots.txt');
    expect(f.calls[0].headers['user-agent']).toBe('DeoDapSentinelBot/1.0');
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/BLOCKED \(HTTP 403\).*bot protection/);
  });

  it('crawler requires CRAWLER_ALLOW_LIVE for a live site but not for localhost', () => {
    expect(connector('crawler', SUCCESS.crawler, makeEnv({ CRAWLER_ALLOW_LIVE: 'false' })).c.isConfigured()).toBe(false);
    expect(connector('crawler', SUCCESS.crawler, makeEnv({ CRAWLER_ALLOW_LIVE: 'false', CRAWLER_BASE_URL: 'http://localhost:8080' })).c.isConfigured()).toBe(true);
  });

  it('gsc: posts a signed JWT to the token endpoint and requires siteOwner (else partial)', async () => {
    const { c, f } = connector('gsc', (url) => (url === TOKEN_URL ? googleToken() : json(200, { siteEntry: [{ siteUrl: 'https://deodap.in/', permissionLevel: 'siteFullUser' }] })));
    const r = await c.test();
    expect(f.calls[0].url).toBe(TOKEN_URL);
    expect(f.calls[0].body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(f.calls[1].url).toBe('https://www.googleapis.com/webmasters/v3/sites');
    expect(f.calls[1].headers.authorization).toBe('Bearer ya29.access-token-SECRET');
    expect(r).toMatchObject({ ok: true, partial: true });
    expect(r.result).toMatch(/Owner/);
  });

  it('gsc: property not listed → not ok', async () => {
    const { c } = connector('gsc', (url) => (url === TOKEN_URL ? googleToken() : json(200, { siteEntry: [{ siteUrl: 'sc-domain:other.com', permissionLevel: 'siteOwner' }] })));
    const r = await c.test();
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/not visible/);
  });

  it('gsc: token endpoint invalid_grant → credentials rejected; malformed JSON → clear error', async () => {
    const bad = connector('gsc', () => json(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }));
    expect((await bad.c.test()).result).toMatch(/credentials rejected by Google token endpoint/);
    const malformed = connector('gsc', SUCCESS.gsc, makeEnv({ GSC_SERVICE_ACCOUNT_JSON: '{not json' }));
    const r = await malformed.c.test();
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/could not be parsed/);
    expect(malformed.f.calls).toHaveLength(0);
  });

  it('psi_crux: 404 "data not found" → partial ok; key redacted from URL', async () => {
    const { c, f } = connector('psi_crux', () => json(404, { error: { code: 404, message: 'chrome ux report data not found' } }));
    const r = await c.test();
    expect(r).toMatchObject({ ok: true, partial: true });
    expect(f.calls[0].url).toContain('records:queryRecord?key=');
    expect(JSON.parse(f.calls[0].body!)).toEqual({ origin: 'https://deodap.in' });
    expectNoSecrets(r.result);
  });

  it('backlinks: semrush reports remaining paid units; zero units → partial', async () => {
    const env = makeEnv({ BACKLINK_PROVIDER: 'semrush' });
    const ok = connector('backlinks', () => text(200, '48210'), env);
    const r = await ok.c.test();
    expect(r).toMatchObject({ ok: true });
    expect(r.result).toMatch(/48210 paid API units remaining/);
    expect(ok.f.calls[0].url).toMatch(/^https:\/\/www\.semrush\.com\/users\/countapiunits\.html\?key=/);
    expectNoSecrets(r.result);
    const zero = await connector('backlinks', () => text(200, '0'), env).c.test();
    expect(zero).toMatchObject({ ok: true, partial: true });
    const wrong = await connector('backlinks', () => text(200, 'ERROR 120 :: WRONG KEY - ID PAIR'), env).c.test();
    expect(wrong.result).toMatch(/credentials rejected/);
  });

  it('backlinks: ahrefs only needs the ahrefs token', () => {
    const env = makeEnv({ SEMRUSH_API_KEY: undefined });
    expect(connector('backlinks', SUCCESS.backlinks, env).c.isConfigured()).toBe(true);
    expect(connector('backlinks', SUCCESS.backlinks, makeEnv({ AHREFS_API_TOKEN: undefined })).c.isConfigured()).toBe(false);
  });

  it('shopify: uses X-Shopify-Access-Token and the configured API version; no webhook secret → partial', async () => {
    const { c, f } = connector('shopify', SUCCESS.shopify, makeEnv({ SHOPIFY_WEBHOOK_SECRET: undefined }));
    const r = await c.test();
    expect(f.calls[0].url).toBe('https://deodap.myshopify.com/admin/api/2026-07/shop.json');
    expect(f.calls[0].headers['x-shopify-access-token']).toBe('shpat_SECRET_abcdef123456');
    expect(r).toMatchObject({ ok: true, partial: true });
    expect(r.result).toContain('"DeoDap"');
  });

  it('gbp: refresh-token exchange then accounts list', async () => {
    const { c, f } = connector('gbp', SUCCESS.gbp);
    await c.test();
    expect(f.calls[0].body).toContain('grant_type=refresh_token');
    expect(f.calls[1].url).toBe('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  });

  it('perplexity: one minimal "sonar" request with max_tokens 1', async () => {
    const { c, f } = connector('perplexity', SUCCESS.perplexity);
    await c.test();
    expect(JSON.parse(f.calls[0].body!)).toMatchObject({ model: 'sonar', max_tokens: 1 });
  });

  it('whatsapp: Graph error code 190 in a 400 → credentials rejected', async () => {
    const r = await connector('whatsapp', () => json(400, { error: { code: 190, message: 'Invalid OAuth access token.' } })).c.test();
    expect(r.result).toMatch(/credentials rejected/);
  });

  it('slack: posts a "Sentinel connection test" message; 404 no_service → credentials rejected; hook path redacted', async () => {
    const ok = connector('slack', SUCCESS.slack);
    await ok.c.test();
    expect(JSON.parse(ok.f.calls[0].body!).text).toMatch(/Sentinel connection test/);
    const r = await connector('slack', () => text(404, 'no_service')).c.test();
    expect(r.result).toMatch(/credentials rejected/);
    expectNoSecrets(r.result);
  });

  it('task_ops: falls back to /health when /api/tasks is 404 → partial', async () => {
    const { c, f } = connector('task_ops', (url) => (url.endsWith('/health') ? json(200, { status: 'ok' }) : json(404, {})));
    const r = await c.test();
    expect(f.calls.map((x) => x.url)).toEqual(['https://tasks.deodap.test/api/tasks?limit=1', 'https://tasks.deodap.test/health']);
    expect(f.calls[0].headers.authorization).toBe('Bearer taskops-SECRET-token');
    expect(r).toMatchObject({ ok: true, partial: true });
  });

  it('task_ops: 500 → failed', async () => {
    const r = await connector('task_ops', () => json(500, {})).c.test();
    expect(r).toMatchObject({ ok: false });
    expect(r.result).toMatch(/HTTP 500/);
  });
});

describe('email connector (SMTP verify)', () => {
  const mail = (verify: () => Promise<unknown>) => {
    const seen: unknown[] = [];
    const factory: MailTransportFactory = (opts) => {
      seen.push(opts);
      return { verify, sendMail: async () => ({ messageId: 'x' }) };
    };
    return { factory, seen };
  };
  const smtpErr = (props: Record<string, unknown>) => () => Promise.reject(Object.assign(new Error(String(props.message ?? 'smtp error')), props));

  it('success → ok; secure only on 465', async () => {
    const m = mail(async () => true);
    const r = await connector('email', SUCCESS.slack, makeEnv(), m.factory).c.test();
    expect(r.ok).toBe(true);
    expect(m.seen[0]).toMatchObject({ host: 'smtp.example.test', port: 587, secure: false });
    const m465 = mail(async () => true);
    await connector('email', SUCCESS.slack, makeEnv({ SMTP_PORT: '465' }), m465.factory).c.test();
    expect(m465.seen[0]).toMatchObject({ secure: true });
  });

  it('EAUTH → credentials rejected (password never echoed)', async () => {
    const r = await connector('email', SUCCESS.slack, makeEnv(), mail(smtpErr({ code: 'EAUTH', responseCode: 535, message: 'Invalid login: 535 bad creds smtp-SECRET-password' })).factory).c.test();
    expect(r.ok).toBe(false);
    expect(r.result).toMatch(/credentials rejected/);
    expectNoSecrets(r.result);
  });

  it('421 too many connections → rateLimited', async () => {
    const r = await connector('email', SUCCESS.slack, makeEnv(), mail(smtpErr({ responseCode: 421, message: '421 Too many connections' })).factory).c.test();
    expect(r.rateLimited).toBe(true);
  });

  it('network error → could not reach host', async () => {
    const r = await connector('email', SUCCESS.slack, makeEnv(), mail(smtpErr({ code: 'ECONNECTION', message: 'connect ECONNREFUSED 10.0.0.1:587' })).factory).c.test();
    expect(r.result).toMatch(/could not reach host smtp\.example\.test/);
  });

  it('missing DIGEST_RECIPIENTS → not configured', () => {
    expect(connector('email', SUCCESS.slack, makeEnv({ DIGEST_RECIPIENTS: undefined })).c.isConfigured()).toBe(false);
  });
});
