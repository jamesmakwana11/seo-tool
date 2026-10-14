/**
 * Minimal 5-field cron parser for the Crawl Center schedule editor (client-side validation and a
 * "next runs" preview). Schedules are evaluated in IST (Asia/Kolkata, UTC+05:30, no DST).
 * Supports `*`, `n`, `a-b`, `*\/s`, `a-b/s` and comma lists. Day-of-week 0 and 7 are Sunday.
 */
export interface CronSpec {
  minutes: number[];
  hours: number[];
  dom: number[];
  months: number[];
  dow: number[];
  domStar: boolean;
  dowStar: boolean;
}

const FIELDS: { name: string; lo: number; hi: number }[] = [
  { name: 'Minute', lo: 0, hi: 59 },
  { name: 'Hour', lo: 0, hi: 23 },
  { name: 'Day of month', lo: 1, hi: 31 },
  { name: 'Month', lo: 1, hi: 12 },
  { name: 'Day of week', lo: 0, hi: 7 },
];

const IST_OFFSET_MS = 330 * 60000;
const DAY_MS = 86400000;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseField(raw: string, f: { name: string; lo: number; hi: number }): number[] | string {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return `${f.name}: "${part}" is not a valid value.`;
    let lo = f.lo;
    let hi = f.hi;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? f.hi : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < f.lo || hi > f.hi) return `${f.name} must be between ${f.lo} and ${f.hi}.`;
    if (lo > hi) return `${f.name}: range ${lo}-${hi} is reversed.`;
    if (step < 1) return `${f.name}: step must be at least 1.`;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): { ok: true; spec: CronSpec } | { ok: false; error: string } {
  const parts = expr.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, error: 'Cron needs exactly 5 fields: minute hour day-of-month month day-of-week.' };
  const vals: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], FIELDS[i]);
    if (typeof r === 'string') return { ok: false, error: r };
    vals.push(r);
  }
  const dow = [...new Set(vals[4].map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    ok: true,
    spec: { minutes: vals[0], hours: vals[1], dom: vals[2], months: vals[3], dow, domStar: parts[2] === '*', dowStar: parts[4] === '*' },
  };
}

/** Next `count` run times (UTC Date objects) strictly after `from`, evaluated on the IST wall clock. */
export function nextRuns(spec: CronSpec, from: Date, count = 3): Date[] {
  const out: Date[] = [];
  const fromMs = from.getTime();
  const wallNow = fromMs + IST_OFFSET_MS;
  const wallMidnight = Math.floor(wallNow / DAY_MS) * DAY_MS;
  for (let d = 0; d < 366 * 5 && out.length < count; d++) {
    const day = new Date(wallMidnight + d * DAY_MS);
    if (!spec.months.includes(day.getUTCMonth() + 1)) continue;
    const domOk = spec.dom.includes(day.getUTCDate());
    const dowOk = spec.dow.includes(day.getUTCDay());
    const dayOk = spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const t = wallMidnight + d * DAY_MS + h * 3600000 + m * 60000 - IST_OFFSET_MS;
        if (t > fromMs) {
          out.push(new Date(t));
          if (out.length >= count) return out;
        }
      }
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Plain-English summary for the common shapes; falls back to "Custom schedule". */
export function describeCron(expr: string): string {
  const p = parseCron(expr);
  if (!p.ok) return 'Invalid cron expression';
  const s = p.spec;
  const parts = expr.trim().split(/\s+/);
  if (s.minutes.length === 1 && s.hours.length === 1 && parts[2] === '*' && parts[3] === '*') {
    const at = `${pad(s.hours[0])}:${pad(s.minutes[0])} IST`;
    if (parts[4] === '*') return `Every day at ${at}`;
    if (s.dow.length === 1) return `Every ${WEEKDAYS[s.dow[0]]} at ${at}`;
    return `${s.dow.map((d) => WEEKDAYS[d].slice(0, 3)).join(', ')} at ${at}`;
  }
  if (parts.slice(1).every((x) => x === '*') && s.minutes.length === 1) return `Every hour at :${pad(s.minutes[0])}`;
  return 'Custom schedule';
}
