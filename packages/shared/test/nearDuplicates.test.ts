import { describe, expect, it } from 'vitest';
import { jaccard, nearIdenticalClusters, shingles } from '../src';

/** The original definition: compare every pair (reference for equivalence). */
function bruteForce(docs: { id: string; text: string; mask?: string }[], threshold: number): string[][] {
  const sh = docs.map((d) => ({ id: d.id, s: shingles(d.mask ? d.text.split(d.mask).join(' PRODUCT ') : d.text, 4) }));
  const parent = new Map(sh.map((d) => [d.id, d.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (let i = 0; i < sh.length; i++) for (let j = i + 1; j < sh.length; j++) if (jaccard(sh[i].s, sh[j].s) >= threshold) parent.set(find(sh[i].id), find(sh[j].id));
  const groups = new Map<string, string[]>();
  for (const d of sh) { const r = find(d.id); groups.set(r, [...(groups.get(r) ?? []), d.id]); }
  return [...groups.values()].filter((g) => g.length > 1);
}

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}
const VOCAB = 'steel kitchen chopper sharp blades easy clean wholesale price india free shipping durable plastic lid container airtight fresh food storage gift toy kids car racing lights festive decor home'.split(' ');

function corpus(seed: number, n: number) {
  const r = rng(seed);
  const templates = Array.from({ length: 4 }, () => Array.from({ length: 30 + Math.floor(r() * 40) }, () => VOCAB[Math.floor(r() * VOCAB.length)]));
  return Array.from({ length: n }, (_, i) => {
    const name = `Product ${i} ${VOCAB[i % VOCAB.length]}`;
    const kind = r();
    let words: string[];
    if (kind < 0.5) {
      // template copy with a few random edits and the product name inserted
      words = [...templates[Math.floor(r() * templates.length)]];
      const edits = Math.floor(r() * 6);
      for (let e = 0; e < edits; e++) words[Math.floor(r() * words.length)] = VOCAB[Math.floor(r() * VOCAB.length)];
      words.splice(Math.floor(r() * words.length), 0, ...name.split(' '));
    } else if (kind < 0.9) {
      words = Array.from({ length: 10 + Math.floor(r() * 60) }, () => VOCAB[Math.floor(r() * VOCAB.length)]);
    } else {
      words = Array.from({ length: Math.floor(r() * 3) }, () => VOCAB[Math.floor(r() * VOCAB.length)]); // too short: empty shingle set
    }
    return { id: `https://shop.example/p/${i}`, text: words.join(' '), mask: r() < 0.7 ? name : undefined };
  });
}

describe('nearIdenticalClusters', () => {
  it.each([[1, 0.8], [2, 0.85], [3, 0.9], [4, 0.75], [5, 0.5], [6, 0.95]])('matches the every-pair result exactly (seed %i, threshold %f)', (seed, t) => {
    const docs = corpus(seed, 400);
    expect(nearIdenticalClusters(docs, t)).toEqual(bruteForce(docs, t));
  });

  it('finds clusters of identical copy and keeps unrelated pages apart', () => {
    const base = 'this premium kitchen chopper has sharp steel blades and is easy to clean at a wholesale price with free shipping';
    const docs = [
      { id: 'a', text: `Alpha ${base}`, mask: 'Alpha' }, { id: 'b', text: `Beta ${base}`, mask: 'Beta' }, { id: 'c', text: `Gamma ${base}`, mask: 'Gamma' },
      { id: 'd', text: 'completely different words about racing cars lights and festive decor for the home and kids toys' },
    ];
    expect(nearIdenticalClusters(docs, 0.8)).toEqual([['a', 'b', 'c']]);
  });

  it('stays fast on 20,000 pages of template copy', () => {
    const docs = corpus(7, 20000);
    const t0 = Date.now();
    const clusters = nearIdenticalClusters(docs, 0.8);
    const ms = Date.now() - t0;
    expect(clusters.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(60000);
  }, 120000);
});
