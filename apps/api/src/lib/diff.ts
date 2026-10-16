/**
 * Line diffs for the comparison views (rendered DOM, CSS / JS assets, theme files), and the formatters that turn one-line
 * (minified) sources into comparable lines.
 *
 * Patience diff: lines that occur exactly once on both sides anchor the comparison (in order), the gaps between anchors
 * are compared recursively, and small gaps with a classic LCS. Memory stays bounded on large pages: an LCS table is only
 * built for gaps of at most LCS_CELLS cells; a larger gap without anchors is shown as "replaced".
 */

export interface DiffOp { op: ' ' | '+' | '-'; text: string; a?: number; b?: number }
export interface DiffResult {
  /** Changed lines with `context` lines around them; long unchanged runs collapse to one "…" line (op '…'). */
  lines: { op: ' ' | '+' | '-' | '…'; text: string; a?: number; b?: number }[];
  added: number;
  removed: number;
  /** The line lists were cut to `maxLines` for display. */
  truncated: boolean;
  /** At least one large region had no common anchor and is shown as replaced rather than line by line. */
  coarse: boolean;
}

const LCS_CELLS = 2_000_000;

function lcs(A: string[], B: string[], a0: number, b0: number, out: DiffOp[]) {
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: ' ', text: A[i], a: a0 + i, b: b0 + j }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: '-', text: A[i], a: a0 + i }); i++; }
    else { out.push({ op: '+', text: B[j], b: b0 + j }); j++; }
  }
  for (; i < n; i++) out.push({ op: '-', text: A[i], a: a0 + i });
  for (; j < m; j++) out.push({ op: '+', text: B[j], b: b0 + j });
}

/** Longest increasing subsequence of `xs` (indices into xs). */
function lis(xs: number[]): number[] {
  const tails: number[] = [];
  const prev = new Int32Array(xs.length).fill(-1);
  for (let k = 0; k < xs.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[tails[mid]] < xs[k]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(k);
  return out.reverse();
}

function patience(A: string[], B: string[], a0: number, b0: number, out: DiffOp[], state: { coarse: boolean }, depth = 0) {
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) { out.push({ op: ' ', text: A[pre], a: a0 + pre, b: b0 + pre }); pre++; }
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  const sa = a0 + pre, sb = b0 + pre;
  const tail = () => { for (let k = A.length - suf; k < A.length; k++) out.push({ op: ' ', text: A[k], a: a0 + k, b: b0 + B.length - (A.length - k) }); };
  if (!a.length || !b.length) {
    a.forEach((t, k) => out.push({ op: '-', text: t, a: sa + k }));
    b.forEach((t, k) => out.push({ op: '+', text: t, b: sb + k }));
    tail();
    return;
  }
  // Unique common lines, in A order, then the longest run that is also in B order.
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  a.forEach((t, k) => ca.set(t, ca.has(t) ? -1 : k));
  b.forEach((t, k) => cb.set(t, cb.has(t) ? -1 : k));
  const pairs: [number, number][] = [];
  for (const [t, i] of ca) { const j = cb.get(t); if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]); }
  pairs.sort((x, y) => x[0] - y[0]);
  const anchors = lis(pairs.map((p) => p[1])).map((k) => pairs[k]);
  if (!anchors.length || depth > 200) {
    if (a.length * b.length <= LCS_CELLS) lcs(a, b, sa, sb, out);
    else {
      state.coarse = true;
      a.forEach((t, k) => out.push({ op: '-', text: t, a: sa + k }));
      b.forEach((t, k) => out.push({ op: '+', text: t, b: sb + k }));
    }
    tail();
    return;
  }
  let pi = 0, pj = 0;
  for (const [i, j] of anchors) {
    patience(a.slice(pi, i), b.slice(pj, j), sa + pi, sb + pj, out, state, depth + 1);
    out.push({ op: ' ', text: a[i], a: sa + i, b: sb + j });
    pi = i + 1; pj = j + 1;
  }
  patience(a.slice(pi), b.slice(pj), sa + pi, sb + pj, out, state, depth + 1);
  tail();
}

export function diffLines(oldText: string, newText: string, opts: { context?: number; maxLines?: number } = {}): DiffResult {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 4000;
  const A = oldText.length ? oldText.split('\n') : [];
  const B = newText.length ? newText.split('\n') : [];
  const ops: DiffOp[] = [];
  const state = { coarse: false };
  patience(A, B, 0, 0, ops, state);
  let added = 0, removed = 0;
  for (const o of ops) { if (o.op === '+') added++; else if (o.op === '-') removed++; }
  // Keep changed lines and `context` lines around them.
  const near = new Uint8Array(ops.length);
  ops.forEach((o, k) => { if (o.op !== ' ') for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) near[d] = 1; });
  const lines: DiffResult['lines'] = [];
  let truncated = false;
  for (let k = 0; k < ops.length; k++) {
    if (lines.length >= maxLines) { truncated = true; break; }
    if (near[k]) lines.push(ops[k]);
    else if (k === 0 || near[k - 1]) lines.push({ op: '…', text: '' });
  }
  return { lines, added, removed, truncated, coarse: state.coarse };
}

// ------------------------------------------------------------------------------------------------ formatters

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Attributes whose values change on every load (nonces, tokens, session ids) and would hide real differences. */
const VOLATILE_ATTR = /\s(nonce|integrity|data-csrf[\w-]*|data-request-id|data-session[\w-]*|data-timestamp|data-nonce)="[^"]*"/gi;

/**
 * Rendered HTML → one element per line, indented by depth, with inline script / style bodies replaced by a short hash
 * marker and volatile attributes removed. What remains is what a visitor and a search engine get.
 */
export function formatHtml(html: string, maxLines = 30_000): string {
  const out: string[] = [];
  let depth = 0;
  const src = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '');
  const re = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  let m: RegExpExecArray | null;
  const pad = () => '  '.repeat(Math.min(depth, 40));
  while ((m = re.exec(src)) && out.length < maxLines) {
    const tok = m[0];
    if (m[1]) {
      const body = m[3].trim();
      const tag = `<${m[1]}${m[2].replace(VOLATILE_ATTR, '')}>`.replace(/\s+/g, ' ');
      out.push(`${pad()}${tag}${body ? `[${body.length.toLocaleString('en-US')} chars, #${hash(body)}]` : ''}</${m[1]}>`);
      continue;
    }
    if (tok.startsWith('</')) { depth = Math.max(0, depth - 1); out.push(`${pad()}${tok.replace(/\s+/g, ' ')}`); continue; }
    if (tok.startsWith('<')) {
      const name = /^<([a-zA-Z0-9-]+)/.exec(tok)?.[1]?.toLowerCase() ?? '';
      out.push(`${pad()}${tok.replace(VOLATILE_ATTR, '').replace(/\s+/g, ' ')}`);
      if (!VOID.has(name) && !tok.endsWith('/>') && name !== '!doctype') depth++;
      continue;
    }
    const text = tok.replace(/\s+/g, ' ').trim();
    if (text) out.push(`${pad()}${text}`);
  }
  return out.join('\n');
}

/** Minified CSS → one rule / declaration block per line. */
export function formatCss(css: string, maxLines = 30_000): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\}\s*/g, '}\n').replace(/\{\s*/g, ' {\n  ').replace(/;\s*/g, ';\n  ')
    .split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, maxLines).join('\n');
}

/** Minified JS → split at statement and block boundaries (an approximation, good enough to see what changed). */
export function formatJs(js: string, maxLines = 30_000): string {
  if (js.split('\n').length > 50 && js.length / js.split('\n').length < 200) return js.split('\n').slice(0, maxLines).join('\n'); // already readable
  return js.replace(/;(?=\S)/g, ';\n').replace(/\{(?=\S)/g, '{\n').replace(/\}(?=[^\s,;)])/g, '}\n').split('\n').slice(0, maxLines).join('\n');
}

export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
