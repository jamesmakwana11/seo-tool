/**
 * Analysis engine (PDF subsystem C). Pure functions over crawled pages + site context:
 * `(pages: ParsedPage[], ctx: SiteContext) => Finding[]` per check, aggregated one finding per check per
 * template. `runAnalyzers` returns `evaluatedChecks` listing every check actually evaluated (even when it
 * passed) so the issue service can auto-resolve issues that disappeared — and ONLY those.
 *
 * Checks needing GSC / GA4 / CrUX / PSI / backlinks / LLM / Shopify Admin / a JS renderer are NOT evaluated here.
 */
import type { PageTemplate } from '@sentinel/shared';
import { getCheck } from '@sentinel/shared';
import type { Finding, PreviousCrawlState } from '../services/ports';
import type { ContextNeed } from '../crawler/engine';
import type { ParsedPage, SiteContext } from '../crawler/types';
import { normalizeUrl } from '../crawler/url';
import { isNoindex, isSelfCanonical, metricEv, perTemplate, prepare, type AnalyzerResult, type Prepared } from './context';
import {
  analyze4xx, analyze5xx, analyzeBrokenInternal, analyzeBrokenOutbound, analyzeCanonical, analyzeCrawlBudget, analyzeCrawlDepth, analyzeDiscontinued,
  analyzeDuplicate, analyzeHost, analyzeHttps, analyzeNoindex, analyzeOrphans, analyzePagination, analyzeRedirects, analyzeRobots, analyzeShopifyDupPaths,
  analyzeSitemap, analyzeThin,
} from './technical';
import { analyzeSchemaErrors, analyzeSchemaPresence } from './schema';
import { analyzeImages, analyzeRenderBlocking, analyzeThirdParty, isBlockingScript, thirdPartyKbByTemplate } from './performance';
import {
  analyzeBreadcrumbs, analyzeH1, analyzeHeadings, analyzeImageSeo, analyzeMeta, analyzeOg, analyzeTitle, analyzeTplCollection, analyzeTplHome, analyzeTplProduct,
} from './onpage';
import { analyzeAiCrawlers, analyzeAnswerBlock, analyzeEeat, analyzeEntity, analyzeExtractability, analyzeFaq, analyzeGeoFreshness, analyzeGeoStructure, modifiedDate } from './aeoGeo';
import {
  analyzeAiBoilerplate, analyzeAiRisk, analyzeArtifacts, analyzeAuthorship, analyzeContentQuality, analyzeDoorway, analyzeExperience, analyzeFakeReviews,
  analyzeKeywordStuffing, analyzeScaledContent, analyzeYmyl,
} from './contentAi';

export interface AnalyzerDef {
  checkId: string;
  run: (prep: Prepared) => AnalyzerResult;
  /** Context the analyzer needs beyond the page HTML (drives what a re-verification fetches). */
  needs: ContextNeed[];
  /**
   * How a re-verification scopes URLs: 'pages' = re-fetch the issue's URLs; 'site' = site-level check
   * (robots.txt, host, TLS, sitemap) — re-run on the homepage + its context; 'template' = needs a sample of the
   * template (duplicates, clusters) — re-fetch the issue's URLs (which are the cluster).
   */
  scope: 'pages' | 'site' | 'template';
}

function analyzeContFreshness(prep: Prepared): AnalyzerResult {
  const days = prep.ctx.thresholds.freshnessDays ?? 180;
  const pages = prep.content.filter((p) => p.tier === 1 && (p.template === 'blog_article' || p.template === 'collection') && modifiedDate(p).date);
  if (!pages.length) return { evaluated: false, findings: [], reason: 'no Tier 1 collection/blog page exposes a modified date in its HTML (needs Shopify updated_at)' };
  return perTemplate(prep, pages, 'CONT-FRESHNESS', 'stale content', (p) => {
    const m = modifiedDate(p);
    const age = Math.floor((prep.ctx.now.getTime() - m.date!.getTime()) / 86400000);
    return age > days ? [{ label: `not updated in ${days}+ days (Tier 1)`, evidence: [metricEv(`last updated ${age} days ago`, { date: m.date!.toISOString(), source: m.source, ageDays: age, threshold: days }, p.url)] }] : [];
  });
}

export const ANALYZERS: AnalyzerDef[] = [
  { checkId: 'TECH-ROBOTS', run: analyzeRobots, needs: ['robots'], scope: 'site' },
  { checkId: 'TECH-NOINDEX', run: analyzeNoindex, needs: [], scope: 'pages' },
  { checkId: 'TECH-SITEMAP', run: (p) => analyzeSitemap(p), needs: ['sitemap', 'linkTargets'], scope: 'site' },
  { checkId: 'TECH-ORPHAN', run: analyzeOrphans, needs: ['sitemap', 'bfs'], scope: 'site' },
  { checkId: 'TECH-CRAWL-DEPTH', run: analyzeCrawlDepth, needs: ['bfs'], scope: 'site' },
  { checkId: 'TECH-CRAWL-BUDGET', run: analyzeCrawlBudget, needs: ['budget', 'robots'], scope: 'template' },
  { checkId: 'TECH-4XX', run: analyze4xx, needs: ['botProbe'], scope: 'pages' },
  { checkId: 'TECH-5XX', run: analyze5xx, needs: [], scope: 'pages' },
  { checkId: 'TECH-REDIRECTS', run: analyzeRedirects, needs: ['linkTargets'], scope: 'pages' },
  { checkId: 'TECH-BROKEN-INTERNAL', run: analyzeBrokenInternal, needs: ['linkTargets'], scope: 'pages' },
  { checkId: 'TECH-BROKEN-OUTBOUND', run: analyzeBrokenOutbound, needs: ['external'], scope: 'pages' },
  { checkId: 'TECH-DISCONTINUED', run: analyzeDiscontinued, needs: ['linkTargets'], scope: 'pages' },
  { checkId: 'TECH-CANONICAL', run: analyzeCanonical, needs: ['linkTargets'], scope: 'pages' },
  { checkId: 'TECH-SHOPIFY-DUP-PATHS', run: analyzeShopifyDupPaths, needs: ['collectionScoped'], scope: 'pages' },
  { checkId: 'TECH-DUPLICATE', run: analyzeDuplicate, needs: [], scope: 'template' },
  { checkId: 'TECH-THIN', run: analyzeThin, needs: [], scope: 'template' },
  { checkId: 'TECH-HOST', run: analyzeHost, needs: ['host'], scope: 'site' },
  { checkId: 'TECH-HTTPS', run: analyzeHttps, needs: ['tls'], scope: 'site' },
  { checkId: 'TECH-PAGINATION', run: analyzePagination, needs: ['pagination'], scope: 'pages' },
  { checkId: 'TECH-SCHEMA-PRESENCE', run: analyzeSchemaPresence, needs: [], scope: 'pages' },
  { checkId: 'TECH-SCHEMA-ERRORS', run: analyzeSchemaErrors, needs: [], scope: 'pages' },
  { checkId: 'PERF-RENDER-BLOCKING', run: analyzeRenderBlocking, needs: ['scripts'], scope: 'pages' },
  { checkId: 'PERF-IMAGES', run: analyzeImages, needs: ['images'], scope: 'pages' },
  { checkId: 'PERF-THIRD-PARTY', run: analyzeThirdParty, needs: ['scripts'], scope: 'template' },
  { checkId: 'CONT-QUALITY', run: analyzeContentQuality, needs: [], scope: 'template' },
  { checkId: 'CONT-FRESHNESS', run: analyzeContFreshness, needs: [], scope: 'pages' },
  { checkId: 'CONT-AI-RISK', run: analyzeAiRisk, needs: [], scope: 'template' },
  { checkId: 'ONP-TITLE', run: analyzeTitle, needs: [], scope: 'template' },
  { checkId: 'ONP-META', run: analyzeMeta, needs: [], scope: 'template' },
  { checkId: 'ONP-H1', run: analyzeH1, needs: [], scope: 'template' },
  { checkId: 'ONP-HEADINGS', run: analyzeHeadings, needs: [], scope: 'template' },
  { checkId: 'ONP-BREADCRUMBS', run: analyzeBreadcrumbs, needs: [], scope: 'pages' },
  { checkId: 'ONP-IMAGES', run: analyzeImageSeo, needs: [], scope: 'template' },
  { checkId: 'ONP-OG', run: analyzeOg, needs: [], scope: 'pages' },
  { checkId: 'ONP-TPL-HOME', run: analyzeTplHome, needs: [], scope: 'site' },
  { checkId: 'ONP-TPL-COLLECTION', run: analyzeTplCollection, needs: ['budget'], scope: 'template' },
  { checkId: 'ONP-TPL-PRODUCT', run: analyzeTplProduct, needs: [], scope: 'template' },
  { checkId: 'AEO-ANSWER-BLOCK', run: analyzeAnswerBlock, needs: [], scope: 'pages' },
  { checkId: 'AEO-FAQ', run: analyzeFaq, needs: [], scope: 'pages' },
  { checkId: 'AEO-EXTRACTABILITY', run: analyzeExtractability, needs: [], scope: 'template' },
  { checkId: 'AEO-ENTITY', run: analyzeEntity, needs: [], scope: 'site' },
  { checkId: 'AEO-AI-CRAWLERS', run: analyzeAiCrawlers, needs: ['robots', 'botProbe'], scope: 'site' },
  { checkId: 'GEO-EEAT', run: analyzeEeat, needs: [], scope: 'site' },
  { checkId: 'GEO-FRESHNESS', run: analyzeGeoFreshness, needs: [], scope: 'pages' },
  { checkId: 'GEO-STRUCTURE', run: analyzeGeoStructure, needs: [], scope: 'pages' },
  { checkId: 'AIC-01', run: analyzeScaledContent, needs: [], scope: 'template' },
  { checkId: 'AIC-02', run: analyzeAiBoilerplate, needs: [], scope: 'template' },
  { checkId: 'AIC-05', run: analyzeExperience, needs: [], scope: 'pages' },
  { checkId: 'AIC-06', run: analyzeFakeReviews, needs: [], scope: 'template' },
  { checkId: 'AIC-07', run: analyzeYmyl, needs: [], scope: 'template' },
  { checkId: 'AIC-08', run: analyzeDoorway, needs: [], scope: 'template' },
  { checkId: 'AIC-09', run: analyzeKeywordStuffing, needs: [], scope: 'template' },
  { checkId: 'AIC-11', run: analyzeAuthorship, needs: [], scope: 'pages' },
  { checkId: 'AIC-12', run: analyzeArtifacts, needs: [], scope: 'template' },
];

export const ANALYZERS_BY_ID: Record<string, AnalyzerDef> = Object.fromEntries(ANALYZERS.map((a) => [a.checkId, a]));

/**
 * Crawler-evaluable checks in the library that have NO analyzer here, and why (reported, never faked).
 */
export const NOT_EVALUATED: Record<string, string> = {
  'CONT-QA-GATE': 'Report section — needs Shopify publish timestamps to know which pages are new; the per-page checklist itself is covered by the ONP-/TECH- checks.',
  'ONP-KEYWORD-MAP': 'Needs the keyword map (one assigned primary keyword per Tier 1–2 page), which does not exist yet.',
  'GEO-CITATION': 'Opportunity (content brief), not a crawl defect — needs SERP / competitor data to judge citation-worthiness.',
  'GEO-CLUSTER': 'Needs the pillar → cluster topic map per category (and search volumes for missing pillars).',
  'AIC-03': 'Needs structured product data from Shopify (metafields/specs) and an LLM to compare claims.',
  'TECH-JS-RENDER': 'No headless browser installed — raw HTML vs rendered DOM cannot be compared.',
  'TECH-MOBILE': 'No headless browser installed — 390px rendering is not available.',
};

/** Validate the registry against the check library at load time (only crawler-evaluable checks may be analyzed). */
for (const a of ANALYZERS) {
  const c = getCheck(a.checkId);
  if (!c.crawlerEvaluable) throw new Error(`Analyzer registered for non-crawler check ${a.checkId}`);
}

export interface AnalysisResult {
  findings: Finding[];
  evaluatedChecks: string[];
  evaluatedTemplates: Record<string, PageTemplate[]>;
  notEvaluated: Record<string, string>;
  sitemapInvalid: { url: string; problem: string }[];
}

export function runAnalyzers(pages: ParsedPage[], ctx: SiteContext, only?: string[]): AnalysisResult {
  const prep = prepare(pages, ctx);
  const findings: Finding[] = [];
  const evaluatedChecks: string[] = [];
  const evaluatedTemplates: Record<string, PageTemplate[]> = {};
  const notEvaluated: Record<string, string> = {};
  let sitemapInvalid: { url: string; problem: string }[] = [];
  for (const a of ANALYZERS) {
    if (only && !only.includes(a.checkId)) continue;
    let r: AnalyzerResult;
    try {
      r = a.run(prep);
    } catch (e) {
      notEvaluated[a.checkId] = `analyzer error: ${(e as Error).message}`;
      continue;
    }
    if (a.checkId === 'TECH-SITEMAP') sitemapInvalid = (r as AnalyzerResult & { invalid?: { url: string; problem: string }[] }).invalid ?? [];
    if (!r.evaluated) {
      notEvaluated[a.checkId] = r.reason ?? 'not evaluable in this run';
      continue;
    }
    evaluatedChecks.push(a.checkId);
    if (r.templates) evaluatedTemplates[a.checkId] = r.templates;
    for (const f of r.findings) {
      f.urls = [...new Set(f.urls)];
      findings.push(f);
    }
  }
  if (!only) for (const [k, v] of Object.entries(NOT_EVALUATED)) notEvaluated[k] ??= v;
  return { findings, evaluatedChecks, evaluatedTemplates, notEvaluated, sitemapInvalid };
}

/** Build the state the NEXT run diffs against. URLs not re-crawled in this run keep their previous state. */
export function snapshotFromPages(pages: ParsedPage[], ctx: SiteContext): PreviousCrawlState {
  const prev = ctx.previous ?? {};
  const prep = prepare(pages, ctx);
  const crawledKeys = new Set(prep.requested.map((p) => normalizeUrl(p.url)));
  const keep = (list?: string[]) => (list ?? []).filter((u) => !crawledKeys.has(normalizeUrl(u)));
  const okNow = prep.requested.filter((p) => p.status === 200).map((p) => p.url);
  const indexableNow = prep.ok.filter((p) => !isNoindex(p).noindex && isSelfCanonical(p)).map((p) => p.url);
  const headScriptsByTemplate: Partial<Record<PageTemplate, string[]>> = { ...(prev.headScriptsByTemplate ?? {}) };
  for (const [t, list] of prep.byTemplate) {
    const baseline = prev.headScriptsByTemplate?.[t];
    const set = new Set<string>(baseline ?? []);
    for (const p of list) {
      for (const s of p.html!.headScripts) {
        // First run for a template: everything becomes the baseline. Later runs: a NEW blocking script stays out of the
        // baseline so PERF-RENDER-BLOCKING keeps reporting it until it is removed or made async/defer (no silent auto-resolve).
        if (!baseline || !isBlockingScript(s)) set.add(s.src.replace(/\?.*$/, ''));
      }
    }
    headScriptsByTemplate[t] = [...set];
  }
  return {
    robotsTxt: ctx.robots?.body ?? prev.robotsTxt,
    headScriptsByTemplate,
    indexableUrls: [...new Set([...keep(prev.indexableUrls), ...indexableNow])],
    okUrls: [...new Set([...keep(prev.okUrls), ...okNow])],
    sitemapEntries: ctx.sitemap ? ctx.sitemap.entries.map((e) => ({ url: e.url, lastmod: e.lastmod })) : prev.sitemapEntries,
    thirdPartyKbByTemplate: { ...(prev.thirdPartyKbByTemplate ?? {}), ...(thirdPartyKbByTemplate(prep) ?? {}) },
  };
}
