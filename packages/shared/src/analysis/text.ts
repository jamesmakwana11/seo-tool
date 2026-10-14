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

/**
 * "Fill-in-the-blank" template detection (AIC-01): after masking the product name,
 * pages that are ≥ `threshold` similar are treated as near-identical.
 */
export function nearIdenticalClusters(docs: { id: string; text: string; mask?: string }[], threshold = 0.8): string[][] {
  const sh = docs.map((d) => ({ id: d.id, s: shingles(d.mask ? d.text.split(d.mask).join(' PRODUCT ') : d.text, 4) }));
  const parent = new Map(sh.map((d) => [d.id, d.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < sh.length; i++) {
    for (let j = i + 1; j < sh.length; j++) {
      if (jaccard(sh[i].s, sh[j].s) >= threshold) parent.set(find(sh[i].id), find(sh[j].id));
    }
  }
  const groups = new Map<string, string[]>();
  for (const d of sh) {
    const r = find(d.id);
    groups.set(r, [...(groups.get(r) ?? []), d.id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
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
