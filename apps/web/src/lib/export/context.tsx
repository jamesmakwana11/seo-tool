import { createContext, useCallback, useContext, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';

/**
 * While a download is being prepared, tables show every row (not just the current page) so the file contains all of
 * them; tables paged by the server load their rows through `track`. Rows per table are capped (EXPORT_ROW_CAP).
 */
export const EXPORT_ROW_CAP = 10_000;

interface ExportCtx {
  expanding: boolean;
  setExpanding: (v: boolean) => void;
  /** Registers work the download must wait for (a table loading all its rows). */
  track: (p: Promise<unknown>) => void;
  /** Resolves when every tracked load has finished (failed ones included). */
  settle: () => Promise<void>;
  /** The Download menu the page header shows (provided by the app shell, so the UI kit does not import it). */
  Menu: ComponentType;
}

const Ctx = createContext<ExportCtx | null>(null);

export function ExportProvider({ children, menu }: { children: ReactNode; menu: ComponentType }) {
  const [expanding, setExpanding] = useState(false);
  const pending = useRef(new Set<Promise<unknown>>());
  const track = useCallback((p: Promise<unknown>) => {
    pending.current.add(p);
    void p.finally(() => pending.current.delete(p)).catch(() => undefined);
  }, []);
  const settle = useCallback(async () => {
    // Loads may register one render after expanding starts: wait for the set to stay empty.
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (!pending.current.size) return;
      await Promise.allSettled([...pending.current]);
    }
  }, []);
  const value = useMemo(() => ({ expanding, setExpanding, track, settle, Menu: menu }), [expanding, track, settle, menu]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** null outside the app shell (tests rendering a page alone): no Download menu, tables behave as usual. */
export function useExport(): ExportCtx | null {
  return useContext(Ctx);
}

/** Every row of a server-paged list (in steps of the API's page limit), up to `cap`. */
export async function loadAllPages<T>(fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>, step: number, cap = EXPORT_ROW_CAP): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < cap; offset += step) {
    const r = await fetchPage(offset, Math.min(step, cap - offset));
    out.push(...r.items);
    if (!r.items.length || out.length >= r.total) break;
  }
  return out.slice(0, cap);
}
