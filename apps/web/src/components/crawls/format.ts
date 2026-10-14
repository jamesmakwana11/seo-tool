/** Human duration for crawl runs: "6s", "48m", "3h 12m". */
export function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 60000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
