/**
 * Read-only Shopify theme source snapshots (through the authorised Admin API connection) and their differences.
 *
 * A snapshot is a manifest (filename → MD5 of the content) plus content-addressed gzip blobs, so unchanged files are
 * stored once across snapshots. Nothing here writes to Shopify; the viewer cannot edit or publish theme code.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ThemeDiffFile, ThemeDiffResponse, ThemeSnapshotMeta, TextDiffView } from '@sentinel/shared';
import { diffLines } from '../lib/diff';

export const THEME_SNAPSHOT_KEEP = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 1500;

interface Manifest { meta: ThemeSnapshotMeta; files: Record<string, string>; skipped: string[] }

const md5 = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

export function createThemeSnapshotStore(dir: () => Promise<string>) {
  const paths = async () => {
    const d = await dir();
    return { snaps: path.join(d, 'snapshots'), blobs: path.join(d, 'blobs') };
  };
  async function load(id: string): Promise<Manifest> {
    if (!/^THS-[\w-]+$/.test(id)) throw new Error(`Not a theme snapshot id: ${id}`);
    const p = await paths();
    return JSON.parse(await fsp.readFile(path.join(p.snaps, `${id}.json`), 'utf8')) as Manifest;
  }
  async function blob(hash: string): Promise<string> {
    const p = await paths();
    return zlib.gunzipSync(await fsp.readFile(path.join(p.blobs, `${hash}.gz`))).toString('utf8');
  }

  return {
    limits: { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES },
    /** Saves a snapshot from file names + a reader of their contents. */
    async save(meta: Omit<ThemeSnapshotMeta, 'id' | 'files' | 'skipped' | 'bytes'>, names: { filename: string; size: number }[], read: (filenames: string[]) => Promise<Map<string, string>>, keep = THEME_SNAPSHOT_KEEP): Promise<ThemeSnapshotMeta> {
      const p = await paths();
      await fsp.mkdir(p.snaps, { recursive: true });
      await fsp.mkdir(p.blobs, { recursive: true });
      const skipped: string[] = [];
      const wanted: string[] = [];
      for (const n of names) {
        if (n.size > MAX_FILE_BYTES) skipped.push(`${n.filename} (${Math.round(n.size / 1024)} KB, over the ${MAX_FILE_BYTES / 1024} KB limit)`);
        else if (wanted.length >= MAX_FILES) skipped.push(`${n.filename} (more than ${MAX_FILES} files)`);
        else wanted.push(n.filename);
      }
      const bodies = await read(wanted);
      const files: Record<string, string> = {};
      let bytes = 0;
      for (const f of wanted) {
        const body = bodies.get(f);
        if (body === undefined) { skipped.push(`${f} (no text content — binary file)`); continue; }
        const h = md5(body);
        files[f] = h;
        bytes += Buffer.byteLength(body);
        const bp = path.join(p.blobs, `${h}.gz`);
        try { await fsp.access(bp); } catch { await fsp.writeFile(bp, zlib.gzipSync(body, { level: 6 })); }
      }
      const id = `THS-${meta.at.replace(/[-:.]/g, '').slice(0, 15)}-${crypto.randomBytes(3).toString('hex')}`;
      const full: ThemeSnapshotMeta = { ...meta, id, files: Object.keys(files).length, skipped: skipped.length, bytes };
      await fsp.writeFile(path.join(p.snaps, `${id}.json`), JSON.stringify({ meta: full, files, skipped } satisfies Manifest));
      await this.prune(keep);
      return full;
    },
    async list(): Promise<ThemeSnapshotMeta[]> {
      const p = await paths();
      const out: ThemeSnapshotMeta[] = [];
      for (const n of await fsp.readdir(p.snaps).catch(() => [] as string[])) {
        if (!n.endsWith('.json')) continue;
        try { out.push((JSON.parse(await fsp.readFile(path.join(p.snaps, n), 'utf8')) as Manifest).meta); } catch { /* damaged: skipped */ }
      }
      return out.sort((a, b) => b.at.localeCompare(a.at));
    },
    async skipped(id: string): Promise<string[]> { return (await load(id)).skipped; },
    /** Keeps the newest `keep` snapshots and the blobs they use. */
    async prune(keep: number) {
      const p = await paths();
      const all = await this.list();
      for (const m of all.slice(keep)) await fsp.rm(path.join(p.snaps, `${m.id}.json`), { force: true });
      const used = new Set<string>();
      for (const m of all.slice(0, keep)) for (const h of Object.values((await load(m.id)).files)) used.add(h);
      for (const n of await fsp.readdir(p.blobs).catch(() => [] as string[])) if (!used.has(n.replace(/\.gz$/, ''))) await fsp.rm(path.join(p.blobs, n), { force: true });
    },
    /** Files added / removed / changed between two snapshots; with `file`, that file's line diff. */
    async diff(fromId: string, toId: string, file?: string): Promise<ThemeDiffResponse> {
      const [a, b] = await Promise.all([load(fromId), load(toId)]);
      const names = [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].sort();
      const files: ThemeDiffFile[] = [];
      for (const f of names) {
        const ha = a.files[f], hb = b.files[f];
        const state: ThemeDiffFile['state'] = !ha ? 'added' : !hb ? 'removed' : ha === hb ? 'same' : 'changed';
        const entry: ThemeDiffFile = { filename: f, state };
        if (file === f && state !== 'same') entry.diff = diffLines(ha ? await blob(ha) : '', hb ? await blob(hb) : '', { maxLines: 4000 }) as TextDiffView;
        files.push(entry);
      }
      const order = { changed: 0, added: 1, removed: 2, same: 3 };
      files.sort((x, y) => order[x.state] - order[y.state] || x.filename.localeCompare(y.filename));
      const same = a.meta.themeId === b.meta.themeId;
      return {
        from: a.meta, to: b.meta, files,
        note: `Theme source read from Shopify through the authorised connection (read-only). ${same ? `Both snapshots are of “${b.meta.themeName}”, taken ${a.meta.at.slice(0, 16).replace('T', ' ')} and ${b.meta.at.slice(0, 16).replace('T', ' ')} UTC.` : `Comparing theme “${a.meta.themeName}” (${a.meta.themeRole}) with “${b.meta.themeName}” (${b.meta.themeRole}).`} This viewer cannot edit or publish theme code.`,
      };
    },
  };
}
