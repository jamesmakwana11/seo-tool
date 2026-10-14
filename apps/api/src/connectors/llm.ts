/**
 * LLM adapter for LLM-judged custom rules, the people-first value test and rewrite drafts.
 * Uses OpenAI chat completions (JSON mode, env.OPENAI_MODEL) when OPENAI_API_KEY is set, otherwise Gemini
 * generateContent (JSON response mime type) when GEMINI_API_KEY is set. Output is parsed strictly with zod;
 * any failure (HTTP, network, malformed JSON, schema mismatch) returns { ok: false, error } — never a guess.
 */
import { z } from 'zod';
import type { Env } from '../config/env';
import type { LlmAdapter } from '../services/ports';
import { defaultFetch, failureResult, httpRequest, is2xx, redact, secretValues, type FetchLike } from './http';

export const GEMINI_MODEL = 'gemini-1.5-flash';
const MAX_TEXT = 12_000;

export const judgementSchema = z
  .object({
    flagged: z.boolean(),
    reason: z.string().min(1).max(2000),
    passage: z.string().max(4000).nullish(),
  })
  .strict();

export const SYSTEM_PROMPT =
  'You are a strict SEO content compliance reviewer for DeoDap (an Indian e-commerce store). ' +
  'Apply ONLY the rule given by the user to the page text. Respond with a single JSON object and nothing else: ' +
  '{"flagged": boolean, "reason": string, "passage": string|null}. ' +
  '"flagged" is true only if the text violates the rule. "reason" briefly explains the decision. ' +
  '"passage" is the shortest exact quote from the text that violates the rule (null when not flagged). Never invent quotes.';

export function buildUserPrompt(instruction: string, text: string): string {
  const t = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[…truncated]` : text;
  return `RULE:\n${instruction}\n\nPAGE TEXT:\n"""\n${t}\n"""`;
}

/** Strict parse of a model's JSON output. Tolerates a ```json fence; nothing else. */
export function parseJudgement(raw: string): { ok: true; flagged: boolean; reason: string; passage?: string } | { ok: false; error: string } {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let json: unknown;
  try {
    json = JSON.parse(s);
  } catch {
    return { ok: false, error: 'LLM returned malformed JSON.' };
  }
  const p = judgementSchema.safeParse(json);
  if (!p.success) return { ok: false, error: `LLM output did not match the expected schema (${p.error.issues.map((i) => i.path.join('.') || i.code).join(', ')}).` };
  const passage = p.data.passage?.trim();
  if (p.data.flagged && !passage) return { ok: false, error: 'LLM flagged the text without quoting a passage.' };
  return { ok: true, flagged: p.data.flagged, reason: p.data.reason, ...(passage && p.data.flagged ? { passage } : {}) };
}

export function createLlmAdapter(deps: { env: Env; fetchImpl?: FetchLike }): LlmAdapter & { provider(): 'openai' | 'gemini' | null } {
  const { env } = deps;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const provider = () => (env.OPENAI_API_KEY ? 'openai' : env.GEMINI_API_KEY ? 'gemini' : null);
  const fail = (error: string) => ({ ok: false as const, error: redact(error, secretValues(env)) });

  return {
    provider,
    isConfigured: () => provider() !== null,
    async judge(instruction, text) {
      const p = provider();
      if (!p) return { ok: false, error: 'No LLM configured — set OPENAI_API_KEY or GEMINI_API_KEY.' };
      if (!instruction.trim()) return { ok: false, error: 'Empty rule instruction.' };
      const user = buildUserPrompt(instruction, text);

      if (p === 'openai') {
        const url = 'https://api.openai.com/v1/chat/completions';
        const r = await httpRequest(fetchImpl, url, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: env.OPENAI_MODEL,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }],
          }),
        }, 60_000);
        if (!is2xx(r)) return fail(failureResult('OpenAI', url, r).result);
        const content = (r.json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') return fail('OpenAI response had no message content.');
        return parseJudgement(content);
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY!)}`;
      const r = await httpRequest(fetchImpl, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      }, 60_000);
      if (!is2xx(r)) return fail(failureResult('Gemini', 'https://generativelanguage.googleapis.com', r).result);
      const parts = (r.json as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
      const content = parts.map((x) => (typeof x.text === 'string' ? x.text : '')).join('');
      if (!content) return fail('Gemini response had no text content (possibly blocked by safety filters).');
      return parseJudgement(content);
    },
  };
}
