import type { CustomRule, PageTemplate, PageTier } from '../types';
import { aiLikelihoodHeuristic, escapeRegExp, excerpt, keywordDensity, wordCount } from './text';

export interface RulePage {
  url: string;
  template: PageTemplate;
  tier: PageTier;
  collectionHandle?: string;
  text: string;
  publishedAt?: string;
  duplicationPct?: number; // supplied by duplicate analysis when available
}

export interface RuleEvaluation {
  flagged: boolean;
  evaluated: boolean; // false when the method cannot run (e.g. LLM provider not configured)
  passage?: string;
  reason?: string;
}

export function ruleAppliesTo(rule: CustomRule, page: RulePage, now: Date, newWindowHours = 24): boolean {
  const s = rule.scope;
  if (!s.fullSite) {
    if (s.templates.length && !s.templates.includes(page.template)) return false;
    if (s.collections.length && !(page.collectionHandle && s.collections.includes(page.collectionHandle))) return false;
    if (s.tiers.length && !s.tiers.includes(page.tier)) return false;
  }
  if (s.newlyPublishedOnly) {
    if (!page.publishedAt) return false;
    if (now.getTime() - new Date(page.publishedAt).getTime() > newWindowHours * 3600_000) return false;
  }
  return true;
}

/** Validate a rule definition; returns human-readable errors (empty = valid). */
export function validateRule(rule: Partial<CustomRule>): string[] {
  const errs: string[] = [];
  if (!rule.name || rule.name.trim().length < 3) errs.push('Name must be at least 3 characters.');
  switch (rule.method) {
    case 'regex':
      if (!rule.pattern) errs.push('Regex pattern is required.');
      else {
        try { new RegExp(rule.pattern, rule.flags ?? 'i'); } catch (e) { errs.push(`Invalid regex: ${(e as Error).message}`); }
      }
      break;
    case 'phrase_list':
      if (!rule.phrases?.length) errs.push('At least one phrase is required.');
      if (!rule.phraseMode) errs.push('Choose banned or required.');
      break;
    case 'threshold':
      if (!rule.threshold) errs.push('Threshold metric, operator and value are required.');
      else if (rule.threshold.metric === 'keyword_density' && !rule.threshold.keyword) errs.push('Keyword density rules need a keyword.');
      break;
    case 'llm_judged':
      if (!rule.llmInstruction || rule.llmInstruction.trim().length < 15) errs.push('Write the plain-language instruction (≥15 characters).');
      break;
    default:
      errs.push('Detection method is required.');
  }
  if (rule.scope && !rule.scope.fullSite && !rule.scope.templates?.length && !rule.scope.collections?.length && !rule.scope.tiers?.length && !rule.scope.newlyPublishedOnly) {
    errs.push('Choose a scope (templates, collections, tiers, newly published) or full site.');
  }
  if (rule.action === 'block_qa_gate' && rule.scope && !rule.scope.newlyPublishedOnly && rule.schedule !== 'on_publish') {
    errs.push('"Block in publish QA gate" applies to new pages only — set scope to newly published or schedule to on-publish.');
  }
  return errs;
}

/**
 * Evaluate a deterministic rule against a page. LLM-judged rules return
 * evaluated=false here; the backend LLM adapter evaluates them when a provider is configured.
 */
export function evaluateRule(rule: CustomRule, page: RulePage): RuleEvaluation {
  const text = page.text;
  switch (rule.method) {
    case 'regex': {
      const re = new RegExp(rule.pattern!, rule.flags ?? 'i');
      const m = re.exec(text);
      return m ? { flagged: true, evaluated: true, passage: excerpt(text, m.index, m[0].length), reason: `Matches /${rule.pattern}/` } : { flagged: false, evaluated: true };
    }
    case 'phrase_list': {
      const phrases = rule.phrases ?? [];
      if (rule.phraseMode === 'banned') {
        for (const p of phrases) {
          const m = new RegExp(`\\b${escapeRegExp(p)}\\b`, 'i').exec(text);
          if (m) return { flagged: true, evaluated: true, passage: excerpt(text, m.index, m[0].length), reason: `Banned phrase "${p}"` };
        }
        return { flagged: false, evaluated: true };
      }
      const missing = phrases.filter((p) => !new RegExp(`\\b${escapeRegExp(p)}\\b`, 'i').test(text));
      return missing.length === phrases.length && phrases.length
        ? { flagged: true, evaluated: true, passage: excerpt(text, 0, 0, 120), reason: `None of the required phrases present: ${missing.join(', ')}` }
        : { flagged: false, evaluated: true };
    }
    case 'threshold': {
      const t = rule.threshold!;
      let value: number | undefined;
      if (t.metric === 'word_count') value = wordCount(text);
      else if (t.metric === 'keyword_density') value = keywordDensity(text, t.keyword ?? '');
      else if (t.metric === 'ai_likelihood') value = aiLikelihoodHeuristic(text);
      else if (t.metric === 'duplication_pct') value = page.duplicationPct;
      if (value === undefined) return { flagged: false, evaluated: false, reason: 'Duplication % not available for this page (duplicate analysis has not run).' };
      const hit = compare(value, t.operator, t.value);
      return hit ? { flagged: true, evaluated: true, passage: excerpt(text, 0, 0, 120), reason: `${t.metric} = ${value} ${t.operator} ${t.value}` } : { flagged: false, evaluated: true };
    }
    case 'llm_judged':
      return { flagged: false, evaluated: false, reason: 'LLM-judged rule requires a configured LLM provider (OPENAI_API_KEY or GEMINI_API_KEY).' };
  }
}

function compare(v: number, op: '<' | '>' | '<=' | '>=', target: number) {
  switch (op) {
    case '<': return v < target;
    case '>': return v > target;
    case '<=': return v <= target;
    case '>=': return v >= target;
  }
}

/** PDF §10.2 day-one example rules, used to seed the rule builder. */
export const EXAMPLE_RULES: Omit<CustomRule, 'id' | 'createdById' | 'createdAt' | 'updatedAt' | 'source'>[] = [
  {
    name: 'Unsupported "lowest price in India" claim', description: 'Flag copy claiming lowest price in India (PDF §10.2 example).',
    method: 'regex', pattern: 'lowest\\s+price\\s+in\\s+india|cheapest\\s+in\\s+india', flags: 'i',
    scope: { templates: ['product', 'collection', 'blog_article'], collections: [], tiers: [], newlyPublishedOnly: false, fullSite: false },
    severity: 'medium', defaultTeam: 'content', action: 'flag_and_rewrite', schedule: 'daily', enabled: true,
  },
  {
    name: 'Missing No-MOQ mention on wholesale collections', description: 'Flag any description missing the No-MOQ mention on wholesale collections (PDF §10.2 example).',
    method: 'phrase_list', phrases: ['no moq', 'no minimum order', 'no minimum order quantity'], phraseMode: 'required',
    scope: { templates: ['collection'], collections: [], tiers: [1, 2], newlyPublishedOnly: false, fullSite: false },
    severity: 'low', defaultTeam: 'content', action: 'flag_and_rewrite', schedule: 'daily', enabled: true,
  },
  {
    name: 'Machine-translated Hindi/Hinglish copy', description: 'Flag Hindi/Hinglish AI translations that read machine-translated (PDF §10.2 example).',
    method: 'llm_judged', llmInstruction: 'Flag any Hindi or Hinglish product/collection copy that reads as literal machine translation: unnatural word order, English idioms translated word-for-word, or inconsistent script mixing.',
    scope: { templates: ['product', 'collection'], collections: [], tiers: [], newlyPublishedOnly: false, fullSite: false },
    severity: 'medium', defaultTeam: 'content', action: 'flag_and_rewrite', schedule: 'weekly', enabled: false,
  },
  {
    name: 'Festival-offer copy live after the festival', description: 'Flag festival-offer copy still live after the festival date (PDF §10.2 example).',
    method: 'regex', pattern: '(diwali|rakhi|raksha bandhan|holi)\\s+(sale|offer|special|discount)', flags: 'i',
    scope: { templates: [], collections: [], tiers: [], newlyPublishedOnly: false, fullSite: true },
    severity: 'low', defaultTeam: 'content', action: 'flag', schedule: 'daily', enabled: true,
  },
  {
    name: 'Unapproved delivery-timeline promises', description: 'LLM-judged example from PDF §10.2: ops has not approved delivery promises in copy.',
    method: 'llm_judged', llmInstruction: "Flag any product description that promises delivery timelines, since ops hasn't approved delivery promises in copy.",
    scope: { templates: ['product'], collections: [], tiers: [], newlyPublishedOnly: true, fullSite: false },
    severity: 'medium', defaultTeam: 'content', action: 'block_qa_gate', schedule: 'on_publish', enabled: false,
  },
];
