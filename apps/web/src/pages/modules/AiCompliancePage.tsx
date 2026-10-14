import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2, FileText, ShieldAlert, XCircle } from 'lucide-react';
import { CHECKS_BY_ID, type AiComplianceFlag, type CustomRule, type RuleMethod } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { ModuleView } from '@/components/domain/ModuleView';
import { Async, Badge, Button, EmptyState, Notice, Panel, Tabs } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { SeverityBadge, SourceBadge } from '@/components/domain/badges';
import { CopyButton, NoAccess, PanelLink } from '@/components/modules/shared';
import { fmtDateTime, fmtRelative, shortUrl } from '@/lib/format';

export default function AiCompliancePage() {
  return (
    <ModuleView
      module="ai_compliance"
      description="Keeps AI-assisted publishing on the safe side of Google's spam policies and helpful-content guidance: 12 built-in checks, each mapped to the policy it protects, plus team-defined rules (PDF §10)."
      headerActions={<PanelLink to="/ai-compliance/rules">Custom rule builder</PanelLink>}
      extra={
        <div className="space-y-5">
          <Notice>Google does not penalise AI-generated content as such — it penalises content made primarily to manipulate rankings. These are Google policies, not laws, but they are treated as hard rules because violations cost rankings or bring manual actions.</Notice>
          <QaGatePanel />
          <FlagsPanel />
          <RulesPanel />
        </div>
      }
    />
  );
}

const flagsKey = ['ai-flags'];

// ---------------------------------------------------------------- QA gate
function QaGatePanel() {
  const q = useApiQuery(flagsKey, () => api.listAiFlags());
  const { can } = useAuth();
  const allowed = can('qa_gate.approve');
  const [pending, setPending] = useState<{ f: AiComplianceFlag; decision: 'approved' | 'rejected' } | null>(null);
  const m = useApiMutation((v: { id: string; decision: 'approved' | 'rejected'; note: string }) => api.decideQaHold(v.id, v.decision, v.note), {
    success: (f) => (f.qaHoldStatus === 'approved' ? 'Publish approved' : 'Publish rejected'),
    invalidate: [flagsKey, ['module', 'ai_compliance'], ['module', 'content'], ['audit']],
    onSuccess: () => setPending(null),
  });
  return (
    <Panel title="Publish QA gate" subtitle="Check #7 (YMYL caution gate) blocks new pages with health or safety claims until a person signs off" bodyClassName="p-0">
      <Async q={q} rows={3}>
        {(all) => {
          const held = all.filter((f) => f.qaHold);
          if (!held.length) return <EmptyState title="Nothing is held at the QA gate" description="Pages with unverified claims such as BPA-free, child-safe or shockproof will wait here for sign-off." />;
          return (
            <ul className="divide-y divide-line">
              {held.map((f) => (
                <li key={f.id} className="flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={f.qaHoldStatus === 'held' ? 'crit' : f.qaHoldStatus === 'approved' ? 'ok' : 'neutral'} icon={<ShieldAlert className="h-3 w-3" />}>{f.qaHoldStatus === 'held' ? 'Held' : f.qaHoldStatus === 'approved' ? 'Approved' : 'Rejected'}</Badge>
                      <span className="font-mono text-xs">{shortUrl(f.url)}</span>
                      <span className="text-xs capitalize text-muted">{f.template.replace('_', ' ')} · {f.ruleName}</span>
                    </div>
                    <blockquote className="mt-1.5 border-l-2 border-crit/50 pl-2 text-sm text-ink-soft"><mark className="rounded bg-crit-tint px-0.5 text-ink">{f.passage}</mark></blockquote>
                    {f.qaDecision && <p className="mt-1 text-xs text-muted">{f.qaHoldStatus === 'approved' ? 'Approved' : 'Rejected'} by {f.qaDecision.byName} · {fmtDateTime(f.qaDecision.at)} IST — "{f.qaDecision.note}"</p>}
                  </div>
                  {f.qaHoldStatus === 'held' && (
                    <div className="flex shrink-0 gap-1.5">
                      <Button size="sm" variant="primary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} disabled={!allowed} title={allowed ? undefined : 'Needs the qa_gate.approve permission'} onClick={() => setPending({ f, decision: 'approved' })}>Approve publish</Button>
                      <Button size="sm" icon={<XCircle className="h-3.5 w-3.5" />} disabled={!allowed} title={allowed ? undefined : 'Needs the qa_gate.approve permission'} onClick={() => setPending({ f, decision: 'rejected' })}>Reject</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          );
        }}
      </Async>
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending?.decision === 'approved' ? 'Approve publish?' : 'Reject publish?'}
        body={
          <>
            <p>This is the human sign-off required by check #7 (YMYL caution gate). It is recorded in the audit log with your name.</p>
            <p className="mt-2">{pending?.decision === 'approved' ? 'Only approve when the claim is backed by a verified source in product data (spec sheet, certificate, test report).' : 'The page stays unpublished; the Content team rewrites the claim or adds a verified source.'}</p>
          </>
        }
        reason="required"
        reasonMin={10}
        reasonLabel="What did you verify?"
        confirmLabel={pending?.decision === 'approved' ? 'Approve publish' : 'Reject publish'}
        danger={pending?.decision === 'rejected'}
        loading={m.isPending}
        onConfirm={(note) => pending && m.mutate({ id: pending.f.id, decision: pending.decision, note })}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------- flags
type FlagFilter = 'all' | 'critical' | 'custom';

function FlagsPanel() {
  const q = useApiQuery(flagsKey, () => api.listAiFlags());
  const [tab, setTab] = useState<FlagFilter>('all');
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash.startsWith('#flag-') || !q.data) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [hash, q.data]);
  return (
    <Panel title="Flags" subtitle="Each flag shows the exact offending passage, why it breaks policy and a human-quality rewrite draft to edit — Sentinel never edits the live page" bodyClassName="p-0">
      <Async q={q} rows={5}>
        {(all) => {
          const rows = all.filter((f) => (tab === 'all' ? true : tab === 'critical' ? f.severity === 'critical' : !f.checkId.startsWith('AIC-')));
          return (
            <>
              <Tabs<FlagFilter>
                className="px-2"
                value={tab}
                onChange={setTab}
                items={[
                  { value: 'all', label: 'All', count: all.length },
                  { value: 'critical', label: 'Critical', count: all.filter((f) => f.severity === 'critical').length },
                  { value: 'custom', label: 'Custom rules', count: all.filter((f) => !f.checkId.startsWith('AIC-')).length },
                ]}
              />
              {rows.length ? <ul className="divide-y divide-line">{rows.map((f) => <FlagItem key={f.id} f={f} highlighted={hash === `#flag-${f.id}`} />)}</ul> : <EmptyState title="No flags here" description="Pages that trip a built-in check or a custom rule appear in this list." />}
            </>
          );
        }}
      </Async>
    </Panel>
  );
}

function FlagItem({ f, highlighted }: { f: AiComplianceFlag; highlighted: boolean }) {
  const check = CHECKS_BY_ID[f.checkId];
  return (
    <li id={`flag-${f.id}`} className={`px-4 py-4 ${highlighted ? 'bg-signal-tint/40' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <span className="font-medium text-ink">{f.ruleName}</span>
        <span className="font-mono text-2xs text-faint">{f.checkId}</span>
        {f.qaHold && <Badge tone="crit" icon={<ShieldAlert className="h-3 w-3" />}>QA gate {f.qaHoldStatus ?? 'held'}</Badge>}
        <span className="ml-auto flex items-center gap-2"><span className="text-xs text-muted">{fmtRelative(f.detectedAt)}</span><SourceBadge source={f.source} /></span>
      </div>
      <p className="mt-1 text-xs text-muted">
        <a href={f.url} target="_blank" rel="noreferrer" className="font-mono text-signal hover:underline">{shortUrl(f.url)}</a>
        <span className="capitalize"> · {f.template.replace('_', ' ')}</span>
        {check?.policy && <> · <span className="text-opp-ink">Protects against: {check.policy}</span></>}
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-medium text-muted">Offending passage</p>
          <blockquote className="rounded-ctl border-l-2 border-crit bg-crit-tint/40 px-3 py-2 text-sm"><mark className="bg-transparent text-ink underline decoration-crit decoration-wavy underline-offset-4">{f.passage}</mark></blockquote>
          <p className="mt-1.5 text-xs text-ink-soft">{f.explanation}</p>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted">Rewrite draft (edit before publishing)</p>
            {f.rewrite && <CopyButton text={f.rewrite} label="Copy draft" />}
          </div>
          {f.rewrite
            ? <blockquote className="rounded-ctl border-l-2 border-ok bg-ok-tint/40 px-3 py-2 text-sm text-ink">{f.rewrite}</blockquote>
            : <p className="rounded-ctl border border-dashed border-line px-3 py-2 text-sm text-muted">No draft for this rule — its action is flag only.</p>}
        </div>
      </div>
      {f.issueId && (
        <div className="mt-2">
          <Link to={`/issues/${f.issueId}`} className="inline-flex items-center gap-1 text-sm text-signal hover:underline"><FileText className="h-3.5 w-3.5" aria-hidden /> Issue {f.issueId} and Fix Card</Link>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- custom rules
const METHOD_LABEL: Record<RuleMethod, string> = { regex: 'Pattern / regex', phrase_list: 'Phrase list', threshold: 'Threshold', llm_judged: 'LLM-judged' };
const ACTION_LABEL: Record<CustomRule['action'], string> = { flag: 'Flag only', flag_and_rewrite: 'Flag + draft rewrite', block_qa_gate: 'Block in QA gate' };

function RulesPanel() {
  const { can } = useAuth();
  const allowed = can('rules.view');
  const q = useApiQuery(['rules'], () => api.listRules(), { enabled: allowed });
  return (
    <Panel title="Custom rules" subtitle="Team-defined checks (PDF §10.2) run in the same pipeline as built-ins — same severities, Fix Cards, digest section and verification" actions={<PanelLink to="/ai-compliance/rules">{can('rules.manage') ? 'Build or edit rules' : 'Open rule builder'}</PanelLink>} bodyClassName="p-3">
      {!allowed ? <NoAccess what="Custom rules" perm="rules.view" /> : (
        <Async q={q} rows={4}>
          {(rows) => (
            <DataTable<CustomRule>
              rows={rows}
              rowKey={(r) => r.id}
              dense
              caption="Custom rules"
              empty={<EmptyState title="No custom rules yet" description="Add one in the rule builder, e.g. flag copy claiming the lowest price in India." action={<PanelLink to="/ai-compliance/rules">Rule builder</PanelLink>} />}
              columns={[
                { key: 'n', header: 'Rule', cell: (r) => <div className="min-w-[200px]"><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{r.description}</div></div> },
                { key: 'm', header: 'Method', width: '130px', cell: (r) => <span className="text-xs">{METHOD_LABEL[r.method]}</span> },
                { key: 'sev', header: 'Severity', width: '100px', hideOnMobile: true, cell: (r) => <SeverityBadge severity={r.severity} /> },
                { key: 'a', header: 'Action', width: '150px', hideOnMobile: true, cell: (r) => <span className="text-xs text-muted">{ACTION_LABEL[r.action]} · {r.schedule.replace('_', ' ')}</span> },
                { key: 'e', header: 'Status', width: '90px', cell: (r) => <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? 'Enabled' : 'Off'}</Badge> },
                {
                  key: 'd', header: 'Last dry run', width: '170px', hideOnMobile: true,
                  cell: (r) => !r.lastDryRun ? <span className="text-xs text-muted">Never run</span>
                    : !r.lastDryRun.evaluated ? <span className="text-xs text-med-ink" title={r.lastDryRun.note}>Not evaluated{r.lastDryRun.note ? ` — ${r.lastDryRun.note}` : ''}</span>
                    : <span className="text-xs"><span className="tabular-nums">{r.lastDryRun.pagesFlagged} / {r.lastDryRun.pagesScanned}</span> pages flagged<span className="block text-muted">{fmtRelative(r.lastDryRun.ranAt)}</span></span>,
                },
              ]}
            />
          )}
        </Async>
      )}
    </Panel>
  );
}
