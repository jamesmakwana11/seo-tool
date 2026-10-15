import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, type SentinelConfig } from '@sentinel/shared';
import { createGoCrawlEngine, type GoEngineOptions } from '../../src/gocrawl/engine';
import { locateBinaries } from '../../src/gocrawl/binaries';
import { silentLog, UA } from '../crawler/helpers';

/** Native binaries built by `npm run build:native` (bin/) or by the toolchains (services/…). */
export const BINS = locateBinaries({ CRAWLER_GO_BIN: process.env.CRAWLER_GO_BIN, TEXTCORE_BIN: process.env.TEXTCORE_BIN }, true);
export const HAVE_GO = !!BINS.crawler.path && !BINS.crawler.problem;
export const HAVE_RUST = !!BINS.textCore.path && !BINS.textCore.problem;

export function tmpWork(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-gotest-'));
}

export function makeGoEngine(baseUrl: string, over: Partial<GoEngineOptions> = {}, cfgOver?: (c: SentinelConfig) => void) {
  const config = defaultConfig(new Date('2026-10-12T00:00:00Z'));
  cfgOver?.(config);
  return createGoCrawlEngine({
    baseUrl, allowLive: false, userAgent: UA, timeoutMs: 800, concurrency: 6, respectRobots: true, retries: 0,
    thresholds: config.thresholds, config, log: silentLog, now: () => new Date('2026-10-12T00:00:00Z'),
    allowLoopback: true, workDir: tmpWork(), env: { CRAWLER_GO_BIN: process.env.CRAWLER_GO_BIN, TEXTCORE_BIN: process.env.TEXTCORE_BIN },
    ...over,
  });
}
