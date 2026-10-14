import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { CHECKS_BY_ID, type Exclusion, type Issue } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, DemoBadge, EmptyState, Mono, Notice, PageHeader, Panel, ProgressBar } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { SeverityBadge } from '@/components/domain/badges';
import { fmtDateTime, fmtNum, fmtPct } from '@/lib/format';

const FP_TARGET_PCT = 5; // PDF acceptance criteria: <5% false positives on Criticals

export default function ExclusionsPage() {
  return (
    <div>
      <PageHeader
        title="Exclusions & false positives"
        description="False-positive feedback (PDF §17): every Fix Card has “Not an issue” with a reason, and the classifier learns exclusions — for example intentionally noindexed pages."
        meta={<DemoBadge />}
      />
      <div className="space-y-5">
        <FalsePositiveRate />
        <ExclusionsPanel />
        <NotAnIssuePanel />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ false-positive rate

function FalsePositiveRate() {
  // All critical issues ever detected (every status, including superseded) vs. those marked Not an issue.
  const all = useApiQuery(['issues', 'fp-rate', 'all-critical'], () => api.listIssues({ severity: ['critical'], includeSuperseded: true, pageSize: 1 }));
  const nai = useApiQuery(['issues', 'fp-rate', 'nai-critical'], () => api.listIssues({ severity: ['critical'], status: ['NOT_AN_ISSUE'], includeSuperseded: true, pageSize: 1 }));
  const q = {
    data: all.data && nai.data ? { total: all.data.total, fp: nai.data.total } : undefined,
    isLoading: all.isLoading || nai.isLoading,
    error: all.error ?? nai.error,
    refetch: () => { void all.refetch(); void nai.refetch(); },
  };
  return (
    <Panel title="False-positive rate on Criticals" subtitle="Critical issues marked Not an issue ÷ all Critical issues ever detected" actions={<DemoBadge />}>
      <Async q={q} rows={2}>
        {({ total, fp }) => {
          const pct = total ? (fp / total) * 100 : 0;
          const ok = pct < FP_TARGET_PCT;
          return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
              <div>
                <div className={`text-3xl font-semibold tabular-nums ${total === 0 ? 'text-muted' : ok ? 'text-ok-ink' : 'text-crit-ink'}`}>{total ? fmtPct(pct, 1) : '—'}</div>
                <div className="text-xs text-muted">{fmtNum(fp)} of {fmtNum(total)} Criticals</div>
              </div>
              <div className="space-y-2">
                <ProgressBar value={Math.min(100, Math.round((pct / (FP_TARGET_PCT * 2)) * 100))} tone={ok ? 'ok' : 'crit'} label={`False-positive rate ${pct.toFixed(1)}% against a ${FP_TARGET_PCT}% target`} />
                <p className="text-sm text-ink-soft">
                  Target: <strong>below {FP_TARGET_PCT}%</strong> (PDF acceptance criteria for the daily digest).{' '}
                  {total === 0 ? 'No Critical issues detected yet.' : ok ? 'Within target.' : 'Above target — review the reasons below and tighten the checks or add exclusions.'}
                </p>
                <p className="text-xs text-muted">Bar scale: full width = {FP_TARGET_PCT * 2}%. Computed from DEMO issues in this session.</p>
              </div>
            </div>
          );
        }}
      </Async>
    </Panel>
  );
}

// ------------------------------------------------------------------ exclusions

function ExclusionsPanel() {
  const { can } = useAuth();
  const q = useApiQuery(['exclusions'], () => api.listExclusions());
  const [removing, setRemoving] = useState<Exclusion | null>(null);
  const m = useApiMutation((id: string) => api.removeExclusion(id), { success: 'Exclusion removed', invalidate: [['exclusions'], ['issues'], ['audit']], onSuccess: () => setRemoving(null) });
  const allowed = can('issues.manage_exclusions');
  return (
    <Panel title="Active exclusions" subtitle="Future runs of the check skip URLs that match the pattern" bodyClassName="p-3">
      {!allowed && <div className="mb-3"><Notice>Your role can view exclusions but not remove them (needs issues.manage_exclusions).</Notice></div>}
      <Async q={q} rows={4}>
        {(list) => (
          <DataTable
            rows={list}
            rowKey={(e) => e.id}
            search={(e) => `${e.urlPattern} ${e.checkId ?? ''} ${e.reason} ${e.createdByName}`}
            searchPlaceholder="Search pattern, check or reason"
            caption="Exclusions"
            initialSort={{ key: 'at', dir: 'desc' }}
            empty={<EmptyState title="No exclusions" description="Exclusions are added when someone marks an issue “Not an issue” and chooses to exclude the affected URLs." />}
            columns={[
              { key: 'check', header: 'Check', cell: (e) => (e.checkId ? <div><div className="text-sm">{CHECKS_BY_ID[e.checkId]?.name ?? e.checkId}</div><Mono className="text-2xs text-muted">{e.checkId}</Mono></div> : <Badge>All checks</Badge>) },
              { key: 'pattern', header: 'URL pattern', cell: (e) => <Mono className="break-all">{e.urlPattern}</Mono> },
              { key: 'reason', header: 'Reason', cell: (e) => <span className="block min-w-[180px] text-xs">{e.reason}</span> },
              { key: 'by', header: 'Created by', hideOnMobile: true, cell: (e) => <span className="text-xs">{e.createdByName}</span> },
              { key: 'at', header: 'When (IST)', hideOnMobile: true, cell: (e) => <span className="whitespace-nowrap text-xs">{fmtDateTime(e.createdAt)}</span>, sort: (a, b) => a.createdAt.localeCompare(b.createdAt) },
              {
                key: 'act', header: 'Action', cell: (e) => (
                  <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={!allowed} title={allowed ? undefined : 'Your role cannot remove exclusions'} onClick={() => setRemoving(e)} aria-label={`Remove exclusion ${e.urlPattern}`}>Remove</Button>
                ),
              },
            ]}
          />
        )}
      </Async>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this exclusion?"
        body={removing && <>{removing.checkId ? <>The check <strong>{CHECKS_BY_ID[removing.checkId]?.name ?? removing.checkId}</strong></> : 'Every check'} will evaluate <Mono>{removing.urlPattern}</Mono> again on the next crawl, and may raise issues for it. The removal is recorded in the audit log.</>}
        confirmLabel="Remove exclusion"
        danger
        loading={m.isPending}
        onConfirm={() => removing && m.mutate(removing.id)}
      />
    </Panel>
  );
}

// ------------------------------------------------------------------ not-an-issue list

function NotAnIssuePanel() {
  const q = useApiQuery(['issues', 'not-an-issue'], () => api.listIssues({ status: ['NOT_AN_ISSUE'], sort: 'detected', dir: 'desc', pageSize: 200 }));
  return (
    <Panel title="Issues marked Not an issue" subtitle="Reasons feed the false-positive review. Reopen an issue from its detail page if it was dismissed by mistake." bodyClassName="p-3">
      <Async q={q} rows={4}>
        {(p) => (
          <>
          {p.total > p.items.length && <p className="mb-2 text-xs text-muted">Showing the {p.items.length} most recent of {fmtNum(p.total)}.</p>}
          <DataTable<Issue>
            rows={p.items}
            rowKey={(i) => i.id}
            search={(i) => `${i.id} ${i.title} ${i.notAnIssue?.reason ?? ''} ${i.notAnIssue?.byName ?? ''}`}
            searchPlaceholder="Search issues or reasons"
            caption="Issues marked not an issue"
            initialSort={{ key: 'at', dir: 'desc' }}
            empty={<EmptyState title="Nothing marked Not an issue" description="When someone dismisses a finding as a false positive it appears here with their reason." />}
            columns={[
              { key: 'sev', header: 'Severity', cell: (i) => <SeverityBadge severity={i.severity} /> },
              { key: 'issue', header: 'Issue', cell: (i) => <div className="min-w-[220px]"><Link to={`/issues/${i.id}`} className="font-medium text-ink hover:text-signal hover:underline">{i.title}</Link><div className="text-xs text-muted"><span className="font-mono">{i.id}</span> · {CHECKS_BY_ID[i.checkId]?.name ?? i.checkId}</div></div> },
              { key: 'reason', header: 'Reason', cell: (i) => <span className="block min-w-[180px] text-xs">{i.notAnIssue?.reason ?? '—'}{i.notAnIssue?.excluded && <Badge className="ml-1" tone="signal">Exclusion added</Badge>}</span> },
              { key: 'by', header: 'Marked by', hideOnMobile: true, cell: (i) => <span className="text-xs">{i.notAnIssue?.byName ?? '—'}</span> },
              { key: 'at', header: 'When (IST)', hideOnMobile: true, cell: (i) => <span className="whitespace-nowrap text-xs">{fmtDateTime(i.notAnIssue?.at)}</span>, sort: (a, b) => (a.notAnIssue?.at ?? '').localeCompare(b.notAnIssue?.at ?? '') },
            ]}
          />
          </>
        )}
      </Async>
    </Panel>
  );
}
