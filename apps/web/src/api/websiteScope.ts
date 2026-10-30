/**
 * The website every website-scoped API call belongs to. Read synchronously at the START of each call (as the
 * X-Website-Id header), so switching websites mid-flight can never write one site's data
 * into another. The selection is remembered in this browser (survives a refresh and new tabs); the website list itself
 * always comes from the server.
 */
import { PRIMARY_WEBSITE_ID } from '@sentinel/shared';

const KEY = 'sentinel.website';
let current: string = (() => {
  try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || PRIMARY_WEBSITE_ID; } catch { return PRIMARY_WEBSITE_ID; }
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

