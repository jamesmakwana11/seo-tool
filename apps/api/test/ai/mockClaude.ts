/**
 * In-memory Anthropic API for tests (no network): GET /v1/models and POST /v1/messages with a forced tool call, the
 * same request and response shapes as the real API. The "model" writes values from the facts in the prompt it is
 * sent (title and description words), aiming at the target length each field asks for, so the whole path —
 * prompt, structured answer, checks, retry — is exercised. Tests can override answers per field and attempt.
 */
export const GOOD_KEY = 'sk-ant-test-GOODKEY-0123456789abcdefghij';
export const MODELS = [
  { type: 'model', id: 'claude-test-large', display_name: 'Claude Test Large', created_at: '2026-06-01T00:00:00Z' },
  { type: 'model', id: 'claude-test-small', display_name: 'Claude Test Small', created_at: '2026-03-01T00:00:00Z' },
];

export interface MockClaudeRequest { key: string; body: { model: string; system: string; messages: { content: ({ type: 'text'; text: string } | { type: 'image'; source: { url: string } })[] }[]; tools: { name: string }[]; tool_choice: { name: string } } }

export function createMockClaude(opts: { override?: (key: string, attempt: number, prompt: string) => string | undefined } = {}) {
  const requests: MockClaudeRequest[] = [];
  const attempts = new Map<string, number>();
  const faults: { status: number; times?: number; type?: string }[] = [];
  let revoked = false;

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  function vocab(prompt: string): string[] {
    const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? '';
    const desc = /Description \/ content \(plain text\):\n"""\n([\s\S]*?)\n"""/.exec(prompt)?.[1] ?? '';
    const words = `${title} ${desc}`.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^\d/.test(w));
    const seen = new Set<string>();
    return words.filter((w) => !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
  }

  /** A sentence from the prompt's own words, at least `lo` and at most `hi` characters. */
  function sentence(words: string[], lo: number, hi: number, maxUse = 1, start = 0): string {
    const use = new Map<string, number>();
    const out: string[] = [];
    for (let i = start; out.join(' ').length < lo && i < start + words.length * maxUse; i++) {
      const w = words[i % words.length];
      if ((use.get(w) ?? 0) >= maxUse) continue;
      if (`${out.join(' ')} ${w}`.trim().length + 1 > hi) break;
      out.push(w);
      use.set(w, (use.get(w) ?? 0) + 1);
    }
    const s = out.join(' ');
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  }

  function write(key: string, block: string, prompt: string): string {
    const words = vocab(prompt);
    const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? 'Product';
    const shop = /^Shop: (.*)$/m.exec(prompt)?.[1] ?? '';
    const t = /target length: (\d+)–(\d+)/.exec(block);
    const lo = t ? Number(t[1]) : 10;
    const hi = t ? Number(t[2]) : 120;
    if (key === 'seoTitle') {
      const suffix = shop && shop !== 'unknown' && !/do not add the shop name/.test(block) ? ` | ${shop}` : '';
      const head = sentence([...title.split(' '), ...words], Math.max(1, lo - suffix.length), hi - suffix.length);
      return `${head}${suffix}`;
    }
    if (key === 'seoDescription') return `${sentence(words, lo - 1, hi - 1)}.`;
    if (key === 'title' || key === 'h1') return sentence(title.split(' '), Math.max(lo, 20), Math.min(hi, 60));
    if (key === 'bodyHtml') {
      const parts: string[] = [];
      let len = 0;
      for (let i = 0; len < lo + 20 && i < 12; i++) { const s = `${sentence(words, 90, 140, 1, i * 3)}.`; parts.push(`<p>${s}</p>`); len += s.length + 1; }
      return parts.join('');
    }
    if (key.startsWith('imageAlt:')) return `${title.split(' ').slice(0, 6).join(' ')} shown ${key.endsWith('featured') ? 'from the front' : `close up, view ${'abcdefghij'[Number(key.slice(-1)) % 10]}`}`;
    if (key === 'tags') return words.slice(0, 4).map((w) => w.toLowerCase()).join(', ');
    return sentence(words, lo, hi);
  }

  async function handle(url: string, init: RequestInit = {}): Promise<Response> {
    const key = String((init.headers as Record<string, string>)?.['x-api-key'] ?? '');
    const f = faults[0];
    if (f) { if (!f.times || --f.times <= 0) faults.shift(); return json({ type: 'error', error: { type: f.type ?? 'rate_limit_error', message: 'mock fault' } }, f.status, f.status === 429 ? { 'retry-after': '0' } : {}); }
    if (key !== GOOD_KEY || revoked) return json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
    const u = new URL(url);
    if (u.pathname === '/v1/models' && (init.method ?? 'GET') === 'GET') return json({ data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS[MODELS.length - 1].id });
    if (u.pathname === '/v1/messages' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as MockClaudeRequest['body'];
      requests.push({ key: '[key]', body });
      if (!MODELS.some((m) => m.id === body.model)) return json({ type: 'error', error: { type: 'not_found_error', message: `model: ${body.model}` } }, 404);
      const prompt = body.messages[0].content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('\n');
      const fieldsPart = prompt.split('Fields to write:')[1] ?? '';
      const blocks = fieldsPart.split(/\n(?=- key: )/).filter((b) => b.trim().startsWith('- key: '));
      const fields = blocks.map((b) => {
        const key = /- key: (\S+)/.exec(b)![1];
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        const value = opts.override?.(key, n, prompt) ?? write(key, b, prompt);
        return { key, value, reason: `Mock model wrote ${key} from the page content.` };
      });
      return json({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_mock', name: body.tool_choice.name, input: { fields } }], usage: { input_tokens: 100, output_tokens: 100 } });
    }
    return json({ type: 'error', error: { type: 'not_found_error', message: 'unknown route' } }, 404);
  }

  return {
    requests, faults,
    revoke() { revoked = true; },
    /** Wraps another fetch (mock Shopify): Anthropic URLs go to this mock, the rest to `next`. */
    wrap(next: (url: string, init?: RequestInit) => Promise<Response>) {
      return (input: string, init?: RequestInit) => (String(input).startsWith('https://api.anthropic.com/') ? handle(String(input), init) : next(input, init));
    },
  };
}
