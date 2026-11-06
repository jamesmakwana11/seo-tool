import { useState } from 'react';
import { ChevronDown, Download, FileSpreadsheet, FileText, FileType2, Sheet } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { Menu } from '@/components/ui/overlay';
import { useToast } from '@/components/ui/Toast';
import { useWebsites } from '@/websites/WebsiteContext';
import { useExport } from '@/lib/export/context';
import { capturePage } from '@/lib/export/capture';
import { FORMAT_LABELS, MIME, fileName, type ExportFormat } from '@/lib/export/model';
import { toCsv, toDocx, toXlsx } from '@/lib/export/office';
import { toPdf } from '@/lib/export/pdf';

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function save(data: Uint8Array | string, name: string, mime: string) {
  const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const ICON: Record<ExportFormat, typeof FileText> = { pdf: FileText, xlsx: FileSpreadsheet, docx: FileType2, csv: Sheet };

/**
 * Download menu on every screen (in the page header): PDF, Excel, Word or CSV of what the screen shows — KPIs, every
 * table with all its rows (not only the visible page), details and text — for the selected website, with the active
 * filters and tabs noted at the top. Built in the browser from data the user can already see.
 */
export function ExportMenu() {
  const exp = useExport();
  const { current } = useWebsites();
  const toast = useToast();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  // Open the menu towards the side with room (the button sits left on narrow screens, right on wide ones).
  const [align, setAlign] = useState<'left' | 'right'>('right');
  if (!exp) return null;
  const run = async (format: ExportFormat) => {
    const root = document.querySelector<HTMLElement>('[data-export-root]');
    if (!root || busy) return;
    setBusy(format);
    try {
      exp.setExpanding(true);
      await nextFrame();
      await exp.settle();
      await nextFrame();
      const doc = capturePage(root, { website: current ? `${current.name} (${current.domain})` : undefined });
      exp.setExpanding(false);
      const rows = doc.sections.reduce((n, s) => n + (s.kind === 'text' ? 0 : s.rows.length), 0);
      const data = format === 'pdf' ? toPdf(doc) : format === 'xlsx' ? toXlsx(doc) : format === 'docx' ? toDocx(doc) : toCsv(doc);
      save(data, fileName(doc, format), MIME[format]);
      toast.success(`${FORMAT_LABELS[format]} downloaded — ${doc.sections.length} section${doc.sections.length === 1 ? '' : 's'}${rows ? `, ${rows.toLocaleString('en-IN')} row${rows === 1 ? '' : 's'}` : ''}`);
    } catch (e) {
      toast.error(`The download could not be created: ${(e as Error).message}`);
    } finally {
      exp.setExpanding(false);
      setBusy(null);
    }
  };
  return (
    <div data-export-skip>
      <Menu
        align={align}
        trigger={(open, isOpen) => (
          <Button icon={<Download className="h-4 w-4" />} loading={!!busy} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAlign(r.right - 240 < (e.currentTarget.closest('main')?.getBoundingClientRect().left ?? 0) ? 'left' : 'right'); open(); }} aria-haspopup="menu" aria-expanded={isOpen} data-testid="export-menu">
            Download<ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
          </Button>
        )}
        items={(['pdf', 'xlsx', 'docx', 'csv'] as ExportFormat[]).map((f) => {
          const Icon = ICON[f];
          return { label: <span className="flex items-center gap-2"><Icon className="h-4 w-4 text-muted" aria-hidden />{FORMAT_LABELS[f]}</span>, onClick: () => void run(f), disabled: !!busy };
        })}
      />
    </div>
  );
}
