/**
 * Keeping large crawls inside the server's memory.
 *
 * 1. String sharing: pages of one site repeat the same header / footer links, image URLs, menu text and script URLs.
 *    Each parsed page would otherwise hold its own copy of every one of those strings. `createInterner` maps equal
 *    strings to one shared instance, so the copies can be garbage-collected. Analysis results are unchanged.
 * 2. Memory guard: `memoryPressure()` reports when the JavaScript heap is close to its limit, so a crawl can stop
 *    taking new pages and finish with what it has instead of crashing the server (which would lose everything kept
 *    in memory).
 */
import v8 from 'node:v8';
import type { ParsedHtml } from './types';

export function createInterner() {
  const pool = new Map<string, string>();
  const s = <T extends string | undefined | null>(v: T): T => {
    if (typeof v !== 'string' || v.length > 2000) return v;
    const hit = pool.get(v);
    if (hit !== undefined) return hit as T;
    pool.set(v, v);
    return v;
  };
  const arr = (a: string[]) => {
    for (let i = 0; i < a.length; i++) a[i] = s(a[i]);
  };
  /** Replaces repeated strings inside one parsed page with shared instances (in place). */
  function parsed(h: ParsedHtml): ParsedHtml {
    for (const l of h.links) {
      l.url = s(l.url);
      l.text = s(l.text);
      if (l.rel !== undefined) l.rel = s(l.rel);
    }
    arr(h.internalLinks);
    arr(h.externalLinks);
    arr(h.canonicals);
    arr(h.scriptSrcs);
    arr(h.stylesheets);
    arr(h.schemaTypes);
    arr(h.blocks);
    arr(h.ownBlocks);
    for (const img of h.images) {
      img.src = s(img.src);
      img.alt = s(img.alt);
      img.width = s(img.width);
      img.height = s(img.height);
      img.loading = s(img.loading);
    }
    for (const sc of h.headScripts) {
      sc.src = s(sc.src);
      sc.type = s(sc.type);
    }
    for (const x of h.headings) x.text = s(x.text);
    for (const x of h.segments) x.text = s(x.text);
    h.metaRobots = s(h.metaRobots);
    h.lang = s(h.lang);
    return h;
  }
  return { string: s, parsed, size: () => pool.size };
}

export type Interner = ReturnType<typeof createInterner>;

/** Heap use as a fraction of the heap limit (0–1). */
export function heapFraction(): number {
  const st = v8.getHeapStatistics();
  return st.used_heap_size / st.heap_size_limit;
}

export function heapLimitMb(): number {
  return Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
}

/**
 * True when the heap is above `threshold` of its limit even after V8 had a chance to collect garbage. Checked at most
 * every `everyMs` so it costs nothing on small crawls.
 */
export function createMemoryGuard(threshold = 0.8, everyMs = 2000) {
  let last = 0;
  let tripped = false;
  return {
    pressure(): boolean {
      if (tripped) return true;
      const now = Date.now();
      if (now - last < everyMs) return false;
      last = now;
      if (heapFraction() < threshold) return false;
      // Allocation-heavy moments can look full before the next GC: confirm on the next check.
      global.gc?.();
      tripped = heapFraction() >= threshold;
      return tripped;
    },
    get tripped() { return tripped; },
  };
}
