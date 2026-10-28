import { SYSTEM_ACTOR, type Ctx } from '../services/context';
import type { CrawlService } from '../services/crawls';
import type { IssueService } from '../services/issues';
import type { ReportService } from '../services/reports';
import { runEscalations } from './escalation';
import { runAllSyncs } from '../sync';

const IST_OFFSET_MS = 330 * 60_000;

/** Wall-clock fields of `d` in Asia/Kolkata (fixed UTC+05:30, no DST). */
export function istParts(d: Date) {
  const t = new Date(d.getTime() + IST_OFFSET_MS);
  return { minute: t.getUTCMinutes(), hour: t.getUTCHours(), dom: t.getUTCDate(), month: t.getUTCMonth() + 1, dow: t.getUTCDay(), ymd: t.toISOString().slice(0, 10) };
}

function fieldMatches(expr: string, value: number, lo: number, hi: number, isDow = false): boolean {
  return expr.split(',').some((seg) => {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(seg.trim());
    if (!m) return false;
    const a = m[2] !== undefined ? Number(m[2]) : lo;
    const b = m[3] !== undefined ? Number(m[3]) : m[2] !== undefined && m[4] === undefined ? a : hi;
    const step = m[4] ? Number(m[4]) : 1;
    const vals = isDow && value === 0 ? [0, 7] : [value];
    return vals.some((v) => v >= a && v <= b && (v - a) % step === 0);
  });
}

/** Standard 5-field cron (minute hour day-of-month month day-of-week) evaluated in IST. */
export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const p = istParts(d);
  const domOk = fieldMatches(f[2], p.dom, 1, 31);
  const dowOk = fieldMatches(f[4], p.dow, 0, 7, true);
  const dayOk = f[2] !== '*' && f[4] !== '*' ? domOk || dowOk : domOk && dowOk;
  return fieldMatches(f[0], p.minute, 0, 59) && fieldMatches(f[1], p.hour, 0, 23) && fieldMatches(f[3], p.month, 1, 12) && dayOk;
}

/** Next matching minute after `from` (searches up to 366 days). */
export function nextRun(expr: string, from: Date): Date | undefined {
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let n = 0; n < 366 * 24 * 60; n++, t.setTime(t.getTime() + 60_000)) if (cronMatches(expr, t)) return new Date(t);
  return undefined;
}

export interface SchedulerDeps { ctx: Ctx; crawls: CrawlService; issues: IssueService; reports: ReportService; monitor?: { tick(): Promise<void> } }

/**
 * In-process scheduler (enabled with SCHEDULER_ENABLED=true). Jobs:
 *  - crawl schedules from the Schedules screen (smart daily, full weekly — PDF §16)
 *  - nightly escalation at 00:30 IST (PDF §3.3)
 *  - connector data syncs (GA4 → tiers, GSC, CrUX) at 01:00 IST (PDF §3.1 tiers computed nightly, §15)
 *  - daily digest at config.reporting.dailyDigestTime IST (08:00, PDF §12.1)
 *  - weekly rollup Monday, monthly report on config.reporting.monthlyDay (PDF §13)
 *  - incremental monitoring (sitemap / Shopify / webhook signals → conditional requests) every MONITOR_INTERVAL_MINUTES
 * Each job runs at most once per matching minute; failures are logged and recorded, never retried silently.
 */
export function createScheduler(d: SchedulerDeps) {
  const { ctx } = d;
  const fired = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  async function once(key: string, fn: () => Promise<unknown>) {
    if (fired.has(key)) return;
    fired.add(key);
    try {
      await fn();
    } catch (e) {
      ctx.log.error({ job: key, err: (e as Error).message }, 'scheduled job failed');
      const m = await ctx.repos.metrics.get();
      m.errors.push({ id: `ERR-${key}`, at: ctx.clock().toISOString(), level: 'error', component: 'scheduler', message: `${key}: ${(e as Error).message}` });
      await ctx.repos.metrics.set(m);
    }
  }

  async function tick(now = ctx.clock()) {
    const p = istParts(now);
    const stamp = `${p.ymd}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    const cfg = await ctx.repos.config.get();
    for (const s of await ctx.repos.schedules.list()) {
      if (s.enabled && cronMatches(s.cron, now)) {
        await once(`crawl:${s.id}:${stamp}`, async () => {
          const run = await d.crawls.start(SYSTEM_ACTOR, s.type, 'schedule');
          await ctx.repos.schedules.update({ ...s, lastRunId: run.id, nextRunAt: nextRun(s.cron, now)?.toISOString() });
        });
      }
    }
    // Incremental monitoring: targeted checks between crawls (interval MONITOR_INTERVAL_MINUTES; runs itself decides).
    if (d.monitor) await once(`monitor:${stamp}`, () => d.monitor!.tick());
    if (cronMatches('30 0 * * *', now)) await once(`escalation:${stamp}`, () => runEscalations(ctx, d.issues));
    if (cronMatches('0 1 * * *', now)) await once(`sync:${stamp}`, () => runAllSyncs(ctx, { ingest: d.issues.ingestFindings }));
    const [hh, mm] = cfg.reporting.dailyDigestTime.split(':').map(Number);
    if (cronMatches(`${mm} ${hh} * * *`, now)) await once(`digest:${stamp}`, () => d.reports.send(SYSTEM_ACTOR, 'daily'));
    if (cronMatches(`${mm} ${hh} * * 1`, now)) await once(`weekly:${stamp}`, () => d.reports.send(SYSTEM_ACTOR, 'weekly'));
    if (cronMatches(`${mm} ${hh} ${cfg.reporting.monthlyDay} * *`, now)) await once(`monthly:${stamp}`, () => d.reports.send(SYSTEM_ACTOR, 'monthly'));
    if (fired.size > 5000) fired.clear();
  }

  return {
    tick,
    start() {
      if (timer) return;
      ctx.log.info('scheduler started (IST)');
      timer = setInterval(() => { void tick(); }, 30_000);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    running: () => !!timer,
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
