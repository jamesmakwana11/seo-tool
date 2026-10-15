#!/usr/bin/env node
/**
 * Lighthouse / rendering runner — one audit per process, started by the API (src/lighthouse/service.ts), so a browser
 * crash or a memory spike never takes the API down.
 *
 * stdin : {"url":"https://…","mode":"lighthouse"|"render","formFactor":"mobile"|"desktop","chromePath":"…","timeoutMs":120000,"chromeFlags":[…]}
 * stdout: one JSON line — {"ok":true, …summary} or {"ok":false,"error":"…","missing":"lighthouse|chrome"}
 *
 * Needs the optional `lighthouse` package (npm) and a Chrome / Chromium binary. Nothing else is contacted than the page
 * (and the resources the page itself loads, as in any browser).
 */
import fs from 'node:fs';

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const read = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return JSON.parse(s);
};

async function main() {
  const job = await read();
  let lighthouse;
  let launcher;
  try {
    lighthouse = await import('lighthouse');
    launcher = await import('chrome-launcher');
  } catch (e) {
    return out({ ok: false, missing: 'lighthouse', error: `The lighthouse package is not installed (${e.message}). Run npm install in apps/api.` });
  }
  if (!job.chromePath || !fs.existsSync(job.chromePath)) {
    return out({ ok: false, missing: 'chrome', error: `No Chrome / Chromium binary found${job.chromePath ? ` at ${job.chromePath}` : ''}. Set LIGHTHOUSE_CHROME_PATH.` });
  }
  const flags = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--mute-audio', ...(job.chromeFlags ?? [])];
  const t0 = Date.now();
  const chrome = await launcher.launch({ chromePath: job.chromePath, chromeFlags: flags, logLevel: 'silent' });
  const timer = setTimeout(() => {
    out({ ok: false, error: `timed out after ${Math.round(job.timeoutMs / 1000)} s` });
    try { chrome.kill(); } catch { /* gone */ }
    process.exit(3);
  }, job.timeoutMs ?? 120000);
  try {
    if (job.mode === 'render') {
      const puppeteer = await import('puppeteer-core');
      const browser = await puppeteer.default.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
      const page = await browser.newPage();
      await page.setUserAgent(job.userAgent ?? 'DeoDapSEOSentinel/1.0 (+rendered check)');
      const res = await page.goto(job.url, { waitUntil: 'networkidle2', timeout: Math.max(10000, (job.timeoutMs ?? 120000) - 10000) });
      const dom = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const host = location.host.replace(/^www\./, '');
        const links = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith('http'));
        const internal = links.filter((h) => { try { return new URL(h).host.replace(/^www\./, '') === host; } catch { return false; } });
        const text = (document.querySelector('main') ?? document.body)?.innerText ?? '';
        return {
          title: document.title || undefined,
          metaDescription: q('meta[name="description"]')?.getAttribute('content') ?? undefined,
          canonical: q('link[rel="canonical"]')?.href ?? undefined,
          metaRobots: q('meta[name="robots"]')?.getAttribute('content') ?? undefined,
          h1s: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()),
          internalLinks: new Set(internal).size,
          wordCount: (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length,
          jsonLdBlocks: document.querySelectorAll('script[type="application/ld+json"]').length,
          finalUrl: location.href,
        };
      });
      await browser.disconnect();
      out({ ok: true, mode: 'render', status: res?.status() ?? null, ms: Date.now() - t0, rendered: dom });
    } else {
      const config = job.formFactor === 'desktop' ? lighthouse.desktopConfig : undefined;
      const r = await lighthouse.default(job.url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] }, config);
      const lhr = r.lhr;
      const cat = (k) => (lhr.categories[k]?.score === null || lhr.categories[k]?.score === undefined ? null : Math.round(lhr.categories[k].score * 100));
      const metric = (id) => { const a = lhr.audits[id]; return a ? { value: a.numericValue ?? null, display: a.displayValue ?? null, score: a.score } : undefined; };
      const opportunities = Object.values(lhr.audits)
        .filter((a) => a.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) > 0)
        .sort((a, b) => (b.details.overallSavingsMs ?? 0) - (a.details.overallSavingsMs ?? 0))
        .slice(0, 8)
        .map((a) => ({ id: a.id, title: a.title, savingsMs: Math.round(a.details.overallSavingsMs ?? 0), savingsBytes: a.details.overallSavingsBytes ?? undefined, display: a.displayValue ?? undefined }));
      const failing = (k) => (lhr.categories[k]?.auditRefs ?? [])
        .map((ref) => lhr.audits[ref.id])
        .filter((a) => a && a.score !== null && a.score < 1 && a.scoreDisplayMode !== 'manual' && a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'informative')
        .slice(0, 15)
        .map((a) => ({ id: a.id, title: a.title, score: a.score, display: a.displayValue ?? undefined }));
      out({
        ok: true, mode: 'lighthouse', ms: Date.now() - t0, lighthouseVersion: lhr.lighthouseVersion, fetchTime: lhr.fetchTime, finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
        formFactor: lhr.configSettings.formFactor, userAgent: lhr.environment?.networkUserAgent, runtimeError: lhr.runtimeError?.message, runWarnings: lhr.runWarnings ?? [],
        scores: { performance: cat('performance'), accessibility: cat('accessibility'), bestPractices: cat('best-practices'), seo: cat('seo') },
        metrics: {
          fcp: metric('first-contentful-paint'), lcp: metric('largest-contentful-paint'), tbt: metric('total-blocking-time'), cls: metric('cumulative-layout-shift'),
          si: metric('speed-index'), tti: metric('interactive'),
        },
        opportunities, seoFailures: failing('seo'), accessibilityFailures: failing('accessibility'),
      });
    }
  } finally {
    clearTimeout(timer);
    try { await chrome.kill(); } catch { /* gone */ }
  }
}

main().catch((e) => {
  out({ ok: false, error: e?.message ?? String(e) });
  process.exit(1);
});
