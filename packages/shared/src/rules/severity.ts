import type { PageTier, Severity, SentinelConfig } from '../types';
import { getCheck } from '../checks/library';

/**
 * Context the analysis engine supplies when classifying a finding.
 * Severity = check type × page value (PDF §3) — never check type alone.
 */
export interface SeverityContext {
  checkId: string;
  highestTier: PageTier;
  templateWide?: boolean; // affects a whole template (e.g. all product pages)
  sitewide?: boolean;
  isWarning?: boolean; // schema warning vs. error
  hasBacklinks?: boolean;
  searchCrawlerAffected?: boolean; // 429 served to Googlebot/Bingbot
  isHomepage?: boolean;
  metric?: number; // numeric measurement relevant to the check (see per-check notes)
  cwvStatus?: 'good' | 'needs_improvement' | 'poor';
  isProductClaim?: boolean; // AIC-03
  unintentional?: boolean; // AEO-AI-CRAWLERS
  affectsIndexablePaths?: boolean; // TECH-ROBOTS
  primaryContentClientOnly?: boolean; // TECH-JS-RENDER
  deprecatedTypeInUse?: boolean; // TECH-SCHEMA-SYNC
  isRegression?: boolean;
}

export interface SeverityDecision {
  severity: Severity;
  rationale: string;
}

const d = (severity: Severity, rationale: string): SeverityDecision => ({ severity, rationale });

/**
 * Rules matrix (PDF §3.2 + per-check "Default severity" column, §4–§10).
 * Thresholds come from config so the SEO lead can tune them (PDF §17).
 */
export function classifySeverity(ctx: SeverityContext, cfg: SentinelConfig): SeverityDecision {
  const t = cfg.thresholds;
  const tier = ctx.highestTier;
  const tierTxt = `Tier ${tier}`;
  switch (ctx.checkId) {
    case 'TECH-ROBOTS':
      return ctx.affectsIndexablePaths
        ? d('critical', 'robots.txt change affects indexable paths (/collections/, /products/, /blogs/ or CSS/JS).')
        : d('low', 'robots.txt changed but no indexable path is affected — logged for awareness.');
    case 'TECH-NOINDEX':
      return tier <= 2
        ? d('critical', `New noindex on a previously indexed ${tierTxt} URL — blocks indexation of a money/working page.`)
        : d('medium', 'New noindex on a Tier 3 URL (verify it is intentional).');
    case 'TECH-INDEX-COVERAGE':
      return (ctx.metric ?? 0) > t.indexDropPct24h
        ? d('critical', `${ctx.metric}% of indexed pages dropped in 24h (threshold ${t.indexDropPct24h}%).`)
        : d('medium', `Index coverage dropped ${ctx.metric ?? 0}% in 24h (below the ${t.indexDropPct24h}% critical threshold).`);
    case 'TECH-CRAWL-BUDGET':
      return (ctx.metric ?? 0) > t.indexedDuplicatesCritical
        ? d('critical', `${ctx.metric} indexed duplicate/parameter URLs (>${t.indexedDuplicatesCritical}).`)
        : d('medium', `${ctx.metric ?? 0} parameter/tag URLs crawled or indexed (critical above ${t.indexedDuplicatesCritical}).`);
    case 'TECH-4XX':
      if (ctx.searchCrawlerAffected) return d('critical', '429 responses are being served to search-engine crawlers.');
      if (tier === 1) return d('critical', 'Tier 1 page returning 4xx.');
      if (ctx.hasBacklinks) return d('critical', 'URL returning 4xx has external backlinks.');
      return d('medium', `${tierTxt} URL returning 4xx without backlinks.`);
    case 'TECH-5XX':
      return d('critical', 'Server error / >3s server response — PDF classifies all as Critical.');
    case 'TECH-REDIRECTS':
      return tier === 1 && (ctx.metric ?? 0) > t.redirectMaxHops
        ? d('critical', `Redirect chain (${ctx.metric} hops) on a Tier 1 URL.`)
        : d('medium', `Redirect hygiene problem on a ${tierTxt} URL.`);
    case 'TECH-BROKEN-OUTBOUND':
      return d('low', 'Broken outbound link — trust/UX signal, batch monthly.');
    case 'TECH-CANONICAL':
      return ctx.templateWide || ctx.sitewide
        ? d('critical', 'Canonical defect is template-wide/sitewide.')
        : d('medium', `Canonical defect on a ${tierTxt} URL.`);
    case 'TECH-SHOPIFY-DUP-PATHS':
      return d('critical', 'Shopify /collections/{c}/products/{p} canonicalization is broken.');
    case 'TECH-HOST':
      return d('critical', 'Canonical host split: more than one host/protocol variant resolves 200.');
    case 'PERF-CRUX':
      if (ctx.cwvStatus === 'poor') return d('critical', 'Core Web Vitals "Poor" on a template.');
      return d('medium', 'Core Web Vitals "Needs improvement" on a template.');
    case 'PERF-RENDER-BLOCKING':
      return (ctx.metric ?? 0) > t.lcpDegradeCriticalMs
        ? d('critical', `New render-blocking script degraded LCP by ${ctx.metric}ms (>${t.lcpDegradeCriticalMs}ms).`)
        : d('medium', 'New render-blocking script detected.');
    case 'PERF-IMAGES':
    case 'ONP-IMAGES':
      return tier === 1 ? d('medium', 'Image problem on a Tier 1 page.') : d('low', `Image problem on a ${tierTxt} page.`);
    case 'TECH-HTTPS':
      return d('critical', 'HTTPS / certificate / mixed-content / HSTS failure.');
    case 'TECH-JS-RENDER':
      return ctx.primaryContentClientOnly
        ? d('critical', 'Primary content or links only render client-side.')
        : d('medium', 'Some content/links rely on client-side rendering.');
    case 'TECH-SCHEMA-ERRORS':
      return ctx.isWarning ? d('medium', 'Structured-data warning.') : d('critical', 'Structured-data error — risks rich-result loss or manual action.');
    case 'TECH-SCHEMA-SYNC':
      return ctx.deprecatedTypeInUse
        ? d('critical', 'A schema type in use is deprecated or a newly required field is missing.')
        : d('medium', 'Google structured-data guideline change affecting live markup.');
    case 'TECH-RICH-COVERAGE':
      return d('critical', `Valid rich-result items dropped >${t.richResultDropPct}% day-over-day.`);
    case 'CONT-QUALITY':
      return d('medium', `${tierTxt} page content-quality score below ${t.contentQualityMin}.`);
    case 'CONT-DECAY':
      return tier === 1 ? d('critical', `Tier 1 page lost ≥${t.contentDecayPct}% organic clicks (28d vs prior 28d).`) : d('medium', `${tierTxt} page lost ≥${t.contentDecayPct}% organic clicks.`);
    case 'CONT-FRESHNESS':
    case 'GEO-FRESHNESS':
      return tier === 1 ? d('medium', 'Stale Tier 1 content (Low→Medium on money pages).') : d('low', 'Stale content.');
    case 'ONP-TITLE':
      return ctx.templateWide ? d('critical', 'Title-tag defect is template-wide.') : tier <= 2 ? d('medium', `Title-tag defect on ${tierTxt}.`) : d('low', 'Title-tag defect on a Tier 3 page.');
    case 'ONP-HEADINGS':
    case 'ONP-OG':
    case 'GEO-STRUCTURE':
    case 'AIC-12':
      return d('low', 'Hygiene item — batch monthly.');
    case 'ONP-SERP-FEATURE':
      return tier === 1 ? d('critical', 'Lost SERP feature for a Tier 1 keyword.') : d('medium', 'Lost SERP feature.');
    case 'OFF-TOXIC':
      return (ctx.metric ?? 0) > t.toxicDomainsPerWeekCritical
        ? d('critical', `${ctx.metric} toxic referring domains this week (>${t.toxicDomainsPerWeekCritical}).`)
        : d('medium', `${ctx.metric ?? 0} toxic referring domains this week.`);
    case 'AEO-AI-CRAWLERS':
      return ctx.unintentional
        ? d('critical', 'AI crawler blocked unintentionally (not in the configured AI-crawler policy).')
        : d('low', 'AI crawler blocked by deliberate, documented policy — surfaced for transparency.');
    case 'AIC-01':
      return (ctx.metric ?? 0) > t.scaledAbuseNearIdentical7d
        ? d('critical', `${ctx.metric} near-identical pages published in 7 days (>${t.scaledAbuseNearIdentical7d}).`)
        : d('medium', `${ctx.metric ?? 0} near-identical pages published in 7 days.`);
    case 'AIC-02':
      return tier === 1 ? d('critical', 'Unedited AI boilerplate on a Tier 1 page.') : d('medium', 'Unedited AI boilerplate.');
    case 'AIC-03':
      return ctx.isProductClaim ? d('critical', 'Fabricated/contradicting product claim (Merchant misrepresentation risk).') : d('medium', 'Unsupported claim in blog content.');
    case 'AIC-06':
      return d('critical', 'Fake or templated review/testimonial markup.');
    case 'AIC-07':
      return d('critical', 'Unverified YMYL claim — blocks publish in QA gate until human sign-off.');
    case 'AIC-08':
      return d('critical', 'Doorway-page pattern detected.');
    case 'AIC-11':
      return tier <= 2 ? d('medium', 'Authorship/disclosure mismatch on a ranking page.') : d('low', 'Missing author attribution.');
    default: {
      const check = getCheck(ctx.checkId);
      if (check.issueClass === 'critical') return d('critical', check.defaultSeverityText);
      if (check.issueClass === 'low') return d('low', check.defaultSeverityText);
      // Generic Medium checks: PDF §3.2 Low examples include "H-tag order on low-traffic pages",
      // so Tier-3-only findings for Medium checks without an explicit rule stay Medium per the table.
      return d('medium', `${check.defaultSeverityText} (${tierTxt}).`);
    }
  }
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, medium: 1, low: 2 };

export function escalateOneLevel(s: Severity): Severity {
  return s === 'low' ? 'medium' : 'critical';
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b];
}
