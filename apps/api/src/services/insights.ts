import {
  CHECKS_BY_ID, buildDashboard, buildModuleData, computeHealthScore, seasonalPlan,
  type AuditModule, type BrandMention, type ContentBrief, type IntegrationId, type KeywordGap,
} from '@sentinel/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { ApiError } from '../lib/errors';
import { audit, loadView, need, type Actor, type Ctx } from './context';

const MODULES: AuditModule[] = ['technical', 'performance', 'content', 'onpage', 'offpage', 'aeo', 'geo', 'ai_compliance'];

/**
 * Read models + opportunity/off-page workflows (PDF §5–§9, §13). Every metric-backed response states its provenance:
 * DEMO seed data is labelled; without DEMO data and without a connected source, `available: false` with the reason.
 */
export function createInsightService(ctx: Ctx) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();

  async function availability(ids: IntegrationId[], label: string, hasData: boolean) {
    const m = await r.metrics.get();
    const connected = (await Promise.all(ids.map((i) => ctx.integrations.isConnected(i)))).some(Boolean);
    if (m.source === 'demo' && hasData) return { available: true, note: `DEMO data — ${label}.` };
    if (connected && hasData) return { available: true, note: undefined };
    if (connected) return { available: false, note: `${label}: connection test passed, but no data has been synced yet.` };
    return { available: false, note: `Not available: ${label}. Configure and test the connection under Settings → Integrations.` };
  }

  return {
    // ---------------------------------------------------------------- dashboard, health, modules
    async dashboard(actor: Actor) {
      await need(ctx, actor, 'dashboard.view');
      return buildDashboard(await loadView(ctx), ctx.clock());
    },
    async healthHistory(actor: Actor, days: number) {
      await need(ctx, actor, 'dashboard.view');
      if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest('days must be an integer between 1 and 365.');
      return (await r.metrics.get()).healthHistory.slice(-days);
    },
    async healthScore(actor: Actor) {
      await need(ctx, actor, 'dashboard.view');
      const v = await loadView(ctx);
      return computeHealthScore(v.issues, v.siteSize, v.config, ctx.clock());
    },
    async listChecks(actor: Actor) {
      await need(ctx, actor, 'modules.view');
      return Object.values(CHECKS_BY_ID);
    },
    async module(actor: Actor, m: AuditModule) {
      await need(ctx, actor, 'modules.view');
      if (!MODULES.includes(m)) throw badRequest('Unknown module.');
      const v = await loadView(ctx);
      return buildModuleData(v, m, ctx.clock(), (await r.metrics.get()).source === 'demo');
    },
    async cwv(actor: Actor) { await need(ctx, actor, 'modules.view'); return (await r.metrics.get()).cwv; },
    async contentScores(actor: Actor) { await need(ctx, actor, 'modules.view'); return (await r.metrics.get()).contentScores; },

    // ---------------------------------------------------------------- opportunities
    async listOpportunities(actor: Actor) {
      await need(ctx, actor, 'opportunities.view');
      return (await r.opportunities.list()).sort((a, b) => b.value - a.value);
    },
    async dismissOpportunity(actor: Actor, id: string) {
      await need(ctx, actor, 'opportunities.manage');
      const o = await r.opportunities.get(id);
      if (!o) throw notFound('Opportunity');
      if (o.status === 'task_created') throw conflict(`Already converted to ${o.taskId}.`);
      o.status = 'dismissed';
      await r.opportunities.update(o);
      await audit(ctx, actor, 'opportunity.dismiss', 'opportunity', id, `Dismissed ${o.title}`);
      return o;
    },
    async keywordGaps(actor: Actor) {
      await need(ctx, actor, 'opportunities.view');
      const items = await r.keywordGaps.list();
      return { items, ...(await availability(['backlinks'], 'keyword gaps require an Ahrefs or Semrush API subscription', items.length > 0)) };
    },
    async updateKeywordGap(actor: Actor, id: string, status: KeywordGap['status']) {
      await need(ctx, actor, 'opportunities.manage');
      if (!['new', 'approved', 'rejected', 'brief_created', 'task_created'].includes(status)) throw badRequest('Unknown status.');
      const g = await r.keywordGaps.get(id);
      if (!g) throw notFound('Keyword gap');
      g.status = status;
      await r.keywordGaps.update(g);
      await audit(ctx, actor, 'opportunity.keyword_gap', 'opportunity', id, `${g.keyword} → ${status}`);
      return g;
    },
    async striking(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return (await r.metrics.get()).striking; },
    async ctrRewrites(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return (await r.metrics.get()).ctrRewrites; },
    async listBriefs(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return r.briefs.list(); },
    async getBrief(actor: Actor, id: string) {
      await need(ctx, actor, 'opportunities.view');
      const b = await r.briefs.get(id);
      if (!b) throw notFound('Brief');
      return b;
    },
    async saveBrief(actor: Actor, brief: ContentBrief) {
      await need(ctx, actor, 'opportunities.manage');
      if (!brief || !brief.title?.trim() || !brief.targetKeyword?.trim()) throw badRequest('Title and target keyword are required.');
      if (!brief.suggestedUrl?.startsWith('/')) throw badRequest('Suggested URL must be a site path starting with "/".');
      if (!['draft', 'approved', 'in_production', 'published'].includes(brief.status)) throw badRequest('Unknown brief status.');
      const existing = brief.id ? await r.briefs.get(brief.id) : undefined;
      const saved: ContentBrief = { ...brief, id: existing?.id ?? (await r.briefs.nextId('BRF')), updatedAt: iso(), source: existing?.source ?? 'manual' };
      await r.briefs.upsert(saved);
      await audit(ctx, actor, 'brief.save', 'brief', saved.id, `Saved brief "${saved.title}" (${saved.status})`);
      return saved;
    },
    async briefFromGap(actor: Actor, gapId: string) {
      await need(ctx, actor, 'opportunities.manage');
      const g = await r.keywordGaps.get(gapId);
      if (!g) throw notFound('Keyword gap');
      if (g.status !== 'approved') throw new ApiError(409, 'NOT_APPROVED', 'Approve the keyword gap before generating a brief (PDF §13: each approved gap generates a brief).');
      const slug = g.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const b: ContentBrief = {
        id: await r.briefs.nextId('BRF'), title: `${g.keyword.replace(/\b\w/g, (m) => m.toUpperCase())}: guide for resellers`, targetKeyword: g.keyword, cluster: g.relevantCategory ?? 'General',
        intent: g.intent, suggestedUrl: g.intent === 'transactional' ? `/collections/${slug}` : `/blogs/news/${slug}`, pageType: g.intent === 'transactional' ? 'collection' : g.intent === 'commercial' ? 'buying_guide' : 'blog',
        outline: ['Direct answer / intro (40–60 words)', `What buyers look for in ${g.keyword}`, 'Wholesale pricing, pack sizes and No MOQ', 'How to order (COD, shipping)', 'FAQ'],
        entities: [g.keyword, 'wholesale', 'No MOQ', 'COD', g.relevantCategory ?? ''].filter(Boolean),
        faqs: [{ q: `What is the minimum order for ${g.keyword}?` }, { q: 'Do you ship across India?' }],
        internalLinks: g.relevantCategory ? [{ from: `/collections/${g.relevantCategory.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, anchor: g.keyword }] : [],
        origin: 'keyword_gap', originRef: g.id, status: 'draft', updatedAt: iso(), source: g.source === 'demo' ? 'demo' : 'manual',
      };
      await r.briefs.insert(b);
      g.status = 'brief_created';
      await r.keywordGaps.update(g);
      await audit(ctx, actor, 'brief.generate', 'brief', b.id, `Generated brief from gap ${g.id} (${g.keyword}) — outline is a template; a SERP-based outline requires the backlink/SERP API.`);
      return b;
    },
    async clusters(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return (await r.metrics.get()).clusters; },
    async seasonal(actor: Actor) {
      await need(ctx, actor, 'opportunities.view');
      const cfg = await r.config.get();
      const collections = (await r.sitePages.list()).filter((p) => p.template === 'collection').map((p) => ({ title: p.title, url: p.url }));
      return { festivals: seasonalPlan(cfg.festivals, collections, cfg.thresholds.festivalLeadDays, ctx.clock()), leadDays: cfg.thresholds.festivalLeadDays };
    },

    // ---------------------------------------------------------------- off-page, competitors, local, AI visibility
    async backlinks(actor: Actor) {
      await need(ctx, actor, 'modules.view');
      const m = await r.metrics.get();
      return { items: m.backlinks, trend: m.refTrend, ...(await availability(['backlinks'], 'backlink data requires the Ahrefs or Semrush API', m.backlinks.length > 0)) };
    },
    async prospects(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return r.prospects.list(); },
    async mentions(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return r.mentions.list(); },
    async updateMention(actor: Actor, id: string, status: BrandMention['status']) {
      await need(ctx, actor, 'opportunities.manage');
      if (!['new', 'outreach', 'reclaimed', 'ignored'].includes(status)) throw badRequest('Unknown status.');
      const m = await r.mentions.get(id);
      if (!m) throw notFound('Mention');
      m.status = status;
      await r.mentions.update(m);
      await audit(ctx, actor, 'opportunity.mention', 'opportunity', id, `Brand mention ${m.domain} → ${status}`);
      return m;
    },
    async disavow(actor: Actor) { await need(ctx, actor, 'modules.view'); return r.disavow.list(); },
    async decideDisavow(actor: Actor, id: string, decision: 'approved' | 'rejected') {
      await need(ctx, actor, 'disavow.approve');
      if (decision !== 'approved' && decision !== 'rejected') throw badRequest('Decision must be approved or rejected.');
      const d = await r.disavow.get(id);
      if (!d) throw notFound('Candidate');
      if (d.approval !== 'pending') throw conflict(`Already ${d.approval}.`);
      d.approval = decision;
      d.decidedById = actor.id;
      d.decidedAt = iso();
      await r.disavow.update(d);
      await audit(ctx, actor, `disavow.${decision === 'approved' ? 'approve' : 'reject'}`, 'disavow', id, `${decision} ${d.domain} — Sentinel does not submit to Google; upload the approved file in GSC manually.`);
      return d;
    },
    async competitors(actor: Actor) { await need(ctx, actor, 'opportunities.view'); return (await r.metrics.get()).competitors; },
    async localHealth(actor: Actor) {
      await need(ctx, actor, 'modules.view');
      const m = await r.metrics.get();
      return { ...m.localHealth, ...(await availability(['gbp'], 'local signals require the Google Business Profile API', !!m.localHealth.gbp || m.localHealth.napConsistency.length > 0)) };
    },
    async aiVisibility(actor: Actor) {
      await need(ctx, actor, 'modules.view');
      const m = await r.metrics.get();
      return { prompts: m.aiPrompts, trend: m.aiTrend, ...(await availability(['openai', 'gemini', 'perplexity'], 'the weekly AI-visibility panel requires OpenAI / Gemini / Perplexity API keys', m.aiPrompts.length > 0)) };
    },
  };
}
export type InsightService = ReturnType<typeof createInsightService>;
