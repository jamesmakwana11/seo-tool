import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import type { ReportMeta } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, DemoBadge, Notice, PageHeader, Panel } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { FilterSelect } from '@/components/ui/filters';
import { DeliveryTable, FORMAT_LABEL, REPORT_LABEL, sourceCounts, summarizeDeliveries, type ExportFormat, type ReportKind } from '@/components/reports/ReportParts';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { HOSTED_REVIEW, useDeliverExport } from '@/components/reports/useDeliverExport';

const KIND_PATH: Record<ReportKind, string> = { daily: '/reports/daily', weekly: '/reports/weekly', monthly: '/reports/monthly' };

export default function ReportHistoryPage() {
  const q = useApiQuery(['digest', 'history'], () => api.listReportHistory());
  const deliveries = useApiQuery(['deliveries'], () => api.listDeliveries());
  const [kind, setKind] = useState('');
  return (
    <div>
      <PageHeader
        title="Report history & export"
        description="Daily digests for the last 14 days plus the current weekly and monthly rollups, with what was actually delivered on each channel (PDF §12.1, §12.5)."
        meta={<DemoBadge />}
      />
      <div className="space-y-5">
        <Notice tone="demo" title="Past snapshots are not stored in DEMO mode">
          Earlier reports are not kept as frozen files. Every export below is regenerated from the current data at the moment you click — the filename carries today's date, not the historical period.
        </Notice>

        <ExportPanel />

        <Panel title="Generated reports" bodyClassName="p-3">
          <Async q={q} rows={8}>
            {(rows) => (
              <DataTable<ReportMeta>
                rows={kind ? rows.filter((r) => r.kind === kind) : rows}
                rowKey={(r) => r.id}
                dense
                pageSize={20}
                caption="Report history"
                toolbar={<FilterSelect label="Kind" value={kind} onChange={setKind} options={(['daily', 'weekly', 'monthly'] as ReportKind[]).map((k) => ({ value: k, label: REPORT_LABEL[k] }))} />}
                columns={[
                  { key: 'kind', header: 'Kind', cell: (r) => <Link to={KIND_PATH[r.kind]} className="text-signal hover:underline">{REPORT_LABEL[r.kind]}</Link> },
                  { key: 'period', header: 'Period', cell: (r) => <span className="whitespace-nowrap">{r.periodStart === r.periodEnd ? fmtDate(r.periodEnd) : `${fmtDate(r.periodStart)} → ${fmtDate(r.periodEnd)}`}</span>, sort: (a, b) => a.periodEnd.localeCompare(b.periodEnd) },
                  { key: 'gen', header: 'Generated (IST)', cell: (r) => <span className="whitespace-nowrap text-xs">{fmtDateTime(r.generatedAt)}</span>, hideOnMobile: true },
                  {
                    key: 'src', header: 'Sources', cell: (r) => {
                      const n = sourceCounts(r);
                      return <span className="flex flex-wrap gap-1">{n.live > 0 && <Badge tone="ok">{n.live} live</Badge>}{n.demo > 0 && <Badge tone="demo">{n.demo} DEMO</Badge>}{n.missing > 0 && <Badge tone="neutral">{n.missing} missing</Badge>}</span>;
                    },
                  },
                  { key: 'del', header: 'Deliveries', cell: (r) => <span className="text-xs text-muted">{summarizeDeliveries(r.deliveries).text}</span> },
                ]}
              />
            )}
          </Async>
        </Panel>

        <Panel title="All delivery attempts" subtitle="Digest, rollup, alert and allocation attempts — outcomes exactly as recorded" bodyClassName="p-3">
          <Async q={deliveries} rows={5}>{(d) => <DeliveryTable rows={d} showKind />}</Async>
        </Panel>
      </div>
    </div>
  );
}

function ExportPanel() {
  const { can } = useAuth();
  const allowed = can('reports.export');
  const [busy, setBusy] = useState<string | null>(null);
  const deliver = useDeliverExport();
  const m = useApiMutation((v: { kind: ReportKind; format: ExportFormat }) => api.exportReport(v.kind, v.format), {
    invalidate: [['audit']],
    onSuccess: (r) => { setBusy(null); void deliver(r); },
  });
  return (
    <Panel title="Export current reports" subtitle={allowed ? (HOSTED_REVIEW ? 'Copies the report, as generated right now, to your clipboard (this hosted preview blocks downloads).' : 'Downloads the report as generated right now.') : 'Your role does not have the reports.export permission.'}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {(['daily', 'weekly', 'monthly'] as ReportKind[]).map((k) => (
          <div key={k} className="rounded-ctl border border-line p-3">
            <p className="mb-2 text-sm font-medium">{REPORT_LABEL[k]}</p>
            <div className="flex flex-wrap gap-1.5">
              {(['json', 'csv', 'md'] as ExportFormat[]).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  icon={<Download className="h-3.5 w-3.5" />}
                  disabled={!allowed || (m.isPending && busy !== `${k}-${f}`)}
                  loading={m.isPending && busy === `${k}-${f}`}
                  title={allowed ? undefined : 'Requires reports.export'}
                  aria-label={`Export ${REPORT_LABEL[k]} as ${FORMAT_LABEL[f]}`}
                  onClick={() => { setBusy(`${k}-${f}`); m.mutate({ kind: k, format: f }, { onError: () => setBusy(null) }); }}
                >
                  {FORMAT_LABEL[f]}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
