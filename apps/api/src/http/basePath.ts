/**
 * Sub-path the app is served under (e.g. "/seo-tool" for https://apps.deodap.info/seo-tool). Comes from APP_BASE_URL, or
 * from the app URL entered with the Shopify app credentials (registered here when it is saved or loaded), so the OAuth
 * callback and the web app work under the sub-path whether or not the reverse proxy strips it.
 */
const registered = new Set<string>();

export function pathOfUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function registerBasePath(url: string): void {
  const p = pathOfUrl(url);
  if (p) registered.add(p);
}

/** Every known sub-path (env first), longest first. */
export function basePaths(appBaseUrl: string | undefined): string[] {
  const env = pathOfUrl(appBaseUrl);
  return [...new Set([env, ...registered].filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function firstBasePath(): string {
  return [...registered][0] ?? '';
}
