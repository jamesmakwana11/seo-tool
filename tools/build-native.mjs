#!/usr/bin/env node
/**
 * Builds the native crawler binaries into bin/ (Windows, macOS and Linux):
 *   bin/sentinel-crawler[.exe]   Go 1.22+   (services/crawler-go)
 *   bin/sentinel-textcore[.exe]  Rust 1.75+ (services/textcore-rs)
 *
 *   node tools/build-native.mjs          build both (npm run build:native)
 *   node tools/build-native.mjs --test   run the Go and Rust test suites (npm run test:native)
 *
 * The API finds the binaries in bin/ automatically (or via CRAWLER_GO_BIN / TEXTCORE_BIN).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const exe = (n) => (win ? `${n}.exe` : n);
const goDir = join(root, 'services', 'crawler-go');
const rsDir = join(root, 'services', 'textcore-rs');
const bin = join(root, 'bin');
const test = process.argv.includes('--test');

function run(cmd, args, cwd, extraEnv = {}) {
  console.log(`\n> ${cmd} ${args.join(' ')}   (${cwd.replace(root, '.')})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false, env: { ...process.env, ...extraEnv } });
  if (r.error) {
    const hint = cmd === 'go' ? 'Install Go 1.22 or newer: https://go.dev/dl/' : 'Install Rust (rustup): https://rustup.rs/';
    console.error(`\n${cmd} could not be started (${r.error.code ?? r.error.message}). ${hint}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
}

if (test) {
  run('go', ['vet', './...'], goDir);
  run('go', ['test', './...'], goDir);
  run('cargo', ['test', '--release'], rsDir);
  console.log('\nGo and Rust tests passed.');
  process.exit(0);
}

mkdirSync(bin, { recursive: true });
// Static Go binary (no libc dependency), symbols stripped.
run('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', join(bin, exe('sentinel-crawler')), '.'], goDir, { CGO_ENABLED: '0' });
run('cargo', ['build', '--release', '--locked'], rsDir);
const rsOut = join(rsDir, 'target', 'release', exe('sentinel-textcore'));
copyFileSync(rsOut, join(bin, exe('sentinel-textcore')));
if (!win) {
  chmodSync(join(bin, exe('sentinel-crawler')), 0o755);
  chmodSync(join(bin, exe('sentinel-textcore')), 0o755);
}
for (const n of ['sentinel-crawler', 'sentinel-textcore']) {
  const r = spawnSync(join(bin, exe(n)), ['--version'], { encoding: 'utf8' });
  console.log(`${exe(n)}: ${(r.stdout || r.stderr || '').trim()}`);
}
console.log(`\nBuilt into ${bin}`);
