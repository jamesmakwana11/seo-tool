/**
 * Performance analyzers that need only crawl data (PDF §4.4): PERF-RENDER-BLOCKING, PERF-IMAGES, PERF-THIRD-PARTY.
 * Field data (PERF-CRUX) and lab runs (PERF-PSI) come from the PSI/CrUX connector, not from here.
 */
import type { PageTemplate } from '@sentinel/shared';
import type { Finding } from '../services/ports';
import type { ParsedPage } from '../crawler/types';
import { hostOf, isSameSite, pathOf } from '../crawler/url';
import { groupByTemplate, htmlEv, metricEv, noun, perTemplate, type AnalyzerResult, type Ev, type Prepared } from './context';

/** Known Shopify app / third-party script hosts → app name (for "names the app"). */
const KNOWN_APPS: [RegExp, string][] = [
  [/judge\.me/i, 'Judge.me Reviews'], [/loox\.io/i, 'Loox Reviews'], [/yotpo/i, 'Yotpo'], [/stamped\.io/i, 'Stamped.io'], [/okendo/i, 'Okendo'],
  [/klaviyo/i, 'Klaviyo'], [/privy/i, 'Privy'], [/omnisend/i, 'Omnisend'], [/hotjar/i, 'Hotjar'], [/clarity\.ms/i, 'Microsoft Clarity'],
  [/googletagmanager|google-analytics|gtag/i, 'Google Tag Manager / GA'], [/connect\.facebook|fbevents/i, 'Meta Pixel'], [/tiktok/i, 'TikTok Pixel'],
  [/tidio/i, 'Tidio Chat'], [/gorgias/i, 'Gorgias'], [/zendesk|zdassets/i, 'Zendesk'], [/intercom/i, 'Intercom'], [/wati|interakt|gupshup/i, 'WhatsApp chat widget'],
  [/boostcommerce|bc-sf-filter/i, 'Boost Product Filter'], [/searchanise/i, 'Searchanise'], [/pagefly/i, 'PageFly'], [/gempages/i, 'GemPages'], [/shogun/i, 'Shogun'],
  [/vitals\.co|vitals\.app/i, 'Vitals'], [/rechargeapps|rechargecdn/i, 'ReCharge'], [/smile\.io/i, 'Smile.io'], [/recaptcha|gstatic\.com\/recaptcha/i, 'reCAPTCHA'],
  [/shopifycloud|cdn\.shopify\.com\/shopifycloud/i, 'Shopify platform'], [/cdn\.shopify\.com\/extensions/i, 'Shopify app extension'],
];

/** Script URLs repeat on every page of a crawl: the app name is worked out once per distinct URL. */
const APP_NAME_CACHE = new Map<string, string>();

export function appNameFor(src: string): string {
  const hit = APP_NAME_CACHE.get(src);
  if (hit !== undefined) return hit;
  const name = appNameUncached(src);
  if (APP_NAME_CACHE.size >= 50000) APP_NAME_CACHE.clear();
  APP_NAME_CACHE.set(src, name);
  return name;
}

function appNameUncached(src: string): string {
  for (const [re, name] of KNOWN_APPS) if (re.test(src)) return name;
  const m = pathOf(src).match(/\/extensions\/[^/]+\/([^/]+)\//);
  if (m) return `Shopify app extension (${m[1]})`;
  const proxy = pathOf(src).match(/^\/apps\/([^/]+)\//);
  if (proxy) return `Shopify app proxy (${proxy[1]})`;
  return hostOf(src) || src;
}

export function isBlockingScript(s: { async: boolean; defer: boolean; module: boolean; type?: string }): boolean {
  if (s.async || s.defer || s.module) return false;
  if (s.type && !/^(text|application)\/(javascript|ecmascript)$/i.test(s.type)) return false;
  return true;
}

export function analyzeRenderBlocking(prep: Prepared): AnalyzerResult {
  const prev = prep.ctx.previous?.headScriptsByTemplate;
  const findings: Finding[] = [];
  const templates: PageTemplate[] = [];
  for (const [t, list] of prep.byTemplate) {
    const known = prev?.[t];
    if (!known) continue; // no baseline for this template ⇒ "new" cannot be decided (snapshot builds it for next run)
    templates.push(t);
    const knownSet = new Set(known.map((s) => s.replace(/\?.*$/, '')));
    const newScripts = new Map<string, { src: string; urls: string[] }>();
    for (const p of list) {
      for (const s of p.html!.headScripts.filter(isBlockingScript)) {
        const key = s.src.replace(/\?.*$/, '');
        if (knownSet.has(key)) continue;
        const e = newScripts.get(key) ?? { src: s.src, urls: [] };
        e.urls.push(p.url);
        newScripts.set(key, e);
      }
    }
    for (const [key, e] of newScripts) {
      const app = appNameFor(e.src);
      const size = prep.ctx.scripts?.get(e.src)?.bytes;
      findings.push({
        checkId: 'PERF-RENDER-BLOCKING', template: t, key: `PERF-RENDER-BLOCKING::${t}::${key}`,
        title: `New render-blocking script from ${app} on ${e.urls.length} ${noun(t, e.urls.length)}`,
        summary: `A synchronous <script src> (no async/defer) appeared in <head> since the last run: ${e.src}. On Shopify this is almost always a newly installed app. LCP impact needs PSI/CrUX data (not measured by the crawler).`,
        urls: e.urls,
        severityContext: {},
        evidence: [
          htmlEv(e.urls[0], `<head> script (blocking) — ${app}`, `<script src="${e.src}"></script>`),
          { kind: 'diff', label: 'Head scripts vs previous run', content: `+ ${e.src}`, data: { app, scriptHost: hostOf(e.src), src: e.src, bytes: size, previousCount: known.length } },
        ],
      });
    }
  }
  if (!prev) return { evaluated: false, findings: [], reason: 'no previous head-script baseline (first run) — baseline recorded in snapshot' };
  return { evaluated: templates.length > 0, templates, findings };
}

const LEGACY_EXT = /\.(jpe?g|png|gif|bmp|tiff?)(\?|$)/i;

function imageFormat(src: string, contentType?: string): string {
  if (contentType && /image\//.test(contentType)) return contentType.replace('image/', '').split(';')[0];
  const m = pathOf(src).match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : 'unknown';
}

export function analyzeImages(prep: Prepared): AnalyzerResult {
  const imgs = prep.ctx.images;
  if (!imgs) return { evaluated: false, findings: [], reason: 'image weights were not measured' };
  const maxKb = prep.ctx.thresholds.imageMaxKb ?? 200;
  return perTemplate(prep, prep.content, 'PERF-IMAGES', 'image performance problems', (p) => {
    const out: { label: string; evidence?: Ev[] }[] = [];
    const main = p.html!.images.filter((i) => i.inMain);
    const heavy: string[] = [];
    const legacy: string[] = [];
    for (const i of main) {
      const a = imgs.get(i.src);
      if (!a) continue;
      if (a.bytes !== undefined && a.bytes / 1024 > maxKb) heavy.push(`${i.src} — ${Math.round(a.bytes / 1024)} KB`);
      const fmt = imageFormat(i.src, a.contentType);
      if (/^(jpe?g|png|gif|bmp|tiff?)$/.test(fmt) || (fmt === 'unknown' && LEGACY_EXT.test(i.src))) legacy.push(`${i.src} (${fmt})`);
    }
    if (heavy.length) out.push({ label: `serve images heavier than ${maxKb} KB`, evidence: [metricEv(`${heavy.length} image(s) > ${maxKb} KB`, { images: heavy, thresholdKb: maxKb }, p.url)] });
    if (legacy.length) out.push({ label: 'serve images in legacy formats (not WebP/AVIF)', evidence: [metricEv(`${legacy.length} legacy-format image(s)`, { images: legacy }, p.url)] });
    const noDims = main.filter((i) => !i.width || !i.height);
    if (noDims.length) out.push({ label: 'have images without width/height (CLS risk)', evidence: [htmlEv(p.url, `${noDims.length} <img> without dimensions`, noDims.slice(0, 5).map((i) => `<img src="${i.src}"${i.width ? ` width="${i.width}"` : ''}${i.height ? ` height="${i.height}"` : ''}>`).join('\n'))] });
    const belowFold = main.slice(2).filter((i) => i.loading !== 'lazy');
    if (belowFold.length) out.push({ label: 'have below-the-fold images without loading="lazy"', evidence: [htmlEv(p.url, `${belowFold.length} below-fold <img> not lazy`, belowFold.slice(0, 5).map((i) => `<img src="${i.src}">`).join('\n'))] });
    return out;
  });
}

export function analyzeThirdParty(prep: Prepared): AnalyzerResult {
  const sc = prep.ctx.scripts;
  if (!sc) return { evaluated: false, findings: [], reason: 'third-party scripts were not measured' };
  const prev = prep.ctx.previous?.thirdPartyKbByTemplate;
  const growthMax = prep.ctx.thresholds.thirdPartyWeeklyGrowthPct ?? 15;
  const findings: Finding[] = [];
  for (const [t, list] of groupByTemplate(prep.ok)) {
    const stats = list.map((p) => {
      const third = p.html!.scriptSrcs.filter((s) => !isSameSite(s, prep.ctx.host));
      const kb = third.reduce((n, s) => n + (sc.get(s)?.bytes ?? 0), 0) / 1024;
      return { p, third, kb };
    });
    const avgKb = Math.round(stats.reduce((n, s) => n + s.kb, 0) / Math.max(1, stats.length));
    const avgCount = Math.round((stats.reduce((n, s) => n + s.third.length, 0) / Math.max(1, stats.length)) * 10) / 10;
    const hosts = new Map<string, number>();
    for (const s of stats) for (const src of s.third) hosts.set(appNameFor(src), (hosts.get(appNameFor(src)) ?? 0) + (sc.get(src)?.bytes ?? 0));
    const before = prev?.[t];
    if (before === undefined || before <= 0) continue;
    const growth = Math.round(((avgKb - before) / before) * 100);
    if (growth <= growthMax) continue;
    findings.push({
      checkId: 'PERF-THIRD-PARTY', template: t, key: `PERF-THIRD-PARTY::${t}`,
      title: `Third-party JS on ${noun(t, 2)} grew ${growth}% (${before} → ${avgKb} KB per page)`,
      summary: `Average third-party JavaScript per ${noun(t, 1)} is ${avgKb} KB across ${avgCount} scripts (was ${before} KB). Threshold: +${growthMax}%/week.`,
      urls: stats.map((s) => s.p.url),
      severityContext: { metric: avgKb },
      evidence: [metricEv('third-party payload by app', { avgKb, previousKb: before, growthPct: growth, avgScripts: avgCount, byApp: Object.fromEntries([...hosts].map(([k, b]) => [k, Math.round(b / 1024)])) })],
    });
  }
  if (!prev) return { evaluated: false, findings: [], reason: 'no previous third-party baseline — trend needs a prior run (baseline recorded in snapshot)' };
  return { evaluated: true, templates: [...prep.byTemplate.keys()].filter((t) => prev[t] !== undefined), findings };
}

/** Average third-party KB per template (for the next run's baseline). */
export function thirdPartyKbByTemplate(prep: Prepared): Partial<Record<PageTemplate, number>> | undefined {
  const sc = prep.ctx.scripts;
  if (!sc) return undefined;
  const out: Partial<Record<PageTemplate, number>> = {};
  for (const [t, list] of prep.byTemplate) {
    const kbs = list.map((p: ParsedPage) => p.html!.scriptSrcs.filter((s) => !isSameSite(s, prep.ctx.host)).reduce((n, s) => n + (sc.get(s)?.bytes ?? 0), 0) / 1024);
    out[t] = Math.round(kbs.reduce((a, b) => a + b, 0) / Math.max(1, kbs.length));
  }
  return out;
}
