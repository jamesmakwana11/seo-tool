import { useState, type ReactNode } from 'react';
import { Copy, ExternalLink, FileCode2, Globe, Image as ImageIcon, BarChart2, StickyNote, GitCompare, Quote, Link as LinkIcon, Server } from 'lucide-react';
import clsx from 'clsx';
import type { ActivityEvent, Evidence } from '@sentinel/shared';
import { Code, Mono } from '@/components/ui/primitives';
import { SourceBadge } from './badges';
import { fmtDateTime, shortUrl } from '@/lib/format';
import { useToast } from '@/components/ui/Toast';

export function UrlList({ urls, max = 8, title }: { urls: string[]; max?: number; title?: ReactNode }) {
  const [all, setAll] = useState(false);
  const toast = useToast();
  const shown = all ? urls : urls.slice(0, max);
  const copy = () => {
    void navigator.clipboard?.writeText(urls.join('\n')).then(() => toast.success(`Copied ${urls.length} URLs`), () => toast.error('Clipboard not available in this browser.'));
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{title ?? `${urls.length} affected URL${urls.length === 1 ? '' : 's'}`}</span>
        <button onClick={copy} className="inline-flex items-center gap-1 text-xs text-signal hover:underline"><Copy className="h-3 w-3" /> Copy all</button>
      </div>
      <ul className="divide-y divide-line rounded-ctl border border-line">
        {shown.map((u) => (
          <li key={u} className="flex items-center gap-2 px-2.5 py-1.5">
            <a href={u} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate hover:text-signal hover:underline" title={u}><Mono className="text-ink-soft">{shortUrl(u)}</Mono></a>
            <a href={u} target="_blank" rel="noreferrer noopener" className="text-faint hover:text-signal" aria-label={`Open ${u} in a new tab`}><ExternalLink className="h-3.5 w-3.5" /></a>
          </li>
        ))}
      </ul>
      {urls.length > max && <button className="mt-1.5 text-xs text-signal hover:underline" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${urls.length}`}</button>}
    </div>
  );
}

const EV_ICON: Record<Evidence['kind'], typeof Globe> = {
  http_response: Server, html_snippet: FileCode2, jsonld: FileCode2, screenshot: ImageIcon, field_data: BarChart2, metric: BarChart2, text_passage: Quote, diff: GitCompare, note: StickyNote, link: LinkIcon,
};

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (!evidence.length) return <p className="text-sm text-muted">No evidence captured.</p>;
  return (
    <ul className="space-y-3">
      {evidence.map((e) => {
        const Icon = EV_ICON[e.kind];
        const codey = ['http_response', 'html_snippet', 'jsonld', 'diff'].includes(e.kind);
        return (
          <li key={e.id} className="rounded-ctl border border-line p-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <Icon className="h-4 w-4 text-muted" aria-hidden />
              <span className="text-sm font-medium text-ink">{e.label}</span>
              <SourceBadge source={e.source} />
              <span className="ml-auto text-xs text-muted">{fmtDateTime(e.capturedAt)}</span>
            </div>
            {e.url && <div className="mb-1.5"><a href={e.url} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-signal hover:underline">{shortUrl(e.url)}</a></div>}
            <EvidenceUrls data={e.data} />
            {e.content && (codey ? <Code language={e.kind === 'jsonld' ? 'JSON-LD' : e.kind === 'http_response' ? 'HTTP' : e.kind === 'diff' ? 'diff' : 'HTML'}>{e.content}</Code> : e.kind === 'text_passage' ? <blockquote className="border-l-2 border-crit/60 bg-crit-tint/40 px-3 py-2 text-sm italic text-ink-soft">{e.content}</blockquote> : <p className="text-sm text-ink-soft">{e.content}</p>)}
          </li>
        );
      })}
    </ul>
  );
}

/** Evidence that names related pages (duplicate groups): the shared text, every page and the exact total. */
function EvidenceUrls({ data }: { data?: Record<string, unknown> }) {
  const urls = Array.isArray(data?.urls) ? (data!.urls as unknown[]).filter((u): u is string => typeof u === 'string') : [];
  if (!urls.length) return null;
  const total = typeof data!.total === 'number' ? data!.total : urls.length;
  const what = typeof data!.duplicateOf === 'string' ? data!.duplicateOf : undefined;
  return (
    <div className="mb-2" data-testid="evidence-urls">
      {what && typeof data!.text === 'string' && <p className="mb-1.5 text-sm text-ink-soft">Shared {what}: <span className="font-medium text-ink">"{data!.text}"</span> <span className="text-muted">({data!.text.length} characters)</span></p>}
      <UrlList urls={urls} max={10} title={`${total.toLocaleString('en-US')} page${total === 1 ? '' : 's'}${urls.length < total ? ` — first ${urls.length.toLocaleString('en-US')} listed here; the full list is on All pages` : ''}`} />
    </div>
  );
}

const ACT_DOT: Partial<Record<ActivityEvent['type'], string>> = {
  created: 'bg-signal', reallocated: 'bg-opp', review_rejected: 'bg-crit', blocker_added: 'bg-crit', verification_run: 'bg-ok', reopened: 'bg-med', sla_escalated: 'bg-crit', review_approved: 'bg-ok',
};

export function ActivityTimeline({ events }: { events: ActivityEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted">No activity yet.</p>;
  const list = [...events].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ol className="relative ml-1.5 border-l border-line">
      {list.map((e) => (
        <li key={e.id} className="relative pb-3 pl-4 last:pb-0">
          <span className={clsx('absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface', ACT_DOT[e.type] ?? 'bg-line-strong')} aria-hidden />
          <div className="text-sm text-ink">{e.message}</div>
          <div className="text-xs text-muted">{e.actorName} · {fmtDateTime(e.at)}</div>
        </li>
      ))}
    </ol>
  );
}
