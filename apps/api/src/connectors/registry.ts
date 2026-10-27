/**
 * Integration registry: honest per-integration status (PDF §15, prompt §5.16).
 *
 * State rules (evaluated in order):
 *  1. no env var of the integration set              → not_configured
 *  2. some required env var missing                  → credentials_missing (missing NAMES listed in stateDetail)
 *  3. configured, never tested                       → not_configured, stateDetail "Credentials set but not yet verified — run Test connection"
 *     (the IntegrationState union has no "untested" member; reporting connected/partial/failed would be dishonest)
 *  4. last test rate limited                         → rate_limited
 *  5. last test failed                               → connection_failed
 *  6. last test ok but partial                       → partial
 *  7. last test ok, last data sync failed            → sync_failed
 *  8. last test ok                                   → connected
 * `connected` (and isConnected) is never reported without a successful test persisted in repos.integrationTests.
 */
import {
  ApiError, INTEGRATION_CATALOG, INTEGRATION_PROPERTY_SETTINGS, isPropertyIntegration, normalizeIntegrationProperty,
  type IntegrationId, type IntegrationState, type IntegrationStatus,
} from '@sentinel/shared';
import { configuredVars, type Env } from '../config/env';
import type { IntegrationTestDoc, Repositories } from '../repositories/types';
import type { Connector, IntegrationRegistry } from '../services/ports';
import { redact, secretValues, type MinimalLogger } from './http';

/**
 * IntegrationTestDoc plus the `partial` flag and the property it was run against (stored alongside), so a test that
 * passed for one GSC / GA4 property never counts as a connection for another one.
 */
export type StoredIntegrationTest = IntegrationTestDoc & { partial?: boolean; testedWith?: string };

type Settings = Record<string, string | number | boolean>;

export const SECRET_SETTING_KEY = /token|secret|password|key/i;
export const UNTESTED_DETAIL = 'Credentials set but not yet verified — run Test connection';

export interface IntegrationRegistryWithSync extends IntegrationRegistry {
  /** Record the outcome of a data sync (used by connector jobs) → drives lastSuccessfulSyncAt / sync_failed. */
  recordSync(id: IntegrationId, outcome: { ok: true } | { ok: false; error: string }): Promise<IntegrationStatus>;
}

export function createIntegrationRegistry(deps: {
  env: Env;
  repos: Repositories;
  connectors: Connector[];
  clock: () => Date;
  log: MinimalLogger;
}): IntegrationRegistryWithSync {
  const { env, repos, clock, log } = deps;
  const byId = new Map(deps.connectors.map((c) => [c.id, c]));
  const secrets = () => secretValues(env);

  const catalogEntry = (id: IntegrationId) => {
    const e = INTEGRATION_CATALOG.find((x) => x.id === id);
    if (!e) throw new ApiError(404, 'NOT_FOUND', `Integration ${String(id)} not found.`);
    return e;
  };

  function varsFor(id: IntegrationId, settings: Settings = {}) {
    const entry = catalogEntry(id);
    const c = byId.get(id);
    const envVars = c?.envVars ?? entry.envVars;
    const optional = new Set(c?.optionalVars ?? entry.optionalVars ?? []);
    const set = configuredVars(env, envVars);
    // Env vars a saved setting provides (GSC_PROPERTY ← settings.property): count as set for the state rules.
    const fromSettings = Object.entries(c?.settingVars ?? {}).filter(([, key]) => String(settings[key] ?? '').trim()).map(([name]) => name);
    const provided = [...new Set([...set, ...fromSettings])];
    const hinted = c as (Connector & { missingVars?: (s?: Settings) => string[] }) | undefined;
    const missing = hinted?.missingVars ? hinted.missingVars(settings) : envVars.filter((n) => !optional.has(n) && !provided.includes(n));
    return { entry, envVars, optional: [...optional], set, provided, missing, connector: c };
  }

  /** The GSC / GA4 property in use: saved on the Integrations screen (wins), else the server env var. */
  function propertyOf(id: IntegrationId, settings: Settings): IntegrationStatus['property'] {
    if (!isPropertyIntegration(id)) return undefined;
    const p = INTEGRATION_PROPERTY_SETTINGS[id];
    const saved = String(settings[p.key] ?? '').trim();
    const fromEnv = String((env as Record<string, unknown>)[p.envVar] ?? '').trim();
    return { key: p.key, envVar: p.envVar, value: saved || fromEnv || undefined, source: saved ? 'saved' : fromEnv ? 'env' : 'none' };
  }
  /** What a test result is bound to (the property for GSC / GA4; nothing for other integrations). */
  const fingerprint = (id: IntegrationId, settings: Settings) => propertyOf(id, settings)?.value;

  /** Plain words for missing credentials (names only — never values). */
  function missingDetail(id: IntegrationId, missing: string[]): string {
    const keys = missing.filter((n) => /SERVICE_ACCOUNT_JSON$/.test(n));
    const base = `Missing required settings: ${missing.join(', ') || 'see connector requirements'}.`;
    if (keys.length && isPropertyIntegration(id)) {
      return `${base} The property can be saved here, but Google only answers with a service-account key: set ${keys.join(', ')} on the API server (never in the browser), add that service account to the property, then run Test connection.`;
    }
    if (missing.length && missing.every((n) => n === INTEGRATION_PROPERTY_SETTINGS[id as 'gsc' | 'ga4']?.envVar)) {
      return `${base} Enter it in the property field below (or set ${missing[0]} on the API server).`;
    }
    return base;
  }

  async function status(id: IntegrationId): Promise<IntegrationStatus> {
    const settings = (await repos.integrationSettings.get(id))?.settings ?? {};
    const { entry, envVars, optional, set, provided, missing, connector } = varsFor(id, settings);
    const stored = (await repos.integrationTests.get(id)) as StoredIntegrationTest | undefined;
    // A test of another property (changed since) is shown as history but says nothing about the current one.
    // (Tests stored before properties could be saved here were run against the server env var.)
    const testedWith = stored?.testedWith ?? (isPropertyIntegration(id) ? String((env as Record<string, unknown>)[INTEGRATION_PROPERTY_SETTINGS[id].envVar] ?? '').trim() || undefined : undefined);
    const stale = !!stored && isPropertyIntegration(id) && testedWith !== fingerprint(id, settings);
    const test = stale ? undefined : stored;
    let state: IntegrationState;
    let stateDetail: string;

    if (provided.length === 0) {
      state = 'not_configured';
      const prop = isPropertyIntegration(id) ? INTEGRATION_PROPERTY_SETTINGS[id].envVar : undefined;
      const needed = envVars.filter((n) => !optional.includes(n) && n !== prop);
      stateDetail = prop
        ? `Not configured — set ${needed.join(', ')} on the API server and save the property below (or set ${prop}).`
        : `Not configured — set ${needed.join(', ')} on the API server.${id === 'shopify' ? ' Or use Connect with Shopify (Settings → Shopify, OAuth) — that connection and its status are shown there.' : ''}`;
    } else if (missing.length > 0 || (connector && !connector.isConfigured(settings))) {
      state = 'credentials_missing';
      stateDetail = missingDetail(id, missing);
    } else if (!connector) {
      state = 'not_configured';
      stateDetail = 'Credentials set, but no connector is available to verify them.';
    } else if (!test) {
      state = 'not_configured';
      stateDetail = stale ? `The property changed since the last test — ${UNTESTED_DETAIL.charAt(0).toLowerCase()}${UNTESTED_DETAIL.slice(1)}.` : UNTESTED_DETAIL;
    } else if (test.rateLimited) {
      state = 'rate_limited';
      stateDetail = `Rate limited by the provider at last test — retry later. ${test.result}`;
    } else if (!test.ok) {
      state = 'connection_failed';
      stateDetail = `Last connection test failed: ${test.result}`;
    } else if (test.partial) {
      state = 'partial';
      stateDetail = `Connected with limitations: ${test.result}`;
    } else if (test.lastSyncError) {
      state = 'sync_failed';
      stateDetail = `Connection test passed, but the last data sync failed: ${test.lastSyncError}`;
    } else {
      state = 'connected';
      stateDetail = `Connection verified ${test.at}.`;
    }

    return {
      id,
      name: entry.name,
      category: entry.category,
      usedFor: entry.usedFor,
      accessNeeded: entry.accessNeeded,
      costNote: entry.costNote,
      state,
      stateDetail: redact(stateDetail, secrets()),
      envVars,
      ...(optional.length ? { optionalVars: optional } : {}),
      configuredVars: set,
      ...(isPropertyIntegration(id) ? { property: propertyOf(id, settings) } : {}),
      lastTestAt: stored?.at,
      lastTestResult: stored ? redact(`${stale ? `(for the previous property ${testedWith ?? '—'}) ` : ''}${stored.result}`, secrets()) : undefined,
      lastSuccessfulSyncAt: test?.lastSuccessfulSyncAt,
      lastSyncError: test?.lastSyncError,
      dependentFeatures: entry.dependentFeatures,
      settings,
    };
  }

  return {
    status,
    async list() {
      return Promise.all(INTEGRATION_CATALOG.map((e) => status(e.id)));
    },

    async test(id) {
      const settings = (await repos.integrationSettings.get(id))?.settings ?? {};
      const { connector, missing } = varsFor(id, settings);
      if (!connector) throw new ApiError(400, 'NO_CONNECTOR', `No connector is available for ${id}.`);
      if (!connector.isConfigured(settings)) {
        // Nothing to call — do not persist a fake failure; status already reports credentials_missing / not_configured.
        log.info({ integration: id, missing }, 'integration test skipped: not configured');
        return status(id);
      }
      const startedAt = clock();
      let r;
      try {
        r = await connector.test(settings);
      } catch {
        r = { ok: false, result: 'Connection test threw unexpectedly.' };
      }
      const prev = (await repos.integrationTests.get(id)) as StoredIntegrationTest | undefined;
      const samePropertyAs = (t?: StoredIntegrationTest) => !isPropertyIntegration(id) || (t?.testedWith ?? (String((env as Record<string, unknown>)[INTEGRATION_PROPERTY_SETTINGS[id].envVar] ?? '').trim() || undefined)) === fingerprint(id, settings);
      const doc: StoredIntegrationTest = {
        id,
        at: startedAt.toISOString(),
        ok: r.ok === true,
        result: redact(String(r.result ?? ''), secrets()),
        rateLimited: r.rateLimited === true ? true : undefined,
        partial: r.partial === true ? true : undefined,
        // Sync history belongs to the property it was synced for.
        lastSuccessfulSyncAt: samePropertyAs(prev) ? prev?.lastSuccessfulSyncAt : undefined,
        lastSyncError: samePropertyAs(prev) ? prev?.lastSyncError : undefined,
        ...(isPropertyIntegration(id) && fingerprint(id, settings) ? { testedWith: fingerprint(id, settings) } : {}),
      };
      await repos.integrationTests.upsert(doc);
      log.info({ integration: id, ok: doc.ok, rateLimited: !!doc.rateLimited, partial: !!doc.partial, ms: clock().getTime() - startedAt.getTime() }, 'integration connection test');
      return status(id);
    },

    async updateSettings(id, settings) {
      catalogEntry(id);
      const rejected = Object.keys(settings).filter((k) => SECRET_SETTING_KEY.test(k));
      const pem = Object.entries(settings).filter(([, v]) => typeof v === 'string' && /PRIVATE KEY-----/.test(v)).map(([k]) => k);
      if (rejected.length || pem.length) {
        throw new ApiError(
          400,
          'SECRET_IN_SETTINGS',
          `Secrets cannot be stored as integration settings (${[...new Set([...rejected, ...pem])].join(', ')}). Set credentials as environment variables on the API server.`,
          { keys: [...new Set([...rejected, ...pem])] },
        );
      }
      for (const [k, v] of Object.entries(settings)) {
        if (!['string', 'number', 'boolean'].includes(typeof v)) throw new ApiError(400, 'VALIDATION', `Setting ${k} must be a string, number or boolean.`);
      }
      const clean: Settings = { ...settings };
      // GSC property / GA4 property ID: validated and stored in the form Google expects ('' clears it → env fallback).
      if (isPropertyIntegration(id)) {
        const p = INTEGRATION_PROPERTY_SETTINGS[id];
        if (p.key in clean && String(clean[p.key]).trim() !== '') {
          const checked = normalizeIntegrationProperty(id, String(clean[p.key]));
          if (!checked.ok) throw new ApiError(400, 'VALIDATION', checked.error, { fields: { [p.key]: checked.error } });
          clean[p.key] = checked.value;
        } else if (p.key in clean) clean[p.key] = '';
      }
      const prev = (await repos.integrationSettings.get(id))?.settings ?? {};
      await repos.integrationSettings.upsert({ id, settings: { ...prev, ...clean } });
      log.info({ integration: id, keys: Object.keys(settings) }, 'integration settings updated');
      return status(id);
    },

    async isConnected(id) {
      const s = await status(id);
      if (s.state !== 'connected' && s.state !== 'partial' && s.state !== 'sync_failed') return false;
      const t = await repos.integrationTests.get(id);
      return t?.ok === true;
    },

    async recordSync(id, outcome) {
      catalogEntry(id);
      const prev = (await repos.integrationTests.get(id)) as StoredIntegrationTest | undefined;
      if (!prev) return status(id); // never tested: a sync result cannot imply connectivity status
      const now = clock().toISOString();
      const next: StoredIntegrationTest = outcome.ok
        ? { ...prev, lastSuccessfulSyncAt: now, lastSyncError: undefined }
        : { ...prev, lastSyncError: redact(outcome.error, secrets()) };
      await repos.integrationTests.upsert(next);
      return status(id);
    },
  };
}
