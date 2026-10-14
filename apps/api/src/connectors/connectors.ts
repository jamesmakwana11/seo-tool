/**
 * Data connectors (PDF subsystem B) + notification / Task Ops connection tests (PDF §15, prompt §5.16).
 *
 * Every `test()` makes ONE real, minimal API call (plus a token exchange for Google OAuth sources) through the
 * injectable `fetchImpl`. Results are honest: `ok: true` only after a real 2xx from the provider.
 *
 * Billing / side-effect notes:
 *  - perplexity: the test makes one tiny billable chat completion (model "sonar", max_tokens 1).
 *  - slack: testing an incoming webhook POSTS a short "Sentinel connection test" message to the channel.
 *  - backlinks: Ahrefs limits-and-usage and Semrush countapiunits are account-info calls (no paid units consumed).
 */
import nodemailer from 'nodemailer';
import type { Env } from '../config/env';
import type { Connector, ConnectorTestResult } from '../services/ports';
import { createGoogleAuth, parseServiceAccount, tokenFailure, type GoogleAuth } from './googleAuth';
import {
  defaultFetch, defineConnector, errMsg, failureResult, hostOf, httpRequest, is2xx, providerMessage,
  type FetchLike, type HintedConnector, type HttpResult,
} from './http';

const isSet = (v: unknown) => v !== undefined && v !== '' && v !== false;

// ---------------------------------------------------------------------------------------------- crawler

export function isLocalhostUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

export function crawlerConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  const local = () => isLocalhostUrl(env.CRAWLER_BASE_URL);
  return defineConnector({
    id: 'crawler',
    env,
    envVars: ['CRAWLER_BASE_URL', 'CRAWLER_USER_AGENT', 'CRAWLER_ALLOW_LIVE'],
    missingVars: () => [
      ...(isSet(env.CRAWLER_BASE_URL) ? [] : ['CRAWLER_BASE_URL']),
      ...(isSet(env.CRAWLER_USER_AGENT) ? [] : ['CRAWLER_USER_AGENT']),
      // A live (non-localhost) site may only be contacted after CRAWLER_ALLOW_LIVE=true.
      ...(env.CRAWLER_ALLOW_LIVE || local() ? [] : ['CRAWLER_ALLOW_LIVE']),
    ],
    async run() {
      const url = new URL('/robots.txt', env.CRAWLER_BASE_URL!).toString();
      const r = await httpRequest(fetchImpl, url, { headers: { 'user-agent': env.CRAWLER_USER_AGENT!, accept: 'text/plain,*/*' } });
      const label = `Crawler (GET ${url})`;
      if (is2xx(r)) {
        const lines = r.text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
        return { ok: true, result: `${label}: HTTP ${r.status} — robots.txt fetched with the crawler user-agent (${r.text.length} bytes, ${lines} directives).` };
      }
      if (r.kind === 'response' && (r.status === 403 || r.status === 429)) {
        return {
          ok: false,
          rateLimited: r.status === 429,
          result: `${label}: BLOCKED (HTTP ${r.status}) — Shopify bot protection / firewall is refusing the crawler user-agent. Allow-list the crawler UA (PDF §15) before crawling.`,
        };
      }
      return failureResult(label, url, r);
    },
  });
}

// ---------------------------------------------------------------------------------------------- Google: GSC / GA4

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

function normalizeSite(s: string): string {
  const t = s.trim();
  if (t.startsWith('sc-domain:')) return t.toLowerCase();
  return (t.endsWith('/') ? t : `${t}/`).toLowerCase();
}

export function gscConnector(env: Env, fetchImpl: FetchLike, auth: GoogleAuth): HintedConnector {
  return defineConnector({
    id: 'gsc',
    env,
    envVars: ['GSC_SERVICE_ACCOUNT_JSON', 'GSC_PROPERTY'],
    async run() {
      const label = 'Google Search Console';
      const sa = parseServiceAccount(env.GSC_SERVICE_ACCOUNT_JSON);
      if ('error' in sa) return { ok: false, result: `${label}: ${sa.error}` };
      const tok = await auth.serviceAccountToken(sa, GSC_SCOPE);
      if (!tok.ok) return tokenFailure(label, tok);
      const url = 'https://www.googleapis.com/webmasters/v3/sites';
      const r = await httpRequest(fetchImpl, url, { headers: { authorization: `Bearer ${tok.accessToken}` } });
      if (!is2xx(r)) return failureResult(label, url, r);
      const entries = ((r.json as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] })?.siteEntry ?? []).filter((e) => typeof e.siteUrl === 'string');
      const want = normalizeSite(env.GSC_PROPERTY!);
      const entry = entries.find((e) => normalizeSite(e.siteUrl!) === want);
      if (!entry) {
        return {
          ok: false,
          result: `${label}: authenticated as ${sa.client_email}, but property ${env.GSC_PROPERTY} is not visible (${entries.length} properties listed). Add the service account as an Owner of the property.`,
        };
      }
      if (entry.permissionLevel === 'siteOwner') return { ok: true, result: `${label}: property ${entry.siteUrl} accessible with Owner permission (siteOwner).` };
      if (entry.permissionLevel === 'siteUnverifiedUser') {
        return { ok: false, result: `${label}: property ${entry.siteUrl} is listed but unverified for ${sa.client_email} — no data access. Add the service account as an Owner.` };
      }
      return {
        ok: true,
        partial: true,
        result: `${label}: property ${entry.siteUrl} accessible with ${entry.permissionLevel ?? 'unknown'} permission — PDF §15 requires Owner access (siteOwner); some reports/actions will be unavailable.`,
      };
    },
  });
}

export function ga4Connector(env: Env, fetchImpl: FetchLike, auth: GoogleAuth): HintedConnector {
  return defineConnector({
    id: 'ga4',
    env,
    envVars: ['GA4_SERVICE_ACCOUNT_JSON', 'GA4_PROPERTY_ID'],
    async run() {
      const label = 'Google Analytics 4';
      const sa = parseServiceAccount(env.GA4_SERVICE_ACCOUNT_JSON);
      if ('error' in sa) return { ok: false, result: `${label}: ${sa.error}` };
      const tok = await auth.serviceAccountToken(sa, GA4_SCOPE);
      if (!tok.ok) return tokenFailure(label, tok);
      const pid = env.GA4_PROPERTY_ID!.replace(/^properties\//, '').trim();
      const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(pid)}`;
      const r = await httpRequest(fetchImpl, url, { headers: { authorization: `Bearer ${tok.accessToken}` } });
      if (is2xx(r)) {
        const name = (r.json as { displayName?: string })?.displayName;
        return { ok: true, result: `${label}: property ${pid}${name ? ` ("${name}")` : ''} readable by ${sa.client_email}.` };
      }
      if (r.kind === 'response' && r.status === 404) {
        return { ok: false, result: `${label}: property ${pid} not found or not shared with ${sa.client_email} (needs Viewer or higher).` };
      }
      return failureResult(label, url, r);
    },
  });
}

// ---------------------------------------------------------------------------------------------- PSI + CrUX

export function psiCruxConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'psi_crux',
    env,
    envVars: ['GOOGLE_API_KEY'],
    async run() {
      const label = 'Chrome UX Report API';
      let origin = 'https://deodap.in';
      try {
        if (env.CRAWLER_BASE_URL && !isLocalhostUrl(env.CRAWLER_BASE_URL)) origin = new URL(env.CRAWLER_BASE_URL).origin;
      } catch {
        /* keep default */
      }
      const url = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(env.GOOGLE_API_KEY!)}`;
      const r = await httpRequest(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin }) });
      const note = ' (PageSpeed Insights lab runs use the same key; PSI API enablement is not exercised by this test.)';
      if (is2xx(r)) return { ok: true, result: `${label}: field data returned for ${origin}.${note}` };
      if (r.kind === 'response' && r.status === 404) {
        return { ok: true, partial: true, result: `${label}: API key accepted, but CrUX has no field data for ${origin} (chrome ux report data not found).${note}` };
      }
      if (r.kind === 'response' && r.status === 400 && /api key not valid|API_KEY_INVALID/i.test(r.text)) {
        return { ok: false, result: `${label}: credentials rejected (HTTP 400) — API key not valid.` };
      }
      return failureResult(label, 'https://chromeuxreport.googleapis.com', r);
    },
  });
}

// ---------------------------------------------------------------------------------------------- backlinks

export function backlinksConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  const missing = () => {
    if (!env.BACKLINK_PROVIDER) return ['BACKLINK_PROVIDER'];
    if (env.BACKLINK_PROVIDER === 'ahrefs') return isSet(env.AHREFS_API_TOKEN) ? [] : ['AHREFS_API_TOKEN'];
    return isSet(env.SEMRUSH_API_KEY) ? [] : ['SEMRUSH_API_KEY'];
  };
  return defineConnector({
    id: 'backlinks',
    env,
    envVars: ['BACKLINK_PROVIDER', 'AHREFS_API_TOKEN', 'SEMRUSH_API_KEY'],
    // Only the token for the selected provider is needed.
    optionalVars: env.BACKLINK_PROVIDER === 'semrush' ? ['AHREFS_API_TOKEN'] : env.BACKLINK_PROVIDER === 'ahrefs' ? ['SEMRUSH_API_KEY'] : [],
    missingVars: missing,
    async run() {
      if (env.BACKLINK_PROVIDER === 'ahrefs') {
        const label = 'Ahrefs API';
        const url = 'https://api.ahrefs.com/v3/subscription-info/limits-and-usage';
        const r = await httpRequest(fetchImpl, url, { headers: { authorization: `Bearer ${env.AHREFS_API_TOKEN}`, accept: 'application/json' } });
        if (!is2xx(r)) return failureResult(label, url, r);
        const u = ((r.json as { limits_and_usage?: Record<string, unknown> })?.limits_and_usage ?? {}) as Record<string, unknown>;
        const limit = typeof u.units_limit_api_key === 'number' ? u.units_limit_api_key : u.units_limit_workspace;
        const used = typeof u.units_usage_api_key === 'number' ? u.units_usage_api_key : u.units_usage_workspace;
        const units = typeof limit === 'number' && typeof used === 'number' ? `${Math.max(0, limit - used)} of ${limit} API units remaining` : 'unit balance not reported';
        const sub = typeof u.subscription === 'string' ? ` (${u.subscription})` : '';
        if (typeof limit === 'number' && typeof used === 'number' && limit - used <= 0) {
          return { ok: true, partial: true, result: `${label}: token valid${sub}, but no paid API units remain — data pulls will fail until units reset${u.usage_reset_date ? ` on ${String(u.usage_reset_date)}` : ''}.` };
        }
        return { ok: true, result: `${label}: token valid${sub}; ${units}. Data pulls consume paid units.` };
      }
      const label = 'Semrush API';
      const url = `https://www.semrush.com/users/countapiunits.html?key=${encodeURIComponent(env.SEMRUSH_API_KEY!)}`;
      const r = await httpRequest(fetchImpl, url);
      if (!is2xx(r)) return failureResult(label, 'https://www.semrush.com', r);
      const body = r.text.trim();
      if (/^ERROR/i.test(body)) {
        if (/WRONG KEY|ERROR 120|ERROR 131|ERROR 132|ERROR 133/i.test(body)) return { ok: false, result: `${label}: credentials rejected — ${body.slice(0, 120)}` };
        return { ok: false, result: `${label}: request failed — ${body.slice(0, 120)}` };
      }
      const n = Number(body);
      if (!Number.isFinite(n)) return { ok: false, result: `${label}: unexpected response from countapiunits.` };
      if (n <= 0) return { ok: true, partial: true, result: `${label}: key valid, but 0 paid API units remain.` };
      return { ok: true, result: `${label}: key valid; ${n} paid API units remaining. Data pulls consume units.` };
    },
  });
}

// ---------------------------------------------------------------------------------------------- Shopify

export function shopifyDomain(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

export function shopifyConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'shopify',
    env,
    envVars: ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_WEBHOOK_SECRET'],
    optionalVars: ['SHOPIFY_WEBHOOK_SECRET'],
    async run() {
      const label = 'Shopify Admin API';
      const domain = shopifyDomain(env.SHOPIFY_STORE_DOMAIN!);
      const url = `https://${domain}/admin/api/${env.SHOPIFY_API_VERSION}/shop.json`;
      const r = await httpRequest(fetchImpl, url, { headers: { 'x-shopify-access-token': env.SHOPIFY_ADMIN_TOKEN!, accept: 'application/json' } });
      if (!is2xx(r)) {
        if (r.kind === 'response' && r.status === 404) return { ok: false, result: `${label}: store ${domain} or API version ${env.SHOPIFY_API_VERSION} not found (HTTP 404).` };
        return failureResult(label, url, r);
      }
      const shop = (r.json as { shop?: { name?: string; myshopify_domain?: string } })?.shop;
      const who = `${shop?.name ? `"${shop.name}"` : 'shop'}${shop?.myshopify_domain ? ` (${shop.myshopify_domain})` : ''}`;
      if (!isSet(env.SHOPIFY_WEBHOOK_SECRET)) {
        return { ok: true, partial: true, result: `${label}: connected to ${who}. SHOPIFY_WEBHOOK_SECRET is not set, so change webhooks cannot be verified/accepted.` };
      }
      return { ok: true, result: `${label}: connected to ${who} (API ${env.SHOPIFY_API_VERSION}); webhook secret configured.` };
    },
  });
}

// ---------------------------------------------------------------------------------------------- Google Business Profile

/**
 * GBP: the Business Profile APIs require a Google *user* with Manager (or Owner) access on the profile —
 * service accounts cannot be added as profile managers — so this uses an OAuth client + refresh token
 * (scope https://www.googleapis.com/auth/business.manage) minted once by that user. The Google Cloud project
 * must also be approved for Business Profile API access (unapproved projects get quota 0 → 429/403).
 */
export function gbpConnector(env: Env, fetchImpl: FetchLike, auth: GoogleAuth): HintedConnector {
  return defineConnector({
    id: 'gbp',
    env,
    envVars: ['GBP_OAUTH_CLIENT_ID', 'GBP_OAUTH_CLIENT_SECRET', 'GBP_OAUTH_REFRESH_TOKEN', 'GBP_LOCATION_ID'],
    optionalVars: ['GBP_LOCATION_ID'],
    async run() {
      const label = 'Google Business Profile';
      const tok = await auth.refreshTokenAccess(env.GBP_OAUTH_CLIENT_ID!, env.GBP_OAUTH_CLIENT_SECRET!, env.GBP_OAUTH_REFRESH_TOKEN!);
      if (!tok.ok) return tokenFailure(label, tok);
      const url = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
      const r = await httpRequest(fetchImpl, url, { headers: { authorization: `Bearer ${tok.accessToken}` } });
      if (!is2xx(r)) return failureResult(label, url, r);
      const accounts = (r.json as { accounts?: unknown[] })?.accounts ?? [];
      if (!accounts.length) {
        return { ok: true, partial: true, result: `${label}: OAuth user authenticated, but no Business Profile accounts are visible — the user needs Manager access on the DeoDap profile.` };
      }
      const loc = isSet(env.GBP_LOCATION_ID) ? '' : ' Set GBP_LOCATION_ID to select the location.';
      return { ok: true, result: `${label}: ${accounts.length} account(s) visible to the OAuth user.${loc}` };
    },
  });
}

// ---------------------------------------------------------------------------------------------- AI engines

export function openaiConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'openai',
    env,
    envVars: ['OPENAI_API_KEY'],
    async run() {
      const label = 'OpenAI API';
      const url = 'https://api.openai.com/v1/models';
      const r = await httpRequest(fetchImpl, url, { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } });
      if (!is2xx(r)) return failureResult(label, url, r);
      const ids = ((r.json as { data?: { id?: string }[] })?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      if (ids.length && !ids.includes(env.OPENAI_MODEL)) {
        return { ok: true, partial: true, result: `${label}: key valid (${ids.length} models), but configured model ${env.OPENAI_MODEL} is not available to this key.` };
      }
      return { ok: true, result: `${label}: key valid; ${ids.length} models available${ids.includes(env.OPENAI_MODEL) ? `, including ${env.OPENAI_MODEL}` : ''}.` };
    },
  });
}

export function geminiConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'gemini',
    env,
    envVars: ['GEMINI_API_KEY'],
    async run() {
      const label = 'Gemini API';
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(env.GEMINI_API_KEY!)}`;
      const r = await httpRequest(fetchImpl, url);
      if (is2xx(r)) {
        const n = ((r.json as { models?: unknown[] })?.models ?? []).length;
        return { ok: true, result: `${label}: key valid; ${n} models listed.` };
      }
      if (r.kind === 'response' && r.status === 400 && /api key not valid|API_KEY_INVALID/i.test(r.text)) {
        return { ok: false, result: `${label}: credentials rejected (HTTP 400) — API key not valid.` };
      }
      return failureResult(label, 'https://generativelanguage.googleapis.com', r);
    },
  });
}

/** NOTE: makes one tiny billable request (model "sonar", max_tokens 1) — Perplexity has no free key-check endpoint. */
export function perplexityConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'perplexity',
    env,
    envVars: ['PERPLEXITY_API_KEY'],
    async run() {
      const label = 'Perplexity API';
      const url = 'https://api.perplexity.ai/chat/completions';
      const r = await httpRequest(fetchImpl, url, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.PERPLEXITY_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (!is2xx(r)) return failureResult(label, url, r);
      return { ok: true, result: `${label}: key valid (one minimal billable "sonar" completion, max_tokens 1, was made).` };
    },
  });
}

// ---------------------------------------------------------------------------------------------- email (SMTP)

export interface MailTransportLike {
  verify(): Promise<unknown>;
  sendMail(opts: { from: string; to: string; subject: string; text: string; html?: string }): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>;
}
export type MailTransportFactory = (opts: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } }) => MailTransportLike;

export const defaultMailTransport: MailTransportFactory = (opts) =>
  nodemailer.createTransport({ ...opts, connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000 }) as unknown as MailTransportLike;

export function smtpOptions(env: Env) {
  const port = env.SMTP_PORT ?? 587;
  return { host: env.SMTP_HOST!, port, secure: port === 465, auth: { user: env.SMTP_USER!, pass: env.SMTP_PASSWORD! } };
}

const NETWORK_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH']);

/** Classifies a nodemailer error. */
export function classifySmtpError(e: unknown): { kind: 'auth' | 'network' | 'rate' | 'temporary' | 'permanent'; message: string } {
  const err = e as { code?: string; responseCode?: number; message?: string };
  const message = errMsg(e);
  if (err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534 || err.responseCode === 530) return { kind: 'auth', message };
  if ((err.code && NETWORK_CODES.has(err.code)) || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(message)) return { kind: 'network', message };
  if (typeof err.responseCode === 'number' && err.responseCode >= 400 && err.responseCode < 500) {
    return { kind: /rate|too many|throttl/i.test(message) ? 'rate' : 'temporary', message };
  }
  return { kind: 'permanent', message };
}

export function emailConnector(env: Env, transport: MailTransportFactory = defaultMailTransport): HintedConnector {
  return defineConnector({
    id: 'email',
    env,
    envVars: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'DIGEST_RECIPIENTS', 'SMTP_FROM'],
    optionalVars: ['SMTP_FROM'],
    async run() {
      const opts = smtpOptions(env);
      const label = `SMTP (${opts.host}:${opts.port}${opts.secure ? ', TLS' : ', STARTTLS'})`;
      try {
        await transport(opts).verify();
        return { ok: true, result: `${label}: server reachable and login accepted (no message sent).` };
      } catch (e) {
        const c = classifySmtpError(e);
        if (c.kind === 'auth') return { ok: false, result: `${label}: credentials rejected — ${c.message.slice(0, 160)}` };
        if (c.kind === 'network') return { ok: false, result: `${label}: could not reach host ${opts.host} (${c.message.slice(0, 160)})` };
        if (c.kind === 'rate') return { ok: false, rateLimited: true, result: `${label}: rate limited — ${c.message.slice(0, 160)}` };
        return { ok: false, result: `${label}: verification failed — ${c.message.slice(0, 160)}` };
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------- WhatsApp / Slack / Task Ops

export const WHATSAPP_GRAPH = 'https://graph.facebook.com/v21.0';

/** Meta Graph errors often arrive as HTTP 400 with an error code; normalize them. */
export function metaFailure(label: string, url: string, r: HttpResult): ConnectorTestResult {
  if (r.kind === 'response') {
    const code = (r.json as { error?: { code?: number } })?.error?.code;
    if (code === 190 || code === 102 || code === 10 || code === 200) return { ok: false, result: `${label}: credentials rejected (HTTP ${r.status}, Graph error ${code}) — ${providerMessage(r)}` };
    if (code === 4 || code === 80007 || code === 130429 || code === 131056 || code === 613) {
      return { ok: false, rateLimited: true, result: `${label}: rate limited (Graph error ${code}) — retry later.` };
    }
  }
  return failureResult(label, url, r);
}

export function whatsappConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'whatsapp',
    env,
    envVars: ['WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_RECIPIENTS'],
    async run() {
      const label = 'WhatsApp Cloud API';
      const url = `${WHATSAPP_GRAPH}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!)}`;
      const r = await httpRequest(fetchImpl, url, { headers: { authorization: `Bearer ${env.WHATSAPP_API_TOKEN}` } });
      if (!is2xx(r)) return metaFailure(label, url, r);
      const j = (r.json ?? {}) as { display_phone_number?: string; verified_name?: string; quality_rating?: string };
      const who = [j.verified_name, j.display_phone_number].filter(Boolean).join(' · ') || 'phone number';
      return {
        ok: true,
        result: `${label}: ${who} reachable with the token${j.quality_rating ? ` (quality ${j.quality_rating})` : ''}. Business-initiated messages outside the 24h window require approved templates.`,
      };
    },
  });
}

/** NOTE: an incoming webhook can only be tested by posting to it, so this sends one short message to the channel. */
export function slackConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'slack',
    env,
    envVars: ['SLACK_WEBHOOK_URL'],
    async run() {
      const label = 'Slack incoming webhook';
      const r = await httpRequest(fetchImpl, env.SLACK_WEBHOOK_URL!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Sentinel connection test — DeoDap SEO Sentinel can post alerts to this channel.' }),
      });
      if (is2xx(r)) return { ok: true, result: `${label}: test message posted (Slack replied "${r.text.trim().slice(0, 20) || 'ok'}").` };
      if (r.kind === 'response' && [403, 404, 410].includes(r.status)) {
        return { ok: false, result: `${label}: credentials rejected (HTTP ${r.status}: ${r.text.trim().slice(0, 60)}) — the webhook was revoked, the channel archived, or the URL is wrong.` };
      }
      return failureResult(label, `https://${hostOf(env.SLACK_WEBHOOK_URL!)}`, r);
    },
  });
}

/**
 * DeoDap Task Ops has NO public API specification. The adapter ASSUMES a REST shape
 * (`GET/POST {base}/api/tasks`, `PUT {base}/api/tasks/:id`, `POST {base}/api/tasks/:id/comments`, `GET {base}/health`,
 * Bearer token) that must be confirmed with the Task Ops owners before go-live.
 */
export function taskOpsConnector(env: Env, fetchImpl: FetchLike): HintedConnector {
  return defineConnector({
    id: 'task_ops',
    env,
    envVars: ['TASK_OPS_BASE_URL', 'TASK_OPS_TOKEN'],
    async run() {
      const label = 'DeoDap Task Ops';
      const base = env.TASK_OPS_BASE_URL!.replace(/\/+$/, '');
      const headers = { authorization: `Bearer ${env.TASK_OPS_TOKEN}`, accept: 'application/json' };
      const url = `${base}/api/tasks?limit=1`;
      const r = await httpRequest(fetchImpl, url, { headers });
      const caveat = ' (endpoint shape is an assumption — Task Ops has no published API spec)';
      if (is2xx(r)) return { ok: true, result: `${label}: GET /api/tasks?limit=1 accepted the token (HTTP ${r.status})${caveat}.` };
      if (r.kind === 'response' && r.status === 404) {
        const h = await httpRequest(fetchImpl, `${base}/health`, { headers });
        if (is2xx(h)) {
          return { ok: true, partial: true, result: `${label}: host reachable (GET /health ${h.status}) but /api/tasks returned 404 — confirm the Task Ops API endpoints; task sync cannot run yet.` };
        }
        return { ok: false, result: `${label}: /api/tasks and /health not found (HTTP 404) at ${hostOf(base)}${caveat}.` };
      }
      return failureResult(label, url, r);
    },
  });
}

// ---------------------------------------------------------------------------------------------- factory

export interface ConnectorOptions {
  mailTransport?: MailTransportFactory;
  googleAuth?: GoogleAuth;
}

export function createConnectors(env: Env, fetchImpl: FetchLike = defaultFetch, opts: ConnectorOptions = {}): (Connector & { missingVars(): string[] })[] {
  const auth = opts.googleAuth ?? createGoogleAuth({ fetchImpl });
  return [
    crawlerConnector(env, fetchImpl),
    gscConnector(env, fetchImpl, auth),
    ga4Connector(env, fetchImpl, auth),
    psiCruxConnector(env, fetchImpl),
    backlinksConnector(env, fetchImpl),
    shopifyConnector(env, fetchImpl),
    gbpConnector(env, fetchImpl, auth),
    openaiConnector(env, fetchImpl),
    geminiConnector(env, fetchImpl),
    perplexityConnector(env, fetchImpl),
    emailConnector(env, opts.mailTransport),
    whatsappConnector(env, fetchImpl),
    slackConnector(env, fetchImpl),
    taskOpsConnector(env, fetchImpl),
  ];
}
