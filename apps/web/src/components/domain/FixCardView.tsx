import { useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, ClipboardCopy, Clock, FileWarning, Lightbulb, MapPin, Repeat, ShieldCheck, Target, Wand2 } from 'lucide-react';
import { TEAMS, type FixCard, type Issue } from '@sentinel/shared';
import { Badge, Button, Code, KV, Notice } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { api } from '@/api/client';
import { useApiMutation } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { SeverityBadge, SlaCountdown, TierBadge } from './badges';
import { EvidenceList, UrlList } from './lists';

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">{icon}{title}</h3>
      {children}
    </section>
  );
}

/** Fix Card (PDF §11.1) — what the team sees for every issue. */
export function FixCardView({ card, issue, done }: { card: FixCard; issue: Issue; done?: boolean }) {
  const toast = useToast();
  const { can } = useAuth();
  const [approve, setApprove] = useState(false);
  const approveM = useApiMutation((note: string) => api.approveProposal(issue.id, note), { success: 'Approval recorded in the audit log. Apply the change in Shopify — Sentinel never edits the live site.', invalidate: [['issue', issue.id], ['audit']], onSuccess: () => setApprove(false) });
  const copy = (t: string) => void navigator.clipboard?.writeText(t).then(() => toast.success('Copied'), () => toast.error('Clipboard not available.'));

  return (
    <article aria-label={`Fix Card for ${issue.id}`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={card.severity} />
        <Badge tone="neutral" title="Impact × Confidence × inverse Effort (PDF §11 step 4)">Priority {card.priorityScore}</Badge>
        <Badge tone="neutral">Playbook {card.playbookId}</Badge>
        {card.completeness.complete ? <Badge tone="ok" icon={<CheckCircle2 className="h-3 w-3" />}>Complete Fix Card</Badge> : <Badge tone="crit" icon={<CircleAlert className="h-3 w-3" />}>Missing: {card.completeness.missing.join(', ')}</Badge>}
      </div>

      {(card.timeEstimate || card.where?.length) ? (
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-ctl border border-signal/30 bg-signal/5 p-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]" data-testid="fix-summary">
          {card.timeEstimate && (
            <div>
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted"><Clock className="h-3.5 w-3.5" /> Estimated time to fix</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums text-ink" data-testid="fix-time">{card.timeEstimate.label}</p>
              <p className="mt-0.5 text-xs text-muted">{card.timeEstimate.basis}</p>
            </div>
          )}
          {!!card.where?.length && (
            <div>
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted"><MapPin className="h-3.5 w-3.5" /> Where to fix</p>
              <ul className="mt-1 space-y-1" data-testid="fix-where">
                {card.where.map((w) => (
                  <li key={`${w.kind}-${w.path ?? ''}`} className="text-sm"><span className="font-medium text-ink">{w.label}</span>{w.path && <span className="text-ink-soft"> — {w.path}</span>}</li>
                ))}
              </ul>
            </div>
          )}
          {card.platformNote && <p className="text-xs text-med-ink md:col-span-2">{card.platformNote}</p>}
        </div>
      ) : null}

      <Section title="What's wrong" icon={<FileWarning className="h-4 w-4 text-crit-ink" />}><p className="text-sm text-ink-soft">{card.whatsWrong}</p></Section>
      <Section title="Why it matters"><p className="text-sm text-ink-soft">{card.whyItMatters}</p></Section>

      <Section title="Affected URLs & page value">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted"><TierBadge tier={issue.highestTier} /> {card.tierSummary}</div>
        <UrlList urls={card.affectedUrls} />
      </Section>

      <Section title="Evidence"><EvidenceList evidence={card.evidence} /></Section>

      <Section title="Root cause (inferred)">
        {card.rootCause ? (
          <div className="rounded-ctl border border-line bg-canvas p-3 text-sm">
            <p className="text-ink">{card.rootCause.text}</p>
            <p className="mt-1 text-xs text-muted">Confidence {Math.round(card.rootCause.confidence * 100)}% · basis: {card.rootCause.basis}</p>
          </div>
        ) : <p className="text-sm text-muted">Not inferred — the available evidence doesn't support a single root cause. Investigate using the evidence above.</p>}
      </Section>

      <Section title="How to fix it, step by step" icon={<Wand2 className="h-4 w-4 text-signal" />}>
        <ol className="space-y-3">
          {card.steps.map((st) => (
            <li key={st.order} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-signal-tint text-xs font-semibold text-signal-dark">{st.order}</span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-sm text-ink">{st.text}</p>
                {st.adminPath && <p className="text-xs text-muted">{card.platformNote ? 'Shopify admin (see the note above for this platform)' : 'Shopify admin'}: <span className="font-medium text-ink-soft">{st.adminPath}</span></p>}
                {st.code && (
                  <div className="relative">
                    <Code language={st.code.language}>{st.code.snippet}</Code>
                    <button onClick={() => copy(st.code!.snippet)} className="absolute right-2 top-1 inline-flex items-center gap-1 text-2xs text-muted hover:text-ink"><ClipboardCopy className="h-3 w-3" /> Copy</button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {card.alternatives.length > 0 && <div className="mt-3 text-sm"><span className="text-xs text-muted">Alternatives: </span>{card.alternatives.join(' · ')}</div>}
        {card.shopifyContext && <p className="mt-3 text-xs text-muted">{card.shopifyContext}</p>}
      </Section>

      {(card.drafts?.length || card.faqDrafts?.length || card.outline?.length) ? (
        <Section title="Ready-to-edit drafts" icon={<Lightbulb className="h-4 w-4 text-opp-ink" />}>
          {card.drafts?.length ? (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              {card.drafts.map((d) => (
                <div key={d.label} className="flex flex-col rounded-ctl border border-line p-3">
                  <div className="mb-1 flex items-center justify-between text-xs"><span className="font-medium text-ink">{d.label}</span>{d.score !== undefined && <span className="tabular-nums text-muted" title={d.scoreBasis}>CTR score {d.score}*</span>}</div>
                  {d.title && <p className="text-sm font-medium text-[#1a0dab]">{d.title} <span className="text-2xs tabular-nums text-faint">({d.title.length})</span></p>}
                  {d.meta && <p className="mt-1 text-xs text-ink-soft">{d.meta} <span className="tabular-nums text-faint">({d.meta.length})</span></p>}
                  <Button size="sm" variant="ghost" className="mt-auto self-start" onClick={() => copy([d.title, d.meta].filter(Boolean).join('\n'))} icon={<ClipboardCopy className="h-3.5 w-3.5" />}>Copy</Button>
                </div>
              ))}
            </div>
          ) : null}
          {card.drafts?.some((d) => d.scoreBasis) && <p className="mt-1.5 text-xs text-muted">* {card.drafts.find((d) => d.scoreBasis)?.scoreBasis}.</p>}
          {card.outline?.length ? <div className="mt-3"><p className="mb-1 text-xs text-muted">Collection description outline</p><ol className="list-decimal space-y-0.5 pl-5 text-sm">{card.outline.map((o) => <li key={o}>{o}</li>)}</ol></div> : null}
          {card.targetEntities?.length ? <div className="mt-2 flex flex-wrap gap-1"><span className="text-xs text-muted">Target entities:</span>{card.targetEntities.map((e) => <Badge key={e}>{e}</Badge>)}</div> : null}
          {card.faqDrafts?.length ? <div className="mt-3 space-y-2"><p className="text-xs text-muted">Drafted FAQs</p>{card.faqDrafts.map((f) => <div key={f.q} className="rounded-ctl bg-canvas p-2.5 text-sm"><p className="font-medium">{f.q}</p><p className="text-ink-soft">{f.a}</p></div>)}</div> : null}
        </Section>
      ) : null}

      <Section title="Ownership, effort & impact" icon={<Target className="h-4 w-4 text-muted" />}>
        <KV cols={3} items={[
          { k: 'Owner suggestion', v: <><span className="font-medium">{TEAMS[card.ownerSuggestion].name}</span><span className="block text-xs text-muted">{card.ownerReason}</span></> },
          { k: 'Estimated time', v: card.timeEstimate ? <><span className="font-medium">{card.timeEstimate.label}</span><span className="block text-xs text-muted">{card.timeEstimate.basis}</span></> : `~${card.effortHours} h` },
          { k: 'Expected impact', v: <span className="capitalize">{card.expectedImpact} (impact {card.impactScore}/5)</span> },
          { k: 'Confidence', v: `${Math.round(card.confidence * 100)}%` },
          { k: 'SLA deadline', v: <SlaCountdown dueAt={card.slaDueAt} done={done} /> },
          { k: 'Recurrence', v: `${card.recurrence.occurrences} occurrence${card.recurrence.occurrences === 1 ? '' : 's'}` },
        ]} />
        {card.recurrence.processRecommendation && (
          <div className="mt-3">
            <Notice tone="med" icon={<Repeat className="h-4 w-4" />} title="Process recommendation">
              <p>{card.recurrence.processRecommendation}</p>
            </Notice>
          </div>
        )}
      </Section>

      <Section title="How to verify it is fixed" icon={<ShieldCheck className="h-4 w-4 text-ok-ink" />}>
        <p className="text-sm text-ink"><span className="text-muted">Verify by: </span>{card.verifyBy}</p>
        <ul className="mt-2 space-y-1">{card.acceptanceCriteria.map((a) => <li key={a} className="flex gap-2 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-faint" />{a}</li>)}</ul>
        <p className="mt-2 text-xs text-muted">The card closes only when automated re-verification finds 0 failing pages — marking an issue Fixed does not verify it.</p>
      </Section>

      {card.requiresHumanApproval && (
        <Notice tone="signal" title="Human approval required (PDF §17)">
          Sentinel proposes this change (redirect, metadata rewrite, schema update or disavow) but never applies it to the live site. Approve here to record the decision, then apply it on the website.
          {can('fixcards.approve_proposal') && <div className="mt-2"><Button size="sm" variant="primary" onClick={() => setApprove(true)}>Record approval</Button></div>}
        </Notice>
      )}
      <ConfirmDialog open={approve} onClose={() => setApprove(false)} title="Record approval of proposed change" body="This writes your approval to the audit log. It does not change the live website." reason="optional" reasonLabel="Note" confirmLabel="Record approval" loading={approveM.isPending} onConfirm={(n) => approveM.mutate(n)} />
    </article>
  );
}
