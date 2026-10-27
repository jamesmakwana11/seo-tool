/**
 * Multi-website workspaces. Each website gets its own composition root (its own repositories for issues, Fix Cards,
 * crawls, reports, settings and integration configuration, plus its own crawler pointed at that website). People,
 * credentials, sessions and the permission matrix are shared, so one sign-in works across websites.
 *
 * Every request is bound to exactly one website (X-Website-Id header; absent = the primary website) through
 * AsyncLocalStorage, so a handler can never read or write another website's data.
 *
 * Storage: with DATABASE_URL every website (stable id, domain, settings) is a row in sentinel_websites and all its data
 * is stored under its id; on start-up every saved website is opened again with its data. Without a database, websites
 * added here are kept in memory only and are lost when the API restarts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEMO_WEBSITE_ID, computeHealthScore, defaultConfig, normalizeDomain, siteHasAuditData, validateWebsiteInput,
  type Website, type WebsiteInput, type WebsiteSummary,
} from '@sentinel/shared';
import { WEBSITE_PLATFORMS } from '@sentinel/shared';
import { createContainer, type Container } from './container';
import { createInMemoryRepositories } from './repositories/memory/inMemory';
import type { Repositories } from './repositories/types';
import { badRequest, notFound } from './lib/errors';
import { audit, need, type Actor } from './services/context';
import { registrationBlockReason } from './crawler/netguard';

/** SEED_WEBSITES entries: "Name|https://url/|platform" (name and platform optional), comma- or newline-separated. */
export function parseSeedWebsites(raw: string | undefined): WebsiteInput[] {
  if (!raw || raw.trim().toLowerCase() === 'none') return [];
  return raw.split(/[,\n]/).map((e) => e.trim()).filter(Boolean).map((e) => {
    const parts = e.split('|').map((x) => x.trim());
    const url = parts.find((p) => /^https?:\/\//i.test(p)) ?? parts[0];
    const name = parts[0] !== url ? parts[0] : new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    const platform = (WEBSITE_PLATFORMS.find((p) => p.id === parts[parts.indexOf(url) + 1])?.id ?? 'shopify') as WebsiteInput['platform'];
    return { name, url, platform };
  });
}

export function createWorkspaces(primary: Container) {
  const als = new AsyncLocalStorage<Container>();
  const containers = new Map<string, Container>([[DEMO_WEBSITE_ID, primary]]);
  const websites: Website[] = [];
  let ready: Promise<void> | undefined;
  const db = primary.persistence;
  /** Loopback test sites only outside production; private, link-local and metadata addresses never. */
  const netPolicy = { allowLoopback: primary.env.NODE_ENV !== 'production' };

  /**
   * A registered website is what authorizes crawling its host, so its address is checked before it is added: no internal
   * or private address, no credentials. (Each request is checked again at crawl time, including DNS answers.)
   */
  function assertCrawlable(raw: string | undefined, normalized: string) {
    let given: URL | undefined;
    try { given = raw ? new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`) : undefined; } catch { /* validateWebsiteInput reports it */ }
    const why = given && (given.username || given.password) ? 'URLs with a user name or password are not accepted' : registrationBlockReason(normalized, netPolicy);
    if (why) throw badRequest(`This website cannot be added for crawling: ${why}. Enter the public address of the website, e.g. https://example.com/.`);
  }

  /**
   * The primary website mirrors the server's configured site (DEMO deodap.in, or CRAWLER_BASE_URL on a clean start).
   * With a database, every other saved website is opened again with its own stored data.
   */
  function init() {
    ready ??= (async () => {
      const saved = db ? await db.listWebsites<Website>() : [];
      const cfg = await primary.repos.config.get();
      const demo = (await primary.repos.issues.list()).some((i) => i.source === 'demo');
      const url = cfg.site.baseUrl.replace(/\/$/, '');
      const at = primary.clock().toISOString();
      const before = saved.find((w) => w.id === DEMO_WEBSITE_ID);
      const main: Website = {
        id: DEMO_WEBSITE_ID, name: cfg.site.brand, url: `${url}/`, domain: normalizeDomain(url), platform: before?.platform ?? 'shopify',
        sitemapUrl: before?.sitemapUrl ?? `${url}/sitemap.xml`, createdAt: before?.createdAt ?? at, updatedAt: before?.updatedAt ?? at,
        createdByName: demo ? 'Sentinel (DEMO seed)' : before?.createdByName ?? 'Server configuration', source: demo ? 'demo' : 'live',
      };
      websites.push(main);
      if (db) await db.saveWebsite(main);
      for (const w of saved) {
        if (w.id === DEMO_WEBSITE_ID || containers.has(w.id)) continue;
        const c = await openSite(w, false);
        containers.set(w.id, c);
        websites.push(w);
        if (primary.env.SCHEDULER_ENABLED) c.scheduler.start();
      }
      if (saved.length) primary.log.info({ websites: websites.length }, 'websites loaded from the database');
      // Recommendations follow each website's platform (Manage websites): keep it in the website's settings.
      for (const w of websites) await syncSiteSettings(containers.get(w.id)!, w);
      await seedWebsites();
      // Shopify app credentials / tokens entered in the app (encrypted): decrypted into memory, app URL sub-path known.
      for (const w of websites) await containers.get(w.id)!.services.shopify.restore().catch((e: Error) => primary.log.warn({ website: w.id, err: e.message }, 'Shopify credentials could not be loaded'));
    })();
    return ready;
  }

  /** The website's name and platform in its settings (brand and platform used by Fix Cards). Only writes when they differ. */
  async function syncSiteSettings(c: Container, w: Website) {
    const cfg = await c.repos.config.get();
    const brand = w.id === DEMO_WEBSITE_ID ? cfg.site.brand : w.name;
    if (cfg.site.platform !== w.platform || cfg.site.brand !== brand) await c.repos.config.set({ ...cfg, site: { ...cfg.site, platform: w.platform, brand } });
  }

  /**
   * SEED_WEBSITES: websites that must always be selectable. Each one missing (by domain) is added like a website added
   * by a person — stored with DATABASE_URL — and never changed or removed afterwards.
   */
  async function seedWebsites() {
    for (const input of parseSeedWebsites(primary.env.SEED_WEBSITES)) {
      let v: ReturnType<typeof validateWebsiteInput>;
      try { v = validateWebsiteInput(input, websites); assertCrawlable(input.url, v.url); } catch (e) {
        if ((e as { code?: string }).code !== 'DUPLICATE_DOMAIN') primary.log.warn({ url: input.url, err: (e as Error).message }, 'SEED_WEBSITES entry skipped');
        continue;
      }
      const at = primary.clock().toISOString();
      const w: Website = { id: `site-${v.domain.replace(/[^a-z0-9]+/g, '-')}`, ...v, createdAt: at, updatedAt: at, createdByName: 'Server configuration (SEED_WEBSITES)', source: 'manual' };
      if (containers.has(w.id)) continue;
      const c = await openSite(w, true);
      if (db) { await db.flush(); await db.saveWebsite(w); }
      containers.set(w.id, c);
      websites.push(w);
      if (primary.env.SCHEDULER_ENABLED) c.scheduler.start();
      primary.log.info({ website: w.domain }, 'website added from SEED_WEBSITES');
    }
  }

  /** A website's container: its own (stored) data, shared people / sign-in / permissions, its own crawler. */
  async function openSite(w: Website, isNew: boolean): Promise<Container> {
    const now = primary.clock();
    const repos: Repositories = db ? await db.repositories(w.id, now, { shared: false }) : createInMemoryRepositories(now);
    const p = primary.repos;
    Object.assign(repos, { employees: p.employees, credentials: p.credentials, resetTokens: p.resetTokens, sessions: p.sessions, permissions: p.permissions });
    if (isNew) {
      const cfg = defaultConfig(now);
      cfg.site = { ...cfg.site, baseUrl: w.url.replace(/\/$/, ''), canonicalHost: w.domain, brand: w.name, platform: w.platform };
      cfg.competitors = [];
      await repos.config.set(cfg);
      // Schedules exist but start disabled: nothing is crawled until someone turns a schedule on or starts a crawl.
      await repos.schedules.insert({ id: 'SCH-smart', type: 'smart', cron: '0 2 * * *', description: 'Daily smart crawl', enabled: false, timezone: 'Asia/Kolkata' });
      await repos.schedules.insert({ id: 'SCH-full', type: 'full', cron: '0 3 * * 0', description: 'Weekly full crawl', enabled: false, timezone: 'Asia/Kolkata' });
    }
    return createContainer({
      env: { ...primary.env, CRAWLER_BASE_URL: w.url.replace(/\/$/, ''), SEED_DEMO_DATA: false },
      repos, log: primary.log, clock: primary.clock, fetchImpl: primary.fetchImpl, diagnostics: primary.diagnostics,
      persistence: db, scope: w.id,
    });
  }

  const stopPrimary = primary.scheduler.stop.bind(primary.scheduler);
  primary.scheduler.stop = () => { stopPrimary(); for (const c of containers.values()) if (c !== primary) c.scheduler.stop(); };

  return {
    als,
    primary,
    /** Resolves when every saved website is loaded (requests wait for it). */
    ready: init,
    /** The container a request runs against; undefined for an unknown website id. */
    resolve(id: string | undefined): Container | undefined { return id ? containers.get(id) : primary; },
    /** Every website with its container (in the order they were added). */
    entries(): { website: Website; container: Container }[] { return websites.map((w) => ({ website: w, container: containers.get(w.id)! })); },
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
      assertCrawlable(input?.url, v.url);
      const at = primary.clock().toISOString();
      const w: Website = { id: `site-${v.domain.replace(/[^a-z0-9]+/g, '-')}`, ...v, createdAt: at, updatedAt: at, createdByName: actor.name, source: 'manual' };
      const c = await openSite(w, true);
      // Stored before it is listed: its settings first, then the website row — one that could not be stored is not added.
      if (db) { await db.flush(); await db.saveWebsite(w); }
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
      if (id !== DEMO_WEBSITE_ID) assertCrawlable(input?.url, v.url);
      if (v.domain !== w.domain && id === DEMO_WEBSITE_ID) throw badRequest('The primary website domain comes from server configuration (CRAWLER_BASE_URL) and cannot be changed here.');
      const c = containers.get(id)!;
      if (v.domain !== w.domain) throw badRequest('Changing a website’s domain is not supported — add a new website instead.');
      Object.assign(w, v, { updatedAt: primary.clock().toISOString() });
      if (db) await db.saveWebsite(w);
      const cfg = await c.repos.config.get();
      await c.repos.config.set({ ...cfg, site: { ...cfg.site, baseUrl: w.url.replace(/\/$/, ''), canonicalHost: w.domain, brand: w.name, platform: w.platform } });
      await audit(c.ctx, actor, 'website.update', 'config', w.id, `Updated website ${w.name}`);
      return w;
    },
  };
}
export type Workspaces = ReturnType<typeof createWorkspaces>;
