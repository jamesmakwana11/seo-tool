import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { ApiError } from '@sentinel/shared';
import { API_MODE } from '@/api/client';
import { Button, Panel } from '@/components/ui/primitives';

/**
 * Full-page error for a detail screen (issue, task, crawl run, brief). The title is the page's <h1>, the explanation says
 * what actually happened in the current API mode, and Retry is offered only when retrying could help.
 */
export function DetailError({ error, what, id, back, onRetry, forbidden }: {
  error: unknown;
  /** Singular noun shown to people, e.g. "Crawl run". */
  what: string;
  id: string;
  back: { to: string; label: string };
  onRetry: () => unknown;
  /** Custom copy for 403 (e.g. a task owned by another team). */
  forbidden?: { title: string; detail: string };
}) {
  const status = error instanceof ApiError ? error.status : 0;
  let title: string;
  let detail: ReactNode;
  let retry = false;
  if (status === 404) {
    title = `${what} ${id} not found`;
    detail = API_MODE === 'mock'
      ? `${what} ${id} doesn't exist. It may have been mistyped, or created in an earlier session — DEMO data lives in this browser and resets on reload.`
      : `${what} ${id} doesn't exist. It may have been mistyped or removed. The API keeps data in temporary memory, so anything created before the server last restarted is gone.`;
  } else if (status === 403) {
    title = forbidden?.title ?? `You don't have access to this ${what.toLowerCase()}`;
    detail = forbidden?.detail ?? (error as ApiError).message;
  } else {
    title = `This ${what.toLowerCase()} could not load`;
    detail = error instanceof Error ? error.message : String(error);
    retry = true;
  }
  return (
    <Panel>
      <div className="flex flex-col items-center justify-center px-6 py-10 text-center" role="alert">
        <AlertTriangle className="mb-2 h-7 w-7 text-crit-ink" aria-hidden="true" />
        <h1 className="text-base font-semibold text-ink">{title}</h1>
        <p className="mt-1 max-w-md text-sm text-muted">{detail}</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          {retry && <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => onRetry()}>Retry</Button>}
          <Link to={back.to} className="text-sm text-signal hover:underline">{back.label}</Link>
        </div>
      </div>
    </Panel>
  );
}
