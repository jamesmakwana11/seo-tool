import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCheck, RotateCcw, ThumbsDown, Layers, Play, Wrench, ShieldCheck } from 'lucide-react';
import { CHECKS_BY_ID, MODULE_LABELS, type IssueDetail } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { DetailError } from '@/components/domain/DetailError';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Checkbox, Field, KV, Notice, Panel, Tabs, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { FixCardView } from '@/components/domain/FixCardView';
import { AllocationTrail } from '@/components/domain/allocation';
import { DeltaBadge, IssueStatusBadge, SeverityBadge, SlaCountdown, SourceBadge, TeamBadge, TierBadge } from '@/components/domain/badges';
import { EvidenceList, UrlList } from '@/components/domain/lists';
import { fmtDateTime } from '@/lib/format';

type Tab = 'fix' | 'evidence' | 'history' | 'children';

export default function IssueDetailPage() {
  const { id = '' } = useParams();
  const q = useApiQuery(['issue', id], () => api.getIssue(id));
  if (q.error) return <DetailError error={q.error} what="Issue" id={id} back={{ to: '/issues', label: 'Back to the issues board' }} onRetry={() => q.refetch()} />;
  return <Async q={q} rows={10}>{(d) => <Detail d={d} />}</Async>;
}

function Detail({ d }: { d: IssueDetail }) {
  const { issue, fixCard } = d;
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('fix');
  const [nai, setNai] = useState(false);
  const [reopen, setReopen] = useState(false);
  const check = CHECKS_BY_ID[issue.checkId];
  const done = ['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE', 'SUPERSEDED', 'FIXED'].includes(issue.status);
  const inv = [['issue', issue.id], ['issues'], ['dashboard'], ['digest'], ['verifications']];
  const ack = useApiMutation(() => api.acknowledgeIssue(issue.id), { success: 'Acknowledged', invalidate: inv });
  const reopenM = useApiMutation((r: string) => api.reopenIssue(issue.id, r), { success: 'Issue reopened', invalidate: inv, onSuccess: () => setReopen(false) });

  return (
    <div>
      <div className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <SeverityBadge severity={issue.severity} />
          <IssueStatusBadge status={issue.status} />
          <TierBadge tier={issue.highestTier} />
          <DeltaBadge delta={issue.delta} />
          <SourceBadge source={issue.source} />
          {issue.isTemplateGroup && <Badge tone="opp" icon={<Layers className="h-3 w-3" />}>Template-level · {issue.childIssueIds?.length} child issues</Badge>}
          {issue.supersededById && <Badge tone="neutral">Superseded by <Link className="ml-1 underline" to={`/issues/${issue.supersededById}`}>{issue.supersededById}</Link></Badge>}
        </div>
        <h1 className="text-[22px] font-semibold leading-tight">{issue.title}</h1>
        <p className="mt-1 text-sm text-muted">
          <span className="font-mono">{issue.id}</span> · {MODULE_LABELS[issue.module]} · {check.name} ({check.id}, PDF p{check.pdfRef.page} §{check.pdfRef.section}) · detected {fmtDateTime(issue.detectedAt)} IST
        </p>
      </div>

      {issue.status === 'FIXED' && <div className="mb-4"><Notice tone="med" title="Fixed — awaiting automated re-verification">Someone marked this fixed. It becomes Verified only when a system re-check finds 0 failing URLs — marking it fixed never verifies it.</Notice></div>}
      {issue.notAnIssue && <div className="mb-4"><Notice title={`Marked "Not an issue" by ${issue.notAnIssue.byName}`}>{issue.notAnIssue.reason}{issue.notAnIssue.excluded && ' · Exclusion added so the classifier skips these URLs.'}</Notice></div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          <Panel bodyClassName="p-3">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="flex flex-wrap gap-2">
                {!issue.acknowledgedBy && !done && <Button size="sm" icon={<CheckCheck className="h-4 w-4" />} loading={ack.isPending} onClick={() => ack.mutate()}>Acknowledge</Button>}
                {can('issues.mark_not_issue') && !['NOT_AN_ISSUE', 'CLOSED', 'VERIFIED', 'SUPERSEDED'].includes(issue.status) && <Button size="sm" icon={<ThumbsDown className="h-4 w-4" />} onClick={() => setNai(true)}>Not an issue</Button>}
                {can('issues.allocate') && ['NOT_AN_ISSUE', 'CLOSED', 'VERIFIED'].includes(issue.status) && <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setReopen(true)}>Reopen</Button>}
              </div>
            </div>
            {issue.acknowledgedBy && <p className="mt-2 text-xs text-muted">Acknowledged by {issue.acknowledgedBy.name} · {fmtDateTime(issue.acknowledgedBy.at)}</p>}
          </Panel>

          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            items={[
              { value: 'fix', label: 'Fix Card' },
              { value: 'evidence', label: 'Evidence & URLs', count: issue.affectedCount },
              { value: 'history', label: 'History', count: issue.allocation.length + issue.severityHistory.length + d.verification.length },
              ...(d.children?.length ? [{ value: 'children' as Tab, label: 'Child issues', count: d.children.length }] : []),
            ]}
          />
          {tab === 'fix' && <Panel bodyClassName="p-5"><FixCardView card={fixCard} issue={issue} done={done} /></Panel>}
          {tab === 'evidence' && (
            <div className="space-y-5">
              <Panel title="Evidence"><EvidenceList evidence={issue.evidence} /></Panel>
              <Panel title="Affected URLs" subtitle={`Tier 1: ${issue.tierBreakdown[1]} · Tier 2: ${issue.tierBreakdown[2]} · Tier 3: ${issue.tierBreakdown[3]}`}><UrlList urls={issue.affectedUrls} max={25} /></Panel>
            </div>
          )}
          {tab === 'history' && (
            <div className="space-y-5">
              <Panel title="Severity & escalation history">
                {issue.severityHistory.length ? (
                  <ul className="space-y-2 text-sm">{issue.severityHistory.map((h, i) => <li key={i}><Badge tone="crit">{h.from} → {h.to}</Badge> <span className="ml-1">{h.reason}</span> <span className="text-xs text-muted">· {h.rule.replace('_', ' ')} · {fmtDateTime(h.at)}</span></li>)}</ul>
                ) : <p className="text-sm text-muted">No escalations. Severity: {issue.severityRationale}</p>}
              </Panel>
              <Panel title="Allocation trail" subtitle="Who allocated → which team → when (PDF §11.1a)"><AllocationTrail events={issue.allocation} /></Panel>
              <Panel title="Verification attempts" bodyClassName="p-3">
                <DataTable rows={d.verification} rowKey={(v) => v.id} dense empty={<p className="p-4 text-sm text-muted">No verification has run yet.</p>} columns={[
                  { key: 'at', header: 'When', cell: (v) => fmtDateTime(v.at) },
                  { key: 'm', header: 'Method', cell: (v) => v.method.replace(/_/g, ' ') },
                  { key: 'o', header: 'Outcome', cell: (v) => <Badge tone={v.outcome === 'passed' ? 'ok' : v.outcome === 'failed' ? 'crit' : 'neutral'}>{v.outcome.replace('_', ' ')}</Badge> },
                  { key: 'd', header: 'Details', cell: (v) => <span className="text-xs">{v.details}</span> },
                  { key: 's', header: 'Source', cell: (v) => <SourceBadge source={v.source} /> },
                ]} />
              </Panel>
              <Panel title="Audit log" bodyClassName="p-3">
                <DataTable rows={[...d.audit].reverse()} rowKey={(a) => a.id} dense columns={[
                  { key: 'at', header: 'When', cell: (a) => <span className="whitespace-nowrap text-xs">{fmtDateTime(a.at)}</span> },
                  { key: 'who', header: 'Actor', cell: (a) => a.actorName },
                  { key: 'what', header: 'Action', cell: (a) => <span className="font-mono text-xs">{a.action}</span> },
                  { key: 'sum', header: 'Summary', cell: (a) => <span className="text-xs">{a.summary}</span> },
                ]} />
              </Panel>
            </div>
          )}
          {tab === 'children' && d.children && (
            <Panel title="Child issues superseded by this template-level fix" subtitle="One template fix supersedes the page-level cards (PDF §11.2)." bodyClassName="p-0">
              <ul className="divide-y divide-line">{d.children.map((c) => <li key={c.id}><Link to={`/issues/${c.id}`} className="flex items-center gap-3 px-4 py-2 hover:bg-raised"><span className="font-mono text-xs text-muted">{c.id}</span><span className="flex-1 text-sm">{c.title}</span><span className="text-xs text-muted">{c.affectedCount} URLs</span><IssueStatusBadge status={c.status} /></Link></li>)}</ul>
            </Panel>
          )}
        </div>

        <aside className="space-y-5">
          <Panel title="Summary">
            <KV cols={1} items={[
              { k: 'Severity rationale', v: issue.severityRationale },
              { k: 'Business impact', v: issue.businessImpact },
              { k: 'SLA', v: <SlaCountdown dueAt={issue.slaDueAt} done={done} /> },
              { k: 'Recommended team', v: <TeamBadge team={issue.recommendedTeam} /> },
              { k: 'Allocated team', v: <TeamBadge team={issue.allocatedTeam} /> },
              { k: 'Occurrences', v: `${issue.occurrences} (first seen ${fmtDateTime(issue.firstSeenAt)})` },
            ]} />
          </Panel>
          <IssueWorkflow d={d} />
          <Panel title="Allocation trail"><AllocationTrail events={issue.allocation} /></Panel>
        </aside>
      </div>

      <NotAnIssueDialog open={nai} onClose={() => setNai(false)} issueId={issue.id} urlCount={issue.affectedCount} />
      <ConfirmDialog open={reopen} onClose={() => setReopen(false)} title={`Reopen ${issue.id}?`} body="Use this when the problem has regressed or was dismissed by mistake. It returns to the team it was allocated to." reason="required" reasonLabel="Why reopen?" confirmLabel="Reopen issue" loading={reopenM.isPending} onConfirm={(r) => reopenM.mutate(r)} />
    </div>
  );
}

/** Issue-level workflow: Assigned → In progress → Fixed → (system re-check) → Verified. */
function IssueWorkflow({ d }: { d: IssueDetail }) {
  const { issue, verification } = d;
  const { can, user } = useAuth();
  const [fixOpen, setFixOpen] = useState(false);
  const [note, setNote] = useState('');
  const inv = [['issue', issue.id], ['issues'], ['dashboard'], ['digest'], ['verifications'], ['notifications']];
  const status = useApiMutation((v: { action: 'start' | 'mark_fixed'; note?: string }) => api.updateIssueStatus(issue.id, v.action, v.note), {
    success: (r) => (r.issue.status === 'FIXED' ? 'Marked fixed — awaiting system re-verification' : 'Work started'),
    invalidate: inv,
    onSuccess: () => { setFixOpen(false); setNote(''); },
  });
  const verify = useApiMutation(() => api.verifyIssue(issue.id), {
    success: (r) => (r.attempt.outcome === 'passed' ? 'Re-check passed — issue verified' : r.attempt.outcome === 'failed' ? `Re-check failed: ${r.attempt.failingUrls} URL(s) still failing — back to In progress` : 'No data to re-check yet — the issue stays Fixed'),
    invalidate: inv,
  });
  const onTeam = !!issue.allocatedTeam && (user?.role !== 'developer' || user.teamIds.includes(issue.allocatedTeam));
  const canUpdate = can('issues.update_status') && onTeam;
  const last = verification.at(-1);
  const steps = ['ASSIGNED', 'IN_PROGRESS', 'FIXED', 'VERIFIED'] as const;
  const at = steps.indexOf(issue.status as (typeof steps)[number]);
  return (
    <Panel title="Workflow" subtitle="Fixed is never Verified until the system re-check passes">
      <ol className="mb-4 grid grid-cols-4 gap-1" aria-label="Issue progress">
        {steps.map((st, i) => (
          <li key={st} className="min-w-0">
            <div className={`h-1 rounded-full ${at >= i ? (st === 'VERIFIED' ? 'bg-ok' : 'bg-signal') : 'bg-line'}`} />
            <span className={`mt-1 block truncate text-2xs ${at === i ? 'font-semibold text-ink' : 'text-muted'}`}>{st === 'IN_PROGRESS' ? 'In progress' : st.charAt(0) + st.slice(1).toLowerCase()}</span>
          </li>
        ))}
      </ol>
      {!issue.allocatedTeam && !['NOT_AN_ISSUE', 'SUPERSEDED', 'VERIFIED', 'CLOSED'].includes(issue.status) ? (
        <p className="text-sm text-muted">Not allocated to a team. The next crawl still re-checks it; Start work and Mark fixed appear once a team is allocated (Criticals left unallocated are allocated automatically).</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {issue.status === 'ASSIGNED' && <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} disabled={!canUpdate} title={canUpdate ? undefined : 'Only the allocated team or an SEO specialist can update this issue.'} loading={status.isPending} onClick={() => status.mutate({ action: 'start' })}>Start work</Button>}
          {(issue.status === 'ASSIGNED' || issue.status === 'IN_PROGRESS') && <Button size="sm" variant="primary" icon={<Wrench className="h-3.5 w-3.5" />} disabled={!canUpdate} title={canUpdate ? undefined : 'Only the allocated team or an SEO specialist can update this issue.'} onClick={() => setFixOpen(true)}>Mark fixed</Button>}
          {issue.status === 'FIXED' && <Button size="sm" variant="primary" icon={<ShieldCheck className="h-3.5 w-3.5" />} disabled={!can('issues.verify')} title={can('issues.verify') ? undefined : 'Your role cannot trigger re-verification (issues.verify).'} loading={verify.isPending} onClick={() => verify.mutate()}>Run re-verification</Button>}
          {['VERIFIED', 'CLOSED'].includes(issue.status) && <p className="text-sm text-ok-ink">Verified by a system re-check.</p>}
        </div>
      )}
      {last && <p className="mt-3 text-xs text-muted">Last re-check: <span className="font-medium text-ink-soft">{last.outcome.replace('_', ' ')}</span> · {fmtDateTime(last.at)} IST{last.source === 'simulated' ? ' · SIMULATED' : ''}</p>}
      <Dialog
        open={fixOpen}
        onClose={() => setFixOpen(false)}
        title={`Mark ${issue.id} fixed`}
        size="sm"
        footer={<><Button onClick={() => setFixOpen(false)}>Cancel</Button><Button variant="primary" loading={status.isPending} onClick={() => status.mutate({ action: 'mark_fixed', note })}>Mark fixed</Button></>}
      >
        <p className="mb-3 text-sm text-muted">The issue moves to Fixed and waits for a system re-check. It is not verified until that re-check finds 0 failing URLs.</p>
        <Field label="What was changed?" htmlFor="fix-note" hint="Optional, but recorded on the issue for reviewers.">
          <Textarea id="fix-note" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Removed the duplicate canonical tag from theme.liquid" />
        </Field>
      </Dialog>
    </Panel>
  );
}

function NotAnIssueDialog({ open, onClose, issueId, urlCount }: { open: boolean; onClose: () => void; issueId: string; urlCount: number }) {
  const [reason, setReason] = useState('');
  const [exclude, setExclude] = useState(true);
  const [touched, setTouched] = useState(false);
  const m = useApiMutation(() => api.markNotAnIssue(issueId, reason, exclude), { success: 'Marked as not an issue', invalidate: [['issue', issueId], ['issues'], ['dashboard'], ['exclusions'], ['tasks']], onSuccess: onClose });
  const invalid = reason.trim().length < 5;
  return (
    <Dialog open={open} onClose={onClose} title="Mark as not an issue" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => { setTouched(true); if (!invalid) m.mutate(); }}>Mark not an issue</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-soft">False-positive feedback (PDF §17). Your reason is logged and used to learn exclusions — e.g. intentionally noindexed pages.</p>
        <Field label="Reason" required htmlFor="nai-reason" error={touched && invalid ? 'At least 5 characters.' : undefined}>
          <Textarea id="nai-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={touched && invalid} />
        </Field>
        <Checkbox checked={exclude} onChange={setExclude} label={`Add exclusion for ${Math.min(20, urlCount)} affected URL${urlCount === 1 ? '' : 's'}`} description="Future runs of this check skip these paths." />
      </div>
    </Dialog>
  );
}
