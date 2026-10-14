/**
 * Content audit (PDF §5) and AI-content compliance (PDF §10.1) analyzers from crawl data.
 * These are heuristics producing flags for human review, never claims that copy is or is not AI-written.
 */
import {
  AI_ARTIFACT_PATTERNS, AI_BOILERPLATE_PATTERNS, YMYL_CLAIM_PATTERNS, aiLikelihoodHeuristic, findPatternHits, keywordDensity, nearIdenticalClusters,
  readingEase, rhythmUniformity, sentences, wordCount,
} from '@sentinel/shared';
import type { Finding } from '../services/ports';
import type { ParsedPage } from '../crawler/types';
import { pathOf } from '../crawler/url';
import { groupByTemplate, metricEv, noun, perTemplate, textEv, trunc, type AnalyzerResult, type Ev, type Prepared } from './context';
import { modifiedDate } from './aeoGeo';
import { UTILITY_PAGE } from './technical';
import { hasType, nodesOfType } from './schema';

/** The page's own copy (product grids and template chrome excluded) — what AI checks read. */
function ownText(prep: Prepared, p: ParsedPage): string {
  const u = prep.uniqueText(p);
  const d = p.html!.descriptionText;
  // The description is normally part of the unique text already; fall back to it when template-boilerplate removal ate it.
  return d && wordCount(u) < wordCount(d) ? d : u;
}

const EXPERIENCE = /\b(we tested|we used|i used|i tried|we tried|our team (tested|used|tried)|hands[- ]on|in our experience|in my experience|after (using|testing)|tested (it|this|them) (for|over)|we found that|our verdict|customer photos?)\b/i;
const ADVICE = /\b(how to|guide|tips|best|vs\.?|review|ideas|benefits|ways to|should you|checklist)\b/i;

const CONTENT_TEMPLATES = ['product', 'collection', 'blog_article', 'page'];

// ------------------------------------------------------------------------------------------------ CONT-QUALITY

export function qualityScore(prep: Prepared, p: ParsedPage, dupUrls: Set<string>): { score: number; parts: Record<string, number>; notes: string[] } {
  const words = prep.uniqueWords(p);
  const total = Math.max(1, p.html!.wordCount);
  const minWords = prep.ctx.thresholds.thinContentWords ?? 150;
  // Uniqueness (0–35): unique words vs. 2× the thin threshold, share of unique copy, near-duplicate penalty.
  const uniqueness = dupUrls.has(p.url) ? 5 : Math.round(Math.min(1, words / (minWords * 2)) * 25 + Math.min(1, words / total) * 10);
  // Readability (0–20): Flesch reading ease bands.
  const ease = readingEase(ownText(prep, p));
  const readability = words < 30 ? 0 : ease >= 60 ? 20 : ease >= 40 ? 15 : ease >= 20 ? 9 : 4;
  // Media (0–20): images in main content, video, tables.
  const imgs = p.html!.images.filter((i) => i.inMain).length;
  const media = Math.min(20, Math.min(12, imgs * 4) + (p.html!.features.video ? 4 : 0) + (p.html!.features.tables ? 4 : 0));
  // Structure (0–10): sub-headings and lists/tables help scanning.
  const h2 = p.html!.headings.filter((h) => h.level === 2 || h.level === 3).length;
  const structure = (h2 ? 5 : 0) + (p.html!.features.tables || p.html!.features.orderedLists ? 5 : h2 >= 2 ? 3 : 0);
  // Freshness (0–15): modified date within the freshness window; unknown = neutral 8.
  const m = modifiedDate(p);
  const ageDays = m.date ? (prep.ctx.now.getTime() - m.date.getTime()) / 86400000 : undefined;
  const fresh = ageDays === undefined ? 8 : ageDays <= (prep.ctx.thresholds.freshnessDays ?? 180) ? 15 : 4;
  const score = Math.max(0, Math.min(100, uniqueness + readability + media + structure + fresh));
  const notes = ['Depth vs. top-10 SERP average word count is NOT included (needs a SERP data source); the score uses uniqueness 35 + readability 20 + media 20 + structure 10 + freshness 15.'];
  if (ageDays === undefined) notes.push('No modified date found — freshness scored neutral (8/15).');
  return { score, parts: { uniqueness, readability, media, structure, freshness: fresh, uniqueWords: words, readingEase: ease, images: imgs }, notes };
}

export function analyzeContentQuality(prep: Prepared): AnalyzerResult {
  const min = prep.ctx.thresholds.contentQualityMin ?? 50;
  const pages = prep.content.filter((p) => CONTENT_TEMPLATES.includes(p.template) && !UTILITY_PAGE.test(pathOf(p.url)));
  const dupUrls = new Set<string>();
  for (const [, list] of groupByTemplate(pages)) {
    const docs = list.filter((p) => prep.uniqueWords(p) >= 30).map((p) => ({ id: p.url, text: prep.uniqueText(p) }));
    for (const c of nearIdenticalClusters(docs, 0.85)) c.forEach((u) => dupUrls.add(u));
  }
  return perTemplate(prep, pages, 'CONT-QUALITY', 'low content quality', (p) => {
    if (p.tier > 2) return [];
    const q = qualityScore(prep, p, dupUrls);
    if (q.score >= min) return [];
    return [{ label: `score below ${min}/100 on content quality`, evidence: [metricEv(`content quality ${q.score}/100`, { score: q.score, ...q.parts, notes: q.notes }, p.url)] }];
  }, (_t, list) => {
    const scores = list.filter((p) => p.tier <= 2).map((p) => qualityScore(prep, p, dupUrls).score);
    return scores.length ? { severityContext: { metric: Math.min(...scores) } } : {};
  });
}

// ------------------------------------------------------------------------------------------------ CONT-AI-RISK

export function analyzeAiRisk(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => CONTENT_TEMPLATES.includes(p.template));
  return perTemplate(prep, pages, 'CONT-AI-RISK', 'AI-content risk', (p) => {
    const text = ownText(prep, p);
    if (wordCount(text) < 60) return [];
    const boiler = findPatternHits(text, AI_BOILERPLATE_PATTERNS);
    const artifacts = findPatternHits(text, AI_ARTIFACT_PATTERNS);
    const likelihood = aiLikelihoodHeuristic(text);
    const experience = EXPERIENCE.test(text) || p.html!.reviews.hasVisible || !!p.html!.author.hasBio;
    if (experience || (boiler.length + artifacts.length === 0 && likelihood < 50)) return [];
    return [{
      label: 'read as boilerplate/spun copy with no experience signals',
      evidence: [
        ...[...boiler, ...artifacts].slice(0, 3).map((h) => textEv(p.url, h.reason, h.passage)),
        metricEv(`heuristic AI-likelihood ${likelihood}/100 (flag for review, not a classifier)`, { likelihood, boilerplateHits: boiler.length, artifactHits: artifacts.length, rhythmUniformity: rhythmUniformity(text), experienceSignals: false }, p.url),
      ],
    }];
  });
}

// ------------------------------------------------------------------------------------------------ AIC-01

export function analyzeScaledContent(prep: Prepared): AnalyzerResult {
  const minCluster = 3;
  const findings: Finding[] = [];
  const pages = prep.content.filter((p) => ['product', 'collection', 'blog_article', 'page'].includes(p.template));
  for (const [t, list] of groupByTemplate(pages)) {
    const docs = list
      .map((p) => ({ p, text: p.html!.descriptionText ?? p.html!.ownBlocks.join('\n') }))
      .filter((d) => wordCount(d.text) >= 25)
      .map((d) => ({ id: d.p.url, text: d.text, mask: d.p.html!.h1s[0] || undefined }));
    const clusters = nearIdenticalClusters(docs, 0.8).filter((c) => c.length >= minCluster);
    for (const c of clusters) {
      const sample = docs.find((d) => d.id === c[0])!;
      const masked = sample.mask ? sample.text.split(sample.mask).join('{product}') : sample.text;
      findings.push({
        checkId: 'AIC-01', template: t, key: `AIC-01::${t}::${c.slice().sort()[0]}`,
        title: `${c.length} ${noun(t, c.length)} share near-identical "fill-in-the-blank" copy (only the name swapped)`,
        summary: `${c.length} pages are ≥80% identical after masking the product/page name. Publish dates (7-day window) need Shopify data; the metric is the cluster size.`,
        urls: c,
        severityContext: { metric: c.length },
        evidence: [textEv(c[0], 'shared template passage (name masked as {product})', trunc(masked, 800), { clusterSize: c.length, urls: c })],
      });
    }
  }
  return { evaluated: true, templates: [...new Set(pages.map((p) => p.template))], findings };
}

// ------------------------------------------------------------------------------------------------ AIC-02

export function analyzeAiBoilerplate(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => CONTENT_TEMPLATES.includes(p.template) || p.template === 'home');
  return perTemplate(prep, pages, 'AIC-02', 'unedited AI boilerplate', (p) => {
    const text = ownText(prep, p);
    const out: { label: string; evidence?: Ev[] }[] = [];
    const hits = findPatternHits(text, AI_BOILERPLATE_PATTERNS);
    const conclusions = (text.match(/\bin conclusion,/gi) ?? []).length;
    if (hits.length) out.push({ label: 'contain unedited AI boilerplate', evidence: hits.map((h) => textEv(p.url, h.reason, h.passage)) });
    const sents = sentences(text);
    const rhythm = rhythmUniformity(text);
    if (sents.length >= 10 && rhythm >= 0.85) out.push({ label: 'have a uniform, repeated sentence rhythm', evidence: [textEv(p.url, `rhythm uniformity ${rhythm}`, sents.slice(0, 4).join(' '), { rhythmUniformity: rhythm, sentences: sents.length })] });
    if (out.length && p.template === 'product' && !/\d/.test(p.html!.descriptionText ?? text) && !p.html!.features.specTable) {
      out.push({ label: 'state zero product-specific facts (no numbers, specs or dimensions)', evidence: [textEv(p.url, 'description', trunc(p.html!.descriptionText ?? text, 400))] });
    }
    void conclusions;
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ AIC-05

export function analyzeExperience(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => p.template === 'blog_article' || (p.template === 'page' && ADVICE.test(`${p.html!.title ?? ''} ${p.html!.h1s[0] ?? ''}`)));
  if (!pages.length) return { evaluated: true, templates: ['blog_article'], findings: [] };
  return perTemplate(prep, pages, 'AIC-05', 'no experience signals', (p) => {
    const text = ownText(prep, p);
    const out: { label: string; evidence?: Ev[] }[] = [];
    const advice = ADVICE.test(`${p.html!.title ?? ''} ${p.html!.h1s.join(' ')}`);
    if (!advice) return out;
    const author = p.html!.author.name || nodesOfType(p, 'Article').concat(nodesOfType(p, 'BlogPosting')).some((n) => n.author);
    if (!author) out.push({ label: 'publish advice/buying-guide content anonymously' });
    if (!EXPERIENCE.test(text)) out.push({ label: 'show no first-hand experience markers (usage notes, testing, tester attribution)', evidence: [textEv(p.url, 'opening', trunc(text, 300))] });
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ AIC-06

const INCENTIVIZED = /\b(received (this|the) (product|item) (for )?free|in exchange for (my|an) (honest )?review|free product for review|sponsored review|discount in exchange)\b/i;

export function analyzeFakeReviews(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => hasType(p, 'Review', 'AggregateRating') || p.html!.reviews.hasVisible);
  const textToPages = new Map<string, Set<string>>();
  for (const p of pages) {
    const bodies = [...p.html!.reviews.texts, ...nodesOfType(p, 'Review').map((r) => (typeof r.reviewBody === 'string' ? r.reviewBody : ''))].map((t) => t.toLowerCase().replace(/\s+/g, ' ').trim()).filter((t) => wordCount(t) >= 6);
    for (const b of new Set(bodies)) textToPages.set(b, (textToPages.get(b) ?? new Set()).add(p.url));
  }
  const templated = [...textToPages.entries()].filter(([, s]) => s.size >= 2);
  return perTemplate(prep, pages, 'AIC-06', 'fake/templated review signals', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const marked = [...nodesOfType(p, 'AggregateRating'), ...nodesOfType(p, 'Review')];
    if (marked.length && !p.html!.reviews.hasVisible) out.push({ label: 'carry review schema with no genuine visible reviews behind it', evidence: [{ kind: 'jsonld', label: 'review markup', url: p.url, content: JSON.stringify(marked[0]).slice(0, 600) }] });
    const mine = templated.filter(([, s]) => s.has(p.url));
    if (mine.length) out.push({ label: 'show review text duplicated verbatim on other products (templated reviews)', evidence: mine.slice(0, 3).map(([t, s]) => textEv(p.url, `same review on ${s.size} pages`, t, { urls: [...s] })) });
    const inc = p.html!.reviews.texts.find((t) => INCENTIVIZED.test(t));
    if (inc) out.push({ label: 'show incentivized-review patterns', evidence: [textEv(p.url, 'incentivized review', inc)] });
    const schemaBodies = nodesOfType(p, 'Review').map((r) => (typeof r.reviewBody === 'string' ? r.reviewBody : '')).filter((b) => wordCount(b) >= 5);
    const visibleJoined = p.html!.mainText.toLowerCase();
    const invisible = schemaBodies.filter((b) => !visibleJoined.includes(b.toLowerCase().slice(0, 60)));
    if (p.html!.reviews.hasVisible && invisible.length) out.push({ label: 'mark up reviews that are not shown on the page', evidence: invisible.slice(0, 2).map((b) => textEv(p.url, 'reviewBody not visible', b)) });
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ AIC-07

export function analyzeYmyl(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => CONTENT_TEMPLATES.includes(p.template));
  return perTemplate(prep, pages, 'AIC-07', 'unverified YMYL claims', (p) => {
    const text = ownText(prep, p);
    const hits = findPatternHits(text, YMYL_CLAIM_PATTERNS);
    if (!hits.length) return [];
    // A claim is considered sourced only when the structured product data (JSON-LD additionalProperty / material /
    // certification) states it too. Shopify metafield verification needs the Shopify connector.
    const structured = JSON.stringify(nodesOfType(p, 'Product').map((n) => ({ a: n.additionalProperty, m: n.material, c: n.hasCertification }))).toLowerCase();
    const unverified = hits.filter((h) => !YMYL_CLAIM_PATTERNS.some((pat) => pat.re.test(h.passage) && pat.re.test(structured)));
    if (!unverified.length) return [];
    return [{
      label: 'make health/safety claims without a verified source in product data',
      evidence: unverified.map((h) => textEv(p.url, h.reason, h.passage, { requiresHumanSignOff: true })),
    }];
  });
}

// ------------------------------------------------------------------------------------------------ AIC-08

export function analyzeDoorway(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => ['page', 'collection', 'blog_article', 'other'].includes(p.template));
  const findings: Finding[] = [];
  const docs = pages
    .map((p) => ({ p, text: prep.uniqueText(p) || p.html!.ownBlocks.join('\n') }))
    .filter((d) => wordCount(d.text) >= 40);
  const clusters = nearIdenticalClusters(docs.map((d) => ({ id: d.p.url, text: d.text, mask: d.p.html!.h1s[0] || undefined })), 0.75).filter((c) => c.length >= 3);
  for (const c of clusters) {
    const cps = c.map((u) => pages.find((p) => p.url === u)!);
    // Destination = most common in-content internal link (excluding the cluster pages themselves).
    const counts = new Map<string, number>();
    for (const p of cps) for (const l of new Set(p.html!.links.filter((x) => x.internal && x.inMain && !c.includes(x.url)).map((x) => pathOf(x.url)))) counts.set(l, (counts.get(l) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < c.length) continue;
    const variable = cps.map((p) => p.html!.h1s[0] ?? p.html!.title ?? p.url);
    findings.push({
      checkId: 'AIC-08', template: cps[0].template, key: `AIC-08::${c.slice().sort()[0]}`,
      title: `${c.length} near-duplicate keyword/location landing pages all funnel to ${top[0]}`,
      summary: `These pages are ≥75% identical after masking their heading (${variable.slice(0, 4).join(' / ')}…) and every one links to ${top[0]} — a doorway-page pattern.`,
      urls: c,
      evidence: [textEv(c[0], 'shared passage', trunc(docs.find((d) => d.p.url === c[0])!.text, 600), { clusterSize: c.length, destination: top[0], headings: variable })],
    });
  }
  return { evaluated: true, templates: [...new Set(pages.map((p) => p.template))], findings };
}

// ------------------------------------------------------------------------------------------------ AIC-09

export function mainPhrase(title: string, brand: string): string {
  const seg = title.split(/\s[|–—:-]\s|\s\|\s|\|/)[0].replace(new RegExp(brand, 'i'), '').trim();
  const words = seg.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return words.slice(0, Math.min(3, words.length)).join(' ');
}

export function analyzeKeywordStuffing(prep: Prepared): AnalyzerResult {
  const brand = prep.ctx.config.site.brand;
  const pages = prep.content.filter((p) => CONTENT_TEMPLATES.includes(p.template) || p.template === 'home');
  return perTemplate(prep, pages, 'AIC-09', 'keyword stuffing', (p) => {
    const title = p.html!.title ?? p.html!.h1s[0] ?? '';
    const kw = mainPhrase(title, brand);
    const text = ownText(prep, p);
    if (!kw || wordCount(kw) < 1 || wordCount(text) < 100) return [];
    const density = keywordDensity(text, kw);
    const occurrences = (text.match(new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) ?? []).length;
    // A product named twice in a short description is not stuffing: require ≥3 exact-match repetitions as well.
    if (density <= 3 || occurrences < 3) return [];
    const re = new RegExp(`[^.!?]*\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^.!?]*[.!?]?`, 'gi');
    const passages = (text.match(re) ?? []).slice(0, 3).map((s) => s.trim());
    return [{ label: 'repeat the title phrase at >3% keyword density', evidence: [metricEv(`"${kw}" density ${density}%`, { keyword: kw, densityPct: density, maxPct: 3, words: wordCount(text) }, p.url), ...passages.map((s) => textEv(p.url, `"${kw}" repetition`, s))] }];
  });
}

// ------------------------------------------------------------------------------------------------ AIC-11

const TESTED_CLAIM = /\b(tested by (our|the) team|our (team|experts) (tested|reviewed)|we (personally )?tested|hand[- ]tested|lab[- ]tested by us)\b/i;

export function analyzeAuthorship(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => p.template === 'blog_article');
  if (!pages.length) return { evaluated: true, templates: ['blog_article'], findings: [] };
  return perTemplate(prep, pages, 'AIC-11', 'authorship gaps', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const schemaAuthor = nodesOfType(p, 'Article').concat(nodesOfType(p, 'BlogPosting')).map((n) => n.author).find(Boolean);
    const name = p.html!.author.name;
    if (!name && !schemaAuthor) out.push({ label: 'missing author attribution' });
    const text = ownText(prep, p);
    const m = text.match(TESTED_CLAIM);
    if (m && (!name || !p.html!.author.hasBio)) out.push({ label: 'claim first-hand testing without a named, described author', evidence: [textEv(p.url, 'testing claim', text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 120))] });
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ AIC-12

export function analyzeArtifacts(prep: Prepared): AnalyzerResult {
  const pages = prep.content.filter((p) => CONTENT_TEMPLATES.includes(p.template) || p.template === 'home');
  return perTemplate(prep, pages, 'AIC-12', 'outdated-model artifacts', (p) => {
    const hits = findPatternHits(ownText(prep, p), AI_ARTIFACT_PATTERNS);
    return hits.length ? [{ label: 'contain AI artifacts (stale dates, literal markdown, prompt leaks)', evidence: hits.map((h) => textEv(p.url, h.reason, h.passage)) }] : [];
  });
}
