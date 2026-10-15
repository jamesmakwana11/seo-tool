/**
 * AEO (PDF §8) and GEO (PDF §9) analyzers that can be evaluated from crawl data.
 */
import type { Finding } from '../services/ports';
import { wordCount } from '@sentinel/shared';
import { groupFor, isAllowed } from '../crawler/robots';
import type { ParsedPage } from '../crawler/types';
import { pathOf, sameUrl } from '../crawler/url';
import { UTILITY_PAGE } from './technical';
import { aggregate, htmlEv, metricEv, perTemplate, textEv, trunc, type AnalyzerResult, type Ev, type Prepared, type Problem } from './context';
import { hasType, nodesOfType } from './schema';

const NOT = (reason: string): AnalyzerResult => ({ evaluated: false, findings: [], reason });

// ------------------------------------------------------------------------------------------------ AEO-ANSWER-BLOCK

export function analyzeAnswerBlock(prep: Prepared): AnalyzerResult {
  const min = prep.ctx.thresholds.answerBlockMinWords ?? 40;
  const max = prep.ctx.thresholds.answerBlockMaxWords ?? 60;
  const pages = prep.content.filter((p) => p.tier <= 2 && ['collection', 'product', 'blog_article', 'page', 'home'].includes(p.template) && !UTILITY_PAGE.test(pathOf(p.url)));
  return perTemplate(prep, pages, 'AEO-ANSWER-BLOCK', 'no answer block', (p) => {
    const qh2 = p.html!.questionHeadings.filter((q) => q.level === 2);
    const good = qh2.find((q) => q.firstAnswerWords >= min && q.firstAnswerWords <= max);
    if (good) return [];
    if (!qh2.length) return [{ label: `lack a question-formatted H2 with a direct ${min}–${max} word answer`, evidence: [htmlEv(p.url, 'H2s on page', p.html!.headings.filter((h) => h.level === 2).map((h) => `<h2>${h.text}</h2>`).join('\n') || '(no H2)')] }];
    return [{
      label: `have question H2s but no ${min}–${max} word direct answer beneath them`,
      evidence: qh2.slice(0, 3).map((q) => textEv(p.url, `"${trunc(q.text, 80)}" → ${q.firstAnswerWords} words`, q.firstAnswer || '(no paragraph directly under the heading)', { words: q.firstAnswerWords, min, max })),
    }];
  });
}

// ------------------------------------------------------------------------------------------------ AEO-FAQ

export function analyzeFaq(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => ['collection', 'product', 'blog_article', 'page'].includes(p.template));
  return perTemplate(prep, pages, 'AEO-FAQ', 'FAQ gaps', (p) => {
    const f = p.html!.faq;
    const out: { label: string; evidence?: Ev[] }[] = [];
    if (!f.present) {
      if (p.template === 'collection' || p.template === 'product') out.push({ label: 'missing an FAQ block' });
      return out;
    }
    if (!hasType(p, 'FAQPage')) out.push({ label: 'with an FAQ block but no FAQPage schema', evidence: [htmlEv(p.url, `${f.items.length} visible Q&A, no FAQPage JSON-LD`, f.items.slice(0, 4).map((i) => `Q: ${i.q}`).join('\n'))] });
    const long = f.items.filter((i) => wordCount(i.a) > 80);
    if (long.length) out.push({ label: 'with FAQ answers too long for extraction (>80 words)', evidence: long.slice(0, 3).map((i) => textEv(p.url, `"${trunc(i.q, 80)}" → ${wordCount(i.a)} words`, i.a)) });
    const vague = f.items.filter((i) => wordCount(i.a) > 0 && wordCount(i.a) < 6);
    if (vague.length) out.push({ label: 'with vague FAQ answers (<6 words)', evidence: vague.slice(0, 3).map((i) => textEv(p.url, `"${trunc(i.q, 80)}"`, i.a)) });
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ AEO-EXTRACTABILITY (metric)

export function extractabilityScore(p: ParsedPage): { score: number; parts: Record<string, boolean> } {
  const f = p.html!.features;
  const parts = {
    definitionSentence: !!f.definitionSentence,
    comparisonTable: f.dataTables > 0 && !f.specTable ? true : f.dataTables > 1,
    numberedSteps: f.orderedLists > 0,
    specTable: f.specTable,
    questionHeadings: p.html!.questionHeadings.length > 0,
  };
  const weights = { definitionSentence: 25, comparisonTable: 20, numberedSteps: 20, specTable: 20, questionHeadings: 15 };
  const score = Object.entries(parts).reduce((n, [k, v]) => n + (v ? weights[k as keyof typeof weights] : 0), 0);
  return { score, parts };
}

export function analyzeExtractability(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => ['collection', 'product', 'blog_article', 'page', 'home'].includes(p.template) && !UTILITY_PAGE.test(pathOf(p.url)));
  return perTemplate(prep, pages, 'AEO-EXTRACTABILITY', 'no quotable formats', (p) => {
    const { score, parts } = extractabilityScore(p);
    if (score >= 20 || p.tier > 2) return [];
    return [{ label: 'have no quotable format (definition sentence, comparison table, numbered steps, spec table)', evidence: [metricEv(`extractability ${score}/100`, { score, ...parts }, p.url)] }];
  }, (_t, list) => {
    // Template average over every examined page (the finding's severity metric).
    const scores = list.map((p) => ({ url: p.url, ...extractabilityScore(p) }));
    const avg = Math.round(scores.reduce((n, s) => n + s.score, 0) / Math.max(1, scores.length));
    return { severityContext: { metric: avg }, extraEvidence: [metricEv(`template average extractability ${avg}/100`, { average: avg, pages: scores.slice(0, 50).map((s) => ({ url: s.url, score: s.score })) })] };
  });
}

// ------------------------------------------------------------------------------------------------ AEO-ENTITY

export function analyzeEntity(prep: Prepared): AnalyzerResult {
  const home = prep.ok.find((p) => p.template === 'home');
  if (!home) return NOT('homepage not crawled');
  const orgs = ['Organization', 'OnlineStore', 'Corporation', 'Store', 'LocalBusiness'].flatMap((t) => nodesOfType(home, t));
  const org = orgs[0];
  const problems: Problem[] = [];
  const url = home.url;
  if (!org) problems.push({ label: 'no Organization schema on the homepage', urls: [url], evidence: [{ kind: 'jsonld', label: 'types present', url, content: home.html!.schemaTypes.join(', ') || 'none' }] });
  else {
    const missing: string[] = [];
    const sameAs = Array.isArray(org.sameAs) ? org.sameAs : org.sameAs ? [org.sameAs] : [];
    if (!sameAs.length) missing.push('sameAs (social profiles)');
    if (!org.logo) missing.push('logo');
    if (!org.address) missing.push('address');
    if (!org.founder && !org.foundingDate) missing.push('founder/foundingDate');
    if (!org.name) missing.push('name');
    if (missing.length) problems.push({ label: `Organization schema incomplete: missing ${missing.join(', ')}`, urls: [url], evidence: [{ kind: 'jsonld', label: 'Organization', url, content: JSON.stringify(org, null, 1).slice(0, 1200), data: { missing } }] });
    const brand = prep.ctx.config.site.brand;
    if (org.name && typeof org.name === 'string' && !org.name.toLowerCase().includes(brand.toLowerCase())) problems.push({ label: `Organization name "${org.name}" does not match brand "${brand}"`, urls: [url] });
    // Consistent brand description across the site.
    const descs = new Set(orgs.map((o) => (typeof o.description === 'string' ? o.description.trim() : '')).filter(Boolean));
    const otherDescs = prep.ok.flatMap((p) => ['Organization', 'OnlineStore'].flatMap((t) => nodesOfType(p, t))).map((o) => (typeof o.description === 'string' ? o.description.trim() : '')).filter(Boolean);
    const all = new Set([...descs, ...otherDescs]);
    if (all.size > 1) problems.push({ label: `${all.size} different Organization descriptions across the site`, urls: [url], evidence: [{ kind: 'text_passage', label: 'descriptions', url, content: [...all].map((d) => `• ${trunc(d, 200)}`).join('\n') }] });
  }
  const f = aggregate({ checkId: 'AEO-ENTITY', template: 'home', noun: 'entity gaps', problems, title: problems.length ? `Entity clarity: ${problems.map((p) => p.label).join('; ')}` : undefined, extraEvidence: [{ kind: 'note', label: 'Not checked by the crawler', content: 'Wikipedia/Wikidata presence and off-site profile consistency need external lookups.' }] });
  return { evaluated: true, templates: ['home'], findings: f ? [f] : [] };
}

// ------------------------------------------------------------------------------------------------ AEO-AI-CRAWLERS

export const AI_BOTS = ['GPTBot', 'Google-Extended', 'PerplexityBot', 'CCBot', 'Bingbot'];

export function analyzeAiCrawlers(prep: Prepared): AnalyzerResult {
  const r = prep.ctx.robots;
  if (!r || r.status === null) return NOT('robots.txt could not be fetched');
  const policy = prep.ctx.config.aiCrawlerPolicy ?? {};
  const findings: Finding[] = [];
  const probePaths = ['/', '/collections/', '/products/', '/blogs/'];
  for (const bot of AI_BOTS) {
    const blockedPaths = r.body === undefined ? [] : probePaths.filter((p) => !isAllowed(r.parsed, bot, p).allowed);
    const g = groupFor(r.parsed, bot);
    const probe = (prep.ctx.botProbes ?? []).find((b) => b.bot === bot);
    const firewall = probe && probe.status !== null && (probe.status === 403 || probe.status === 401 || probe.status === 429 || probe.status === 503);
    if (!blockedPaths.length && !firewall) continue;
    const pol = policy[bot];
    const unintentional = pol !== 'block_intentional';
    const evidence: Ev[] = [];
    if (blockedPaths.length) {
      const rules = blockedPaths.map((p) => isAllowed(r.parsed, bot, p).rule).filter(Boolean);
      evidence.push({ kind: 'http_response', label: `robots.txt group "User-agent: ${g.agent}"`, url: r.url, content: [`User-agent: ${g.agent}`, ...g.rules.map((x) => `${x.type === 'allow' ? 'Allow' : 'Disallow'}: ${x.path}`)].join('\n'), data: { blockedPaths, rules } });
    }
    if (firewall) evidence.push({ kind: 'http_response', label: `${bot} user-agent request`, url: `${prep.ctx.origin}/`, content: `User-Agent: ${probe!.userAgent}\n→ HTTP ${probe!.status}` });
    evidence.push({ kind: 'note', label: 'Configured AI-crawler policy', data: { bot, policy: pol ?? '(not set — treated as unintentional)' } });
    findings.push({
      checkId: 'AEO-AI-CRAWLERS', key: `AEO-AI-CRAWLERS::site::${bot}`,
      title: `${bot} is blocked${blockedPaths.length ? ` by robots.txt (${blockedPaths.join(', ')})` : ''}${firewall ? `${blockedPaths.length ? ' and' : ''} by the firewall (HTTP ${probe!.status})` : ''}${unintentional ? ' — not in the AI-crawler policy' : ' (deliberate policy)'}`,
      summary: unintentional
        ? `The configured policy says ${pol === 'allow' ? '"allow"' : 'nothing'} for ${bot}, but it cannot crawl ${blockedPaths.join(', ') || 'the site'}. DeoDap will be missing from ${bot === 'Bingbot' ? 'Bing / Copilot' : bot === 'GPTBot' ? 'ChatGPT' : bot === 'Google-Extended' ? 'Gemini grounding' : bot === 'PerplexityBot' ? 'Perplexity' : 'Common Crawl-based models'} answers.`
        : `${bot} is blocked by deliberate, documented policy (block_intentional). Surfaced for transparency.`,
      urls: [r.url], severityContext: { unintentional }, evidence,
    });
  }
  return { evaluated: true, findings };
}

// ------------------------------------------------------------------------------------------------ GEO-EEAT

const TRUST_PAGES: { key: string; re: RegExp }[] = [
  { key: 'About', re: /\/pages\/(about|about-us|our-story|who-we-are)/i },
  { key: 'Contact', re: /\/pages\/(contact|contact-us)/i },
  { key: 'Shipping policy', re: /\/(pages\/(shipping|shipping-policy|delivery)|policies\/shipping-policy)/i },
  { key: 'Returns/refund policy', re: /\/(pages\/(returns?|refund|return-policy|refund-policy|cancellation)|policies\/refund-policy)/i },
];

export function analyzeEeat(prep: Prepared): AnalyzerResult {
  const home = prep.ok.find((p) => p.template === 'home');
  if (!home) return NOT('homepage not crawled');
  const problems: Problem[] = [];
  const nonHome = prep.ok.filter((p) => p.template !== 'home').slice(0, 30);
  for (const t of TRUST_PAGES) {
    const onHome = home.html!.internalLinks.some((l) => t.re.test(pathOf(l)));
    const sitewide = nonHome.length ? nonHome.filter((p) => p.html!.internalLinks.some((l) => t.re.test(pathOf(l)))).length / nonHome.length : 1;
    if (!onHome || sitewide < 0.8) problems.push({ label: `${t.key} page not linked sitewide`, urls: [home.url], evidence: [metricEv(`${t.key} link coverage`, { linkedFromHomepage: onHome, sitewideShare: Math.round(sitewide * 100) })] });
  }
  const about = prep.ok.find((p) => TRUST_PAGES[0].re.test(pathOf(p.url)));
  if (about && prep.uniqueWords(about) < 200) problems.push({ label: 'About page is thin (<200 words)', urls: [about.url], evidence: [metricEv('About page depth', { words: prep.uniqueWords(about) }, about.url)] });
  if (!prep.ok.some((p) => p.html!.phoneVisible)) problems.push({ label: 'no visible phone number', urls: [home.url] });
  const articles = prep.content.filter((p) => p.template === 'blog_article');
  const noBio = articles.filter((p) => !p.html!.author.hasBio);
  if (noBio.length) problems.push({ label: 'blog articles without an author bio', urls: noBio.map((p) => p.url), evidence: noBio.slice(0, 5).map((p) => htmlEv(p.url, 'author', p.html!.author.name ? `Author: ${p.html!.author.name} (no bio)` : '(no author)')) });
  const f = aggregate({ checkId: 'GEO-EEAT', noun: 'E-E-A-T gaps', problems, title: problems.length ? `E-E-A-T surface gaps: ${problems.map((p) => p.label).join('; ')}` : undefined });
  return { evaluated: true, findings: f ? [f] : [] };
}

// ------------------------------------------------------------------------------------------------ GEO-FRESHNESS

export function modifiedDate(p: ParsedPage): { date?: Date; source?: string } {
  for (const t of ['Article', 'BlogPosting', 'NewsArticle', 'WebPage']) {
    for (const n of nodesOfType(p, t)) {
      const v = n.dateModified ?? n.datePublished;
      if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return { date: new Date(v), source: `${t}.${n.dateModified ? 'dateModified' : 'datePublished'}` };
    }
  }
  const vis = p.html!.visibleDates.find((d) => d.label === 'updated' && d.iso) ?? p.html!.visibleDates.find((d) => d.iso);
  return vis?.iso ? { date: new Date(vis.iso), source: `visible "${vis.text}"` } : {};
}

export function analyzeGeoFreshness(prep: Prepared): AnalyzerResult {
  const days = prep.ctx.thresholds.freshnessDays ?? 180;
  const nowYear = prep.ctx.now.getUTCFullYear();
  const pages = prep.content.filter((p) => p.template === 'blog_article' || p.template === 'blog_index');
  const articles = pages.filter((p) => p.template === 'blog_article');
  if (!articles.length) return { evaluated: true, templates: ['blog_article'], findings: [] };
  return perTemplate(prep, articles, 'GEO-FRESHNESS', 'freshness gaps', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const hasModified = nodesOfType(p, 'Article').concat(nodesOfType(p, 'BlogPosting')).some((n) => n.dateModified);
    const visibleUpdated = p.html!.visibleDates.some((d) => d.label === 'updated');
    if (!hasModified) out.push({ label: 'without dateModified in Article schema' });
    if (!visibleUpdated) out.push({ label: 'without a visible "last updated" date' });
    const m = modifiedDate(p);
    if (m.date && (prep.ctx.now.getTime() - m.date.getTime()) / 86400000 > days) out.push({ label: `not updated in over ${days} days`, evidence: [metricEv('last modified', { date: m.date.toISOString(), source: m.source }, p.url)] });
    const stale = (p.html!.mainText.match(/[^.!?\n]*\b(?:in|as of|since|for|during)\s+(20[0-2]\d)\b[^.!?\n]*\d+\s?%[^.!?\n]*/gi) ?? []).filter((s) => Number(s.match(/20[0-2]\d/)![0]) <= nowYear - 3);
    if (stale.length) out.push({ label: 'citing statistics that are 3+ years old', evidence: stale.slice(0, 3).map((s) => textEv(p.url, 'stale statistic', s.trim())) });
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ GEO-STRUCTURE

export function analyzeGeoStructure(prep: Prepared): AnalyzerResult {
  const maxRun = prep.ctx.thresholds.retrievalHeadingEveryMaxWords ?? 300;
  const pages = prep.content.filter((p) => ['blog_article', 'page', 'collection', 'product'].includes(p.template));
  return perTemplate(prep, pages, 'GEO-STRUCTURE', 'retrieval-structure gaps', (p) => {
    let run = 0;
    let worst = 0;
    let worstStart = '';
    let currentStart = '';
    for (const s of p.html!.segments) {
      if (s.kind === 'heading' && s.level && s.level >= 2) {
        run = 0;
        currentStart = '';
        continue;
      }
      if (s.kind === 'text') {
        if (!run) currentStart = s.text;
        run += wordCount(s.text);
        if (run > worst) {
          worst = run;
          worstStart = currentStart;
        }
      }
    }
    if (worst <= maxRun) return [];
    return [{ label: `have ${maxRun}+ words without a descriptive H2/H3`, evidence: [textEv(p.url, `${worst} words under one heading`, trunc(worstStart, 300), { longestRunWords: worst, max: maxRun })] }];
  }, (_t, list) => ({ severityContext: {} , examined: list.length }));
}

export { sameUrl };
