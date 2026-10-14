import type { CrawlRun, CrawlStatus, CrawlType, VerificationAttempt } from '@sentinel/shared';
import { Badge, type Tone } from '@/components/ui/primitives';

export const CRAWL_TYPE_LABELS: Record<CrawlType, string> = { full: 'Full crawl', smart: 'Smart crawl', reverify: 'Re-verification crawl' };
export const CRAWL_TRIGGER_LABELS: Record<CrawlRun['trigger'], string> = { schedule: 'Schedule', manual: 'Manual', webhook: 'Webhook', verification: 'Verification' };

const STATUS_TONE: Record<CrawlStatus, Tone> = { scheduled: 'neutral', queued: 'neutral', running: 'signal', completed: 'ok', failed: 'crit', cancelled: 'neutral' };
const STATUS_LABEL: Record<CrawlStatus, string> = { scheduled: 'Scheduled', queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

/**
 * Crawl status. A simulated run that "completed" fetched nothing, so it is labelled
 * "Simulated — no URLs fetched" rather than a green Completed.
 */
export function CrawlStatusBadge({ run }: { run: Pick<CrawlRun, 'status' | 'source'> }) {
  if (run.source === 'simulated' && run.status === 'completed') return <Badge tone="demo" title="Simulated run: mock mode makes no HTTP requests and produces no findings.">Simulated — no URLs fetched</Badge>;
  return <Badge tone={STATUS_TONE[run.status]} icon={run.status === 'running' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal" aria-hidden /> : undefined}>{STATUS_LABEL[run.status]}</Badge>;
}

export function HttpStatusBadge({ status, error }: { status: number | null; error?: string }) {
  if (status === null) return <Badge tone="crit" title={error}>No response</Badge>;
  const tone: Tone = status >= 500 ? 'crit' : status >= 400 ? 'crit' : status >= 300 ? 'med' : 'ok';
  return <Badge tone={tone} className="font-mono">{status}</Badge>;
}

const OUTCOME_TONE: Record<VerificationAttempt['outcome'], Tone> = { passed: 'ok', failed: 'crit', pending_data: 'neutral', error: 'med' };
const OUTCOME_LABEL: Record<VerificationAttempt['outcome'], string> = { passed: 'Passed', failed: 'Failed', pending_data: 'Pending data', error: 'Error' };
export function VerificationOutcomeBadge({ outcome }: { outcome: VerificationAttempt['outcome'] }) {
  return <Badge tone={OUTCOME_TONE[outcome]} title={outcome === 'pending_data' ? 'The data source needed to verify is not connected or the re-check has not run yet — not a pass.' : undefined}>{OUTCOME_LABEL[outcome]}</Badge>;
}

export const VERIFICATION_METHOD_LABELS: Record<VerificationAttempt['method'], string> = {
  automated_recrawl: 'Automated re-crawl',
  connector_check: 'Connector check',
  manual_attestation: 'Manual attestation',
};
export const VERIFICATION_OUTCOME_LABELS = OUTCOME_LABEL;
