/**
 * Anthropic API client (Claude): the Messages API with a forced tool call for structured output, and the Models API
 * for the model picker. Every request goes through the injectable fetch, retries rate limits / overload / transient
 * server errors with backoff (honouring retry-after), and never puts the API key in an error message.
 */
import { httpRequest, redact, type FetchLike } from '../connectors/http';

export const ANTHROPIC_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

export type ClaudeErrorCode = 'auth' | 'permission' | 'rate_limited' | 'overloaded' | 'bad_request' | 'model_not_found' | 'server' | 'network' | 'bad_response';

export class ClaudeError extends Error {
  constructor(public code: ClaudeErrorCode, message: string, public status?: number) { super(message); }
  /** Worth trying again later (the same request may work): rate limits, overload, server and network errors. */
  get transient() { return this.code === 'rate_limited' || this.code === 'overloaded' || this.code === 'server' || this.code === 'network'; }
}

export interface ClaudeModel { id: string; name: string; createdAt?: string }

export type ClaudeBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'url'; url: string } };

export interface ClaudeToolCall {
  system: string;
  content: ClaudeBlock[];
  tool: { name: string; description: string; schema: Record<string, unknown> };
  maxTokens: number;
  /** Per attempt. */
  timeoutMs?: number;
}

export interface ClaudeClientOptions {
  apiKey: string;
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts after the first one, for transient failures. */
  retries?: number;
  baseUrl?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errorFrom(status: number, json: unknown, text: string, secrets: string[]): ClaudeError {
  const e = (json as { error?: { type?: string; message?: string } } | undefined)?.error;
  const msg = redact(String(e?.message ?? text ?? '').slice(0, 300), secrets).trim();
  const t = e?.type ?? '';
  if (status === 401 || t === 'authentication_error') return new ClaudeError('auth', 'Anthropic rejected the API key (invalid, revoked or mistyped).', status);
  if (status === 403 || t === 'permission_error') return new ClaudeError('permission', `The API key is not allowed to do this${msg ? `: ${msg}` : '.'}`, status);
  if (status === 404 || t === 'not_found_error') return new ClaudeError('model_not_found', `Not available to this key${msg ? `: ${msg}` : ''} — choose another model.`, status);
  if (status === 429 || t === 'rate_limit_error') return new ClaudeError('rate_limited', `Anthropic rate limit reached${msg ? `: ${msg}` : ''}.`, status);
  if (status === 529 || t === 'overloaded_error') return new ClaudeError('overloaded', 'Anthropic is overloaded right now.', status);
  if (status >= 500) return new ClaudeError('server', `Anthropic answered ${status}${msg ? `: ${msg}` : ''}.`, status);
  if (/credit balance|billing/i.test(msg)) return new ClaudeError('permission', `Anthropic: ${msg}`, status);
  return new ClaudeError('bad_request', `Anthropic refused the request (${status})${msg ? `: ${msg}` : ''}.`, status);
}

export function createClaudeClient(o: ClaudeClientOptions) {
  const base = (o.baseUrl ?? ANTHROPIC_BASE).replace(/\/$/, '');
  const sleep = o.sleep ?? realSleep;
  const retries = o.retries ?? 3;
  const secrets = [o.apiKey];
  const headers = { 'x-api-key': o.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };

  async function send(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    let last: ClaudeError | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = await httpRequest(o.fetchImpl, `${base}${path}`, { ...init, headers }, timeoutMs);
      if (r.kind === 'network') {
        last = new ClaudeError('network', `Anthropic could not be reached: ${redact(r.error, secrets)}`);
      } else if (r.status >= 200 && r.status < 300) {
        return r.json;
      } else {
        last = errorFrom(r.status, r.json, r.text, secrets);
        if (!last.transient) throw last;
        const ra = Number(r.headers.get('retry-after'));
        if (attempt < retries) { await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : Math.min(1000 * 2 ** attempt, 15_000)); continue; }
        break;
      }
      if (attempt < retries) await sleep(Math.min(1000 * 2 ** attempt, 15_000));
    }
    throw last ?? new ClaudeError('network', 'Anthropic could not be reached.');
  }

  return {
    /** Models the key can use, newest first. Doubles as the key check (401 → auth). */
    async listModels(): Promise<ClaudeModel[]> {
      const out: ClaudeModel[] = [];
      let after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const json = await send(`/v1/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { method: 'GET' }, 20_000) as { data?: { id?: unknown; display_name?: unknown; created_at?: unknown }[]; has_more?: boolean; last_id?: string };
        if (!json || !Array.isArray(json.data)) throw new ClaudeError('bad_response', 'Anthropic returned an unexpected model list.');
        for (const m of json.data) if (typeof m.id === 'string') out.push({ id: m.id, name: typeof m.display_name === 'string' ? m.display_name : m.id, ...(typeof m.created_at === 'string' ? { createdAt: m.created_at } : {}) });
        if (!json.has_more || !json.last_id) break;
        after = json.last_id;
      }
      return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    },

    /** One Messages API call that must answer with the given tool; returns the tool input (validate it yourself). */
    async callTool<T = unknown>(model: string, c: ClaudeToolCall): Promise<{ input: T; usage?: { input_tokens?: number; output_tokens?: number } }> {
      const body = {
        model, max_tokens: c.maxTokens, system: c.system,
        messages: [{ role: 'user', content: c.content }],
        tools: [{ name: c.tool.name, description: c.tool.description, input_schema: c.tool.schema }],
        tool_choice: { type: 'tool', name: c.tool.name },
      };
      const json = await send('/v1/messages', { method: 'POST', body: JSON.stringify(body) }, c.timeoutMs ?? 90_000) as { content?: { type?: string; name?: string; input?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const use = json?.content?.find((b) => b.type === 'tool_use' && b.name === c.tool.name);
      if (!use || typeof use.input !== 'object' || use.input === null) {
        throw new ClaudeError('bad_response', json?.stop_reason === 'max_tokens' ? 'The answer was cut off (too long).' : 'Claude did not return the structured answer.');
      }
      return { input: use.input as T, usage: json.usage };
    },
  };
}
export type ClaudeClient = ReturnType<typeof createClaudeClient>;
