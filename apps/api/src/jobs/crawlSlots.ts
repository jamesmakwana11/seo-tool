/**
 * Server-wide admission for crawl jobs (every website shares one API process and one machine).
 *
 * Any number of crawls can be started — one per website, e.g. a batch of 11 websites — and every one is stored as a
 * job. Only some run at the same time: a queued crawl starts, in the order it was queued, when
 *  - fewer than CRAWLER_MAX_CONCURRENT_JOBS crawls are running, and
 *  - the memory in use (API process + every running crawler / text core process) leaves room for one more crawl
 *    (CRAWLER_JOB_RESERVE_MB) within the memory budget (CRAWLER_MEMORY_BUDGET_MB, else 85 % of the container limit), and
 *  - the API's Node.js heap has the same room.
 * One crawl may always run, so a busy server never blocks every crawl. Waiting crawls are re-checked every second and
 * whenever a crawl ends. A waiting crawl can be cancelled; it then leaves the queue without ever starting.
 */
import v8 from 'node:v8';
import { activeChildMemoryMB } from '../gocrawl/engine';
import { memoryPlan, nodeMemory } from '../gocrawl/memoryBudget';

export interface SlotLimits {
  CRAWLER_MAX_CONCURRENT_JOBS: number;
  CRAWLER_JOB_RESERVE_MB: number;
  CRAWLER_MEMORY_BUDGET_MB?: number;
}

interface Waiter { id: string; limits: SlotLimits; grant: (ok: boolean) => void }

const waiters: Waiter[] = [];
let active = 0;
let lastBlock: string | undefined;
let timer: NodeJS.Timeout | undefined;
let peakActive = 0;

/** Why another crawl cannot start right now, or undefined. */
export function admissionBlock(l: SlotLimits): string | undefined {
  if (active >= l.CRAWLER_MAX_CONCURRENT_JOBS) return `${active} of ${l.CRAWLER_MAX_CONCURRENT_JOBS} crawl slots are in use (CRAWLER_MAX_CONCURRENT_JOBS)`;
  if (active === 0) return undefined;
  const budget = memoryPlan(l).budgetMB;
  const used = Math.round(nodeMemory().rssMB + activeChildMemoryMB());
  if (budget && used + l.CRAWLER_JOB_RESERVE_MB > budget) {
    return `${used} MB of the ${budget} MB memory budget are in use; another crawl needs about ${l.CRAWLER_JOB_RESERVE_MB} MB (CRAWLER_JOB_RESERVE_MB)`;
  }
  const h = v8.getHeapStatistics();
  const heapUsedMB = h.used_heap_size / 1048576;
  const heapLimitMB = h.heap_size_limit / 1048576;
  if (heapUsedMB + l.CRAWLER_JOB_RESERVE_MB / 2 > heapLimitMB * 0.8) {
    return `the API's Node.js heap is ${Math.round(heapUsedMB)} of ${Math.round(heapLimitMB)} MB; another crawl needs room for its analysis`;
  }
  return undefined;
}

function pump() {
  while (waiters.length) {
    const why = admissionBlock(waiters[0].limits);
    if (why) { lastBlock = why; break; }
    const w = waiters.shift()!;
    active++;
    peakActive = Math.max(peakActive, active);
    w.grant(true);
  }
  if (!waiters.length) { lastBlock = undefined; if (timer) { clearInterval(timer); timer = undefined; } }
  else if (!timer) { timer = setInterval(pump, 1000); timer.unref(); }
}

/**
 * Waits for a slot for crawl `id` (FIFO). Resolves true when the crawl may run (call release() when it ends), or false
 * when `signal` aborted first (cancelled while queued) — then no slot is held.
 */
export function acquireSlot(id: string, limits: SlotLimits, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const w: Waiter = { id, limits, grant: (ok) => { signal?.removeEventListener('abort', onAbort); resolve(ok); } };
    const onAbort = () => {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); w.grant(false); pump(); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiters.push(w);
    pump();
  });
}

export function releaseSlot() {
  active = Math.max(0, active - 1);
  pump();
}

/** Shutdown: waiting crawls stop waiting (they stay queued in the database and are queued again after the restart). */
export function dropWaiters() {
  for (const w of waiters.splice(0)) w.grant(false);
  pump();
}

/** Position of a queued crawl (1 = next), how many wait, and why it is not running yet. */
export function queueInfo(id: string): { position: number; waiting: number; reason?: string } | undefined {
  const i = waiters.findIndex((w) => w.id === id);
  return i < 0 ? undefined : { position: i + 1, waiting: waiters.length, reason: lastBlock };
}

export function slotStats() {
  return { running: active, waiting: waiters.length, peakRunning: peakActive, blockedBy: lastBlock };
}

/** Tests only. */
export function resetSlotsForTests() { waiters.splice(0); active = 0; peakActive = 0; lastBlock = undefined; }
