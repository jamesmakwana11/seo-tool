/**
 * Locates the native crawler binaries:
 *  - sentinel-crawler   (Go, services/crawler-go)  — the production website crawler;
 *  - sentinel-textcore  (Rust, services/textcore-rs) — duplicate / near-duplicate text analysis, run by the crawler.
 *
 * Order: CRAWLER_GO_BIN / TEXTCORE_BIN, then `bin/` at the repository root (what `npm run build:native` and the
 * Dockerfile produce), then the toolchains' own build folders (services/…/target/release) for local development.
 * Each binary is probed with `--version` and must speak protocol 1.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSION = 1;

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export interface BinaryInfo {
  path?: string;
  version?: string;
  /** Why the binary cannot be used (missing, not executable, wrong protocol). */
  problem?: string;
}

export interface NativeBinaries {
  crawler: BinaryInfo;
  textCore: BinaryInfo;
}

/** Folders to look in: the working directory and every parent of this module (dist/ or src/), up to the repo root. */
function searchRoots(): string[] {
  const roots = new Set<string>();
  const add = (start: string) => {
    let d = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      roots.add(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  };
  add(process.cwd());
  try {
    add(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    /* not an ES module URL (tests) */
  }
  return [...roots];
}

function candidates(name: string, devBuild: string[]): string[] {
  const out: string[] = [];
  for (const r of searchRoots()) {
    out.push(path.join(r, 'bin', exe(name)));
    out.push(path.join(r, ...devBuild, exe(name)));
  }
  return out;
}

function probe(file: string): BinaryInfo {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { path: file, problem: 'not a file' };
  } catch {
    return { path: file, problem: 'not found' };
  }
  const r = spawnSync(file, ['--version'], { timeout: 5000, encoding: 'utf8', windowsHide: true, env: minimalEnv() });
  if (r.error) return { path: file, problem: `cannot run: ${r.error.message}` };
  const out = `${r.stdout ?? ''}`.trim();
  const m = /protocol (\d+)/.exec(out);
  if (!m) return { path: file, problem: `unexpected --version output: ${out.slice(0, 120) || '(none)'}` };
  if (Number(m[1]) !== PROTOCOL_VERSION) return { path: file, version: out, problem: `speaks protocol ${m[1]}, the API needs protocol ${PROTOCOL_VERSION}` };
  return { path: file, version: out };
}

function find(explicit: string | undefined, name: string, devBuild: string[]): BinaryInfo {
  if (explicit) return probe(path.resolve(explicit));
  let firstProblem: BinaryInfo | undefined;
  for (const c of candidates(name, devBuild)) {
    if (!fs.existsSync(c)) continue;
    const info = probe(c);
    if (!info.problem) return info;
    firstProblem ??= info;
  }
  return firstProblem ?? { problem: `${exe(name)} not found (run "npm run build:native", or set ${name === 'sentinel-crawler' ? 'CRAWLER_GO_BIN' : 'TEXTCORE_BIN'})` };
}

let cache: { key: string; value: NativeBinaries } | undefined;

export function locateBinaries(env: { CRAWLER_GO_BIN?: string; TEXTCORE_BIN?: string }, fresh = false): NativeBinaries {
  const key = `${env.CRAWLER_GO_BIN ?? ''}|${env.TEXTCORE_BIN ?? ''}`;
  if (!fresh && cache?.key === key) return cache.value;
  const value: NativeBinaries = {
    crawler: find(env.CRAWLER_GO_BIN, 'sentinel-crawler', ['services', 'crawler-go']),
    textCore: find(env.TEXTCORE_BIN, 'sentinel-textcore', ['services', 'textcore-rs', 'target', 'release']),
  };
  cache = { key, value };
  return value;
}

/**
 * Environment for the native processes: no API secrets (session secret, Shopify / Google / SMTP credentials …) are
 * passed to them — only what a process needs to run and reach the network (proxy settings).
 */
export function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'LANG', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}
