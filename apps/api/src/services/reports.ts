import {
  buildDailyDigest, buildMonthlyReport, buildWeeklyReport, exportReport,
  type DailyDigest, type DeliveryAttempt, type MonthlyReport, type ReportMeta, type WeeklyReport,
} from '@sentinel/shared';
import { badRequest } from '../lib/errors';
import { audit, loadView, need, notify, type Actor, type Ctx } from './context';

type Kind = 'daily' | 'weekly' | 'monthly';
const KIND_TO_DELIVERY: Record<Kind, DeliveryAttempt['kind']> = { daily: 'daily_digest', weekly: 'weekly_report', monthly: 'monthly_report' };
const TITLE: Record<Kind, string> = { daily: 'Daily SEO digest', weekly: 'Weekly SEO rollup', monthly: 'Monthly executive SEO report' };

/** Reporting (PDF §12.1 daily digest, §13 weekly/monthly). Built from live repository state via the shared builders. */
export function createReportService(ctx: Ctx) {
  const r = ctx.repos;

  async function build(kind: Kind, at = ctx.clock()): Promise<DailyDigest | WeeklyReport | MonthlyReport> {
    const v = await loadView(ctx);
    return kind === 'daily' ? buildDailyDigest(v, at) : kind === 'weekly' ? buildWeeklyReport(v, at) : buildMonthlyReport(v, at);
  }

  /** Send through every configured external channel. Outcomes come from the providers — never assumed. */
  async function send(actor: Actor, kind: Kind): Promise<DeliveryAttempt[]> {
    if (!['daily', 'weekly', 'monthly'].includes(kind)) throw badRequest('Unknown report kind.');
    const rep = await build(kind);
    const md = exportReport(kind, 'md', rep).content;
    const cfg = await r.config.get();
    const channels = cfg.reporting.channels.filter((c): c is 'email' | 'whatsapp' | 'slack' => c !== 'in_app');
    const subject = `${TITLE[kind]} — ${ctx.clock().toISOString().slice(0, 10)}`;
    const base = ctx.env.APP_BASE_URL;
    const out = channels.length
      ? await ctx.delivery.deliver(KIND_TO_DELIVERY[kind], channels, { subject, text: md, links: base ? [{ label: 'Open in Sentinel', url: `${base}/reports/${kind}` }] : undefined })
      : [];
    if (cfg.reporting.channels.includes('in_app')) {
      const recipients = (await r.employees.list()).filter((e) => e.status === 'active').map((e) => e.id);
      await notify(ctx, recipients, { type: 'digest', title: subject, body: rep.meta.dataNotes[0] ?? 'Open the report for details.', link: `/reports/${kind}` });
    }
    const summary = out.length ? out.map((d) => `${d.channel}: ${d.outcome}`).join(', ') : 'no external channels selected';
    await audit(ctx, actor, 'report.send', 'report', kind, `${TITLE[kind]} send — ${summary}`);
    return out;
  }

  return {
    build,
    send,
    async daily(actor: Actor, date?: string) {
      await need(ctx, actor, 'reports.view');
      let at = ctx.clock();
      if (date) {
        const d = new Date(`${date}T08:00:00+05:30`);
        if (Number.isNaN(d.getTime())) throw badRequest('date must be YYYY-MM-DD.');
        at = d;
      }
      return build('daily', at) as Promise<DailyDigest>;
    },
    async weekly(actor: Actor) { await need(ctx, actor, 'reports.view'); return build('weekly') as Promise<WeeklyReport>; },
    async monthly(actor: Actor) { await need(ctx, actor, 'reports.view'); return build('monthly') as Promise<MonthlyReport>; },
    async history(actor: Actor): Promise<ReportMeta[]> {
      await need(ctx, actor, 'reports.view');
      const v = await loadView(ctx);
      const deliveries = await r.deliveries.list();
      const now = ctx.clock();
      const out: ReportMeta[] = [];
      for (let d = 0; d < 14; d++) {
        const day = new Date(now.getTime() - d * 86400_000);
        const m = buildDailyDigest(v, day).meta;
        out.push({ ...m, deliveries: deliveries.filter((x) => x.kind === 'daily_digest' && x.at.slice(0, 10) === day.toISOString().slice(0, 10)) });
      }
      const w = buildWeeklyReport(v, now).meta;
      const mo = buildMonthlyReport(v, now).meta;
      out.push({ ...w, deliveries: deliveries.filter((x) => x.kind === 'weekly_report' && x.at >= w.periodStart) });
      out.push({ ...mo, deliveries: deliveries.filter((x) => x.kind === 'monthly_report' && x.at >= mo.periodStart) });
      return out.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
    },
    async export(actor: Actor, kind: Kind, format: 'json' | 'csv' | 'md') {
      await need(ctx, actor, 'reports.export');
      if (!['daily', 'weekly', 'monthly'].includes(kind)) throw badRequest('Unknown report kind.');
      if (!['json', 'csv', 'md'].includes(format)) throw badRequest('Format must be json, csv or md.');
      const res = exportReport(kind, format, await build(kind));
      await audit(ctx, actor, 'report.export', 'report', `${kind}-${format}`, `Exported ${kind} report as ${format}`);
      return res;
    },
    async sendManual(actor: Actor, kind: Kind) {
      await need(ctx, actor, 'reports.export');
      return send(actor, kind);
    },
  };
}
export type ReportService = ReturnType<typeof createReportService>;
