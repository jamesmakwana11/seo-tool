/**
 * Multi-website crawl batches: one request starts a crawl for each of up to MAX_BATCH_WEBSITES websites.
 *
 * Each website's crawl is created by that website's own crawl service, in that website's workspace — so its progress,
 * page results, issues, findings and errors stay with that website and can never mix with another's. All of them are
 * stored as jobs at once (none is dropped); how many run at the same time is decided server-wide by jobs/crawlSlots.ts
 * (CRAWLER_MAX_CONCURRENT_JOBS and the memory in use), the rest wait in the queue in the order of the batch. A website's
 * crawl is cancelled on its own (the others continue); the batch can also cancel everything still queued or running.
 * Every crawl keeps the website's own URL restriction, robots.txt, rate limiting, retries and SSRF protection.
 */
import crypto from 'node:crypto';
import {
  ApiError, CRAWL_LIMITS, MAX_BATCH_WEBSITES, defaultCrawlOptions,
  type CrawlBatch, type CrawlBatchInput, type CrawlBatchJob, type CrawlBatchJobStatus, type CrawlBatchRecord, type CrawlRun,
} from '@sentinel/shared';
import { slotStats } from './jobs/crawlSlots';
import { badRequest, notFound } from './lib/errors';
import { audit, need, type Actor } from './services/context';
import type { Workspaces } from './websites';

const KEEP_BATCHES = 50;

export function createBatchService(ws: Workspaces) {
  const primary = ws.primary;
  const repo = () => primary.repos.crawlBatches;
  const iso = () => primary.clock().toISOString();

  function siteOf(id: string) {
    const e = ws.entries().find((x) => x.website.id === id);
    if (!e) throw notFound(`Website ${id}`);
    return e;
  }

  /** The batch with each website's crawl as it is now. */
  async function view(rec: CrawlBatchRecord): Promise<CrawlBatch> {
    const counts: Record<CrawlBatchJobStatus, number> = { scheduled: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, not_started: 0 };
    const jobs: CrawlBatchJob[] = [];
    for (const j of rec.jobs) {
      const e = ws.entries().find((x) => x.website.id === j.websiteId);
      const raw = e && j.runId ? await e.container.repos.crawls.get(j.runId) : undefined;
      const run = raw && e ? e.container.services.crawls.withQueue(raw) : undefined;
      const status: CrawlBatchJobStatus = run ? run.status : 'not_started';
      counts[status]++;
      jobs.push({
        websiteId: j.websiteId, websiteName: e?.website.name ?? j.websiteId, domain: e?.website.domain ?? '', runId: j.runId, existing: j.existing,
        status, error: j.error ?? (run && (run.status === 'failed' || run.status === 'cancelled') ? run.error : undefined), run,
      });
    }
    const st = slotStats();
    return {
      ...rec, jobs, counts, finished: counts.queued + counts.running === 0,
      server: { running: st.running, waiting: st.waiting, maxRunning: primary.env.CRAWLER_MAX_CONCURRENT_JOBS, blockedBy: st.blockedBy },
    };
  }

  async function record(id: string): Promise<CrawlBatchRecord> {
    const rec = await repo().get(id);
    if (!rec) throw notFound(`Crawl batch ${id}`);
    return rec;
  }

  return {
    async start(actor: Actor, input: CrawlBatchInput): Promise<CrawlBatch> {
      await ws.ready();
      await need(primary.ctx, actor, 'crawls.run');
      const ids = Array.isArray(input?.websiteIds) ? input.websiteIds.map(String) : [];
      if (!ids.length) throw badRequest('Choose at least one website.');
      if (new Set(ids).size !== ids.length) throw badRequest('Each website can be in a batch only once.');
      if (ids.length > MAX_BATCH_WEBSITES) throw badRequest(`A batch can crawl at most ${MAX_BATCH_WEBSITES} websites; ${ids.length} were chosen.`);
      if (input.type !== 'smart' && input.type !== 'full') throw badRequest('Crawl type must be smart or full.');
      const unknown = ids.filter((id) => !ws.entries().some((e) => e.website.id === id));
      if (unknown.length) throw badRequest(`Unknown website${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
      if (input.maxPages !== undefined && input.maxPages !== null && (!Number.isInteger(input.maxPages) || input.maxPages < 1)) throw badRequest('Maximum pages must be a whole number of at least 1, or empty for no limit.');
      const rec: CrawlBatchRecord = {
        id: `BAT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, createdAt: iso(), createdBy: actor.name || actor.id, type: input.type,
        ...(input.type === 'full' ? { maxPages: input.maxPages ?? null } : {}), jobs: [],
      };
      // Every website's job is created here, in the order chosen; each is queued server-wide and starts when there is room.
      for (const id of ids) {
        const { container } = siteOf(id);
        const crawls = container.services.crawls;
        try {
          let options: unknown;
          if (input.type === 'full') {
            const st = await crawls.status(actor);
            const o = defaultCrawlOptions(st.siteUrl, st.maxPagesCap);
            options = {
              ...o, maxPages: input.maxPages === undefined ? o.maxPages : input.maxPages,
              requestDelayMs: input.requestDelayMs ?? Math.max(st.requestDelayMs, CRAWL_LIMITS.requestDelayMs.min),
            };
          }
          const run: CrawlRun = await crawls.startManual(actor, input.type, options, rec.id);
          rec.jobs.push({ websiteId: id, runId: run.id });
        } catch (e) {
          const err = e as ApiError;
          const runId = (err.details as { runId?: string } | undefined)?.runId;
          if (err.code === 'CRAWL_ALREADY_RUNNING' && runId) rec.jobs.push({ websiteId: id, runId, existing: true, error: `A crawl of this website (${runId}) was already running; it is followed here instead of starting a second one.` });
          else rec.jobs.push({ websiteId: id, error: err.message || 'The crawl could not be created.' });
        }
      }
      await repo().insert(rec);
      for (const old of (await repo().list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(KEEP_BATCHES)) await repo().delete(old.id);
      await audit(primary.ctx, actor, 'crawl.batch_start', 'crawl', rec.id, `Started a ${input.type} crawl batch of ${ids.length} website${ids.length === 1 ? '' : 's'} (${rec.jobs.filter((j) => j.runId && !j.existing).length} new crawls)`);
      return view(rec);
    },

    async list(actor: Actor): Promise<CrawlBatch[]> {
      await need(primary.ctx, actor, 'crawls.view');
      const recs = (await repo().list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
      return Promise.all(recs.map(view));
    },

    async get(actor: Actor, id: string): Promise<CrawlBatch> {
      await need(primary.ctx, actor, 'crawls.view');
      return view(await record(id));
    },

    /** Cancels one website's crawl of the batch; the other websites' crawls continue. */
    async cancelJob(actor: Actor, id: string, websiteId: string): Promise<CrawlBatch> {
      const rec = await record(id);
      const j = rec.jobs.find((x) => x.websiteId === websiteId);
      if (!j?.runId) throw notFound(`A crawl of website ${websiteId} in batch ${id}`);
      await siteOf(websiteId).container.services.crawls.cancel(actor, j.runId);
      return view(rec);
    },

    /** Cancels every crawl of the batch that is still queued or running. */
    async cancelAll(actor: Actor, id: string): Promise<CrawlBatch> {
      await need(primary.ctx, actor, 'crawls.run');
      const rec = await record(id);
      // Queued ones first, so none of them starts while the running ones stop.
      const jobs = [...rec.jobs].filter((j) => j.runId && !j.existing);
      const state = await Promise.all(jobs.map(async (j) => ({ j, run: await siteOf(j.websiteId).container.repos.crawls.get(j.runId!) })));
      const order = state.filter((x) => x.run?.status === 'queued').concat(state.filter((x) => x.run?.status === 'running'));
      await Promise.all(order.map(({ j }) => siteOf(j.websiteId).container.services.crawls.cancel(actor, j.runId!).catch(() => undefined)));
      return view(rec);
    },
  };
}
export type BatchService = ReturnType<typeof createBatchService>;
