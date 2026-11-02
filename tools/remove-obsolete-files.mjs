#!/usr/bin/env node
/**
 * Removes source files that later versions of Sentinel deleted, before a production build.
 *
 * Why: when a new release is copied over an existing checkout (unzipped on top of it), files the release no longer
 * has stay behind. TypeScript compiles every file under src/, so a leftover such as
 * apps/api/src/repositories/seedDemo.ts (renamed to seedFixtures.ts when demo mode was removed) breaks the build with
 * errors about types that no longer exist ("demo" is not assignable to type DataSource).
 *
 * Only the exact paths listed here are touched, and only when they exist; each removal is printed. Delete them from the
 * repository too (git rm) so the next checkout is clean.
 */
import { existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files removed or renamed in later releases (path relative to the repository root → why). */
export const OBSOLETE = {
  'apps/api/src/repositories/seedDemo.ts': 'renamed to seedFixtures.ts (demo mode removed, Oct 2026)',
  'apps/web/src/api/mock/mockApi.ts': 'in-browser demo adapter removed; the web tests use apps/web/test/support/fixtureApi.ts',
  'apps/web/test/mockApi.test.ts': 'tested the removed in-browser demo adapter',
  'apps/web/e2e/smoke.mjs': 'smoke test of the removed in-browser demo build (apps/web/e2e/prod-smoke.mjs remains)',
  'apps/web/scripts/package-review.mjs': 'packaged the removed hosted demo build',
};
/** Folders removed when they are left empty. */
const MAYBE_EMPTY = ['apps/web/src/api/mock', 'apps/web/scripts'];

let removed = 0;
for (const [rel, why] of Object.entries(OBSOLETE)) {
  const p = join(root, rel);
  if (!existsSync(p)) continue;
  rmSync(p, { force: true });
  removed++;
  console.log(`removed obsolete ${rel} — ${why}`);
}
for (const rel of MAYBE_EMPTY) {
  const p = join(root, rel);
  try { if (existsSync(p) && readdirSync(p).length === 0) rmdirSync(p); } catch { /* not empty or not removable: leave it */ }
}
if (removed) console.log(`${removed} obsolete file(s) removed. Delete them from the repository too (git rm …) so the next checkout is clean.`);
