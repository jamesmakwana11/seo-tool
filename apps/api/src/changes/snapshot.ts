/**
 * Compact per-URL page snapshots for the Change Monitor (format v1, one gzip NDJSON line per URL), and the rules that
 * compare two snapshots of the same URL.
 *
 * Small fields (status, title, meta, H1, canonical, robots) are stored as values; large ones (text, links, images,
 * JSON-LD, assets) as a hash plus a capped list, so a 50,000-page snapshot stays a few MB on disk and the comparison
 * never needs whole crawls in memory.
 */
import crypto from 'node:crypto';
import type { ChangeField, ChangeFieldDiff, CrawledUrl } from '@sentinel/shared';
import type { ParsedPage } from '../crawler/types';

export const SNAPSHOT_VERSION = 1;
export const LINKS_CAP = 150;
export const IMAGES_CAP = 40;
export const ASSETS_CAP = 60;
export const HEADINGS_CAP = 20;
/** Main-text excerpt kept per page (enough to show what changed; the comparison itself uses a hash of the whole text). */
export const SNAPSHOT_TEXT_CHARS = 600;

export interface SnapRec {
  u: string;
  /** fetched | robots | excluded | depth_limit | page_limit | not_processed */
  st: string;
  s?: number | null;
  fs?: number | null;
  fu?: string;
  rc?: number;
  e?: string;
  tpl?: string;
  smp?: 1;
  tr?: 1;
  t?: string;
  m?: string;
  h1?: string[];
  h2?: string[];
  h3?: string[];
  c?: string;
  rb?: string;
  ix?: 0 | 1;
  ixr?: string;
  wc?: number;
  ch?: string;
  tx?: string;
  lc?: number;
  lh?: string;
  l?: string[];
  ih?: string;
  im?: [string, string | null][];
  sh?: string;
  sd?: string[];
  ah?: string;
  as?: string[];
}

const h = (v: string) => crypto.createHash('sha1').update(v).digest('hex').slice(0, 16);
const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
/** Path + query of an absolute URL by string ops (called ~150× per page: parsing each with new URL() cost ~0.2 ms/page). */
const pathOf = (u: string) => {
  const s = u.indexOf('//');
  if (s < 0) return u;
  const i = u.indexOf('/', s + 2);
  const q = u.indexOf('?', s + 2);
  const start = i < 0 || (q >= 0 && q < i) ? -1 : i;
  const rest = start < 0 ? `/${q >= 0 ? u.slice(q) : ''}` : u.slice(start);
  const h = rest.indexOf('#');
  return h >= 0 ? rest.slice(0, h) : rest;
};

const pathHashes = new Map<string, number>();
/** FNV-1a 32-bit hash of a link path, memoised (bounded) because the same menu links appear on every page. */
function pathHash(p: string): number {
  let v = pathHashes.get(p);
  if (v !== undefined) return v;
  v = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) v = Math.imul(v ^ p.charCodeAt(i), 0x01000193) >>> 0;
  if (pathHashes.size >= 200_000) pathHashes.clear();
  pathHashes.set(p, v);
  return v;
}

/** Snapshot of a fetched page (the page as parsed for the audit + its audit row). */
export function snapFromPage(p: ParsedPage, row: CrawledUrl, textChars: number): SnapRec {
  const r: SnapRec = { u: p.url, st: p.skippedByRobots ? 'robots' : 'fetched', s: p.status, fs: p.finalStatus, tpl: p.template };
  if (p.chain?.length) { r.rc = p.chain.length; r.fu = p.finalUrl; }
  if (p.error) r.e = p.error.slice(0, 300);
  if (p.budgetSample || p.scopedSample || p.paginated) r.smp = 1;
  if (p.truncated) r.tr = 1;
  const html = p.html;
  if (html) {
    if (html.title !== undefined) r.t = norm(html.title).slice(0, 500);
    if (html.metaDescription !== undefined) r.m = norm(html.metaDescription).slice(0, 1000);
    r.h1 = html.h1s.slice(0, HEADINGS_CAP).map((x) => norm(x).slice(0, 300));
    r.h2 = html.headings.filter((x) => x.level === 2).slice(0, HEADINGS_CAP).map((x) => norm(x.text).slice(0, 200));
    r.h3 = html.headings.filter((x) => x.level === 3).slice(0, HEADINGS_CAP).map((x) => norm(x.text).slice(0, 200));
    if (html.canonicals[0]) r.c = html.canonicals[0];
    // The parser's main text is already whitespace-collapsed: hash it as is (normalising 50,000 full texts cost ~3 s).
    r.wc = html.wordCount;
    r.ch = h(html.mainText ?? '');
    if (textChars > 0) r.tx = norm((html.mainText ?? '').slice(0, textChars * 2)).slice(0, textChars);
    // Links: deduplicated paths; an order-independent hash of all of them (sum + xor of per-path hashes, memoised —
    // menus repeat on every page), and the first LINKS_CAP paths in page order for the added / removed lists.
    const seen = new Set<string>();
    const list: string[] = [];
    let sum = 0;
    let mix = 0;
    for (const u of html.internalLinks) {
      const p = pathOf(u);
      if (seen.has(p)) continue;
      seen.add(p);
      const v = pathHash(p);
      sum = (sum + v) >>> 0;
      mix = (mix ^ Math.imul(v, 2654435761)) >>> 0;
      if (list.length < LINKS_CAP) list.push(p);
    }
    r.lc = seen.size;
    r.lh = `${sum.toString(16).padStart(8, '0')}${mix.toString(16).padStart(8, '0')}${seen.size.toString(16)}`;
    r.l = list;
    const imgs = html.images.filter((i) => i.inMain).map((i) => [i.src, i.alt] as [string, string | null]);
    r.ih = h(imgs.map(([s, a]) => `${s}\u0000${a ?? '\u0001'}`).join('\n'));
    r.im = imgs.slice(0, IMAGES_CAP);
    const ld = html.jsonld.map((j) => j.raw.replace(/\s+/g, ' ')).join('\n');
    r.sh = h(ld);
    r.sd = [...new Set(html.schemaTypes)].sort().slice(0, 40);
    const assets = [...new Set([...html.stylesheets, ...html.scriptSrcs])].sort();
    r.ah = h(assets.join('\n'));
    r.as = assets.slice(0, ASSETS_CAP);
  }
  const robots = [row.metaRobots, row.xRobotsTag].filter(Boolean).join(' | ');
  if (robots) r.rb = robots;
  if (row.indexable !== undefined) r.ix = row.indexable ? 1 : 0;
  if (row.indexabilityReason) r.ixr = row.indexabilityReason.slice(0, 300);
  return r;
}

/** Snapshot of a URL that was found but not fetched (its state says why). */
export function snapFromRow(row: CrawledUrl): SnapRec {
  return { u: row.url, st: row.crawlState ?? 'not_processed', tpl: row.template };
}

/** Field groups compared between two snapshots (each a short fingerprint). */
export const GROUPS: ChangeField[] = ['status', 'redirect', 'title', 'meta', 'h1', 'h2', 'h3', 'canonical', 'indexability', 'content', 'links', 'images', 'structured_data', 'assets'];

export function fingerprint(r: SnapRec): string {
  const j = (a?: unknown[]) => (a ? a.join('\u0002') : '');
  const parts: Record<ChangeField, string> = {
    status: `${r.s ?? ''}/${r.fs ?? ''}`,
    redirect: r.fu ?? '',
    title: r.t ?? '\u0001',
    meta: r.m ?? '\u0001',
    h1: j(r.h1),
    h2: j(r.h2),
    h3: j(r.h3),
    canonical: r.c ?? '',
    indexability: `${r.ix ?? ''}|${r.rb ?? ''}|${r.st === 'robots' ? 'robots' : ''}`,
    content: r.ch ?? '',
    links: r.lh ?? '',
    images: r.ih ?? '',
    structured_data: r.sh ?? '',
    assets: r.ah ?? '',
  };
  // One short hash of every compared field: equal fingerprints = nothing SEO-relevant changed (field details come from compare()).
  return h(GROUPS.map((g) => parts[g]).join('\u0003'));
}

export const ok = (r: SnapRec | undefined) => !!r && r.st === 'fetched' && typeof r.fs === 'number' && r.fs < 400 && !r.fu;
/** A failure that does not prove the page is gone (server error, rate limit, timeout, network). */
export const transientFailure = (r: SnapRec) => r.st === 'fetched' && (r.s === null || r.s === undefined || r.fs === null || r.fs === undefined || r.fs === 429 || r.fs >= 500);
export const gone = (r: SnapRec) => r.st === 'fetched' && (r.fs === 404 || r.fs === 410);

export type FieldChange = ChangeFieldDiff;

const list = (a?: string[]) => (a ?? []).join(' | ');
function setDiff(a: string[] = [], b: string[] = []) {
  const A = new Set(a);
  const B = new Set(b);
  return { added: b.filter((x) => !A.has(x)).slice(0, 50), removed: a.filter((x) => !B.has(x)).slice(0, 50) };
}

/** What changed between two fetched snapshots of one URL, with old / new values and evidence. */
export function compare(o: SnapRec, n: SnapRec): FieldChange[] {
  const out: FieldChange[] = [];
  const trunc = o.tr || n.tr ? 'suspected' as const : 'confirmed' as const;
  const truncNote = o.tr || n.tr ? 'One of the responses was cut off at the size limit, so the difference may be incomplete.' : undefined;
  if (`${o.s}/${o.fs}` !== `${n.s}/${n.fs}`) out.push({ field: 'status', old: `${o.s ?? '—'} → ${o.fs ?? '—'}`, new: `${n.s ?? '—'} → ${n.fs ?? '—'}`, confidence: 'confirmed' });
  if ((o.fu ?? '') !== (n.fu ?? '')) out.push({ field: 'redirect', old: o.fu ? `redirects to ${o.fu} (${o.rc} hop${o.rc === 1 ? '' : 's'})` : 'no redirect', new: n.fu ? `redirects to ${n.fu} (${n.rc} hop${n.rc === 1 ? '' : 's'})` : 'no redirect', confidence: 'confirmed' });
  if (!ok(o) || !ok(n)) return out;
  if ((o.t ?? '') !== (n.t ?? '')) out.push({ field: 'title', old: o.t ?? '(none)', new: n.t ?? '(none)', confidence: 'confirmed' });
  if ((o.m ?? '') !== (n.m ?? '')) out.push({ field: 'meta', old: o.m ?? '(none)', new: n.m ?? '(none)', confidence: 'confirmed' });
  for (const f of ['h1', 'h2', 'h3'] as const) {
    if (list(o[f]) !== list(n[f])) out.push({ field: f, old: list(o[f]) || '(none)', new: list(n[f]) || '(none)', ...setDiff(o[f], n[f]), confidence: trunc, note: truncNote });
  }
  if ((o.c ?? '') !== (n.c ?? '')) out.push({ field: 'canonical', old: o.c ?? '(none)', new: n.c ?? '(none)', confidence: 'confirmed' });
  const ixs = (r: SnapRec) => `${r.ix === 1 ? 'indexable' : r.ix === 0 ? 'not indexable' : 'unknown'}${r.rb ? ` (robots: ${r.rb})` : ''}${r.ix === 0 && r.ixr ? ` — ${r.ixr}` : ''}`;
  if ((o.ix ?? '') !== (n.ix ?? '') || (o.rb ?? '') !== (n.rb ?? '')) out.push({ field: 'indexability', old: ixs(o), new: ixs(n), confidence: 'confirmed' });
  if ((o.ch ?? '') !== (n.ch ?? '')) {
    out.push({ field: 'content', old: `${o.wc ?? 0} words${o.tx ? `: “${o.tx.slice(0, 300)}…”` : ''}`, new: `${n.wc ?? 0} words${n.tx ? `: “${n.tx.slice(0, 300)}…”` : ''}`, confidence: trunc, note: truncNote ?? 'Main-content text differs (hash compared).' });
  }
  if ((o.lh ?? '') !== (n.lh ?? '')) {
    const d = setDiff(o.l, n.l);
    const capped = (o.lc ?? 0) > LINKS_CAP || (n.lc ?? 0) > LINKS_CAP;
    out.push({ field: 'links', old: `${o.lc ?? 0} internal links`, new: `${n.lc ?? 0} internal links`, ...d, confidence: trunc, note: capped ? `More than ${LINKS_CAP} internal links: the counts cover every link; the added / removed lists compare the first ${LINKS_CAP} of each version in page order.` : truncNote });
  }
  if ((o.ih ?? '') !== (n.ih ?? '')) {
    const key = (x: [string, string | null]) => x[0];
    const oa = new Map((o.im ?? []).map((x) => [key(x), x[1]]));
    const alt: string[] = [];
    for (const [src, a] of n.im ?? []) if (oa.has(src) && (oa.get(src) ?? null) !== (a ?? null)) alt.push(`${src}: “${oa.get(src) ?? '(no alt)'}” → “${a ?? '(no alt)'}”`);
    const d = setDiff((o.im ?? []).map(key), (n.im ?? []).map(key));
    out.push({ field: 'images', old: `${o.im?.length ?? 0} images in the main content`, new: `${n.im?.length ?? 0} images`, ...d, confidence: trunc, note: alt.length ? `Alt text changed: ${alt.slice(0, 10).join('; ')}` : truncNote });
  }
  if ((o.sh ?? '') !== (n.sh ?? '')) {
    const d = setDiff(o.sd, n.sd);
    out.push({ field: 'structured_data', old: `types: ${list(o.sd) || '(none)'}`, new: `types: ${list(n.sd) || '(none)'}`, ...d, confidence: 'confirmed', note: d.added.length || d.removed.length ? undefined : 'Same types; the JSON-LD content changed (values such as price, availability or rating).' });
  }
  if ((o.ah ?? '') !== (n.ah ?? '')) {
    const d = setDiff(o.as, n.as);
    const base = (u: string) => u.split('?')[0];
    const versioned = d.added.filter((a) => d.removed.some((r) => base(r) === base(a))).map((a) => base(a));
    out.push({ field: 'assets', old: `${o.as?.length ?? 0} stylesheets / scripts`, new: `${n.as?.length ?? 0}`, ...d, confidence: 'confirmed', note: versioned.length ? `New version of: ${versioned.slice(0, 10).join(', ')}` : undefined });
  }
  return out;
}
