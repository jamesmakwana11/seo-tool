import { ApiError, WEBSITE_HEADER, setPriorityConfig, type CrawlBatchInput, type WebsiteInput } from '@sentinel/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from '../lib/passwords';
import type { Container } from '../container';
import { verifyShopifyWebhook } from '../connectors';
import type { Actor } from '../services/context';
import { registerRoutes, type ApiRoute } from './routes';
import { createWorkspaces } from '../websites';
import { createBatchService } from '../batches';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { requestId: string; actor?: Actor; token?: string }
  }
}

/** Consistent error body: { error: { code, message, details }, requestId }. */
function sendError(res: Response, req: Request, err: unknown) {
  // Client errors raised by Express middleware (malformed JSON, payload too large…) keep their 4xx status without internals.
  const status = (err as { status?: unknown })?.status;
  const clientErr = !(err instanceof ApiError) && typeof status === 'number' && status >= 400 && status < 500;
  const e = err instanceof ApiError ? err
    : clientErr ? new ApiError(status, status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', status === 413 ? 'The request body is too large.' : 'The request could not be read. Check that it is valid JSON.')
      : new ApiError(500, 'INTERNAL', 'Something went wrong on the server.');
  if (clientErr) {
    res.status(e.status).json({ error: { code: e.code, message: e.message }, requestId: req.requestId });
    return;
  }
  if (!(err instanceof ApiError)) req.app.locals.log?.error({ err: (err as Error).message, stack: (err as Error).stack, requestId: req.requestId }, 'unhandled error');
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details }, requestId: req.requestId });
}

/**
 * The path this app is served under, from APP_BASE_URL (e.g. https://apps.deodap.info/seo-tool → "/seo-tool"); "" when it
 * is served at the root. Requests under it are accepted whether or not the reverse proxy strips it.
 */
import { basePaths, pathOfUrl } from './basePath';

export function publicBasePath(env: Pick<Container['env'], 'APP_BASE_URL'>): string {
  return pathOfUrl(env.APP_BASE_URL);
}

/** The web app's index.html for this base path: <base href> for its relative assets and the path for the router / API. */
export function indexHtmlFor(html: string, basePath: string): string {
  const esc = basePath.replace(/[&"<>]/g, '');
  const tags = `<base href="${esc}/"><meta name="sentinel-base-path" content="${esc}">`;
  const without = html.replace(/<base\s+href="[^"]*"\s*\/?>/i, '');
  return /<head[^>]*>/i.test(without) ? without.replace(/<head([^>]*)>/i, `<head$1>${tags}`) : `${tags}${without}`;
}

export function createApp(container: Container) {
  const { services, env, log, clock } = container;
  const ws = createWorkspaces(container);
  const batches = createBatchService(ws);
  // Route handlers see the CURRENT REQUEST's website: services and ctx resolve through AsyncLocalStorage per call.
  const scopedService = (name: keyof Container['services']) => new Proxy({}, {
    get: (_t, k) => {
      const s = ws.current().services[name] as unknown as Record<PropertyKey, unknown>;
      const v = s[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(s) : v;
    },
  });
  const scopedServices = Object.fromEntries(Object.keys(services).map((n) => [n, scopedService(n as keyof Container['services'])])) as Container['services'];
  const scoped = new Proxy(container, { get: (t, k) => (k === 'services' ? scopedServices : (ws.current() as unknown as Record<PropertyKey, unknown>)[k] ?? (t as unknown as Record<PropertyKey, unknown>)[k]) }) as Container;
  const app = express();
  app.locals.log = log;
  app.disable('x-powered-by');
  // Served under a sub-path (APP_BASE_URL=https://apps.deodap.info/seo-tool): accept /seo-tool/… as well as the
  // stripped path a reverse proxy may forward, so /seo-tool/api/shopify/oauth/callback reaches the callback route.
  // Known sub-paths: APP_BASE_URL's, plus the app URL entered with the Shopify app credentials (loaded at start-up).
  app.use((req, _res, next) => {
    for (const basePath of basePaths(env.APP_BASE_URL)) {
      if (req.url === basePath || req.url.startsWith(`${basePath}/`) || req.url.startsWith(`${basePath}?`)) {
        const rest = req.url.slice(basePath.length);
        req.url = rest.startsWith('/') ? rest : `/${rest}`;
        break;
      }
    }
    next();
  });
  const prod = env.NODE_ENV === 'production';
  if (env.TRUST_PROXY !== undefined) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY);
  else if (prod) app.set('trust proxy', 1);

  // Security headers on every response (API and the served web app).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (prod) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Liveness probe for the hosting platform: no website binding, no auth, no internals.
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Brute-force protection for unauthenticated auth endpoints: fixed 15-minute window per client IP (in memory, single instance).
  const authHits = new Map<string, { n: number; reset: number }>();
  const AUTH_WINDOW_MS = 15 * 60_000;
  app.use(/^\/api\/auth\/(login|preview|request-reset|reset)$/, (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let hit = authHits.get(key);
    if (!hit || hit.reset <= now) { hit = { n: 0, reset: now + AUTH_WINDOW_MS }; authHits.set(key, hit); }
    hit.n += 1;
    if (authHits.size > 10_000) for (const [k, v] of authHits) if (v.reset <= now) authHits.delete(k);
    if (hit.n > env.AUTH_RATE_LIMIT) {
      res.setHeader('Retry-After', String(Math.ceil((hit.reset - now) / 1000)));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a few minutes and try again.' } });
    }
    next();
  });

  // Shopify webhook needs the raw body for HMAC verification — register before the JSON parser.
  app.post('/api/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), async (req: Request, res: Response) => {
    req.requestId = randomToken(8);
    const raw = req.body as Buffer;
    const hmac = req.header('X-Shopify-Hmac-Sha256');
    if (!env.SHOPIFY_WEBHOOK_SECRET || !hmac || !verifyShopifyWebhook(raw, hmac, env.SHOPIFY_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed.' }, requestId: req.requestId });
    }
    try {
      const topic = req.header('X-Shopify-Topic') ?? '';
      const payload = JSON.parse(raw.toString('utf8')) as { handle?: string };
      const domain = env.SHOPIFY_STORE_DOMAIN ?? new URL(env.CRAWLER_BASE_URL ?? 'https://deodap.in').host;
      const urls: string[] = [];
      if (payload.handle && /product/.test(topic)) urls.push(`https://${domain}/products/${payload.handle}`);
      if (payload.handle && /collection/.test(topic)) urls.push(`https://${domain}/collections/${payload.handle}`);
      if (urls.length) await services.crawls.markChanged(urls);
      log.info({ topic, urls, requestId: req.requestId }, 'shopify webhook');
      res.status(202).json({ received: true, queued: urls.length });
    } catch (e) {
      sendError(res, req, e);
    }
  });

  app.use(express.json({ limit: '2mb' }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.requestId = req.header('X-Request-Id') ?? randomToken(8);
    const t0 = Date.now();
    const done = () => {
      const ms = Date.now() - t0;
      container.recent.unshift({ at: clock().toISOString(), method: req.method, path: req.path, status: _res.statusCode, ms, requestId: req.requestId });
      container.recent.length = Math.min(container.recent.length, 100);
      // Structured access log: path only (no query string, headers or body), so tokens and personal data never reach the logs.
      if (req.path.startsWith('/api/')) log.info({ method: req.method, path: req.path, status: _res.statusCode, ms, requestId: req.requestId }, 'request');
    };
    _res.on('finish', done);
    next();
  });
  if (env.CORS_ORIGIN) {
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', env.CORS_ORIGIN!);
      res.header('Access-Control-Allow-Headers', `Content-Type, Authorization, X-Request-Id, ${WEBSITE_HEADER}`);
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    const db = container.persistence?.status();
    // No database name, host or error text here (public endpoint): System health shows the details to admins.
    res.json({ ok: !db || db.connected, storage: { kind: container.repos.storage.kind, persistent: container.repos.storage.persistent, ...(db ? { connected: db.connected, pendingWrites: db.pending } : {}) }, crawler: container.ctx.engine.readiness() });
  });

  const bearer = (req: Request) => {
    const h = req.header('Authorization');
    return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
  };

  // The built web app (same origin as the API, so no CORS and no API URL baked into the bundle).
  if (env.WEB_DIST_DIR) {
    const dist = path.resolve(env.WEB_DIST_DIR);
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) throw new Error(`WEB_DIST_DIR has no index.html: ${dist}`);
    let cached: { mtime: number; basePath: string; html: string } | undefined;
    const indexHtml = () => {
      const mtime = fs.statSync(index).mtimeMs;
      const basePath = publicBasePath(env) || basePaths(undefined)[0] || '';
      if (!cached || cached.mtime !== mtime || cached.basePath !== basePath) cached = { mtime, basePath, html: indexHtmlFor(fs.readFileSync(index, 'utf8'), basePath) };
      return cached.html;
    };
    // Hashed bundles are immutable; everything else revalidates.
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    // SPA fallback: any non-API page GET gets index.html; client-side routing takes over. Missing files (paths with an
    // extension, or under /assets) fall through to a 404 instead of returning HTML in place of a script.
    app.get(/^(?!\/api\/|\/api$|\/healthz$).*/, (req, res, next) => {
      if (req.path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(req.path) || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(indexHtml());
    });
  }

  // Every saved website is loaded (from the database) before any API request is served.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    ws.ready().then(() => next(), (e: Error) => sendError(res, req, new ApiError(503, 'STARTING', `The websites could not be loaded: ${e.message}`)));
  });

  // Bind the request to one website. Unknown website ids are refused rather than silently served another site's data.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = req.header(WEBSITE_HEADER) || undefined;
    const c = ws.resolve(id);
    if (!c) {
      if (/^\/api\/(websites|auth|crawl-batches)(\/|$)/.test(req.path)) return ws.als.run(container, () => next());
      return sendError(res, req, new ApiError(404, 'WEBSITE_NOT_FOUND', container.persistence ? 'The selected website does not exist on this server. Choose another website.' : 'The selected website does not exist on this server (without a database, websites are kept in temporary memory and are lost on restart). Choose another website.'));
    }
    ws.als.run(c, () => {
      void c.repos.config.get().then((cfg) => { setPriorityConfig(cfg); next(); }, next);
    });
  });

  const routes: ApiRoute[] = [];
  registerRoutes(routes, scoped);
  routes.push(
    { method: 'get', path: '/api/websites', permission: 'dashboard.view', description: 'Websites and what is known about each', handle: (req) => ws.list(req.actor!) },
    { method: 'post', path: '/api/websites', permission: 'websites.manage', description: 'Add a website (starts empty)', status: 201, handle: (req) => ws.create(req.actor!, (req.body ?? {}) as WebsiteInput) },
    { method: 'patch', path: '/api/websites/:id', permission: 'websites.manage', description: 'Edit a website', handle: (req) => ws.update(req.actor!, String(req.params.id), (req.body ?? {}) as WebsiteInput) },
    // Multi-website crawl batches (up to MAX_BATCH_WEBSITES websites, one crawl job each; see batches.ts).
    { method: 'get', path: '/api/crawl-batches', permission: 'crawls.view', description: 'Recent multi-website crawl batches with each website\'s crawl', handle: (req) => batches.list(req.actor!) },
    { method: 'post', path: '/api/crawl-batches', permission: 'crawls.run', description: 'Start crawls of up to 11 websites (body: websiteIds, type smart|full, maxPages); queued server-wide', handle: (req) => batches.start(req.actor!, (req.body ?? {}) as CrawlBatchInput) },
    { method: 'get', path: '/api/crawl-batches/:id', permission: 'crawls.view', description: 'One crawl batch: every website\'s crawl status, progress and queue position', handle: (req) => batches.get(req.actor!, String(req.params.id)) },
    { method: 'post', path: '/api/crawl-batches/:id/cancel', permission: 'crawls.run', description: 'Cancel every crawl of the batch still queued or running', handle: (req) => batches.cancelAll(req.actor!, String(req.params.id)) },
    { method: 'post', path: '/api/crawl-batches/:id/jobs/:websiteId/cancel', permission: 'crawls.run', description: 'Cancel one website\'s crawl of the batch (the others continue)', handle: (req) => batches.cancelJob(req.actor!, String(req.params.id), String(req.params.websiteId)) },
  );
  app.locals.ready = ws.ready;
  app.locals.workspaces = ws;
  container.diagnostics.endpoints.push(...routes.map((r) => ({ method: r.method.toUpperCase(), path: r.path, permission: r.permission, description: r.description })));

  for (const route of routes) {
    const handler = async (req: Request, res: Response) => {
      try {
        if (!route.public) {
          const token = bearer(req);
          const { actor } = await services.auth.authenticate(token);
          req.actor = actor;
          req.token = token;
        }
        const result = await route.handle(req);
        if (route.raw) return; // handler already responded
        // A change is answered only once it is stored (DATABASE_URL); a database that cannot be written answers 503.
        if (route.method !== 'get' && container.persistence) await container.persistence.flush();
        res.status(route.status ?? 200).json(result ?? { ok: true });
      } catch (e) {
        sendError(res, req, e);
      }
    };
    const m = route.method;
    app[m](route.path, handler);
  }

  app.use((req: Request, res: Response) => sendError(res, req, new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}.`)));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => sendError(res, req, err));
  return app;
}
