/**
 * Packages a hosted-review build for publishing as a private review page.
 *
 *   VITE_API_MODE=mock VITE_ROUTER=memory VITE_HOSTED_REVIEW=true npx vite build --outDir <dir>
 *   node scripts/package-review.mjs <dir>
 *
 * The host wraps the page in its own <!doctype>/<head>/<body> skeleton (charset + viewport included), so the published
 * index.html carries only the head content and the app root. Assets stay as separate same-origin files under assets/.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/package-review.mjs <build dir>');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const script = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
if (!script) throw new Error('module entry script not found in index.html');

const page = `<title>DeoDap SEO Sentinel</title>
<meta name="robots" content="noindex">
<meta name="description" content="Multi-website daily SEO audits and Fix Cards — hosted review build on DEMO data.">
<link rel="icon" href="./favicon.svg" type="image/svg+xml">
${css.map((h) => `<link rel="stylesheet" href="${h}">`).join('\n')}
<style>
  /* The app ships one deliberate light theme; set the ground explicitly so the host theme never shows through. */
  :root { color-scheme: light; --review-canvas: #FAF9FD; --review-ink: #252238; }
  html, body { background: var(--review-canvas); color: var(--review-ink); }
</style>
<div id="root"></div>
<script type="module" src="${script}"></script>
`;
writeFileSync(join(dir, 'index.html'), page);
console.log(JSON.stringify({ script, css }));
