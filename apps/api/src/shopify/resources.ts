/**
 * Products, collections, pages and articles through the Admin GraphQL API: storefront URL → resource, reading the SEO
 * fields, listing, and the write operations for the SEO editor.
 *
 * Where each value lives:
 *  - product / collection: title, descriptionHtml, seo { title description } (productUpdate / collectionUpdate);
 *  - page / article: title, body (article: summary, tags), SEO title / description in the metafields
 *    global.title_tag / global.description_tag (pageUpdate / articleUpdate + metafieldsSet);
 *  - image alt text: the MediaImage file (fileUpdate).
 */
import type { ShopifyResourceKind, ShopifyResourceSummary } from '@sentinel/shared';
import { checkUserErrors, ShopifyApiError, type AdminClient } from './client';

export interface ShopifyImage { id: string; alt: string; url?: string }

export interface ShopifyResource {
  kind: ShopifyResourceKind;
  id: string;
  handle: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  bodyHtml: string;
  summaryHtml?: string;
  tags?: string[];
  images?: ShopifyImage[];
  blogHandle?: string;
  updatedAt?: string;
  path: string;
}

const LOCALE = /^\/[a-z]{2}(?:-[a-z]{2})?(?=\/(?:products|collections|pages|blogs)\/)/i;

/** Storefront URL → which kind of resource and its handle (locale prefixes such as /hi/ or /en-in/ are ignored). */
export function parseStorefrontPath(url: string): { kind: ShopifyResourceKind; handle: string; blogHandle?: string } | undefined {
  let p: string;
  try { p = new URL(url).pathname; } catch { p = url; }
  p = decodeURIComponent(p).replace(LOCALE, '').replace(/\/+$/, '');
  const seg = p.split('/').filter(Boolean);
  if (seg[0] === 'products' && seg[1]) return { kind: 'product', handle: seg[1] };
  if (seg[0] === 'collections' && seg[2] === 'products' && seg[3]) return { kind: 'product', handle: seg[3] };
  if (seg[0] === 'collections' && seg[1] && seg.length === 2) return { kind: 'collection', handle: seg[1] };
  if (seg[0] === 'pages' && seg[1]) return { kind: 'page', handle: seg[1] };
  if (seg[0] === 'blogs' && seg[1] && seg[2] && seg[2] !== 'tagged') return { kind: 'article', blogHandle: seg[1], handle: seg[2] };
  return undefined;
}

export const storefrontPath = (r: Pick<ShopifyResource, 'kind' | 'handle' | 'blogHandle'>) =>
  r.kind === 'product' ? `/products/${r.handle}` : r.kind === 'collection' ? `/collections/${r.handle}` : r.kind === 'page' ? `/pages/${r.handle}` : `/blogs/${r.blogHandle ?? 'news'}/${r.handle}`;

export function adminUrl(shop: string, r: Pick<ShopifyResource, 'kind' | 'id'>): string {
  const num = r.id.split('/').pop();
  const section = r.kind === 'product' ? 'products' : r.kind === 'collection' ? 'collections' : r.kind === 'page' ? 'pages' : 'articles';
  return `https://${shop}/admin/${section}/${num}`;
}

const GID = /^gid:\/\/shopify\/(Product|Collection|Page|Article|MediaImage)\/\d+$/;
export const isGid = (id: string, type?: string) => GID.test(id) && (!type || id.startsWith(`gid://shopify/${type}/`));

// ---------------------------------------------------------------------------------------------- reading

const PRODUCT_FIELDS = 'id handle title descriptionHtml tags updatedAt seo { title description } media(first: 50) { nodes { ... on MediaImage { id alt image { url } } } }';
const COLLECTION_FIELDS = 'id handle title descriptionHtml updatedAt seo { title description } image { altText url }';
const SEO_TAGS = 'titleTag: metafield(namespace: "global", key: "title_tag") { value } descTag: metafield(namespace: "global", key: "description_tag") { value }';
const PAGE_FIELDS = `id handle title body updatedAt ${SEO_TAGS}`;
const ARTICLE_FIELDS = `id handle title body summary tags updatedAt blog { handle } image { altText url } ${SEO_TAGS}`;

type Raw = Record<string, unknown> & { id: string; handle: string; title: string };
const s = (v: unknown) => (typeof v === 'string' ? v : '');

function toResource(kind: ShopifyResourceKind, n: Raw): ShopifyResource {
  const seo = (n.seo ?? {}) as { title?: string | null; description?: string | null };
  const tag = (k: string) => s((n[k] as { value?: string } | null)?.value);
  const base = { kind, id: n.id, handle: n.handle, title: n.title, updatedAt: s(n.updatedAt) || undefined };
  // Collections and articles have one featured image; its alt text is written with collectionUpdate / articleUpdate.
  const img = n.image as { altText?: string | null; url?: string } | null | undefined;
  const featured = img?.url ? [{ id: 'featured', alt: img.altText ?? '', url: img.url }] : undefined;
  let r: ShopifyResource;
  if (kind === 'product') {
    const media = ((n.media as { nodes?: { id?: string; alt?: string | null; image?: { url?: string } | null }[] } | undefined)?.nodes ?? []).filter((m) => m.id && isGid(m.id, 'MediaImage'));
    r = { ...base, seoTitle: s(seo.title), seoDescription: s(seo.description), bodyHtml: s(n.descriptionHtml), tags: (n.tags as string[]) ?? [], images: media.map((m) => ({ id: m.id!, alt: m.alt ?? '', url: m.image?.url })), path: '' };
  } else if (kind === 'collection') {
    r = { ...base, seoTitle: s(seo.title), seoDescription: s(seo.description), bodyHtml: s(n.descriptionHtml), ...(featured ? { images: featured } : {}), path: '' };
  } else if (kind === 'page') {
    r = { ...base, seoTitle: tag('titleTag'), seoDescription: tag('descTag'), bodyHtml: s(n.body), path: '' };
  } else {
    r = { ...base, seoTitle: tag('titleTag'), seoDescription: tag('descTag'), bodyHtml: s(n.body), summaryHtml: s(n.summary), tags: (n.tags as string[]) ?? [], blogHandle: s((n.blog as { handle?: string } | null)?.handle) || undefined, ...(featured ? { images: featured } : {}), path: '' };
  }
  r.path = storefrontPath(r);
  return r;
}

const FIELDS: Record<ShopifyResourceKind, string> = { product: PRODUCT_FIELDS, collection: COLLECTION_FIELDS, page: PAGE_FIELDS, article: ARTICLE_FIELDS };
const TYPE: Record<ShopifyResourceKind, string> = { product: 'Product', collection: 'Collection', page: 'Page', article: 'Article' };

export async function fetchById(client: AdminClient, kind: ShopifyResourceKind, id: string): Promise<ShopifyResource | undefined> {
  if (!isGid(id, TYPE[kind])) throw new ShopifyApiError(`Not a Shopify ${kind} ID: ${id}`, { code: 'BAD_ID' });
  const d = await client.request<{ node: Raw | null }>(`query SentinelRead($id: ID!) { node(id: $id) { ... on ${TYPE[kind]} { ${FIELDS[kind]} } } }`, { id });
  return d.node?.id ? toResource(kind, d.node) : undefined;
}

/** Handles are matched exactly (Shopify search is fuzzy, so results are filtered). */
export async function fetchByHandle(client: AdminClient, kind: ShopifyResourceKind, handle: string, blogHandle?: string): Promise<ShopifyResource | undefined> {
  if (kind === 'product' || kind === 'collection') {
    const field = kind === 'product' ? 'productByIdentifier' : 'collectionByIdentifier';
    const d = await client.request<Record<string, Raw | null>>(`query SentinelByHandle($h: String!) { r: ${field}(identifier: { handle: $h }) { ${FIELDS[kind]} } }`, { h: handle });
    return d.r?.id ? toResource(kind, d.r) : undefined;
  }
  const root = kind === 'page' ? 'pages' : 'articles';
  const d = await client.request<Record<string, { nodes: Raw[] }>>(`query SentinelSearch($q: String!) { r: ${root}(first: 25, query: $q) { nodes { ${FIELDS[kind]} } } }`, { q: `handle:${JSON.stringify(handle)}` });
  const found = (d.r?.nodes ?? []).map((n) => toResource(kind, n)).filter((r) => r.handle === handle && (!blogHandle || r.blogHandle === blogHandle));
  return found[0];
}

export async function listResources(client: AdminClient, kind: ShopifyResourceKind, q?: string, after?: string): Promise<{ items: ShopifyResource[]; nextCursor?: string }> {
  const root = { product: 'products', collection: 'collections', page: 'pages', article: 'articles' }[kind];
  const fields = kind === 'product' ? 'id handle title tags updatedAt seo { title description }' : kind === 'collection' ? COLLECTION_FIELDS.replace('descriptionHtml ', '') : kind === 'page' ? `id handle title updatedAt ${SEO_TAGS}` : `id handle title updatedAt blog { handle } ${SEO_TAGS}`;
  const d = await client.request<Record<string, { nodes: Raw[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } }>>(
    `query SentinelList($after: String, $q: String) { r: ${root}(first: 50, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`,
    { after: after ?? null, q: q?.trim() ? q.trim() : null },
  );
  const conn = d.r;
  return { items: (conn?.nodes ?? []).map((n) => toResource(kind, { descriptionHtml: '', body: '', ...n })), nextCursor: conn?.pageInfo.hasNextPage ? conn.pageInfo.endCursor ?? undefined : undefined };
}

export function summarize(shop: string, r: ShopifyResource): ShopifyResourceSummary {
  return { kind: r.kind, id: r.id, handle: r.handle, title: r.title, path: r.path, seoTitle: r.seoTitle, seoDescription: r.seoDescription, updatedAt: r.updatedAt, adminUrl: adminUrl(shop, r) };
}

/** The current value of an editor field on a resource. */
export function fieldValue(r: ShopifyResource, key: string): string {
  switch (key) {
    case 'seoTitle': return r.seoTitle;
    case 'seoDescription': return r.seoDescription;
    case 'title': return r.title;
    case 'tags': return (r.tags ?? []).join(', ');
    case 'bodyHtml': return r.bodyHtml;
    case 'summaryHtml': return r.summaryHtml ?? '';
    default:
      if (key.startsWith('imageAlt:')) return r.images?.find((i) => i.id === key.slice(9))?.alt ?? '';
      return '';
  }
}

export const parseTags = (v: string) => v.split(',').map((t) => t.trim()).filter(Boolean);

// ---------------------------------------------------------------------------------------------- writing

export interface WriteOp {
  name: string;
  keys: string[];
  run: (client: AdminClient) => Promise<void>;
}

const MUTATION: Record<ShopifyResourceKind, string> = { product: 'productUpdate', collection: 'collectionUpdate', page: 'pageUpdate', article: 'articleUpdate' };

/** Which mutation writes a field (shown in the editor before anything is written). */
export function mutationFor(kind: ShopifyResourceKind, key: string): string {
  if (key === 'imageAlt:featured') return `${MUTATION[kind]} (image.altText)`;
  if (key.startsWith('imageAlt:')) return 'fileUpdate (alt)';
  if (key === 'seoTitle' || key === 'seoDescription') {
    if (kind === 'page' || kind === 'article') return `metafieldsSet (global.${key === 'seoTitle' ? 'title_tag' : 'description_tag'})`;
    return `${MUTATION[kind]} (seo.${key === 'seoTitle' ? 'title' : 'description'})`;
  }
  const f = { title: 'title', tags: 'tags', bodyHtml: kind === 'product' || kind === 'collection' ? 'descriptionHtml' : 'body', summaryHtml: 'summary' }[key as 'title'] ?? key;
  return `${MUTATION[kind]} (${f})`;
}

/**
 * The mutations that write `changes` (key → new value). `live` is the resource as read just before writing:
 * SEO title and description are always sent together, so the one not being changed keeps its live value.
 */
export function writeOps(live: ShopifyResource, changes: Record<string, string>): WriteOp[] {
  const ops: WriteOp[] = [];
  const keys = Object.keys(changes);
  const has = (k: string) => k in changes;
  const main = keys.filter((k) => ['title', 'tags', 'bodyHtml', 'summaryHtml'].includes(k) || ((live.kind === 'product' || live.kind === 'collection') && (k === 'seoTitle' || k === 'seoDescription')));
  if (main.length) {
    const seo = has('seoTitle') || has('seoDescription') ? { title: has('seoTitle') ? changes.seoTitle : live.seoTitle, description: has('seoDescription') ? changes.seoDescription : live.seoDescription } : undefined;
    if (live.kind === 'product') {
      const product: Record<string, unknown> = { id: live.id };
      if (has('title')) product.title = changes.title;
      if (has('bodyHtml')) product.descriptionHtml = changes.bodyHtml;
      if (has('tags')) product.tags = parseTags(changes.tags);
      if (seo) product.seo = seo;
      ops.push({ name: 'productUpdate', keys: main, run: async (c) => {
        const d = await c.request<{ productUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelProductUpdate($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }', { product });
        checkUserErrors(d.productUpdate, 'productUpdate');
      } });
    } else if (live.kind === 'collection') {
      const input: Record<string, unknown> = { id: live.id };
      if (has('title')) input.title = changes.title;
      if (has('bodyHtml')) input.descriptionHtml = changes.bodyHtml;
      if (seo) input.seo = seo;
      ops.push({ name: 'collectionUpdate', keys: main, run: async (c) => {
        const d = await c.request<{ collectionUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelCollectionUpdate($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }', { input });
        checkUserErrors(d.collectionUpdate, 'collectionUpdate');
      } });
    } else if (live.kind === 'page') {
      const page: Record<string, unknown> = {};
      if (has('title')) page.title = changes.title;
      if (has('bodyHtml')) page.body = changes.bodyHtml;
      ops.push({ name: 'pageUpdate', keys: main, run: async (c) => {
        const d = await c.request<{ pageUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelPageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message code } } }', { id: live.id, page });
        checkUserErrors(d.pageUpdate, 'pageUpdate');
      } });
    } else {
      const article: Record<string, unknown> = {};
      if (has('title')) article.title = changes.title;
      if (has('bodyHtml')) article.body = changes.bodyHtml;
      if (has('summaryHtml')) article.summary = changes.summaryHtml;
      if (has('tags')) article.tags = parseTags(changes.tags);
      ops.push({ name: 'articleUpdate', keys: main, run: async (c) => {
        const d = await c.request<{ articleUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelArticleUpdate($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id } userErrors { field message code } } }', { id: live.id, article });
        checkUserErrors(d.articleUpdate, 'articleUpdate');
      } });
    }
  }
  if ((live.kind === 'page' || live.kind === 'article') && (has('seoTitle') || has('seoDescription'))) {
    const metafields = [
      ...(has('seoTitle') ? [{ ownerId: live.id, namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: changes.seoTitle }] : []),
      ...(has('seoDescription') ? [{ ownerId: live.id, namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: changes.seoDescription }] : []),
    ];
    ops.push({ name: 'metafieldsSet', keys: keys.filter((k) => k === 'seoTitle' || k === 'seoDescription'), run: async (c) => {
      const d = await c.request<{ metafieldsSet: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelSeoTags($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { key } userErrors { field message code } } }', { m: metafields });
      checkUserErrors(d.metafieldsSet, 'metafieldsSet');
    } });
  }
  if (has('imageAlt:featured') && (live.kind === 'collection' || live.kind === 'article')) {
    const altText = changes['imageAlt:featured'];
    ops.push(live.kind === 'collection'
      ? { name: 'collectionUpdate', keys: ['imageAlt:featured'], run: async (c) => {
        const d = await c.request<{ collectionUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelCollectionUpdate($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }', { input: { id: live.id, image: { altText } } });
        checkUserErrors(d.collectionUpdate, 'collectionUpdate');
      } }
      : { name: 'articleUpdate', keys: ['imageAlt:featured'], run: async (c) => {
        const d = await c.request<{ articleUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelArticleUpdate($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id } userErrors { field message code } } }', { id: live.id, article: { image: { altText } } });
        checkUserErrors(d.articleUpdate, 'articleUpdate');
      } });
  }
  const alts = keys.filter((k) => k.startsWith('imageAlt:') && k !== 'imageAlt:featured');
  if (alts.length) {
    const files = alts.map((k) => ({ id: k.slice(9), alt: changes[k] }));
    ops.push({ name: 'fileUpdate', keys: alts, run: async (c) => {
      const d = await c.request<{ fileUpdate: { userErrors: { field?: string[]; message: string }[] } }>('mutation SentinelAlt($files: [FileUpdateInput!]!) { fileUpdate(files: $files) { files { id alt } userErrors { field message code } } }', { files });
      checkUserErrors(d.fileUpdate, 'fileUpdate');
    } });
  }
  return ops;
}

/** Compares a value read back from Shopify with what was written (Shopify may re-format HTML whitespace). */
export function sameValue(key: string, written: string, readBack: string): boolean {
  const n = (v: string) => (key === 'bodyHtml' || key === 'summaryHtml'
    ? v.replace(/>\s+</g, '><').replace(/\s+/g, ' ').replace(/<br\s*\/?>/gi, '<br>').replace(/\s*\/>/g, '>').trim()
    : key === 'tags' ? parseTags(v).map((t) => t.toLowerCase()).sort().join(',') : v.replace(/\s+/g, ' ').trim());
  return n(written) === n(readBack);
}
