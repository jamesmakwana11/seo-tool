import { useCallback } from 'react';
import { useToast } from '@/components/ui/Toast';
import { downloadText } from '@/lib/format';

/** Hosted review build (VITE_HOSTED_REVIEW=true): the host blocks file downloads and printing. */
export const HOSTED_REVIEW = import.meta.env.VITE_HOSTED_REVIEW === 'true';

/** Hands an exported report to the person: a download normally; in the hosted review, the clipboard (downloads are blocked there). */
export function useDeliverExport() {
  const toast = useToast();
  return useCallback(async (r: { filename: string; mime: string; content: string }) => {
    if (!HOSTED_REVIEW) {
      downloadText(r.filename, r.mime, r.content);
      toast.success(`Exported ${r.filename}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(r.content);
      toast.success(`Copied ${r.filename} to the clipboard. File downloads are blocked in this hosted preview.`);
    } catch {
      toast.info(`${r.filename} was generated, but this hosted preview blocks downloads and the clipboard. Run the app locally to export files.`);
    }
  }, [toast]);
}
