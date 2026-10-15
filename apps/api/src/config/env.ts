import { z } from 'zod';

/**
 * Runtime environment. Secrets are read from process.env only (never hard-coded, never sent to the
 * browser, never logged). See apps/api/.env.example for every variable.
 */
const bool = (def: boolean) => z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** HMAC secret for session tokens. Required in production; a random per-process secret is generated otherwise. */
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
  /** Load the deterministic DEMO seed into the in-memory repositories on start (development default). */
  SEED_DEMO_DATA: bool(true),
  /** DEVELOPMENT ONLY: allow /auth/preview role switching with mock users. Refused when NODE_ENV=production. */
  ALLOW_DEV_ROLE_PREVIEW: bool(true),
  /** DEVELOPMENT ONLY: return the password-reset token in the API response when no email adapter is configured. */
  DEV_EXPOSE_RESET_TOKEN: bool(true),
  /** Run the in-process scheduler (crawls, nightly escalations, 08:00 IST digest). */
  SCHEDULER_ENABLED: bool(false),
  CORS_ORIGIN: z.string().optional(),

  // Production hosting
  /**
   * The only storage implementation is TEMPORARY in-memory (no database has been authorized). In production the server
   * refuses to start unless this is explicitly true, so nobody deploys it believing data is persisted.
   */
  ALLOW_EPHEMERAL_STORAGE: bool(false),
  /** First admin account, created on a clean start when no employees exist. The password is read once, hashed, never logged. */
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_NAME: z.string().min(2).optional(),
  ADMIN_INITIAL_PASSWORD: z.string().optional(),
  /** Directory with the built web app (apps/web/dist). When set, the API also serves the SPA from the same origin. */
  WEB_DIST_DIR: z.string().optional(),
  /** Express "trust proxy" — hops in front of the app (1 behind a single platform load balancer). */
  TRUST_PROXY: z.string().optional(),
  /** Sign-in / password-reset attempts allowed per client IP per 15 minutes. */
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(20),

  // Crawler
  /**
   * The primary website — the only host the primary workspace's crawler may request (a security boundary, not just a
   * default). Must be an http(s) URL such as https://deodap.in, without credentials. Websites added under Manage
   * websites get their own crawler bound to their own URL.
   */
  CRAWLER_BASE_URL: z.string().trim().url().refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }).optional(),
  CRAWLER_USER_AGENT: z.string().optional(),
  /** Must be explicitly true before the crawler sends requests to a live site. */
  CRAWLER_ALLOW_LIVE: bool(false),
  /**
   * OPTIONAL server-wide page cap. Unset (the default) = no cap: a crawl can fetch every page the site has. Set it only
   * to protect a small server; the Crawl Center then refuses crawls above it.
   */
  CRAWLER_MAX_PAGES: z.coerce.number().int().positive().optional(),
  /** Minimum gap between requests to the crawled site, per crawl (politeness throttle). */
  CRAWLER_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(250),
  /** Largest response body read per request; bigger pages are truncated (bytes). */
  CRAWLER_MAX_BODY_BYTES: z.coerce.number().int().min(65536).max(20 * 1024 * 1024).default(5 * 1024 * 1024),
  /** Retries per request after a transient failure (429 / 502 / 503 / 504, timeout, dropped connection). */
  CRAWLER_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** Longest Retry-After / backoff wait per retry; a site asking for longer gets its answer recorded instead. */
  CRAWLER_MAX_RETRY_WAIT_MS: z.coerce.number().int().min(0).max(300000).default(30000),
  /** Highest robots.txt Crawl-delay honoured (ms). */
  CRAWLER_MAX_CRAWL_DELAY_MS: z.coerce.number().int().min(0).max(300000).default(30000),
  /** Most sitemap files read per crawl (sitemap index files included). */
  CRAWLER_MAX_SITEMAP_FILES: z.coerce.number().int().min(1).max(50000).default(1000),
  /** Largest sitemap file read, after decompression (MB). The sitemaps.org limit is 50 MB. */
  CRAWLER_MAX_SITEMAP_MB: z.coerce.number().int().min(1).max(200).default(50),
  /** Crawls that may run at the same time across all websites on this server. */
  CRAWLER_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(10).default(2),
  /** Public URL of the web app, used for deep links in alerts/Task Ops. */
  APP_BASE_URL: z.string().url().optional(),

  // Connectors (names only documented; values never logged)
  GSC_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GSC_PROPERTY: z.string().optional(),
  GA4_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GA4_PROPERTY_ID: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  BACKLINK_PROVIDER: z.enum(['ahrefs', 'semrush']).optional(),
  AHREFS_API_TOKEN: z.string().optional(),
  SEMRUSH_API_KEY: z.string().optional(),
  SHOPIFY_STORE_DOMAIN: z.string().optional(),
  SHOPIFY_ADMIN_TOKEN: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default('2024-10'),
  GBP_OAUTH_CLIENT_ID: z.string().optional(),
  GBP_OAUTH_CLIENT_SECRET: z.string().optional(),
  GBP_OAUTH_REFRESH_TOKEN: z.string().optional(),
  GBP_LOCATION_ID: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  GEMINI_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),

  // Delivery adapters
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  DIGEST_RECIPIENTS: z.string().optional(),
  WHATSAPP_API_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_RECIPIENTS: z.string().optional(),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  TASK_OPS_BASE_URL: z.string().url().optional(),
  TASK_OPS_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

/** How to fix a missing primary website (shown at start-up, in the Crawl Center and by the crawl API). */
export const CRAWLER_BASE_URL_MISSING =
  'CRAWLER_BASE_URL is not set on the API server, so live crawling has no allowed website. Set it to the primary website ' +
  '(for example CRAWLER_BASE_URL=https://deodap.in) in the API server environment — apps/api/.env when running locally, ' +
  'or the service\'s Environment settings on Render — and restart the API. Start URLs must be on that website.';

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const clean = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(clean);
  if (!parsed.success) {
    // Report variable NAMES only — never values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET (≥32 chars) is required in production.');
    // The DEMO seed contains preview accounts whose passwords are published in the repository: never load it in production.
    if (env.SEED_DEMO_DATA && clean.SEED_DEMO_DATA !== undefined) {
      throw new Error('SEED_DEMO_DATA=true is not allowed in production (the DEMO accounts have publicly known passwords). Remove it or set it to false.');
    }
    env.SEED_DEMO_DATA = false;
    if (!env.ALLOW_EPHEMERAL_STORAGE) {
      throw new Error('No persistent database is configured: all data would be lost on every restart. Set ALLOW_EPHEMERAL_STORAGE=true to run anyway (staging/pilot only), or wait for the PostgreSQL integration.');
    }
    env.ALLOW_DEV_ROLE_PREVIEW = false;
    env.DEV_EXPOSE_RESET_TOKEN = false;
  }
  if (env.NODE_ENV === 'production' && env.CRAWLER_ALLOW_LIVE && !env.CRAWLER_BASE_URL) {
    // Live crawling was switched on without saying which website it may crawl: fail at start-up with the fix, instead
    // of starting a server whose Crawl Center can never run. (The crawler never falls back to a built-in website.)
    throw new Error(CRAWLER_BASE_URL_MISSING);
  }
  if ((env.ADMIN_EMAIL || env.ADMIN_INITIAL_PASSWORD) && !(env.ADMIN_EMAIL && env.ADMIN_INITIAL_PASSWORD)) {
    throw new Error('ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD must be set together.');
  }
  return env;
}

/** Which of the given env var names are set (names only). */
export function configuredVars(env: Env, names: string[]): string[] {
  return names.filter((n) => {
    const v = (env as Record<string, unknown>)[n];
    return v !== undefined && v !== '' && v !== false;
  });
}
