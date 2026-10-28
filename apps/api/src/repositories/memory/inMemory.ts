import type { DocumentStore, Repositories, Repository } from '../types';
import { defaultConfig, DEFAULT_PERMISSIONS } from '@sentinel/shared';

/**
 * TEMPORARY in-memory repository (Phase 2). Not persistent: every process restart loses all data.
 * Values are deep-cloned on the way in and out so callers can never mutate stored state by reference —
 * the same semantics a database-backed implementation will have.
 */
export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  protected readonly items = new Map<string, T>();
  private seq = 0;
  /** Highest numeric suffix per id prefix seen so far (computed once per prefix, then kept up to date on writes). */
  private readonly prefixMax = new Map<string, number>();
  constructor(readonly name: string) {}

  /** Load stored items (database start-up) without treating them as new writes. */
  hydrate(list: T[]) {
    for (const it of list) { this.items.set(it.id, it); this.track(it.id); }
  }

  private track(id: string) {
    for (const [p, m] of this.prefixMax) {
      if (!id.startsWith(`${p}-`)) continue;
      const rest = id.slice(p.length + 1);
      if (/^\d+$/.test(rest) && Number(rest) > m) this.prefixMax.set(p, Number(rest));
    }
  }

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
    this.track(item.id);
    return structuredClone(item);
  }
  async update(item: T) {
    if (!this.items.has(item.id)) throw new Error(`${this.name}: ${item.id} does not exist`);
    this.items.set(item.id, structuredClone(item));
    return structuredClone(item);
  }
  async upsert(item: T) {
    this.items.set(item.id, structuredClone(item));
    this.track(item.id);
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
    let known = this.prefixMax.get(prefix);
    if (known === undefined) {
      // First id for this prefix: scan once; later writes keep the maximum current (no scan per insert).
      known = 0;
      const re = new RegExp(`^${prefix}-(\\d+)$`);
      for (const id of this.items.keys()) {
        const m = re.exec(id);
        if (m) known = Math.max(known, Number(m[1]));
      }
      this.prefixMax.set(prefix, known);
    }
    this.seq = Math.max(this.seq, known) + 1;
    return `${prefix}-${String(this.seq).padStart(width, '0')}`;
  }
}

export class InMemoryDocument<T> implements DocumentStore<T> {
  protected value: T;
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

/** How a repository set is built: plain memory, or memory written through to PostgreSQL (repositories/postgres). */
export interface RepositoryFactory {
  repo<T extends { id: string }>(name: string): InMemoryRepository<T>;
  doc<T>(name: string, initial: T): InMemoryDocument<T>;
  storage: Repositories['storage'];
}

const MEMORY: RepositoryFactory = {
  repo: <T extends { id: string }>(n: string) => new InMemoryRepository<T>(n),
  doc: <T>(_n: string, initial: T) => new InMemoryDocument(initial),
  storage: { kind: 'in_memory', persistent: false, note: 'TEMPORARY in-memory storage: all data is lost when the API process restarts. Set DATABASE_URL to keep it in PostgreSQL.' },
};

export function createInMemoryRepositories(now = new Date(), f: RepositoryFactory = MEMORY): Repositories {
  const r = <T extends { id: string }>(n: string) => f.repo<T>(n);
  return {
    storage: f.storage,
    employees: r('employees'), credentials: r('credentials'), resetTokens: r('resetTokens'), sessions: r('sessions'),
    issues: r('issues'), groups: r('groups'), exclusions: r('exclusions'), tasks: r('tasks'), verifications: r('verifications'),
    crawls: r('crawls'), crawlUrls: r('crawlUrls'), crawlBatches: r('crawlBatches'), sitemapDiffs: r('sitemapDiffs'), schedules: r('schedules'), snapshots: r('snapshots'), crawlStates: r('crawlStates'),
    sitePages: r('sitePages'), pageTexts: r('pageTexts'), notifications: r('notifications'), deliveries: r('deliveries'), audit: r('audit'),
    rules: r('rules'), aiFlags: r('aiFlags'), briefs: r('briefs'), keywordGaps: r('keywordGaps'), opportunities: r('opportunities'),
    mentions: r('mentions'), prospects: r('prospects'), disavow: r('disavow'), integrationSettings: r('integrationSettings'),
    integrationTests: r('integrationTests'), integrationSecrets: r('integrationSecrets'),
    monitorState: r('monitorState'), monitorPages: r('monitorPages'), monitorEvents: r('monitorEvents'),
    config: f.doc('config', defaultConfig(now)),
    permissions: f.doc('permissions', structuredClone(DEFAULT_PERMISSIONS)),
    metrics: f.doc('metrics', {
      source: 'live', siteSize: 0, healthHistory: [], cwv: [], indexation: [], visibility: [], aiTrend: [], aiPrompts: [], backlinks: [], refTrend: [],
      competitors: [], localHealth: { napConsistency: [], gbp: null }, striking: [], ctrRewrites: [], clusters: [], contentScores: [], criticalAlerts: [], errors: [],
    }),
  };
}
