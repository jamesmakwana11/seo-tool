/**
 * The path the app is served under ("" at the root, "/seo-tool" for https://apps.deodap.info/seo-tool), set by the API
 * server in index.html. Used for the router basename and the API base, so one build works at any path.
 */
export function appBasePath(doc: Pick<Document, 'querySelector'> | undefined = typeof document === 'undefined' ? undefined : document): string {
  const v = doc?.querySelector('meta[name="sentinel-base-path"]')?.getAttribute('content') ?? '';
  const clean = v.trim().replace(/\/+$/, '');
  return clean && clean.startsWith('/') ? clean : '';
}
