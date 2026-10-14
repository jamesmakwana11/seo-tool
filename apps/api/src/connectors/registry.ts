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
import { ApiError, INTEGRATION_CATALOG, type IntegrationId, type IntegrationState, type IntegrationStatus } from '@sentinel/shared';
import { configuredVars, type Env } from '../config/env';
import type { IntegrationTestDoc, Repositories } from '../repositories/types';
import type { Connector, IntegrationRegistry } from '../services/ports';
import { redact, secretValues, type MinimalLogger } from './http';

/** IntegrationTestDoc plus the `partial` flag (stored alongside; IntegrationTestDoc has no `partial` field yet). */
export type StoredIntegrationTest = IntegrationTestDoc & { partial?: boolean };

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

  function varsFor(id: IntegrationId) {
    const entry = catalogEntry(id);
    const c = byId.get(id);
    const envVars = c?.envVars ?? entry.envVars;
    const optional = new Set(c?.optionalVars ?? []);
    const set = configuredVars(env, envVars);
    const hinted = c as (Connector & { missingVars?: () => string[] }) | undefined;
    const missing = hinted?.missingVars ? hinted.missingVars() : envVars.filter((n) => !optional.has(n) && !set.includes(n));
    return { entry, envVars, set, missing, connector: c };
  }

  async function status(id: IntegrationId): Promise<IntegrationStatus> {
    const { entry, envVars, set, missing, connector } = varsFor(id);
    const settings = (await repos.integrationSettings.get(id))?.settings ?? {};
    const test = (await repos.integrationTests.get(id)) as StoredIntegrationTest | undefined;
    let state: IntegrationState;
    let stateDetail: string;

    if (set.length === 0) {
      state = 'not_configured';
      stateDetail = `Not configured — set ${envVars.filter((n) => !(connector?.optionalVars ?? []).includes(n)).join(', ')} on the API server.`;
    } else if (missing.length > 0 || (connector && !connector.isConfigured())) {
      state = 'credentials_missing';
      stateDetail = `Missing required settings: ${missing.join(', ') || 'see connector requirements'}.`;
    } else if (!connector) {
      state = 'not_configured';
      stateDetail = 'Credentials set, but no connector is available to verify them.';
    } else if (!test) {
      state = 'not_configured';
      stateDetail = UNTESTED_DETAIL;
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
      configuredVars: set,
      lastTestAt: test?.at,
      lastTestResult: test ? redact(test.result, secrets()) : undefined,
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
      const { connector, missing } = varsFor(id);
      if (!connector) throw new ApiError(400, 'NO_CONNECTOR', `No connector is available for ${id}.`);
      if (!connector.isConfigured()) {
        // Nothing to call — do not persist a fake failure; status already reports credentials_missing / not_configured.
        log.info({ integration: id, missing }, 'integration test skipped: not configured');
        return status(id);
      }
      const startedAt = clock();
      let r;
      try {
        r = await connector.test();
      } catch {
        r = { ok: false, result: 'Connection test threw unexpectedly.' };
      }
      const prev = (await repos.integrationTests.get(id)) as StoredIntegrationTest | undefined;
      const doc: StoredIntegrationTest = {
        id,
        at: startedAt.toISOString(),
        ok: r.ok === true,
        result: redact(String(r.result ?? ''), secrets()),
        rateLimited: r.rateLimited === true ? true : undefined,
        partial: r.partial === true ? true : undefined,
        lastSuccessfulSyncAt: prev?.lastSuccessfulSyncAt,
        lastSyncError: prev?.lastSyncError,
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
      const prev = (await repos.integrationSettings.get(id))?.settings ?? {};
      await repos.integrationSettings.upsert({ id, settings: { ...prev, ...settings } });
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
