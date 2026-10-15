/**
 * Reading the crawler's result files line by line (gzip NDJSON), without holding a file in memory.
 * A file cut short by a crash (truncated gzip stream) yields every complete line before the damage, then stops and
 * reports it instead of throwing.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';

export interface ReadStats {
  lines: number;
  badLines: number;
  /** The file ended unexpectedly (crash while writing); lines before that point were read. */
  truncated?: string;
  missing?: boolean;
}

export async function* readNdjsonGz<T>(file: string, stats: ReadStats = { lines: 0, badLines: 0 }): AsyncGenerator<T> {
  if (!fs.existsSync(file)) {
    stats.missing = true;
    return;
  }
  const gunzip = zlib.createGunzip();
  const src = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  let streamError: Error | undefined;
  gunzip.on('error', (e) => { streamError = e; });
  src.on('error', (e) => { streamError = e; gunzip.destroy(e); });
  const rl = readline.createInterface({ input: src.pipe(gunzip), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let v: T;
      try {
        v = JSON.parse(line) as T;
      } catch {
        stats.badLines++;
        continue;
      }
      stats.lines++;
      yield v;
    }
  } catch (e) {
    streamError ??= e as Error;
  } finally {
    rl.close();
    src.destroy();
  }
  if (streamError) stats.truncated = streamError.message;
}

/** Gzip NDJSON writer with back-pressure (used for the page-text file of custom rules). */
export function gzWriter(file: string) {
  const gz = zlib.createGzip({ level: 3 });
  const out = fs.createWriteStream(file);
  gz.pipe(out);
  return {
    async write(v: unknown) {
      if (!gz.write(`${JSON.stringify(v)}\n`)) await new Promise<void>((r) => gz.once('drain', () => r()));
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        out.once('finish', () => resolve());
        out.once('error', reject);
        gz.end();
      });
    },
  };
}
