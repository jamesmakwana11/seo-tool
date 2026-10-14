import { Link } from 'react-router-dom';
import { Radar } from 'lucide-react';
import type { VerificationAttempt } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { useEmployees } from '@/hooks/lookups';
import { Async, DemoBadge, EmptyState, Notice, PageHeader, Panel, Stat } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { ClearFilters, FilterSelect, useUrlFilters } from '@/components/ui/filters';
import { SourceBadge } from '@/components/domain/badges';
import { VERIFICATION_METHOD_LABELS, VERIFICATION_OUTCOME_LABELS, VerificationOutcomeBadge } from '@/components/crawls/crawlBadges';
import { fmtDateTime, fmtNum } from '@/lib/format';

export default function VerificationPage() {
  const q = useApiQuery(['verifications'], () => api.listVerifications());
  return (
    <div>
      <PageHeader
        title="Verification results"
        description="Automated re-verification and re-verification crawl results for fixed issues (PDF §12.3). Re-verification closes issues automatically — nobody marks an issue verified by hand."
        meta={<DemoBadge />}
        actions={<Link to="/crawls" className="inline-flex h-9 items-center gap-1.5 rounded-ctl border border-line-strong bg-surface px-3 text-sm font-medium shadow-card transition-colors hover:border-signal/40 hover:text-signal-dark"><Radar className="h-4 w-4" /> Crawl Center</Link>}
      />
      <div className="space-y-5">
        <Notice tone="signal" title="How an issue closes">
          <ul className="list-disc space-y-0.5 pl-5">
            <li>When someone marks an issue fixed, it moves to <strong>Fixed — awaiting automated re-verification</strong>. That is not verified.</li>
            <li>The next smart crawl re-checks every affected URL. The issue closes only when the automated re-check finds <strong>0 failing pages</strong>; any failing page keeps it open.</li>
            <li><strong>Pending data</strong> means the data source needed for the check (for example Search Console or CrUX) is not connected, or the re-crawl has not run yet. It is never counted as a pass.</li>
            <li>A manual attestation records what a person checked, but it is evidence, not an automated pass.</li>
          </ul>
        </Notice>
        <Async q={q} rows={8}>{(list) => <Body list={list} />}</Async>
      </div>
    </div>
  );
}

function Body({ list }: { list: VerificationAttempt[] }) {
  const emp = useEmployees();
  const f = useUrlFilters(['outcome', 'method'] as const);
  const outcome = f.get('outcome');
  const method = f.get('method');
  const rows = list.filter((v) => (!outcome || v.outcome === outcome) && (!method || v.method === method));
  const count = (o: VerificationAttempt['outcome']) => list.filter((v) => v.outcome === o).length;
  const manual = list.filter((v) => v.method === 'manual_attestation').length;
  const errors = count('error');
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Passed" value={count('passed')} tone="ok" hint="0 failing pages on re-check" />
        <Stat label="Failed" value={count('failed')} tone={count('failed') ? 'crit' : undefined} hint="Issue stays open" />
        <Stat label="Pending data" value={count('pending_data')} hint={errors ? `${errors} errored · not a pass` : 'Source not connected · not a pass'} />
        <Stat label="Manual attestations" value={manual} hint="Evidence only — not an automated pass" />
      </div>
      <Panel title="Verification attempts" subtitle="Newest first" bodyClassName="p-3">
        <DataTable
          rows={rows}
          rowKey={(v) => v.id}
          search={(v) => `${v.id} ${v.issueId} ${v.details}`}
          searchPlaceholder="Search issue or details"
          caption="Verification attempts"
          initialSort={{ key: 'at', dir: 'desc' }}
          toolbar={
            <>
              <FilterSelect label="Outcome" value={outcome} onChange={(v) => f.set('outcome', v)} options={(Object.keys(VERIFICATION_OUTCOME_LABELS) as VerificationAttempt['outcome'][]).map((o) => ({ value: o, label: VERIFICATION_OUTCOME_LABELS[o] }))} />
              <FilterSelect label="Method" value={method} onChange={(v) => f.set('method', v)} options={(Object.keys(VERIFICATION_METHOD_LABELS) as VerificationAttempt['method'][]).map((m) => ({ value: m, label: VERIFICATION_METHOD_LABELS[m] }))} />
              <ClearFilters show={f.active} onClear={f.clear} />
            </>
          }
          empty={<EmptyState title={list.length ? 'No attempts match these filters' : 'No verification has run yet'} description={list.length ? 'Clear the filters to see every attempt.' : 'Attempts appear when a fixed task is re-checked by the next smart crawl or a connector check.'} />}
          columns={[
            { key: 'at', header: 'When (IST)', cell: (v) => <span className="whitespace-nowrap text-xs">{fmtDateTime(v.at)}</span>, sort: (a, b) => a.at.localeCompare(b.at) },
            { key: 'issue', header: 'Issue', cell: (v) => (v.issueId && v.issueId !== '-' ? <Link to={`/issues/${v.issueId}`} className="font-mono text-xs text-signal hover:underline">{v.issueId}</Link> : <span className="text-xs text-muted">—</span>) },
            { key: 'method', header: 'Method', hideOnMobile: true, cell: (v) => <span className="whitespace-nowrap text-xs">{VERIFICATION_METHOD_LABELS[v.method]}</span> },
            { key: 'outcome', header: 'Outcome', cell: (v) => <VerificationOutcomeBadge outcome={v.outcome} /> },
            { key: 'urls', header: 'Checked / failing', cell: (v) => (v.outcome === 'pending_data' && v.checkedUrls === 0 ? <span className="text-xs text-muted">Not checked yet</span> : <span className="whitespace-nowrap tabular-nums text-xs">{fmtNum(v.checkedUrls)} / <span className={v.failingUrls ? 'font-medium text-crit-ink' : ''}>{fmtNum(v.failingUrls)}</span></span>), sort: (a, b) => a.failingUrls - b.failingUrls },
            { key: 'details', header: 'Details', cell: (v) => <span className="block min-w-[200px] text-xs">{v.details}{v.triggeredBy !== 'system' && <span className="text-muted"> · triggered by {emp.name(v.triggeredBy)}</span>}</span> },
            { key: 'src', header: 'Source', cell: (v) => <span className="whitespace-nowrap"><SourceBadge source={v.source} /></span> },
          ]}
        />
      </Panel>
    </div>
  );
}
