/**
 * Accessibility scan (axe-core, WCAG 2.0/2.1 A + AA) over the main screens as SEO Specialist at 1440px.
 * Usage: BASE_URL=http://localhost:4173 node e2e/a11y.mjs   → e2e/results/a11y-results.json, exit 1 on violations.
 */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const PATHS = ['/login', '/', '/health', '/issues', '/issues/ISS-0001', '/tasks/board', '/tasks/list', '/tasks/TSK-0003', '/modules/technical', '/modules/performance',
  '/modules/ai-compliance', '/crawls', '/opportunities', '/opportunities/briefs/BRF-001', '/reports/daily', '/ai-compliance/rules', '/settings/thresholds', '/team/employees', '/notifications'];
mkdirSync(resolve(here, 'results'), { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const report = [];
for (const path of PATHS) {
  if (path !== '/login' && !report.some((r) => r.loggedIn)) {
    await page.goto(`${BASE}/login`);
    await page.getByRole('button', { name: 'SEO Specialist', exact: true }).click();
    await page.waitForURL(`${BASE}/`);
    report.push({ loggedIn: true });
  }
  await page.goto(`${BASE}${path}`);
  await page.waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  report.push({ path, violations: res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })) });
}
await browser.close();
const pages = report.filter((r) => r.path);
const total = pages.reduce((s, r) => s + r.violations.reduce((a, v) => a + v.nodes, 0), 0);
writeFileSync(resolve(here, 'results/a11y-results.json'), JSON.stringify({ ranAt: new Date().toISOString(), pages: pages.length, totalViolationNodes: total, report: pages }, null, 2));
for (const r of pages) for (const v of r.violations) console.log(`${r.path}  ${v.impact}  ${v.id} ×${v.nodes}  ${v.sample[0]}`);
console.log(`${pages.length} pages scanned, ${total} violating nodes`);
process.exit(total ? 1 : 0);
