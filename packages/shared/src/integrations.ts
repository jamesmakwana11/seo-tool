import type { IntegrationId, IntegrationStatus } from './types';

/** PDF §15 data sources + prompt §5.16 notification / Task Ops adapters. */
export const INTEGRATION_CATALOG: Omit<IntegrationStatus, 'state' | 'stateDetail' | 'configuredVars' | 'settings'>[] = [
  { id: 'crawler', name: 'Site crawler', category: 'crawler', usedFor: 'Modules 1–3, 5–6: daily smart crawl and weekly full crawl', accessNeeded: 'Crawl allowance; crawler user-agent allowed by Shopify bot protection / firewall', envVars: ['CRAWLER_BASE_URL', 'CRAWLER_ALLOW_LIVE', 'CRAWLER_USER_AGENT'], optionalVars: ['CRAWLER_USER_AGENT'], dependentFeatures: ['Technical checks', 'On-page checks', 'Re-verification'] },
  { id: 'gsc', name: 'Google Search Console API', category: 'search', usedFor: 'Indexation, queries, CTR, rich results, cannibalization, decay', accessNeeded: 'A Google Cloud service-account key on the API server (GSC_SERVICE_ACCOUNT_JSON), the Search Console API enabled in its project, and the service account added as an Owner (or Full user) of the property', envVars: ['GSC_SERVICE_ACCOUNT_JSON', 'GSC_PROPERTY'], dependentFeatures: ['Index coverage delta', 'Content decay', 'Cannibalization', 'Striking distance', 'Low-CTR alerts'] },
  { id: 'ga4', name: 'Google Analytics 4 API', category: 'analytics', usedFor: 'Revenue/traffic for page-value tiers', accessNeeded: 'A Google Cloud service-account key on the API server (GA4_SERVICE_ACCOUNT_JSON), the Google Analytics Data API enabled in its project, and the service account added as Viewer (or higher) of the GA4 property', envVars: ['GA4_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTY_ID'], dependentFeatures: ['Tier 1 computation', 'Monthly revenue'] },
  { id: 'psi_crux', name: 'PageSpeed Insights + CrUX API', category: 'performance', usedFor: 'Core Web Vitals lab and field data', accessNeeded: 'Google Cloud API key with PageSpeed Insights + Chrome UX Report APIs enabled', envVars: ['GOOGLE_API_KEY'], dependentFeatures: ['CrUX field data', 'Lab PSI runs'] },
  { id: 'backlinks', name: 'Ahrefs or Semrush API', category: 'backlinks', usedFor: 'Backlinks, keywords, competitors, toxicity', accessNeeded: 'Paid subscription with API units', costNote: 'Consumes paid API units per request', envVars: ['BACKLINK_PROVIDER', 'AHREFS_API_TOKEN', 'SEMRUSH_API_KEY'], dependentFeatures: ['New/lost backlinks', 'Toxic-link spike', 'Keyword gaps', 'Competitor view'] },
  { id: 'shopify', name: 'Shopify Admin API + webhooks', category: 'commerce', usedFor: 'SEO editor (read and, after confirmation, write titles, meta descriptions, descriptions, tags, image alt text; theme proposals on unpublished themes), change detection via webhooks', accessNeeded: 'Connect in Settings → Shopify (OAuth: SHOPIFY_API_KEY + SHOPIFY_API_SECRET + APP_BASE_URL) or a custom-app token. Scopes: read_products, write_products, read_content, write_content; optional read_themes, write_themes, write_files', envVars: ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_WEBHOOK_SECRET', 'SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'], dependentFeatures: ['SEO editor', 'Changed-URL detection', 'Discontinued-product root cause', 'Factual-accuracy check'] },
  { id: 'gbp', name: 'Google Business Profile API', category: 'local', usedFor: 'Local signals, reviews', accessNeeded: 'Manager access on the business profile, granted to an OAuth user (refresh token) — service accounts cannot access GBP', envVars: ['GBP_OAUTH_CLIENT_ID', 'GBP_OAUTH_CLIENT_SECRET', 'GBP_OAUTH_REFRESH_TOKEN', 'GBP_LOCATION_ID'], dependentFeatures: ['Local citations & GBP'] },
  { id: 'openai', name: 'OpenAI API', category: 'ai', usedFor: 'Weekly AI-visibility panel; LLM-judged rules; rewrite drafts', accessNeeded: 'API key, small budget', costNote: 'Usage-billed', envVars: ['OPENAI_API_KEY'], dependentFeatures: ['AI-visibility sampling', 'LLM-judged custom rules', 'People-first value test'] },
  { id: 'gemini', name: 'Gemini API', category: 'ai', usedFor: 'Weekly AI-visibility panel', accessNeeded: 'API key, small budget', costNote: 'Usage-billed', envVars: ['GEMINI_API_KEY'], dependentFeatures: ['AI-visibility sampling'] },
  { id: 'perplexity', name: 'Perplexity API', category: 'ai', usedFor: 'Weekly AI-visibility panel', accessNeeded: 'API key, small budget', costNote: 'Usage-billed', envVars: ['PERPLEXITY_API_KEY'], dependentFeatures: ['AI-visibility sampling'] },
  { id: 'email', name: 'Email (SMTP)', category: 'notification', usedFor: 'Daily digest, weekly/monthly reports', accessNeeded: 'SMTP host and credentials', envVars: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'DIGEST_RECIPIENTS'], dependentFeatures: ['Daily digest delivery'] },
  { id: 'whatsapp', name: 'WhatsApp Business (Cloud API)', category: 'notification', usedFor: 'Digest + real-time alerts', accessNeeded: 'WhatsApp Business account, approved message templates, access token', envVars: ['WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_RECIPIENTS'], dependentFeatures: ['Real-time alerts', 'Digest'] },
  { id: 'slack', name: 'Slack', category: 'notification', usedFor: 'Real-time alerts to the dev + SEO channel', accessNeeded: 'Incoming webhook URL for the channel', envVars: ['SLACK_WEBHOOK_URL'], dependentFeatures: ['Real-time alerts', 'Digest'] },
  { id: 'task_ops', name: 'DeoDap Task Ops', category: 'tasks', usedFor: 'Create/update tasks on allocation, verification auto-comments (PDF §12.4)', accessNeeded: 'Task Ops API base URL + service token (no public API documented — internal task store is used until configured)', envVars: ['TASK_OPS_BASE_URL', 'TASK_OPS_TOKEN'], dependentFeatures: ['External task sync'] },
];

export function integrationBase(id: IntegrationId) {
  const i = INTEGRATION_CATALOG.find((x) => x.id === id);
  if (!i) throw new Error(`Unknown integration ${id}`);
  return i;
}

// ------------------------------------------------------------------ Google property settings (saved per website)

/**
 * GSC_PROPERTY / GA4_PROPERTY_ID can be saved from the Integrations screen (per website, not secret). The saved value is
 * used in the connection test and in every data sync; the server environment variable is the fallback. The
 * service-account key always stays in the server environment.
 */
export const INTEGRATION_PROPERTY_SETTINGS = {
  gsc: {
    key: 'property', envVar: 'GSC_PROPERTY', label: 'Search Console property', placeholder: 'sc-domain:deodap.in or https://deodap.in/',
    hint: 'A Domain property as sc-domain:example.com, or a URL-prefix property as the full address ending in / (exactly as Search Console lists it).',
  },
  ga4: {
    key: 'propertyId', envVar: 'GA4_PROPERTY_ID', label: 'GA4 property ID', placeholder: '123456789',
    hint: 'The numeric Property ID from GA4 Admin → Property details (not the G-… Measurement ID).',
  },
} as const;
export type PropertyIntegrationId = keyof typeof INTEGRATION_PROPERTY_SETTINGS;
export const isPropertyIntegration = (id: string): id is PropertyIntegrationId => id in INTEGRATION_PROPERTY_SETTINGS;

export type PropertyCheck = { ok: true; value: string } | { ok: false; error: string };

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

/** "sc-domain:example.com" or "https://www.example.com/" (URL-prefix, trailing slash added). */
export function normalizeGscProperty(raw: string): PropertyCheck {
  const v = (raw ?? '').trim();
  if (!v) return { ok: false, error: 'Enter the Search Console property.' };
  if (/^sc-domain:/i.test(v)) {
    const host = v.slice('sc-domain:'.length).trim().toLowerCase().replace(/\.$/, '');
    if (!HOST.test(host)) return { ok: false, error: `“${host}” is not a valid domain. A Domain property looks like sc-domain:example.com.` };
    return { ok: true, value: `sc-domain:${host}` };
  }
  if (!/^https?:\/\//i.test(v)) {
    const host = v.toLowerCase().replace(/\/.*$/, '');
    return { ok: false, error: HOST.test(host)
      ? `Write it as sc-domain:${host} (Domain property) or https://${host}/ (URL-prefix property), exactly as Search Console lists it.`
      : 'A Search Console property is sc-domain:example.com or a URL such as https://example.com/.' };
  }
  let u: URL;
  try { u = new URL(v); } catch { return { ok: false, error: 'That URL is not valid.' }; }
  if (u.username || u.password) return { ok: false, error: 'Remove the user name or password from the URL.' };
  if (u.search || u.hash) return { ok: false, error: 'A URL-prefix property has no ? query or # part.' };
  if (!HOST.test(u.hostname.toLowerCase())) return { ok: false, error: `“${u.hostname}” is not a public domain.` };
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  return { ok: true, value: `${u.protocol}//${u.host.toLowerCase()}${path}` };
}

/** "123456789" or "properties/123456789" → "123456789". Measurement IDs (G-…) and Universal Analytics IDs are refused. */
export function normalizeGa4PropertyId(raw: string): PropertyCheck {
  const v = String(raw ?? '').trim().replace(/^properties\//i, '');
  if (!v) return { ok: false, error: 'Enter the GA4 property ID.' };
  if (/^G-[A-Z0-9]+$/i.test(v)) return { ok: false, error: `${v} is a Measurement ID. Enter the numeric Property ID from GA4 Admin → Property details.` };
  if (/^UA-/i.test(v)) return { ok: false, error: `${v} is a Universal Analytics ID; GA4 uses a numeric Property ID.` };
  if (!/^\d{4,15}$/.test(v)) return { ok: false, error: 'A GA4 property ID is a number, e.g. 123456789.' };
  return { ok: true, value: v };
}

export function normalizeIntegrationProperty(id: PropertyIntegrationId, raw: string): PropertyCheck {
  return id === 'gsc' ? normalizeGscProperty(raw) : normalizeGa4PropertyId(raw);
}

/** The integrations always shown on the Integrations screen; every other one is picked from a dropdown. */
export const PRIMARY_INTEGRATIONS: readonly IntegrationId[] = ['crawler', 'gsc', 'ga4'];
