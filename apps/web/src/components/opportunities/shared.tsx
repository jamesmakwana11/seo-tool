import { useState } from 'react';
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { type OpportunityItem, type SearchIntent, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Badge, Button, type Tone } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { shortUrl } from '@/lib/format';

// ------------------------------------------------------------------ labels

export const OPP_KIND_LABELS: Record<OpportunityItem['kind'], string> = {
  striking_distance: 'Striking distance',
  ctr_rewrite: 'CTR rewrite',
  content_brief: 'Content brief',
  keyword_gap: 'Keyword gap',
  link_prospect: 'Link prospect',
  brand_mention: 'Unlinked mention',
  paa_gap: 'PAA gap',
  snippet_target: 'Snippet target',
  seasonal: 'Seasonal',
  digital_pr: 'Digital PR',
  citation_gap: 'Citation gap',
};

/** Team that usually actions each opportunity class (pre-selected; the user can change it). */
export const OPP_KIND_TEAM: Record<OpportunityItem['kind'], TeamId> = {
  striking_distance: 'seo',
  ctr_rewrite: 'content',
  content_brief: 'content',
  keyword_gap: 'seo',
  link_prospect: 'seo',
  brand_mention: 'seo',
  paa_gap: 'content',
  snippet_target: 'content',
  seasonal: 'content',
  digital_pr: 'seo',
  citation_gap: 'content',
};

/** Screen that holds the full working view for each opportunity class. */
export const OPP_KIND_SCREEN: Record<OpportunityItem['kind'], { href: string; label: string }> = {
  striking_distance: { href: '/opportunities/keywords', label: 'Keyword research' },
  ctr_rewrite: { href: '/opportunities/keywords?tab=ctr', label: 'CTR rewrites' },
  content_brief: { href: '/opportunities/briefs', label: 'Content briefs' },
  keyword_gap: { href: '/opportunities/gaps', label: 'Keyword gaps' },
  link_prospect: { href: '/opportunities/link-building', label: 'Link building' },
  brand_mention: { href: '/opportunities/mentions', label: 'Brand mentions' },
  paa_gap: { href: '/opportunities/briefs', label: 'Content briefs' },
  snippet_target: { href: '/opportunities/keywords', label: 'Keyword research' },
  seasonal: { href: '/opportunities/seasonal', label: 'Seasonal planner' },
  digital_pr: { href: '/opportunities/link-building', label: 'Link building' },
  citation_gap: { href: '/opportunities/briefs', label: 'Content briefs' },
};

export const INTENT_LABELS: Record<SearchIntent, string> = {
  informational: 'Informational',
  commercial: 'Commercial',
  transactional: 'Transactional',
  navigational: 'Navigational',
};
const INTENT_TONE: Record<SearchIntent, Tone> = { informational: 'low', commercial: 'opp', transactional: 'signal', navigational: 'neutral' };
export function IntentBadge({ intent }: { intent: SearchIntent }) {
  return <Badge tone={INTENT_TONE[intent]}>{INTENT_LABELS[intent]}</Badge>;
}

const OPP_STATUS: Record<OpportunityItem['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'opp' },
  task_created: { label: 'Actioned', tone: 'signal' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
};
export function OppStatusBadge({ status }: { status: OpportunityItem['status'] }) {
  return <Badge tone={OPP_STATUS[status].tone}>{OPP_STATUS[status].label}</Badge>;
}

// ------------------------------------------------------------------ small display helpers

/** A site URL: absolute URLs open in a new tab, site paths render as monospace text. */
export function SiteUrl({ url, className }: { url?: string; className?: string }) {
  if (!url) return <span className="text-muted">—</span>;
  if (/^https?:\/\//.test(url)) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className={`inline-flex max-w-full items-center gap-1 font-mono text-[12.5px] text-signal hover:underline ${className ?? ''}`} title={url}>
        <span className="truncate">{shortUrl(url)}</span>
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    );
  }
  return <span className={`break-all font-mono text-[12.5px] ${className ?? ''}`}>{url}</span>;
}

export function YesNo({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return value ? (
    <span className="inline-flex items-center gap-1 text-xs text-ok-ink"><Check className="h-3.5 w-3.5" aria-hidden />{yes}</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-crit-ink"><X className="h-3.5 w-3.5" aria-hidden />{no}</span>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<Copy className="h-3.5 w-3.5" />}
      aria-label={label}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => toast.success('Copied to clipboard'), () => toast.error('Clipboard not available in this browser.'))}
    >
      Copy
    </Button>
  );
}

// ------------------------------------------------------------------ opportunity actions

/** Dismiss (confirm) for one opportunity. Opportunities are worked from the Fix Cards and pages they point to. */
export function OpportunityActions({ o, size = 'sm' }: { o: OpportunityItem; size?: 'sm' | 'md' }) {
  const { can } = useAuth();
  const [dismissOpen, setDismissOpen] = useState(false);
  const allowed = can('opportunities.manage');
  const why = allowed ? undefined : 'Your role does not have permission to manage opportunities (opportunities.manage).';
  const dismiss = useApiMutation(() => api.dismissOpportunity(o.id), { success: 'Opportunity dismissed', invalidate: [['opportunities']], onSuccess: () => setDismissOpen(false) });

  if (o.status === 'dismissed') return <span className="text-xs text-muted">Dismissed</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size={size} variant="ghost" disabled={!allowed} title={why} onClick={() => setDismissOpen(true)}>Dismiss</Button>
      <ConfirmDialog
        open={dismissOpen}
        onClose={() => setDismissOpen(false)}
        onConfirm={() => dismiss.mutate()}
        title="Dismiss opportunity"
        body={<>Dismiss <span className="font-medium text-ink">{o.title}</span>? It moves to the dismissed list and stops appearing in the open queue. The dismissal is recorded in the audit log.</>}
        confirmLabel="Dismiss"
        loading={dismiss.isPending}
      />
    </div>
  );
}
