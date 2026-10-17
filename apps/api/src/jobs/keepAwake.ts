import type { Logger } from '../lib/logger';

/**
 * Keeps the server awake while crawls run in the background.
 *
 * A host that stops idle services stops them by INCOMING traffic: Render's free instances spin down after 15 minutes
 * without a request, however busy the process is. While someone watches the Crawl Center its progress polling keeps the
 * server up; once the browser is closed (or the laptop shut down) nothing does, and the crawl would be cut off mid-run.
 * So while at least one crawl runs (or waits to run again after a restart), this requests the server's own public
 * /healthz every few minutes. When no crawl runs, nothing is requested and the host may stop the server as usual.
 *
 * The address is the server's own (KEEP_AWAKE_URL, else RENDER_EXTERNAL_URL, which Render sets) — never a user-supplied
 * one. Off with CRAWL_KEEP_AWAKE=false.
 */
export interface KeepAwake {
  enabled: boolean;
  target?: string;
  /** One check: requests /healthz if a crawl is busy. Returns whether it requested. */
  tick: () => Promise<boolean>;
  stop: () => void;
}

export function startKeepAwake(o: { enabled: boolean; url?: string; intervalMs: number; busy: () => boolean; log: Logger }): KeepAwake {
  if (!o.enabled || !o.url) return { enabled: false, tick: async () => false, stop: () => undefined };
  const target = new URL('/healthz', o.url).toString();
  let failing = false;
  const tick = async () => {
    if (!o.busy()) return false;
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'DeoDap-SEO-Sentinel/keep-awake' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failing) o.log.info({ url: target }, 'keep-awake request answered again');
      failing = false;
    } catch (e) {
      if (!failing) o.log.warn({ url: target, err: (e as Error).message }, 'keep-awake request failed; a host that stops idle services may stop this server while a crawl runs');
      failing = true;
    }
    return true;
  };
  const timer = setInterval(() => { void tick(); }, o.intervalMs);
  timer.unref();
  o.log.info({ url: target, everySeconds: Math.round(o.intervalMs / 1000) }, 'keep-awake: requests /healthz while a crawl runs, so an idle-stopping host does not stop it');
  return { enabled: true, target, tick, stop: () => clearInterval(timer) };
}
