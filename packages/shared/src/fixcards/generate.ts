import type { DraftVariant, FixCard, FixStep, Issue, SentinelConfig, TeamId } from '../types';
import { getCheck } from '../checks/library';
import { PLAYBOOK_BY_CHECK, type Playbook } from './playbook';
import { priorityScore } from '../rules/priority';
import { TEAMS } from '../config';

export interface FixCardContext {
  now?: Date;
  pageName?: string;
  primaryKeyword?: string;
  redirectTarget?: string;
  appName?: string;
}

/**
 * Smart Recommendation Engine (PDF §11):
 *  1 context assembly → 2 root-cause inference → 3 fix selection (playbook) →
 *  4 prioritization (Impact × Confidence × inverse Effort, tie → tier) → owner → verification.
 */
export function generateFixCard(issue: Issue, cfg: SentinelConfig, ctx: FixCardContext = {}): FixCard {
  const check = getCheck(issue.checkId);
  const pb: Playbook = PLAYBOOK_BY_CHECK[issue.checkId] ?? genericPlaybook(issue);
  const rootCause = inferRootCause(issue);
  const confidence = rootCause ? rootCause.confidence : evidenceConfidence(issue);

  // Impact scales with tier and reach; playbook impactScore is the base for Tier 1.
  const tierAdj = issue.highestTier === 1 ? 0 : issue.highestTier === 2 ? -1 : -2;
  const reachAdj = issue.affectedCount >= 100 ? 1 : 0;
  const impactScore = clamp(pb.impactScore + tierAdj + reachAdj, 1, 5);
  const effortHours = issue.isTemplateGroup ? pb.effortHours : pb.effortHours * Math.min(4, Math.max(1, Math.ceil(issue.affectedCount / 25)));
  const prio = priorityScore({ impactScore, confidence, effortHours, tier: issue.highestTier }, cfg);

  const interp = (t: string) =>
    t
      .replace(/\{\{count\}\}/g, String(issue.affectedCount))
      .replace(/\{\{url\}\}/g, issue.affectedUrls[0] ?? '')
      .replace(/\{\{template\}\}/g, issue.template ?? 'page')
      .replace(/\{\{target\}\}/g, ctx.redirectTarget ?? 'the parent collection')
      .replace(/\{\{app\}\}/g, ctx.appName ?? String(issue.evidence.find((e) => e.data?.app)?.data?.app ?? 'the app named in Evidence'));
  const steps: FixStep[] = pb.steps.map((st) => ({ ...st, text: interp(st.text) }));

  const owner: TeamId = pb.owner ?? check.ownerTeam;
  const recurrence = {
    occurrences: issue.occurrences,
    processRecommendation:
      pb.processRecommendationAfter && issue.occurrences >= pb.processRecommendationAfter.occurrences
        ? `${ordinal(issue.occurrences)} occurrence — ${pb.processRecommendationAfter.text}`
        : issue.occurrences >= 4
          ? `${ordinal(issue.occurrences)} occurrence of this issue type — add a prevention step to the relevant SOP.`
          : undefined,
  };

  const drafts = buildDrafts(issue, ctx);
  const card: FixCard = {
    issueId: issue.id,
    severity: issue.severity,
    title: issue.title,
    whatsWrong: issue.summary,
    whyItMatters: `${pb.whyItMatters}${issue.businessImpact ? ` ${issue.businessImpact}` : ''}`,
    affectedUrls: issue.affectedUrls,
    affectedCount: issue.affectedCount,
    tierSummary: `Tier 1: ${issue.tierBreakdown[1]} · Tier 2: ${issue.tierBreakdown[2]} · Tier 3: ${issue.tierBreakdown[3]}`,
    evidence: issue.evidence,
    rootCause,
    steps,
    alternatives: pb.alternatives ?? [],
    shopifyContext: pb.shopifyContext ?? 'Paths and theme file names follow Shopify Online Store 2.0 conventions — confirm file names in DeoDap\'s live theme before editing.',
    ownerSuggestion: owner,
    ownerReason: pb.ownerReason ?? ownerReasonFor(owner),
    effortHours: round(effortHours),
    expectedImpact: impactScore >= 4 ? 'high' : impactScore >= 3 ? 'medium' : 'low',
    impactScore,
    confidence: round(confidence),
    priorityScore: prio,
    slaDueAt: issue.slaDueAt,
    verifyBy: pb.verifyBy,
    acceptanceCriteria: pb.acceptance,
    recurrence,
    drafts: drafts.variants,
    faqDrafts: drafts.faqs,
    outline: drafts.outline,
    targetEntities: drafts.entities,
    requiresHumanApproval: pb.requiresHumanApproval,
    playbookId: pb.id,
    generatedAt: (ctx.now ?? new Date()).toISOString(),
    completeness: { complete: true, missing: [] },
  };
  card.completeness = fixCardCompleteness(card);
  return card;
}

/** "Every issue carries a complete Fix Card" (PDF §16 acceptance). */
export function fixCardCompleteness(c: FixCard): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.whatsWrong) missing.push("What's wrong");
  if (!c.whyItMatters) missing.push('Why it matters');
  if (!c.affectedUrls.length) missing.push('Affected URLs');
  if (!c.evidence.length) missing.push('Evidence');
  if (!c.steps.length) missing.push('Exact fix steps');
  if (!c.ownerSuggestion) missing.push('Owner suggestion');
  if (!(c.effortHours > 0)) missing.push('Effort');
  if (!c.verifyBy) missing.push('Verification procedure');
  if (!c.acceptanceCriteria.length) missing.push('Acceptance criteria');
  if (!c.slaDueAt) missing.push('SLA deadline');
  return { complete: missing.length === 0, missing };
}

/** Root-cause inference (PDF §11 step 2). Returns null rather than guessing when evidence is insufficient. */
export function inferRootCause(issue: Issue): FixCard['rootCause'] {
  const data = Object.assign({}, ...issue.evidence.map((e) => e.data ?? {})) as Record<string, unknown>;
  if ((issue.checkId === 'TECH-4XX' || issue.checkId === 'TECH-DISCONTINUED') && typeof data.shopifyDraftedCount === 'number') {
    const drafted = data.shopifyDraftedCount as number;
    if (drafted >= Math.ceil(issue.affectedCount * 0.5)) {
      return {
        text: `${drafted} of ${issue.affectedCount} URLs belong to products set to draft/deleted (Shopify webhook) — catalog cleanup without redirects, not a server issue.`,
        confidence: 0.9, basis: 'Shopify products/update webhooks matched to the 404 URLs',
      };
    }
  }
  if (issue.checkId === 'TECH-SCHEMA-ERRORS' && data.priceMismatch && data.changedAfter) {
    return {
      text: `Theme schema snippet reads product.price instead of product.selected_or_first_available_variant.price after ${String(data.changedAfter)}.`,
      confidence: 0.8, basis: 'JSON-LD offers.price vs rendered price on sampled URLs + change date',
    };
  }
  if (issue.checkId === 'PERF-RENDER-BLOCKING' && data.app) {
    return { text: `New render-blocking script from ${String(data.app)} (${String(data.scriptHost ?? 'host in evidence')}) first seen in today's script diff.`, confidence: 0.85, basis: 'Daily script-list diff' };
  }
  if (issue.checkId === 'TECH-NOINDEX' && data.xRobotsTag) {
    return { text: 'noindex is delivered via X-Robots-Tag header (not theme meta) — likely an app or proxy setting.', confidence: 0.7, basis: 'HTTP response headers' };
  }
  if (issue.isTemplateGroup && issue.template) {
    return { text: `A single defect in the ${issue.template} template is producing the same failure on ${issue.affectedCount} pages.`, confidence: 0.85, basis: `${issue.childIssueIds?.length ?? 0} related issues on one template (PDF §3.3)` };
  }
  return null;
}

function evidenceConfidence(issue: Issue): number {
  const live = issue.evidence.some((e) => e.source === 'live');
  const n = issue.evidence.length;
  return clamp((live ? 0.6 : 0.5) + Math.min(0.3, n * 0.1), 0.3, 0.9);
}

function genericPlaybook(issue: Issue): Playbook {
  const c = getCheck(issue.checkId);
  return {
    id: `PB-GENERIC-${c.id}`, checkId: c.id, title: c.name,
    whyItMatters: `${c.name}: ${c.detects}`,
    steps: [
      { order: 1, text: `Review the evidence and affected URLs for "${c.name}".` },
      { order: 2, text: `Apply the remediation appropriate to: ${c.detects}` },
      { order: 3, text: 'Record what was changed in the task comments so verification can be traced.' },
    ],
    effortHours: 2, impact: 'medium', impactScore: 3,
    verifyBy: `Next ${c.cadence} run of "${c.name}" no longer reports the affected URLs.`,
    acceptance: [`"${c.name}" passes for all affected URLs`],
    requiresHumanApproval: false,
  };
}

const USPS = ['No MOQ', 'Wholesale Price', 'COD Available', 'Fast Shipping'];

/** Heuristic CTR score for title/meta variants. Labelled as an estimate everywhere it is shown. */
export function heuristicCtrScore(text: string, keyword?: string, kind: 'title' | 'meta' = 'title'): number {
  let sc = 50;
  const lower = text.toLowerCase();
  if (keyword && lower.slice(0, 35).includes(keyword.toLowerCase())) sc += 15;
  else if (keyword && lower.includes(keyword.toLowerCase())) sc += 7;
  if (USPS.some((u) => lower.includes(u.toLowerCase()))) sc += 10;
  if (/\d/.test(text)) sc += 5;
  const len = text.length;
  if (kind === 'title') {
    if (len >= 45 && len <= 60) sc += 10;
    if (len > 60) sc -= 20;
    if (len < 30) sc -= 10;
  } else {
    if (len >= 120 && len <= 160) sc += 10;
    if (len > 160) sc -= 15;
    if (len < 70) sc -= 10;
  }
  return clamp(sc, 0, 100);
}

function buildDrafts(issue: Issue, ctx: FixCardContext) {
  const name = ctx.pageName ?? 'Product';
  const kw = ctx.primaryKeyword ?? name.toLowerCase();
  const basis = 'Heuristic estimate (keyword position, USP, length) — not a measured CTR';
  const out: { variants?: DraftVariant[]; faqs?: { q: string; a: string }[]; outline?: string[]; entities?: string[] } = {};
  if (['ONP-TITLE', 'ONP-LOW-CTR', 'ONP-KEYWORD-MAP'].includes(issue.checkId)) {
    const titles = [
      `${cap(kw)} – Wholesale Price, No MOQ | DeoDap`,
      `Buy ${name} in Bulk – COD & Fast Shipping | DeoDap`,
      `${name} Wholesale India – No Minimum Order | DeoDap`,
    ];
    const metas = [
      `Shop ${name} at wholesale prices with No MOQ. COD available and fast shipping across India. Order 1 piece or 1,000 from DeoDap.`,
      `${cap(kw)} for resellers and dropshippers – wholesale pricing, no minimum order, cash on delivery and quick dispatch from DeoDap.`,
      `Looking for ${kw}? DeoDap offers wholesale rates, No MOQ, COD and fast shipping on ${name}. Browse specs, bulk pricing and reviews.`,
    ];
    out.variants = titles.map((t, i) => ({
      label: `Variant ${String.fromCharCode(65 + i)}`, title: t, meta: metas[i],
      score: Math.round((heuristicCtrScore(t, kw, 'title') + heuristicCtrScore(metas[i], kw, 'meta')) / 2), scoreBasis: basis,
    }));
  }
  if (issue.checkId === 'ONP-META') {
    const metas = [
      `Shop ${name} at wholesale prices with No MOQ. COD available and fast shipping across India.`,
      `${cap(kw)} at DeoDap – wholesale rates, no minimum order, cash on delivery, quick dispatch.`,
      `Buy ${name} in any quantity: wholesale pricing, No MOQ, COD and fast shipping from DeoDap.`,
    ];
    out.variants = metas.map((m, i) => ({ label: `Variant ${String.fromCharCode(65 + i)}`, meta: m, score: heuristicCtrScore(m, kw, 'meta'), scoreBasis: basis }));
  }
  if (['TECH-THIN', 'ONP-TPL-COLLECTION', 'CONT-QUALITY', 'CONT-DECAY'].includes(issue.checkId)) {
    out.outline = [
      `Intro (40–60 words): what the ${name} range covers and who buys it wholesale`,
      'Key product types and use cases (H2)',
      'How to choose: sizes, materials, pack quantities (H2)',
      'Wholesale & dropshipping benefits: No MOQ, COD, fast shipping (H2)',
      'FAQs (3–5 questions, ≤60-word answers)',
    ];
    out.entities = [kw, 'wholesale', 'bulk buying', 'dropshipping', 'India', 'COD', 'GST invoice'];
  }
  if (['AEO-FAQ', 'AEO-ANSWER-BLOCK', 'ONP-TPL-COLLECTION'].includes(issue.checkId)) {
    out.faqs = [
      { q: `Is there a minimum order quantity for ${name}?`, a: `No. DeoDap has no minimum order quantity — you can order a single piece at wholesale pricing or buy in bulk for resale.` },
      { q: `Do you offer cash on delivery?`, a: 'Yes, cash on delivery is available on eligible pin codes across India; prepaid orders may ship faster.' },
      { q: `Can I dropship ${name} from DeoDap?`, a: 'Yes. Resellers can list DeoDap products and we ship directly to their customers. See the dropshipping page for details.' },
    ];
  }
  return out;
}

function ownerReasonFor(t: TeamId): string {
  switch (t) {
    case 'development': return `Theme/Liquid/app/server work → ${TEAMS.development.name}.`;
    case 'content': return `Copy, metadata, FAQs or briefs → ${TEAMS.content.name}.`;
    case 'seo': return `Strategy, schema decisions, redirects, links or keyword work → ${TEAMS.seo.name}.`;
  }
}

const cap = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100) / 100;
function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
