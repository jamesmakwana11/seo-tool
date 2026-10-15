/**
 * Theme files: list themes, read a file, line diff, and write a file of an UNPUBLISHED theme.
 *
 * Safety rules (enforced here, not only in the UI):
 *  - never writes to the live theme (role MAIN) — the merchant previews the changed copy and publishes it in Shopify;
 *  - never calls themePublish or any other theme mutation than themeFilesUpsert;
 *  - the original file is kept as a backup, and a file changed since the proposal is a conflict (checksum compare).
 */
import crypto from 'node:crypto';
import type { DiffLine, ShopifyTheme, ShopifyThemeFile } from '@sentinel/shared';
import { checkUserErrors, ShopifyApiError, type AdminClient } from './client';

const THEME_GID = /^gid:\/\/shopify\/OnlineStoreTheme\/\d+$/;
/** Theme files the editor may change (text templates only; no assets/binaries, no config/settings_data.json). */
export const EDITABLE_FILE = /^(layout|templates|sections|snippets)\/[A-Za-z0-9_.\-/]+\.(liquid|json)$/;
export const MAX_THEME_FILE_BYTES = 512 * 1024;

export async function listThemes(client: AdminClient): Promise<ShopifyTheme[]> {
  const d = await client.request<{ themes: { nodes: { id: string; name: string; role: string; updatedAt?: string }[] } }>('query SentinelThemes { themes(first: 50) { nodes { id name role updatedAt } } }');
  return (d.themes?.nodes ?? []).map((t) => ({ id: t.id, name: t.name, role: t.role, updatedAt: t.updatedAt, writable: t.role !== 'MAIN' && t.role !== 'LOCKED' && t.role !== 'DEMO' }));
}

export async function getTheme(client: AdminClient, themeId: string): Promise<ShopifyTheme> {
  if (!THEME_GID.test(themeId)) throw new ShopifyApiError('Not a theme ID.', { code: 'BAD_ID' });
  const t = (await listThemes(client)).find((x) => x.id === themeId);
  if (!t) throw new ShopifyApiError('Theme not found.', { code: 'NOT_FOUND' });
  return t;
}

export async function readThemeFile(client: AdminClient, themeId: string, filename: string): Promise<ShopifyThemeFile> {
  if (!THEME_GID.test(themeId)) throw new ShopifyApiError('Not a theme ID.', { code: 'BAD_ID' });
  if (!EDITABLE_FILE.test(filename) || filename.includes('..')) throw new ShopifyApiError('Only .liquid / .json files under layout/, templates/, sections/ or snippets/ can be opened.', { code: 'BAD_FILE' });
  const d = await client.request<{ theme: { files: { nodes: { filename: string; checksumMd5: string | null; size: number | string; body: { content?: string } }[] } } | null }>(
    'query SentinelThemeFile($id: ID!, $f: [String!]) { theme(id: $id) { files(filenames: $f, first: 1) { nodes { filename checksumMd5 size body { ... on OnlineStoreThemeFileBodyText { content } } } } } }',
    { id: themeId, f: [filename] },
  );
  const node = d.theme?.files?.nodes?.[0];
  if (!node) throw new ShopifyApiError(`File ${filename} not found in this theme.`, { code: 'NOT_FOUND' });
  if (typeof node.body?.content !== 'string') throw new ShopifyApiError(`${filename} is not a text file.`, { code: 'BAD_FILE' });
  return { themeId, filename: node.filename, checksumMd5: node.checksumMd5 ?? md5(node.body.content), size: Number(node.size) || Buffer.byteLength(node.body.content), content: node.body.content };
}

export async function writeThemeFile(client: AdminClient, theme: ShopifyTheme, filename: string, content: string): Promise<void> {
  if (theme.role === 'MAIN') throw new ShopifyApiError('Refused: this is the live (published) theme. Duplicate it in Shopify, apply the change to the copy, preview it, then publish it yourself.', { code: 'LIVE_THEME' });
  if (!theme.writable) throw new ShopifyApiError(`Refused: theme role ${theme.role} cannot be changed.`, { code: 'READ_ONLY_THEME' });
  if (!EDITABLE_FILE.test(filename)) throw new ShopifyApiError('This file cannot be changed from Sentinel.', { code: 'BAD_FILE' });
  const d = await client.request<{ themeFilesUpsert: { userErrors: { field?: string[]; message: string }[] } }>(
    'mutation SentinelThemeWrite($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) { themeFilesUpsert(themeId: $themeId, files: $files) { upsertedThemeFiles { filename } userErrors { field message code } } }',
    { themeId: theme.id, files: [{ filename, body: { type: 'TEXT', value: content } }] },
  );
  checkUserErrors(d.themeFilesUpsert, 'themeFilesUpsert');
}

export const md5 = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/**
 * Line diff (common prefix/suffix trimmed, LCS on the rest) with 3 lines of context; long unchanged runs collapse to “…”.
 * Very large changed regions fall back to “all old lines removed, all new lines added”.
 */
export function lineDiff(a: string, b: string, context = 3): { lines: DiffLine[]; added: number; removed: number } {
  const A = a.split('\n');
  const B = b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const mid: DiffLine[] = [];
  if (a2.length * b2.length > 4_000_000) {
    for (const t of a2) mid.push({ op: '-', text: t });
    for (const t of b2) mid.push({ op: '+', text: t });
  } else {
    const n = a2.length, m = b2.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { mid.push({ op: ' ', text: a2[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) mid.push({ op: '-', text: a2[i++] });
      else mid.push({ op: '+', text: b2[j++] });
    }
    while (i < n) mid.push({ op: '-', text: a2[i++] });
    while (j < m) mid.push({ op: '+', text: b2[j++] });
  }
  const all: DiffLine[] = [...A.slice(0, pre).map((t) => ({ op: ' ' as const, text: t })), ...mid, ...A.slice(A.length - suf).map((t) => ({ op: ' ' as const, text: t }))];
  const keep = all.map((l, k) => l.op !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some((x) => x.op !== ' '));
  const lines: DiffLine[] = [];
  for (let k = 0; k < all.length; k++) {
    if (keep[k]) lines.push(all[k]);
    else if (k === 0 || keep[k - 1]) lines.push({ op: '…', text: '' });
  }
  return { lines, added: mid.filter((l) => l.op === '+').length, removed: mid.filter((l) => l.op === '-').length };
}
