import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import type { ContentBrief } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Button, EmptyState, Field, Input, PageHeader } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/overlay';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ChipGroup, ClearFilters, useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { IntentBadge } from '@/components/opportunities/shared';
import { BRIEF_STATUS, BriefStatusBadge, ORIGIN_LABELS, PAGE_TYPE_LABELS } from '@/components/opportunities/briefLabels';
import { fmtDate, fmtRelative } from '@/lib/format';

const KEYS = ['status'] as const;

export default function BriefsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const q = useApiQuery(['briefs'], () => api.listBriefs());
  const allowed = can('opportunities.manage');
  return (
    <div>
      <PageHeader
        title="Content briefs"
        description="Briefs generated from approved keyword gaps, PAA gaps, citation gaps and the seasonal planner — target keyword, cluster, intent, suggested URL and type, outline, entities, FAQs and internal links (PDF §13)."
        actions={
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} disabled={!allowed} title={allowed ? undefined : 'Your role does not have permission to manage opportunities (opportunities.manage).'} onClick={() => setCreating(true)}>
            New brief
          </Button>
        }
      />
      <Async q={q} rows={8}>{(briefs) => <BriefTable briefs={briefs} />}</Async>
      {creating && <NewBriefDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function BriefTable({ briefs }: { briefs: ContentBrief[] }) {
  const f = useUrlFilters(KEYS);
  const nav = useNavigate();
  const status = f.getList('status') as ContentBrief['status'][];
  const rows = briefs.filter((b) => !status.length || status.includes(b.status));
  const columns: Column<ContentBrief>[] = [
    {
      key: 'title', header: 'Title', sort: (a, b) => a.title.localeCompare(b.title),
      cell: (b) => (
        <div className="min-w-[180px]">
          <Link to={`/opportunities/briefs/${b.id}`} className="font-medium text-ink hover:text-signal hover:underline" onClick={(e) => e.stopPropagation()}>{b.title}</Link>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted"><span className="font-mono">{b.id}</span><SourceBadge source={b.source} /></div>
        </div>
      ),
    },
    { key: 'keyword', header: 'Target keyword', cell: (b) => b.targetKeyword, sort: (a, b) => a.targetKeyword.localeCompare(b.targetKeyword) },
    { key: 'cluster', header: 'Cluster', cell: (b) => b.cluster, sort: (a, b) => a.cluster.localeCompare(b.cluster), hideOnMobile: true },
    { key: 'intent', header: 'Intent', cell: (b) => <IntentBadge intent={b.intent} />, hideOnMobile: true },
    { key: 'type', header: 'Page type', cell: (b) => PAGE_TYPE_LABELS[b.pageType], sort: (a, b) => a.pageType.localeCompare(b.pageType), hideOnMobile: true },
    { key: 'origin', header: 'Origin', cell: (b) => <span className="text-xs">{ORIGIN_LABELS[b.origin]}{b.originRef && <span className="ml-1 font-mono text-muted">{b.originRef}</span>}</span>, hideOnMobile: true },
    { key: 'status', header: 'Status', cell: (b) => <BriefStatusBadge status={b.status} />, sort: (a, b) => a.status.localeCompare(b.status) },
    { key: 'updated', header: 'Updated', cell: (b) => <span className="whitespace-nowrap text-xs text-muted" title={fmtDate(b.updatedAt)}>{fmtRelative(b.updatedAt)}</span>, sort: (a, b) => a.updatedAt.localeCompare(b.updatedAt) },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(b) => b.id}
      onRowClick={(b) => nav(`/opportunities/briefs/${b.id}`)}
      search={(b) => `${b.id} ${b.title} ${b.targetKeyword} ${b.cluster}`}
      searchPlaceholder="Search briefs"
      initialSort={{ key: 'updated', dir: 'desc' }}
      caption="Content briefs"
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <ChipGroup label="Status" value={status} onChange={(v) => f.set('status', v)} options={(Object.keys(BRIEF_STATUS) as ContentBrief['status'][]).map((s) => ({ value: s, label: `${BRIEF_STATUS[s].label} (${briefs.filter((b) => b.status === s).length})` }))} />
          <ClearFilters show={f.active} onClear={f.clear} />
        </div>
      }
      empty={<EmptyState title={status.length ? 'No briefs with this status' : 'No content briefs yet'} description={status.length ? 'Clear the status filter to see every brief.' : 'Approve a keyword gap and choose "Generate brief", or create one manually with "New brief".'} />}
    />
  );
}

function NewBriefDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [keyword, setKeyword] = useState('');
  const [touched, setTouched] = useState(false);
  const errs = { title: title.trim() ? undefined : 'Enter a working title.', keyword: keyword.trim() ? undefined : 'Enter the target keyword.' };
  const m = useApiMutation((b: ContentBrief) => api.saveBrief(b), {
    success: (b) => `Brief ${b.id} created`,
    invalidate: [['briefs']],
    onSuccess: (b) => nav(`/opportunities/briefs/${b.id}`),
  });
  const submit = () => {
    setTouched(true);
    if (errs.title || errs.keyword) return;
    const kw = keyword.trim().toLowerCase();
    m.mutate({
      id: '', title: title.trim(), targetKeyword: kw, cluster: 'General', intent: 'informational',
      suggestedUrl: `/blogs/news/${kw.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`, pageType: 'blog',
      outline: [], entities: [], faqs: [], internalLinks: [], origin: 'manual', status: 'draft', updatedAt: new Date().toISOString(), source: 'manual',
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New brief"
      size="sm"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={submit}>Create draft brief</Button></>}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">Creates a draft brief and opens it in the editor, where you add the outline, entities, FAQs and internal links.</p>
        <Field label="Working title" htmlFor="nb-title" required error={touched ? errs.title : undefined}>
          <Input id="nb-title" data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={touched && !!errs.title} />
        </Field>
        <Field label="Target keyword" htmlFor="nb-kw" required error={touched ? errs.keyword : undefined} hint="The suggested URL is derived from this; you can change it in the editor.">
          <Input id="nb-kw" value={keyword} onChange={(e) => setKeyword(e.target.value)} aria-invalid={touched && !!errs.keyword} />
        </Field>
      </div>
    </Dialog>
  );
}
