/**
 * Multi-website crawl batches: one Start for up to MAX_BATCH_WEBSITES websites. Each website gets its own crawl job
 * (own id, progress, results, findings, errors and cancel) in its own workspace — a batch only groups them. How many
 * run at the same time is a server setting (CRAWLER_MAX_CONCURRENT_JOBS plus a memory check); the others are queued.
 */
import type { CrawlRun, CrawlStatus } from './types';

export const MAX_BATCH_WEBSITES = 11;

export type BatchCrawlType = 'smart' | 'full';

export interface CrawlBatchInput {
  websiteIds: string[];
  type: BatchCrawlType;
  /** Full crawl: page limit per website (null = no limit; the server's CRAWLER_MAX_PAGES cap still applies). */
  maxPages?: number | null;
  /** Full crawl: pause between requests to one website (ms); the server default when absent. */
  requestDelayMs?: number;
}

/** not_started = the website's crawl could not be created (the reason is in `error`). */
export type CrawlBatchJobStatus = CrawlStatus | 'not_started';

export interface CrawlBatchJob {
  websiteId: string;
  websiteName: string;
  domain: string;
  runId?: string;
  /** The website already had a crawl running when the batch started: that crawl is followed instead of a second one. */
  existing?: boolean;
  status: CrawlBatchJobStatus;
  error?: string;
  /** The website's crawl as it is now (progress, outcome, queue position). */
  run?: CrawlRun;
}

export interface CrawlBatch {
  id: string;
  createdAt: string;
  createdBy: string;
  type: BatchCrawlType;
  maxPages?: number | null;
  jobs: CrawlBatchJob[];
  counts: Record<CrawlBatchJobStatus, number>;
  /** Finished when no job is queued or running. */
  finished: boolean;
  /** The server's crawl slots right now (all websites, batches and single crawls together). */
  server: { running: number; waiting: number; maxRunning: number; blockedBy?: string };
}

/** What is stored for a batch (the jobs' live state is read from each website's crawl). */
export interface CrawlBatchRecord {
  id: string;
  createdAt: string;
  createdBy: string;
  type: BatchCrawlType;
  maxPages?: number | null;
  jobs: { websiteId: string; runId?: string; existing?: boolean; error?: string }[];
}
