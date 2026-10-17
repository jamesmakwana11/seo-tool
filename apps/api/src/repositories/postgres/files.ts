/**
 * Mirrors a folder of files a website needs after a restart (Change Monitor baseline and change lists) into the
 * database, and restores it on an empty disk (Render's filesystem is reset on every restart / redeploy).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Persistence } from './persistence';

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Stores the folder's files that `keep` selects under `prefix`: files not yet stored, plus `always` (e.g. an index that
 * changes in place); removes stored files that are gone from the folder (retention).
 */
export async function syncFolderToDb(p: Persistence, scope: string, prefix: string, dir: string, keep: (rel: string) => boolean, always: (rel: string) => boolean) {
  const local = (await walk(dir)).filter(keep);
  const stored = new Set((await p.listFiles(scope, prefix)).map((x) => x.slice(prefix.length)));
  for (const rel of local) {
    if (stored.has(rel) && !always(rel)) continue;
    await p.saveFile(scope, prefix + rel, await fsp.readFile(path.join(dir, rel)));
  }
  const gone = [...stored].filter((rel) => !local.includes(rel));
  await p.deleteFiles(scope, gone.map((rel) => prefix + rel));
}

/** Writes the stored files back when the folder lacks them (after a restart). Returns how many were restored. */
export async function restoreFolderFromDb(p: Persistence, scope: string, prefix: string, dir: string): Promise<number> {
  let n = 0;
  for (const full of await p.listFiles(scope, prefix)) {
    const rel = full.slice(prefix.length);
    const dst = path.join(dir, rel);
    if (!dst.startsWith(path.resolve(dir)) || fs.existsSync(dst)) continue;
    const content = await p.readFile(scope, full);
    if (!content) continue;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.writeFile(`${dst}.tmp`, content);
    await fsp.rename(`${dst}.tmp`, dst);
    n++;
  }
  return n;
}
