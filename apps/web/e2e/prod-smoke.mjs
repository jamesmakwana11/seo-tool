/**
 * Production smoke test — runs against a deployed server (real sign-in, no DEV role preview, no DEMO seed).
 *
 *   BASE_URL=https://your-host ADMIN_EMAIL=… ADMIN_PASSWORD=… node e2e/prod-smoke.mjs [--write]
 *
 * Read-only by default: signs in, visits every routed screen at 1440 and 390 px, and records page errors, console errors
 * (including Content-Security-Policy violations), 5xx responses and missing page headings. It also checks API-level
 * guarantees: health endpoints, unknown website id refused, Task Management routes absent, unauthenticated API refused.
 * With --write it also adds a throw-away website and checks it starts empty and isolated (data is in memory on the server).
 * Exit code 1 on any failure.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const WRITE = process.argv.includes('--write');
if (!EMAIL || !PASSWORD) { console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD.'); process.exit(2); }

const routesSrc = readFileSync(resolve(here, '../src/routes.tsx'), 'utf8');
const PATHS = JSON.parse(routesSrc.slice(routesSrc.indexOf('[', routesSrc.indexOf('SMOKE_PATHS')), routesSrc.indexOf('];', routesSrc.indexOf('SMOKE_PATHS')) + 1).replace(/'/g, '"').replace(/,\s*]/, ']'));
const IGNORED = [/React Router Future Flag/, /Download the React DevTools/, /Failed to load resource.*(401|403|404)/];

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };

// ---------------------------------------------------------------- API-level
const j = async (path, init = {}) => {
  const r = await fetch(BASE + path, init);
  let body; try { body = await r.json(); } catch { body = undefined; }
  return { status: r.status, body, headers: r.headers };
};
const live = await j('/healthz');
check('GET /healthz', live.status === 200 && live.body?.ok === true);
const health = await j('/api/health');
check('GET /api/health reports storage honestly', health.status === 200 && health.body?.storage?.kind, health.body?.storage);
check('HTTPS hardening headers present', !BASE.startsWith('https') || (live.headers.get('strict-transport-security') ?? '').includes('max-age'));
check('unauthenticated API is refused', (await j('/api/issues')).status === 401);
const login = await j('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
check('admin sign-in via API', login.status === 200 && login.body?.token);
const auth = { Authorization: `Bearer ${login.body?.token}` };
check('DEV role preview disabled', (await j('/api/auth/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"role":"admin"}' })).status === 403);
check('Task Management API absent', (await j('/api/tasks', { headers: auth })).status === 404);
check('unknown website id refused', (await j('/api/issues', { headers: { ...auth, 'X-Website-Id': 'no-such-site' } })).body?.error?.code === 'WEBSITE_NOT_FOUND');

// ---------------------------------------------------------------- UI
const browser = await chromium.launch();
const visits = [];
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORED.some((re) => re.test(m.text()))) problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/login`);
  check(`no DEV preview buttons on the sign-in page (${width}px)`, (await page.getByText('Development role preview').count()) === 0);
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  for (const path of [...PATHS, '/tasks', '/no-such-page']) {
    problems.length = 0;
    await page.goto(BASE + path);
    await page.waitForFunction(() => !document.querySelector('[role="status"][aria-label="Loading"], .animate-pulse, .skeleton'), null, { timeout: 10000 }).catch(() => {});
    const expectMissing = path === '/tasks' || path === '/no-such-page';
    const h1 = expectMissing
      ? await page.getByText("This page doesn't exist").textContent({ timeout: 5000 }).catch(() => null)
      : await page.locator('main h1').first().textContent({ timeout: 5000 }).catch(() => null);
    const p = [...problems];
    if (!h1) p.push(expectMissing ? 'not-found page not shown' : 'no page heading');
    visits.push({ width, path, h1: h1?.trim(), problems: p });
  }
  await page.close();
}
const notFound = visits.find((v) => v.path === '/tasks' && v.width === 1440);
check('Task Management screens removed (/tasks is Not found)', notFound && /doesn't exist/i.test(notFound.h1 ?? ''), notFound?.h1);
check('every screen renders without errors', visits.every((v) => v.problems.length === 0), visits.filter((v) => v.problems.length).slice(0, 10));

// ---------------------------------------------------------------- optional write check
if (WRITE) {
  const domain = `prod-smoke-${Date.now()}.example.com`;
  const created = await j('/api/websites', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Prod smoke', url: `https://${domain}`, platform: 'shopify' }) });
  check('add a website', created.status === 201, created.body?.error);
  if (created.status === 201) {
    const id = created.body.id;
    const issues = await j('/api/issues', { headers: { ...auth, 'X-Website-Id': id } });
    const total = issues.body?.total ?? issues.body?.items?.length;
    check('new website starts empty and isolated', issues.status === 200 && total === 0, { status: issues.status, total });
    const crawl = await j('/api/crawls', { method: 'POST', headers: { ...auth, 'X-Website-Id': id, 'Content-Type': 'application/json' }, body: '{"type":"smart"}' });
    check('crawl of an unreachable site is not reported as a success', crawl.status >= 400 || crawl.body?.status !== 'completed', { status: crawl.status, body: crawl.body?.error ?? crawl.body?.status });
  }
}
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), screensVisited: visits.length, checks }, null, 2));
process.exit(failed.length ? 1 : 0);
