import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink } from 'lucide-react';
import { DEFAULT_PAGE_AUDIT_LIMITS, PAGE_AUDIT_TODO, type CrawledUrl, type CrawlPageReport, type DuplicateGroup, type PageAuditCheck, type PageAuditLimits } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { Mono } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { fmtNum, shortUrl } from '@/lib/format';
import { ImageThumb } from './ImageThumb';

/** What the page audit needs to show a finding in full: the page row, its crawl and (when already loaded) the duplicates. */
export interface AuditContext {
  row: CrawledUrl;
  runId: string;
  limits?: PageAuditLimits;
  /** Pages sharing this page's title / meta / H1 (the page report has them; the drawer loads them when opened). */
  duplicates?: CrawlPageReport['duplicates'];
  /** Pages of the crawl per audit check (the All pages facets, when already loaded). */
  checkCounts?: Record<string, number>;
}

const NOT_IDENTIFIED = 'Could not be identified from this crawl.';
const reportHref = (runId: string, url: string) => `/pages/report?run=${encodeURIComponent(runId)}&url=${encodeURIComponent(url)}`;
const chars = (s?: string) => [...(s ?? '').trim()].length;

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 py-1 text-xs">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function ExtLink({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-start gap-1 break-all font-mono text-[11.5px] text-signal hover:underline" title={url}>
      {children ?? url}<ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

/** Every page of a list: each opens its page report; the icon opens the live page. Shown 50 at a time. */
export function PageList({ urls, runId, total, testId }: { urls: string[]; runId: string; total?: number; testId?: string }) {
  const [shown, setShown] = useState(50);
  const toast = useToast();
  const copy = () => void navigator.clipboard?.writeText(urls.join('\n')).then(() => toast.success(`Copied ${urls.length} URLs`), () => toast.error('Clipboard not available in this browser.'));
  return (
    <div data-testid={testId}>
      <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-ctl border border-line bg-surface">
        {urls.slice(0, shown).map((u) => (
          <li key={u} className="flex items-center gap-2 px-2 py-1">
            <Link to={reportHref(runId, u)} className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-signal hover:underline" title={u}>{shortUrl(u)}</Link>
            <a href={u} target="_blank" rel="noreferrer noopener" className="text-faint hover:text-signal" aria-label={`Open ${u} in a new tab`}><ExternalLink className="h-3.5 w-3.5" /></a>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
        {urls.length > shown && <button type="button" className="text-signal hover:underline" onClick={() => setShown((n) => n + 200)}>Show {fmtNum(Math.min(200, urls.length - shown))} more ({fmtNum(urls.length - shown)} not shown yet)</button>}
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-signal hover:underline"><Copy className="h-3 w-3" /> Copy all {fmtNum(urls.length)}</button>
        {total !== undefined && total > urls.length && <span className="text-muted">{fmtNum(total - urls.length)} more pages share it but are not listed (list limit reached).</span>}
      </div>
    </div>
  );
}

/** The title / meta / H1 shared with other pages, every other page and the exact count. */
function DuplicateDetails({ ctx, kind, what }: { ctx: AuditContext; kind: 'title' | 'meta' | 'h1'; what: string }) {
  const q = useApiQuery(['crawlPage', ctx.runId, ctx.row.url], () => api.getCrawlPage(ctx.runId, ctx.row.url), { enabled: !ctx.duplicates });
  const d = ctx.duplicates ?? q.data?.duplicates;
  if (!d) return <p className="text-xs text-muted">{q.isError ? `The other pages could not be loaded. ${NOT_IDENTIFIED}` : 'Loading the other pages…'}</p>;
  const g: DuplicateGroup | undefined = d[kind];
  const text = g?.text ?? (kind === 'title' ? ctx.row.title : kind === 'meta' ? ctx.row.metaDescription : ctx.row.h1?.[0]);
  return (
    <div data-testid={`dup-${kind}`}>
      <dl>
        <KV k={`Shared ${what}`}>{text ? <>"{text}" <span className="text-muted">({chars(text)} characters)</span></> : <span className="text-muted">{NOT_IDENTIFIED}</span>}</KV>
        <KV k="Pages with it">{g && g.total > 0 ? <span className="font-medium tabular-nums">{fmtNum(g.total + 1)} pages — this one and {fmtNum(g.total)} other{g.total === 1 ? '' : 's'}</span> : <span className="text-muted">{NOT_IDENTIFIED}</span>}</KV>
      </dl>
      {g && g.urls.length > 0 ? <><p className="mb-1 mt-1.5 text-xs font-medium text-ink">Other pages with the same {what}</p><PageList urls={g.urls} runId={ctx.runId} total={g.total} testId={`dup-${kind}-urls`} /></> : <p className="text-xs text-muted">The other pages {NOT_IDENTIFIED.toLowerCase()} Run a new crawl to list them.</p>}
    </div>
  );
}

function TextDetails({ text, what, min, max }: { text?: string; what: string; min: number; max: number }) {
  const n = chars(text);
  return (
    <dl>
      <KV k={`Current ${what}`}>{text?.trim() ? `"${text.trim()}"` : <span className="text-crit-ink">None on the page</span>}</KV>
      <KV k="Length"><span className={n && (n < min || n > max) ? 'font-medium text-med-ink' : ''}>{n} characters</span> <span className="text-muted">— recommended {min}–{max}</span></KV>
    </dl>
  );
}

function AltDetails({ row }: { row: CrawledUrl }) {
  const list = row.imagesMissingAltSrc ?? [];
  const total = row.imagesMissingAlt ?? list.length;
  return (
    <div data-testid="alt-images">
      <p className="mb-1 text-xs text-ink"><span className="font-medium tabular-nums">{fmtNum(total)}</span> of {fmtNum(row.images ?? total)} image{(row.images ?? total) === 1 ? '' : 's'} on this page without ALT text</p>
      {list.length ? (
        <ul className="max-h-96 space-y-1 overflow-y-auto">
          {list.map((src, i) => (
            <li key={`${src}-${i}`} className="flex items-center gap-2 rounded-ctl border border-line px-2 py-1">
              <ImageThumb src={src} size={40} />
              <ExtLink url={src}>{shortUrl(src)}</ExtLink>
            </li>
          ))}
        </ul>
      ) : null}
      {total > list.length && <p className="mt-1 text-xs text-muted">{fmtNum(total - list.length)} image address{total - list.length === 1 ? '' : 'es'} {NOT_IDENTIFIED.toLowerCase()} Run a new crawl to list every image.</p>}
    </div>
  );
}

function RepeatedDetails({ row }: { row: CrawledUrl }) {
  const rep = row.repeatedImages;
  if (!rep) return <p className="text-xs text-muted">Which copies repeat {NOT_IDENTIFIED.toLowerCase()} Run a new crawl to list them.</p>;
  return (
    <ul className="space-y-2" data-testid="repeated-images">
      {rep.map((r) => (
        <li key={r.src} className="rounded-ctl border border-line p-2">
          <div className="flex items-start gap-2">
            <ImageThumb src={r.src} size={56} />
            <div className="min-w-0 flex-1">
              <ExtLink url={r.src} />
              <p className="mt-0.5 text-xs text-ink"><span className="font-medium">Shown {r.count}× on this page</span> <span className="text-muted">— the same image file in {r.count} places</span></p>
            </div>
          </div>
          <table className="mt-1.5 w-full text-left text-xs">
            <thead className="text-muted"><tr><th className="py-0.5 pr-2 font-normal">Copy</th><th className="py-0.5 pr-2 font-normal">Where in the HTML</th><th className="py-0.5 pr-2 font-normal">ALT</th><th className="py-0.5 font-normal">Loading</th></tr></thead>
            <tbody>
              {r.instances.map((x, i) => (
                <tr key={i} className="border-t border-line align-top">
                  <td className="py-1 pr-2 tabular-nums">{i + 1} <span className="text-muted">(image #{x.position})</span></td>
                  <td className="py-1 pr-2">{x.location ? <Mono className="text-[11px]">{x.location}</Mono> : <span className="text-muted">{x.inMain ? 'Main content — section not identifiable' : 'Section not identifiable'}</span>}</td>
                  <td className="py-1 pr-2">{x.alt === null ? <span className="text-med-ink">missing</span> : x.alt === '' ? <span className="text-muted">empty (decorative)</span> : `"${x.alt}"`}</td>
                  <td className="py-1">{x.loading ?? <span className="text-muted">default</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
      ))}
    </ul>
  );
}

function BrokenDetails({ row }: { row: CrawledUrl }) {
  const det = row.brokenLinkDetails;
  const urls = row.brokenLinks ?? [];
  const list = det ?? urls.map((url) => ({ url, status: undefined as number | null | undefined, error: '' }));
  return (
    <div data-testid="broken-links-table">
      <p className="mb-1 text-xs text-ink">Source page: <ExtLink url={row.url}>{shortUrl(row.url)}</ExtLink></p>
      <div className="max-h-96 overflow-auto rounded-ctl border border-line">
        <table className="w-full text-left text-xs">
          <thead className="bg-canvas text-muted"><tr><th className="px-2 py-1 font-normal">Destination (linked from this page)</th><th className="px-2 py-1 font-normal">HTTP status</th><th className="px-2 py-1 font-normal">Error type</th></tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l.url} className="border-t border-line align-top">
                <td className="px-2 py-1"><ExtLink url={l.url}>{shortUrl(l.url)}</ExtLink></td>
                <td className="px-2 py-1 tabular-nums">{l.status === undefined ? <span className="text-muted">not recorded</span> : l.status === null ? 'no response' : l.status}</td>
                <td className="px-2 py-1">{l.error || <span className="text-muted">not recorded — run a new crawl</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {urls.length >= 500 && <p className="mt-1 text-xs text-muted">The crawl records up to 500 broken links per page; this page may have more.</p>}
    </div>
  );
}

/** The detail rows a check needs; undefined = the generic view (value + items). */
function specific(c: PageAuditCheck, ctx: AuditContext): ReactNode | undefined {
  const u = ctx.row;
  const L = { ...DEFAULT_PAGE_AUDIT_LIMITS, ...ctx.limits };
  switch (c.id) {
    case 'title-missing': case 'title-short': case 'title-long': case 'title-multiple':
      return <><TextDetails text={u.title} what="title" min={L.titleMinChars} max={L.titleMaxChars} />{c.id === 'title-multiple' && <KV k="Title elements">{u.titleCount ?? 'not recorded'}</KV>}</>;
    case 'title-duplicate':
      return <><TextDetails text={u.title} what="title" min={L.titleMinChars} max={L.titleMaxChars} /><DuplicateDetails ctx={ctx} kind="title" what="title" /></>;
    case 'meta-missing': case 'meta-short': case 'meta-long': case 'meta-multiple':
      return <><TextDetails text={u.metaDescription} what="meta description" min={L.metaMinChars} max={L.metaMaxChars} />{c.id === 'meta-multiple' && <KV k="Meta elements">{u.metaDescriptionCount ?? 'not recorded'}</KV>}</>;
    case 'meta-duplicate':
      return <><TextDetails text={u.metaDescription} what="meta description" min={L.metaMinChars} max={L.metaMaxChars} /><DuplicateDetails ctx={ctx} kind="meta" what="meta description" /></>;
    case 'h1-missing': case 'h1-empty': case 'h1-multiple':
      return <dl><KV k="H1 on this page">{u.h1?.length ? <ol className="list-decimal pl-4">{u.h1.map((h, i) => <li key={i}>{h ? `"${h}"` : <em className="text-muted">empty</em>}</li>)}</ol> : <span className="text-crit-ink">None</span>}</KV><KV k="Count">{u.h1?.length ?? 0} (recommended: exactly 1)</KV></dl>;
    case 'h1-duplicate':
      return <DuplicateDetails ctx={ctx} kind="h1" what="H1" />;
    case 'alt-missing': return <AltDetails row={u} />;
    case 'images-repeated': return <RepeatedDetails row={u} />;
    case 'broken-links': return <BrokenDetails row={u} />;
    case 'redirect':
      return <dl><KV k="Requested URL"><ExtLink url={u.url} /></KV><KV k="Status">{u.status ?? 'no response'}{u.redirects ? ` — ${u.redirects} hop${u.redirects > 1 ? 's' : ''}` : ''}</KV><KV k="Final URL">{u.finalUrl ? <ExtLink url={u.finalUrl} /> : <span className="text-muted">{NOT_IDENTIFIED}</span>}</KV><KV k="Final status">{u.finalStatus ?? (u.redirects ? 'no response' : '—')}</KV><KV k="Linked from">{u.foundOn ? <ExtLink url={u.foundOn} /> : <span className="text-muted">{NOT_IDENTIFIED}</span>}</KV></dl>;
    case 'error-status': case 'no-response':
      return <dl><KV k="URL"><ExtLink url={u.url} /></KV><KV k="HTTP status">{u.finalStatus ?? u.status ?? 'no response'}</KV><KV k="Error">{u.error ?? (c.id === 'error-status' ? `HTTP ${u.finalStatus ?? u.status}` : <span className="text-muted">{NOT_IDENTIFIED}</span>)}</KV><KV k="Linked from">{u.foundOn ? <ExtLink url={u.foundOn} /> : <span className="text-muted">{NOT_IDENTIFIED}</span>}</KV><KV k="Internal links here">{u.inlinks !== undefined ? fmtNum(u.inlinks) : <span className="text-muted">not recorded</span>}</KV></dl>;
    case 'slow':
      return <dl><KV k="Response time">{u.responseMs !== undefined ? `${(u.responseMs / 1000).toFixed(2)} s` : '—'}</KV><KV k="Limit">{(L.slowResponseMs / 1000).toFixed(1)} s</KV>{u.bytes !== undefined && <KV k="Page size">{fmtNum(Math.round(u.bytes / 1024))} KB</KV>}</dl>;
    case 'thin':
      return <dl><KV k="Words on the page">{u.wordCount !== undefined ? fmtNum(u.wordCount) : '—'}{u.uniqueWords !== undefined && <span className="text-muted"> ({fmtNum(u.uniqueWords)} unique)</span>}</KV><KV k="Recommended">at least {fmtNum(L.thinContentWords)} words</KV><KV k="Template">{u.template ?? '—'}</KV></dl>;
    case 'not-indexable':
      return <dl><KV k="Reason">{u.indexabilityReason ?? <span className="text-muted">{NOT_IDENTIFIED}</span>}</KV><KV k="Meta robots">{u.metaRobots ?? 'none'}</KV><KV k="X-Robots-Tag">{u.xRobotsTag ?? 'none'}</KV><KV k="Canonical">{u.canonical ? <ExtLink url={u.canonical} /> : 'none'}</KV><KV k="In sitemap">{u.inSitemap === undefined ? '—' : u.inSitemap ? 'Yes' : 'No'}</KV></dl>;
    case 'canonical-other': case 'canonical-missing': case 'canonical-multiple':
      return <dl><KV k="This page"><ExtLink url={u.finalUrl ?? u.url} /></KV><KV k="Canonical">{u.canonical ? <ExtLink url={u.canonical} /> : 'none'}</KV>{u.canonicalCount !== undefined && <KV k="Canonical tags">{u.canonicalCount}</KV>}</dl>;
    case 'orphan':
      return <dl><KV k="Internal links here">{u.inlinks ?? 0}</KV><KV k="Found via">{u.foundVia?.join(', ') ?? u.reason}</KV><KV k="In sitemap">{u.inSitemap === undefined ? '—' : u.inSitemap ? 'Yes' : 'No'}</KV></dl>;
    default: return undefined;
  }
}

/** Crawl-wide count of pages with this finding, with a link to all of them on All pages. */
function CrawlWide({ id, ctx }: { id: string; ctx: AuditContext }) {
  const listed = PAGE_AUDIT_TODO.some((t) => t.id === id);
  const q = useApiQuery(['crawlCheckCounts', ctx.runId], () => api.getCrawlPages(ctx.runId, { limit: 1 }), { enabled: listed && !ctx.checkCounts });
  if (!listed) return null;
  const n = (ctx.checkCounts ?? q.data?.facets.check)?.[id];
  return (
    <p className="text-xs text-ink-soft" data-testid={`crawl-wide-${id}`}>
      {n === undefined ? (q.isError ? 'Pages of this crawl with the same finding could not be counted.' : 'Counting pages with the same finding…') : <>
        <span className="font-medium tabular-nums text-ink">{fmtNum(n)}</span> page{n === 1 ? '' : 's'} of this crawl have this finding{' '}
        <Link to={`/pages?run=${encodeURIComponent(ctx.runId)}&check=${encodeURIComponent(id)}`} className="text-signal hover:underline">List all {fmtNum(n)}</Link>
      </>}
    </p>
  );
}

/** Findings that open to details: every problem (fail / warn) and the notes whose details explain them. */
const INFO_WITH_DETAILS = new Set(['not-indexable', 'canonical-other', 'canonical-missing']);
export const hasDetails = (c: PageAuditCheck) => c.status === 'fail' || c.status === 'warn' || (c.status === 'info' && INFO_WITH_DETAILS.has(c.id));

/** Everything known about one finding: the affected page, the detected values and the related pages / images / links. */
export function CheckDetails({ check: c, ctx }: { check: PageAuditCheck; ctx: AuditContext }) {
  const body = specific(c, ctx);
  return (
    <div className="mt-2 space-y-2 rounded-ctl border border-line bg-canvas/60 p-2.5" data-testid={`details-${c.id}`}>
      <dl><KV k="Affected page"><ExtLink url={ctx.row.url} /></KV></dl>
      {body ?? ((c.value || c.items?.length) ? (
        <dl>
          {c.value && <KV k="Detected">{c.value}</KV>}
          {c.items?.length ? <KV k="Elements"><ul className="space-y-0.5">{c.items.map((x) => <li key={x} className="break-all font-mono text-[11.5px]">{/^https?:\/\//.test(x) ? <ExtLink url={x} /> : x}</li>)}</ul></KV> : null}
        </dl>
      ) : null)}
      <CrawlWide id={c.id} ctx={ctx} />
    </div>
  );
}
