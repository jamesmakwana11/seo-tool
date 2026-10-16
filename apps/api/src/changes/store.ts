/**
 * Change Monitor storage on disk (no database). One folder per website:
 *
 *   <CHANGE_SNAPSHOT_DIR>/<host>/index.json                 runs, baseline pointer, format version
 *   <host>/baseline-<snapshotId>.ndjson.gz                 the baseline (one BaseRec per URL)
 *   <host>/runs/<snapshotId>.snap.ndjson.gz                each crawl's snapshot
 *   <host>/runs/<snapshotId>.notable.ndjson.gz             its new / removed / failed / changed URLs
 *   <host>/runs/<snapshotId>.quiet.ndjson.gz               its unchanged / unchecked URLs
 *
 * Every file is written under a temporary name and renamed into place, and index.json last, so a crash mid-write leaves
 * the previous state intact. Retention removes old runs' files; the baseline is never removed by retention.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChangeRunSummary } from '@sentinel/shared';

export const STORE_VERSION = 1;

export interface BaselineMeta {
  snapshotId: string;
  runId: string;
  observedAt: string;
  crawlType: string;
  urls: number;
  /** Snapshot ids of smart crawls merged into this baseline since it was created. */
  mergedFrom: string[];
  file: string;
}

export interface SiteIndex {
  version: number;
  site: string;
  baseline: BaselineMeta | null;
  /** Newest first. */
  runs: ChangeRunSummary[];
}

export const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').slice(0, 120) || 'site';

export function createChangeStore(root: string, site: string) {
  const dir = path.join(root, safeName(site));
  const runsDir = path.join(dir, 'runs');
  const indexFile = path.join(dir, 'index.json');
  let chain: Promise<unknown> = Promise.resolve();

  const files = (id: string) => ({
    snap: path.join(runsDir, `${id}.snap.ndjson.gz`),
    notable: path.join(runsDir, `${id}.notable.ndjson.gz`),
    quiet: path.join(runsDir, `${id}.quiet.ndjson.gz`),
    pending: path.join(runsDir, `${id}.pending.ndjson.gz`),
  });

  async function readIndex(): Promise<SiteIndex> {
    try {
      const raw = JSON.parse(await fsp.readFile(indexFile, 'utf8')) as SiteIndex;
      // Another format version: start a new history (files of the other format are removed by the next prune).
      if (raw.version !== STORE_VERSION) return { version: STORE_VERSION, site, baseline: null, runs: [] };
      if (raw.baseline && !fs.existsSync(path.join(dir, raw.baseline.file))) raw.baseline = null;
      return raw;
    } catch {
      return { version: STORE_VERSION, site, baseline: null, runs: [] };
    }
  }

  async function writeIndex(ix: SiteIndex) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${indexFile}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(ix, null, 1));
    await fsp.rename(tmp, indexFile);
  }

  return {
    dir,
    runsDir,
    files,
    baselinePath: (b: BaselineMeta) => path.join(dir, b.file),
    readIndex,
    writeIndex,
    async ensure() { await fsp.mkdir(runsDir, { recursive: true }); },
    /** Runs `fn` after every earlier store operation of this website (one writer at a time). */
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      const p = chain.then(fn, fn);
      chain = p.catch(() => undefined);
      return p;
    },
    /** Drops runs beyond `keep` or older than `maxAgeDays` (and their files). Returns the snapshot ids removed. */
    async prune(ix: SiteIndex, keep: number, maxAgeDays: number, now: Date): Promise<string[]> {
      const cutoff = now.getTime() - maxAgeDays * 86400_000;
      const kept: ChangeRunSummary[] = [];
      const removed: string[] = [];
      for (const r of ix.runs) {
        if (kept.length < keep && new Date(r.observedAt).getTime() >= cutoff) kept.push(r);
        else removed.push(r.snapshotId);
      }
      ix.runs = kept;
      for (const id of removed) {
        const f = files(id);
        for (const p of [f.snap, f.notable, f.quiet, f.pending]) await fsp.rm(p, { force: true }).catch(() => undefined);
      }
      // Stray files (a crash between writing a file and the index): anything not referenced is deleted.
      const live = new Set(ix.runs.map((r) => r.snapshotId));
      for (const name of await fsp.readdir(runsDir).catch(() => [] as string[])) {
        const id = name.split('.')[0];
        if (!live.has(id)) await fsp.rm(path.join(runsDir, name), { force: true }).catch(() => undefined);
      }
      for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (/^baseline-.*\.ndjson\.gz/.test(name) && name !== ix.baseline?.file) await fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
      }
      return removed;
    },
    async diskBytes(): Promise<number> {
      let n = 0;
      const walk = async (d: string) => {
        for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p);
          else n += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
        }
      };
      await walk(dir);
      return n;
    },
  };
}

export type ChangeStore = ReturnType<typeof createChangeStore>;
