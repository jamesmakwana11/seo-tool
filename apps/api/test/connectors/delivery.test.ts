import { describe, expect, it } from 'vitest';
import { createDeliveryAdapters, createSlackAdapter, createWhatsAppAdapter, createEmailAdapter, slackPayload } from '../../src/notifications/adapters';
import { createDeliveryService } from '../../src/notifications/delivery';
import { createInMemoryRepositories } from '../../src/repositories/memory/inMemory';
import type { MailTransportFactory } from '../../src/connectors/connectors';
import type { DeliveryChannelAdapter, OutboundMessage, SendResult } from '../../src/services/ports';
import { emptyEnv, expectNoSecrets, json, makeEnv, mockFetch, networkError, silentLog, text } from './helpers';

const clock = () => new Date('2026-10-12T02:30:00.000Z');
const msg: OutboundMessage = {
  subject: 'Critical: robots.txt changed',
  text: 'robots.txt now disallows /collections/.',
  links: [{ label: 'Allocate to SEO', url: 'https://sentinel.deodap.test/issues/ISS-0001?allocate=seo' }],
};
const noDelay = { attempts: 3, delayMs: () => 0 };

function fakeAdapter(channel: DeliveryChannelAdapter['channel'], results: SendResult[]) {
  let i = 0;
  const a: DeliveryChannelAdapter & { sends: number } = {
    channel,
    envVars: ['X'],
    sends: 0,
    isConfigured: () => true,
    async send() {
      a.sends++;
      return results[Math.min(i++, results.length - 1)];
    },
  };
  return a;
}

describe('delivery service', () => {
  it('skipped_not_configured with missing env var NAMES when env is empty; persisted', async () => {
    const repos = createInMemoryRepositories();
    const log = silentLog();
    const svc = createDeliveryService({ repos, adapters: createDeliveryAdapters(emptyEnv(), mockFetch(() => json(200, {}))), clock, log, retry: noDelay });
    const out = await svc.deliver('realtime_alert', ['email', 'whatsapp', 'slack'], msg, { issueId: 'ISS-0001' });
    expect(out.map((a) => a.outcome)).toEqual(['skipped_not_configured', 'skipped_not_configured', 'skipped_not_configured']);
    expect(out[0].error).toMatch(/SMTP_HOST.*DIGEST_RECIPIENTS/);
    expect(out[1].error).toMatch(/WHATSAPP_API_TOKEN/);
    expect(out[2].error).toMatch(/SLACK_WEBHOOK_URL/);
    expect(out[0].id).toMatch(/^DLV-\d{5}$/);
    expect(await repos.deliveries.count()).toBe(3);
    expect(out[0]).toMatchObject({ issueId: 'ISS-0001', kind: 'realtime_alert', retryable: false, at: '2026-10-12T02:30:00.000Z' });
    expect(svc.channelStatus().every((c) => !c.configured)).toBe(true);
  });

  it('retries a retryable failure then delivers with providerMessageId', async () => {
    const repos = createInMemoryRepositories();
    const a = fakeAdapter('slack', [{ ok: false, error: 'HTTP 503', retryable: true }, { ok: true, providerMessageId: 'm-1' }]);
    const svc = createDeliveryService({ repos, adapters: [a], clock, log: silentLog(), retry: noDelay });
    const [r] = await svc.deliver('daily_digest', ['slack'], msg);
    expect(a.sends).toBe(2);
    expect(r).toMatchObject({ outcome: 'delivered', providerMessageId: 'm-1', retryable: false });
    expect(await repos.deliveries.get(r.id)).toEqual(r);
  });

  it('fails after 3 retryable errors with retryable=true', async () => {
    const repos = createInMemoryRepositories();
    const a = fakeAdapter('whatsapp', [{ ok: false, error: 'rate limited (HTTP 429)', retryable: true }]);
    const delays: number[] = [];
    const svc = createDeliveryService({ repos, adapters: [a], clock, log: silentLog(), retry: { attempts: 3, delayMs: (n) => (delays.push(n), 0) } });
    const [r] = await svc.deliver('realtime_alert', ['whatsapp'], msg);
    expect(a.sends).toBe(3);
    expect(delays).toEqual([1, 2]);
    expect(r).toMatchObject({ outcome: 'failed', retryable: true });
    expect(r.error).toMatch(/after 3 attempts/);
    expect(await repos.deliveries.count()).toBe(1);
  });

  it('non-retryable failure (HTTP 400) fails immediately', async () => {
    const repos = createInMemoryRepositories();
    const f = mockFetch(() => text(400, 'invalid_payload'));
    const svc = createDeliveryService({ repos, adapters: [createSlackAdapter(makeEnv(), f)], clock, log: silentLog(), retry: noDelay });
    const [r] = await svc.deliver('realtime_alert', ['slack'], msg);
    expect(f.calls).toHaveLength(1);
    expect(r).toMatchObject({ outcome: 'failed', retryable: false });
    expectNoSecrets(r.error);
  });

  it('real slack adapter: 500, network, then ok → delivered after 3 attempts', async () => {
    const repos = createInMemoryRepositories();
    const f = mockFetch((url, _i, n) => (n === 1 ? text(500, 'oops') : n === 2 ? networkError(url) : text(200, 'ok')));
    const svc = createDeliveryService({ repos, adapters: [createSlackAdapter(makeEnv(), f)], clock, log: silentLog(), retry: noDelay });
    const [r] = await svc.deliver('realtime_alert', ['slack'], msg);
    expect(f.calls).toHaveLength(3);
    expect(r.outcome).toBe('delivered');
  });

  it('logs outcome metadata only — no bodies, no secrets', async () => {
    const log = silentLog();
    const f = mockFetch((url) => networkError(url));
    const svc = createDeliveryService({ repos: createInMemoryRepositories(), adapters: createDeliveryAdapters(makeEnv(), f, { mailTransport: () => ({ verify: async () => true, sendMail: async () => ({ messageId: '<id@x>', accepted: ['a'] }) }) }), clock, log, retry: noDelay });
    await svc.deliver('realtime_alert', ['email', 'whatsapp', 'slack'], msg);
    const dump = JSON.stringify(log.entries);
    expect(dump).not.toContain(msg.text);
    expectNoSecrets(dump);
  });

  it('an adapter that throws is recorded as failed, never delivered', async () => {
    const a: DeliveryChannelAdapter = { channel: 'email', envVars: [], isConfigured: () => true, send: async () => { throw new Error('kaboom'); } };
    const svc = createDeliveryService({ repos: createInMemoryRepositories(), adapters: [a], clock, log: silentLog(), retry: noDelay });
    expect((await svc.deliver('daily_digest', ['email'], msg))[0]).toMatchObject({ outcome: 'failed', retryable: false });
  });
});

describe('delivery adapters', () => {
  it('slack payload has text + header/section/actions blocks with link buttons', () => {
    const p = slackPayload(msg);
    expect(p.text).toContain(msg.subject);
    expect(p.blocks.map((b) => b.type)).toEqual(['header', 'section', 'actions']);
    expect((p.blocks[2] as { elements: { url: string }[] }).elements[0].url).toBe(msg.links![0].url);
  });

  it('whatsapp posts a text message per recipient and joins provider message ids', async () => {
    const f = mockFetch((_u, _i, n) => json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.${n}` }] }));
    const r = await createWhatsAppAdapter(makeEnv(), f).send(msg);
    expect(r).toEqual({ ok: true, providerMessageId: 'wamid.1,wamid.2' });
    expect(f.calls[0].url).toBe('https://graph.facebook.com/v21.0/1098765432/messages');
    const body = JSON.parse(f.calls[0].body!);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'text' });
    expect(body.text.body).toContain('Allocate to SEO: https://');
    expect(f.calls[0].headers.authorization).toBe('Bearer EAAG-SECRET-whatsapp-token');
  });

  it('whatsapp: 2xx without message id is NOT delivered; partial success is not retried', async () => {
    expect(await createWhatsAppAdapter(makeEnv(), mockFetch(() => json(200, {}))).send(msg)).toMatchObject({ ok: false, retryable: false });
    const f = mockFetch((_u, _i, n) => (n === 1 ? json(200, { messages: [{ id: 'wamid.1' }] }) : json(500, {})));
    const r = await createWhatsAppAdapter(makeEnv(), f).send(msg);
    expect(r).toMatchObject({ ok: false, retryable: false });
    if (!r.ok) expect(r.error).toMatch(/1 of 2 recipients accepted/);
  });

  it('email sends html + text to DIGEST_RECIPIENTS and returns the SMTP messageId', async () => {
    const sent: Record<string, unknown>[] = [];
    const t: MailTransportFactory = () => ({ verify: async () => true, sendMail: async (o) => (sent.push(o), { messageId: '<abc@smtp>', accepted: ['seo@deodap.test'] }) });
    const r = await createEmailAdapter(makeEnv(), t).send(msg);
    expect(r).toEqual({ ok: true, providerMessageId: '<abc@smtp>' });
    expect(sent[0]).toMatchObject({ to: 'seo@deodap.test, dev@deodap.test', from: 'Sentinel <alerts@deodap.test>', subject: msg.subject });
    expect(sent[0].html).toContain('href="https://sentinel.deodap.test/issues/ISS-0001?allocate=seo"');
    expect(sent[0].text).toContain('Allocate to SEO');
  });

  it('email: auth error non-retryable, connection error retryable', async () => {
    const fail = (props: Record<string, unknown>): MailTransportFactory => () => ({ verify: async () => true, sendMail: async () => { throw Object.assign(new Error('x smtp-SECRET-password'), props); } });
    const auth = await createEmailAdapter(makeEnv(), fail({ code: 'EAUTH' })).send(msg);
    expect(auth).toMatchObject({ ok: false, retryable: false });
    if (!auth.ok) expectNoSecrets(auth.error);
    expect(await createEmailAdapter(makeEnv(), fail({ code: 'ECONNECTION' })).send(msg)).toMatchObject({ ok: false, retryable: true });
  });

  it('email requires SMTP_FROM to send', () => {
    expect(createEmailAdapter(makeEnv({ SMTP_FROM: undefined })).isConfigured()).toBe(false);
  });
});
