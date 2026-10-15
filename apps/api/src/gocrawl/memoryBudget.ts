/**
 * Memory accounting for a crawl across every process that works on it: the API (Node.js), the Go crawler and the Rust
 * text core. On a ~500 MB host the budget is what matters, not the Node heap limit: an 8 GB --max-old-space-size does
 * not give the machine more memory, it only lets Node grow until the host kills the service.
 */
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';

/** Memory limit of this container (cgroup v2 / v1), in MB — undefined when unlimited or not on Linux. */
export function cgroupLimitMB(): number | undefined {
  const files = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      if (raw === 'max') return undefined;
      const n = Number(raw);
      // v1 reports a huge number (≈ 2^63) when there is no limit.
      if (Number.isFinite(n) && n > 0 && n < 2 ** 50) return Math.floor(n / 1048576);
    } catch {
      /* not there */
    }
  }
  return undefined;
}

export interface MemoryPlan {
  /** Total MB the crawl's processes may use together before the crawl stops taking new pages (resource stop). */
  budgetMB?: number;
  /** Go crawler heap limit (soft limit + guard). */
  goMemoryMB: number;
  /** Where the budget came from. */
  basis: string;
}

export function memoryPlan(env: { CRAWLER_MEMORY_BUDGET_MB?: number; CRAWLER_GO_MEMORY_MB?: number }): MemoryPlan {
  const limit = cgroupLimitMB();
  let budgetMB: number | undefined;
  let basis: string;
  if (env.CRAWLER_MEMORY_BUDGET_MB) {
    budgetMB = env.CRAWLER_MEMORY_BUDGET_MB;
    basis = 'CRAWLER_MEMORY_BUDGET_MB';
  } else if (limit) {
    budgetMB = Math.floor(limit * 0.85);
    basis = `85% of the container memory limit (${limit} MB)`;
  } else {
    budgetMB = undefined;
    basis = `no container memory limit detected (machine has ${Math.round(os.totalmem() / 1048576)} MB); set CRAWLER_MEMORY_BUDGET_MB to enforce one`;
  }
  const goMemoryMB = env.CRAWLER_GO_MEMORY_MB ?? (budgetMB ? Math.max(64, Math.min(160, Math.floor(budgetMB * 0.35))) : 160);
  return { budgetMB, goMemoryMB, basis };
}

/** RSS of this Node.js process (MB) and its V8 heap use. */
export function nodeMemory(): { rssMB: number; heapMB: number } {
  const m = process.memoryUsage();
  return { rssMB: Math.round((m.rss / 1048576) * 10) / 10, heapMB: Math.round((m.heapUsed / 1048576) * 10) / 10 };
}

/**
 * Measured peak live heap of the streaming analysis per page (index + text-core view + page checks): about 4 KB on the
 * synthetic 50,000-product store (225 MB at 53,000 pages under a 256 MB heap). 4.5 KB leaves a margin.
 */
export const ANALYSIS_BYTES_PER_PAGE = 4.5 * 1024;

/** Pages the API can analyse after a crawl with the heap it has left (at least 1,000). */
export function analyzablePages(): number {
  const h = v8.getHeapStatistics();
  const free = h.heap_size_limit * 0.9 - h.used_heap_size - 40 * 1048576;
  return Math.max(1000, Math.floor(free / ANALYSIS_BYTES_PER_PAGE));
}
