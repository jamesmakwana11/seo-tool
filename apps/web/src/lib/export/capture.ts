/**
 * Turns the screen the user is looking at into an ExportDoc: the page title and description, the website, the filters
 * and tabs in effect, KPI tiles, every panel (its tables, label / value lists, or its text), and tables outside panels.
 * Buttons, form controls, icons and charts are left out. Works on a detached copy of the page, laid out off-screen once,
 * so cell text keeps its line breaks.
 */
import type { ExportDoc, ExportSection } from './model';

/** Left out: action buttons (Button / IconButton), form controls, icons, charts (their numbers come from hidden tables), menus, tabs. */
const SKIP = 'input, select, textarea, svg, canvas, img, [role="menu"], [role="dialog"], [data-export-skip], .sr-only, nav[aria-label="Pagination"], .recharts-wrapper, [role="tablist"], [role="radiogroup"], [aria-hidden="true"]';

const clean = (s: string | null | undefined) => (s ?? '').split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
const textOf = (el: Element | null | undefined) => {
  if (!el) return '';
  const h = el as HTMLElement;
  return clean(typeof h.innerText === 'string' ? h.innerText : el.textContent);
};
const oneLine = (s: string) => s.replace(/\n+/g, ' — ');

function liveFilters(root: Element): [string, string][] {
  const out: [string, string][] = [];
  root.querySelectorAll('[role="tablist"]').forEach((tl) => {
    const sel = tl.querySelector('[role="tab"][aria-selected="true"]');
    if (sel) out.push(['View', clean(sel.textContent).replace(/\s*\d+$/, '')]);
  });
  root.querySelectorAll('[role="radiogroup"][aria-label]').forEach((g) => {
    const sel = g.querySelector('[aria-checked="true"]');
    if (sel) out.push([g.getAttribute('aria-label')!, clean(sel.textContent)]);
  });
  root.querySelectorAll('select').forEach((s) => {
    // Form fields (with their own label) are content, not filters.
    if (s.closest('[role="dialog"]') || s.closest('form') || !s.value || (s.id && root.querySelector(`label[for="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s.id) : s.id}"]`))) return;
    const opt = s.selectedOptions?.[0];
    const label = s.getAttribute('aria-label') || clean(s.closest('label')?.firstChild?.textContent);
    if (label && opt && !/^(all|any)\b/i.test(clean(opt.textContent))) out.push([label, clean(opt.textContent)]);
  });
  root.querySelectorAll('input[type="search"], input[aria-label^="Search"], input[placeholder^="Search"]').forEach((i) => {
    const v = (i as HTMLInputElement).value?.trim();
    if (v && !i.closest('[role="dialog"]')) out.push(['Search', v]);
  });
  root.querySelectorAll('[aria-pressed="true"]').forEach((b) => { if (!b.closest('[role="dialog"]')) out.push(['Filter', clean(b.textContent)]); });
  return out;
}

function tableSection(t: HTMLTableElement, heading: string): ExportSection {
  const headRow = t.tHead?.rows[0] ?? t.rows[0];
  const columns = headRow ? [...headRow.cells].map((c) => oneLine(textOf(c))) : [];
  const bodyRows = [...t.rows].filter((r) => r !== headRow && !r.closest('thead'));
  let rows = bodyRows.map((r) => [...r.cells].map((c) => textOf(c)));
  const n = Math.max(columns.length, ...rows.map((r) => r.length), 0);
  const cols = Array.from({ length: n }, (_, i) => columns[i] ?? '');
  // Columns with no header and no content (action buttons) are dropped.
  const keep = cols.map((h, i) => !!h || rows.some((r) => !!r[i]));
  rows = rows.map((r) => r.filter((_, i) => keep[i]));
  const caption = t.getAttribute('data-export-caption') || '';
  return { heading: heading || caption, kind: 'table', columns: cols.filter((_, i) => keep[i]).map((h, i) => h || `Column ${i + 1}`), rows };
}

function kvSection(dl: Element, heading: string): ExportSection {
  const rows: [string, string][] = [];
  dl.querySelectorAll('dt').forEach((dt) => {
    const dd = dt.nextElementSibling?.tagName === 'DD' ? dt.nextElementSibling : dt.parentElement?.querySelector('dd');
    rows.push([oneLine(textOf(dt)), textOf(dd)]);
  });
  return { heading, kind: 'kv', rows };
}

function kpiRow(el: Element): [string, string] {
  const label = textOf(el.querySelector('[data-export-label]'));
  const value = textOf(el.querySelector('[data-export-value]'));
  const hint = textOf(el.querySelector('[data-export-hint]'));
  return [oneLine(label), oneLine([value, hint].filter(Boolean).join(' · '))];
}

export function capturePage(liveRoot: HTMLElement, o: { website?: string; now?: Date } = {}): ExportDoc {
  const now = o.now ?? new Date();
  const filters = liveFilters(liveRoot);
  // Lay out a cleaned copy off-screen so innerText keeps block line breaks.
  const box = document.createElement('div');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = `position:absolute;left:-100000px;top:0;width:${Math.max(1024, liveRoot.clientWidth || 1200)}px;visibility:visible;pointer-events:none;`;
  // Form values are properties, not attributes: note them on the live page so the copy can show them as text.
  const marked: Element[] = [];
  liveRoot.querySelectorAll('input, select, textarea').forEach((el) => {
    const i = el as HTMLInputElement;
    let v: string | undefined;
    if (i.type === 'checkbox' || i.type === 'radio') v = i.checked ? 'Yes' : 'No';
    else if (el.tagName === 'SELECT') v = clean((el as HTMLSelectElement).selectedOptions?.[0]?.textContent);
    else if (i.type !== 'hidden' && i.type !== 'password' && i.type !== 'file') v = i.value;
    if (v !== undefined) { el.setAttribute('data-export-v', v); marked.push(el); }
  });
  const root = liveRoot.cloneNode(true) as HTMLElement;
  marked.forEach((el) => el.removeAttribute('data-export-v'));
  // Filter controls (already listed at the top) and search boxes are left out; other fields show their value.
  root.querySelectorAll('label').forEach((l) => { if (l.querySelector('select') && !l.closest('table') && !l.closest('form')) l.remove(); });
  root.querySelectorAll('[aria-pressed]').forEach((b) => b.remove());
  root.querySelectorAll('input[aria-label^="Search"], input[placeholder^="Search"], input[type="search"]').forEach((e) => e.remove());
  root.querySelectorAll('[data-export-v]').forEach((el) => {
    const v = el.getAttribute('data-export-v') ?? '';
    const span = document.createElement('span');
    span.textContent = v;
    el.replaceWith(span);
  });
  // Captions are visually hidden: keep them as data before hidden text is removed.
  root.querySelectorAll('table').forEach((t) => { const c = t.getAttribute('data-export-caption') || clean(t.caption?.textContent); if (c) t.setAttribute('data-export-caption', c); });
  root.querySelectorAll(SKIP).forEach((e) => e.remove());
  // Plain buttons (sortable column headers, clickable titles) keep their text.
  root.querySelectorAll('button').forEach((b) => b.replaceWith(...Array.from(b.childNodes)));
  // Chart numbers are hidden tables on screen; shown in the copy.
  root.querySelectorAll('[data-export-only]').forEach((e) => { e.removeAttribute('hidden'); (e as HTMLElement).style.display = 'table'; });
  root.querySelectorAll('[data-export-hint][hidden]').forEach((e) => { e.removeAttribute('hidden'); (e as HTMLElement).style.display = 'block'; });
  // Separate inline pieces (badges, links side by side) with a space.
  root.querySelectorAll('span, a, time, strong, em, code, abbr').forEach((e) => e.after(document.createTextNode(' ')));
  box.appendChild(root);
  document.body.appendChild(box);
  try {
    const title = oneLine(textOf(root.querySelector('[data-export-title]'))) || document.title || 'Export';
    const subtitle = textOf(root.querySelector('[data-export-desc]')) || undefined;
    const pageMeta = textOf(root.querySelector('[data-export-meta]'));
    const sections: ExportSection[] = [];
    const done = new Set<Element>();
    const inPanel = (el: Element) => el.parentElement?.closest('[data-export-panel]');
    const kpis: [string, string][] = [];
    const flushKpis = () => { if (kpis.length) { sections.push({ heading: 'Summary', kind: 'kv', rows: kpis.splice(0) }); } };
    const name = (base: string) => { let h = base || 'Details'; for (let i = 2; sections.some((s) => s.heading === h); i++) h = `${base || 'Details'} (${i})`; return h; };

    for (const el of root.querySelectorAll('[data-export-panel], table, [data-export-kv], [data-export-kpi]')) {
      if (done.has(el)) continue;
      const owner = inPanel(el);
      if (el.matches('[data-export-panel]')) {
        if (owner) continue; // handled with its outer panel
        flushKpis();
        const heading = oneLine(textOf(el.querySelector('[data-export-panel-title]')));
        const parts = [...el.querySelectorAll('table, [data-export-kv], [data-export-kpi]')].filter((x) => !x.parentElement?.closest('table'));
        parts.forEach((x) => done.add(x));
        const panelKpis: [string, string][] = [];
        for (const x of parts) {
          if (x.matches('table')) sections.push(tableSection(x as HTMLTableElement, name(heading || x.getAttribute('data-export-caption') || title)));
          else if (x.matches('[data-export-kv]')) sections.push(kvSection(x, name(heading || 'Details')));
          else panelKpis.push(kpiRow(x));
        }
        if (panelKpis.length) sections.push({ heading: name(heading || 'Summary'), kind: 'kv', rows: panelKpis });
        if (!parts.length) {
          const body = el.querySelector('[data-export-panel-body]') ?? el;
          const lines = textOf(body).split('\n').filter(Boolean).slice(0, 2000);
          if (lines.length) sections.push({ heading: name(heading || title), kind: 'text', lines });
        }
        continue;
      }
      if (owner) continue;
      if (el.matches('[data-export-kpi]')) { kpis.push(kpiRow(el)); continue; }
      flushKpis();
      if (el.matches('table')) { if (!el.parentElement?.closest('table')) sections.push(tableSection(el as HTMLTableElement, name(el.getAttribute('data-export-caption') || title))); }
      else sections.push(kvSection(el, name('Details')));
    }
    flushKpis();
    if (!sections.length) {
      const header = root.querySelector('[data-export-header]');
      header?.remove();
      const lines = textOf(root).split('\n').filter(Boolean).slice(0, 2000);
      sections.push({ heading: title, kind: 'text', lines: lines.length ? lines : ['Nothing to show on this screen.'] });
    }
    const meta: [string, string][] = [
      ...(o.website ? [['Website', o.website] as [string, string]] : []),
      ['Generated', `${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`],
      ...(pageMeta ? [['Details', oneLine(pageMeta)] as [string, string]] : []),
      ...filters,
    ];
    return { title, subtitle, meta, sections };
  } finally {
    box.remove();
  }
}
