/**
 * DeoDap Task Ops adapter (PDF §12.4).
 *
 * ASSUMPTION — DeoDap Task Ops has no public/published API specification. This adapter assumes:
 *   POST {TASK_OPS_BASE_URL}/api/tasks              create  → JSON with the new id (`id`, `data.id`, `task_id` or `task_ids[0]`)
 *   PUT  {TASK_OPS_BASE_URL}/api/tasks/{id}         update (when the Sentinel task already has externalTaskOpsId)
 *   POST {TASK_OPS_BASE_URL}/api/tasks/{id}/comments  { body, body_format: 'text' }
 *   Authorization: Bearer {TASK_OPS_TOKEN}
 * Field names below (title, description, assignee_group, priority, priority_bucket, deadline_at, external_ref…) must be
 * confirmed with the Task Ops owners before go-live; until then Sentinel's internal task store is the source of truth.
 */
import { TEAMS, type Issue, type Task, type TaskPriority, type TeamId } from '@sentinel/shared';
import type { Env } from '../config/env';
import type { SendResult, TaskOpsAdapter } from '../services/ports';
import { defaultFetch, httpRequest, is2xx, redact, secretValues, sendError, type FetchLike } from '../connectors/http';

/** Sentinel team → Task Ops assignee group. */
export const TASK_OPS_GROUP: Record<TeamId, string> = {
  seo: TEAMS.seo.name, // "1into2 SEO Team"
  content: TEAMS.content.name, // "1into2 Content Team"
  development: TEAMS.development.name, // "1into2 Development Team"
};

/** Sentinel P1/P2/P3 → Task Ops priority bucket (the Task Ops UI uses low/medium/high/urgent). */
export const TASK_OPS_PRIORITY: Record<TaskPriority, 'urgent' | 'high' | 'medium'> = { P1: 'urgent', P2: 'high', P3: 'medium' };

export function buildTaskOpsPayload(task: Task, issue: Issue | undefined, appBaseUrl: string | undefined) {
  const base = appBaseUrl?.replace(/\/+$/, '');
  const issueId = issue?.id ?? task.issueId;
  const fixCardUrl = base && issueId ? `${base}/issues/${encodeURIComponent(issueId)}` : undefined;
  const taskUrl = base ? `${base}/tasks/${encodeURIComponent(task.id)}` : undefined;
  const urls = task.affectedUrls.slice(0, 10);
  const lines = [
    task.description,
    '',
    issue ? `Issue ${issue.id} (${issue.severity}) — ${issue.title}` : issueId ? `Issue ${issueId}` : '',
    issue?.businessImpact ? `Business impact: ${issue.businessImpact}` : '',
    fixCardUrl ? `Fix Card: ${fixCardUrl}` : issueId ? `Fix Card: open issue ${issueId} in SEO Sentinel` : '',
    taskUrl ? `Sentinel task: ${taskUrl}` : `Sentinel task: ${task.id}`,
    task.acceptanceCriteria.length ? `\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
    urls.length ? `\nAffected URLs (${task.affectedUrls.length}):\n${urls.join('\n')}${task.affectedUrls.length > urls.length ? '\n…' : ''}` : '',
  ].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''));
  return {
    title: `[${task.priority}] ${task.title}`.slice(0, 200),
    description: lines.join('\n').trim(),
    assignee_group: TASK_OPS_GROUP[task.team],
    priority: task.priority,
    priority_bucket: TASK_OPS_PRIORITY[task.priority],
    deadline_at: task.dueAt,
    status: task.status,
    external_ref: task.id,
    source: 'deodap-seo-sentinel',
    links: [fixCardUrl && { label: 'Fix Card', url: fixCardUrl }, taskUrl && { label: 'Sentinel task', url: taskUrl }].filter(Boolean),
  };
}

function extractId(json: unknown): string | undefined {
  const j = json as Record<string, unknown> | undefined;
  if (!j || typeof j !== 'object') return undefined;
  const pick = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
  const data = j.data as Record<string, unknown> | unknown[] | undefined;
  return (
    pick(j.id) ??
    pick(j.task_id) ??
    (Array.isArray(j.task_ids) ? pick(j.task_ids[0]) : undefined) ??
    (Array.isArray(data) ? pick((data[0] as Record<string, unknown> | undefined)?.id) : pick(data?.id))
  );
}

export function createTaskOpsAdapter(deps: { env: Env; fetchImpl?: FetchLike; appBaseUrl?: string }): TaskOpsAdapter & { missingVars(): string[] } {
  const { env } = deps;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const appBaseUrl = deps.appBaseUrl ?? env.CORS_ORIGIN?.split(',')[0]?.trim();
  const missingVars = () => (['TASK_OPS_BASE_URL', 'TASK_OPS_TOKEN'] as const).filter((n) => !env[n]);
  const base = () => env.TASK_OPS_BASE_URL!.replace(/\/+$/, '');
  const headers = () => ({ authorization: `Bearer ${env.TASK_OPS_TOKEN}`, 'content-type': 'application/json', accept: 'application/json' });
  const clean = <T extends { error: string }>(e: T): T => ({ ...e, error: redact(e.error, secretValues(env)) });
  const notConfigured = () => ({ ok: false as const, error: `Task Ops not configured — missing ${missingVars().join(', ')}`, retryable: false });

  return {
    missingVars,
    isConfigured: () => missingVars().length === 0,

    async upsertTask(task, issue) {
      if (missingVars().length) return notConfigured();
      const existing = task.externalTaskOpsId;
      const url = existing ? `${base()}/api/tasks/${encodeURIComponent(existing)}` : `${base()}/api/tasks`;
      const r = await httpRequest(fetchImpl, url, { method: existing ? 'PUT' : 'POST', headers: headers(), body: JSON.stringify(buildTaskOpsPayload(task, issue, appBaseUrl)) });
      if (!is2xx(r)) return clean(sendError('Task Ops', url, r));
      const id = extractId(r.json) ?? existing;
      if (!id) return { ok: false, error: 'Task Ops accepted the request but returned no task id (response shape unconfirmed).', retryable: false };
      return { ok: true, externalId: id };
    },

    async comment(externalId, body): Promise<SendResult> {
      if (missingVars().length) return notConfigured();
      const url = `${base()}/api/tasks/${encodeURIComponent(externalId)}/comments`;
      const r = await httpRequest(fetchImpl, url, { method: 'POST', headers: headers(), body: JSON.stringify({ body: body.slice(0, 50_000), body_format: 'text' }) });
      if (!is2xx(r)) return clean(sendError('Task Ops comment', url, r));
      return { ok: true, providerMessageId: extractId(r.json) };
    },
  };
}
