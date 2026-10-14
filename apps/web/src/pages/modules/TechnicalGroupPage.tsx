import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Compass } from 'lucide-react';
import type { CrawledUrl, CrawlDetail, SentinelConfig } from '@sentinel/shared';
import { ModuleView } from '@/components/domain/ModuleView';
import { Async, Badge, Code, EmptyState, KV, Mono, Notice, Panel, Tabs } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { SourceBadge } from '@/components/domain/badges';
import { TECH_GROUPS, type TechGroupSlug } from '@/components/modules/techGroups';
import { Bullets, NoAccess, PanelLink, useConfigQuery, useLatestCrawl } from '@/components/modules/shared';
import { fmtDateTime, fmtMs, fmtNum, shortUrl } from '@/lib/format';

const PAGE_GROUPS = ['crawlability', 'responses', 'canonicals', 'security', 'structured-data'] as const satisfies readonly TechGroupSlug[];
type PageGroup = (typeof PAGE_GROUPS)[number];

const DESCRIPTIONS: Record<PageGroup, string> = {
  crawlability: 'Can Google reach and index what matters? robots.txt, noindex, GSC coverage, sitemap integrity, orphans, depth and crawl-budget waste (PDF §4.1).',
  responses: 'Status codes, redirects and links on every crawled URL — 4xx/429, 5xx and slow responses, chains, broken links and discontinued products (PDF §4.2).',
  canonicals: 'One URL per piece of content: canonical validity, Shopify product-path duplication, duplicate and thin content, host policy (PDF §4.3).',
  security: 'HTTPS and certificate health, mobile usability at 390px, JS-only content and pagination handling (PDF §4.5).',
  'structured-data': 'Schema by template, validation errors, the monthly Google guideline sync and rich-result coverage (PDF §4.6).',
};

export default function TechnicalGroupPage() {
  const { group = '' } = useParams();
  const def = TECH_GROUPS.find((g) => g.slug === group);
  if (!def || !(PAGE_GROUPS as readonly string[]).includes(group)) {
    return (
      <EmptyState
        icon={<Compass className="h-8 w-8" />}
        title="This technical area doesn't exist"
        description="Pick one of the technical SEO areas from the overview."
        action={<Link to="/modules/technical" className="text-sm font-medium text-signal hover:underline">Back to Technical SEO</Link>}
      />
    );
  }
  const g = group as PageGroup;
  return (
    <ModuleView
      module="technical"
      title={`${def.prefix} ${def.title}`}
      description={DESCRIPTIONS[g]}
      groupFilter={def.prefix}
      headerActions={<PanelLink to="/modules/technical">Technical SEO overview</PanelLink>}
      extra={<GroupExtra group={g} />}
    />
  );
}

function GroupExtra({ group }: { group: PageGroup }) {
  switch (group) {
    case 'crawlability': return <Crawlability />;
    case 'responses': return <Responses />;
    case 'canonicals': return <Canonicals />;
    case 'security': return <Security />;
    case 'structured-data': return <StructuredData />;
  }
}

// ---------------------------------------------------------------- 4.1
function Crawlability() {
  const { q, allowed } = useConfigQuery();
  const crawl = useLatestCrawl();
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Panel title="robots.txt & AI-crawler policy" subtitle="Daily snapshot diff — any change touching /collections/, /products/ or /blogs/ is Critical" actions={allowed ? <PanelLink to="/settings/crawl">Crawl settings</PanelLink> : undefined}>
        {!allowed ? <NoAccess what="Site configuration" perm="settings.view" /> : (
          <Async q={q} rows={4}>
            {(cfg) => <PolicySummary cfg={cfg} />}
          </Async>
        )}
      </Panel>
      <Panel title="Sitemap & orphan summary" subtitle="Sitemap vs. crawl diff from the latest completed crawl">
        {!crawl.allowed ? <NoAccess what="Crawl data" perm="crawls.view" /> : (
          <Async q={crawl.runs} rows={4}>
            {() => (crawl.run ? (
              <Async q={crawl.detail} rows={4}>
                {(d) => <SitemapSummary d={d} />}
              </Async>
            ) : <EmptyState title="No completed crawl yet" description="Run a smart crawl from the Crawl Center to get a sitemap diff." action={<PanelLink to="/crawls">Crawl Center</PanelLink>} />)}
          </Async>
        )}
      </Panel>
    </div>
  );
}

function PolicySummary({ cfg }: { cfg: SentinelConfig }) {
  const bots = Object.entries(cfg.aiCrawlerPolicy);
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Intentional noindex paths (never flagged)</p>
        <div className="flex flex-wrap gap-1.5">
          {cfg.intentionalNoindex.length ? cfg.intentionalNoindex.map((p) => <Badge key={p}><Mono>{p}</Mono></Badge>) : <span className="text-sm text-muted">None configured.</span>}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">AI and search crawler policy (PDF §8)</p>
        <ul className="divide-y divide-line rounded-ctl border border-line">
          {bots.map(([bot, policy]) => (
            <li key={bot} className="flex items-center justify-between px-3 py-1.5 text-sm">
              <Mono>{bot}</Mono>
              <Badge tone={policy === 'allow' ? 'ok' : 'neutral'}>{policy === 'allow' ? 'Allow' : 'Blocked on purpose'}</Badge>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-muted">A block found in robots.txt or the firewall that is not listed as intentional raises a Critical finding (AEO-AI-CRAWLERS).</p>
      </div>
      <p className="text-xs text-muted">Crawler respects robots.txt: {cfg.crawl.respectRobots ? 'yes' : 'no'} · user agent <Mono>{cfg.crawl.userAgent}</Mono></p>
    </div>
  );
}

function SitemapSummary({ d }: { d: CrawlDetail }) {
  const s = d.sitemapDiff;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link to={`/crawls/${d.run.id}`} className="font-medium text-signal hover:underline">{d.run.id}</Link>
        <span className="text-muted">{d.run.type} · finished {fmtDateTime(d.run.finishedAt)} IST</span>
        <SourceBadge source={d.run.source} />
      </div>
      {s ? (
        <>
          <KV
            cols={3}
            items={[
              { k: 'Added to sitemap', v: fmtNum(s.added.length) },
              { k: 'Removed', v: fmtNum(s.removed.length) },
              { k: 'lastmod changed', v: fmtNum(s.lastmodChanged.length) },
              { k: 'Orphan candidates', v: <span className={s.inSitemapNotCrawled.length ? 'font-semibold text-med-ink' : ''}>{fmtNum(s.inSitemapNotCrawled.length)}</span> },
              { k: 'Crawled, not in sitemap', v: fmtNum(s.crawledNotInSitemap.length) },
              { k: 'Invalid entries', v: <span className={s.invalidEntries.length ? 'font-semibold text-med-ink' : ''}>{fmtNum(s.invalidEntries.length)}</span> },
            ]}
          />
          {s.invalidEntries.length > 0 && (
            <ul className="space-y-1 text-xs">
              {s.invalidEntries.slice(0, 4).map((e) => <li key={e.url} className="flex justify-between gap-2"><Mono className="truncate">{shortUrl(e.url)}</Mono><span className="shrink-0 text-muted">{e.problem}</span></li>)}
            </ul>
          )}
          <PanelLink to={`/crawls/${d.run.id}`}>Full sitemap diff</PanelLink>
        </>
      ) : <p className="text-sm text-muted">This crawl has no sitemap diff. Sitemap diffs are produced by smart and full crawls that fetched the XML sitemap.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- 4.2
type Bucket = '2xx' | '3xx' | '4xx' | '5xx' | 'timeout';
const bucketOf = (u: CrawledUrl): Bucket => (u.status === null ? 'timeout' : u.status >= 500 ? '5xx' : u.status >= 400 ? '4xx' : u.status >= 300 ? '3xx' : '2xx');
const BUCKET_LABEL: Record<Bucket, string> = { '2xx': '2xx success', '3xx': '3xx redirect', '4xx': '4xx client error', '5xx': '5xx server error', timeout: 'Timeout / no response' };

function Responses() {
  const crawl = useLatestCrawl();
  if (!crawl.allowed) return <Panel title="Status-code distribution"><NoAccess what="Crawl data" perm="crawls.view" /></Panel>;
  return (
    <Panel title="Status-code distribution" subtitle="Every URL fetched in the latest completed crawl" bodyClassName="p-3">
      <Async q={crawl.runs} rows={4}>
        {() => (crawl.run ? (
          <Async q={crawl.detail} rows={6}>{(d) => <StatusTable d={d} />}</Async>
        ) : <EmptyState title="No completed crawl yet" description="Run a smart crawl from the Crawl Center to see response codes." action={<PanelLink to="/crawls">Crawl Center</PanelLink>} />)}
      </Async>
    </Panel>
  );
}

function StatusTable({ d }: { d: CrawlDetail }) {
  const [bucket, setBucket] = useState<Bucket | 'all'>('all');
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, timeout: 0 };
    d.urls.forEach((u) => { c[bucketOf(u)] += 1; });
    return c;
  }, [d.urls]);
  const slow = d.urls.filter((u) => (u.responseMs ?? 0) > 3000).length;
  const rows = bucket === 'all' ? d.urls : d.urls.filter((u) => bucketOf(u) === bucket);
  if (!d.urls.length) return <EmptyState title="This crawl has no URL-level data" description={d.run.source === 'simulated' ? 'Simulated runs fetch nothing. URL results appear after a real crawl (Phase 2).' : 'No URLs were recorded for this run.'} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Crawl</span>
        <Link to={`/crawls/${d.run.id}`} className="font-medium text-signal hover:underline">{d.run.id}</Link>
        <span className="text-muted">· {fmtDateTime(d.run.finishedAt)} IST · {fmtNum(d.urls.length)} URLs sampled</span>
        <SourceBadge source={d.run.source} />
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">Response-code counts</caption>
          <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-3 py-1.5 font-medium">Class</th><th className="px-3 py-1.5 font-medium">URLs</th><th className="px-3 py-1.5 font-medium">Share</th><th className="px-3 py-1.5 font-medium">Related check</th></tr></thead>
          <tbody>
            {(Object.keys(counts) as Bucket[]).map((b) => (
              <tr key={b} className="border-b border-line last:border-0">
                <td className="px-3 py-1.5">{BUCKET_LABEL[b]}</td>
                <td className={`px-3 py-1.5 tabular-nums ${b !== '2xx' && counts[b] ? 'font-semibold text-crit-ink' : ''}`}>{fmtNum(counts[b])}</td>
                <td className="px-3 py-1.5 tabular-nums text-muted">{((counts[b] / d.urls.length) * 100).toFixed(1)}%</td>
                <td className="px-3 py-1.5 text-xs">
                  {b === '4xx' && <Link className="text-signal hover:underline" to="/issues?checkId=TECH-4XX">TECH-4XX</Link>}
                  {b === '3xx' && <Link className="text-signal hover:underline" to="/issues?checkId=TECH-REDIRECTS">TECH-REDIRECTS</Link>}
                  {(b === '5xx' || b === 'timeout') && <Link className="text-signal hover:underline" to="/issues?checkId=TECH-5XX">TECH-5XX</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{fmtNum(slow)} URL{slow === 1 ? '' : 's'} responded slower than 3s at server level (PDF §4.2 threshold).</p>
      <Tabs<Bucket | 'all'>
        value={bucket}
        onChange={setBucket}
        items={[{ value: 'all', label: 'All', count: d.urls.length }, ...(Object.keys(counts) as Bucket[]).filter((b) => counts[b]).map((b) => ({ value: b, label: b === 'timeout' ? 'Timeouts' : b, count: counts[b] }))]}
      />
      <DataTable
        rows={rows}
        rowKey={(u) => u.url}
        dense
        caption="Crawled URLs"
        search={(u) => u.url}
        searchPlaceholder="Search URLs"
        initialSort={{ key: 'st', dir: 'desc' }}
        columns={[
          { key: 'u', header: 'URL', cell: (u) => <a href={u.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-signal hover:underline">{shortUrl(u.url)}</a> },
          { key: 'st', header: 'Status', width: '90px', sort: (a, b) => (a.status ?? 999) - (b.status ?? 999), cell: (u) => <Badge tone={bucketOf(u) === '2xx' ? 'ok' : bucketOf(u) === '3xx' ? 'med' : 'crit'}>{u.status ?? 'none'}</Badge> },
          { key: 'ms', header: 'Response', width: '100px', sort: (a, b) => (a.responseMs ?? 0) - (b.responseMs ?? 0), cell: (u) => <span className={`tabular-nums ${(u.responseMs ?? 0) > 3000 ? 'font-semibold text-crit-ink' : ''}`}>{u.error ?? fmtMs(u.responseMs)}</span> },
          { key: 'r', header: 'Why crawled', hideOnMobile: true, cell: (u) => <span className="text-xs text-muted">{u.reason.replace(/_/g, ' ')}</span> },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 4.3
function Canonicals() {
  const { q, allowed } = useConfigQuery();
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
      <Panel title="Shopify product-path canonicalization" subtitle="TECH-SHOPIFY-DUP-PATHS — Critical if broken">
        <div className="space-y-3 text-sm text-ink-soft">
          <p>Shopify serves every product at two paths: the canonical <Mono>/products/{'{handle}'}</Mono> and a collection-scoped <Mono>/collections/{'{collection}'}/products/{'{handle}'}</Mono>. The theme must point the second at the first, otherwise each product competes with itself in every collection it belongs to.</p>
          <Code language="html">{`<!-- on /collections/kitchen/products/steel-bottle -->
<link rel="canonical" href="https://deodap.in/products/steel-bottle">`}</Code>
          <Bullets items={[
            'Collection grids should link straight to /products/{handle} (Liquid: product.url without | within: collection) so crawl budget is not spent on duplicates.',
            'Canonicals must not point to redirects, 404s or noindexed URLs, and must match og:url (TECH-CANONICAL).',
            'Filtered and sorted collection URLs (?sort_by=, ?filter.) canonicalise to the clean collection URL.',
          ]} />
        </div>
      </Panel>
      <Panel title="Host and trailing-slash policy" subtitle="TECH-HOST — only one host resolves 200; every other variant 301s to it">
        {!allowed ? <NoAccess what="Site configuration" perm="settings.view" /> : (
          <Async q={q} rows={4}>
            {(cfg) => <HostPolicy cfg={cfg} />}
          </Async>
        )}
      </Panel>
    </div>
  );
}

function HostPolicy({ cfg }: { cfg: SentinelConfig }) {
  const host = cfg.site.canonicalHost;
  const bare = host.replace(/^www\./, '');
  const variants = [`http://${bare}/`, `http://www.${bare}/`, `https://www.${bare}/`, `https://${bare}/`].filter((v) => v !== `https://${host}/`);
  return (
    <div className="space-y-3 text-sm">
      <KV items={[{ k: 'Canonical host', v: <Mono>https://{host}</Mono> }, { k: 'Base URL', v: <Mono>{cfg.site.baseUrl}</Mono> }]} />
      <div>
        <p className="mb-1 text-xs font-medium text-muted">Expected behaviour</p>
        <ul className="divide-y divide-line rounded-ctl border border-line">
          <li className="flex items-center justify-between gap-2 px-3 py-1.5"><Mono>https://{host}/</Mono><Badge tone="ok">200</Badge></li>
          {variants.map((v) => <li key={v} className="flex items-center justify-between gap-2 px-3 py-1.5"><Mono>{v}</Mono><Badge tone="neutral">301 → https://{host}/</Badge></li>)}
          <li className="flex items-center justify-between gap-2 px-3 py-1.5"><Mono>/products/x/</Mono><Badge tone="neutral">301 → /products/x</Badge></li>
        </ul>
      </div>
      <p className="text-xs text-muted">Shopify paths have no trailing slash. A split (two variants both returning 200) is Critical because link equity and indexing divide between hosts.</p>
    </div>
  );
}

// ---------------------------------------------------------------- 4.5
function Security() {
  const rows: { check: string; id: string; what: ReactNode; needs: string; renderer: boolean }[] = [
    { check: 'HTTPS & certificate', id: 'TECH-HTTPS', what: 'Certificate expiry under 21 days, mixed content (http:// assets on https pages), missing HSTS header.', needs: 'Crawler (TLS handshake + response headers)', renderer: false },
    { check: 'Mobile usability', id: 'TECH-MOBILE', what: 'Viewport meta, tap targets, font size and content wider than the screen — pages are rendered at a 390px viewport.', needs: 'Headless renderer', renderer: true },
    { check: 'JS rendering diff', id: 'TECH-JS-RENDER', what: 'Content or links present in the rendered DOM but missing from raw HTML (menus or product grids injected by apps). Critical when primary content only renders client-side.', needs: 'Crawler + headless renderer', renderer: true },
    { check: 'Pagination', id: 'TECH-PAGINATION', what: '?page=N must be self-canonical and indexable-follow; no canonical-to-page-1; reasonable depth.', needs: 'Crawler', renderer: false },
  ];
  return (
    <Panel title="How these checks run" subtitle="Two of the four checks need a headless browser in addition to the HTTP crawler" bodyClassName="p-0">
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Security, mobile and rendering checks</caption>
          <thead><tr className="border-b border-line bg-raised/70 text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Check</th><th className="px-3 py-2 font-medium">What it looks at</th><th className="px-3 py-2 font-medium">Needs</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="px-4 py-2"><div className="font-medium">{r.check}</div><Link to={`/issues?checkId=${r.id}`} className="font-mono text-2xs text-signal hover:underline">{r.id}</Link></td>
                <td className="px-3 py-2 text-ink-soft">{r.what}</td>
                <td className="px-3 py-2">{r.renderer ? <Badge tone="neutral" title="Not available until the headless renderer is deployed">{r.needs}</Badge> : <span className="text-xs text-muted">{r.needs}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="p-4">
        <Notice tone="demo" title="Headless renderer not available in this build">
          TECH-MOBILE and TECH-JS-RENDER need a headless browser (390px viewport) that runs on the crawler server. Until it is deployed these checks have no live results; any findings shown here are DEMO samples.
        </Notice>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- 4.6
const SCHEMA_ROWS: { template: string; types: string; required: string }[] = [
  { template: 'Product', types: 'Product + Offer', required: 'name, image, offers.price, offers.priceCurrency (INR), offers.availability, aggregateRating (only with visible reviews), brand, sku' },
  { template: 'Product, collection', types: 'BreadcrumbList', required: 'itemListElement with position, name, item — must match the visible breadcrumb' },
  { template: 'Homepage (site-wide)', types: 'Organization', required: 'name, url, logo, sameAs (social profiles), contactPoint, address' },
  { template: 'Homepage', types: 'WebSite + SearchAction', required: 'url, potentialAction.target with {search_term_string}, query-input' },
  { template: 'Collection', types: 'CollectionPage / ItemList', required: 'name, url, itemListElement (product URLs in order)' },
  { template: 'Collection, product (with FAQ block)', types: 'FAQPage', required: 'mainEntity Question + acceptedAnswer — only for FAQs visible on the page' },
  { template: 'Blog article', types: 'Article / BlogPosting', required: 'headline, author (real person), datePublished, dateModified, image, publisher' },
];

function StructuredData() {
  const { q, allowed } = useConfigQuery();
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Panel title="Required schema by template" subtitle="TECH-SCHEMA-PRESENCE (Medium if missing) and TECH-SCHEMA-ERRORS (Critical for errors)" bodyClassName="p-0">
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">Required schema types per template</caption>
            <thead><tr className="border-b border-line bg-raised/70 text-left text-xs text-muted"><th className="px-4 py-2 font-medium">Template</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Fields validated</th></tr></thead>
            <tbody>
              {SCHEMA_ROWS.map((r) => (
                <tr key={r.types} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2">{r.template}</td>
                  <td className="px-3 py-2"><Mono>{r.types}</Mono></td>
                  <td className="px-3 py-2 text-xs text-ink-soft">{r.required}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-muted">Inline validation also checks price in markup against the visible price and flags review markup with no visible reviews (risk of a manual action).</p>
      </Panel>
      <Panel title="Monthly guideline sync" subtitle="TECH-SCHEMA-SYNC — Critical if a type in use is deprecated or a newly required field is missing">
        <div className="space-y-3 text-sm text-ink-soft">
          <p>Once a month Sentinel reads Google's structured-data documentation changelog and Search Central announcements, diffs them against DeoDap's live markup and flags:</p>
          <Bullets items={['Newly deprecated types or rich results (as happened to FAQ and HowTo)', 'Newly required or recommended fields on types in use (Product, Offer, Organization…)', 'Property renames and format changes']} />
          <p>Each change becomes a Fix Card with the exact Liquid/JSON-LD update.</p>
          {!allowed ? <NoAccess what="Automation settings" perm="settings.view" /> : (
            <Async q={q} rows={2}>
              {(cfg) => (
                <Notice tone={cfg.automation.autoApplySchemaUpdates ? 'med' : 'neutral'} title={`Auto-apply schema updates: ${cfg.automation.autoApplySchemaUpdates ? 'on' : 'off'}`}>
                  {cfg.automation.autoApplySchemaUpdates
                    ? 'Opted in (PDF §17): approved schema changes may be applied by the tool, followed by a GSC re-validation request. A human still approves each change first.'
                    : 'Off by default (PDF §17). Every schema update is a proposal that a person reviews and applies; Sentinel does not change the live theme.'}
                  {' '}<Link to="/settings/thresholds" className="text-signal hover:underline">Settings</Link>
                </Notice>
              )}
            </Async>
          )}
          <p className="text-xs text-muted">Needs the Google documentation feed; until it is connected the sync shows no live results.</p>
        </div>
      </Panel>
    </div>
  );
}
