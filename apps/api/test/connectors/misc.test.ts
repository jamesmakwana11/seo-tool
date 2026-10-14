import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Issue, Task } from '@sentinel/shared';
import { verifyShopifyWebhook } from '../../src/connectors/shopifyWebhook';
import { createLlmAdapter, parseJudgement } from '../../src/connectors/llm';
import { createTaskOpsAdapter } from '../../src/notifications/taskOps';
import { redact } from '../../src/connectors/http';
import * as index from '../../src/connectors/index';
import { emptyEnv, expectNoSecrets, json, makeEnv, mockFetch, networkError } from './helpers';

describe('verifyShopifyWebhook', () => {
  const secret = 'whsec-SECRET-abcdef';
  const body = Buffer.from(JSON.stringify({ id: 1, title: 'Steel bottle' }));
  const good = createHmac('sha256', secret).update(body).digest('base64');

  it('true for a matching HMAC', () => expect(verifyShopifyWebhook(body, good, secret)).toBe(true));
  it('false for tampered body, wrong secret, garbage or empty header', () => {
    expect(verifyShopifyWebhook(Buffer.from(body.toString() + ' '), good, secret)).toBe(false);
    expect(verifyShopifyWebhook(body, good, 'other')).toBe(false);
    expect(verifyShopifyWebhook(body, 'not-base64!!', secret)).toBe(false);
    expect(verifyShopifyWebhook(body, '', secret)).toBe(false);
    expect(verifyShopifyWebhook(body, good, '')).toBe(false);
  });
});

describe('LLM adapter', () => {
  const okOpenAi = (content: string) => json(200, { choices: [{ message: { content } }] });

  it('not configured without keys', async () => {
    const a = createLlmAdapter({ env: emptyEnv() });
    expect(a.isConfigured()).toBe(false);
    expect(await a.judge('rule', 'text')).toMatchObject({ ok: false });
  });

  it('OpenAI: JSON mode with configured model; parses a flagged judgement', async () => {
    const f = mockFetch(() => okOpenAi('{"flagged": true, "reason": "Unverified medical claim", "passage": "cures arthritis"}'));
    const r = await createLlmAdapter({ env: makeEnv(), fetchImpl: f }).judge('No medical claims', 'This mat cures arthritis.');
    expect(r).toEqual({ ok: true, flagged: true, reason: 'Unverified medical claim', passage: 'cures arthritis' });
    const body = JSON.parse(f.calls[0].body!);
    expect(f.calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body).toMatchObject({ model: 'gpt-4o-mini', response_format: { type: 'json_object' }, temperature: 0 });
    expect(body.messages[1].content).toContain('No medical claims');
  });

  it('not flagged → no passage', async () => {
    const f = mockFetch(() => okOpenAi('{"flagged": false, "reason": "Compliant", "passage": null}'));
    expect(await createLlmAdapter({ env: makeEnv(), fetchImpl: f }).judge('r', 't')).toEqual({ ok: true, flagged: false, reason: 'Compliant' });
  });

  it('malformed / schema-mismatched output → ok:false', async () => {
    for (const bad of ['not json', '{"flagged":"yes","reason":"x"}', '{"flagged":true,"reason":"x"}', '{"flagged":false,"reason":"x","extra":1}', '[]']) {
      const f = mockFetch(() => okOpenAi(bad));
      expect(await createLlmAdapter({ env: makeEnv(), fetchImpl: f }).judge('r', 't')).toMatchObject({ ok: false });
    }
    expect(parseJudgement('```json\n{"flagged":false,"reason":"ok"}\n```')).toMatchObject({ ok: true });
  });

  it('HTTP 401 / network errors → ok:false without secrets', async () => {
    const r1 = await createLlmAdapter({ env: makeEnv(), fetchImpl: mockFetch(() => json(401, { error: { message: 'Incorrect API key provided: sk-SECRET-openai-abcdef' } })) }).judge('r', 't');
    expect(r1).toMatchObject({ ok: false, error: expect.stringMatching(/credentials rejected/) });
    if (!r1.ok) expectNoSecrets(r1.error);
    const r2 = await createLlmAdapter({ env: makeEnv({ OPENAI_API_KEY: undefined }), fetchImpl: mockFetch((u) => networkError(u)) }).judge('r', 't');
    expect(r2).toMatchObject({ ok: false });
    if (!r2.ok) expectNoSecrets(r2.error);
  });

  it('falls back to Gemini generateContent when only GEMINI_API_KEY is set', async () => {
    const f = mockFetch(() => json(200, { candidates: [{ content: { parts: [{ text: '{"flagged":false,"reason":"fine"}' }] } }] }));
    const a = createLlmAdapter({ env: makeEnv({ OPENAI_API_KEY: undefined }), fetchImpl: f });
    expect(a.provider()).toBe('gemini');
    expect(await a.judge('r', 't')).toEqual({ ok: true, flagged: false, reason: 'fine' });
    expect(f.calls[0].url).toMatch(/:generateContent\?key=/);
    expect(JSON.parse(f.calls[0].body!).generationConfig.responseMimeType).toBe('application/json');
  });
});

describe('Task Ops adapter', () => {
  const task = {
    id: 'TSK-0007', title: 'Fix noindex on collection template', description: 'Remove the stray noindex meta.', issueId: 'ISS-0042',
    priority: 'P1', team: 'development', dueAt: '2026-10-13T08:00:00.000Z', status: 'ASSIGNED', affectedUrls: ['https://deodap.in/collections/kitchen'],
    acceptanceCriteria: ['No noindex on Tier 1 collections'],
  } as unknown as Task;
  const issue = { id: 'ISS-0042', title: 'Tier 1 noindex', severity: 'critical', businessImpact: 'Revenue pages deindexed' } as unknown as Issue;

  it('not configured without vars', async () => {
    const a = createTaskOpsAdapter({ env: emptyEnv() });
    expect(a.isConfigured()).toBe(false);
    expect(await a.upsertTask(task)).toMatchObject({ ok: false, retryable: false });
  });

  it('POST /api/tasks with team group, priority, due date, Fix Card link → externalId', async () => {
    const f = mockFetch(() => json(201, { ok: true, task_ids: [9876] }));
    const r = await createTaskOpsAdapter({ env: makeEnv(), fetchImpl: f, appBaseUrl: 'https://sentinel.deodap.test' }).upsertTask(task, issue);
    expect(r).toEqual({ ok: true, externalId: '9876' });
    expect(f.calls[0].url).toBe('https://tasks.deodap.test/api/tasks');
    expect(f.calls[0].init?.method).toBe('POST');
    const body = JSON.parse(f.calls[0].body!);
    expect(body).toMatchObject({ assignee_group: '1into2 Development Team', priority: 'P1', priority_bucket: 'urgent', deadline_at: task.dueAt, external_ref: 'TSK-0007' });
    expect(body.title).toBe('[P1] Fix noindex on collection template');
    expect(body.description).toContain('Fix Card: https://sentinel.deodap.test/issues/ISS-0042');
  });

  it('PUT when the task already has an external id; comment endpoint', async () => {
    const f = mockFetch(() => json(200, { id: 'ext-1' }));
    const a = createTaskOpsAdapter({ env: makeEnv(), fetchImpl: f });
    expect(await a.upsertTask({ ...task, externalTaskOpsId: 'ext-1' })).toEqual({ ok: true, externalId: 'ext-1' });
    expect(f.calls[0]).toMatchObject({ url: 'https://tasks.deodap.test/api/tasks/ext-1' });
    expect(f.calls[0].init?.method).toBe('PUT');
    expect(await a.comment('ext-1', 'Verification passed')).toMatchObject({ ok: true });
    expect(f.calls[1].url).toBe('https://tasks.deodap.test/api/tasks/ext-1/comments');
  });

  it('errors: 401 non-retryable, 503 retryable, 2xx without id is a failure', async () => {
    const a401 = await createTaskOpsAdapter({ env: makeEnv(), fetchImpl: mockFetch(() => json(401, {})) }).upsertTask(task);
    expect(a401).toMatchObject({ ok: false, retryable: false });
    if (!a401.ok) expect(a401.error).toMatch(/credentials rejected/);
    expect(await createTaskOpsAdapter({ env: makeEnv(), fetchImpl: mockFetch(() => json(503, {})) }).upsertTask(task)).toMatchObject({ ok: false, retryable: true });
    expect(await createTaskOpsAdapter({ env: makeEnv(), fetchImpl: mockFetch(() => json(200, { ok: true })) }).upsertTask(task)).toMatchObject({ ok: false });
  });
});

describe('redact + index exports', () => {
  it('redacts key params, bearer tokens, PEM blocks and slack hook paths', () => {
    const s = redact('GET https://x.test/a?key=AIzaABC&b=1 Bearer abc.def -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- https://hooks.slack.com/services/T/B/xyz');
    expect(s).not.toMatch(/AIzaABC|abc\.def|MIIE|T\/B\/xyz/);
  });

  it('index exports the required factories', () => {
    for (const k of ['createConnectors', 'createIntegrationRegistry', 'createDeliveryAdapters', 'createDeliveryService', 'createTaskOpsAdapter', 'createLlmAdapter', 'verifyShopifyWebhook']) {
      expect(typeof (index as Record<string, unknown>)[k]).toBe('function');
    }
  });
});
