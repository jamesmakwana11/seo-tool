import type { DocumentStore, Repositories, Repository } from '../types';
import { defaultConfig, DEFAULT_PERMISSIONS } from '@sentinel/shared';

/**
 * TEMPORARY in-memory repository (Phase 2). Not persistent: every process restart loses all data.
 * Values are deep-cloned on the way in and out so callers can never mutate stored state by reference —
 * the same semantics a database-backed implementation will have.
 */
export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly items = new Map<string, T>();
  private seq = 0;
  constructor(private readonly name: string) {}

  async get(id: string) {
    const v = this.items.get(id);
    return v ? structuredClone(v) : undefined;
  }
  async list() {
    return [...this.items.values()].map((v) => structuredClone(v));
  }
  async where(filter: Partial<Record<keyof T, unknown>>) {
    const entries = Object.entries(filter) as [keyof T, unknown][];
    return (await this.list()).filter((it) => entries.every(([k, v]) => it[k] === v));
  }
  async insert(item: T) {
    if (this.items.has(item.id)) throw new Error(`${this.name}: duplicate id ${item.id}`);
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  async update(item: T) {
    if (!this.items.has(item.id)) throw new Error(`${this.name}: ${item.id} does not exist`);
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  async upsert(item: T) {
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  async delete(id: string) {
    return this.items.delete(id);
  }
  async count() {
    return this.items.size;
  }
  /** Next sequential id with a prefix, never colliding with existing (e.g. seeded) ids. */
  async nextId(prefix: string, width = 4) {
    let max = this.seq;
    for (const id of this.items.keys()) {
      const m = id.match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, Number(m[1]));
    }
    this.seq = max + 1;
    return `${prefix}-${String(this.seq).padStart(width, '0')}`;
  }
}

export class InMemoryDocument<T> implements DocumentStore<T> {
  private value: T;
  constructor(initial: T) {
    this.value = structuredClone(initial);
  }
  async get() {
    return structuredClone(this.value);
  }
  async set(v: T) {
    this.value = structuredClone(v);
    return structuredClone(v);
  }
}

export function createInMemoryRepositories(now = new Date()): Repositories {
  const r = <T extends { id: string }>(n: string) => new InMemoryRepository<T>(n);
  return {
    storage: { kind: 'in_memory', persistent: false, note: 'TEMPORARY in-memory repositories (Phase 2). All data is lost when the API process restarts. A database will be added only after explicit authorization (Phase 3).' },
    employees: r('employees'), credentials: r('credentials'), resetTokens: r('resetTokens'), sessions: r('sessions'),
    issues: r('issues'), groups: r('groups'), exclusions: r('exclusions'), tasks: r('tasks'), verifications: r('verifications'),
    crawls: r('crawls'), crawlUrls: r('crawlUrls'), sitemapDiffs: r('sitemapDiffs'), schedules: r('schedules'), snapshots: r('snapshots'), crawlStates: r('crawlStates'),
    sitePages: r('sitePages'), pageTexts: r('pageTexts'), notifications: r('notifications'), deliveries: r('deliveries'), audit: r('audit'),
    rules: r('rules'), aiFlags: r('aiFlags'), briefs: r('briefs'), keywordGaps: r('keywordGaps'), opportunities: r('opportunities'),
    mentions: r('mentions'), prospects: r('prospects'), disavow: r('disavow'), integrationSettings: r('integrationSettings'),
    integrationTests: r('integrationTests'),
    config: new InMemoryDocument(defaultConfig(now)),
    permissions: new InMemoryDocument(structuredClone(DEFAULT_PERMISSIONS)),
    metrics: new InMemoryDocument({
      source: 'live', siteSize: 0, healthHistory: [], cwv: [], indexation: [], visibility: [], aiTrend: [], aiPrompts: [], backlinks: [], refTrend: [],
      competitors: [], localHealth: { napConsistency: [], gbp: null }, striking: [], ctrRewrites: [], clusters: [], contentScores: [], criticalAlerts: [], errors: [],
    }),
  };
}
