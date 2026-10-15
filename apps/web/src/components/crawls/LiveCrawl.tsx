import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Download, Globe2, Play, Square, TriangleAlert } from 'lucide-react';
import { ApiError, CRAWL_LIMITS, crawlOptionErrors, defaultCrawlOptions, type CrawlOptionField, type CrawlOptions, type CrawlRun, type CrawlerStatus } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Checkbox, Field, Input, Notice } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { fmtDuration } from './format';
import { CrawlStatusBadge } from './crawlBadges';
import { fmtNum } from '@/lib/format';

export const isActiveRun = (r: Pick<CrawlRun, 'status'>) => r.status === 'running' || r.status === 'queued';

/** Says plainly that crawl jobs and results only live in server memory. */
export function TemporaryResultsNote({ compact }: { compact?: boolean }) {
  return (
    <p className={compact ? 'text-xs text-muted' : 'rounded-ctl border border-line bg-canvas px-3 py-2 text-xs text-muted'}>
      <strong className="font-medium text-ink-soft">Temporary results.</strong> Crawl jobs and their results are kept in server memory only — restarting or
      redeploying the server erases them. Export CSV or JSON to keep a copy.
    </p>
  );
}

// ------------------------------------------------------------------ start form

type FormState = { startUrl: string; allPages: boolean; maxPages: string; anyDepth: boolean; maxDepth: string; timeoutSec: string; concurrency: string; delayMs: string };
const toForm = (o: CrawlOptions, delayMs: number): FormState => ({
  startUrl: o.startUrl, allPages: o.maxPages === null, maxPages: o.maxPages === null ? '' : String(o.maxPages),
  anyDepth: o.maxDepth === null, maxDepth: o.maxDepth === null ? '' : String(o.maxDepth), timeoutSec: String(o.timeoutMs / 1000), concurrency: String(o.concurrency),
  delayMs: String(o.requestDelayMs ?? delayMs),
});
const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
const fromForm = (f: FormState) => ({
  startUrl: f.startUrl.trim(), maxPages: f.allPages ? null : num(f.maxPages), maxDepth: f.anyDepth ? null : num(f.maxDepth),
  timeoutMs: Math.round(num(f.timeoutSec) * 1000), concurrency: num(f.concurrency), requestDelayMs: num(f.delayMs),
});

export function LiveCrawlForm({ status, running, onStarted }: { status: CrawlerStatus; running?: CrawlRun; onStarted: (r: CrawlRun) => void }) {
  const { can } = useAuth();
  const [form, setForm] = useState<FormState>(() => toForm(defaultCrawlOptions(status.siteUrl, status.maxPagesCap), status.requestDelayMs));
  const [errors, setErrors] = useState<Partial<Record<CrawlOptionField, string>>>({});
  const [formError, setFormError] = useState<string>();
  // Switching websites changes the site the crawl is restricted to.
  useEffect(() => {
    setForm(toForm(defaultCrawlOptions(status.siteUrl, status.maxPagesCap), status.requestDelayMs));
    setErrors({});
    setFormError(undefined);
  }, [status.siteUrl, status.maxPagesCap, status.requestDelayMs]);

  const m = useApiMutation((o: CrawlOptions) => api.startCrawl('full', o), {
    success: (r) => `Crawl ${r.id} started`,
    invalidate: [['crawls'], ['dashboard']],
    silentError: true,
    onSuccess: onStarted,
  });
  const allowed = can('crawls.run');
  const blocked = !allowed ? 'Your role cannot start crawls (needs crawls.run).' : !status.ready ? status.reason : running ? `${running.id} is still ${running.status}. Cancel it or wait for it to finish.` : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(undefined);
    const o = fromForm(form);
    const errs = crawlOptionErrors(o, status.siteUrl, status.maxPagesCap);
    if (errs.timeoutMs) errs.timeoutMs = `Request timeout must be between ${CRAWL_LIMITS.timeoutMs.min / 1000} and ${CRAWL_LIMITS.timeoutMs.max / 1000} seconds.`;
    setErrors(errs);
    if (Object.keys(errs).length || blocked) return;
    m.mutate(o as CrawlOptions, {
      onError: (err) => {
        const fields = err instanceof ApiError ? (err.details as { fields?: Partial<Record<CrawlOptionField, string>> } | undefined)?.fields : undefined;
        if (fields) setErrors(fields);
        else setFormError(errorMessage(err));
      },
    });
  };
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {!status.ready && (
        <Notice tone="med" title="Live crawling is not available for this website" icon={<TriangleAlert className="h-4 w-4" />}>
          {status.reason}
        </Notice>
      )}
      {formError && <Notice tone="crit">{formError}</Notice>}
      <Field label="Start URL" htmlFor="crawl-start" required error={errors.startUrl} hint={`Must be on ${hostOf(status.siteUrl)}. Pages are discovered from its links and the site's sitemap.`}>
        <div className="relative">
          <Globe2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input id="crawl-start" type="url" inputMode="url" className="pl-9 font-mono text-[13px]" value={form.startUrl} onChange={set('startUrl')} aria-invalid={!!errors.startUrl} autoComplete="off" spellCheck={false} />
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Field label="Maximum pages" htmlFor="crawl-pages" error={errors.maxPages} hint={form.allPages ? 'Every page the site has' : status.maxPagesCap ? `1–${fmtNum(status.maxPagesCap)} (server limit)` : 'Any number from 1'}>
          <div className="space-y-2">
            <Checkbox label="All pages (no limit)" checked={form.allPages} disabled={!!status.maxPagesCap} onChange={(v) => setForm((f) => ({ ...f, allPages: v, maxPages: v ? '' : f.maxPages || '100' }))} />
            {!form.allPages && <Input id="crawl-pages" type="number" inputMode="numeric" min={1} max={status.maxPagesCap ?? undefined} value={form.maxPages} onChange={set('maxPages')} aria-invalid={!!errors.maxPages} />}
          </div>
        </Field>
        <Field label="Crawl depth" htmlFor="crawl-depth" error={errors.maxDepth} hint={form.anyDepth ? 'Follow links at any depth' : 'Links away from the start URL (0 = start URL only)'}>
          <div className="space-y-2">
            <Checkbox label="No depth limit" checked={form.anyDepth} onChange={(v) => setForm((f) => ({ ...f, anyDepth: v, maxDepth: v ? '' : f.maxDepth || '3' }))} />
            {!form.anyDepth && <Input id="crawl-depth" type="number" inputMode="numeric" min={CRAWL_LIMITS.maxDepth.min} value={form.maxDepth} onChange={set('maxDepth')} aria-invalid={!!errors.maxDepth} />}
          </div>
        </Field>
        <Field label="Request timeout (s)" htmlFor="crawl-timeout" error={errors.timeoutMs} hint={`${CRAWL_LIMITS.timeoutMs.min / 1000}–${CRAWL_LIMITS.timeoutMs.max / 1000} seconds per request`}>
          <Input id="crawl-timeout" type="number" inputMode="decimal" min={CRAWL_LIMITS.timeoutMs.min / 1000} max={CRAWL_LIMITS.timeoutMs.max / 1000} step={1} value={form.timeoutSec} onChange={set('timeoutSec')} aria-invalid={!!errors.timeoutMs} />
        </Field>
        <Field label="Delay between requests (ms)" htmlFor="crawl-delay" error={errors.requestDelayMs} hint="0–10,000. Raised automatically when the site asks (robots.txt Crawl-delay, 429 / 503)">
          <Input id="crawl-delay" type="number" inputMode="numeric" min={CRAWL_LIMITS.requestDelayMs.min} max={CRAWL_LIMITS.requestDelayMs.max} step={50} value={form.delayMs} onChange={set('delayMs')} aria-invalid={!!errors.requestDelayMs} />
        </Field>
        <Field label="Concurrency" htmlFor="crawl-conc" error={errors.concurrency} hint={`Parallel requests, ${CRAWL_LIMITS.concurrency.min}–${CRAWL_LIMITS.concurrency.max}`}>
          <Input id="crawl-conc" type="number" inputMode="numeric" min={CRAWL_LIMITS.concurrency.min} max={CRAWL_LIMITS.concurrency.max} value={form.concurrency} onChange={set('concurrency')} aria-invalid={!!errors.concurrency} />
        </Field>
      </div>
      {form.allPages && (
        <p className="rounded-ctl border border-line bg-canvas px-3 py-2 text-xs text-ink-soft">
          <strong className="font-medium">All pages:</strong> every page found through links and the sitemap is fetched. A large store can take hours
          (a page every {fmtNum(Math.max(status.requestDelayMs, 1))} ms at most) and needs a lot of server memory. You can cancel at any time.
          URLs with query strings (filters, sorting) and cart / account pages are skipped so the crawl always ends.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs text-muted">
          {status.respectsRobots ? 'Respects robots.txt. ' : 'robots.txt is NOT being respected (crawl configuration). '}
          Failed requests are retried with backoff; the crawler slows down when the site answers 429 or 503 and honours robots.txt Crawl-delay. 
          Only this website is crawled; private and internal network addresses are always blocked.
        </p>
        <Button type="submit" variant="primary" icon={<Play className="h-4 w-4" />} loading={m.isPending} disabled={!!blocked} title={blocked}>
          Start crawl
        </Button>
      </div>
      {running && status.ready && <p className="text-xs text-muted">{running.id} is {running.status} — one crawl per website at a time.</p>}
    </form>
  );
}

function hostOf(u: string) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

// ------------------------------------------------------------------ live progress

function Counter({ label, value, tone, hint }: { label: string; value?: number; tone?: 'ok' | 'crit'; hint?: string }) {
  return (
    <div className="min-w-0 rounded-ctl border border-line bg-surface px-3 py-2" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${tone === 'crit' && value ? 'text-crit-ink' : tone === 'ok' ? 'text-ok-ink' : 'text-ink'}`}>{value === undefined ? '—' : fmtNum(value)}</dd>
    </div>
  );
}

/** Progress of one crawl: real counts from the server, refreshed by polling. */
export function CrawlProgress({ run, showLink = true }: { run: CrawlRun; showLink?: boolean }) {
  const { can } = useAuth();
  const [now, setNow] = useState(() => Date.now());
  const active = isActiveRun(run);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const cancel = useApiMutation(() => api.cancelCrawl(run.id), { success: `Crawl ${run.id} cancelled`, invalidate: [['crawls'], ['crawl', run.id]] });
  const processed = run.urlsCrawled;
  const succeeded = run.urlsSucceeded;
  const errorsCount = succeeded === undefined ? run.urlsFailed : Math.max(0, processed - succeeded);
  const cap = run.options ? run.options.maxPages ?? Number.POSITIVE_INFINITY : run.urlsPlanned;
  const target = Math.max(1, Math.min(cap, Math.max(run.urlsDiscovered ?? run.urlsPlanned, processed)));
  const pct = run.status === 'completed' ? 100 : Math.min(100, Math.round((processed / target) * 100));
  const elapsed = run.startedAt ? (run.finishedAt ? new Date(run.finishedAt).getTime() : now) - new Date(run.startedAt).getTime() : undefined;
  // Pages per minute so far, and pages found but not fetched yet (large crawls run for hours: show the pace).
  const perMinute = elapsed && elapsed > 5000 && processed > 0 ? Math.round((processed / elapsed) * 60000) : undefined;
  const waiting = run.urlsDiscovered !== undefined ? Math.max(0, Math.min(cap, run.urlsDiscovered) - processed) : undefined;
  const phaseText = run.status === 'queued'
    ? 'Queued — checking the site address before the first request…'
    : run.phase === 'analysing'
      ? `Fetching finished. Analysing ${fmtNum(processed)} pages — on a large crawl this can take several minutes.`
      : run.phase === 'saving'
        ? 'Saving page results and updating issues…'
        : `Running — figures refresh every 2 seconds.${perMinute ? ` About ${fmtNum(perMinute)} pages a minute` : ''}${perMinute && waiting ? `; ${fmtNum(waiting)} found and waiting` : ''}${perMinute ? '.' : ''} Discovered includes URLs from the sitemap${run.options?.maxPages ? '; only up to the maximum pages are fetched' : ''}.`;
  return (
    <section aria-label={`Crawl ${run.id} progress`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted">{run.id}</span>
          <CrawlStatusBadge run={run} />
          {run.options && <span className="truncate font-mono text-xs text-ink-soft" title={run.options.startUrl}>{run.options.startUrl}</span>}
        </div>
        <div className="flex items-center gap-2">
          {elapsed !== undefined && <span className="text-xs tabular-nums text-muted">{fmtDuration(elapsed)}</span>}
          {active && can('crawls.run') && (
            <Button size="sm" variant="secondary" icon={<Square className="h-3.5 w-3.5" />} loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel crawl</Button>
          )}
          {showLink && <Link to={`/crawls/${run.id}`} className="text-sm font-medium text-signal hover:underline">{active ? 'Watch results' : 'View results'}</Link>}
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[#EEE8FB]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Pages processed">
        <div className={`h-full rounded-full transition-[width] duration-500 ${run.status === 'failed' ? 'bg-crit' : run.status === 'cancelled' ? 'bg-med' : 'bg-gradient-to-r from-[#9474E8] to-[#7650D8]'}`} style={{ width: `${pct}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Counter label="Discovered" value={run.urlsDiscovered} hint="Same-site page URLs found in links and the sitemap. Only up to the maximum pages are fetched." />
        <Counter label={`Processed${run.options?.maxPages ? ` (max ${fmtNum(run.options.maxPages)})` : ''}`} value={processed} />
        <Counter label="Successful" value={succeeded} tone="ok" hint="Final response 2xx or 3xx" />
        <Counter label="Errors / no response" value={errorsCount} tone="crit" hint="4xx, 5xx, timeouts, blocked or failed requests" />
      </dl>
      {(run.resolvedFrom || run.politeness) && (
        <p className="text-xs text-ink-soft">
          {run.resolvedFrom && <>Crawling <span className="font-mono">{run.resolvedStartUrl}</span> ({run.resolvedFrom} redirects there). </>}
          {run.politeness && (
            <>
              {fmtNum(run.politeness.delayMs)} ms between requests
              {run.politeness.crawlDelayMs ? ` (robots.txt Crawl-delay ${fmtNum(run.politeness.crawlDelayMs / 1000)} s)` : ''}
              {run.politeness.retries ? ` · ${fmtNum(run.politeness.retries)} request${run.politeness.retries === 1 ? '' : 's'} retried` : ''}
              {run.politeness.slowDowns ? ` · the site asked to slow down ${fmtNum(run.politeness.slowDowns)} time${run.politeness.slowDowns === 1 ? '' : 's'}` : ''}.
            </>
          )}
        </p>
      )}
      {active && <p className="text-xs text-muted" aria-live="polite">{phaseText}</p>}
      {!active && run.status === 'completed' && (
        <p className="text-sm text-ink-soft">
          Finished: {fmtNum(processed)} pages processed · <span className={run.newIssues ? 'font-medium text-crit-ink' : ''}>{run.newIssues} new</span> / {run.resolvedIssues} resolved / {run.recurringIssues} recurring issues.
        </p>
      )}
      {!active && run.error && <Notice tone={run.status === 'failed' ? 'crit' : 'med'}>{run.error}</Notice>}
    </section>
  );
}

// ------------------------------------------------------------------ export

export function saveFile(f: { filename: string; mimeType: string; content: string }) {
  const url = URL.createObjectURL(new Blob([f.content], { type: f.mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function ExportButtons({ run, disabled }: { run: CrawlRun; disabled?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'csv' | 'json' | null>(null);
  const go = async (format: 'csv' | 'json') => {
    setBusy(format);
    try {
      saveFile(await api.exportCrawl(run.id, format));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'csv'} disabled={disabled} onClick={() => go('csv')}>Export CSV</Button>
      <Button size="sm" variant="secondary" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'json'} disabled={disabled} onClick={() => go('json')}>Export JSON</Button>
    </div>
  );
}

export function LiveBadge() {
  return <Badge tone="signal">Live crawl</Badge>;
}
