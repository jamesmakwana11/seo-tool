import { Download, Printer, Send } from 'lucide-react';
import type { DeliveryAttempt, ReportMeta } from '@sentinel/shared';
import { api } from '@/api/client';
import { useApiMutation } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { Badge, Button, KV, Notice, Panel, type Tone } from '@/components/ui/primitives';
import { Menu } from '@/components/ui/overlay';
import { DataTable } from '@/components/ui/DataTable';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { HOSTED_REVIEW, useDeliverExport } from './useDeliverExport';

export type ReportKind = 'daily' | 'weekly' | 'monthly';
export type ExportFormat = 'json' | 'csv' | 'md';

export const REPORT_LABEL: Record<ReportKind, string> = { daily: 'Daily digest', weekly: 'Weekly rollup', monthly: 'Monthly executive report' };
export const FORMAT_LABEL: Record<ExportFormat, string> = { json: 'JSON', csv: 'CSV', md: 'Markdown' };

const OUTCOME: Record<DeliveryAttempt['outcome'], { label: string; tone: Tone }> = {
  delivered: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Failed', tone: 'crit' },
  skipped_not_configured: { label: 'Skipped — not configured', tone: 'neutral' },
  retrying: { label: 'Retrying', tone: 'med' },
};
const CHANNEL_LABEL: Record<DeliveryAttempt['channel'], string> = { email: 'Email', whatsapp: 'WhatsApp', slack: 'Slack' };

export function DeliveryOutcomeBadge({ outcome }: { outcome: DeliveryAttempt['outcome'] }) {
  return <Badge tone={OUTCOME[outcome].tone}>{OUTCOME[outcome].label}</Badge>;
}

export function channelLabel(c: DeliveryAttempt['channel']) {
  return CHANNEL_LABEL[c];
}

/** Truthful one-line summary of a set of delivery attempts. */
export function summarizeDeliveries(atts: DeliveryAttempt[]): { text: string; anyDelivered: boolean } {
  if (!atts.length) return { text: 'No delivery attempted.', anyDelivered: false };
  const c = { delivered: 0, failed: 0, skipped_not_configured: 0, retrying: 0 };
  for (const a of atts) c[a.outcome]++;
  const parts: string[] = [];
  if (c.delivered) parts.push(`${c.delivered} delivered`);
  if (c.retrying) parts.push(`${c.retrying} retrying`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.skipped_not_configured) parts.push(`${c.skipped_not_configured} skipped (not configured)`);
  return { text: parts.join(' · '), anyDelivered: c.delivered > 0 };
}

/** Delivery attempts table — every outcome shown as-is, never upgraded to "sent". */
export function DeliveryTable({ rows, showKind, empty }: { rows: DeliveryAttempt[]; showKind?: boolean; empty?: string }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(d) => d.id}
      dense
      pageSize={10}
      caption="Delivery attempts"
      empty={<p className="p-4 text-sm text-muted">{empty ?? 'No delivery attempts yet.'}</p>}
      columns={[
        { key: 'at', header: 'When (IST)', cell: (d) => <span className="whitespace-nowrap text-xs">{fmtDateTime(d.at)}</span>, sort: (a, b) => a.at.localeCompare(b.at) },
        { key: 'ch', header: 'Channel', cell: (d) => channelLabel(d.channel) },
        ...(showKind ? [{ key: 'kind', header: 'Kind', cell: (d: DeliveryAttempt) => <span className="text-xs">{d.kind.replace(/_/g, ' ')}</span>, hideOnMobile: true }] : []),
        { key: 'subj', header: 'Subject', cell: (d) => <span className="text-xs">{d.subject}</span>, hideOnMobile: true },
        { key: 'out', header: 'Outcome', cell: (d) => <DeliveryOutcomeBadge outcome={d.outcome} /> },
        { key: 'err', header: 'Error / detail', cell: (d) => <span className="text-xs text-muted">{d.error ?? (d.providerMessageId ? `Provider id ${d.providerMessageId}` : '—')}</span> },
      ]}
    />
  );
}

export function SourceStateBadge({ state }: { state: 'live' | 'demo' | 'missing' }) {
  return state === 'live' ? <Badge tone="ok">Live</Badge> : state === 'demo' ? <Badge tone="demo">DEMO</Badge> : <Badge tone="neutral">Missing</Badge>;
}

export function sourceCounts(meta: ReportMeta) {
  return {
    live: meta.sources.filter((s) => s.state === 'live').length,
    demo: meta.sources.filter((s) => s.state === 'demo').length,
    missing: meta.sources.filter((s) => s.state === 'missing').length,
  };
}

/** Report provenance: period, generation time, per-source live/demo state, data notes and delivery attempts. */
export function ReportMetaPanel({ meta, schedule }: { meta: ReportMeta; schedule?: string }) {
  const n = sourceCounts(meta);
  return (
    <Panel title="Report details & delivery" subtitle={schedule}>
      <div className="space-y-4">
        <KV
          cols={3}
          items={[
            { k: 'Period', v: meta.periodStart === meta.periodEnd ? fmtDate(meta.periodEnd) : `${fmtDate(meta.periodStart)} → ${fmtDate(meta.periodEnd)}` },
            { k: 'Generated', v: `${fmtDateTime(meta.generatedAt)} IST` },
            { k: 'Data sources', v: `${n.live} live · ${n.demo} DEMO${n.missing ? ` · ${n.missing} missing` : ''}` },
          ]}
        />
        <div>
          <p className="mb-1.5 text-xs text-muted">Source state</p>
          <ul className="flex flex-wrap gap-2">
            {meta.sources.map((s) => (
              <li key={s.name} className="inline-flex items-center gap-1.5 rounded-ctl border border-line px-2 py-1 text-xs">
                {s.name} <SourceStateBadge state={s.state} />
              </li>
            ))}
          </ul>
        </div>
        {meta.dataNotes.length > 0 && (
          <Notice tone="demo" title="Data notes">
            <ul className="list-disc pl-5">{meta.dataNotes.map((d) => <li key={d}>{d}</li>)}</ul>
          </Notice>
        )}
        <div>
          <p className="mb-1.5 text-xs text-muted">Delivery attempts for this report</p>
          <DeliveryTable rows={meta.deliveries} empty="No delivery attempted for this period yet. Use “Send now” to attempt delivery on the configured channels." />
        </div>
      </div>
    </Panel>
  );
}

/** Export (JSON/CSV/Markdown) and "Send now" — both real API calls gated by reports.export. */
export function ReportActions({ kind, print }: { kind: ReportKind; print?: boolean }) {
  const { can } = useAuth();
  const toast = useToast();
  const allowed = can('reports.export');
  const why = allowed ? undefined : 'Your role does not have the reports.export permission';
  const deliver = useDeliverExport();
  const exp = useApiMutation((format: ExportFormat) => api.exportReport(kind, format), {
    invalidate: [['audit']],
    onSuccess: (r) => { void deliver(r); },
  });
  const send = useApiMutation(() => api.sendReport(kind), {
    invalidate: [['digest'], ['deliveries'], ['audit']],
    onSuccess: (atts) => {
      if (!atts.length) {
        toast.info('Not sent: no external channels are selected in the report schedule (Settings → Notifications).');
        return;
      }
      const s = summarizeDeliveries(atts);
      const skipped = atts.filter((a) => a.outcome === 'skipped_not_configured').length;
      if (s.anyDelivered) toast.success(`Sent: ${s.text}.`);
      else if (skipped === atts.length) toast.info(`Not sent: ${skipped} channel${skipped === 1 ? '' : 's'} not configured (${atts.map((a) => channelLabel(a.channel)).join(', ')}).`);
      else toast.error(`Not sent: ${s.text}.`);
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      {print && !HOSTED_REVIEW && <Button icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print</Button>}
      <Menu
        trigger={(open, isOpen) => (
          <Button icon={<Download className="h-4 w-4" />} onClick={open} disabled={!allowed} title={why} loading={exp.isPending} aria-haspopup="menu" aria-expanded={isOpen}>Export</Button>
        )}
        items={(['json', 'csv', 'md'] as ExportFormat[]).map((f) => ({ label: `Export as ${FORMAT_LABEL[f]}`, onClick: () => exp.mutate(f) }))}
      />
      <Button variant="primary" icon={<Send className="h-4 w-4" />} disabled={!allowed} title={why ?? 'Attempts delivery on the configured report channels'} loading={send.isPending} onClick={() => send.mutate()}>Send now</Button>
    </div>
  );
}
