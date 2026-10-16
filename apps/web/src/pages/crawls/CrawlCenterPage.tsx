import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Play, RefreshCcw, ShieldCheck, Zap } from 'lucide-react';
import type { CrawlRun, CrawlSchedule, CrawlType } from '@sentinel/shared';
import { api, API_MODE } from '@/api/client';
import { useApiMutation, useApiQuery, useSiteKey } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, DemoBadge, EmptyState, Field, Input, Mono, Notice, PageHeader, Panel, Stat, Toggle } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { CRAWL_TRIGGER_LABELS, CRAWL_TYPE_LABELS, CrawlStatusBadge } from '@/components/crawls/crawlBadges';
import { describeCron, nextRuns, parseCron } from '@/components/crawls/cron';
import { fmtDuration } from '@/components/crawls/format';
import { CrawlProgress, LiveCrawlForm, TemporaryResultsNote } from '@/components/crawls/LiveCrawl';
import { LighthousePanel } from '@/components/crawls/LighthousePanel';
import { ChangeMonitorPanel } from '@/components/crawls/ChangeMonitor';
import { fmtDateTime, fmtNum, fmtRelative } from '@/lib/format';

const isActive = (r: CrawlRun) => r.status === 'running' || r.status === 'queued';

export default function CrawlCenterPage() {
  const qc = useQueryClient();
  const siteKey = useSiteKey();
  // Poll every 2s while any run is running/queued (cached data from the previous fetch decides).
  const cached = qc.getQueryData<CrawlRun[]>(siteKey(['crawls']));
  const polling = !!cached?.some(isActive);
  const q = useApiQuery(['crawls'], () => api.listCrawls(), { refetchInterval: polling ? 2000 : undefined });
  const running = q.data?.find(isActive);
  const latestLive = q.data?.find((r) => !!r.options);

  return (
    <div>
      <PageHeader
        title="Crawl Center"
        description="Crawl the selected website live, watch progress, and review every page and issue found. Smart and re-verification crawls are below."
        meta={<><DemoBadge />{API_MODE === 'mock' && <DemoBadge label="Crawls are SIMULATED" title="Mock mode makes no HTTP requests. Runs you start here are simulated and produce no findings." />}</>}
        actions={<Link to="/verification" className="inline-flex h-9 items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark"><ShieldCheck className="h-4 w-4" /> Verification results</Link>}
      />
      <div className="space-y-5">
        <LiveCrawlPanel running={running} latest={latestLive} />
        {API_MODE !== 'mock' && <ChangeMonitorPanel />}
        <StartCrawlPanel running={running} loading={q.isLoading} />
        <LighthouseSection />
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <StrategyPanel />
          <SchedulesPanel />
        </div>
        <Async q={q} rows={8}>{(runs) => <History runs={runs} />}</Async>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ start a crawl

function LiveCrawlPanel({ running, latest }: { running?: CrawlRun; latest?: CrawlRun }) {
  const status = useApiQuery(['crawls', 'status'], () => api.getCrawlerStatus());
  const showLatest = latest && (!running || running.id !== latest.id);
  return (
    <Panel title="Crawl a website" subtitle="Fetches real pages from the selected website and checks status codes, redirects, titles, meta descriptions, headings, canonicals, robots directives, indexability, links and image alt text.">
      <Async q={status} rows={4}>
        {(st) => (
          <div className="space-y-5">
            {running && (
              <div className="rounded-ctl border border-signal/30 bg-raised/40 p-4">
                <CrawlProgress run={running} />
              </div>
            )}
            <LiveCrawlForm status={st} running={running} onStarted={() => undefined} />
            {showLatest && (
              <div className="border-t border-line pt-4">
                <h3 className="mb-2 text-sm font-semibold">Latest live crawl</h3>
                <CrawlProgress run={latest} />
              </div>
            )}
            {st.engine && <EngineStatus e={st.engine} />}
            <TemporaryResultsNote />
          </div>
        )}
      </Async>
    </Panel>
  );
}

const START_OPTIONS: { type: CrawlType; icon: typeof Play; blurb: string }[] = [
  { type: 'smart', icon: Zap, blurb: 'Homepage, all collections, top products, URLs changed in the last 48h and yesterday’s issue URLs (from earlier live crawls).' },
  { type: 'reverify', icon: RefreshCcw, blurb: 'Re-checks only the URLs of issues marked Fixed. Closes issues that now show 0 failing pages.' },
];

function StartCrawlPanel({ running, loading }: { running?: CrawlRun; loading: boolean }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const [pending, setPending] = useState<CrawlType | null>(null);
  const m = useApiMutation((t: CrawlType) => api.startCrawl(t), {
    success: (r) => `${CRAWL_TYPE_LABELS[r.type]} started (${r.id})${r.source === 'simulated' ? ' — simulated, no URLs will be fetched' : ''}`,
    invalidate: [['crawls'], ['dashboard']],
    onSuccess: () => setPending(null),
  });
  const allowed = can('crawls.run');
  const disabledReason = !allowed ? 'Your role cannot start crawls (needs crawls.run).' : running ? `${running.id} is still ${running.status}. Wait for it to finish.` : undefined;

  return (
    <Panel title="Other crawl types" subtitle="Manual runs are logged in the audit trail. Only one crawl can run at a time per website.">
      {running && !running.options && (
        <div className="mb-4">
          <Notice tone="signal" title={`${CRAWL_TYPE_LABELS[running.type]} ${running.id} is ${running.status}`}>
            Started {fmtRelative(running.startedAt)} by {CRAWL_TRIGGER_LABELS[running.trigger].toLowerCase()} trigger. This page refreshes every 2 seconds until it finishes.{' '}
            {running.source === 'simulated' && 'This is a simulated run: no URLs are being fetched. '}
            <button className="font-medium underline" onClick={() => nav(`/crawls/${running.id}`)}>Open run</button>
          </Notice>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {START_OPTIONS.map((o) => (
          <div key={o.type} className="flex flex-col rounded-ctl border border-line p-3">
            <div className="flex items-center gap-2">
              <o.icon className="h-4 w-4 text-signal" aria-hidden />
              <h3 className="text-sm font-semibold">{CRAWL_TYPE_LABELS[o.type]}</h3>
            </div>
            <p className="mt-1 flex-1 text-xs text-muted">{o.blurb}</p>
            <Button className="mt-3 self-start" size="sm" variant={o.type === 'smart' ? 'primary' : 'secondary'} icon={<Play className="h-3.5 w-3.5" />} disabled={!!disabledReason || loading} title={disabledReason} onClick={() => setPending(o.type)}>
              Start {CRAWL_TYPE_LABELS[o.type].toLowerCase()}
            </Button>
          </div>
        ))}
      </div>
      {!allowed && <p className="mt-3 text-xs text-muted">Your role can view crawl history but not start crawls. Ask an SEO specialist or admin.</p>}
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending ? `Start ${CRAWL_TYPE_LABELS[pending].toLowerCase()}?` : ''}
        body={pending && (
          <div className="space-y-2">
            <p>{START_OPTIONS.find((o) => o.type === pending)?.blurb}</p>
            {API_MODE === 'mock' && <Notice tone="demo">Mock mode: this run is <strong>simulated</strong>. No HTTP requests are made, no pages are fetched and no findings are produced. The real crawler runs from the API server (Phase 2).</Notice>}
          </div>
        )}
        confirmLabel={pending ? `Start ${CRAWL_TYPE_LABELS[pending].toLowerCase()}` : 'Start'}
        loading={m.isPending}
        onConfirm={() => pending && m.mutate(pending)}
      />
    </Panel>
  );
}

// ------------------------------------------------------------------ strategy explainer

function StrategyPanel() {
  const { can } = useAuth();
  const cfg = useApiQuery(['config'], () => api.getConfig(), { enabled: can('settings.view') });
  const c = cfg.data?.crawl;
  const topN = c?.smartTopProducts ?? 500;
  const hours = c?.changedWithinHours ?? 48;
  return (
    <Panel title="Crawl strategy" subtitle="Why daily audits stay fast and cheap (PDF §2.1)" actions={can('settings.view') ? <Link to="/settings/crawl" className="text-sm text-signal hover:underline">Crawl configuration</Link> : undefined}>
      <div className="space-y-4 text-sm">
        <div>
          <h3 className="font-semibold">Weekly full crawl</h3>
          <p className="mt-0.5 text-ink-soft">All indexable URLs, with JavaScript rendering enabled on a sample{c ? ` of ${fmtNum(c.jsRenderSampleSize)} pages` : ''} to catch content that only appears after rendering.</p>
        </div>
        <div>
          <h3 className="font-semibold">Daily smart crawl</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-soft">
            <li>Homepage</li>
            <li>All category / collection pages</li>
            <li>Top {fmtNum(topN)} products by revenue or traffic</li>
            <li>Every URL changed in the last {hours} hours — detected via sitemap <Mono>lastmod</Mono> and Shopify webhooks for product, collection and page updates</li>
            <li>Every URL that had an issue yesterday (re-verify)</li>
          </ul>
        </div>
        <div>
          <h3 className="font-semibold">Delta detection</h3>
          <p className="mt-0.5 text-ink-soft">Every check stores yesterday’s result, so the daily digest leads with what changed — new, worsening, recurring and resolved — not the full inventory.</p>
        </div>
        {!can('settings.view') && <p className="text-xs text-muted">Figures shown are the PDF defaults; your role cannot read the live crawl configuration.</p>}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ schedules

function SchedulesPanel() {
  const { can } = useAuth();
  const status = useApiQuery(['crawls', 'status'], () => api.getCrawlerStatus());
  const q = useApiQuery(['crawls', 'schedules'], () => api.listSchedules());
  const [editing, setEditing] = useState<CrawlSchedule | null>(null);
  const toggle = useApiMutation((v: { id: string; enabled: boolean }) => api.updateSchedule(v.id, { enabled: v.enabled }), {
    success: (r) => `Schedule ${r.enabled ? 'enabled' : 'paused'}`,
    invalidate: [['crawls', 'schedules']],
  });
  const canConfigure = can('crawls.configure');
  return (
    <Panel title="Schedules" subtitle="Cron times are IST (Asia/Kolkata)" bodyClassName="p-0">
      <Async q={q} rows={3} empty={(d) => d.length === 0 && <EmptyState title="No crawl schedules" description="Schedules are created with the crawler configuration." />}>
        {(list) => (
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const parsed = parseCron(s.cron);
              const next = s.enabled && parsed.ok ? nextRuns(parsed.spec, new Date(), 1)[0] : undefined;
              return (
                <li key={s.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CalendarClock className="h-4 w-4 text-muted" aria-hidden />
                        <span className="text-sm font-semibold">{CRAWL_TYPE_LABELS[s.type]}</span>
                        {s.enabled ? <Badge tone="ok">Enabled</Badge> : <Badge tone="neutral">Paused</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted">{s.description}</p>
                      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        <div><dt className="text-xs text-muted">Cron</dt><dd><Mono>{s.cron}</Mono> <span className="text-xs text-muted">· {describeCron(s.cron)}</span></dd></div>
                        <div><dt className="text-xs text-muted">Next run</dt><dd>{s.enabled ? (next ? `${fmtDateTime(next.toISOString())} IST` : '—') : 'Paused — will not run'}</dd></div>
                        {s.lastRunId && <div><dt className="text-xs text-muted">Last run</dt><dd><Link to={`/crawls/${s.lastRunId}`} className="font-mono text-xs text-signal hover:underline">{s.lastRunId}</Link></dd></div>}
                      </dl>
                    </div>
                    <div className="flex items-center gap-2">
                      <Toggle
                        checked={s.enabled}
                        label={`${s.enabled ? 'Pause' : 'Enable'} ${CRAWL_TYPE_LABELS[s.type].toLowerCase()} schedule`}
                        disabled={!canConfigure || toggle.isPending}
                        onChange={(v) => toggle.mutate({ id: s.id, enabled: v })}
                      />
                      <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} disabled={!canConfigure} title={canConfigure ? undefined : 'Your role cannot change schedules (needs crawls.configure).'} onClick={() => setEditing(s)}>Edit cron</Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Async>
      {!canConfigure && <p className="border-t border-line px-4 py-2 text-xs text-muted">Only admins can change crawl schedules.</p>}
      <p className="border-t border-line px-4 py-2 text-xs text-muted">Next run is computed from the cron expression in IST.{API_MODE === 'mock' && ' In mock mode schedules are stored but nothing fires on them.'}</p>
      {status.data && !status.data.schedulerEnabled && API_MODE !== 'mock' && (
        <p className="border-t border-line px-4 py-2 text-xs font-medium text-med-ink">Scheduled crawls are disabled on this server (SCHEDULER_ENABLED is off), so schedules never fire. Start crawls manually.</p>
      )}
      <EditCronDialog schedule={editing} onClose={() => setEditing(null)} />
    </Panel>
  );
}

function EditCronDialog({ schedule, onClose }: { schedule: CrawlSchedule | null; onClose: () => void }) {
  return schedule ? <EditCronForm key={schedule.id} schedule={schedule} onClose={onClose} /> : null;
}

function EditCronForm({ schedule, onClose }: { schedule: CrawlSchedule; onClose: () => void }) {
  const [cron, setCron] = useState(schedule.cron);
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parseCron(cron), [cron]);
  const preview = useMemo(() => (parsed.ok ? nextRuns(parsed.spec, new Date(), 3) : []), [parsed]);
  const m = useApiMutation(() => api.updateSchedule(schedule.id, { cron: cron.trim() }), { success: 'Schedule saved', invalidate: [['crawls', 'schedules'], ['config']], onSuccess: onClose });
  const error = !parsed.ok ? parsed.error : preview.length === 0 ? 'This expression never fires.' : undefined;
  const save = () => {
    setTouched(true);
    if (!error) m.mutate();
  };
  return (
    <Dialog open onClose={onClose} title={`Edit ${CRAWL_TYPE_LABELS[schedule.type].toLowerCase()} schedule`} size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={save} disabled={cron.trim() === schedule.cron}>Save schedule</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Cron expression (IST)" htmlFor="cron-expr" required error={touched || cron !== schedule.cron ? error : undefined} hint="minute hour day-of-month month day-of-week — e.g. 30 5 * * * is daily at 05:30">
          <Input id="cron-expr" data-autofocus className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} aria-invalid={!!error && (touched || cron !== schedule.cron)} autoComplete="off" spellCheck={false} />
        </Field>
        {parsed.ok && preview.length > 0 && (
          <div className="rounded-ctl border border-line bg-canvas px-3 py-2 text-sm">
            <p className="font-medium">{describeCron(cron)}</p>
            <p className="mt-1 text-xs text-muted">Next runs:</p>
            <ul className="text-xs tabular-nums text-ink-soft">{preview.map((d) => <li key={d.toISOString()}>{fmtDateTime(d.toISOString())} IST</li>)}</ul>
          </div>
        )}
        {schedule.type === 'smart' && <p className="text-xs text-muted">Keep the daily smart crawl early enough that the 8 AM IST digest is ready (PDF acceptance criteria).</p>}
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ history

function History({ runs }: { runs: CrawlRun[] }) {
  const nav = useNavigate();
  const f = useUrlFilters(['type', 'status'] as const);
  const type = f.get('type');
  const status = f.get('status');
  const rows = runs.filter((r) => (!type || r.type === type) && (!status || r.status === status));
  const done = runs.filter((r) => r.status === 'completed' && r.source !== 'simulated');
  const failed = runs.filter((r) => r.status === 'failed').length;
  const last = done[0];
  const simulated = runs.filter((r) => r.source === 'simulated').length;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Last completed crawl" value={last ? fmtRelative(last.finishedAt) : '—'} hint={last ? `${last.id} · ${CRAWL_TYPE_LABELS[last.type]}` : 'None yet'} />
        <Stat label="URLs crawled (last run)" value={last ? fmtNum(last.urlsCrawled) : '—'} hint={last ? `${fmtNum(last.urlsFailed)} failed` : undefined} tone={last && last.urlsFailed > 0 ? 'med' : undefined} />
        <Stat label="Failed runs" value={failed} tone={failed ? 'crit' : 'ok'} hint={`of ${runs.length} runs listed`} />
        <Stat label="Simulated runs" value={simulated} hint="Started in mock mode — fetched nothing" />
      </div>
      <Panel title="Run history" subtitle="Newest first. Select a run for its URLs, sitemap diff and re-verification results.">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/crawls/${r.id}`)}
          search={(r) => `${r.id} ${r.type} ${r.status} ${r.trigger}`}
          searchPlaceholder="Search runs"
          caption="Crawl run history"
          toolbar={
            <>
              <FilterSelect label="Type" value={type} onChange={(v) => f.set('type', v)} options={(['full', 'smart', 'reverify'] as CrawlType[]).map((t) => ({ value: t, label: CRAWL_TYPE_LABELS[t] }))} />
              <FilterSelect label="Status" value={status} onChange={(v) => f.set('status', v)} options={['running', 'completed', 'failed', 'queued', 'cancelled'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))} />
              <ClearFilters show={f.active} onClear={f.clear} />
            </>
          }
          empty={<EmptyState title="No runs match these filters" description="Clear the filters or start a crawl above." />}
          columns={[
            {
              key: 'run', header: 'Run', cell: (r) => (
                <div className="min-w-[150px]">
                  <Link to={`/crawls/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-signal hover:underline">{r.id}</Link>
                  <div className="text-sm font-medium">{r.options ? "Live crawl" : CRAWL_TYPE_LABELS[r.type]}</div>{r.options && <p className="max-w-[260px] truncate font-mono text-xs text-muted" title={r.options.startUrl}>{r.options.startUrl}</p>}
                  {r.source === 'simulated' && r.error && <p className="mt-0.5 max-w-[320px] text-xs text-demo">{r.error}</p>}
                  {r.source === 'simulated' && !r.error && <p className="mt-0.5 max-w-[320px] text-xs text-demo">Simulated run in progress — no HTTP requests are made.</p>}
                  {r.source !== 'simulated' && r.error && <p className="mt-0.5 max-w-[320px] text-xs text-crit-ink">{r.error}</p>}
                </div>
              ),
            },
            { key: 'trigger', header: 'Trigger', hideOnMobile: true, cell: (r) => <span className="text-xs">{CRAWL_TRIGGER_LABELS[r.trigger]}</span> },
            { key: 'status', header: 'Status', cell: (r) => <CrawlStatusBadge run={r} /> },
            { key: 'started', header: 'Started (IST)', cell: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.startedAt ?? r.scheduledFor)}</span>, sort: (a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') },
            { key: 'dur', header: 'Duration', hideOnMobile: true, cell: (r) => <span className="tabular-nums text-xs">{isActive(r) ? 'running…' : fmtDuration(r.durationMs)}</span>, sort: (a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0) },
            {
              key: 'urls', header: 'Planned / crawled / failed', cell: (r) => r.source === 'simulated'
                ? <span className="text-xs text-muted">{fmtNum(r.urlsPlanned)} planned · <span className="text-demo">0 fetched (simulated)</span></span>
                : <span className="whitespace-nowrap tabular-nums text-xs">{fmtNum(r.urlsPlanned)} / {fmtNum(r.urlsCrawled)} / <span className={r.urlsFailed ? 'font-medium text-crit-ink' : ''}>{fmtNum(r.urlsFailed)}</span></span>,
            },
            {
              key: 'delta', header: 'New / resolved / recurring', hideOnMobile: true, cell: (r) => r.source === 'simulated' || isActive(r)
                ? <span className="text-xs text-muted">—</span>
                : <span className="whitespace-nowrap tabular-nums text-xs"><span className={r.newIssues ? 'text-crit-ink' : ''}>{r.newIssues}</span> / <span className="text-ok-ink">{r.resolvedIssues}</span> / {r.recurringIssues}</span>,
            },
            { key: 'src', header: 'Source', cell: (r) => <span className="whitespace-nowrap"><SourceBadge source={r.source} /></span> },
          ]}
        />
      </Panel>
    </div>
  );
}

/** Which crawler runs here and whether its native parts are installed (told plainly, never assumed). */
function EngineStatus({ e }: { e: NonNullable<import('@sentinel/shared').CrawlerStatus['engine']> }) {
  return (
    <p className="rounded-ctl border border-line bg-canvas px-3 py-2 text-xs text-ink-soft">
      <strong className="font-medium">Crawler:</strong>{' '}
      {e.active === 'go' ? 'Go production crawler' : 'built-in Node.js crawler'}
      {' · '}Go crawler {e.goCrawler.available ? `installed${e.goCrawler.version ? ` (${e.goCrawler.version})` : ''}` : `not available — ${e.goCrawler.problem ?? 'not found'}`}
      {' · '}Rust text core {e.textCore.available ? 'installed' : `not available — ${e.textCore.problem ?? 'not found'} (duplicate-content checks are skipped)`}
      {e.memoryBudgetMB ? ` · memory budget ${e.memoryBudgetMB.toLocaleString('en-US')} MB for all crawl processes` : ' · no memory budget set'}
      {e.note ? ` · ${e.note}` : ''}
    </p>
  );
}

function LighthouseSection() {
  const status = useApiQuery(['crawls', 'status'], () => api.getCrawlerStatus());
  return status.data ? <LighthousePanel siteUrl={status.data.siteUrl} /> : null;
}
