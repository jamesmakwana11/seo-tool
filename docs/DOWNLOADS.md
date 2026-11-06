# Downloads — PDF, Excel, Word, CSV on every screen

Every screen has a **Download** button in its header with four formats: **PDF**, **Excel (.xlsx)**, **Word (.docx)**
and **CSV**. The file contains what the screen shows for the selected website:

- the title and description, the website, the date and time (IST), and the filters, tabs and periods in effect;
- KPI tiles (value and comparison) as a *Summary*;
- every panel: its tables, label / value lists, or its text;
- the numbers behind each chart, as a table;
- **every row** of each table — not only the visible page. Tables paged by the server (Issues board, All pages,
  Image Audit, Change monitor, SEO optimization) load all matching rows for the file (up to 10,000 rows per table;
  2,000 for SEO optimization lists, which are computed per row).

Left out: buttons, menus, form controls, icons and the chart drawings themselves. Form fields (settings screens) are
written as their current values; checkboxes as Yes / No.

Formats:

| Format | What you get |
|---|---|
| PDF | A4 (landscape when a table has more than five columns), tables with wrapped cells, the header row repeated on each page, page numbers. Helvetica: characters outside Western European text are replaced (₹ → Rs, → → ->) |
| Excel | An *About this report* sheet, then one sheet per section; header row bold, frozen and filterable; numbers stored as numbers (ids such as 0042 stay text) |
| Word | Title, facts, then each section as a heading with a table (header row repeated on each page) or paragraphs; landscape for wide tables |
| CSV | UTF-8 with BOM (opens correctly in Excel); sections one after another; cells that start with = + - @ are prefixed with ' so spreadsheets do not run them as formulas |

Files are built in the browser from data the signed-in user can already see (no extra server calls except loading
all rows of server-paged tables through the same permission-checked API), and no new dependency was added. The
existing exports (crawl results CSV / JSON, Image Audit, Change monitor, reports) remain.

Code: `apps/web/src/lib/export/` (model, capture, office writers, PDF writer, ZIP), `components/export/ExportMenu.tsx`;
tests: `apps/web/test/export.test.tsx`.
