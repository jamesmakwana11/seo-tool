import type { ContentBrief } from '@sentinel/shared';
import { Badge, type Tone } from '@/components/ui/primitives';

export const PAGE_TYPE_LABELS: Record<ContentBrief['pageType'], string> = {
  collection: 'Collection',
  blog: 'Blog post',
  buying_guide: 'Buying guide',
  landing_page: 'Landing page',
  faq: 'FAQ',
};

export const ORIGIN_LABELS: Record<ContentBrief['origin'], string> = {
  keyword_gap: 'Keyword gap',
  paa_gap: 'PAA gap',
  seasonal: 'Seasonal planner',
  citation_gap: 'Citation gap',
  manual: 'Manual',
  intent_mismatch: 'Intent mismatch',
};

export const BRIEF_STATUS: Record<ContentBrief['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  approved: { label: 'Approved', tone: 'signal' },
  in_production: { label: 'In production', tone: 'med' },
  published: { label: 'Published', tone: 'ok' },
};

export function BriefStatusBadge({ status }: { status: ContentBrief['status'] }) {
  return <Badge tone={BRIEF_STATUS[status].tone}>{BRIEF_STATUS[status].label}</Badge>;
}
