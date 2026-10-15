/**
 * Delivery service: sends one message over the requested channels, retries retryable failures, persists exactly
 * one final DeliveryAttempt per channel and never reports `delivered` without provider confirmation.
 * Logs outcome metadata only — never message bodies, recipients' content or secrets.
 */
import type { DeliveryAttempt } from '@sentinel/shared';
import type { Repositories } from '../repositories/types';
import type { DeliveryChannelAdapter, DeliveryService, OutboundMessage, SendResult } from '../services/ports';
import { errMsg, type MinimalLogger } from '../connectors/http';

export interface RetryPolicy {
  attempts: number;
  delayMs: (attempt: number) => number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, delayMs: (n) => 1000 * 2 ** (n - 1) };

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

export function createDeliveryService(deps: {
  repos: Repositories;
  adapters: DeliveryChannelAdapter[];
  clock: () => Date;
  log: MinimalLogger;
  retry?: RetryPolicy;
}): DeliveryService {
  const { repos, clock, log } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const maxAttempts = Math.max(1, Math.floor(retry.attempts));
  const byChannel = new Map(deps.adapters.map((a) => [a.channel, a]));

  const missingNames = (a: DeliveryChannelAdapter) => {
    const hinted = a as DeliveryChannelAdapter & { missingVars?: () => string[] };
    return hinted.missingVars ? hinted.missingVars() : a.envVars;
  };

  async function sendWithRetry(a: DeliveryChannelAdapter, msg: OutboundMessage): Promise<{ result: SendResult; tries: number }> {
    let result: SendResult = { ok: false, error: 'not attempted', retryable: false };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        result = await a.send(msg);
      } catch (e) {
        // Adapters should not throw; treat an unexpected throw as a non-retryable failure.
        result = { ok: false, error: `Adapter error: ${errMsg(e).slice(0, 200)}`, retryable: false };
      }
      if (result.ok || !result.retryable || attempt === maxAttempts) return { result, tries: attempt };
      log.warn({ channel: a.channel, attempt, maxAttempts }, 'delivery attempt failed (retryable); retrying');
      await sleep(retry.delayMs(attempt));
    }
    return { result, tries: maxAttempts };
  }

  return {
    async deliver(kind, channels, msg, refs) {
      const out: DeliveryAttempt[] = [];
      for (const channel of [...new Set(channels)]) {
        const a = byChannel.get(channel);
        const base = { channel, kind, subject: msg.subject, issueId: refs?.issueId, taskId: refs?.taskId };
        let attempt: DeliveryAttempt;
        if (!a || !a.isConfigured(msg)) {
          const names = a ? missingNames(a) : [];
          attempt = {
            ...base,
            id: await repos.deliveries.nextId('DLV', 5),
            at: clock().toISOString(),
            outcome: 'skipped_not_configured',
            retryable: false,
            error: a ? `Channel not configured — missing ${names.join(', ') || a.envVars.join(', ')}` : `No ${channel} adapter is installed.`,
          };
        } else {
          const { result, tries } = await sendWithRetry(a, msg);
          attempt = {
            ...base,
            id: await repos.deliveries.nextId('DLV', 5),
            at: clock().toISOString(),
            ...(result.ok
              ? { outcome: 'delivered' as const, retryable: false, providerMessageId: result.providerMessageId }
              : { outcome: 'failed' as const, retryable: result.retryable, error: tries > 1 ? `${result.error} (after ${tries} attempts)` : result.error }),
          };
        }
        for (const k of Object.keys(attempt) as (keyof DeliveryAttempt)[]) if (attempt[k] === undefined) delete attempt[k];
        await repos.deliveries.insert(attempt);
        const meta = { deliveryId: attempt.id, channel, kind, outcome: attempt.outcome, retryable: attempt.retryable, issueId: refs?.issueId, taskId: refs?.taskId };
        if (attempt.outcome === 'failed') log.error({ ...meta, error: attempt.error }, 'delivery failed');
        else if (attempt.outcome === 'skipped_not_configured') log.info(meta, 'delivery skipped: channel not configured');
        else log.info({ ...meta, providerMessageId: attempt.providerMessageId }, 'delivery confirmed by provider');
        out.push(attempt);
      }
      return out;
    },

    channelStatus() {
      const channels: DeliveryAttempt['channel'][] = ['email', 'whatsapp', 'slack'];
      return channels.map((channel) => {
        const a = byChannel.get(channel);
        return { channel, configured: !!a && a.isConfigured(), envVars: a?.envVars ?? [] };
      });
    },
  };
}
