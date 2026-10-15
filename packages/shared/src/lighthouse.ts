/** Lighthouse lab audits and rendered-page checks run by the API server (one at a time, in a separate process). */

export type LighthouseFormFactor = 'mobile' | 'desktop';

export interface LighthouseMetric {
  value: number | null;
  display: string | null;
  score: number | null;
}

export interface LighthouseSummary {
  lighthouseVersion: string;
  fetchTime: string;
  finalUrl: string;
  formFactor: LighthouseFormFactor;
  userAgent?: string;
  runtimeError?: string;
  runWarnings: string[];
  /** 0–100, null when a category could not be scored. */
  scores: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
  metrics: Partial<Record<'fcp' | 'lcp' | 'tbt' | 'cls' | 'si' | 'tti', LighthouseMetric>>;
  opportunities: { id: string; title: string; savingsMs: number; savingsBytes?: number; display?: string }[];
  seoFailures: { id: string; title: string; score: number | null; display?: string }[];
  accessibilityFailures: { id: string; title: string; score: number | null; display?: string }[];
  ms: number;
}

/** What the server's raw HTML says vs what the browser shows after JavaScript runs. */
export interface RenderComparison {
  status: number | null;
  ms: number;
  fields: { field: string; raw: string; rendered: string; differs: boolean }[];
  /** Fields where the rendered page differs from the HTML search engines fetch first. */
  differences: number;
}

export interface LighthouseRun {
  id: string;
  url: string;
  kind: 'lighthouse' | 'render';
  formFactor?: LighthouseFormFactor;
  status: 'queued' | 'running' | 'completed' | 'failed';
  requestedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: LighthouseSummary;
  render?: RenderComparison;
}

export interface LighthouseStatus {
  /** Audits can run on this server now. */
  available: boolean;
  /** What is missing or why runs are refused (package, browser, memory). */
  problems: string[];
  lighthouseVersion?: string;
  chromePath?: string;
  /** Free memory a run needs (MB) and what the budget leaves now. */
  memoryNeededMB: number;
  memoryFreeMB?: number;
  queued: number;
  running?: string;
}
