/**
 * Image references of a crawl: for every page that answered 200 with HTML, the <img> elements read from the HTML
 * already fetched (address, ALT, width / height attributes, loading, main content or not). Written once while the crawl
 * is analysed (gzip NDJSON, one line per page, never the whole crawl in memory) and read only when a user starts an
 * Image Audit. Making this file costs no network request.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParsedPage } from '../crawler/types';
import { gzWriter, readNdjsonGz, type ReadStats } from '../gocrawl/files';

/** One <img> of a page: s = src, a = alt (null = no alt attribute), w / h = width / height attributes, l = loading, m = in main content, x = position on the page, c = where on the page (landmark › section › component). */
export interface ImageRef { s: string; a: string | null; w?: string; h?: string; l?: string; m: boolean; x: number; c?: string }
/** One page: p = page URL, t = template, i = its images. */
export interface ImageRefPage { p: string; t?: string; i: ImageRef[] }

export const IMAGE_REFS_FILE = 'images.ndjson.gz';
/** Images recorded per page (a page with more is noted as truncated in the audit). */
export const MAX_IMAGES_PER_PAGE = 300;

/** The page's image references, or undefined for pages without HTML / not answering 200. */
export function imageRefsOf(p: ParsedPage, ok: boolean): ImageRefPage | undefined {
  if (!ok || !p.html) return undefined;
  const imgs = p.html.images;
  if (!imgs.length) return { p: p.url, t: p.template, i: [] };
  return {
    p: p.url, t: p.template,
    i: imgs.slice(0, MAX_IMAGES_PER_PAGE).map((im, k) => {
      const r: ImageRef = { s: im.src, a: im.alt === null ? null : im.alt.slice(0, 300), m: im.inMain, x: im.index ?? k };
      if (im.width) r.w = im.width;
      if (im.height) r.h = im.height;
      if (im.loading) r.l = im.loading;
      if (im.location) r.c = im.location.slice(0, 200);
      return r;
    }),
  };
}

export type ImageRefsWriter = ReturnType<typeof gzWriter>;
export const imageRefsWriter = (file: string): ImageRefsWriter => gzWriter(file);

export async function* readImageRefs(file: string, stats?: ReadStats): AsyncGenerator<ImageRefPage> {
  yield* readNdjsonGz<ImageRefPage>(file, stats);
}

/** Built-in (Node) crawler: its pages are in memory; the references go to a temporary file like the Go crawler's. */
export async function writeImageRefsFile(pages: ParsedPage[], isOk: (p: ParsedPage) => boolean, tag: string): Promise<string> {
  const dir = path.join(os.tmpdir(), 'sentinel-image-refs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${tag.replace(/[^\w.-]/g, '_')}-${Date.now().toString(36)}.ndjson.gz`);
  const w = imageRefsWriter(file);
  for (const p of pages) {
    const r = imageRefsOf(p, isOk(p));
    if (r) await w.write(r);
  }
  await w.close();
  return file;
}
