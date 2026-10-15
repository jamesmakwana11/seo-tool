/**
 * Delivery channel adapters (PDF §12.1–12.2). `ok: true` is returned only after the provider confirmed acceptance:
 *  - email:    SMTP server accepted the message for at least one recipient (nodemailer messageId)
 *  - whatsapp: Cloud API returned a message id for every recipient
 *  - slack:    incoming webhook returned 2xx "ok"
 */
import type { Env } from '../config/env';
import type { DeliveryChannelAdapter, OutboundMessage, SendResult } from '../services/ports';
import { classifySmtpError, defaultMailTransport, smtpOptions, WHATSAPP_GRAPH, type MailTransportFactory } from '../connectors/connectors';
import { defaultFetch, hostOf, httpRequest, is2xx, redact, secretValues, sendError, type FetchLike, type HttpResult } from '../connectors/http';

const isSet = (v: unknown) => v !== undefined && v !== '' && v !== false;
const missing = (env: Env, names: string[]) => names.filter((n) => !isSet((env as Record<string, unknown>)[n]));

export function splitList(v: string | undefined): string[] {
  // Comma / semicolon / newline separated — NOT spaces ("+91 98765 43210" is one phone number).
  return (v ?? '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderTextWithLinks(msg: OutboundMessage): string {
  const links = (msg.links ?? []).map((l) => `${l.label}: ${l.url}`);
  return links.length ? `${msg.text}\n\n${links.join('\n')}` : msg.text;
}

export function renderHtml(msg: OutboundMessage): string {
  const body = msg.html ?? `<p>${escapeHtml(msg.text).replace(/\n/g, '<br>')}</p>`;
  const links = (msg.links ?? [])
    .map((l) => `<a href="${escapeHtml(l.url)}" style="display:inline-block;margin:4px 8px 4px 0;padding:6px 12px;border:1px solid #888;border-radius:4px;text-decoration:none">${escapeHtml(l.label)}</a>`)
    .join('');
  return links ? `${body}<p>${links}</p>` : body;
}

// ---------------------------------------------------------------------------------------------- email

const SMTP_TRANSPORT_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
/** True when the SMTP transport itself is configured (recipients aside). */
export const emailTransportReady = (env: Env) => missing(env, SMTP_TRANSPORT_VARS).length === 0;

export function createEmailAdapter(env: Env, transport: MailTransportFactory = defaultMailTransport): DeliveryChannelAdapter & { missingVars(): string[] } {
  const envVars = [...SMTP_TRANSPORT_VARS, 'DIGEST_RECIPIENTS'];
  const missingVars = () => missing(env, envVars);
  // A message with explicit recipients goes to them only; everything else goes to the digest list.
  const recipients = (msg?: OutboundMessage) => (msg?.to?.length ? msg.to : splitList(env.DIGEST_RECIPIENTS));
  return {
    channel: 'email',
    envVars,
    missingVars,
    isConfigured: (msg?: OutboundMessage) => emailTransportReady(env) && recipients(msg).length > 0,
    async send(msg): Promise<SendResult> {
      const to = recipients(msg);
      try {
        const info = await transport(smtpOptions(env)).sendMail({ from: env.SMTP_FROM!, to: to.join(', '), subject: msg.subject, text: renderTextWithLinks(msg), html: renderHtml(msg) });
        const accepted = Array.isArray(info.accepted) ? info.accepted.length : undefined;
        if (accepted === 0) return { ok: false, error: 'SMTP server accepted no recipients.', retryable: false };
        return { ok: true, providerMessageId: info.messageId };
      } catch (e) {
        const c = classifySmtpError(e);
        const error = redact(`SMTP ${c.kind === 'auth' ? 'credentials rejected' : c.kind === 'network' ? `could not reach host ${env.SMTP_HOST}` : 'send failed'}: ${c.message.slice(0, 200)}`, secretValues(env));
        return { ok: false, error, retryable: c.kind === 'network' || c.kind === 'rate' || c.kind === 'temporary' };
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------- WhatsApp

/**
 * Sends a free-form `text` message to each recipient. NOTE: WhatsApp only delivers free-form text inside a 24h
 * customer-service window; business-initiated alerts outside it need approved templates (PDF §15 access note).
 * Meta returns an accepted message id ("wamid…") — that is provider acceptance, not handset delivery.
 */
export function createWhatsAppAdapter(env: Env, fetchImpl: FetchLike = defaultFetch): DeliveryChannelAdapter & { missingVars(): string[] } {
  const envVars = ['WHATSAPP_API_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_RECIPIENTS'];
  const missingVars = () => missing(env, envVars);
  return {
    channel: 'whatsapp',
    envVars,
    missingVars,
    isConfigured: () => missingVars().length === 0 && splitList(env.WHATSAPP_RECIPIENTS).length > 0,
    async send(msg): Promise<SendResult> {
      const url = `${WHATSAPP_GRAPH}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID!)}/messages`;
      const body = `*${msg.subject}*\n\n${renderTextWithLinks(msg)}`.slice(0, 4096);
      const ids: string[] = [];
      const failures: { to: string; r: HttpResult }[] = [];
      for (const raw of splitList(env.WHATSAPP_RECIPIENTS)) {
        const to = raw.replace(/[^\d]/g, '');
        const r = await httpRequest(fetchImpl, url, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body } }),
        });
        const id = is2xx(r) ? (r.json as { messages?: { id?: string }[] })?.messages?.[0]?.id : undefined;
        if (id) ids.push(id);
        else failures.push({ to, r });
      }
      if (!failures.length) return { ok: true, providerMessageId: ids.join(',') };
      const first = failures[0];
      const base = is2xx(first.r) ? { ok: false as const, error: 'WhatsApp Cloud API: response had no message id', retryable: false } : sendError('WhatsApp Cloud API', url, first.r);
      const partialNote = ids.length ? ` (${ids.length} of ${ids.length + failures.length} recipients accepted: ${ids.join(',')})` : '';
      // Meta signals throttling in the body (HTTP 400 + code 4/80007/130429/131056).
      const code = first.r.kind === 'response' ? (first.r.json as { error?: { code?: number } })?.error?.code : undefined;
      const throttled = code === 4 || code === 80007 || code === 130429 || code === 131056;
      return {
        ok: false,
        error: redact(`${base.error}${failures.length > 1 ? ` [${failures.length} recipients failed]` : ''}${partialNote}`, secretValues(env)),
        // Retrying would re-send to recipients that already got the message; only retry when none were accepted.
        retryable: ids.length === 0 && (base.retryable || throttled),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------- Slack

export function slackPayload(msg: OutboundMessage) {
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: msg.subject.slice(0, 150), emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: msg.text.slice(0, 2900) || ' ' } },
  ];
  const links = (msg.links ?? []).slice(0, 25);
  if (links.length) {
    blocks.push({
      type: 'actions',
      elements: links.map((l, i) => ({ type: 'button', text: { type: 'plain_text', text: l.label.slice(0, 75) }, url: l.url, action_id: `link_${i}` })),
    });
  }
  return { text: `${msg.subject}\n${msg.text}`.slice(0, 3000), blocks };
}

export function createSlackAdapter(env: Env, fetchImpl: FetchLike = defaultFetch): DeliveryChannelAdapter & { missingVars(): string[] } {
  const envVars = ['SLACK_WEBHOOK_URL'];
  const missingVars = () => missing(env, envVars);
  return {
    channel: 'slack',
    envVars,
    missingVars,
    isConfigured: () => missingVars().length === 0,
    async send(msg): Promise<SendResult> {
      const url = env.SLACK_WEBHOOK_URL!;
      const r = await httpRequest(fetchImpl, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(slackPayload(msg)) });
      if (is2xx(r)) return { ok: true };
      const e = sendError('Slack webhook', `https://${hostOf(url)}`, r);
      return { ...e, error: redact(e.error, secretValues(env)) };
    },
  };
}

export function createDeliveryAdapters(env: Env, fetchImpl: FetchLike = defaultFetch, opts: { mailTransport?: MailTransportFactory } = {}) {
  return [createEmailAdapter(env, opts.mailTransport), createWhatsAppAdapter(env, fetchImpl), createSlackAdapter(env, fetchImpl)];
}
