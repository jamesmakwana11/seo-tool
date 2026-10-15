/**
 * Deterministic text heuristics used by Module 7 (AI-content compliance) and the
 * custom rule builder. These are heuristics, not an AI-detector: results are
 * "flags for human review", never a claim that content is or isn't AI-written
 * (prompt §5.10: "Do not claim AI-generated copy is safe simply because it passes…").
 */

export function wordCount(text: string): number {
  const m = text.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

export interface PassageHit {
  passage: string;
  reason: string;
  index: number;
}

/** AIC-02 — unedited AI boilerplate markers (PDF p14). */
export const AI_BOILERPLATE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /as an ai language model/i, reason: 'Literal LLM self-reference ("As an AI language model")' },
  { re: /\bin today'?s fast[- ]paced world\b/i, reason: 'Generic filler ("In today\'s fast-paced world")' },
  { re: /\bin conclusion,/i, reason: '"In conclusion," stack typical of unedited AI output' },
  { re: /\b(lorem ipsum|\[(insert|product name|keyword)[^\]]*\])/i, reason: 'Placeholder text left in published copy' },
  { re: /\bunlock the (power|potential) of\b/i, reason: 'Generic AI marketing filler ("unlock the power of")' },
  { re: /\b(elevate|revolutioni[sz]e) your (experience|kitchen|home|life)\b/i, reason: 'Generic AI marketing filler' },
  { re: /\bwhether you(?:'| a)re a\b.*\bor a\b/i, reason: 'Formulaic "Whether you\'re a … or a …" opener' },
];

/** AIC-12 — outdated-model artifacts (PDF p15). */
export const AI_ARTIFACT_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bas of (my (last|knowledge) (update|cutoff)|20(1\d|2[0-3]))\b/i, reason: 'Stale AI date reference ("as of 2023" / knowledge cutoff)' },
  { re: /\*\*[^*\n]{2,80}\*\*/, reason: 'Markdown asterisks rendered literally' },
  { re: /^#{1,6}\s/m, reason: 'Markdown heading syntax rendered literally' },
  { re: /\b(here is|here's) (a|the) (rewritten|revised|product) (description|version)\b/i, reason: 'Prompt-leak fragment ("Here is the rewritten description")' },
  { re: /\b(certainly|sure)!? (here|below) (is|are)\b/i, reason: 'Assistant reply preamble left in copy' },
];

/** AIC-07 — YMYL claim vocabulary (PDF p15). */
export const YMYL_CLAIM_PATTERNS: { re: RegExp; claim: string }[] = [
  { re: /\bbpa[- ]free\b/i, claim: 'BPA-free' },
  { re: /\bchild[- ]safe\b/i, claim: 'child-safe' },
  { re: /\bshock[- ]?proof\b/i, claim: 'shockproof' },
  { re: /\bnon[- ]toxic\b/i, claim: 'non-toxic' },
  { re: /\bfood[- ]grade\b/i, claim: 'food-grade' },
  { re: /\bfire[- ]?proof\b/i, claim: 'fireproof' },
  { re: /\b(isi|bis|ce|fda)[- ]certified\b/i, claim: 'certification claim' },
  { re: /\bmedical[- ]grade\b/i, claim: 'medical-grade' },
];

export function findPatternHits(text: string, patterns: { re: RegExp; reason?: string; claim?: string }[]): PassageHit[] {
  const hits: PassageHit[] = [];
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) hits.push({ passage: excerpt(text, m.index, m[0].length), reason: p.reason ?? `Claim: ${p.claim}`, index: m.index });
  }
  return hits;
}

export function excerpt(text: string, index: number, len: number, pad = 60): string {
  const start = Math.max(0, index - pad);
  const end = Math.min(text.length, index + len + pad);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Keyword density (%) of an exact phrase in text. */
export function keywordDensity(text: string, keyword: string): number {
  const words = wordCount(text);
  if (!words || !keyword.trim()) return 0;
  const re = new RegExp(`\\b${escapeRegExp(keyword.trim())}\\b`, 'gi');
  const occurrences = (text.match(re) || []).length;
  const kwWords = wordCount(keyword);
  return Math.round(((occurrences * kwWords) / words) * 1000) / 10;
}

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word shingles for near-duplicate detection. */
export function shingles(text: string, n = 5): Set<string> {
  const w = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 53-bit string hash (cyrb53): collisions are practically impossible at crawl sizes. */
function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Word-shingle fingerprints (hashed), same tokenisation as `shingles`. */
function shingleHashes(text: string, n: number): Set<number> {
  const w = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<number>();
  for (let i = 0; i + n <= w.length; i++) out.add(hash53(w.slice(i, i + n).join(' ')));
  return out;
}

/**
 * "Fill-in-the-blank" template detection (AIC-01): after masking the product name,
 * pages that are ≥ `threshold` similar (Jaccard over 4-word shingles) are treated as near-identical.
 *
 * Exact all-pairs similarity join without comparing every pair, so it scales to 50,000+ pages:
 * - prefix filtering: shingles are ordered rarest-first; two sets with Jaccard ≥ t must share a token within their
 *   first |x| − ⌈t·|x|⌉ + 1 tokens, so only pairs sharing such a token are compared (no true match is missed);
 * - size filtering: a set cannot reach t with a set smaller than t·|x|;
 * - pages with identical shingle sets are joined directly and only one of them is indexed;
 * - pairs already in the same cluster are not compared again.
 * Memory stays flat: shingles are kept as sorted integer ranks in typed arrays (no per-shingle objects, no Map with an
 * entry per distinct shingle, which would hit the engine's 16.7M-entry limit on very large crawls).
 * Clusters (and their member order) are the same as comparing every pair.
 */
export function nearIdenticalClusters(docs: { id: string; text: string; mask?: string }[], threshold = 0.8): string[][] {
  const n = docs.length;
  // 1. Each document's distinct shingle hashes, sorted (typed arrays: 8 bytes per shingle, no boxed numbers).
  const hashes: Float64Array[] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = docs[i];
    const a = Float64Array.from(shingleHashes(d.mask ? d.text.split(d.mask).join(' PRODUCT ') : d.text, 4));
    a.sort();
    hashes[i] = a;
    total += a.length;
  }
  // 2. Global token table: distinct hashes with their document frequency, then a rank per token in the order
  //    (frequency ascending, hash ascending) — rarest first, ties broken by hash value.
  const flat = new Float64Array(total);
  for (let i = 0, off = 0; i < n; i++) { flat.set(hashes[i], off); off += hashes[i].length; }
  flat.sort();
  let u = 0;
  const uniq = new Float64Array(total);
  const count = new Int32Array(total);
  for (let k = 0; k < total; k++) {
    if (k === 0 || flat[k] !== flat[k - 1]) { uniq[u] = flat[k]; count[u] = 1; u++; } else count[u - 1]++;
  }
  // Counting sort by frequency keeps hash order inside one frequency.
  const byFreq = new Int32Array(n + 2);
  for (let k = 0; k < u; k++) byFreq[count[k] + 1]++;
  for (let f = 1; f < byFreq.length; f++) byFreq[f] += byFreq[f - 1];
  const rankOf = new Int32Array(u);
  for (let k = 0; k < u; k++) rankOf[k] = byFreq[count[k]]++;
  const find32 = (h: number) => {
    let lo = 0;
    let hi = u - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = uniq[mid];
      if (v === h) return mid;
      if (v < h) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };
  // 3. Each document as ascending ranks (= rarest-first order). Same set ⇔ same rank array.
  const ranks: Int32Array[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = hashes[i];
    const r = new Int32Array(a.length);
    for (let k = 0; k < a.length; k++) r[k] = rankOf[find32(a[k])];
    r.sort();
    ranks[i] = r;
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  // Two empty sets are identical (Jaccard 1); an empty set is never similar to a non-empty one.
  let firstEmpty = -1;
  for (let i = 0; i < n; i++) if (!ranks[i].length) { if (firstEmpty < 0) firstEmpty = i; else union(firstEmpty, i); }
  // 4. Identical sets (Jaccard 1 ≥ any threshold): join them and index one representative only.
  const reps: number[] = [];
  const bySignature = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const r = ranks[i];
    if (!r.length) continue;
    let h1 = 0x811c9dc5 ^ r.length;
    let h2 = 0x9e3779b9;
    for (let k = 0; k < r.length; k++) { h1 = Math.imul(h1 ^ r[k], 16777619); h2 = Math.imul(h2 ^ r[k], 2246822519) + k; }
    const sig = `${r.length}:${h1 >>> 0}:${h2 >>> 0}`;
    const cands = bySignature.get(sig);
    const same = cands?.find((j) => equalArrays(ranks[j], r));
    if (same !== undefined) { union(i, same); continue; }
    if (cands) cands.push(i); else bySignature.set(sig, [i]);
    reps.push(i);
  }
  bySignature.clear();
  // 5. Prefix-filtered join over the representatives, smallest sets first. The inverted index is split into shards so
  //    no single Map approaches the engine's entry limit.
  reps.sort((a, b) => ranks[a].length - ranks[b].length || a - b);
  const SHARDS = 16;
  const index: Map<number, number[]>[] = Array.from({ length: SHARDS }, () => new Map());
  const stamp = new Int32Array(n).fill(-1);
  const eps = 1e-9;
  for (const x of reps) {
    const rx = ranks[x];
    const sx = rx.length;
    const minSize = threshold * sx - eps;
    const prefix = Math.min(sx, sx - Math.ceil(threshold * sx - eps) + 1);
    for (let k = 0; k < prefix; k++) {
      const list = index[rx[k] % SHARDS].get(rx[k]);
      if (!list) continue;
      for (const y of list) {
        if (stamp[y] === x) continue;
        stamp[y] = x;
        if (ranks[y].length < minSize) continue;
        if (find(x) === find(y)) continue;
        if (jaccardSorted(rx, ranks[y]) >= threshold) union(x, y);
      }
    }
    for (let k = 0; k < prefix; k++) {
      const t = rx[k];
      const shard = index[t % SHARDS];
      const list = shard.get(t);
      if (list) list.push(x);
      else shard.set(t, [x]);
    }
  }
  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(docs[i].id);
    else groups.set(r, [docs[i].id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

function equalArrays(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** Jaccard of two ascending integer arrays (merge intersection). */
function jaccardSorted(a: Int32Array, b: Int32Array): number {
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { inter++; i++; j++; } else if (a[i] < b[j]) i++; else j++;
  }
  return inter / (a.length + b.length - inter);
}

/** Flesch reading ease (English approximation). */
export function readingEase(text: string): number {
  const w = wordCount(text);
  const s = Math.max(1, sentences(text).length);
  const syl = (text.toLowerCase().match(/[aeiouy]+/g) || []).length;
  if (!w) return 0;
  return Math.round((206.835 - 1.015 * (w / s) - 84.6 * (syl / w)) * 10) / 10;
}

/**
 * Repeated sentence-rhythm signal (AIC-02): share of sentences whose length is within ±2 words
 * of the median — very uniform rhythm is a weak signal of unedited generation.
 */
export function rhythmUniformity(text: string): number {
  const lens = sentences(text).map(wordCount).filter((n) => n > 0);
  if (lens.length < 5) return 0;
  const sorted = [...lens].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  return Math.round((lens.filter((n) => Math.abs(n - med) <= 2).length / lens.length) * 100) / 100;
}

/**
 * Heuristic "AI-likelihood" 0–100 for threshold rules. Explicitly a heuristic composite of
 * boilerplate hits, artifact hits and rhythm uniformity — NOT a classifier.
 */
export function aiLikelihoodHeuristic(text: string): number {
  const b = findPatternHits(text, AI_BOILERPLATE_PATTERNS).length;
  const a = findPatternHits(text, AI_ARTIFACT_PATTERNS).length;
  const r = rhythmUniformity(text);
  return Math.min(100, Math.round(b * 25 + a * 20 + r * 30));
}

/** Keyword stuffing (AIC-09): exact-match density above `maxPct`. */
export function isKeywordStuffed(text: string, keyword: string, maxPct = 3): { stuffed: boolean; density: number } {
  const density = keywordDensity(text, keyword);
  return { stuffed: density > maxPct, density };
}
