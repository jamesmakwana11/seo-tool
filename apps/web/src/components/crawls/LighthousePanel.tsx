import { useEffect, useState, type FormEvent } from 'react';
import { Gauge } from 'lucide-react';
import type { LighthouseFormFactor, LighthouseRun, LighthouseStatus } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Checkbox, EmptyState, Field, Input, Mono, Notice, Panel } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/overlay';
import { fmtDateTime, fmtMs, shortUrl } from '@/lib/format';

const scoreTone = (n: number | null | undefined) => (n === null || n === undefined ? 'neutral' : n >= 90 ? 'ok' : n >= 50 ? 'med' : 'crit');

/** Lighthouse lab audits (mobile / desktop) and rendered-vs-raw HTML checks of single pages, run on the API server. */
export function LighthousePanel({ siteUrl }: { siteUrl: string }) {
  const { can } = useAuth();
  const status = useApiQuery(['lighthouse', 'status'], () => api.getLighthouseStatus());
  const [busy, setBusy] = useState(false);
  const runs = useApiQuery(['lighthouse', 'runs'], () => api.listLighthouseRuns(), { refetchInterval: busy ? 3000 : undefined });
  const list = runs.data ?? [];
  const pending = list.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => setBusy(pending), [pending]);
  const [url, setUrl] = useState(siteUrl);
  const [mobile, setMobile] = useState(true);
  const [desktop, setDesktop] = useState(false);
  const [render, setRender] = useState(true);
  const [open, setOpen] = useState<LighthouseRun | null>(null);
  const start = useApiMutation((i: { url: string; formFactors: LighthouseFormFactor[]; render: boolean }) => api.startLighthouse(i), {
    success: (r) => `${r.length} audit${r.length === 1 ? '' : 's'} queued — they run one at a time`,
    invalidate: [['lighthouse']],
    onSuccess: () => setBusy(true),
  });
  const st: LighthouseStatus | undefined = status.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    start.mutate({ url, formFactors: [...(mobile ? ['mobile' as const] : []), ...(desktop ? ['desktop' as const] : [])], render });
  };
  return (
    <Panel title="Lighthouse and rendered check" subtitle="Lab audit of one page in a real browser (performance, accessibility, best practices, SEO), and a comparison of the HTML search engines fetch first with the page after JavaScript runs.">
      {st && !st.available && <Notice tone="med" title="Not available on this server">{st.problems.join(' ')}</Notice>}
      <form onSubmit={submit} className="mt-3 space-y-3">
        <Field label="Page URL" htmlFor="lh-url" hint="A page of the selected website.">
          <Input id="lh-url" type="url" className="font-mono text-[13px]" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-4">
          <Checkbox label="Mobile" checked={mobile} onChange={setMobile} />
          <Checkbox label="Desktop" checked={desktop} onChange={setDesktop} />
          <Checkbox label="Rendered vs raw HTML" checked={render} onChange={setRender} />
          <Button type="submit" variant="primary" icon={<Gauge className="h-4 w-4" />} loading={start.isPending} disabled={!st?.available || !can('crawls.run') || (!mobile && !desktop && !render)}>Run audit</Button>
        </div>
        <p className="text-xs text-muted">One browser runs at a time{st?.memoryFreeMB !== undefined ? ` and needs about ${st.memoryNeededMB} MB free (${st.memoryFreeMB} MB free now)` : ''}. Lab scores vary between runs; field data (CrUX) shows what real visitors get.</p>
      </form>
      <div className="mt-4">
        <DataTable
          rows={list}
          rowKey={(r) => r.id}
          dense
          pageSize={10}
          onRowClick={(r) => (r.status === 'completed' || r.status === 'failed' ? setOpen(r) : undefined)}
          caption="Lighthouse runs"
          empty={<EmptyState title="No audits yet" description="Run one above. Results stay in server memory until the API restarts." />}
          columns={[
            { key: 'url', header: 'Page', cell: (r) => <Mono className="text-xs">{shortUrl(r.url)}</Mono> },
            { key: 'kind', header: 'Run', cell: (r) => <span className="text-xs">{r.kind === 'render' ? 'Rendered check' : `Lighthouse · ${r.formFactor}`}</span> },
            { key: 'status', header: 'Status', cell: (r) => <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'crit' : 'neutral'} title={r.error}>{r.status}</Badge> },
            {
              key: 'scores', header: 'Scores', cell: (r) => (r.result ? (
                <span className="inline-flex flex-wrap gap-1 text-xs">
                  <Badge tone={scoreTone(r.result.scores.performance)}>Perf {r.result.scores.performance ?? '—'}</Badge>
                  <Badge tone={scoreTone(r.result.scores.seo)}>SEO {r.result.scores.seo ?? '—'}</Badge>
                  <Badge tone={scoreTone(r.result.scores.accessibility)}>A11y {r.result.scores.accessibility ?? '—'}</Badge>
                </span>
              ) : r.render ? <span className="text-xs">{r.render.differences} difference{r.render.differences === 1 ? '' : 's'}</span> : <span className="text-xs text-crit-ink">{r.error ?? ''}</span>),
            },
            { key: 'at', header: 'Requested', hideOnMobile: true, cell: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.createdAt)}</span> },
          ]}
        />
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${open.kind === 'render' ? 'Rendered check' : `Lighthouse (${open.formFactor})`} — ${shortUrl(open.url)}` : ''} width="lg">
        {open && <RunDetail r={open} />}
      </Drawer>
    </Panel>
  );
}

function RunDetail({ r }: { r: LighthouseRun }) {
  if (r.error && !r.result && !r.render) return <Notice tone="crit">{r.error}</Notice>;
  if (r.render) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">HTTP {r.render.status ?? '—'} · rendered in {fmtMs(r.render.ms)}. Differences mean search engines see something else in the first (raw) HTML than visitors see after JavaScript.</p>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted"><th className="py-1">Field</th><th>Raw HTML</th><th>After JavaScript</th></tr></thead>
          <tbody>
            {r.render.fields.map((f) => (
              <tr key={f.field} className={`border-t border-line align-top ${f.differs ? 'bg-med/10' : ''}`}>
                <td className="py-1.5 pr-2 text-xs font-medium">{f.field}{f.differs && <Badge tone="med" className="ml-1">differs</Badge>}</td>
                <td className="break-all py-1.5 pr-2 text-xs">{f.raw || <em className="text-faint">none</em>}</td>
                <td className="break-all py-1.5 text-xs">{f.rendered || <em className="text-faint">none</em>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const res = r.result!;
  const m = res.metrics;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-muted">Lighthouse {res.lighthouseVersion} · {res.formFactor} · {fmtDateTime(res.fetchTime)} · {fmtMs(res.ms)} · final URL <Mono className="text-xs">{res.finalUrl}</Mono></p>
      <div className="flex flex-wrap gap-2">
        {(['performance', 'accessibility', 'bestPractices', 'seo'] as const).map((k) => <Badge key={k} tone={scoreTone(res.scores[k])}>{k === 'bestPractices' ? 'Best practices' : k[0].toUpperCase() + k.slice(1)} {res.scores[k] ?? '—'}</Badge>)}
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {([['lcp', 'Largest Contentful Paint'], ['cls', 'Cumulative Layout Shift'], ['tbt', 'Total Blocking Time'], ['fcp', 'First Contentful Paint'], ['si', 'Speed Index'], ['tti', 'Time to Interactive']] as const).map(([k, label]) => (
          <div key={k} className="rounded-ctl border border-line px-3 py-2"><dt className="text-xs text-muted">{label}</dt><dd className="font-semibold tabular-nums">{m[k]?.display ?? '—'}</dd></div>
        ))}
      </dl>
      {!!res.opportunities.length && (
        <section><h3 className="mb-1 font-semibold">Biggest savings</h3><ul className="space-y-1">{res.opportunities.map((o) => <li key={o.id} className="flex justify-between gap-3 text-xs"><span>{o.title}</span><span className="tabular-nums text-muted">{fmtMs(o.savingsMs)}</span></li>)}</ul></section>
      )}
      {!!res.seoFailures.length && (
        <section><h3 className="mb-1 font-semibold">SEO audits not passed</h3><ul className="list-disc space-y-0.5 pl-4 text-xs">{res.seoFailures.map((a) => <li key={a.id}>{a.title}{a.display ? ` — ${a.display}` : ''}</li>)}</ul></section>
      )}
      {!!res.accessibilityFailures.length && (
        <section><h3 className="mb-1 font-semibold">Accessibility audits not passed</h3><ul className="list-disc space-y-0.5 pl-4 text-xs">{res.accessibilityFailures.map((a) => <li key={a.id}>{a.title}</li>)}</ul></section>
      )}
      {!!res.runWarnings.length && <Notice tone="med">{res.runWarnings.join(' ')}</Notice>}
    </div>
  );
}
