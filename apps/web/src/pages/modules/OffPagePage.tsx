import { useMemo, useState } from 'react';
import { CheckCircle2, MapPin, XCircle } from 'lucide-react';
import { defaultConfig, type Backlink, type DisavowCandidate, type ReferringDomainTrendPoint } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { ModuleView } from '@/components/domain/ModuleView';
import { Async, Badge, Button, EmptyState, KV, Notice, Panel, Stat } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { TrendChart } from '@/components/ui/charts';
import { SourceBadge } from '@/components/domain/badges';
import { ApiNote, PanelLink, useConfigQuery, SrOnly } from '@/components/modules/shared';
import { useEmployees } from '@/hooks/lookups';
import { fmtDate, fmtNum } from '@/lib/format';

export default function OffPagePage() {
  return (
    <ModuleView
      module="offpage"
      description="Daily backlink deltas, toxic-link and anchor-text monitoring, referring-domain trend vs. competitors, plus the weekly deep-dive: link gap, digital PR, local citations and disavow review (PDF §7)."
      headerActions={<PanelLink to="/modules/offpage/backlinks">Backlink analysis</PanelLink>}
      extra={
        <div className="space-y-5">
          <BacklinkOverview />
          <DisavowPanel />
          <LocalPanel />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- daily backlinks
function BacklinkOverview() {
  const q = useApiQuery(['backlinks'], () => api.listBacklinks());
  const { q: cfg } = useConfigQuery();
  const t = cfg.data?.thresholds ?? defaultConfig().thresholds;
  return (
    <Async q={q} rows={6}>
      {(d) => (
        <div className="space-y-5">
          <ApiNote note={d.note} available={d.available} />
          <Counts items={d.items} lostMinDr={t.lostLinkMinDr} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Panel title="Referring domains vs. competitors" subtitle="OFF-REFDOMAINS — 30-day trend vs. the top 3 competitors">
              <RefTrend trend={d.trend} />
            </Panel>
            <Panel title="Anchor-text distribution" subtitle={`OFF-ANCHOR — exact-match commercial anchors should stay under ~${t.exactMatchAnchorPct}% of new links`}>
              <Anchors items={d.items} limit={t.exactMatchAnchorPct} />
            </Panel>
          </div>
        </div>
      )}
    </Async>
  );
}

function Counts({ items, lostMinDr }: { items: Backlink[]; lostMinDr: number }) {
  const n = items.filter((b) => b.status === 'new').length;
  const lost = items.filter((b) => b.status === 'lost');
  const lostQuality = lost.filter((b) => b.domainRating > lostMinDr).length;
  const toxicDomains = new Set(items.filter((b) => (b.toxicScore ?? 0) >= 70).map((b) => b.sourceDomain)).size;
  const refDomains = new Set(items.filter((b) => b.status !== 'lost').map((b) => b.sourceDomain)).size;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="New links" value={n} tone={n ? 'ok' : undefined} to="/modules/offpage/backlinks?status=new" />
      <Stat label="Lost links" value={lost.length} tone={lostQuality ? 'med' : undefined} hint={`${lostQuality} from DR > ${lostMinDr} — reclaim`} to="/modules/offpage/backlinks?status=lost" />
      <Stat label="Toxic domains" value={toxicDomains} tone={toxicDomains ? 'crit' : undefined} hint="toxic score ≥ 70" to="/modules/offpage/backlinks?toxic=1" />
      <Stat label="Referring domains in sample" value={refDomains} hint="live + new" />
    </div>
  );
}

function RefTrend({ trend }: { trend: ReferringDomainTrendPoint[] }) {
  const keys = Object.keys(trend.at(-1)?.values ?? {});
  const data = trend.map((p) => ({ date: p.date, ...p.values }));
  if (!trend.length) return <EmptyState title="No trend data yet" description="Requires the Ahrefs or Semrush API." />;
  return <TrendChart data={data} x="date" series={keys.map((k) => ({ key: k, label: k, dashed: k !== 'DeoDap' }))} />;
}

const ANCHOR_LABEL: Record<Backlink['anchorType'], string> = { branded: 'Branded', exact_match: 'Exact match', partial: 'Partial match', url: 'Naked URL', generic: 'Generic' };

function Anchors({ items, limit }: { items: Backlink[]; limit: number }) {
  const { rows, newExact, newTotal } = useMemo(() => {
    const counts = new Map<Backlink['anchorType'], number>();
    items.forEach((b) => counts.set(b.anchorType, (counts.get(b.anchorType) ?? 0) + 1));
    const fresh = items.filter((b) => b.status === 'new');
    return {
      rows: [...counts.entries()].sort((a, b) => b[1] - a[1]),
      newExact: fresh.filter((b) => b.anchorType === 'exact_match').length,
      newTotal: fresh.length,
    };
  }, [items]);
  const pct = newTotal ? (newExact / newTotal) * 100 : 0;
  const over = pct > limit;
  return (
    <div className="space-y-3">
      <div className={`rounded-ctl border p-3 ${over ? 'border-med/40 bg-med-tint' : 'border-line'}`}>
        <p className="text-xs text-muted">Exact-match share of new links</p>
        <p className={`text-2xl font-semibold tabular-nums ${over ? 'text-med-ink' : 'text-ok-ink'}`}>{pct.toFixed(1)}%</p>
        <p className="text-xs text-muted">{newExact} of {newTotal} new links · threshold {limit}%{over ? ' — over-optimisation risk' : ''}</p>
      </div>
      <ul className="space-y-1.5">
        {rows.map(([type, n]) => {
          const share = (n / items.length) * 100;
          return (
            <li key={type} className="text-sm">
              <div className="flex justify-between"><span>{ANCHOR_LABEL[type]}</span><span className="tabular-nums text-muted">{n} · {share.toFixed(0)}%</span></div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-line"><div className={`h-full rounded-full ${type === 'exact_match' ? 'bg-med' : 'bg-signal'}`} style={{ width: `${share}%` }} /></div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted">Distribution across all {items.length} links in the sample.</p>
    </div>
  );
}

// ---------------------------------------------------------------- disavow
function DisavowPanel() {
  const q = useApiQuery(['disavow'], () => api.listDisavowCandidates());
  return (
    <Panel title="Disavow candidates" subtitle="OFF-DISAVOW — maintained continuously; every domain needs a human decision" bodyClassName="p-3">
      <div className="mb-3"><Notice>Approving adds the domain to the approved disavow list. A person builds the disavow file from it and uploads it in Google Search Console — Sentinel never submits anything to Google.</Notice></div>
      <Async q={q} rows={4}>
        {(rows) => <DisavowTable rows={rows} />}
      </Async>
    </Panel>
  );
}

function DisavowTable({ rows }: { rows: DisavowCandidate[] }) {
  const { can } = useAuth();
  const emp = useEmployees();
  const allowed = can('disavow.approve');
  const [pending, setPending] = useState<{ c: DisavowCandidate; decision: 'approved' | 'rejected' } | null>(null);
  const m = useApiMutation((v: { id: string; decision: 'approved' | 'rejected' }) => api.decideDisavow(v.id, v.decision), {
    success: (d) => (d.approval === 'approved' ? `${d.domain} approved for disavow` : `${d.domain} rejected`),
    invalidate: [['disavow'], ['audit']],
    onSuccess: () => setPending(null),
  });
  return (
    <>
      <DataTable
        rows={rows}
        rowKey={(c) => c.id}
        dense
        caption="Disavow candidates"
        initialSort={{ key: 'score', dir: 'desc' }}
        empty={<EmptyState title="No disavow candidates" description="Toxic referring domains appear here when the toxic-link monitor flags them." />}
        columns={[
          { key: 'd', header: 'Domain', cell: (c) => <span className="font-mono text-xs">{c.domain}</span> },
          { key: 'score', header: 'Toxic score', width: '100px', sort: (a, b) => a.toxicScore - b.toxicScore, cell: (c) => <span className="font-semibold tabular-nums text-crit-ink">{c.toxicScore}</span> },
          { key: 'sig', header: 'Signals', hideOnMobile: true, cell: (c) => <div className="flex flex-wrap gap-1">{c.signals.map((s) => <Badge key={s} tone="neutral">{s}</Badge>)}</div> },
          { key: 'seen', header: 'First seen', width: '110px', hideOnMobile: true, sort: (a, b) => a.firstSeen.localeCompare(b.firstSeen), cell: (c) => <span className="text-xs text-muted">{fmtDate(c.firstSeen)}</span> },
          {
            key: 'a', header: 'Decision', width: '220px',
            cell: (c) => c.approval === 'pending' ? (
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" icon={<CheckCircle2 className="h-3.5 w-3.5" />} disabled={!allowed} title={allowed ? undefined : 'Needs the disavow.approve permission'} onClick={() => setPending({ c, decision: 'approved' })}>Approve</Button>
                <Button size="sm" variant="ghost" icon={<XCircle className="h-3.5 w-3.5" />} disabled={!allowed} title={allowed ? undefined : 'Needs the disavow.approve permission'} onClick={() => setPending({ c, decision: 'rejected' })}>Reject</Button>
              </div>
            ) : (
              <div className="text-xs">
                <Badge tone={c.approval === 'approved' ? 'crit' : 'neutral'}>{c.approval === 'approved' ? 'Approved for disavow' : 'Rejected'}</Badge>
                <div className="mt-0.5 text-muted">{c.decidedById ? emp.name(c.decidedById) : ''}{c.decidedAt ? ` · ${fmtDate(c.decidedAt)}` : ''}</div>
              </div>
            ),
          },
          { key: 's', header: <SrOnly>Source</SrOnly>, width: '80px', hideOnMobile: true, cell: (c) => <SourceBadge source={c.source} /> },
        ]}
      />
      <ConfirmDialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={pending?.decision === 'approved' ? `Approve ${pending.c.domain} for disavow?` : `Reject ${pending?.c.domain ?? ''}?`}
        body={pending?.decision === 'approved'
          ? <>The domain is added to the approved disavow list. <strong>Sentinel never submits to Google</strong> — a person uploads the disavow file in Search Console. Disavowing good links can hurt rankings, so only approve clear spam.</>
          : 'The domain stays off the disavow list and is not proposed again unless its signals change.'}
        confirmLabel={pending?.decision === 'approved' ? 'Approve for disavow' : 'Reject candidate'}
        danger={pending?.decision === 'approved'}
        loading={m.isPending}
        onConfirm={() => pending && m.mutate({ id: pending.c.id, decision: pending.decision })}
      />
    </>
  );
}

// ---------------------------------------------------------------- local
function LocalPanel() {
  const q = useApiQuery(['local-health'], () => api.getLocalHealth());
  return (
    <Panel title="Local citations & Google Business Profile" subtitle="OFF-LOCAL — NAP consistency across directories, GBP health and review velocity (weekly)">
      <Async q={q} rows={4}>
        {(d) => (
          <div className="space-y-4">
            <ApiNote note={d.note} available={d.available} />
            {d.gbp ? (
              <KV cols={3} items={[
                { k: 'GBP rating', v: <span className="tabular-nums">{d.gbp.rating.toFixed(1)} / 5</span> },
                { k: 'Reviews', v: <span className="tabular-nums">{fmtNum(d.gbp.reviews)}</span> },
                { k: 'New reviews (30 days)', v: <span className="tabular-nums">{fmtNum(d.gbp.reviewVelocity30d)}</span> },
                { k: 'Profile completeness', v: <span className={`tabular-nums ${d.gbp.completeness < 80 ? 'text-med-ink' : ''}`}>{d.gbp.completeness}%</span> },
              ]} />
            ) : <p className="text-sm text-muted">Google Business Profile not connected — requires the GBP API.</p>}
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">NAP consistency (name, address, phone)</p>
              {d.napConsistency.length ? (
                <ul className="divide-y divide-line rounded-ctl border border-line">
                  {d.napConsistency.map((n) => (
                    <li key={n.directory} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <MapPin className="h-4 w-4 text-faint" aria-hidden />
                      <span className="font-medium">{n.directory}</span>
                      <Badge tone={n.consistent ? 'ok' : 'med'}>{n.consistent ? 'Consistent' : 'Mismatch'}</Badge>
                      <span className="min-w-0 flex-1 text-xs text-muted">{n.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-muted">No directory listings checked yet.</p>}
            </div>
          </div>
        )}
      </Async>
    </Panel>
  );
}
