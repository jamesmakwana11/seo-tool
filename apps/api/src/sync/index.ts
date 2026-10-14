/**
 * Connector data-sync jobs (PDF §15). Run daily at 01:00 IST by the scheduler (before the 02:00 smart crawl) and on
 * demand via POST /api/integrations/:id/sync. Each sync is a no-op (`ran: false`) unless its integration is connected.
 */
import type { Ctx } from '../services/context';
import { SYNC_IDS, type SyncDeps, type SyncId, type SyncResult } from './common';
import { cruxCwv } from './crux';
import { ga4Tiers } from './ga4';
import { gscSearch } from './gsc';

export { ga4Tiers, computeTiers, recomputeTiers } from './ga4';
export { gscSearch } from './gsc';
export { cruxCwv, classifyCwv } from './crux';
export { isSyncId, SYNC_IDS, type SyncDeps, type SyncId, type SyncResult } from './common';

const JOBS: Record<SyncId, (ctx: Ctx, deps?: SyncDeps) => Promise<SyncResult>> = { ga4: ga4Tiers, gsc: gscSearch, psi_crux: cruxCwv };

export function runSync(ctx: Ctx, id: SyncId, deps: SyncDeps = {}): Promise<SyncResult> {
  return JOBS[id](ctx, deps);
}

export interface SyncRunSummary { at: string; results: SyncResult[]; ran: number; ok: number; failed: number; skipped: number }

/** GA4 first (fresh page value), then GSC (impressions/clicks; recomputes tiers again), then CrUX (uses the fresh tiers). */
export async function runAllSyncs(ctx: Ctx, deps: SyncDeps = {}): Promise<SyncRunSummary> {
  const at = ctx.clock().toISOString();
  const results: SyncResult[] = [];
  for (const id of SYNC_IDS) results.push(await runSync(ctx, id, deps));
  const summary: SyncRunSummary = {
    at, results,
    ran: results.filter((r) => r.ran).length,
    ok: results.filter((r) => r.ran && r.ok).length,
    failed: results.filter((r) => r.ran && !r.ok).length,
    skipped: results.filter((r) => !r.ran).length,
  };
  ctx.log.info({ sync: 'all', ran: summary.ran, ok: summary.ok, failed: summary.failed, skipped: summary.skipped }, 'connector syncs finished');
  return summary;
}
