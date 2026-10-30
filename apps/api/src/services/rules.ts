import {
  evaluateRule, ruleAppliesTo, validateRule,
  type AiComplianceFlag, type CustomRule, type DryRunResult, type PageTier,
} from '@sentinel/shared';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import { audit, need, notify, seoLead, teamLead, type Actor, type Ctx } from './context';
import type { PageTextDoc } from '../repositories/types';

export type RuleInput = Omit<CustomRule, 'id' | 'createdAt' | 'updatedAt' | 'createdById' | 'source'> & { id?: string };

/** Reject regexes with nested quantifiers — user-defined patterns run server-side over many pages (ReDoS guard). */
export function unsafeRegex(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern) || pattern.length > 500;
}

const MAX_TEXT = 50_000;

/**
 * Custom rules (PDF §10.2), AI-compliance flags and the QA gate (PDF §5 CONT-QA-GATE, §10).
 * LLM-judged rules run only through the configured LLM adapter; otherwise they report evaluated=false — never a fake pass.
 */
export function createRuleService(ctx: Ctx) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();

  function validate(input: RuleInput) {
    const errs = validateRule(input);
    if (input.method === 'regex' && input.pattern && unsafeRegex(input.pattern)) errs.push('Pattern has nested quantifiers (e.g. "(a+)+") or is too long — rewrite it so it cannot hang the scanner.');
    if (errs.length) throw new ApiError(400, 'VALIDATION', errs.join(' '), errs);
  }

  async function evaluate(rule: CustomRule, page: PageTextDoc): Promise<{ evaluated: boolean; flagged: boolean; passage?: string; reason?: string }> {
    const p = { ...page, text: page.text.slice(0, MAX_TEXT) };
    if (rule.method === 'llm_judged') {
      if (!ctx.llm.isConfigured()) return { evaluated: false, flagged: false, reason: 'LLM-judged rule: no LLM provider configured (OPENAI_API_KEY or GEMINI_API_KEY).' };
      const res = await ctx.llm.judge(rule.llmInstruction ?? rule.description, p.text.slice(0, 12_000));
      if (!res.ok) return { evaluated: false, flagged: false, reason: `LLM provider error: ${res.error}` };
      return { evaluated: true, flagged: res.flagged, passage: res.passage, reason: res.reason };
    }
    return evaluateRule(rule, p);
  }

  /** Run enabled rules over pages captured by a crawl → AI-compliance flags (+ QA-gate holds). */
  async function applyToPages(pages: PageTextDoc[]) {
    const rules = (await r.rules.list()).filter((x) => x.enabled);
    let flagged = 0;
    if (!rules.length || !pages.length) return { rules: rules.length, flagged };
    // Existing flags looked up from one read (not one full-collection scan per flagged page).
    const flagKey = (checkId: string, url: string) => `${checkId}\u0000${url}`;
    const existingFlags = new Map<string, AiComplianceFlag>();
    for (const f of await r.aiFlags.list()) if (!existingFlags.has(flagKey(f.checkId, f.url))) existingFlags.set(flagKey(f.checkId, f.url), f);
    for (const rule of rules) {
      for (const page of pages) {
        if (!ruleAppliesTo(rule, page, ctx.clock())) continue;
        const res = await evaluate(rule, page);
        if (!res.evaluated || !res.flagged) continue;
        const existing = existingFlags.get(flagKey(rule.id, page.url));
        if (existing && existing.qaHoldStatus !== 'rejected') continue;
        const flag: AiComplianceFlag = {
          id: await r.aiFlags.nextId('AIF'), checkId: rule.id, ruleName: rule.name, url: page.url, template: page.template, passage: res.passage ?? '',
          explanation: res.reason ?? rule.description, severity: rule.severity, qaHold: rule.action === 'block_qa_gate', qaHoldStatus: rule.action === 'block_qa_gate' ? 'held' : undefined,
          detectedAt: iso(), source: page.source === 'sample' ? 'sample' : 'live',
        };
        await r.aiFlags.insert(flag);
        if (!existingFlags.has(flagKey(flag.checkId, flag.url))) existingFlags.set(flagKey(flag.checkId, flag.url), flag);
        flagged++;
        if (flag.qaHold) await notify(ctx, [await seoLead(ctx), await teamLead(ctx, rule.defaultTeam)], { type: 'review', title: `QA gate hold: ${rule.name}`, body: page.url, link: '/ai-compliance/qa-gate', severity: rule.severity });
      }
    }
    return { rules: rules.length, flagged };
  }

  return {
    applyToPages,

    async listFlags(actor: Actor) {
      await need(ctx, actor, 'modules.view');
      return (await r.aiFlags.list()).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    },
    async decideQaHold(actor: Actor, flagId: string, decision: 'approved' | 'rejected', note: string) {
      await need(ctx, actor, 'qa_gate.approve');
      if (decision !== 'approved' && decision !== 'rejected') throw badRequest('Decision must be approved or rejected.');
      const f = await r.aiFlags.get(flagId);
      if (!f) throw notFound('Flag');
      if (!f.qaHold) throw conflict('This flag does not hold the QA gate.');
      if (f.qaHoldStatus !== 'held') throw conflict(`Already ${f.qaHoldStatus}.`);
      if (!note || note.trim().length < 10) throw badRequest('Record what you verified (at least 10 characters) — this is the human sign-off.');
      f.qaHoldStatus = decision;
      f.qaDecision = { byId: actor.id, byName: actor.name, at: iso(), note: note.trim() };
      await r.aiFlags.update(f);
      await audit(ctx, actor, `qa_gate.${decision}`, 'qa_gate', flagId, `QA gate ${decision} for ${f.url}: ${note.trim()}`);
      return f;
    },

    async list(actor: Actor) {
      await need(ctx, actor, 'rules.view');
      return r.rules.list();
    },
    async save(actor: Actor, input: RuleInput) {
      await need(ctx, actor, 'rules.manage');
      validate(input);
      if (input.id) {
        const cur = await r.rules.get(input.id);
        if (!cur) throw notFound('Rule');
        const changedLogic = ['method', 'pattern', 'flags', 'phrases', 'phraseMode', 'threshold', 'llmInstruction', 'scope'].some((k) => JSON.stringify((cur as never)[k]) !== JSON.stringify((input as never)[k]));
        const next: CustomRule = { ...cur, ...input, id: cur.id, updatedAt: iso(), lastDryRun: changedLogic ? undefined : cur.lastDryRun };
        // Changing the rule logic invalidates the dry run; an enabled rule must be re-tested before it keeps running.
        if (changedLogic && next.enabled) next.enabled = false;
        await r.rules.update(next);
        await audit(ctx, actor, 'rule.update', 'rule', next.id, `Updated rule "${next.name}"${changedLogic && cur.enabled ? ' — logic changed, disabled until a new dry run' : ''}`);
        return next;
      }
      if (input.enabled) throw new ApiError(409, 'DRY_RUN_REQUIRED', 'Save the rule disabled, run a dry run, then enable it (PDF §10.2 test mode).');
      const rule: CustomRule = { ...input, id: await r.rules.nextId('RULE'), createdById: actor.id, createdAt: iso(), updatedAt: iso(), source: 'manual' } as CustomRule;
      await r.rules.insert(rule);
      await audit(ctx, actor, 'rule.create', 'rule', rule.id, `Created rule "${rule.name}"`);
      return rule;
    },
    async remove(actor: Actor, id: string) {
      await need(ctx, actor, 'rules.manage');
      const rule = await r.rules.get(id);
      if (!rule) throw notFound('Rule');
      await r.rules.delete(id);
      await audit(ctx, actor, 'rule.delete', 'rule', id, `Deleted rule "${rule.name}"`);
    },
    async dryRun(actor: Actor, input: RuleInput): Promise<DryRunResult> {
      await need(ctx, actor, 'rules.manage');
      validate(input);
      const rule = { ...input, id: input.id ?? 'draft', createdById: actor.id, createdAt: iso(), updatedAt: iso(), source: 'manual' } as CustomRule;
      const cfg = await r.config.get();
      const windowDays = cfg.thresholds.dryRunWindowDays ?? 30;
      const cutoff = ctx.clock().getTime() - windowDays * 86400_000;
      const all = await r.pageTexts.list();
      const pages = all
        .filter((p) => !p.publishedAt || new Date(p.publishedAt).getTime() >= cutoff)
        .filter((p) => ruleAppliesTo({ ...rule, scope: { ...rule.scope, newlyPublishedOnly: false } }, p, ctx.clock()))
        .slice(0, rule.method === 'llm_judged' ? 25 : 5000);
      const samples: DryRunResult['samples'] = [];
      let flagged = 0;
      let evaluated = true;
      let note: string | undefined;
      for (const p of pages) {
        const res = await evaluate(rule, p);
        if (!res.evaluated) { evaluated = false; note = res.reason; break; }
        if (res.flagged) {
          flagged++;
          if (samples.length < 10) samples.push({ url: p.url, passage: res.passage ?? '', reason: res.reason ?? '' });
        }
      }
      const live = pages.filter((p) => p.source === 'live').length;
      const source = live === pages.length && pages.length > 0 ? 'live' : pages.some((p) => p.source === 'live') ? 'live' : 'sample';
      const res: DryRunResult = {
        ruleId: input.id, ranAt: iso(), pagesScanned: evaluated ? pages.length : 0, pagesFlagged: flagged, windowDays, samples, evaluated,
        note: note ?? `Dry run over ${pages.length} stored page texts (${live} from live crawls, ${pages.length - live} sample) from the last ${windowDays} days. Nothing was flagged in the digest.`,
        source,
      };
      if (input.id) {
        const cur = await r.rules.get(input.id);
        if (cur) await r.rules.update({ ...cur, lastDryRun: res });
      }
      await audit(ctx, actor, 'rule.dry_run', 'rule', input.id ?? 'draft', `Dry run "${input.name}": ${flagged}/${res.pagesScanned} pages flagged${evaluated ? '' : ' (not evaluated)'}`);
      return res;
    },
    async setEnabled(actor: Actor, id: string, enabled: boolean) {
      await need(ctx, actor, 'rules.manage');
      const rule = await r.rules.get(id);
      if (!rule) throw notFound('Rule');
      if (enabled && rule.method === 'llm_judged' && !ctx.llm.isConfigured()) throw new ApiError(409, 'PROVIDER_REQUIRED', 'LLM-judged rules cannot be enabled until an LLM provider (OPENAI_API_KEY or GEMINI_API_KEY) is configured on the server.');
      if (enabled && (!rule.lastDryRun || !rule.lastDryRun.evaluated)) throw new ApiError(409, 'DRY_RUN_REQUIRED', 'Run a successful dry run against the last 30 days of pages before enabling (PDF §10.2 test mode).');
      rule.enabled = enabled;
      rule.updatedAt = iso();
      await r.rules.update(rule);
      await audit(ctx, actor, enabled ? 'rule.enable' : 'rule.disable', 'rule', id, `${enabled ? 'Enabled' : 'Disabled'} "${rule.name}"`);
      return rule;
    },
  };
}
export type RuleService = ReturnType<typeof createRuleService>;
export type { PageTier };
