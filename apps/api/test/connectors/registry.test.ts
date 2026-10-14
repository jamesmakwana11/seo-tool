import { describe, expect, it } from 'vitest';
import { ApiError } from '@sentinel/shared';
import { createIntegrationRegistry, UNTESTED_DETAIL } from '../../src/connectors/registry';
import { createConnectors } from '../../src/connectors/connectors';
import { createInMemoryRepositories } from '../../src/repositories/memory/inMemory';
import type { Connector, ConnectorTestResult } from '../../src/services/ports';
import { emptyEnv, expectNoSecrets, json, makeEnv, mockFetch, silentLog } from './helpers';

const clock = () => new Date('2026-10-12T08:00:00.000Z');

function setup(env = makeEnv(), responses: (() => Response)[] = []) {
  let i = 0;
  const f = mockFetch(() => (responses[Math.min(i++, responses.length - 1)] ?? json(500, {}))());
  const repos = createInMemoryRepositories();
  const log = silentLog();
  const reg = createIntegrationRegistry({ env, repos, connectors: createConnectors(env, f), clock, log });
  return { reg, repos, f, log };
}

describe('integration registry', () => {
  it('lists all 14 catalog entries; empty env → not_configured everywhere, nothing connected', async () => {
    const { reg } = setup(emptyEnv());
    const list = await reg.list();
    expect(list).toHaveLength(14);
    for (const s of list) {
      // SHOPIFY_API_VERSION / OPENAI_MODEL have defaults but are not in any envVars list
      expect(s.state).toBe('not_configured');
      expect(s.configuredVars).toEqual([]);
      expect(await reg.isConnected(s.id)).toBe(false);
    }
  });

  it('partial vars → credentials_missing with missing names', async () => {
    const env = makeEnv({}, { NODE_ENV: 'test', SLACK_WEBHOOK_URL: '', GSC_PROPERTY: 'https://deodap.in/' } as Record<string, string>);
    const { reg } = setup(env);
    const s = await reg.status('gsc');
    expect(s.state).toBe('credentials_missing');
    expect(s.configuredVars).toEqual(['GSC_PROPERTY']);
    expect(s.stateDetail).toMatch(/GSC_SERVICE_ACCOUNT_JSON/);
  });

  it('transitions: untested → connected → connection_failed → rate_limited, persisted in integrationTests', async () => {
    const { reg, repos } = setup(makeEnv(), [() => json(200, { data: [] }), () => json(401, { error: 'bad token' }), () => json(429, {})]);
    let s = await reg.status('openai');
    expect(s.state).toBe('not_configured');
    expect(s.stateDetail).toBe(UNTESTED_DETAIL);
    expect(s.configuredVars).toEqual(['OPENAI_API_KEY']);
    expect(await reg.isConnected('openai')).toBe(false);

    s = await reg.test('openai');
    expect(s.state).toBe('connected');
    expect(s.lastTestAt).toBe('2026-10-12T08:00:00.000Z');
    expect(await reg.isConnected('openai')).toBe(true);
    expect(await repos.integrationTests.get('openai')).toMatchObject({ ok: true, at: '2026-10-12T08:00:00.000Z' });

    s = await reg.test('openai');
    expect(s.state).toBe('connection_failed');
    expect(s.lastTestResult).toMatch(/credentials rejected/);
    expect(await reg.isConnected('openai')).toBe(false);

    s = await reg.test('openai');
    expect(s.state).toBe('rate_limited');
    expect(await reg.isConnected('openai')).toBe(false);
    for (const x of [s.stateDetail, s.lastTestResult]) expectNoSecrets(x);
  });

  it('partial test result → partial state; sync failure → sync_failed; sync success clears it', async () => {
    const env = makeEnv();
    const fake = (r: ConnectorTestResult): Connector => ({ id: 'slack', envVars: ['SLACK_WEBHOOK_URL'], isConfigured: () => true, test: async () => r });
    const repos = createInMemoryRepositories();
    const partial = createIntegrationRegistry({ env, repos, connectors: [fake({ ok: true, partial: true, result: 'limited' })], clock, log: silentLog() });
    expect((await partial.test('slack')).state).toBe('partial');
    expect(await partial.isConnected('slack')).toBe(true);

    const okReg = createIntegrationRegistry({ env, repos, connectors: [fake({ ok: true, result: 'fine' })], clock, log: silentLog() });
    expect((await okReg.test('slack')).state).toBe('connected');
    expect((await okReg.recordSync('slack', { ok: false, error: 'sync blew up' })).state).toBe('sync_failed');
    const s = await okReg.recordSync('slack', { ok: true });
    expect(s.state).toBe('connected');
    expect(s.lastSuccessfulSyncAt).toBe('2026-10-12T08:00:00.000Z');
  });

  it('connected is never reported without a stored successful test (even with every var set)', async () => {
    const { reg, repos } = setup(makeEnv());
    for (const s of await reg.list()) expect(s.state).not.toBe('connected');
    await repos.integrationTests.upsert({ id: 'gemini', at: clock().toISOString(), ok: false, result: 'nope' });
    expect((await reg.status('gemini')).state).toBe('connection_failed');
    expect(await reg.isConnected('gemini')).toBe(false);
  });

  it('test() on an unconfigured integration makes no call and stores nothing', async () => {
    const { reg, repos, f } = setup(emptyEnv());
    const s = await reg.test('openai');
    expect(s.state).toBe('not_configured');
    expect(f.calls).toHaveLength(0);
    expect(await repos.integrationTests.get('openai')).toBeUndefined();
  });

  it('a connector that throws is stored as a failure, not a success', async () => {
    const env = makeEnv();
    const bad: Connector = { id: 'slack', envVars: ['SLACK_WEBHOOK_URL'], isConfigured: () => true, test: async () => { throw new Error('boom'); } };
    const reg = createIntegrationRegistry({ env, repos: createInMemoryRepositories(), connectors: [bad], clock, log: silentLog() });
    expect((await reg.test('slack')).state).toBe('connection_failed');
  });

  it('updateSettings rejects secret-looking keys with SECRET_IN_SETTINGS and stores non-secret settings', async () => {
    const { reg, repos } = setup(makeEnv());
    for (const key of ['apiToken', 'client_secret', 'password', 'API_KEY', 'privateKey']) {
      const err = await reg.updateSettings('gsc', { [key]: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 400, code: 'SECRET_IN_SETTINGS' });
    }
    const pem = await reg.updateSettings('gsc', { note: '-----BEGIN PRIVATE KEY-----abc' }).catch((e) => e);
    expect(pem).toMatchObject({ code: 'SECRET_IN_SETTINGS' });
    expect(await repos.integrationSettings.get('gsc')).toBeUndefined();

    const s = await reg.updateSettings('gsc', { syncHourIst: 6, includeDiscover: true });
    expect(s.settings).toEqual({ syncHourIst: 6, includeDiscover: true });
    expect((await reg.updateSettings('gsc', { rowLimit: 5000 })).settings).toEqual({ syncHourIst: 6, includeDiscover: true, rowLimit: 5000 });
  });

  it('status never exposes env values, only names', async () => {
    const { reg } = setup(makeEnv());
    const all = JSON.stringify(await reg.list());
    expectNoSecrets(all);
    expect(all).not.toContain('deodap.myshopify.com'); // even non-secret values are not echoed
  });
});
