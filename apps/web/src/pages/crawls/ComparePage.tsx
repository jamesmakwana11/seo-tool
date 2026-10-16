import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Camera, Download, Eye, FileCode2, Layers, ScanSearch } from 'lucide-react';
import {
  ApiError, CHANGE_FIELD_LABELS,
  type AssetChange, type CaptureViewport, type PageCapture, type PageComparison, type ThemeDiffFile, type ThemeSnapshotMeta,
} from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, Checkbox, EmptyState, Field, Input, LoadingBlock, Notice, PageHeader, Panel, Segmented, Select, Tabs } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { DiffView } from '@/components/crawls/DiffView';
import { KindBadge } from '@/components/crawls/ChangeMonitor';
import { saveFile } from '@/components/crawls/LiveCrawl';
import { fmtDateTime, shortUrl } from '@/lib/format';

type View = 'visual' | 'dom' | 'seo' | 'assets' | 'theme';
const when = (c?: PageCapture | null) => (c ? `${fmtDateTime(c.at)} IST` : '');

/** A capture image fetched with the session (images are not public URLs), as an object URL. */
function useCaptureImage(id: string | undefined, kind: 'image' | 'diff') {
  const [src, setSrc] = useState<string>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (!id) { setSrc(undefined); return undefined; }
    let url: string | undefined;
    let live = true;
    setErr(undefined);
    api.getCaptureImage(id, kind).then((b) => { if (live) { url = URL.createObjectURL(b); setSrc(url); } }).catch((e) => live && setErr(errorMessage(e)));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [id, kind]);
  return { src, err };
}

export default function ComparePage() {
  const [params, setParams] = useSearchParams();
  const url = params.get('url') ?? '';
  const viewport = (params.get('viewport') as CaptureViewport) || 'desktop';
  const [draft, setDraft] = useState(url);
  useEffect(() => setDraft(url), [url]);
  const set = (k: string, v?: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k === 'url' || k === 'viewport') { p.delete('from'); p.delete('to'); } setParams(p, { replace: k !== 'url' }); };
  const pages = useApiQuery(['captures', 'pages'], () => api.listCapturePages());
  const go = (e: FormEvent) => { e.preventDefault(); if (draft.trim()) set('url', draft.trim()); };

  return (
    <div>
      <Link to="/crawls" className="mb-3 inline-flex items-center gap-1 text-sm text-signal hover:underline"><ArrowLeft className="h-4 w-4" /> Crawl Center</Link>
      <PageHeader title="Compare page versions" description="Screenshots, rendered HTML, SEO fields and the CSS / JS a real browser loaded — previous capture next to the current one. Nothing is shown that was not captured." />
      <div className="space-y-5">
        <CaptureStatusPanel url={url} />
        <Panel>
          <form onSubmit={go} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[240px] flex-1"><Field label="Page" htmlFor="cmp-url"><Input id="cmp-url" type="url" className="w-full font-mono text-[13px]" placeholder="https://your-store/products/…" value={draft} onChange={(e) => setDraft(e.target.value)} /></Field></div>
            <Button type="submit" variant="primary" icon={<ScanSearch className="h-4 w-4" />}>Show</Button>
            {!!pages.data?.length && (
              <Field label="Pages with captures" htmlFor="cmp-pages">
                <Select id="cmp-pages" value="" onChange={(e) => e.target.value && set('url', e.target.value)}>
                  <option value="">Choose…</option>
                  {pages.data.map((p) => <option key={p.url} value={p.url}>{shortUrl(p.url)} ({p.captures})</option>)}
                </Select>
              </Field>
            )}
          </form>
        </Panel>
        {url ? <Comparison url={url} viewport={viewport} from={params.get('from') ?? undefined} to={params.get('to') ?? undefined} set={set} /> : (
          <Panel><EmptyState icon={<Eye className="h-8 w-8 text-muted" />} title="Choose a page" description="Enter a URL of this website, or open one from a crawl's Changes tab. Capture it once now and again after the next change to compare." /></Panel>
        )}
      </div>
    </div>
  );
}

function CaptureStatusPanel({ url }: { url: string }) {
  const { can } = useAuth();
  const [polling, setPolling] = useState(false);
  const st = useApiQuery(['captures', 'status'], () => api.getCaptureStatus(), { refetchInterval: polling ? 2500 : undefined });
  const busy = !!st.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => setPolling(busy), [busy]);
  const [desktop, setDesktop] = useState(true);
  const [mobile, setMobile] = useState(true);
  const capture = useApiMutation(() => api.requestCaptures({ urls: [url], viewports: [...(desktop ? ['desktop' as const] : []), ...(mobile ? ['mobile' as const] : [])] }), {
    success: 'Capture queued — one browser runs at a time', invalidate: [['captures']], onSuccess: () => setPolling(true),
  });
  const watch = useApiMutation((urls: string[]) => api.setCaptureWatch(urls), { success: 'Watched pages saved', invalidate: [['captures']] });
  const s = st.data;
  if (!s) return st.error ? <Notice tone="crit">{errorMessage(st.error)}</Notice> : null;
  const watched = !!url && s.watch.includes(url);
  const last = s.jobs[0];
  return (
    <Panel title="Screenshots" subtitle={`A real Chromium captures ${s.limits.maxHeight.toLocaleString('en-US')} px of each page per viewport. The last ${s.limits.keepPerPage} captures per page are kept.`}>
      <div className="mt-3 space-y-3">
        {!s.available && <Notice tone="med" title="Screenshots are not available on this server">{s.problems.join(' ')} Every comparison view below says so instead of showing anything made up.</Notice>}
        {s.available && (
          <div className="flex flex-wrap items-center gap-4">
            <Checkbox label="Desktop (1366 px)" checked={desktop} onChange={setDesktop} />
            <Checkbox label="Mobile (390 px)" checked={mobile} onChange={setMobile} />
            <Button icon={<Camera className="h-4 w-4" />} variant="primary" loading={capture.isPending} disabled={!url || !can('crawls.run') || (!desktop && !mobile)} onClick={() => capture.mutate()}>Capture this page now</Button>
            {can('crawls.configure') && url && (
              <Checkbox label="Capture after every crawl" checked={watched} disabled={watch.isPending} onChange={(v) => watch.mutate(v ? [...s.watch, url] : s.watch.filter((w) => w !== url))}
                description={s.afterCrawl.enabled ? `After each crawl: ${s.watch.length || 1} watched page(s) and up to ${s.afterCrawl.changedPages} changed pages (${s.afterCrawl.viewports.join(', ')}).` : 'After-crawl captures are switched off on this server (CHANGE_CAPTURE_AFTER_CRAWL).'} />
            )}
          </div>
        )}
        {s.memoryFreeMB !== undefined && <p className="text-xs text-muted">Needs about {s.memoryNeededMB} MB free within the memory budget ({s.memoryFreeMB} MB free now); refused rather than started when it does not fit.</p>}
        {last && (
          <p className="text-xs text-muted">
            Latest job {last.id}: <Badge tone={last.status === 'failed' ? 'crit' : last.status === 'done' ? 'ok' : 'signal'}>{last.status}</Badge>{' '}
            {last.items.filter((i) => i.state === 'done').length}/{last.items.length} captured{last.error ? ` — ${last.error}` : ''}{last.items.some((i) => i.error) ? ` — ${last.items.find((i) => i.error)!.error}` : ''}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Comparison({ url, viewport, from, to, set }: { url: string; viewport: CaptureViewport; from?: string; to?: string; set: (k: string, v?: string) => void }) {
  const caps = useApiQuery(['captures', 'list', url], () => api.listCaptures(url));
  const cmp = useApiQuery(['captures', 'compare', url, viewport, from ?? '', to ?? '', (caps.data ?? []).length], () => api.compareCaptures({ url, viewport, from, to }));
  const [view, setView] = useState<View>('visual');
  const { can } = useAuth();
  const ok = (caps.data ?? []).filter((c) => c.viewport === viewport && c.ok);
  const c = cmp.data;
  return (
    <Panel bodyClassName="p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented<CaptureViewport> label="Viewport" value={viewport} onChange={(v) => set('viewport', v)} items={[{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Mobile' }]} />
        <Field label="Previous" htmlFor="cmp-from">
          <Select id="cmp-from" value={c?.from?.id ?? ''} onChange={(e) => set('from', e.target.value || undefined)} disabled={ok.length < 2}>
            {!c?.from && <option value="">No earlier capture</option>}
            {ok.filter((x) => x.id !== c?.to?.id).map((x) => <option key={x.id} value={x.id}>{fmtDateTime(x.at)}{x.trigger === 'after_crawl' ? ' · after crawl' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Current" htmlFor="cmp-to">
          <Select id="cmp-to" value={c?.to?.id ?? ''} onChange={(e) => set('to', e.target.value || undefined)} disabled={!ok.length}>
            {!ok.length && <option value="">No capture yet</option>}
            {ok.map((x) => <option key={x.id} value={x.id}>{fmtDateTime(x.at)}{x.trigger === 'after_crawl' ? ' · after crawl' : ''}</option>)}
          </Select>
        </Field>
        {c?.change && <span className="ml-auto flex items-center gap-2 text-xs text-muted">Latest crawl: <KindBadge r={c.change} />{c.change.fields.length ? ` ${c.change.fields.map((f) => CHANGE_FIELD_LABELS[f.field]).join(', ')}` : ''}</span>}
      </div>
      {caps.data?.some((x) => x.viewport === viewport && !x.ok) && (
        <p className="mt-2 text-xs text-crit-ink">Last failed {viewport} capture: {caps.data.find((x) => x.viewport === viewport && !x.ok)!.error}</p>
      )}
      <Tabs<View> className="mt-4" value={view} onChange={setView} items={[
        { value: 'visual', label: 'Visual' },
        { value: 'dom', label: 'Rendered HTML' },
        { value: 'seo', label: 'SEO fields' },
        { value: 'assets', label: 'CSS / JS', count: c?.assets.items.filter((a) => a.state !== 'same').length },
        ...(can('shopify.theme') ? [{ value: 'theme' as View, label: 'Theme source' }] : []),
      ]} />
      <div className="mt-4">
        {cmp.isLoading && <LoadingBlock rows={6} />}
        {cmp.error && <Notice tone="crit">{errorMessage(cmp.error)}</Notice>}
        {c && view === 'visual' && <VisualView c={c} />}
        {c && view === 'dom' && <DomView c={c} />}
        {c && view === 'seo' && <SeoView c={c} />}
        {c && view === 'assets' && <AssetsView c={c} />}
        {view === 'theme' && <ThemeSourceView />}
      </div>
    </Panel>
  );
}

function Shot({ cap, kind, label, empty }: { cap: PageCapture | null; kind: 'image' | 'diff'; label: string; empty: string }) {
  const img = useCaptureImage(cap && (kind === 'image' ? cap.hasImage : cap.hasDiffImage) ? cap.id : undefined, kind);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-muted">{cap ? `${when(cap)}${cap.status ? ` · HTTP ${cap.status}` : ''}` : ''}</span>
      </figcaption>
      <div className="max-h-[720px] overflow-auto rounded-ctl border border-line bg-canvas">
        {!cap ? <p className="px-4 py-16 text-center text-sm text-muted">{empty}</p>
          : img.err ? <p className="p-4 text-sm text-crit-ink">{img.err}</p>
            : img.src ? <img src={img.src} alt={`${label} screenshot of ${cap.url}`} className="block w-full" />
              : <LoadingBlock rows={4} />}
      </div>
      {cap?.cut && <p className="mt-1 text-[11px] text-muted">The page is {cap.docHeight?.toLocaleString('en-US')} px tall; the first {cap.height?.toLocaleString('en-US')} px were captured.</p>}
    </figure>
  );
}

function VisualView({ c }: { c: PageComparison }) {
  const [mode, setMode] = useState<'side' | 'diff'>('side');
  const hasDiff = !!c.visual.diffOf;
  return (
    <div className="space-y-3">
      {c.visual.reason && <Notice tone={c.visual.available ? 'neutral' : 'med'}>{c.visual.reason}</Notice>}
      {hasDiff && (
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<'side' | 'diff'> label="Visual view" value={mode} onChange={setMode} items={[{ value: 'side', label: 'Side by side' }, { value: 'diff', label: 'Difference' }]} />
          <span className="text-xs text-muted">{((c.visual.ratio ?? 0) * 100).toFixed(1)} % of pixels differ{c.visual.sizeChanged ? ' · the page height changed, so content below a change shifts' : ''}</span>
        </div>
      )}
      {mode === 'diff' && hasDiff ? (
        <Shot cap={c.to} kind="diff" label="Difference (red = changed pixels)" empty="" />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Shot cap={c.from} kind="image" label="Previous" empty="No earlier screenshot of this page and viewport. None is made up." />
          <Shot cap={c.to} kind="image" label="Current" empty="No screenshot yet. Capture this page to start its history." />
        </div>
      )}
    </div>
  );
}

function DomView({ c }: { c: PageComparison }) {
  const toast = useToast();
  const dl = async (id: string) => { try { saveFile(await api.downloadCaptureHtml(id)); } catch (e) { toast.error(errorMessage(e)); } };
  return (
    <div className="space-y-3">
      <Notice tone="neutral">{c.dom.note || 'Rendered HTML after JavaScript, as Chromium built it.'}</Notice>
      {!c.dom.available ? <Notice tone="med">{c.dom.reason}</Notice> : (
        <>
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            <span>Previous: {when(c.from)}</span><span>·</span><span>Current: {when(c.to)}</span>
            <span className="ml-auto flex gap-2">
              {c.from?.hasHtml && <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => dl(c.from!.id)}>Previous HTML</Button>}
              {c.to?.hasHtml && <Button size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} onClick={() => dl(c.to!.id)}>Current HTML</Button>}
            </span>
          </div>
          <DiffView diff={c.dom.diff!} label="Rendered HTML differences" />
        </>
      )}
    </div>
  );
}

function SeoView({ c }: { c: PageComparison }) {
  return (
    <div className="space-y-4">
      {!c.to ? <Notice tone="med">{c.visual.reason}</Notice> : (
        <div className="overflow-x-auto rounded-ctl border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">SEO fields of the rendered page</caption>
            <thead className="bg-raised/60 text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">Field (rendered page)</th><th className="px-3 py-2 font-medium">Previous · {c.from ? when(c.from) : 'none'}</th><th className="px-3 py-2 font-medium">Current · {when(c.to)}</th></tr></thead>
            <tbody className="divide-y divide-line">
              {c.seoFields.map((f) => (
                <tr key={f.field} className={f.changed ? 'bg-signal-tint/40' : undefined}>
                  <td className="whitespace-nowrap px-3 py-2 align-top text-xs font-medium">{f.field}{f.changed && <Badge tone="signal" className="ml-2">Changed</Badge>}</td>
                  <td className="break-words px-3 py-2 align-top text-[13px] text-ink-soft">{c.from ? f.from ?? <span className="text-faint">(none)</span> : <span className="text-faint">—</span>}</td>
                  <td className="break-words px-3 py-2 align-top text-[13px] text-ink-soft">{f.to ?? <span className="text-faint">(none)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.change && c.change.fields.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Crawler comparison (raw HTML)</h3>
          <p className="mb-2 text-xs text-muted">What the crawler saw in the HTML it fetched (before JavaScript), latest crawl vs the baseline of {c.change.baselineObservedAt ? fmtDateTime(c.change.baselineObservedAt) : '—'}.</p>
          <ul className="space-y-1.5">
            {c.change.fields.map((f) => <li key={f.field} className="text-[13px]"><span className="font-medium">{CHANGE_FIELD_LABELS[f.field]}:</span> <span className="text-crit-ink">{f.old}</span> → <span className="text-ok-ink">{f.new}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function AssetsView({ c }: { c: PageComparison }) {
  const [open, setOpen] = useState<AssetChange | null>(null);
  const changed = c.assets.items.filter((a) => a.state !== 'same');
  const diff = useApiQuery(['captures', 'asset', c.url, c.from?.id ?? '', c.to?.id ?? '', open?.key ?? ''], () => api.getCaptureAssetDiff({ url: c.url, from: c.from!.id, to: c.to!.id, key: open!.key }), { enabled: !!open && !!c.from && !!c.to });
  if (!c.assets.available) return <Notice tone="med">{c.assets.reason}</Notice>;
  if (!c.assets.items.length) return <Notice tone="neutral">{c.assets.reason}</Notice>;
  const tone = { changed: 'signal', added: 'ok', removed: 'crit', same: 'neutral' } as const;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">The stylesheets and scripts of this website and its CDN that Chromium downloaded during each capture. {changed.length ? `${changed.length} differ.` : 'None differs.'} These are public files, not the theme source.</p>
      <ul className="divide-y divide-line rounded-ctl border border-line">
        {c.assets.items.map((a) => (
          <li key={a.key}>
            <button type="button" disabled={a.state === 'same'} onClick={() => setOpen(open?.key === a.key ? null : a)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm enabled:hover:bg-raised/50 disabled:cursor-default">
              <Badge tone={tone[a.state]}>{a.state}</Badge>
              <Badge>{a.type.toUpperCase()}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={a.to?.url ?? a.from?.url}>{a.key}</span>
              <span className="text-xs tabular-nums text-muted">{a.from ? `${Math.round(a.from.bytes / 1024)} KB` : '—'} → {a.to ? `${Math.round(a.to.bytes / 1024)} KB` : '—'}</span>
            </button>
            {open?.key === a.key && (
              <div className="border-t border-line p-3">
                {diff.isLoading ? <LoadingBlock rows={4} /> : diff.error ? <Notice tone="crit">{errorMessage(diff.error)}</Notice> : diff.data ? (
                  <>
                    <p className="mb-2 text-xs text-muted">{diff.data.note}</p>
                    <DiffView diff={diff.data.diff} label={`Differences in ${a.key}`} maxHeight={420} />
                  </>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThemeSourceView() {
  const themes = useApiQuery(['shopify', 'themes'], () => api.listShopifyThemes());
  const snaps = useApiQuery(['shopify', 'themeSnapshots'], () => api.listThemeSnapshots());
  const take = useApiMutation((id: string) => api.createThemeSnapshot(id), { success: (m) => `Read ${m.files} theme file(s)`, invalidate: [['shopify', 'themeSnapshots']] });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [file, setFile] = useState<string>();
  const list: ThemeSnapshotMeta[] = useMemo(() => snaps.data ?? [], [snaps.data]);
  useEffect(() => { if (list.length >= 2 && !to) { setTo(list[0].id); setFrom(list[1].id); } }, [list, to]);
  const diff = useApiQuery(['shopify', 'themeDiff', from, to, file ?? ''], () => api.diffThemeSnapshots(from, to, file), { enabled: !!from && !!to && from !== to });
  const notConnected = themes.error instanceof ApiError && themes.error.status === 409;
  const label = (m: ThemeSnapshotMeta) => `${m.themeName} (${m.themeRole.toLowerCase()}) · ${fmtDateTime(m.at)}`;
  return (
    <div className="space-y-4">
      <Notice tone="neutral" title="Theme source is not the rendered page">
        Public pages never expose the theme&apos;s source. It is read here only through the authorised Shopify connection (read_themes), read-only: this viewer cannot edit or publish theme code. A difference in the rendered HTML alone does not prove the theme changed.
      </Notice>
      {themes.isLoading && <LoadingBlock rows={3} />}
      {themes.error && <Notice tone="med" title={notConnected ? 'No authorised Shopify connection' : 'Themes could not load'}>{errorMessage(themes.error)} {notConnected && <Link to="/settings/shopify" className="text-signal hover:underline">Connect Shopify</Link>}</Notice>}
      {themes.data && (
        <ul className="divide-y divide-line rounded-ctl border border-line">
          {themes.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">{t.name} <Badge>{t.role.toLowerCase()}</Badge></span>
              <Button size="sm" icon={<Layers className="h-3.5 w-3.5" />} loading={take.isPending && take.variables === t.id} onClick={() => take.mutate(t.id)}>Read source now</Button>
            </li>
          ))}
        </ul>
      )}
      {list.length >= 2 ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From" htmlFor="th-from"><Select id="th-from" value={from} onChange={(e) => { setFrom(e.target.value); setFile(undefined); }}>{list.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}</Select></Field>
            <Field label="To" htmlFor="th-to"><Select id="th-to" value={to} onChange={(e) => { setTo(e.target.value); setFile(undefined); }}>{list.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}</Select></Field>
          </div>
          {from === to ? <p className="text-sm text-muted">Choose two different snapshots.</p> : diff.isLoading ? <LoadingBlock rows={4} /> : diff.error ? <Notice tone="crit">{errorMessage(diff.error)}</Notice> : diff.data && (
            <div className="space-y-2">
              <p className="text-xs text-muted">{diff.data.note}</p>
              <ThemeFiles files={diff.data.files} open={file} onOpen={setFile} />
            </div>
          )}
        </>
      ) : !themes.error && <p className="text-sm text-muted">{list.length ? 'One snapshot so far. Read the source again later (or another theme) to compare.' : 'No snapshot yet. Read a theme’s source to start.'}</p>}
    </div>
  );
}

function ThemeFiles({ files, open, onOpen }: { files: ThemeDiffFile[]; open?: string; onOpen: (f?: string) => void }) {
  const [showSame, setShowSame] = useState(false);
  const shown = files.filter((f) => showSame || f.state !== 'same');
  const tone = { changed: 'signal', added: 'ok', removed: 'crit', same: 'neutral' } as const;
  return (
    <div>
      <Checkbox label={`Show unchanged files (${files.filter((f) => f.state === 'same').length})`} checked={showSame} onChange={setShowSame} />
      {!shown.length ? <p className="mt-2 text-sm text-muted">No file differs.</p> : (
        <ul className="mt-2 divide-y divide-line rounded-ctl border border-line">
          {shown.map((f) => (
            <li key={f.filename}>
              <button type="button" disabled={f.state === 'same'} onClick={() => onOpen(open === f.filename ? undefined : f.filename)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm enabled:hover:bg-raised/50">
                <Badge tone={tone[f.state]}>{f.state}</Badge><FileCode2 className="h-3.5 w-3.5 text-muted" /><span className="font-mono text-xs">{f.filename}</span>
              </button>
              {open === f.filename && f.diff && <div className="border-t border-line p-3"><DiffView diff={f.diff} label={`Differences in ${f.filename}`} maxHeight={480} /></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
