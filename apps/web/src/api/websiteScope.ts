/**
 * The website every website-scoped API call belongs to. Read synchronously at the START of each call (mock: before its
 * simulated latency; http: as the X-Website-Id header), so switching websites mid-flight can never write one site's data
 * into another. The selection is remembered in this browser (survives a refresh and new tabs); the website list itself
 * always comes from the server.
 */
import { DEMO_WEBSITE_ID } from '@sentinel/shared';

const KEY = 'sentinel.website';
let current: string = (() => {
  try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || DEMO_WEBSITE_ID; } catch { return DEMO_WEBSITE_ID; }
})();
const listeners = new Set<(id: string) => void>();

export const websiteScope = {
  get: () => current,
  set(id: string) {
    if (id === current) return;
    current = id;
    try { localStorage.setItem(KEY, id); } catch { /* storage unavailable — selection lasts until reload */ }
    for (const l of listeners) l(id);
  },
  subscribe(l: (id: string) => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

/** Whether the selected website is the bundled DEMO workspace (drives the generic "DEMO data" badge). */
let demo = true;
const demoListeners = new Set<() => void>();
export const demoScope = {
  get: () => demo,
  set(v: boolean) { if (v !== demo) { demo = v; for (const l of demoListeners) l(); } },
  subscribe(l: () => void) { demoListeners.add(l); return () => { demoListeners.delete(l); }; },
};
