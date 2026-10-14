import { useEffect, useRef, useState } from 'react';

/** True when the person asked the OS for reduced motion — charts skip their entrance animation then. */
export function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function useReducedMotion(): boolean {
  const [r] = useState(prefersReducedMotion);
  return r;
}

/** Flips to true one frame after mount, so CSS transitions can play an entrance once. */
export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setM(true)); return () => cancelAnimationFrame(id); }, []);
  return m;
}

/**
 * Counts a number up once when it first appears (and eases to a new value if the real value changes).
 * Purely presentational: the final number is always the real value.
 */
export function CountUp({ value, decimals, duration = 650, format }: { value: number; decimals?: number; duration?: number; format?: (v: number) => string }) {
  const reduced = useReducedMotion();
  const d = decimals ?? (Number.isInteger(value) ? 0 : (String(value).split('.')[1]?.length ?? 1));
  const [shown, setShown] = useState(reduced ? value : 0);
  const from = useRef(reduced ? value : 0);
  useEffect(() => {
    if (reduced) { setShown(value); return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);
  const v = Number(shown.toFixed(d));
  return <>{format ? format(v) : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}</>;
}
