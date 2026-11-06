import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { DataTable } from '../src/components/ui/DataTable';
import { Button, KV, Panel, Stat } from '../src/components/ui/primitives';
import { capturePage } from '../src/lib/export/capture';
import { ExportProvider, loadAllPages, useExport } from '../src/lib/export/context';
import { fileName, type ExportDoc } from '../src/lib/export/model';
import { asNumber, toCsv, toDocx, toXlsx } from '../src/lib/export/office';
import { toPdf, winAnsi } from '../src/lib/export/pdf';
import { crc32 } from '../src/lib/export/zip';

/** Download menu engine: the four writers and the page capture (every table row, KPIs, panels; no buttons). */
afterEach(cleanup);

const doc: ExportDoc = {
  title: 'Tasks', subtitle: 'Work of the team', meta: [['Website', 'DeoDap (deodap.in)'], ['View', 'Open']],
  sections: [
    { heading: 'Summary', kind: 'kv', rows: [['Open tasks', '3']] },
    { heading: 'Tasks', kind: 'table', columns: ['Task', 'Due', 'Count'], rows: [['Fix "H1", now', '7 Nov 2026', '1,500'], ['=HYPERLINK("x")', '₹ 1,499 → next', '0042']] },
  ],
};
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('writers', () => {
  it('CRC-32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('CSV: BOM, quoting, formula-safe cells, every section', () => {
    const csv = toCsv(doc);
    expect(csv.startsWith('﻿Tasks\r\n')).toBe(true);
    expect(csv).toContain('"Fix ""H1"", now",7 Nov 2026,"1,500"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('Open tasks,3');
  });

  it('Excel and Word are ZIP packages with their main parts; numbers stay numbers, ids stay text', () => {
    const x = toXlsx(doc);
    expect(text(x.slice(0, 2))).toBe('PK');
    const xs = text(x);
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet3.xml']) expect(xs).toContain(part);
    expect(asNumber('1,500')).toBe(1500);
    expect(asNumber('0042')).toBeUndefined();
    expect(asNumber('7 Nov 2026')).toBeUndefined();
    const d = text(toDocx(doc));
    expect(d.startsWith('PK')).toBe(true);
    expect(d).toContain('word/document.xml');
    expect(d).toContain('<w:tblHeader/>');
  });

  it('PDF: valid header, cross-reference offsets point at their objects, WinAnsi text', () => {
    const p = text(toPdf(doc));
    expect(p.startsWith('%PDF-1.4')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(p)![1]);
    expect(p.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...p.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(p.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(winAnsi('₹ 1,499 → next — “ok”')).toBe('Rs  1,499 -> next \x97 \x93ok\x94');
    expect(fileName(doc, 'pdf', new Date('2026-11-06T07:00:00Z'))).toBe('tasks_deodap-deodapin_2026-11-06_1230.pdf');
  });
});

describe('page capture', () => {
  it('reads the title, KPIs, panels with their tables and key / values; leaves buttons out; keeps sortable headers', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `T${i + 1}`, name: `Task ${i + 1}` }));
    function Page() {
      const exp = useExport()!;
      useEffect(() => { exp.setExpanding(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <div data-export-root>
          <div data-export-header><h1 data-export-title>Tasks</h1><p data-export-desc>All work</p></div>
          <Stat label="Open" value={60} />
          <Panel title="Board">
            <DataTable rows={rows} rowKey={(r) => r.id} pageSize={25} caption="Tasks" columns={[
              { key: 'id', header: 'ID', cell: (r) => r.id, sort: (a, b) => a.id.localeCompare(b.id) },
              { key: 'name', header: 'Name', cell: (r) => <span>{r.name}<Button size="sm">Delete</Button></span> },
              { key: 'act', header: <span className="sr-only">Actions</span>, cell: () => <button type="button" data-export-skip>Edit</button> },
            ]} />
          </Panel>
          <Panel title="About"><KV items={[{ k: 'Owner', v: 'Admin' }]} /></Panel>
        </div>
      );
    }
    render(<ExportProvider menu={() => null}><Page /></ExportProvider>);
    const root = document.querySelector<HTMLElement>('[data-export-root]')!;
    const d = capturePage(root, { website: 'DeoDap (deodap.in)' });
    expect(d.title).toBe('Tasks');
    expect(d.subtitle).toBe('All work');
    expect(d.meta[0]).toEqual(['Website', 'DeoDap (deodap.in)']);
    expect(d.sections.map((s) => s.heading)).toEqual(['Summary', 'Board', 'About']);
    const table = d.sections[1];
    if (table.kind !== 'table') throw new Error('expected a table');
    expect(table.columns).toEqual(['ID', 'Name']);
    expect(table.rows).toHaveLength(60); // every row, not the first page of 25
    expect(table.rows[0]).toEqual(['T1', 'Task 1']);
    expect(d.sections[2]).toEqual({ heading: 'About', kind: 'kv', rows: [['Owner', 'Admin']] });
    expect(d.sections[0]).toEqual({ heading: 'Summary', kind: 'kv', rows: [['Open', '60']] });
  });

  it('server-paged tables load every row through the export loader', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ id: `R${i}` }));
    const load = () => loadAllPages((offset, limit) => Promise.resolve({ items: all.slice(offset, offset + limit), total: all.length }), 50);
    let ctx: ReturnType<typeof useExport>;
    function T() {
      ctx = useExport();
      return <DataTable rows={all.slice(0, 25)} rowKey={(r) => r.id} columns={[{ key: 'id', header: 'ID', cell: (r) => r.id }]} server={{ page: 1, pageSize: 25, total: 120, onPage: () => undefined }} exportRows={load} />;
    }
    render(<ExportProvider menu={() => null}><T /></ExportProvider>);
    expect(screen.getAllByRole('row')).toHaveLength(26);
    await act(async () => { ctx!.setExpanding(true); });
    await act(async () => { await ctx!.settle(); });
    expect(screen.getAllByRole('row')).toHaveLength(121);
    await act(async () => { ctx!.setExpanding(false); });
    expect(screen.getAllByRole('row')).toHaveLength(26);
  });
});
