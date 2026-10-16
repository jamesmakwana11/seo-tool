#!/usr/bin/env node
/**
 * Page capture runner — screenshots, rendered HTML, the CSS / JS the page loaded, and pixel diffs, in one Chromium per
 * job. Started by the API (src/changes/capture.ts) as a separate process, so a browser crash or memory spike never takes
 * the API down.
 *
 * stdin : {"chromePath","userAgent","timeoutMs","outDir","assetDir","concurrency","maxHeight","allowLoopback","siteHost",
 *          "assetHosts":[…],"assetLimits":{"count","bytes","total"},"captures":[{"key","url","viewport","previousPng"?}]}
 * stdout: one JSON line per capture ({"key",…}), then {"done":true}. Errors: {"fatal":"…","missing":"playwright|chrome"}.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const read = async () => {
  let s = '';
  for await (const c of process.stdin) s += c;
  return JSON.parse(s);
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

/** Literal private / loopback / link-local addresses (the page itself may not reach them). */
function privateHost(host, allowLoopback) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)) return !allowLoopback;
  if (/^(10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h === 'metadata.google.internal') return true;
  return false;
}

async function pixelDiff(browser, aPng, bPng, outPng) {
  const page = await browser.newPage();
  try {
    const a = fs.readFileSync(aPng).toString('base64');
    const b = fs.readFileSync(bPng).toString('base64');
    const r = await page.evaluate(async ([a64, b64]) => {
      const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image')); i.src = `data:image/png;base64,${s}`; });
      const [A, B] = await Promise.all([load(a64), load(b64)]);
      const w = Math.max(A.width, B.width), h = Math.max(A.height, B.height);
      const ctx = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0); return x; };
      const da = ctx(A).getImageData(0, 0, w, h).data;
      const xb = ctx(B);
      const db = xb.getImageData(0, 0, w, h);
      const o = db.data;
      let changed = 0;
      for (let p = 0; p < o.length; p += 4) {
        const d = Math.abs(da[p] - o[p]) + Math.abs(da[p + 1] - o[p + 1]) + Math.abs(da[p + 2] - o[p + 2]);
        if (d > 48) { changed++; o[p] = 230; o[p + 1] = 20; o[p + 2] = 60; o[p + 3] = 255; }
        else { const g = 0.299 * o[p] + 0.587 * o[p + 1] + 0.114 * o[p + 2]; const f = 225 + g * 0.12; o[p] = f; o[p + 1] = f; o[p + 2] = f; }
      }
      xb.putImageData(db, 0, 0);
      return { url: xb.canvas.toDataURL('image/png'), changed, total: w * h, sizeChanged: A.width !== B.width || A.height !== B.height, before: [A.width, A.height], after: [B.width, B.height] };
    }, [a, b]);
    fs.writeFileSync(outPng, Buffer.from(r.url.split(',')[1], 'base64'));
    return { png: outPng, changedPixels: r.changed, ratio: r.total ? r.changed / r.total : 0, sizeChanged: r.sizeChanged, before: r.before, after: r.after };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function captureOne(browser, job, c) {
  const t0 = Date.now();
  const vp = VIEWPORTS[c.viewport] ?? VIEWPORTS.desktop;
  const context = await browser.newContext({ ...vp, userAgent: job.userAgent, ignoreHTTPSErrors: false, javaScriptEnabled: true, serviceWorkers: 'block' });
  const assets = [];
  let assetBytes = 0;
  const pending = [];
  try {
    await context.route('**/*', (route) => {
      try {
        const u = new URL(route.request().url());
        if ((u.protocol === 'http:' || u.protocol === 'https:') && privateHost(u.hostname, job.allowLoopback)) return route.abort('blockedbyclient');
      } catch { /* data: etc. */ }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('response', (resp) => {
      const type = resp.request().resourceType();
      if (type !== 'stylesheet' && type !== 'script') return;
      let host;
      try { host = new URL(resp.url()).hostname; } catch { return; }
      if (!(host === job.siteHost || (job.assetHosts ?? []).some((h) => host === h || host.endsWith(`.${h}`)))) return;
      if (resp.status() !== 200 || assets.length >= job.assetLimits.count) return;
      pending.push(resp.body().then((buf) => {
        if (buf.length > job.assetLimits.bytes || assetBytes + buf.length > job.assetLimits.total || assets.length >= job.assetLimits.count) return;
        assetBytes += buf.length;
        const hash = crypto.createHash('sha1').update(buf).digest('hex');
        const file = path.join(job.assetDir, `${hash}.gz`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, zlib.gzipSync(buf, { level: 6 }));
        assets.push({ url: resp.url(), type: type === 'stylesheet' ? 'css' : 'js', hash, bytes: buf.length });
      }).catch(() => undefined));
    });
    let status = null;
    let navError;
    try {
      const resp = await page.goto(c.url, { waitUntil: 'load', timeout: job.timeoutMs });
      status = resp?.status() ?? null;
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => undefined);
    } catch (e) {
      navError = e.message.split('\n')[0];
    }
    const finalUrl = page.url();
    if (navError && (!finalUrl || finalUrl === 'about:blank')) return { key: c.key, ok: false, error: navError, ms: Date.now() - t0 };
    // Lazy-loaded content: scroll through the page once (bounded), then back to the top.
    await page.evaluate(async (max) => {
      const step = window.innerHeight;
      for (let y = 0; y < Math.min(document.documentElement.scrollHeight, max); y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
    }, job.maxHeight).catch(() => undefined);
    await page.waitForTimeout(300);
    const docHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)).catch(() => vp.viewport.height);
    const height = Math.max(1, Math.min(docHeight, job.maxHeight));
    const png = path.join(job.outDir, `${c.key}.png`);
    await page.screenshot({ path: png, fullPage: true, clip: { x: 0, y: 0, width: vp.viewport.width, height }, animations: 'disabled', timeout: job.timeoutMs });
    const html = await page.content();
    const htmlFile = path.join(job.outDir, `${c.key}.html.gz`);
    fs.writeFileSync(htmlFile, zlib.gzipSync(html, { level: 6 }));
    const fields = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: document.title || undefined,
        meta: q('meta[name="description"]')?.getAttribute('content') ?? undefined,
        h1: [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).slice(0, 10),
        canonical: q('link[rel="canonical"]')?.href ?? undefined,
        robots: q('meta[name="robots"]')?.getAttribute('content') ?? undefined,
      };
    }).catch(() => ({}));
    await Promise.all(pending);
    const result = {
      key: c.key, ok: true, status, finalUrl, ms: Date.now() - t0, png, html: htmlFile, width: vp.viewport.width, height, docHeight, cut: docHeight > height,
      htmlBytes: Buffer.byteLength(html), fields, assets, navWarning: navError,
    };
    if (c.previousPng && fs.existsSync(c.previousPng)) {
      try { result.diff = await pixelDiff(browser, c.previousPng, png, path.join(job.outDir, `${c.key}.diff.png`)); } catch (e) { result.diffError = e.message; }
    }
    return result;
  } catch (e) {
    return { key: c.key, ok: false, error: e.message.split('\n')[0], ms: Date.now() - t0 };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function main() {
  const job = await read();
  let pw;
  try {
    pw = await import('playwright-core');
  } catch (e) {
    out({ fatal: `The playwright-core package is not installed (${e.message}). Run npm install in apps/api.`, missing: 'playwright' });
    return;
  }
  if (!job.chromePath || !fs.existsSync(job.chromePath)) {
    out({ fatal: `No Chrome / Chromium binary found${job.chromePath ? ` at ${job.chromePath}` : ''}.`, missing: 'chrome' });
    return;
  }
  fs.mkdirSync(job.outDir, { recursive: true });
  fs.mkdirSync(job.assetDir, { recursive: true });
  const browser = await pw.chromium.launch({
    executablePath: job.chromePath, headless: true,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--mute-audio', '--disable-extensions', '--js-flags=--max-old-space-size=256', ...(job.chromeFlags ?? [])],
  });
  try {
    const queue = [...job.captures];
    const workers = Array.from({ length: Math.max(1, Math.min(2, job.concurrency ?? 1)) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) out(await captureOne(browser, job, c));
    });
    await Promise.all(workers);
  } finally {
    await browser.close().catch(() => undefined);
  }
  out({ done: true });
}

main().catch((e) => {
  out({ fatal: e?.message ?? String(e) });
  process.exit(1);
});
