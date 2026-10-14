/**
 * Multi-website workspaces. Each website gets its own composition root (its own temporary in-memory repositories for issues,
 * Fix Cards, crawls, reports, settings and integration configuration, plus its own crawler pointed at that website).
 * People, credentials, sessions and the permission matrix are shared, so one sign-in works across websites.
 *
 * Every request is bound to exactly one website (X-Website-Id header; absent = the primary website) through
 * AsyncLocalStorage, so a handler can never read or write another website's data. Storage is TEMPORARY: websites added
 * here, and all their data, are lost when the API restarts. No database.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEMO_WEBSITE_ID, computeHealthScore, defaultConfig, normalizeDomain, siteHasAuditData, validateWebsiteInput,
  type Website, type WebsiteInput, type WebsiteSummary,
} from '@sentinel/shared';
import { createContainer, type Container } from './container';
import { createInMemoryRepositories } from './repositories/memory/inMemory';
import type { Repositories } from './repositories/types';
import { badRequest, notFound } from './lib/errors';
import { audit, need, type Actor } from './services/context';

export function createWorkspaces(primary: Container) {
  const als = new AsyncLocalStorage<Container>();
  const containers = new Map<string, Container>([[DEMO_WEBSITE_ID, primary]]);
  const websites: Website[] = [];
  let ready: Promise<void> | undefined;

  /** The primary website mirrors the server's configured site (DEMO deodap.in, or CRAWLER_BASE_URL on a clean start). */
  function init() {
    ready ??= (async () => {
      const cfg = await primary.repos.config.get();
      const demo = (await primary.repos.issues.list()).some((i) => i.source === 'demo');
      const url = cfg.site.baseUrl.replace(/\/$/, '');
      const at = primary.clock().toISOString();
      websites.push({
        id: DEMO_WEBSITE_ID, name: cfg.site.brand, url: `${url}/`, domain: normalizeDomain(url), platform: 'shopify',
        sitemapUrl: `${url}/sitemap.xml`, createdAt: at, updatedAt: at, createdByName: demo ? 'Sentinel (DEMO seed)' : 'Server configuration', source: demo ? 'demo' : 'live',
      });
    })();
    return ready;
  }

  /** Repositories for a new website: empty site data, shared people/auth/permissions. */
  function siteRepos(w: Website): Repositories {
    const now = primary.clock();
    const repos = createInMemoryRepositories(now);
    const p = primary.repos;
    Object.assign(repos, { employees: p.employees, credentials: p.credentials, resetTokens: p.resetTokens, sessions: p.sessions, permissions: p.permissions });
    const cfg = defaultConfig(now);
    cfg.site = { ...cfg.site, baseUrl: w.url.replace(/\/$/, ''), canonicalHost: w.domain, brand: w.name };
    cfg.competitors = [];
    void repos.config.set(cfg);
    // Schedules exist but start disabled: nothing is crawled until someone turns a schedule on or starts a crawl.
    void repos.schedules.insert({ id: 'SCH-smart', type: 'smart', cron: '0 2 * * *', description: 'Daily smart crawl', enabled: false, timezone: 'Asia/Kolkata' });
    void repos.schedules.insert({ id: 'SCH-full', type: 'full', cron: '0 3 * * 0', description: 'Weekly full crawl', enabled: false, timezone: 'Asia/Kolkata' });
    return repos;
  }

  const stopPrimary = primary.scheduler.stop.bind(primary.scheduler);
  primary.scheduler.stop = () => { stopPrimary(); for (const c of containers.values()) if (c !== primary) c.scheduler.stop(); };

  return {
    als,
    primary,
    /** The container a request runs against; undefined for an unknown website id. */
    resolve(id: string | undefined): Container | undefined { return id ? containers.get(id) : primary; },
    /** Container for the current request (falls back to the primary website outside a request). */
    current(): Container { return als.getStore() ?? primary; },

    async list(actor: Actor): Promise<WebsiteSummary[]> {
      await init();
      await need(primary.ctx, actor, 'dashboard.view');
      return Promise.all(websites.map(async (w) => {
        const c = containers.get(w.id)!;
        const [issues, crawls, cfg, integrations] = await Promise.all([c.repos.issues.list(), c.repos.crawls.list(), c.repos.config.get(), c.ctx.integrations.list()]);
        const has = siteHasAuditData({ issues, crawls });
        const open = { critical: 0, medium: 0, low: 0 };
        for (const i of issues) if (!i.supersededById && !['VERIFIED', 'CLOSED', 'NOT_AN_ISSUE', 'SUPERSEDED'].includes(i.status)) open[i.severity] += 1;
        const last = [...crawls].sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '')).reverse().find((x) => x.status === 'completed');
        const siteSize = (await c.repos.metrics.get()).siteSize;
        const usable = integrations.filter((i) => i.category !== 'tasks');
        return {
          ...w, hasAuditData: has, lastCrawlAt: last?.finishedAt, lastCrawlSource: last?.source,
          healthScore: has ? computeHealthScore(issues, siteSize, cfg, c.clock()).score : undefined,
          openIssues: open, integrationsConnected: usable.filter((i) => i.state === 'connected').length, integrationsTotal: usable.length,
        };
      }));
    },

    async create(actor: Actor, input: WebsiteInput): Promise<Website> {
      await init();
      await need(primary.ctx, actor, 'websites.manage');
      const v = validateWebsiteInput(input, websites);
      const at = primary.clock().toISOString();
      const w: Website = { id: `site-${v.domain.replace(/[^a-z0-9]+/g, '-')}`, ...v, createdAt: at, updatedAt: at, createdByName: actor.name, source: 'manual' };
      const c = await createContainer({
        env: { ...primary.env, CRAWLER_BASE_URL: w.url.replace(/\/$/, ''), SEED_DEMO_DATA: false },
        repos: siteRepos(w), log: primary.log, clock: primary.clock, fetchImpl: primary.fetchImpl, diagnostics: primary.diagnostics,
      });
      containers.set(w.id, c);
      websites.push(w);
      if (primary.env.SCHEDULER_ENABLED) c.scheduler.start();
      await audit(c.ctx, actor, 'website.create', 'config', w.id, `Added website ${w.name} (${w.domain}) — not crawled yet`);
      return w;
    },

    async update(actor: Actor, id: string, input: WebsiteInput): Promise<Website> {
      await init();
      await need(primary.ctx, actor, 'websites.manage');
      const w = websites.find((x) => x.id === id);
      if (!w) throw notFound(`Website ${id}`);
      const v = validateWebsiteInput(input, websites, id);
      if (v.domain !== w.domain && id === DEMO_WEBSITE_ID) throw badRequest('The primary website domain comes from server configuration (CRAWLER_BASE_URL) and cannot be changed here.');
      const c = containers.get(id)!;
      if (v.domain !== w.domain) throw badRequest('Changing a website’s domain is not supported — add a new website instead.');
      Object.assign(w, v, { updatedAt: primary.clock().toISOString() });
      const cfg = await c.repos.config.get();
      await c.repos.config.set({ ...cfg, site: { ...cfg.site, baseUrl: w.url.replace(/\/$/, ''), canonicalHost: w.domain, brand: w.name } });
      await audit(c.ctx, actor, 'website.update', 'config', w.id, `Updated website ${w.name}`);
      return w;
    },
  };
}
export type Workspaces = ReturnType<typeof createWorkspaces>;
