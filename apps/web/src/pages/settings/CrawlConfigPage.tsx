import { Link } from 'react-router-dom';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import type { SentinelConfig } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Checkbox, Field, Input, Mono, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { ConfigSection, NumberField } from '@/components/settings/ConfigSection';
import { fmtDateTime } from '@/lib/format';

const CRON = /^(\S+\s+){4}\S+$/;

export default function CrawlConfigPage() {
  const q = useApiQuery(['config'], () => api.getConfig());
  return (
    <div>
      <PageHeader
        title="Crawl configuration"
        description="How the crawler covers deodap.in: a daily smart crawl (home, collections, top products, URLs changed in the last 48h, re-verify set) and a weekly full crawl with JS rendering on a sample (PDF §2.1)."
        actions={<Link to="/crawls" className="inline-flex h-9 items-center gap-1 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark">Crawl Center <ArrowUpRight className="h-4 w-4" /></Link>}
      />
      <div className="space-y-5">
        <Notice tone="signal" icon={<ShieldCheck className="h-4 w-4" />} title="Allow the crawler through Shopify bot protection">
          The crawler user agent below must be allowed by Shopify’s bot protection and any firewall/CDN in front of deodap.in, otherwise crawls return challenge pages instead of real HTML (PDF §15 “verify crawler user-agent allowed”).
        </Notice>
        <Async q={q} rows={8}>{(c) => <CrawlForm c={c} />}</Async>
        <Schedules />
      </div>
    </div>
  );
}

function CrawlForm({ c }: { c: SentinelConfig }) {
  const { can } = useAuth();
  return (
    <ConfigSection
      config={c}
      k="crawl"
      title="Crawler settings"
      subtitle="Sent as one slice to the configuration API; other settings are untouched."
      origin="PDF §2.1, §4.5"
      canEdit={can('settings.manage')}
      readOnlyReason="Editing crawl settings needs the settings.manage permission."
      saveLabel="Save crawl settings"
      validate={(v) => {
        if (!CRON.test(v.fullCrawlCron.trim()) || !CRON.test(v.smartCrawlCron.trim())) return 'Cron expressions need 5 fields: minute hour day month weekday.';
        if (!v.userAgent.trim()) return 'User agent is required.';
        const nums: [string, number, number][] = [['Smart crawl top products', v.smartTopProducts, 1], ['Changed-within window', v.changedWithinHours, 1], ['JS render sample size', v.jsRenderSampleSize, 0], ['Max concurrency', v.maxConcurrency, 1], ['Request timeout', v.requestTimeoutMs, 1000], ['Render viewport width', v.renderViewportWidth, 320]];
        const bad = nums.find(([, n, min]) => !Number.isFinite(n) || n < min);
        return bad ? `${bad[0]} must be at least ${bad[2]}.` : undefined;
      }}
    >
      {(v, set, d) => (
        <div className="space-y-5">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Coverage</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <NumberField id="c-top" label="Smart crawl: top products" value={v.smartTopProducts} min={1} step={1} disabled={d} onChange={(n) => set({ ...v, smartTopProducts: n })} hint="PDF §2.1 default 500." />
              <NumberField id="c-changed" label="Smart crawl: changed within" value={v.changedWithinHours} min={1} step={1} suffix="hours" disabled={d} onChange={(n) => set({ ...v, changedWithinHours: n })} hint="PDF §2.1 default 48h." />
              <NumberField id="c-js" label="JS render sample size" value={v.jsRenderSampleSize} min={0} step={1} suffix="URLs" disabled={d} onChange={(n) => set({ ...v, jsRenderSampleSize: n })} hint="Workshop placeholder (200)." />
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Schedule (cron, IST)</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Full crawl" htmlFor="c-full" hint="Default weekly, Sunday 02:00 IST (day/time workshop).">
                <Input id="c-full" value={v.fullCrawlCron} disabled={d} onChange={(e) => set({ ...v, fullCrawlCron: e.target.value })} className="max-w-xs font-mono" aria-invalid={!CRON.test(v.fullCrawlCron.trim())} />
              </Field>
              <Field label="Smart crawl" htmlFor="c-smart" hint="Default daily 05:30 IST so the 08:00 digest is ready.">
                <Input id="c-smart" value={v.smartCrawlCron} disabled={d} onChange={(e) => set({ ...v, smartCrawlCron: e.target.value })} className="max-w-xs font-mono" aria-invalid={!CRON.test(v.smartCrawlCron.trim())} />
              </Field>
            </div>
            <p className="mt-2 text-xs text-muted">These are the configured defaults. Live schedule entries below are enabled, paused or re-timed from the Crawl Center.</p>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Requests</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Crawler user agent" htmlFor="c-ua" hint="Must be allow-listed in Shopify bot protection / firewall.">
                  <Input id="c-ua" value={v.userAgent} disabled={d} onChange={(e) => set({ ...v, userAgent: e.target.value })} className="font-mono" aria-invalid={!v.userAgent.trim()} />
                </Field>
              </div>
              <NumberField id="c-conc" label="Max concurrency" value={v.maxConcurrency} min={1} step={1} disabled={d} onChange={(n) => set({ ...v, maxConcurrency: n })} hint="Parallel requests — keep low to be polite." />
              <NumberField id="c-timeout" label="Request timeout" value={v.requestTimeoutMs} min={1000} step={500} suffix="ms" disabled={d} onChange={(n) => set({ ...v, requestTimeoutMs: n })} />
              <NumberField id="c-vp" label="Render viewport width" value={v.renderViewportWidth} min={320} step={1} suffix="px" disabled={d} onChange={(n) => set({ ...v, renderViewportWidth: n })} hint="PDF §4.5 mobile check uses 390px." />
              <div className="flex items-end pb-2 sm:col-span-2">
                <Checkbox label="Respect robots.txt" description="Recommended. Turning this off only affects Sentinel’s own crawler." checked={v.respectRobots} disabled={d} onChange={(b) => set({ ...v, respectRobots: b })} />
              </div>
            </div>
          </fieldset>
        </div>
      )}
    </ConfigSection>
  );
}

function Schedules() {
  const q = useApiQuery(['crawls', 'schedules'], () => api.listSchedules());
  return (
    <Panel title="Current schedules" subtitle="Managed in the Crawl Center" actions={<Link to="/crawls" className="text-sm text-signal hover:underline">Manage in Crawl Center</Link>} bodyClassName="p-3">
      <Async q={q} rows={2}>
        {(rows) => (
          <DataTable
            rows={rows}
            rowKey={(s) => s.id}
            dense
            caption="Crawl schedules"
            columns={[
              { key: 't', header: 'Type', cell: (s) => <span className="capitalize">{s.type}</span> },
              { key: 'cron', header: 'Cron (IST)', cell: (s) => <Mono>{s.cron}</Mono> },
              { key: 'desc', header: 'Description', cell: (s) => <span className="text-xs">{s.description}</span>, hideOnMobile: true },
              { key: 'en', header: 'Status', cell: (s) => <Badge tone={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'Enabled' : 'Paused'}</Badge> },
              { key: 'next', header: 'Next run', cell: (s) => <span className="whitespace-nowrap text-xs">{s.enabled && s.nextRunAt ? `${fmtDateTime(s.nextRunAt)} IST` : '—'}</span> },
              { key: 'last', header: 'Last run', cell: (s) => (s.lastRunId ? <Link to={`/crawls/${s.lastRunId}`} className="font-mono text-xs text-signal hover:underline">{s.lastRunId}</Link> : '—'), hideOnMobile: true },
            ]}
          />
        )}
      </Async>
    </Panel>
  );
}
