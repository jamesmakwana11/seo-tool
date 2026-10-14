import type { Severity, SentinelConfig, SlaState } from '../types';

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** End of the IST calendar day that contains `d` (23:59:59.999 IST), as a UTC Date. */
export function endOfIstDay(d: Date): Date {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const endIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 23, 59, 59, 999);
  return new Date(endIst - IST_OFFSET_MS);
}

/**
 * SLA deadline (PDF §3.2): Critical = same day (end of the IST day of detection),
 * Medium = 7 days, Low = 30-day batch.
 */
export function slaDueAt(severity: Severity, detectedAt: Date, cfg: SentinelConfig): Date {
  if (severity === 'critical') {
    return cfg.sla.criticalSameDay ? endOfIstDay(detectedAt) : new Date(detectedAt.getTime() + DAY);
  }
  const days = severity === 'medium' ? cfg.sla.mediumDays : cfg.sla.lowDays;
  return new Date(detectedAt.getTime() + days * DAY);
}

export function slaState(dueAt: string | Date, now: Date, cfg: SentinelConfig, done = false): SlaState {
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt;
  const ms = due.getTime() - now.getTime();
  const breached = !done && ms < 0;
  const atRisk = !done && !breached && ms <= cfg.sla.watchWindowHours * HOUR;
  return { dueAt: due.toISOString(), msRemaining: ms, breached, atRisk, label: done ? 'Done' : formatDuration(ms) };
}

export function formatDuration(ms: number): string {
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / 60000);
  const core = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return neg ? `${core} overdue` : `${core} left`;
}

export const HOURS = HOUR;
export const DAYS = DAY;
