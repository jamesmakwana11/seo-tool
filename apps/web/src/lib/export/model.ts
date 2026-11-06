/**
 * What a screen looks like as a document: a title, a few facts (website, date, filters) and sections — tables,
 * label / value lists and text. Every download format (PDF, Excel, Word, CSV) is written from this one model, in the
 * browser, with no extra libraries.
 */
export type ExportSection =
  | { heading: string; kind: 'table'; columns: string[]; rows: string[][] }
  | { heading: string; kind: 'kv'; rows: [string, string][] }
  | { heading: string; kind: 'text'; lines: string[] };

export interface ExportDoc {
  title: string;
  subtitle?: string;
  /** Facts shown under the title: website, generated at, period, filters… */
  meta: [string, string][];
  sections: ExportSection[];
}

export type ExportFormat = 'pdf' | 'xlsx' | 'docx' | 'csv';
export const FORMAT_LABELS: Record<ExportFormat, string> = { pdf: 'PDF', xlsx: 'Excel (.xlsx)', docx: 'Word (.docx)', csv: 'CSV' };
export const MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv;charset=utf-8',
};

/** Rows of a section as a plain grid (header first) — used by CSV and Excel. */
export function sectionGrid(s: ExportSection): string[][] {
  if (s.kind === 'table') return [s.columns, ...s.rows];
  if (s.kind === 'kv') return [['Item', 'Value'], ...s.rows];
  return s.lines.map((l) => [l]);
}

export function fileName(doc: ExportDoc, ext: string, now = new Date()): string {
  const slug = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60);
  const site = doc.meta.find(([k]) => k === 'Website')?.[1];
  const stamp = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  return `${[slug(doc.title) || 'export', site ? slug(site) : ''].filter(Boolean).join('_')}_${stamp}.${ext}`;
}

/** Characters XML 1.0 does not allow (control characters) are dropped. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
export const xmlText = (v: string) => v.replace(XML_INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
