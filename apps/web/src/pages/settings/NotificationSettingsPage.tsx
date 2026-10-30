import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, RotateCcw, Save } from 'lucide-react';
import { TEAMS, TEAM_IDS, type AlertRule, type Channel, type SentinelConfig, type TeamId } from '@sentinel/shared';
import { api } from '@/api/client';
import { errorMessage, useApiMutation, useApiQuery } from '@/api/hooks';
import { useAuth } from '@/auth/AuthContext';
import { Async, Badge, Button, Checkbox, Field, Input, Notice, PageHeader, Panel, Select, Toggle } from '@/components/ui/primitives';
import { ConfigSection, IntegrationStateBadge, NumberField, sameJson } from '@/components/settings/ConfigSection';
import { DeliveryTable } from '@/components/reports/ReportParts';

const CHANNELS: { id: Channel; label: string }[] = [
  { id: 'in_app', label: 'In-app' },
  { id: 'email', label: 'Email' },
  { id: 'whatsapp', label: 'WhatsApp' },
  { id: 'slack', label: 'Slack' },
];

const ALERT_HELP: Record<AlertRule['type'], string> = {
  sitewide_5xx: 'Server errors across many URLs at once.',
  robots_change: 'Any change to /robots.txt content.',
  tier1_noindex: 'Homepage or a Tier-1 page turns noindex.',
  ssl_failure: 'Certificate invalid, expired or handshake failing.',
  index_collapse: 'Indexed-page count drops sharply in GSC.',
  toxic_link_spike: 'Sudden surge of toxic referring domains.',
  cwv_poor_template: 'A template’s Core Web Vitals turn “Poor”.',
};

export default function NotificationSettingsPage() {
  const cfg = useApiQuery(['config'], () => api.getConfig());
  return (
    <div>
      <PageHeader
        title="Notifications & alerts"
        description="Real-time alerts bypass the digest and go straight to the dev + SEO channel (PDF §12.2). Digest and rollup schedules follow PDF §12.1 and §12.5."
      />
      <div className="space-y-5">
        <ChannelStatus />
        <Async q={cfg} rows={8}>
          {(c) => (
            <>
              <AlertRulesEditor rules={c.alerts} />
              <ScheduleEditor config={c} />
            </>
          )}
        </Async>
        <RecentDeliveries />
      </div>
    </div>
  );
}

function ChannelStatus() {
  const { can } = useAuth();
  const q = useApiQuery(['integrations'], () => api.listIntegrations(), { enabled: can('integrations.view') });
  if (!can('integrations.view')) {
    return <Notice>Channel connection status needs the integrations.view permission. Alerts are still recorded in-app.</Notice>;
  }
  return (
    <Panel title="Channel status" subtitle="External delivery only works once a channel's integration is connected and tested on the API server." actions={<Link to="/settings/integrations" className="inline-flex items-center gap-1 text-sm text-signal hover:underline">Integrations <ArrowUpRight className="h-3.5 w-3.5" /></Link>}>
      <Async q={q} rows={2}>
        {(list) => {
          const notif = list.filter((i) => i.category === 'notification');
          return (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <li className="rounded-ctl border border-line p-3">
                <p className="text-sm font-medium">In-app</p>
                <Badge tone="ok" className="mt-1">Always on</Badge>
                <p className="mt-1 text-xs text-muted">Notification bell inside Sentinel.</p>
              </li>
              {notif.map((i) => (
                <li key={i.id} className="rounded-ctl border border-line p-3">
                  <p className="text-sm font-medium">{i.name}</p>
                  <div className="mt-1"><IntegrationStateBadge state={i.state} /></div>
                  <p className="mt-1 text-xs text-muted">Needs {i.envVars.join(', ')}</p>
                </li>
              ))}
            </ul>
          );
        }}
      </Async>
      <p className="mt-3 text-xs text-muted">Unconfigured channels are recorded as “skipped — not configured” in the delivery log below; nothing is reported as sent unless the provider accepted it.</p>
    </Panel>
  );
}

function AlertRulesEditor({ rules }: { rules: AlertRule[] }) {
  const { can } = useAuth();
  const canEdit = can('notifications.configure');
  const [draft, setDraft] = useState<AlertRule[] | null>(null);
  const value = draft ?? rules;
  const dirty = draft !== null && !sameJson(draft, rules);
  const m = useApiMutation((r: AlertRule[]) => api.updateAlertRules(r), { success: 'Alert routing saved', invalidate: [['config'], ['audit']], onSuccess: () => setDraft(null) });
  const patch = (type: AlertRule['type'], p: Partial<AlertRule>) => setDraft(value.map((r) => (r.type === type ? { ...r, ...p } : r)));
  const toggleIn = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const clientErrors = value.filter((r) => r.enabled && !r.channels.length).map((r) => `“${r.label}” is enabled but has no channels.`);
  return (
    <Panel
      title={<span className="flex items-center gap-2">Real-time alerts {dirty && <Badge tone="med">Unsaved changes</Badge>}</span>}
      subtitle="PDF §12.2 — delivered instantly to the dev + SEO channel"
      actions={canEdit ? (
        <>
          {dirty && <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { setDraft(null); m.reset(); }}>Discard</Button>}
          <Button size="sm" variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty || clientErrors.length > 0} loading={m.isPending} onClick={() => m.mutate(value)}>Save alert routing</Button>
        </>
      ) : <Badge tone="neutral">Read-only</Badge>}
      bodyClassName="p-0"
    >
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">Real-time alert rules</caption>
          <thead>
            <tr className="border-b border-line bg-raised/70 text-left text-xs text-muted">
              <th scope="col" className="px-4 py-2 font-medium">Alert</th>
              <th scope="col" className="px-3 py-2 font-medium">Enabled</th>
              <th scope="col" className="px-3 py-2 font-medium">Channels</th>
              <th scope="col" className="px-3 py-2 font-medium">Recipient teams</th>
            </tr>
          </thead>
          <tbody>
            {value.map((r) => (
              <tr key={r.type} className="border-b border-line align-top last:border-0">
                <td className="px-4 py-2.5">
                  <p className="font-medium">{r.label}</p>
                  <p className="text-xs text-muted">{ALERT_HELP[r.type]}</p>
                </td>
                <td className="px-3 py-2.5"><Toggle checked={r.enabled} onChange={(v) => patch(r.type, { enabled: v })} label={`Enable ${r.label} alert`} disabled={!canEdit || m.isPending} /></td>
                <td className="px-3 py-2.5">
                  <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
                    <legend className="sr-only">Channels for {r.label}</legend>
                    {CHANNELS.map((ch) => <Checkbox key={ch.id} label={ch.label} checked={r.channels.includes(ch.id)} disabled={!canEdit || m.isPending} onChange={(on) => patch(r.type, { channels: toggleIn(r.channels, ch.id, on) })} />)}
                  </fieldset>
                </td>
                <td className="px-3 py-2.5">
                  <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
                    <legend className="sr-only">Recipient teams for {r.label}</legend>
                    {TEAM_IDS.map((t: TeamId) => <Checkbox key={t} label={TEAMS[t].shortName} checked={r.recipients.includes(t)} disabled={!canEdit || m.isPending} onChange={(on) => patch(r.type, { recipients: toggleIn(r.recipients, t, on) })} />)}
                  </fieldset>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(clientErrors.length > 0 || (m.error && dirty)) && (
        <div className="space-y-2 border-t border-line p-3">
          {clientErrors.map((e) => <Notice key={e} tone="crit">{e}</Notice>)}
          {m.error && dirty && <Notice tone="crit" title="Not saved">{errorMessage(m.error)}</Notice>}
        </div>
      )}
      {!canEdit && <p className="border-t border-line px-4 py-2 text-xs text-muted">Editing needs the notifications.configure permission.</p>}
    </Panel>
  );
}

function ScheduleEditor({ config }: { config: SentinelConfig }) {
  const { can } = useAuth();
  return (
    <ConfigSection
      config={config}
      k="reporting"
      title="Digest & report schedule"
      subtitle="Daily digest 8:00 AM IST (PDF §12.1) · weekly rollup Monday · monthly executive report (PDF §12.5). Times are IST."
      origin="PDF §12.1, §12.5"
      canEdit={can('settings.manage')}
      readOnlyReason="Changing the schedule needs the settings.manage permission."
      saveLabel="Save schedule"
      validate={(v) => (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.dailyDigestTime) ? 'Digest time must be HH:MM (24-hour, IST).' : !Number.isInteger(v.monthlyDay) || v.monthlyDay < 1 || v.monthlyDay > 28 ? 'Monthly day must be a whole number from 1 to 28.' : !v.channels.length ? 'Choose at least one delivery channel.' : undefined)}
    >
      {(v, set, disabled) => (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Daily digest time (IST)" htmlFor="sch-time">
            <Input id="sch-time" type="time" value={v.dailyDigestTime} disabled={disabled} onChange={(e) => set({ ...v, dailyDigestTime: e.target.value })} className="max-w-[160px]" />
          </Field>
          <Field label="Weekly rollup day" htmlFor="sch-week" hint="Fixed to Monday by the PDF.">
            <Select id="sch-week" value={v.weeklyDay} disabled className="max-w-[160px]"><option value="monday">Monday</option></Select>
          </Field>
          <NumberField id="sch-month" label="Monthly report day of month" value={v.monthlyDay} min={1} max={28} step={1} disabled={disabled} onChange={(n) => set({ ...v, monthlyDay: n })} hint="1–28 so it exists every month." />
          <fieldset className="space-y-1">
            <legend className="text-[13px] font-medium text-ink">Delivery channels</legend>
            {CHANNELS.map((ch) => <Checkbox key={ch.id} label={ch.label} checked={v.channels.includes(ch.id)} disabled={disabled} onChange={(on) => set({ ...v, channels: on ? [...v.channels, ch.id] : v.channels.filter((x) => x !== ch.id) })} />)}
          </fieldset>
        </div>
      )}
    </ConfigSection>
  );
}

function RecentDeliveries() {
  const { can } = useAuth();
  const q = useApiQuery(['deliveries'], () => api.listDeliveries(), { enabled: can('reports.view') });
  if (!can('reports.view')) return null;
  return (
    <Panel title="Recent delivery attempts" subtitle="Alerts and digests — outcome exactly as recorded" actions={<Link to="/reports/history" className="text-sm text-signal hover:underline">Report history</Link>} bodyClassName="p-3">
      <Async q={q} rows={4}>{(d) => <DeliveryTable rows={d} showKind />}</Async>
    </Panel>
  );
}
