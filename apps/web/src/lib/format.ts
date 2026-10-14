const TZ = 'Asia/Kolkata';

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function fmtShortDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(d.length === 10 ? `${d}T00:00:00+05:30` : d).toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });
}

export function fmtRelative(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const d = Math.round(abs / 86400000);
  const v = m < 60 ? `${m}m` : h < 48 ? `${h}h` : `${d}d`;
  return diff < 0 ? `${v} ago` : `in ${v}`;
}

export function fmtNum(n?: number | null, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtPct(n?: number | null, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(digits)}%`;
}

export function fmtMs(ms?: number): string {
  if (ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}` || '/';
  } catch {
    return u;
  }
}

export function downloadText(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
