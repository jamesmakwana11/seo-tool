/**
 * Fix verification (PDF §12.3 FIXED → VERIFIED): re-fetches an issue's affected URLs (cap 200) plus whatever
 * context the check's analyzer needs, re-runs THAT check's analyzer and reports the honest failing-URL count.
 *
 * Never fakes a pass:
 *  - `canVerify` is true only for crawler-evaluable checks that have an analyzer here, and only when the crawler is ready;
 *  - if the analyzer could not evaluate (missing baseline, truncated crawl…) the outcome is `error`, not `passed`;
 *  - URLs that could not be fetched / no longer return a 200 HTML page cannot prove a content fix → `error` unless
 *    other URLs still fail (then `failed`).
 */
import { getCheck, type Issue, type PageTemplate, type PageTier } from '@sentinel/shared';
import type { Finding, PreviousCrawlState, Reverifier } from '../services/ports';
import type { Collector, ContextNeed } from '../crawler/engine';
import type { ParsedPage } from '../crawler/types';
import { hostOf, normalizeUrl, sameUrl, templateOf } from '../crawler/url';
import { ANALYZERS_BY_ID, runAnalyzers, type AnalyzerDef } from './analyzers';
import { isBlockingScript } from './performance';

export interface ReverifierDeps {
  /** Fetch + parse + context collection (from `createCrawlEngine(...).collector` or `createCollector`). */
  collector: Pick<Collector, 'collect' | 'readiness'>;
  /** Analyzer registry (defaults to the full registry). */
  analyzers?: Record<string, AnalyzerDef>;
  /** Base URL to verify against (defaults to the collector's readiness().baseUrl). */
  baseUrl?: string;
  tierOf?: (url: string) => PageTier;
  /** Latest crawl snapshot (robots.txt, head scripts…) — used where an analyzer diffs against a baseline. */
  previous?: () => PreviousCrawlState | undefined;
  maxUrls?: number;
  /** Max pages for checks that need the full link graph (TECH-ORPHAN, TECH-CRAWL-DEPTH). */
  bfsMaxPages?: number;
  /** Extra same-template pages fetched as context for template-relative checks (boilerplate removal, duplicates). */
  templateContextPages?: number;
}

/** Checks whose verdict depends on the HTTP response itself (a non-200 answer is a valid observation). */
const STATUS_CHECKS = new Set([
  'TECH-4XX', 'TECH-5XX', 'TECH-REDIRECTS', 'TECH-DISCONTINUED', 'TECH-SITEMAP', 'TECH-ROBOTS', 'TECH-HOST', 'TECH-HTTPS', 'AEO-AI-CRAWLERS',
  'TECH-ORPHAN', 'TECH-CRAWL-DEPTH', 'TECH-PAGINATION', 'TECH-SHOPIFY-DUP-PATHS', 'TECH-CRAWL-BUDGET',
]);

export function createReverifier(deps: ReverifierDeps): Reverifier {
  const registry = deps.analyzers ?? ANALYZERS_BY_ID;
  const maxUrls = deps.maxUrls ?? 200;

  function canVerify(checkId: string): { ok: boolean; reason?: string } {
    let check;
    try {
      check = getCheck(checkId);
    } catch {
      return { ok: false, reason: `Unknown check ${checkId}.` };
    }
    if (!check.crawlerEvaluable) return { ok: false, reason: `${checkId} needs ${check.dataSources.filter((d) => d !== 'crawler').join(', ') || 'non-crawler'} data — it cannot be re-verified by a crawl.` };
    if (!registry[checkId]) return { ok: false, reason: `${checkId} has no crawler analyzer yet — verify manually.` };
    const r = deps.collector.readiness();
    if (!r.ready) return { ok: false, reason: `Crawler not ready: ${r.reason}` };
    return { ok: true };
  }

  async function verify(issue: Issue) {
    const can = canVerify(issue.checkId);
    if (!can.ok) return { outcome: 'error' as const, checkedUrls: 0, failingUrls: 0, details: can.reason ?? 'cannot verify' };
    const a = registry[issue.checkId];
    const baseUrl = deps.baseUrl ?? deps.collector.readiness().baseUrl!;
    const origin = new URL(baseUrl).origin;
    const siteHost = hostOf(baseUrl);
    const affected = issue.affectedUrls.filter((u) => hostOf(u) === siteHost || !hostOf(u)).map((u) => new URL(u, origin).toString());
    const capped = affected.slice(0, maxUrls);
    const tierFallback = issue.highestTier ?? 2;
    const tierOf = deps.tierOf ?? ((u: string) => (capped.some((x) => sameUrl(x, u)) ? tierFallback : 3));

    // ---------------------------------------------------------------- what to fetch
    const needs = new Set<ContextNeed>(a.needs);
    needs.add('robots');
    const bfs = needs.has('bfs');
    const pageUrls = capped.filter((u) => !/\/robots\.txt$|\/sitemap[^/]*\.xml$/.test(new URL(u).pathname));
    let extra: string[] = [];
    if (a.scope === 'template' || a.checkId === 'ONP-TPL-HOME') {
      // Template-relative checks need peers of the same template (boilerplate removal, duplicate detection).
      const templates = new Set<PageTemplate>([...(issue.template ? [issue.template] : []), ...pageUrls.map(templateOf)]);
      extra = await discoverPeers(deps, origin, templates, pageUrls, deps.templateContextPages ?? 6);
    }
    const urls = [...pageUrls, ...extra].map((url) => ({ url, reason: 'reverify' as const }));

    const prev = { ...(deps.previous?.() ?? {}) } as PreviousCrawlState;
    // A noindex issue's URLs were indexable before the regression by definition.
    if (issue.checkId === 'TECH-NOINDEX') prev.indexableUrls = [...new Set([...(prev.indexableUrls ?? []), ...capped])];
    // Robots: judge the CURRENT file (blocked indexable paths), not "did it change since yesterday".
    if (issue.checkId === 'TECH-ROBOTS') delete prev.robotsTxt;
    if (issue.checkId === 'PERF-THIRD-PARTY') {
      const before = issue.evidence.map((e) => e.data?.previousKb).find((v) => typeof v === 'number') as number | undefined;
      if (before !== undefined && issue.template) prev.thirdPartyKbByTemplate = { ...(prev.thirdPartyKbByTemplate ?? {}), [issue.template]: before };
    }

    const collected = await deps.collector.collect({
      type: bfs ? 'full' : 'reverify', baseUrl, urls, maxPages: bfs ? deps.bfsMaxPages ?? 2000 : urls.length + 1, tierOf, previous: prev, needs,
    });
    const { pages, ctx } = collected;

    if (issue.checkId === 'PERF-RENDER-BLOCKING') {
      // Baseline = every head script currently on these pages EXCEPT the flagged one(s), so only the flagged script is judged.
      const flagged = new Set(issue.evidence.map((e) => e.data?.src).filter((s): s is string => typeof s === 'string').map((s) => s.replace(/\?.*$/, '')));
      if (!flagged.size) return { outcome: 'error' as const, checkedUrls: 0, failingUrls: 0, details: 'Issue evidence does not name the flagged script (data.src) — cannot re-verify.' };
      const base: Partial<Record<PageTemplate, string[]>> = {};
      for (const p of pages) if (p.html) base[p.template] = [...new Set([...(base[p.template] ?? []), ...p.html.headScripts.map((s) => s.src.replace(/\?.*$/, '')).filter((s) => !flagged.has(s))])];
      ctx.previous = { ...prev, headScriptsByTemplate: base };
      void isBlockingScript;
    }

    // ---------------------------------------------------------------- re-run only this check
    const res = runAnalyzers(pages, ctx, [issue.checkId]);
    const checkedUrls = a.scope === 'site' ? Math.max(1, capped.length) : pageUrls.length;
    if (!res.evaluatedChecks.includes(issue.checkId)) {
      return { outcome: 'error' as const, checkedUrls, failingUrls: 0, details: `Check could not be evaluated: ${res.notEvaluated[issue.checkId] ?? 'unknown reason'}.` };
    }
    let findings = res.findings.filter((f) => f.checkId === issue.checkId);
    if (issue.template && a.scope !== 'site') findings = findings.filter((f) => !f.template || f.template === issue.template);
    if (issue.checkId === 'AEO-AI-CRAWLERS') {
      const bot = issue.evidence.map((e) => e.data?.bot).find((b): b is string => typeof b === 'string');
      if (bot) findings = findings.filter((f) => f.key?.endsWith(`::${bot}`));
    }

    const failingSet = new Set<string>();
    const affectedKeys = new Set(capped.map(normalizeUrl));
    for (const f of findings) {
      for (const u of f.urls) {
        if (a.scope === 'site' || affectedKeys.has(normalizeUrl(u)) || capped.some((x) => sameUrl(x, u))) failingSet.add(u);
      }
    }
    // Site-level findings may list URLs other than the issue's (e.g. robots.txt URL): count them all.
    if (a.scope === 'site') for (const f of findings) f.urls.forEach((u) => failingSet.add(u));
    const failingUrls = failingSet.size;
    const evidence: Finding['evidence'] = findings.flatMap((f) => f.evidence).slice(0, 20);

    // ---------------------------------------------------------------- URLs we could not actually check
    const unverifiable: { url: string; why: string }[] = [];
    if (a.scope !== 'site') {
      for (const u of pageUrls) {
        const p = findPage(pages, u);
        if (!p) unverifiable.push({ url: u, why: 'not fetched' });
        else if (p.skippedByRobots) unverifiable.push({ url: u, why: 'disallowed by robots.txt for our user-agent' });
        else if (p.status === null && issue.checkId !== 'TECH-5XX') unverifiable.push({ url: u, why: p.error ?? 'no response' });
        else if (!STATUS_CHECKS.has(issue.checkId) && !(p.status === 200 && p.html && !p.chain.length)) {
          unverifiable.push({ url: u, why: `no longer a 200 HTML page (HTTP ${p.status}${p.chain.length ? ` → ${p.finalStatus}` : ''})` });
        }
      }
    }
    const capNote = affected.length > capped.length ? ` Only the first ${capped.length} of ${affected.length} affected URLs were re-checked.` : '';
    if (failingUrls > 0) {
      return {
        outcome: 'failed' as const, checkedUrls, failingUrls,
        details: `${failingUrls} URL(s) still fail ${issue.checkId}: ${[...failingSet].slice(0, 10).join(', ')}${failingUrls > 10 ? ' …' : ''}.${unverifiable.length ? ` ${unverifiable.length} URL(s) could not be checked.` : ''}${capNote}`,
        evidence,
      };
    }
    if (unverifiable.length) {
      return {
        outcome: 'error' as const, checkedUrls: checkedUrls - unverifiable.length, failingUrls: 0,
        details: `No remaining failures on the URLs that could be checked, but ${unverifiable.length} URL(s) could not be verified: ${unverifiable.slice(0, 5).map((x) => `${x.url} (${x.why})`).join('; ')}.${capNote}`,
        evidence: unverifiable.slice(0, 10).map((x) => ({ kind: 'note' as const, label: 'Not verifiable', url: x.url, content: x.why })),
      };
    }
    return { outcome: 'passed' as const, checkedUrls, failingUrls: 0, details: `${issue.checkId} re-run on ${checkedUrls} URL(s): no failures.${capNote}` };
  }

  return { canVerify, verify };
}

function findPage(pages: ParsedPage[], url: string): ParsedPage | undefined {
  return pages.find((p) => !p.derivedFrom && sameUrl(p.url, url));
}

/** Same-template peer pages linked from the homepage (template context for relative checks). */
async function discoverPeers(deps: ReverifierDeps, origin: string, templates: Set<PageTemplate>, exclude: string[], n: number): Promise<string[]> {
  if (n <= 0 || !templates.size) return [];
  const home = await deps.collector.collect({ type: 'reverify', baseUrl: origin, urls: [], maxPages: 1, tierOf: () => 3, needs: new Set() });
  const links = home.pages.flatMap((p) => p.html?.internalLinks ?? []).filter((l) => hostOf(l) === hostOf(origin) && !l.includes('?'));
  const out: string[] = [];
  const level2: string[] = [];
  for (const l of links) {
    if (out.length >= n) break;
    if (exclude.some((x) => sameUrl(x, l)) || out.some((x) => sameUrl(x, l))) continue;
    if (templates.has(templateOf(l))) out.push(l);
    else if (templateOf(l) === 'collection') level2.push(l);
  }
  // Products are usually one level down (collection pages).
  if (out.length < n && level2.length) {
    const cols = await deps.collector.collect({ type: 'reverify', baseUrl: origin, urls: level2.slice(0, 2).map((url) => ({ url, reason: 'reverify' })), maxPages: 3, tierOf: () => 3, needs: new Set() });
    for (const l of cols.pages.flatMap((p) => p.html?.internalLinks ?? [])) {
      if (out.length >= n) break;
      if (hostOf(l) !== hostOf(origin) || l.includes('?') || exclude.some((x) => sameUrl(x, l)) || out.some((x) => sameUrl(x, l))) continue;
      if (templates.has(templateOf(l)) && !/^\/collections\/[^/]+\/products\//.test(new URL(l).pathname)) out.push(l);
    }
  }
  return out;
}
