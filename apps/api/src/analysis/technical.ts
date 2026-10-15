/**
 * Technical SEO analyzers (PDF §4.1–§4.5): crawlability, status codes, canonicals, duplication, host, HTTPS, pagination.
 */
import type { PageTemplate } from '@sentinel/shared';
import { nearIdenticalClusters } from '@sentinel/shared';
import type { Finding } from '../services/ports';
import { diffRobots, isAllowed } from '../crawler/robots';
import type { ParsedPage } from '../crawler/types';
import { collectionHandle, hostOf, isSameSite, normalizeUrl, pageParam, pathOf, productHandle, sameUrl, stripQuery, templateOf, urlKey } from '../crawler/url';
import {
  aggregate, canonicalOf, escapeHtml, groupByTemplate, htmlEv, httpEv, inlinksOf, isIntentionalNoindex, isNoindex, MAX_KEPT_EVIDENCE, maxOf, metricEv, minOf, noun, perTemplate,
  problemCollector, textEv, trunc, type AnalyzerResult, type Ev, type Prepared, type Problem,
} from './context';

const NOT = (reason: string): AnalyzerResult => ({ evaluated: false, findings: [], reason });

// ------------------------------------------------------------------------------------------------ TECH-ROBOTS

/** Representative indexable paths per template, from crawled pages where possible. */
function indexableProbePaths(prep: Prepared): { label: string; path: string }[] {
  const pick = (t: PageTemplate, fallback: string) => {
    const p = prep.ok.find((x) => x.template === t && !x.url.includes('?'));
    return p ? pathOf(p.url) : fallback;
  };
  return [
    { label: 'homepage', path: '/' },
    { label: '/collections/', path: pick('collection', '/collections/all') },
    { label: '/products/', path: pick('product', '/products/sample-product') },
    { label: '/blogs/', path: pick('blog_article', '/blogs/news/sample-article') },
  ];
}

function cssJsProbePaths(prep: Prepared): string[] {
  const home = prep.ok.find((p) => p.template === 'home') ?? prep.ok[0];
  if (!home?.html) return ['/cdn/shop/t/1/assets/theme.css', '/cdn/shop/t/1/assets/theme.js'];
  const own = [...home.html.stylesheets, ...home.html.scriptSrcs].filter((u) => hostOf(u) === prep.ctx.host).slice(0, 10);
  return own.length ? own.map((u) => { const x = new URL(u); return `${x.pathname}${x.search}`; }) : ['/cdn/shop/t/1/assets/theme.css'];
}

export function analyzeRobots(prep: Prepared): AnalyzerResult {
  const r = prep.ctx.robots;
  if (!r) return NOT('robots.txt was not fetched');
  const url = r.url;
  const prevTxt = prep.ctx.previous?.robotsTxt;
  if (r.status === null || r.status >= 500) {
    return {
      evaluated: true,
      findings: [{
        checkId: 'TECH-ROBOTS', key: 'TECH-ROBOTS::site', title: `robots.txt unreachable (${r.status ?? r.error})`,
        summary: `GET ${url} returned ${r.status ?? `no response (${r.error})`}. Google treats a 5xx/unreachable robots.txt as "disallow all" and pauses crawling of the site.`,
        urls: [url], severityContext: { affectsIndexablePaths: true }, evidence: [httpEv(url, { status: r.status, finalStatus: r.status, chain: [], error: r.error })],
      }],
    };
  }
  const body = r.body ?? '';
  const blocked: { what: string; agent: string; line?: number; rule?: string }[] = [];
  for (const ua of ['Googlebot', '*']) {
    for (const probe of indexableProbePaths(prep)) {
      const d = isAllowed(r.parsed, ua, probe.path);
      if (!d.allowed) blocked.push({ what: `${probe.label} (${probe.path})`, agent: d.agent, line: d.rule?.line, rule: d.rule ? `Disallow: ${d.rule.path}` : undefined });
    }
    for (const path of cssJsProbePaths(prep)) {
      const d = isAllowed(r.parsed, ua, path);
      if (!d.allowed) blocked.push({ what: `CSS/JS ${path}`, agent: d.agent, line: d.rule?.line, rule: d.rule ? `Disallow: ${d.rule.path}` : undefined });
    }
  }
  const uniqBlocked = blocked.filter((b, i) => blocked.findIndex((x) => x.what === b.what && x.agent === b.agent) === i);
  const changed = prevTxt !== undefined && prevTxt.trim() !== body.trim();
  const diff = changed ? diffRobots(prevTxt!, body) : undefined;
  if (!uniqBlocked.length && !changed) return { evaluated: true, findings: [] };
  const evidence: Ev[] = [];
  if (diff) evidence.push({ kind: 'diff', label: 'robots.txt vs previous snapshot', url, content: [...diff.removed.map((l) => `- ${l}`), ...diff.added.map((l) => `+ ${l}`)].join('\n'), data: diff });
  if (uniqBlocked.length) evidence.push({ kind: 'note', label: 'Indexable paths / assets now disallowed', url, data: { blocked: uniqBlocked } });
  evidence.push({ kind: 'http_response', label: `robots.txt (HTTP ${r.status})`, url, content: body.slice(0, 3000) });
  const affects = uniqBlocked.length > 0;
  const title = affects
    ? `robots.txt ${changed ? 'change ' : ''}blocks indexable paths: ${[...new Set(uniqBlocked.map((b) => b.what.split(' (')[0]))].join(', ')}`
    : `robots.txt changed (${diff!.added.length} line(s) added, ${diff!.removed.length} removed) — no indexable path affected`;
  return {
    evaluated: true,
    findings: [{
      checkId: 'TECH-ROBOTS', key: 'TECH-ROBOTS::site', title,
      summary: affects
        ? uniqBlocked.map((b) => `• ${b.what} disallowed for ${b.agent === '*' ? 'all crawlers (*)' : b.agent}${b.line ? ` by line ${b.line} "${b.rule}"` : ''}`).join('\n')
        : 'robots.txt differs from yesterday\'s snapshot; none of /, /collections/, /products/, /blogs/ or theme CSS/JS is blocked.',
      urls: [url], severityContext: { affectsIndexablePaths: affects }, evidence,
    }],
  };
}

// ------------------------------------------------------------------------------------------------ TECH-NOINDEX

export function analyzeNoindex(prep: Prepared): AnalyzerResult {
  const prevIdx = prep.ctx.previous?.indexableUrls;
  const prevKeys = prevIdx ? new Set(prevIdx.map(urlKey)) : undefined;
  const wasIndexable = (u: string) => !!prevKeys && prevKeys.has(urlKey(u));
  const pages = prep.all.filter((p) => p.status === 200 && p.html && !p.skippedByRobots && !p.budgetSample && !p.paginated && !p.scopedSample);
  const MONEY: PageTemplate[] = ['home', 'collection', 'product', 'blog_article'];
  return perTemplate(prep, pages, 'TECH-NOINDEX', 'new noindex', (p) => {
    const n = isNoindex(p);
    if (!n.noindex || isIntentionalNoindex(p.url, prep.ctx)) return [];
    if (prevKeys ? !wasIndexable(p.url) : !MONEY.includes(p.template)) return [];
    const ev: Ev = n.via === 'meta robots'
      ? htmlEv(p.url, 'meta robots', `<meta name="robots" content="${escapeHtml(n.value ?? '')}">`)
      : { kind: 'http_response', label: 'X-Robots-Tag header', url: p.url, content: `HTTP ${p.status}\nX-Robots-Tag: ${n.value}` };
    return [{ label: prevKeys ? `newly noindexed (were indexable last run) via ${n.via}` : `noindexed via ${n.via} (no previous baseline — first run)`, evidence: [ev] }];
  }, () => ({ businessImpact: 'Noindexed pages drop out of Google\'s index — lost rankings and revenue on these URLs until removed.' }));
}

// ------------------------------------------------------------------------------------------------ TECH-SITEMAP

export function analyzeSitemap(prep: Prepared): AnalyzerResult & { invalid: { url: string; problem: string }[] } {
  const sm = prep.ctx.sitemap;
  if (!sm) return { ...NOT('sitemap was not fetched'), invalid: [] };
  const max = prep.ctx.thresholds.sitemapMaxUrls ?? 50000;
  const collector = problemCollector();
  const problems: Problem[] = collector.problems;
  const invalid: { url: string; problem: string }[] = [];
  const add = (label: string, url: string, ev?: Ev) => { collector.add(label, url, ev); };
  const reachable = sm.files.filter((f) => f.kind === 'urlset' || f.kind === 'sitemapindex');
  if (!reachable.length) {
    for (const f of sm.files) add(f.kind === 'invalid' ? 'sitemap file is not valid XML' : 'sitemap unreachable', f.url, { kind: 'http_response', label: `${f.url}`, url: f.url, content: `HTTP ${f.status ?? 'no response'} — ${f.error ?? ''}` });
  }
  for (const f of sm.files) {
    if (reachable.length && (f.kind === 'invalid' || f.kind === 'unreachable')) add(f.kind === 'invalid' ? 'sitemap file is not valid XML' : 'sitemap file unreachable', f.url, { kind: 'http_response', label: f.url, url: f.url, content: `HTTP ${f.status ?? 'no response'} — ${f.error ?? ''}` });
    if (f.count > max) add(`sitemap file lists more than ${max} URLs`, f.url, metricEv('URLs in file', { count: f.count, max }, f.url));
  }
  const now = prep.ctx.now.getTime();
  const lastmods: string[] = [];
  let checked = 0;
  for (const e of sm.entries) {
    if (!isSameSite(e.url, prep.ctx.host)) {
      add('sitemap entries on another host', e.url);
      invalid.push({ url: e.url, problem: 'different host' });
      continue;
    }
    if (e.lastmod) {
      lastmods.push(e.lastmod);
      const t = Date.parse(e.lastmod);
      if (Number.isNaN(t)) {
        add('sitemap entries with an invalid <lastmod>', e.url, textEv(e.url, 'lastmod', e.lastmod));
        invalid.push({ url: e.url, problem: `invalid lastmod "${e.lastmod}"` });
      } else if (t > now + 86400000) {
        add('sitemap entries with a <lastmod> in the future', e.url, textEv(e.url, 'lastmod', e.lastmod));
        invalid.push({ url: e.url, problem: `lastmod in the future (${e.lastmod})` });
      }
    }
    const s = prep.statusOf(e.url);
    if (!s) continue;
    checked++;
    if (s.status === null) continue; // network failure: reported by TECH-5XX, not a sitemap defect
    if (s.status >= 300 && s.status < 400) {
      add('sitemap entries that redirect', e.url, httpEv(e.url, s));
      invalid.push({ url: e.url, problem: `redirects (${s.status}) to ${s.finalUrl}` });
    } else if (s.status >= 400) {
      add(`sitemap entries returning ${s.status >= 500 ? '5xx' : '4xx'}`, e.url, httpEv(e.url, s));
      invalid.push({ url: e.url, problem: `HTTP ${s.status}` });
    } else if (s.noindex) {
      add('noindexed sitemap entries', e.url, htmlEv(e.url, 'meta robots / X-Robots-Tag', s.page?.html?.metaRobots ?? s.page?.headers['x-robots-tag'] ?? 'noindex'));
      invalid.push({ url: e.url, problem: 'noindex' });
    } else if (s.page?.html) {
      const c = canonicalOf(s.page);
      if (c && !sameUrl(c, e.url)) {
        add('sitemap entries that canonicalize elsewhere', e.url, htmlEv(e.url, 'canonical', `<link rel="canonical" href="${escapeHtml(c)}">`));
        invalid.push({ url: e.url, problem: `canonical points to ${c}` });
      }
    }
  }
  // lastmod accuracy: every entry carrying the same timestamp means lastmod is not tracking real changes.
  if (lastmods.length >= 20 && new Set(lastmods).size === 1) {
    add('sitemap entries share one identical <lastmod> (not reflecting real changes)', sm.files[0]?.url ?? sm.rootUrls[0], textEv(sm.rootUrls[0], 'lastmod', lastmods[0]));
  }
  const f = aggregate({
    checkId: 'TECH-SITEMAP', noun: 'sitemap problems', problems,
    title: problems.length ? `Sitemap integrity: ${problems.map((p) => `${p.urls.length} ${p.label}`).join('; ')}` : undefined,
    extraEvidence: [metricEv('Sitemap coverage', { files: sm.files.map((x) => ({ url: x.url, kind: x.kind, status: x.status, count: x.count })), entries: sm.entries.length, entriesStatusChecked: checked })],
  });
  return { evaluated: true, findings: f ? [f] : [], invalid };
}

// ------------------------------------------------------------------------------------------------ TECH-ORPHAN / TECH-CRAWL-DEPTH

export function analyzeOrphans(prep: Prepared): AnalyzerResult {
  if (prep.ctx.crawlType !== 'full') return NOT('orphan detection needs the full link graph (full crawl only)');
  if (prep.ctx.bfsTruncated) return NOT('full crawl hit maxPages before the link graph was exhausted — orphan status unknown');
  if (!prep.ctx.sitemap) return NOT('sitemap not fetched');
  const inSitemap = new Set(prep.ctx.sitemap.entries.map((e) => normalizeUrl(e.url)));
  const cands = prep.indexable.filter((p) => p.template !== 'home' && (inSitemap.has(normalizeUrl(p.url)) || p.inSitemap));
  return perTemplate(prep, cands, 'TECH-ORPHAN', 'no internal links', (p) => (inlinksOf(prep, p.url).length === 0
    ? [{ label: 'receive no internal links (found only via the sitemap)', evidence: [metricEv('internal inlinks', { inlinks: 0, foundVia: 'sitemap' }, p.url)] }]
    : []));
}

export function analyzeCrawlDepth(prep: Prepared): AnalyzerResult {
  if (prep.ctx.crawlType !== 'full') return NOT('click depth is only measured on full crawls (BFS from the homepage)');
  const max = prep.ctx.thresholds.crawlDepthMax ?? 3;
  const pages = prep.indexable.filter((p) => p.depth !== undefined);
  const res = perTemplate(prep, pages, 'TECH-CRAWL-DEPTH', 'excess depth', (p) => (p.tier <= 2 && (p.depth ?? 0) > max
    ? [{ label: `are deeper than ${max} clicks from the homepage`, evidence: [metricEv('click depth', { depth: p.depth, max, tier: p.tier }, p.url)] }]
    : []));
  for (const f of res.findings) {
    const inF = new Set(f.urls);
    f.severityContext = { ...f.severityContext, metric: maxOf(pages.filter((p) => inF.has(p.url)).map((p) => p.depth ?? 0)) };
  }
  return res;
}

// ------------------------------------------------------------------------------------------------ TECH-CRAWL-BUDGET

export function analyzeCrawlBudget(prep: Prepared): AnalyzerResult {
  const discovered = prep.ctx.discoveredBudgetUrls;
  if (!discovered) return NOT('parameter URLs were not sampled');
  const robots = prep.ctx.robots;
  const crawlable = discovered.filter((u) => !robots?.body || isAllowed(robots.parsed, 'Googlebot', `${new URL(u).pathname}${new URL(u).search}`).allowed);
  const indexableSamples: ParsedPage[] = [];
  const evid: Ev[] = [];
  for (const s of prep.budgetSamples) {
    if (s.status !== 200 || !s.html) continue;
    if (robots?.body && !isAllowed(robots.parsed, 'Googlebot', `${new URL(s.url).pathname}${new URL(s.url).search}`).allowed) continue;
    if (isNoindex(s).noindex) continue;
    const c = canonicalOf(s);
    if (c && !sameUrl(c, s.url)) continue;
    indexableSamples.push(s);
    evid.push(htmlEv(s.url, `${s.budgetSample} — crawlable and indexable`, c ? `<link rel="canonical" href="${escapeHtml(c)}"> (self)` : '(no canonical, no noindex, not disallowed in robots.txt)'));
  }
  if (!indexableSamples.length) return { evaluated: true, templates: [], findings: [] };
  const sampled = prep.budgetSamples.length;
  const share = sampled ? indexableSamples.length / sampled : 1;
  const estimate = Math.max(indexableSamples.length, Math.round(crawlable.length * share));
  const findings: Finding[] = [];
  for (const [t, list] of groupByTemplate(indexableSamples)) {
    findings.push({
      checkId: 'TECH-CRAWL-BUDGET', template: t, key: `TECH-CRAWL-BUDGET::${t}`,
      title: `${list.length} sampled parameter/tag URLs on ${noun(t, 2)} are crawlable and indexable (≈${estimate} such URLs linked internally)`,
      summary: `Sorted/filtered/tag URLs (${[...new Set(list.map((x) => x.budgetSample))].join('; ')}) are neither disallowed in robots.txt, noindexed nor canonicalized to the clean URL. ${discovered.length} parameter/tag URLs are linked internally (${crawlable.length} crawlable); ${indexableSamples.length} of ${sampled} sampled are indexable. Indexed counts need GSC.`,
      urls: list.map((x) => x.url), severityContext: { metric: estimate },
      evidence: [...evid.slice(0, 10), metricEv('Crawl-budget sample', { discovered: discovered.length, crawlable: crawlable.length, sampled, indexableSamples: indexableSamples.length, estimate, examples: crawlable.slice(0, 20) })],
    });
  }
  return { evaluated: true, templates: [], findings };
}

// ------------------------------------------------------------------------------------------------ TECH-4XX

const SOFT_404 = /\b(page not found|404|not found|no longer available|this page (does not|doesn't) exist|product (is )?unavailable|nothing (was )?found)\b/i;

export function analyze4xx(prep: Prepared): AnalyzerResult {
  const prevOk = prep.ctx.previous?.okUrls;
  const prevSet = prevOk ? new Set(prevOk.map(normalizeUrl)) : undefined;
  const findings: Finding[] = [];
  const pages = prep.requested.filter((p) => !p.budgetSample);
  const problemsByT = new Map<PageTemplate, ReturnType<typeof problemCollector>>();
  const add = (t: PageTemplate, label: string, url: string, ev: Ev) => {
    let c = problemsByT.get(t);
    if (!c) { c = problemCollector(); problemsByT.set(t, c); }
    c.add(label, url, ev);
  };
  for (const p of pages) {
    const st = p.chain.length ? p.finalStatus : p.status;
    if (st === 429) {
      add(p.template, 'return 429 Too Many Requests', p.url, httpEv(p.url, p));
      continue;
    }
    if (st !== null && st >= 400 && st < 500 && !p.chain.length) {
      const isNew = prevSet ? prevSet.has(normalizeUrl(p.url)) : undefined;
      const inl = inlinksOf(prep, p.url).length;
      add(p.template, isNew ? `newly return ${st} (were 200 last run)` : `return ${st}${prevSet ? '' : ''}`, p.url, { ...httpEv(p.url, p), data: { status: st, internalInlinks: inl, newSinceLastRun: isNew } });
    }
  }
  // Internal link targets (not crawled as pages) answering 4xx.
  for (const l of prep.ctx.linkTargets.values()) {
    if (hostOf(l.url) !== prep.ctx.host || l.chain.length || l.status === null || l.status < 400 || l.status >= 500) continue;
    const isNew = prevSet ? prevSet.has(normalizeUrl(l.url)) : undefined;
    const from = inlinksOf(prep, l.url);
    add(templateOf(l.url), isNew ? `newly return ${l.status} (were 200 last run)` : `return ${l.status} (linked internally)`, l.url, { ...httpEv(l.url, { ...l, finalStatus: l.finalStatus }), data: { status: l.status, internalInlinks: from.length, linkedFrom: from.slice(0, 10), newSinceLastRun: isNew } });
  }
  // soft 404s: 200 responses whose title/H1 says "not found"
  for (const p of prep.ok) {
    const t = `${p.html!.title ?? ''} | ${p.html!.h1s.join(' | ')}`;
    if (SOFT_404.test(t) || (p.template === 'product' && p.html!.wordCount < 30 && !p.html!.schemaTypes.includes('Product'))) {
      add(p.template, 'look like soft 404s (200 status, "not found" content)', p.url, textEv(p.url, 'title / H1', t));
    }
  }
  const searchBots = (prep.ctx.botProbes ?? []).filter((b) => (b.bot === 'Googlebot' || b.bot === 'Bingbot') && b.status === 429);
  if (searchBots.length) {
    const home = `${prep.ctx.origin}/`;
    findings.push({
      checkId: 'TECH-4XX', template: 'home', key: 'TECH-4XX::bot-429',
      title: `429 Too Many Requests served to ${searchBots.map((b) => b.bot).join(' and ')}`,
      summary: 'The homepage returns 429 when requested with a search-engine crawler user-agent — rate limiting / bot protection is throttling search crawlers.',
      urls: [home], severityContext: { searchCrawlerAffected: true },
      evidence: searchBots.map((b) => ({ kind: 'http_response' as const, label: `${b.bot} request`, url: home, content: `User-Agent: ${b.userAgent}\n→ HTTP ${b.status}` })),
    });
  }
  for (const [t, m] of problemsByT) {
    const f = aggregate({ checkId: 'TECH-4XX', template: t, noun: '4xx responses', problems: m.problems });
    if (f) findings.push(f);
  }
  return { evaluated: true, templates: [...new Set(pages.map((p) => p.template))], findings };
}

// ------------------------------------------------------------------------------------------------ TECH-5XX

export function analyze5xx(prep: Prepared): AnalyzerResult {
  const maxMs = prep.ctx.thresholds.serverResponseMs ?? 3000;
  const pages = prep.requested;
  return perTemplate(prep, pages, 'TECH-5XX', 'server errors / slow responses', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const st = p.finalStatus ?? p.status;
    if (p.status === null || (p.chain.length && p.finalStatus === null && !p.redirectLoop && !p.tooManyRedirects)) {
      if (p.redirectLoop || p.tooManyRedirects) return out;
      out.push({ label: /timeout/i.test(p.error ?? '') ? `time out (no response within the request timeout)` : 'fail with a network error (no response)', evidence: [httpEv(p.url, p)] });
    } else if (st !== null && st >= 500) {
      out.push({ label: `return 5xx`, evidence: [httpEv(p.url, p)] });
    }
    if (p.responseMs !== undefined && p.status !== null && p.responseMs > maxMs) {
      out.push({ label: `respond slower than ${maxMs}ms at server level`, evidence: [metricEv('server response time (time to headers)', { responseMs: p.responseMs, thresholdMs: maxMs }, p.url)] });
    }
    return out;
  }, (_t, list) => {
    const slow = list.filter((p) => (p.responseMs ?? 0) > maxMs).map((p) => p.responseMs ?? 0);
    return slow.length ? { severityContext: { metric: maxOf(slow) } } : {};
  });
}

// ------------------------------------------------------------------------------------------------ TECH-REDIRECTS

export function analyzeRedirects(prep: Prepared): AnalyzerResult {
  const maxHops = prep.ctx.thresholds.redirectMaxHops ?? 1;
  type R = { url: string; status: number | null; finalStatus: number | null; chain: ParsedPage['chain']; redirectLoop: boolean; tooManyRedirects?: boolean; error?: string; template: PageTemplate; source: string };
  const items: R[] = [];
  for (const p of prep.requested) if (p.chain.length || p.redirectLoop) items.push({ ...p, source: 'crawled URL' });
  for (const l of prep.ctx.linkTargets.values()) {
    if (!isSameSite(l.url, prep.ctx.host)) continue;
    if (l.chain.length || l.redirectLoop) items.push({ ...l, template: templateOf(l.url), source: 'internal link / canonical target' });
  }
  const byT = groupByTemplate(items);
  const findings: Finding[] = [];
  for (const [t, list] of byT) {
    const collector = problemCollector();
    const add = (label: string, r: R) => {
      const p = collector.get(label);
      const ev = p && (p.evidence!.length >= MAX_KEPT_EVIDENCE) ? undefined : httpEv(r.url, r, `${r.source}: ${r.chain.map((h) => h.status).join(' → ')}${r.finalStatus ? ` → ${r.finalStatus}` : ''}`);
      collector.add(label, r.url, ev, true);
    };
    for (const r of list) {
      if (r.redirectLoop) add('are caught in a redirect loop', r);
      else if (r.tooManyRedirects) add('redirect more than 5 times', r);
      // Protocol/host canonicalization hops (http→https, www) are TECH-HOST's concern; judge path redirects only.
      const temp = r.chain.filter((h) => [302, 303, 307].includes(h.status) && !(hostOf(h.url) !== hostOf(h.location) || new URL(h.url).protocol !== new URL(h.location).protocol));
      if (temp.length) add(`use temporary redirects (${[...new Set(temp.map((h) => h.status))].join('/')}) that should be 301`, r);
      if (r.chain.length > maxHops) add(`redirect through a chain of more than ${maxHops} hop`, r);
      if (r.finalStatus !== null && r.finalStatus >= 400) add(`redirect to a ${r.finalStatus >= 500 ? '5xx' : '4xx'} page`, r);
    }
    const f = aggregate({ checkId: 'TECH-REDIRECTS', template: t, noun: 'redirect problems', problems: collector.problems });
    if (f) {
      const inF = new Set(f.urls);
      f.severityContext = { ...f.severityContext, metric: maxOf(list.filter((x) => inF.has(x.url)).map((x) => x.chain.length)) };
      findings.push(f);
    }
  }
  return { evaluated: true, templates: [...new Set(prep.requested.map((p) => p.template))], findings };
}

// ------------------------------------------------------------------------------------------------ TECH-BROKEN-INTERNAL / OUTBOUND

export function analyzeBrokenInternal(prep: Prepared): AnalyzerResult {
  let unchecked = 0;
  const hostCache = new Map<string, string>();
  const host = (l: string) => {
    let h = hostCache.get(l);
    if (h === undefined) { h = hostOf(l); hostCache.set(l, h); }
    return h;
  };
  const res = perTemplate(prep, prep.ok, 'TECH-BROKEN-INTERNAL', 'broken internal links', (p) => {
    const broken: { target: string; status: number | null; error?: string }[] = [];
    for (const l of p.html!.internalLinks) {
      if (host(l) !== prep.ctx.host) continue;
      const s = prep.statusOf(l);
      if (!s) {
        unchecked++;
        continue;
      }
      const fin = s.chain.length ? s.finalStatus : s.status;
      if (s.redirectLoop || (fin !== null && fin >= 400)) broken.push({ target: l, status: fin, error: s.redirectLoop ? 'redirect loop' : undefined });
    }
    if (!broken.length) return [];
    const anchors = p.html!.links.filter((x) => broken.some((b) => b.target === x.url));
    return [{
      label: 'contain internal links resolving to non-200',
      evidence: [{
        kind: 'html_snippet', label: `${broken.length} broken link(s)`, url: p.url,
        content: anchors.slice(0, 10).map((a) => `<a href="${escapeHtml(a.url)}">${escapeHtml(trunc(a.text, 60))}</a> → ${broken.find((b) => b.target === a.url)?.status ?? 'loop'}`).join('\n'),
        data: { broken },
      }],
    }];
  });
  if (unchecked) for (const f of res.findings) f.evidence.push({ kind: 'note', label: 'Coverage', data: { uncheckedLinks: unchecked, note: 'link checks are capped per run' } });
  return res;
}

const UNVERIFIABLE_OUTBOUND = new Set([401, 403, 405, 429, 999]);

export function analyzeBrokenOutbound(prep: Prepared): AnalyzerResult {
  const ext = prep.ctx.externalLinks;
  if (!ext) return NOT('outbound links were not checked');
  return perTemplate(prep, prep.ok, 'TECH-BROKEN-OUTBOUND', 'broken outbound links', (p) => {
    const broken = p.html!.externalLinks
      .map((l) => ext.get(l))
      .filter((a): a is NonNullable<typeof a> => !!a && ((a.status !== null && a.status >= 400 && !UNVERIFIABLE_OUTBOUND.has(a.status)) || (a.status === null && /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|certificate/i.test(a.error ?? ''))));
    return broken.length
      ? [{ label: 'link to dead external pages', evidence: [{ kind: 'html_snippet', label: `${broken.length} dead outbound link(s)`, url: p.url, content: broken.map((b) => `${b.url} → ${b.status ?? b.error}`).join('\n'), data: { broken } }] }]
      : [];
  });
}

// ------------------------------------------------------------------------------------------------ TECH-DISCONTINUED

export function analyzeDiscontinued(prep: Prepared): AnalyzerResult {
  const dead = new Map<string, { status: number | null; s: ReturnType<Prepared['statusOf']> }>();
  for (const p of prep.requested) if (p.template === 'product' && !p.chain.length && (p.status === 404 || p.status === 410)) dead.set(p.url, { status: p.status, s: prep.statusOf(p.url) });
  for (const l of prep.ctx.linkTargets.values()) {
    if (templateOf(l.url) !== 'product' || hostOf(l.url) !== prep.ctx.host) continue;
    if (!l.chain.length && (l.status === 404 || l.status === 410)) dead.set(stripQuery(l.url), { status: l.status, s: prep.statusOf(l.url) });
  }
  if (!dead.size) return { evaluated: true, templates: ['product'], findings: [] };
  const evidence: Ev[] = [];
  const urls: string[] = [];
  // Product handle → collection pages linking to it, built once (not one scan of every collection per dead product).
  const wanted = new Set<string>();
  for (const url of dead.keys()) { const h = productHandle(url); if (h) wanted.add(h); }
  const collectionsByHandle = new Map<string, string[]>();
  for (const p of prep.ok) {
    if (p.template !== 'collection') continue;
    const here = new Set<string>();
    for (const l of p.html!.internalLinks) {
      if (!l.includes('/products/')) continue;
      const h = productHandle(l);
      if (h && wanted.has(h)) here.add(h);
    }
    for (const h of here) { const list = collectionsByHandle.get(h); if (list) list.push(stripQuery(p.url)); else collectionsByHandle.set(h, [stripQuery(p.url)]); }
  }
  for (const [url, d] of dead) {
    urls.push(url);
    const handle = productHandle(url);
    const linkingCollections = (handle && collectionsByHandle.get(handle)) || [];
    const fromPath = collectionHandle(url) ? `${prep.ctx.origin}/collections/${collectionHandle(url)}` : undefined;
    const suggested = fromPath ?? linkingCollections[0] ?? `${prep.ctx.origin}/collections/all`;
    evidence.push({
      kind: 'http_response', label: `HTTP ${d.status} — suggest 301 → ${suggested}`, url,
      content: `${url} → ${d.status}\nSuggested redirect target (parent collection): ${suggested}`,
      data: { status: d.status, suggestedRedirect: suggested, basis: fromPath ? 'collection in URL path' : linkingCollections.length ? 'collection page linking to the product' : 'no linking collection found — fallback /collections/all', linkingCollections: linkingCollections.slice(0, 50), linkingCollectionCount: linkingCollections.length, internalInlinks: inlinksOf(prep, url).slice(0, 50), internalInlinkCount: inlinksOf(prep, url).length },
    });
  }
  return {
    evaluated: true, templates: ['product'],
    findings: [{
      checkId: 'TECH-DISCONTINUED', template: 'product', key: 'TECH-DISCONTINUED::product',
      title: `${urls.length} discontinued ${noun('product', urls.length)} return ${[...new Set([...dead.values()].map((d) => d.status))].join('/')} instead of a 301 to the parent collection`,
      summary: `Deleted/draft products leave live 404s. Suggested 301 targets are in the evidence (from the linking collection page).`,
      urls, evidence,
    }],
  };
}

// ------------------------------------------------------------------------------------------------ TECH-CANONICAL

export function analyzeCanonical(prep: Prepared): AnalyzerResult {
  const pages = prep.ok.filter((p) => p.template !== 'search' && !isIntentionalNoindex(p.url, prep.ctx));
  return perTemplate(prep, pages, 'TECH-CANONICAL', 'canonical defects', (p) => {
    const h = p.html!;
    const out: { label: string; evidence?: Ev[] }[] = [];
    const tags = h.canonicals.map((c) => `<link rel="canonical" href="${escapeHtml(c)}">`).join('\n');
    if (!h.canonicals.length) {
      out.push({ label: 'missing a canonical tag', evidence: [htmlEv(p.url, '<head> has no rel=canonical', '(no <link rel="canonical"> found)')] });
      return out;
    }
    if (new Set(h.canonicals.map(normalizeUrl)).size > 1) out.push({ label: 'declaring multiple conflicting canonicals', evidence: [htmlEv(p.url, 'canonical tags', tags)] });
    else if (h.canonicals.length > 1) out.push({ label: 'declaring the canonical more than once', evidence: [htmlEv(p.url, 'canonical tags', tags)] });
    const c = h.canonicals[0];
    if (!isSameSite(c, prep.ctx.host)) out.push({ label: 'canonicalizing to another host', evidence: [htmlEv(p.url, 'canonical', tags)] });
    else if (!sameUrl(c, p.url)) {
      const s = prep.statusOf(c);
      if (s && s.status !== null) {
        if (s.chain.length) out.push({ label: 'canonicalizing to a redirecting URL', evidence: [htmlEv(p.url, 'canonical', tags), httpEv(c, s)] });
        else if (s.status >= 400) out.push({ label: `canonicalizing to a ${s.status >= 500 ? '5xx' : '4xx'} URL`, evidence: [htmlEv(p.url, 'canonical', tags), httpEv(c, s)] });
        else if (s.noindex) out.push({ label: 'canonicalizing to a noindexed URL', evidence: [htmlEv(p.url, 'canonical', tags)] });
      }
    }
    if (h.og.url && !sameUrl(h.og.url, c) && isSameSite(h.og.url, prep.ctx.host)) {
      out.push({ label: 'with og:url ≠ canonical', evidence: [htmlEv(p.url, 'canonical vs og:url', `${tags}\n<meta property="og:url" content="${escapeHtml(h.og.url)}">`)] });
    }
    return out;
  });
}

// ------------------------------------------------------------------------------------------------ TECH-SHOPIFY-DUP-PATHS

export function analyzeShopifyDupPaths(prep: Prepared): AnalyzerResult {
  const scoped = prep.all.filter((p) => p.scopedSample && !p.skippedByRobots);
  if (!scoped.length) return { evaluated: true, templates: ['product'], findings: [] };
  const problems = new Map<string, Problem>();
  const add = (label: string, url: string, ev: Ev) => {
    const p = problems.get(label) ?? { label, urls: [], evidence: [] };
    problems.set(label, p);
    p.urls.push(url);
    p.evidence!.push(ev);
  };
  for (const p of scoped) {
    const target = p.chain.length ? prep.all.find((x) => x.derivedFrom === p.url) : p;
    if (p.chain.length && target && /^\/products\//.test(pathOf(target.url))) continue; // redirected to /products/handle: fine
    if (!target?.html) continue;
    const handle = productHandle(p.url)!;
    const want = `${prep.ctx.origin}/products/${handle}`;
    const c = canonicalOf(target);
    const tag = c ? `<link rel="canonical" href="${escapeHtml(c)}">` : '(no canonical)';
    if (!c) add('collection-scoped product URLs without a canonical', p.url, htmlEv(p.url, `expected canonical ${want}`, tag));
    else if (!sameUrl(stripQuery(c), want)) add('collection-scoped product URLs not canonicalized to /products/{handle}', p.url, htmlEv(p.url, `expected canonical ${want}`, tag));
  }
  const f = aggregate({
    checkId: 'TECH-SHOPIFY-DUP-PATHS', template: 'product', noun: 'duplicate-path canonicals', problems: [...problems.values()], examined: scoped.length,
    title: problems.size ? `${[...problems.values()].reduce((n, p) => n + p.urls.length, 0)} /collections/{c}/products/{p} URLs are not canonicalized to /products/{p}` : undefined,
  });
  return { evaluated: true, templates: ['product'], findings: f ? [f] : [] };
}

// ------------------------------------------------------------------------------------------------ TECH-DUPLICATE

const normTitle = (s: string, brand: string) =>
  s.toLowerCase().replace(new RegExp(`\\s*[|–—:-]\\s*${brand.toLowerCase()}.*$`), '').replace(/\s+/g, ' ').trim();

export function duplicateGroups(pages: ParsedPage[], get: (p: ParsedPage) => string | undefined): string[][] {
  const m = new Map<string, string[]>();
  for (const p of pages) {
    const v = get(p);
    if (!v) continue;
    { const list = m.get(v); if (list) list.push(p.url); else m.set(v, [p.url]); }
  }
  return [...m.values()].filter((g) => g.length > 1);
}

export function analyzeDuplicate(prep: Prepared): AnalyzerResult {
  const brand = prep.ctx.config.site.brand;
  const findings: Finding[] = [];
  const pagesAll = prep.content.filter((p) => !isNoindex(p).noindex);
  for (const [t, pages] of groupByTemplate(pagesAll)) {
    const problems: Problem[] = [];
    const mk = (label: string, groups: string[][], show: (u: string) => string) => {
      if (!groups.length) return;
      problems.push({
        label, urls: groups.flat(),
        evidence: groups.slice(0, 6).map((g) => ({ kind: 'text_passage' as const, label: `${g.length} pages share: "${trunc(show(g[0]), 120)}"`, content: show(g[0]), data: { urls: g } })),
      });
    };
    const byUrl = new Map(pages.map((p) => [p.url, p]));
    mk('sharing a duplicate title', duplicateGroups(pages, (p) => (p.html!.title ? normTitle(p.html!.title, brand) : undefined)), (u) => byUrl.get(u)!.html!.title ?? '');
    mk('sharing a duplicate meta description', duplicateGroups(pages, (p) => p.html!.metaDescription?.toLowerCase() || undefined), (u) => byUrl.get(u)!.html!.metaDescription ?? '');
    mk('sharing a duplicate H1', duplicateGroups(pages, (p) => p.html!.h1s[0]?.toLowerCase() || undefined), (u) => byUrl.get(u)!.html!.h1s[0] ?? '');
    const docs = pages.filter((p) => prep.uniqueWords(p) >= 40).map((p) => ({ id: p.url, text: prep.uniqueText(p) }));
    const clusters = nearIdenticalClusters(docs, 0.9);
    if (clusters.length) {
      problems.push({
        label: 'with near-duplicate body copy (≥90% shingle overlap)', urls: clusters.flat(),
        evidence: clusters.slice(0, 5).map((c) => textEv(c[0], `${c.length} near-identical pages`, trunc(prep.uniqueText(byUrl.get(c[0])!), 400), { urls: c })),
      });
    }
    const f = aggregate({ checkId: 'TECH-DUPLICATE', template: t, noun: 'duplicate content', problems, examined: pages.length });
    if (f) findings.push(f);
  }
  return { evaluated: true, templates: [...new Set(pagesAll.map((p) => p.template))], findings };
}

// ------------------------------------------------------------------------------------------------ TECH-THIN

export const UTILITY_PAGE = /^\/(pages\/(contact|contact-us|track|track-order|order-tracking|login|wishlist|compare|cart|store-locator|faq|shipping[\w-]*|returns?[\w-]*|refund[\w-]*|privacy[\w-]*|terms[\w-]*|cancellation[\w-]*)|policies\/)/i;

export function analyzeThin(prep: Prepared): AnalyzerResult {
  const min = prep.ctx.thresholds.thinContentWords ?? 150;
  const pages = prep.content.filter((p) => !isNoindex(p).noindex && !UTILITY_PAGE.test(pathOf(p.url)) && p.template !== 'blog_index');
  return perTemplate(prep, pages, 'TECH-THIN', 'thin content', (p) => {
    const w = prep.uniqueWords(p);
    if (w >= min) return [];
    const first = prep.uniqueText(p).split('\n')[0] ?? '';
    return [{
      label: `have fewer than ${min} words of unique content`,
      evidence: [{ kind: 'metric', label: `${w} unique words (threshold ${min})`, url: p.url, content: first ? trunc(first, 300) : '(no unique copy beyond template chrome / product grid)', data: { uniqueWords: w, totalMainWords: p.html!.wordCount, threshold: min, templateBoilerplateRemoved: prep.boilerplateKnown(p.template) } }],
    }];
  }, (_t, list) => ({ severityContext: { metric: minOf(list.map((p) => prep.uniqueWords(p))) } }));
}

// ------------------------------------------------------------------------------------------------ TECH-HOST

export function analyzeHost(prep: Prepared): AnalyzerResult {
  const v = prep.ctx.hostVariants;
  if (!v) return NOT(prep.ctx.isLocal ? 'host variants are not checked for local/staging base URLs' : 'host variants were not fetched');
  const canonical = `${prep.ctx.origin}/`;
  const problems: Problem[] = [];
  const add = (label: string, url: string, ev: Ev) => {
    let p = problems.find((x) => x.label === label);
    if (!p) problems.push((p = { label, urls: [], evidence: [] }));
    p.urls.push(url);
    p.evidence!.push(ev);
  };
  for (const x of v) {
    if (x.isCanonical) {
      if (x.status !== 200) add('canonical homepage does not resolve 200 directly', x.url, httpEv(x.url, x));
      continue;
    }
    if (x.status === null) continue; // e.g. www host without DNS — not a split
    if (x.status === 200) add('host/protocol variants resolve 200 (canonical host split)', x.url, httpEv(x.url, x));
    else if (x.chain.length) {
      if (x.chain[0].status !== 301 && x.chain[0].status !== 308) add('host/protocol variants redirect with a temporary status', x.url, httpEv(x.url, x));
      if (!sameUrl(x.finalUrl, canonical)) add('host/protocol variants do not end on the canonical homepage', x.url, httpEv(x.url, x));
    }
  }
  const ts = prep.ctx.trailingSlash;
  if (ts?.problem) add('trailing-slash variants resolve 200 without canonicalizing', ts.variant, { kind: 'http_response', label: ts.problem, url: ts.variant, content: `${ts.variant} → ${ts.status}; canonical: ${ts.canonical ?? '(none)'}` });
  const f = aggregate({ checkId: 'TECH-HOST', noun: 'host canonicalization problems', problems, title: problems.length ? `Canonical host split: ${problems.map((p) => p.label).join('; ')}` : undefined });
  return { evaluated: true, findings: f ? [f] : [] };
}

// ------------------------------------------------------------------------------------------------ TECH-HTTPS

export function analyzeHttps(prep: Prepared): AnalyzerResult {
  const base = new URL(prep.ctx.baseUrl);
  if (prep.ctx.isLocal) return NOT('HTTPS / certificate checks are skipped for local/staging base URLs');
  const problems: Problem[] = [];
  const home = prep.ok.find((p) => p.template === 'home');
  const homeUrl = `${prep.ctx.origin}/`;
  if (base.protocol !== 'https:') {
    problems.push({ label: 'site base URL is served over plain HTTP', urls: [homeUrl], evidence: [{ kind: 'note', label: 'Base URL', url: homeUrl, content: prep.ctx.baseUrl }] });
  } else {
    const tls = prep.ctx.tls;
    const minDays = prep.ctx.thresholds.certExpiryDays ?? 21;
    if (tls?.error) problems.push({ label: 'TLS handshake failed', urls: [homeUrl], evidence: [{ kind: 'note', label: 'TLS error', url: homeUrl, content: tls.error }] });
    else if (tls) {
      if (tls.daysLeft !== undefined && tls.daysLeft < minDays) problems.push({ label: `certificate expires in ${tls.daysLeft} days (<${minDays})`, urls: [homeUrl], evidence: [metricEv('certificate expiry', { validTo: tls.validTo, daysLeft: tls.daysLeft, threshold: minDays }, homeUrl)] });
      if (tls.authorized === false) problems.push({ label: 'certificate is not trusted', urls: [homeUrl], evidence: [{ kind: 'note', label: 'TLS authorization error', url: homeUrl, content: tls.authorizationError }] });
    }
    if (home && !home.headers['strict-transport-security']) problems.push({ label: 'missing Strict-Transport-Security (HSTS) header', urls: [homeUrl], evidence: [{ kind: 'http_response', label: 'response headers', url: homeUrl, content: Object.entries(home.headers).map(([k, x]) => `${k}: ${x}`).join('\n').slice(0, 1500) }] });
    const mixed = prep.ok.filter((p) => p.html!.mixedContent.length);
    if (mixed.length) problems.push({ label: 'pages load http:// subresources (mixed content)', urls: mixed.map((p) => p.url), evidence: mixed.slice(0, 8).map((p) => htmlEv(p.url, `${p.html!.mixedContent.length} insecure subresource(s)`, p.html!.mixedContent.slice(0, 10).join('\n'))) });
  }
  const f = aggregate({ checkId: 'TECH-HTTPS', noun: 'HTTPS problems', problems, title: problems.length ? `HTTPS: ${problems.map((p) => p.label).join('; ')}` : undefined });
  return { evaluated: true, templates: [], findings: f ? [f] : [] };
}

// ------------------------------------------------------------------------------------------------ TECH-PAGINATION

export function analyzePagination(prep: Prepared): AnalyzerResult {
  const pag = prep.all.filter((p) => p.paginated && !p.skippedByRobots);
  if (!pag.length) return { evaluated: true, templates: [], findings: [] };
  return perTemplate(prep, pag, 'TECH-PAGINATION', 'pagination defects', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    if (p.status !== 200 || p.chain.length) return [{ label: `?page=N URLs that do not return 200 (${p.status})`, evidence: [httpEv(p.url, p)] }];
    const c = canonicalOf(p);
    const tag = c ? `<link rel="canonical" href="${escapeHtml(c)}">` : '(no canonical)';
    if (c && pageParam(c) === undefined && sameUrl(stripQuery(c), stripQuery(p.url))) out.push({ label: 'paginated URLs canonicalized to page 1', evidence: [htmlEv(p.url, 'canonical', tag)] });
    else if (c && !sameUrl(c, p.url)) out.push({ label: 'paginated URLs canonicalized elsewhere (should be self-canonical)', evidence: [htmlEv(p.url, 'canonical', tag)] });
    if (isNoindex(p).noindex) out.push({ label: 'paginated URLs noindexed (products deeper in the list lose discovery)', evidence: [htmlEv(p.url, 'meta robots', p.html!.metaRobots ?? 'noindex')] });
    return out;
  });
}
