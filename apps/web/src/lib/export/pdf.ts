/**
 * PDF from an ExportDoc without a library: A4 (landscape when a table is wide), Helvetica / Helvetica-Bold (built into
 * every PDF reader), tables with wrapped cells, a header row repeated on each page, and "Page n of N" footers.
 * Text is written in WinAnsi encoding: characters it lacks are replaced (₹ → Rs, → → ->, other scripts → ?).
 */
import type { ExportDoc } from './model';

// Helvetica glyph widths (1/1000 em) for ASCII 32–126, from the standard AFM.
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WIN: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const SUBST: Record<string, string> = { '₹': 'Rs ', '→': '->', '←': '<-', '↑': '^', '↓': 'v', '≤': '<=', '≥': '>=', '≠': '!=', '✓': 'Yes', '✗': 'No', '×': 'x', '\u00a0': ' ', '\u200b': '', '≈': '~', '−': '-' };

/** Text as WinAnsi bytes (one char per byte, as a JS string). */
export function winAnsi(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const sub = SUBST[ch];
    if (sub !== undefined) { out += sub; continue; }
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) out += ch;
    else if (WIN[ch]) out += String.fromCharCode(WIN[ch]);
    else if (c >= 0xa0 && c <= 0xff) out += ch;
    else if (c === 9) out += ' ';
    else {
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out += base && base.codePointAt(0)! < 127 ? base : '?';
    }
  }
  return out;
}
const width = (s: string, size: number, bold = false) => {
  let w = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); w += c >= 32 && c <= 126 ? W[c - 32] : 556; }
  return (w * size * (bold ? 1.06 : 1)) / 1000;
};
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Word-wraps encoded text to `max` points; very long words are broken. At most `maxLines` lines (… on the last). */
function wrap(text: string, size: number, max: number, bold = false, maxLines = Infinity): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (width(cand, size, bold) <= max) { line = cand; continue; }
      if (line) out.push(line);
      let w = word;
      while (width(w, size, bold) > max && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && width(w.slice(0, n), size, bold) > max) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  if (out.length > maxLines) { const cut = out.slice(0, maxLines); cut[maxLines - 1] = `${cut[maxLines - 1].slice(0, -2)}\x85`; return cut; }
  return out;
}

interface Page { ops: string[] }

export function toPdf(doc: ExportDoc): Uint8Array {
  const wide = doc.sections.some((s) => s.kind === 'table' && s.columns.length > 5);
  const [PW, PH] = wide ? [842, 595] : [595, 842];
  const M = 36;
  const CW = PW - 2 * M;
  const pages: Page[] = [];
  let page: Page;
  let y = 0;
  const newPage = () => { page = { ops: [] }; pages.push(page); y = PH - M; };
  newPage();
  const text = (s: string, x: number, yy: number, size: number, bold = false, gray = 0.12) => {
    page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${gray} g ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const rect = (x: number, yy: number, w: number, h: number, fill: string) => page.ops.push(`${fill} rg ${x.toFixed(2)} ${yy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  const line = (x1: number, y1: number, x2: number, y2: number) => page.ops.push(`0.85 0.83 0.91 RG 0.5 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  const ensure = (h: number) => { if (y - h < M + 18) { newPage(); return true; } return false; };

  // ---- title and facts
  for (const l of wrap(winAnsi(doc.title), 18, CW, true)) { text(l, M, y - 18, 18, true); y -= 24; }
  if (doc.subtitle) for (const l of wrap(winAnsi(doc.subtitle), 9.5, CW)) { text(l, M, y - 10, 9.5, false, 0.42); y -= 13; }
  y -= 4;
  for (const [k, v] of doc.meta) {
    const kk = winAnsi(`${k}: `);
    const kw = width(kk, 9, true);
    const lines = wrap(winAnsi(v), 9, CW - kw);
    ensure(lines.length * 12);
    text(kk, M, y - 9, 9, true, 0.3);
    lines.forEach((l, i) => text(l, M + kw, y - 9 - i * 12, 9, false, 0.3));
    y -= lines.length * 12;
  }
  y -= 10;

  // ---- sections
  const FS = 7.8;
  const LH = 9.6;
  const PAD = 4;
  for (const s of doc.sections) {
    ensure(40);
    text(winAnsi(s.heading), M, y - 12, 12, true);
    y -= 20;
    if (s.kind === 'text') {
      for (const raw of s.lines) for (const l of wrap(winAnsi(raw), 9, CW)) { ensure(12); text(l, M, y - 9, 9); y -= 12; }
      y -= 10;
      continue;
    }
    const header = s.kind === 'kv' ? ['Item', 'Value'] : s.columns.map(winAnsi);
    const body = (s.kind === 'kv' ? s.rows.map(([k, v]) => [k, v]) : s.rows).map((r) => header.map((_, i) => winAnsi(r[i] ?? '')));
    // Column widths: natural width (capped), at least the header's longest word, scaled to the page.
    const nat = header.map((h, c) => {
      const longestWord = Math.max(...h.split(/\s+/).map((w) => width(w, FS, true)), 24);
      const content = Math.max(width(h, FS, true), ...body.slice(0, 400).map((r) => Math.min(260, width(r[c], FS))));
      return { min: longestWord + 2 * PAD, want: Math.min(260, content) + 2 * PAD };
    });
    const total = nat.reduce((a, b) => a + b.want, 0);
    let cols = nat.map((n) => (total <= CW ? n.want + 2 : Math.max(n.min, (n.want / total) * CW)));
    const sum = cols.reduce((a, b) => a + b, 0);
    // Tables use the full page width (narrow two-column lists stay compact).
    const target = header.length <= 2 ? Math.min(CW, Math.max(sum, CW * 0.6)) : CW;
    cols = cols.map((w) => (w / sum) * target);
    const xs = cols.map((_, i) => M + cols.slice(0, i).reduce((a, b) => a + b, 0));
    const tableW = cols.reduce((a, b) => a + b, 0);
    const drawHeader = () => {
      const lines = header.map((h, i) => wrap(h, FS, cols[i] - 2 * PAD, true, 3));
      const h = Math.max(...lines.map((l) => l.length)) * LH + 2 * PAD;
      rect(M, y - h, tableW, h, '0.937 0.918 0.984');
      lines.forEach((ls, i) => ls.forEach((l, j) => text(l, xs[i] + PAD, y - PAD - FS - j * LH + 1, FS, true, 0.15)));
      y -= h;
      line(M, y, M + tableW, y);
    };
    drawHeader();
    if (!body.length) { ensure(14); text('No rows.', M + PAD, y - 11, 8, false, 0.45); y -= 16; }
    body.forEach((r, ri) => {
      const lines = r.map((v, i) => wrap(v, FS, cols[i] - 2 * PAD, false, 10));
      const h = Math.max(1, ...lines.map((l) => l.length)) * LH + 2 * PAD;
      if (ensure(h)) drawHeader();
      if (ri % 2 === 1) rect(M, y - h, tableW, h, '0.985 0.98 0.995');
      lines.forEach((ls, i) => ls.forEach((l, j) => text(l, xs[i] + PAD, y - PAD - FS - j * LH + 1, FS)));
      y -= h;
      line(M, y, M + tableW, y);
    });
    y -= 16;
  }

  // ---- footers
  pages.forEach((p, i) => {
    page = p;
    const f = winAnsi(`${doc.title} — page ${i + 1} of ${pages.length}`);
    text(f, PW - M - width(f, 7.5), M - 18, 7.5, false, 0.5);
    text('DeoDap SEO Sentinel', M, M - 18, 7.5, false, 0.5);
  });

  // ---- file
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const content = p.ops.join('\n');
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(winAnsi(doc.title))}) /Producer (DeoDap SEO Sentinel) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
