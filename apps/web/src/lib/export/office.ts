/**
 * CSV, Excel (.xlsx) and Word (.docx) from an ExportDoc. Excel: a "Summary" sheet with the title and facts, then one
 * sheet per section (header row bold, frozen and filterable, numbers stored as numbers). Word: title, facts, then each
 * section as a heading with a table (header row repeated on every page) or paragraphs; landscape when tables are wide.
 */
import { sectionGrid, xmlText, type ExportDoc } from './model';
import { zip } from './zip';

// ------------------------------------------------------------------------------------------------ CSV

const csvCell = (v: string) => (/[",\r\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

/** UTF-8 with BOM (Excel opens it with the right characters); sections one after another, separated by a blank line. */
export function toCsv(doc: ExportDoc): string {
  const lines: string[] = [csvCell(doc.title)];
  for (const [k, v] of doc.meta) lines.push(`${csvCell(k)},${csvCell(v)}`);
  for (const s of doc.sections) {
    lines.push('');
    if (doc.sections.length > 1 || s.heading) lines.push(csvCell(s.heading));
    for (const row of sectionGrid(s)) lines.push(row.map((c) => csvCell(c ?? '')).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------------------------------------ Excel

const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
/** A plain number ("1,500", "-3.25", "42") — not an id with a leading zero, a phone number or a date. */
export function asNumber(v: string): number | undefined {
  const t = v.trim();
  if (!/^-?(\d{1,3}(,\d{2,3})*|\d+)(\.\d+)?$/.test(t) || /^-?0\d/.test(t) || t.replace(/[^\d]/g, '').length > 15) return undefined;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function sheetXml(grid: string[][], header: boolean): string {
  const widths = (grid[0] ?? []).map((_, c) => Math.min(80, Math.max(8, ...grid.slice(0, 500).map((r) => Math.min(80, (r[c] ?? '').length + 2)))));
  const rows = grid.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const ref = `${colName(ci)}${ri + 1}`;
    const style = header && ri === 0 ? ' s="1"' : (v ?? '').length > 60 ? ' s="2"' : '';
    const num = header && ri === 0 ? undefined : asNumber(v ?? '');
    return num !== undefined ? `<c r="${ref}"${style}><v>${num}</v></c>` : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText((v ?? '').slice(0, 32000))}</t></is></c>`;
  }).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const last = `${colName(Math.max(0, (grid[0]?.length ?? 1) - 1))}${Math.max(1, grid.length)}`;
  const frozen = header && grid.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const filter = header && grid.length > 1 ? `<autoFilter ref="A1:${last}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${frozen}${cols}<sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

export function toXlsx(doc: ExportDoc): Uint8Array {
  const used = new Set<string>();
  const sheetName = (raw: string) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet').slice(0, 28);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  };
  const sheets: { name: string; xml: string }[] = [];
  sheets.push({ name: sheetName('About this report'), xml: sheetXml([[doc.title], ...(doc.subtitle ? [[doc.subtitle]] : []), [], ...doc.meta.map(([k, v]) => [k, v]), [], ['Sections', ''], ...doc.sections.map((s) => [s.heading, s.kind === 'table' ? `${s.rows.length} rows` : s.kind === 'kv' ? `${s.rows.length} items` : `${s.lines.length} lines`])], false) });
  for (const s of doc.sections) sheets.push({ name: sheetName(s.heading), xml: sheetXml(sectionGrid(s), s.kind !== 'text') });
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(doc.title)}</dc:title><dc:creator>DeoDap SEO Sentinel</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEAFB"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
  ];
  return zip(files);
}

// ------------------------------------------------------------------------------------------------ Word

const run = (text: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
  `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz ?? 20}"/></w:rPr><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`;
const para = (inner: string, o: { spaceAfter?: number; keepNext?: boolean } = {}) => `<w:p><w:pPr><w:spacing w:after="${o.spaceAfter ?? 80}"/>${o.keepNext ? '<w:keepNext/>' : ''}</w:pPr>${inner}</w:p>`;

function table(grid: string[][], widthTwips: number): string {
  const cols = grid[0]?.length ?? 1;
  const natural = Array.from({ length: cols }, (_, c) => Math.min(60, Math.max(6, ...grid.slice(0, 300).map((r) => (r[c] ?? '').length))));
  const sum = natural.reduce((a, b) => a + b, 0) || 1;
  const widths = natural.map((n) => Math.max(600, Math.round((n / sum) * widthTwips)));
  const border = '<w:top w:val="single" w:sz="4" w:color="D9D3E8"/><w:left w:val="single" w:sz="4" w:color="D9D3E8"/><w:bottom w:val="single" w:sz="4" w:color="D9D3E8"/><w:right w:val="single" w:sz="4" w:color="D9D3E8"/><w:insideH w:val="single" w:sz="4" w:color="D9D3E8"/><w:insideV w:val="single" w:sz="4" w:color="D9D3E8"/>';
  const rows = grid.map((r, ri) => `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${r.map((v, ci) => `<w:tc><w:tcPr><w:tcW w:w="${widths[ci]}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEAFB"/>' : ''}</w:tcPr>${(v ?? '').split('\n').map((line) => `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(line, { b: ri === 0, sz: 16 })}</w:p>`).join('')}</w:tc>`).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widthTwips}" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${rows}</w:tbl>${para('', { spaceAfter: 160 })}`;
}

export function toDocx(doc: ExportDoc): Uint8Array {
  const wide = doc.sections.some((s) => s.kind === 'table' && s.columns.length > 5);
  // A4: 11906 x 16838 twips, 720 margins.
  const [pw, ph] = wide ? [16838, 11906] : [11906, 16838];
  const width = pw - 1440;
  const body: string[] = [
    para(run(doc.title, { b: true, sz: 36 }), { spaceAfter: 60 }),
    ...(doc.subtitle ? [para(run(doc.subtitle, { sz: 20, color: '6B6680' }), { spaceAfter: 120 })] : []),
    ...doc.meta.map(([k, v]) => para(`${run(`${k}: `, { b: true, sz: 18 })}${run(v, { sz: 18 })}`, { spaceAfter: 20 })),
    para('', { spaceAfter: 120 }),
  ];
  for (const s of doc.sections) {
    body.push(para(run(s.heading, { b: true, sz: 26 }), { spaceAfter: 100, keepNext: true }));
    if (s.kind === 'text') body.push(...s.lines.map((l) => para(run(l, { sz: 20 }), { spaceAfter: 60 })), para('', { spaceAfter: 120 }));
    else body.push(table(sectionGrid(s), width));
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"${wide ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>' },
    { name: 'word/document.xml', data: document },
  ]);
}
