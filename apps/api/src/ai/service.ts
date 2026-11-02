/**
 * Claude AI connection (Integrations → Claude AI): one connection for the whole server (every website uses it).
 *
 * The Anthropic API key is entered on the Integrations screen, sent once to the API over HTTPS, checked against
 * Anthropic, and stored encrypted (AES-256-GCM, security/secretBox — key derived from CREDENTIALS_ENCRYPTION_KEY or
 * SESSION_SECRET, which every production server already has). It is never returned to the browser, logged, audited or
 * exported; only "a key is saved" and the model are. With DATABASE_URL it survives restarts; without it the key lives
 * in this server's memory until the next restart.
 *
 * Requests are limited server-wide (a few at a time) so a bulk fix cannot flood the account's rate limit; rate limits
 * and overload are retried by the client with backoff.
 */
import type { ClaudeModelOption, ClaudeStatus, ClaudeTestResult } from '@sentinel/shared';
import type { FetchLike } from '../connectors/http';
import { redact } from '../connectors/http';
import { badRequest, ApiError } from '../lib/errors';
import type { Repositories } from '../repositories/types';
import { SecretBoxError, type SecretBox } from '../security/secretBox';
import { ClaudeError, createClaudeClient, type ClaudeClient, type ClaudeToolCall } from './claude';

export interface ClaudeServiceDeps {
  /** The primary website's repositories: the connection is stored there once for all websites. */
  repos: Pick<Repositories, 'integrationSecrets' | 'storage'>;
  box?: SecretBox;
  fetchImpl: FetchLike;
  clock: () => Date;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
  audit: (actor: { id: string; name: string }, action: string, summary: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Concurrent requests to Anthropic, server-wide. */
  maxConcurrent?: number;
}

const DOC = 'claude' as const;
const AAD = 'global:claude:apiKey';
const KEY_RE = /^[\x21-\x7e]{20,400}$/;

interface Loaded { apiKey?: string; model?: string; modelName?: string; connectedAt?: string; connectedBy?: string; lastTestAt?: string; lastTestOk?: boolean; lastTestResult?: string; problem?: string }

export function createClaudeService(d: ClaudeServiceDeps) {
  const iso = () => d.clock().toISOString();
  let state: Loaded = {};
  let loaded: Promise<void> | undefined;
  const usage: ClaudeStatus['usage'] = { requests: 0, failures: 0 };
  // ---- server-wide limiter
  const max = d.maxConcurrent ?? 3;
  let active = 0;
  const waiting: (() => void)[] = [];
  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  }

  function load(force = false) {
    if (force) loaded = undefined;
    loaded ??= (async () => {
      const doc = await d.repos.integrationSecrets.get(DOC);
      state = {};
      if (!doc) return;
      const m = (doc.meta ?? {}) as Partial<Loaded>;
      state = { model: doc.plain.model || undefined, modelName: doc.plain.modelName || undefined, connectedAt: m.connectedAt, connectedBy: m.connectedBy, lastTestAt: m.lastTestAt, lastTestOk: m.lastTestOk, lastTestResult: m.lastTestResult };
      if (doc.sealed.apiKey) {
        try {
          if (!d.box) throw new SecretBoxError('no key');
          state.apiKey = d.box.open(doc.sealed.apiKey, AAD);
        } catch (e) {
          state.problem = `The saved Claude API key could not be decrypted — ${d.box ? `${d.box.keySource} changed since it was saved` : 'no encryption key is configured on the server'}. Enter the key again.`;
          d.log.warn({ err: (e as Error).message }, 'stored Claude API key could not be decrypted');
        }
      }
    })();
    return loaded;
  }

  const client = (apiKey: string): ClaudeClient => createClaudeClient({ apiKey, fetchImpl: d.fetchImpl, sleep: d.sleep });
  const clean = (s: string, key?: string) => redact(s, [key ?? '', state.apiKey ?? ''].filter((x) => x.length >= 4));

  async function saveMeta(patch: Partial<Loaded>) {
    const doc = await d.repos.integrationSecrets.get(DOC);
    if (!doc) return;
    const meta = { ...(doc.meta ?? {}), ...patch };
    await d.repos.integrationSecrets.upsert({ ...doc, meta });
    Object.assign(state, patch);
  }

  async function status(): Promise<ClaudeStatus> {
    await load();
    return {
      connected: !!state.apiKey && !!state.model,
      ...(state.model ? { model: state.model, modelName: state.modelName } : {}),
      connectedAt: state.connectedAt, connectedBy: state.connectedBy, lastTestAt: state.lastTestAt, lastTestOk: state.lastTestOk,
      lastTestResult: state.problem ?? state.lastTestResult,
      canStore: !!d.box, ...(d.box ? {} : { storeProblem: 'The key cannot be stored: the API server has no SESSION_SECRET (or CREDENTIALS_ENCRYPTION_KEY) to encrypt it with. Set SESSION_SECRET (32+ characters) once on the server.' }),
      persistent: d.repos.storage.persistent !== false,
      usage: { ...usage },
    };
  }

  function checkKey(raw: unknown): string {
    const k = String(raw ?? '').trim();
    if (!k) throw badRequest('Enter the Anthropic API key.');
    if (!KEY_RE.test(k)) throw badRequest('That does not look like an Anthropic API key (it starts with sk-ant- and has no spaces).');
    return k;
  }

  /** Lists models with the key; a model, when given, must be one of them. Never throws for provider failures. */
  async function probe(apiKey: string, model?: string): Promise<ClaudeTestResult> {
    try {
      const models = await client(apiKey).listModels();
      const options: ClaudeModelOption[] = models.map((m) => ({ id: m.id, name: m.name, ...(m.createdAt ? { createdAt: m.createdAt } : {}) }));
      if (!options.length) return { ok: false, message: 'The key works, but Anthropic lists no models for it.' };
      if (model && !options.some((m) => m.id === model)) return { ok: false, message: `The model “${model}” is not available to this key. Choose one from the list.`, models: options };
      return { ok: true, message: `The key works: ${options.length} model(s) available${model ? `; “${options.find((m) => m.id === model)!.name}” selected` : ''}.`, models: options };
    } catch (e) {
      const ce = e instanceof ClaudeError ? e : new ClaudeError('network', (e as Error).message);
      return { ok: false, message: clean(ce.message, apiKey), ...(ce.code === 'rate_limited' ? { rateLimited: true } : {}) };
    }
  }

  return {
    status,
    load,

    async isConnected() { await load(); return !!state.apiKey && !!state.model; },
    async model() { await load(); return state.model; },

    async test(input: { apiKey?: unknown; model?: unknown }): Promise<ClaudeTestResult> {
      await load();
      const typed = input.apiKey !== undefined && String(input.apiKey).trim() !== '';
      const key = typed ? checkKey(input.apiKey) : state.apiKey;
      if (!key) throw badRequest(state.problem ?? 'Enter the Anthropic API key to test it.');
      const model = typeof input.model === 'string' && input.model ? input.model : typed ? undefined : state.model;
      const r = await probe(key, model);
      if (!typed) await saveMeta({ lastTestAt: iso(), lastTestOk: r.ok, lastTestResult: r.message });
      d.log.info({ ok: r.ok, saved: !typed }, 'Claude connection test');
      return r;
    },

    async connect(actor: { id: string; name: string }, input: { apiKey?: unknown; model?: unknown }): Promise<ClaudeStatus> {
      await load();
      if (!d.box) throw new ApiError(409, 'CANNOT_STORE', 'The key cannot be stored: the API server has no SESSION_SECRET (or CREDENTIALS_ENCRYPTION_KEY) to encrypt it with.');
      const key = checkKey(input.apiKey);
      const model = String(input.model ?? '').trim();
      if (!model) throw badRequest('Choose a Claude model.');
      const r = await probe(key, model);
      if (!r.ok) throw new ApiError(r.rateLimited ? 429 : 400, 'CLAUDE_TEST_FAILED', `Not connected: ${r.message}`);
      const at = iso();
      const name = r.models?.find((m) => m.id === model)?.name ?? model;
      await d.repos.integrationSecrets.upsert({
        id: DOC, plain: { model, modelName: name }, sealed: { apiKey: d.box.seal(key, AAD) },
        meta: { connectedAt: at, connectedBy: actor.name, lastTestAt: at, lastTestOk: true, lastTestResult: r.message }, updatedAt: at, updatedBy: actor.name,
      });
      await load(true);
      await d.audit(actor, 'integration.claude_connect', `Connected Claude AI (model ${name}); the API key is stored encrypted`);
      d.log.info({ model }, 'Claude AI connected');
      return status();
    },

    async setModel(actor: { id: string; name: string }, input: { model?: unknown }): Promise<ClaudeStatus> {
      await load();
      if (!state.apiKey) throw new ApiError(409, 'CLAUDE_NOT_CONNECTED', state.problem ?? 'Claude AI is not connected.');
      const model = String(input.model ?? '').trim();
      if (!model) throw badRequest('Choose a Claude model.');
      const r = await probe(state.apiKey, model);
      if (!r.ok) throw new ApiError(r.rateLimited ? 429 : 400, 'CLAUDE_TEST_FAILED', r.message);
      const doc = (await d.repos.integrationSecrets.get(DOC))!;
      const name = r.models?.find((m) => m.id === model)?.name ?? model;
      await d.repos.integrationSecrets.upsert({ ...doc, plain: { ...doc.plain, model, modelName: name }, meta: { ...(doc.meta ?? {}), lastTestAt: iso(), lastTestOk: true, lastTestResult: r.message }, updatedAt: iso(), updatedBy: actor.name });
      await load(true);
      await d.audit(actor, 'integration.claude_model', `Claude AI model changed to ${name}`);
      return status();
    },

    async disconnect(actor: { id: string; name: string }): Promise<ClaudeStatus> {
      await d.repos.integrationSecrets.delete(DOC).catch(() => false);
      await load(true);
      await d.audit(actor, 'integration.claude_disconnect', 'Disconnected Claude AI; the stored API key was removed');
      d.log.info({}, 'Claude AI disconnected');
      return status();
    },

    /**
     * One structured request with the connected key and model (limited server-wide). Throws ClaudeError
     * (`code` says whether to retry later, stop, or fall back); never includes the key.
     */
    async call<T>(c: ClaudeToolCall): Promise<{ input: T; model: string }> {
      await load();
      if (!state.apiKey || !state.model) throw new ClaudeError('auth', state.problem ?? 'Claude AI is not connected.');
      const key = state.apiKey;
      const model = state.model;
      return slot(async () => {
        usage.requests++;
        try {
          const r = await client(key).callTool<T>(model, c);
          return { input: r.input, model };
        } catch (e) {
          usage.failures++;
          const ce = e instanceof ClaudeError ? e : new ClaudeError('network', (e as Error).message);
          ce.message = clean(ce.message, key);
          usage.lastError = ce.message;
          usage.lastErrorAt = iso();
          if (ce.code === 'auth') await saveMeta({ lastTestAt: iso(), lastTestOk: false, lastTestResult: ce.message }).catch(() => undefined);
          throw ce;
        }
      });
    },
  };
}
export type ClaudeService = ReturnType<typeof createClaudeService>;
