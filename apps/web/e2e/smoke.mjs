/**
 * Phase 1 route smoke test (Playwright + Chromium).
 *
 * For each role (DEV role preview) × viewport (1440 / 768 / 390) it visits every route and records:
 *  - uncaught page errors and console errors
 *  - horizontal overflow of the document (responsive check)
 *  - presence of a page heading (h1) or the access-denied message (role guard)
 *  - presence of a DEMO / SIMULATED indicator (sample data labelling)
 * plus a few interaction checks (allocation, keyboard focus).
 *
 * Usage: start the app (`npm run build && npm run preview` → :4173, or `npm run dev` → :5173), then
 *   BASE_URL=http://localhost:4173 node e2e/smoke.mjs [--shots]
 * Writes e2e/results/smoke-results.json (+ screenshots with --shots). Exit code 1 on any failure.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const SHOTS = process.argv.includes('--shots');
const out = resolve(here, 'results');
mkdirSync(out, { recursive: true });

// Route list is the single source in src/routes.tsx (SMOKE_PATHS).
const routesSrc = readFileSync(resolve(here, '../src/routes.tsx'), 'utf8');
const SMOKE_PATHS = JSON.parse(routesSrc.slice(routesSrc.indexOf('[', routesSrc.indexOf('SMOKE_PATHS')), routesSrc.indexOf('];', routesSrc.indexOf('SMOKE_PATHS')) + 1).replace(/'/g, '"').replace(/,\s*]/, ']'));
// Crawl ids: the DEMO seed holds 30 daily smart crawls + one full crawl per Sunday in the window, i.e. 34 or 35 runs depending on
// the date — CRL-0034 exists on every date (CRL-0035 only when the window contains 5 Sundays).
const DYNAMIC = ['/issues/ISS-0001', '/issues/ISS-0066', '/crawls/CRL-0034', '/opportunities/briefs/BRF-001', '/no-such-page'];

const ROLES = [
  { label: 'Admin', key: 'admin' },
  { label: 'SEO Specialist', key: 'seo' },
  { label: 'Developer', key: 'developer' },
];
const WIDTHS = [1440, 768, 390];
const IGNORED_CONSOLE = [
  /React Router Future Flag/, /Download the React DevTools/,
  // http mode: a correct server-side permission denial (403) or auth prompt (401) surfaces as a resource
  // console error even though the UI renders the denied/empty state gracefully. These are expected.
  /Failed to load resource.*(401|403)/,
];

const results = [];
let failures = 0;
const browser = await chromium.launch();

for (const role of ROLES) {
  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) errors.push(`console: ${m.text()}`); });
    await page.goto(`${BASE}/login`);
    await page.getByRole('button', { name: role.label, exact: true }).click();
    await page.waitForURL(`${BASE}/`);
    for (const path of [...SMOKE_PATHS, ...DYNAMIC]) {
      errors.length = 0;
      await page.goto(`${BASE}${path}`);
      // wait for lazy chunk + mock latency + skeletons to settle
      await page.waitForFunction(() => !document.querySelector('[role="status"][aria-label="Loading"], .animate-pulse, .skeleton'), null, { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({
        h1: document.querySelector('main h1')?.textContent?.trim() ?? null,
        denied: !!Array.from(document.querySelectorAll('main p')).find((p) => /don't have access|belongs to another team/.test(p.textContent ?? '')),
        notFound: !!Array.from(document.querySelectorAll('main p')).find((p) => /doesn't exist/.test(p.textContent ?? '')),
        overflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        mainOverflowPx: (() => { const m = document.querySelector('main'); return m ? Math.max(0, m.scrollWidth - m.clientWidth) : 0; })(),
        demoLabel: /DEMO|SIMULATED/.test(document.body.innerText),
        errorState: !!Array.from(document.querySelectorAll('[role="alert"]')).find((a) => /could not load/.test(a.textContent ?? '')),
      }));
      const problems = [];
      if (errors.length) problems.push(...errors);
      if (r.overflowPx > 1 || r.mainOverflowPx > 1) problems.push(`horizontal overflow ${Math.max(r.overflowPx, r.mainOverflowPx)}px`);
      if (!r.h1 && !r.denied && !r.notFound && !page.url().includes('/login')) problems.push('no page heading');
      if (r.errorState && !r.denied) problems.push('section error state rendered');
      if (!r.demoLabel) problems.push('no DEMO indicator');
      const row = { role: role.key, width, path, h1: r.h1, denied: r.denied, problems };
      results.push(row);
      if (problems.length) failures++;
      if (SHOTS && width !== 768) await page.screenshot({ path: `${out}/${role.key}-${width}-${path.replace(/[^a-z0-9]+/gi, '_') || 'root'}.png` });
    }
    await page.close();
  }
}

// ---- interaction checks (SEO specialist, desktop)
const interactions = [];
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: 'SEO Specialist', exact: true }).click();
  await page.waitForURL(`${BASE}/`);
  // 1. The issue page has no allocation section (removed at the owner's request); Acknowledge and Not an issue remain.
  await page.goto(`${BASE}/issues?severity=critical&status=NEW&team=unallocated`);
  await page.locator('main tbody tr').first().waitFor({ timeout: 15000 });
  const target = (await page.locator('main tbody tr').first().innerText()).match(/ISS-\d+/)?.[0];
  await page.goto(`${BASE}/issues/${target}`);
  await page.getByRole('button', { name: 'Not an issue' }).first().waitFor({ timeout: 10000 });
  const noAllocation = (await page.getByText('Allocate this fix').count()) === 0 && (await page.getByRole('button', { name: /^Fix with/ }).count()) === 0;
  const kept = (await page.getByRole('button', { name: 'Acknowledge' }).count()) > 0;
  interactions.push({ name: 'issue page has no allocation section; Acknowledge / Not an issue remain', ok: noAllocation && kept });
  // 2. Keyboard: Tab reaches a visible focused element with an outline
  await page.goto(`${BASE}/issues`);
  await page.locator('main h1').waitFor();
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const s = getComputedStyle(el); return { tag: el.tagName, outline: s.outlineStyle }; });
  interactions.push({ name: 'keyboard focus visible', ok: !!focus && focus.outline !== 'none', detail: focus });
  // 3. Global search finds an issue by id
  await page.getByRole('combobox', { name: 'Global search' }).fill('ISS-0002');
  const hit = await page.getByRole('option').first().waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
  interactions.push({ name: 'global search', ok: hit });
  // 4. Adding a website creates an empty, separate workspace (in-app navigation: a reload resets mock memory)
  await page.getByRole('link', { name: 'Manage websites' }).click();
  await page.getByRole('button', { name: 'Add website' }).first().click();
  await page.fill('#ws-name', 'Smoke Store');
  await page.fill('#ws-url', `smoke-${Date.now()}.example.com`);
  await page.getByRole('dialog').getByRole('button', { name: 'Add website' }).click();
  const empty = await page.getByText('Smoke Store has no audit data yet').waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  await page.getByRole('link', { name: 'Issues board' }).click();
  const noIssues = await page.getByText('No issues match these filters').waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
  interactions.push({ name: 'new website starts empty and isolated', ok: empty && noIssues });
  // 5. Developer is denied an admin-only route
  await page.goto(`${BASE}/login`);
  await page.close();
  const dev = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await dev.goto(`${BASE}/login`);
  await dev.getByRole('button', { name: 'Developer', exact: true }).click();
  await dev.waitForURL(`${BASE}/`);
  await dev.goto(`${BASE}/team/roles`);
  const denied = await dev.getByText(/don't have access/).waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
  const noNav = !(await dev.getByRole('link', { name: 'Roles & permissions' }).count());
  interactions.push({ name: 'developer denied Roles page and nav hidden', ok: denied && noNav });
  await dev.close();
}
await browser.close();

for (const i of interactions) if (!i.ok) failures++;
const summary = {
  base: BASE, ranAt: new Date().toISOString(), visits: results.length, routes: SMOKE_PATHS.length + DYNAMIC.length,
  roles: ROLES.map((r) => r.key), widths: WIDTHS, failingVisits: results.filter((r) => r.problems.length).length,
  denied: results.filter((r) => r.denied).map((r) => `${r.role} ${r.path}`).filter((v, i, a) => a.indexOf(v) === i),
  interactions,
};
writeFileSync(`${out}/smoke-results.json`, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const r of results.filter((x) => x.problems.length)) console.log(`FAIL ${r.role} ${r.width} ${r.path}: ${r.problems.join(' | ')}`);
process.exit(failures ? 1 : 0);
