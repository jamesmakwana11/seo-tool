import type { Request } from 'express';
import type { AuditModule, CrawlType, IntegrationId, Role } from '@sentinel/shared';
import { badRequest } from '../lib/errors';
import type { Container } from '../container';
import { need, type Actor } from '../services/context';
import { isSyncId, runSync, SYNC_IDS } from '../sync';
import { handleOAuthCallback } from '../shopify/service';

export interface ApiRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  description: string;
  permission?: string;
  public?: boolean;
  /** true when the handler writes the response itself (e.g. file download). */
  raw?: boolean;
  status?: number;
  handle: (req: Request) => Promise<unknown> | unknown;
}

const actorOf = (req: Request): Actor => req.actor!;
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.length) throw badRequest(`${name} is required.`);
  return v;
};
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const prm = (req: Request, k: string): string => { const v = req.params[k]; return Array.isArray(v) ? v[0] : (v ?? ''); };
const num = (v: unknown, def: number): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : def;
};
const arr = <T = string>(v: unknown): T[] | undefined => (Array.isArray(v) ? (v as T[]) : typeof v === 'string' && v ? (v.split(',') as unknown as T[]) : undefined);

/** Translate IssueFilter query params (arrays arrive comma-separated over the wire). */
function issueFilter(q: Request['query']): import('@sentinel/shared').IssueFilter {
  return {
    q: optStr(q.q), severity: arr(q.severity), module: arr<AuditModule>(q.module), status: arr(q.status), team: arr(q.team), allocatorId: optStr(q.allocatorId),
    template: arr(q.template), tier: arr(q.tier)?.map(Number) as (1 | 2 | 3)[] | undefined, delta: arr(q.delta), checkId: optStr(q.checkId), crawlRunId: optStr(q.crawlRunId),
    includeSuperseded: q.includeSuperseded === 'true', sort: optStr(q.sort) as never, dir: optStr(q.dir) as never,
    page: q.page ? num(q.page, 1) : undefined, pageSize: q.pageSize ? num(q.pageSize, 25) : undefined,
  } as import('@sentinel/shared').IssueFilter;
}
/** Register one route per SentinelApi method. Order: auth → dashboard → modules → issues → tasks → crawls → opportunities → off-page → AI → reports → notifications → people → config → audit/system/search/diagnostics. */
export function registerRoutes(routes: ApiRoute[], c: Container) {
  const { services } = c;
  const { auth, tasks, issues, rules, crawls, changes, captures, imageAudits, reports, insights, admin, lighthouse, shopify } = services;
  const add = (r: ApiRoute) => routes.push(r);

  // -------------------------------------------------------------- auth
  add({ method: 'post', path: '/api/auth/login', description: 'Sign in', public: true, handle: (req) => auth.login(str(req.body.email, 'email'), str(req.body.password, 'password')) });
  add({ method: 'post', path: '/api/auth/preview', description: 'DEVELOPMENT role preview', public: true, handle: (req) => auth.previewAs(str(req.body.role, 'role') as Role) });
  add({ method: 'post', path: '/api/auth/logout', description: 'Sign out', public: true, raw: false, handle: async (req) => { const h = req.header('Authorization'); await auth.logout(h?.startsWith('Bearer ') ? h.slice(7) : undefined); return { ok: true }; } });
  add({ method: 'get', path: '/api/auth/me', description: 'Current session user', handle: async (req) => (await auth.authenticate(req.token)).user });
  add({ method: 'post', path: '/api/auth/request-reset', description: 'Request a password reset', public: true, handle: (req) => auth.requestPasswordReset(str(req.body.email, 'email')) });
  add({ method: 'post', path: '/api/auth/reset', description: 'Complete a password reset', public: true, handle: (req) => auth.resetPassword(str(req.body.token, 'token'), str(req.body.newPassword, 'newPassword')) });
  add({ method: 'patch', path: '/api/auth/profile', description: 'Update own profile', handle: async (req) => auth.updateProfile(actorOf(req), req.body ?? {}, actorOf(req).demo) });

  // -------------------------------------------------------------- dashboard & health
  add({ method: 'get', path: '/api/dashboard', permission: 'dashboard.view', description: 'Dashboard aggregates', handle: (req) => insights.dashboard(actorOf(req)) });
  add({ method: 'get', path: '/api/health/history', permission: 'dashboard.view', description: 'Health score history', handle: (req) => insights.healthHistory(actorOf(req), num(req.query.days, 30)) });
  add({ method: 'get', path: '/api/health/score', permission: 'dashboard.view', description: 'Current health score', handle: (req) => insights.healthScore(actorOf(req)) });

  // -------------------------------------------------------------- checks & modules
  add({ method: 'get', path: '/api/checks', permission: 'modules.view', description: 'Check library', handle: (req) => insights.listChecks(actorOf(req)) });
  add({ method: 'get', path: '/api/modules/:module', permission: 'modules.view', description: 'Module detail', handle: (req) => insights.module(actorOf(req), prm(req, 'module') as AuditModule) });
  add({ method: 'get', path: '/api/cwv', permission: 'modules.view', description: 'Core Web Vitals', handle: (req) => insights.cwv(actorOf(req)) });
  add({ method: 'get', path: '/api/content-scores', permission: 'modules.view', description: 'Content scores', handle: (req) => insights.contentScores(actorOf(req)) });

  // -------------------------------------------------------------- issues
  add({ method: 'get', path: '/api/issues', permission: 'issues.view', description: 'Issues board', handle: (req) => issues.list(actorOf(req), issueFilter(req.query)) });
  add({ method: 'get', path: '/api/issues/groups', permission: 'issues.view', description: 'Template-level issue groups', handle: (req) => issues.listGroups(actorOf(req)) });
  add({ method: 'get', path: '/api/issues/exclusions', permission: 'issues.view', description: 'Not-an-issue exclusions', handle: (req) => issues.listExclusions(actorOf(req)) });
  add({ method: 'delete', path: '/api/issues/exclusions/:id', permission: 'issues.manage_exclusions', description: 'Remove an exclusion', handle: async (req) => { await issues.removeExclusion(actorOf(req), prm(req, 'id')); return { ok: true }; } });
  add({ method: 'get', path: '/api/issues/allocation-history', permission: 'issues.view', description: 'Allocation history', handle: (req) => issues.allocationHistory(actorOf(req)) });
  add({ method: 'get', path: '/api/issues/:id', permission: 'issues.view', description: 'Issue detail + Fix Card', handle: (req) => issues.get(actorOf(req), prm(req, 'id')) });
  add({ method: 'post', path: '/api/issues/:id/allocate', permission: 'issues.allocate', description: 'One-tap allocation', handle: (req) => issues.allocate(actorOf(req), prm(req, 'id'), str(req.body.team, 'team') as never, optStr(req.body.reason)) });
  add({ method: 'post', path: '/api/issues/groups/:groupId/allocate', permission: 'issues.allocate', description: 'Bulk allocate a template group', handle: (req) => issues.bulkAllocate(actorOf(req), prm(req, 'groupId'), str(req.body.team, 'team') as never, optStr(req.body.reason)) });
  add({ method: 'post', path: '/api/issues/:id/acknowledge', permission: 'issues.view', description: 'Acknowledge an issue', handle: (req) => issues.acknowledge(actorOf(req), prm(req, 'id')) });
  add({ method: 'post', path: '/api/issues/:id/not-an-issue', permission: 'issues.mark_not_issue', description: 'Mark not an issue', handle: (req) => issues.markNotAnIssue(actorOf(req), prm(req, 'id'), str(req.body.reason, 'reason'), !!req.body.addExclusion) });
  add({ method: 'post', path: '/api/issues/:id/reopen', permission: 'issues.allocate', description: 'Reopen an issue', handle: (req) => issues.reopen(actorOf(req), prm(req, 'id'), str(req.body.reason, 'reason')) });
  add({ method: 'post', path: '/api/issues/:id/status', permission: 'issues.update_status', description: 'Start work / mark fixed (never verifies)', handle: async (req) => { const id = prm(req, 'id'); const action = str(req.body.action, 'action'); if (action !== 'start' && action !== 'mark_fixed') throw badRequest('action must be start or mark_fixed.'); await tasks.issueAction(actorOf(req), id, action, optStr(req.body.note)); return issues.get(actorOf(req), id); } });
  add({ method: 'post', path: '/api/issues/:id/verify', permission: 'issues.verify', description: 'System re-verification of a fixed issue', handle: async (req) => { const id = prm(req, 'id'); const attempt = await tasks.verifyIssue(actorOf(req), id); return { detail: await issues.get(actorOf(req), id), attempt }; } });
  add({ method: 'post', path: '/api/issues/:id/approve-proposal', permission: 'fixcards.approve_proposal', description: 'Record human approval of a proposed change', handle: (req) => issues.approveProposal(actorOf(req), prm(req, 'id'), optStr(req.body.note) ?? '') });


  // -------------------------------------------------------------- crawls
  add({ method: 'get', path: '/api/crawls', permission: 'crawls.view', description: 'Crawl runs', handle: (req) => crawls.list(actorOf(req)) });
  add({ method: 'get', path: '/api/crawls/schedules', permission: 'crawls.view', description: 'Crawl schedules', handle: (req) => crawls.listSchedules(actorOf(req)) });
  add({ method: 'patch', path: '/api/crawls/schedules/:id', permission: 'crawls.configure', description: 'Update a crawl schedule', handle: (req) => crawls.updateSchedule(actorOf(req), prm(req, 'id'), req.body ?? {}) });
  add({ method: 'get', path: '/api/crawls/verifications', permission: 'crawls.view', description: 'Verification attempts', handle: (req) => crawls.listVerifications(actorOf(req)) });
  add({ method: 'get', path: '/api/crawls/status', permission: 'crawls.view', description: 'Whether this website can be crawled live, and the limits that apply', handle: (req) => crawls.status(actorOf(req)) });
  add({ method: 'get', path: '/api/crawls/:id', permission: 'crawls.view', description: 'Crawl detail', handle: (req) => crawls.get(actorOf(req), prm(req, 'id')) });
  add({
    method: 'get', path: '/api/crawls/:id/export', permission: 'crawls.view', description: 'Download the current (in-memory) results of a crawl as CSV or JSON', raw: true,
    handle: async (req) => {
      const f = await crawls.exportResults(actorOf(req), prm(req, 'id'), String(req.query.format ?? 'csv'));
      const res = req.res!;
      res.setHeader('Content-Type', f.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.-]/g, '_')}"`);
      res.setHeader('Cache-Control', 'no-store');
      if (f.content !== undefined) {
        res.status(200).send(f.content);
        return;
      }
      // Large runs: streamed in chunks with back-pressure (the file is never built in memory).
      res.status(200);
      for await (const chunk of f.stream!) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise<void>((r) => { res.once('drain', () => r()); res.once('close', () => r()); });
      }
      res.end();
    },
  });
  add({
    method: 'get', path: '/api/crawls/:id/pages', permission: 'crawls.view',
    description: 'Page rows of a crawl with their audit score, paged on the server (query: offset, limit ≤ 500, q, status, indexable, problem, crawlState, source, template, score = poor/fair/good/none, sort incl. score, dir)',
    handle: (req) => crawls.pages(actorOf(req), prm(req, 'id'), {
      offset: num(req.query.offset, 0), limit: num(req.query.limit, 50), q: optStr(req.query.q), status: optStr(req.query.status) as never, indexable: optStr(req.query.indexable) as never,
      problem: optStr(req.query.problem) as never, crawlState: optStr(req.query.crawlState) as never, source: optStr(req.query.source), template: optStr(req.query.template), score: optStr(req.query.score) as never, check: optStr(req.query.check),
      sort: optStr(req.query.sort) as never, dir: optStr(req.query.dir) as never,
    }),
  });
  // ---- Change Monitor (snapshots on disk; lists paged and filtered on the server)
  const changeQuery = (req: { query: Record<string, unknown> }) => ({
    kind: optStr(req.query.kind) as never, field: optStr(req.query.field) as never, confidence: optStr(req.query.confidence) as never,
    q: optStr(req.query.q), template: optStr(req.query.template), page: num(req.query.page, 1), pageSize: num(req.query.pageSize, 50),
  });
  add({ method: 'get', path: '/api/changes/status', permission: 'crawls.view', description: 'Change Monitor: baseline, recorded crawls, storage folder and retention', handle: (req) => changes.status(actorOf(req)) });
  add({ method: 'get', path: '/api/changes/runs/:id', permission: 'crawls.view', description: 'Change summary of a crawl (id = crawl id, snapshot id or "latest")', handle: (req) => changes.summary(actorOf(req), prm(req, 'id')) });
  add({
    method: 'get', path: '/api/changes/runs/:id/urls', permission: 'crawls.view',
    description: 'Changed / new / removed / failed / unchanged / unchecked URLs of a crawl, paged on the server (query: kind, field, confidence, q, template, page, pageSize ≤ 200)',
    handle: (req) => changes.list(actorOf(req), prm(req, 'id'), changeQuery(req)),
  });
  add({ method: 'get', path: '/api/changes/runs/:id/url', permission: 'crawls.view', description: 'One URL\'s change record with old / new values, evidence and its open issues (query: url)', handle: (req) => changes.detail(actorOf(req), prm(req, 'id'), String(req.query.url ?? '')) });
  add({ method: 'get', path: '/api/changes/for-url', permission: 'crawls.view', description: 'This URL\'s change record in the latest crawl that was compared with the baseline (query: url); null when there is none', handle: async (req) => ({ change: await changes.latestChange(String(req.query.url ?? '')) }) });
  add({ method: 'post', path: '/api/changes/issues', permission: 'crawls.view', description: 'Open issues on a page of URLs (body: urls, at most 200)', handle: (req) => changes.issuesFor(actorOf(req), Array.isArray(req.body?.urls) ? req.body.urls.map(String) : []) });
  add({
    method: 'get', path: '/api/changes/runs/:id/export', permission: 'crawls.view', description: 'Download a crawl\'s change records as CSV or JSON (same filters as the list), streamed', raw: true,
    handle: async (req) => {
      const f = await changes.export(actorOf(req), prm(req, 'id'), String(req.query.format ?? 'csv'), { ...changeQuery(req), page: undefined, pageSize: undefined });
      const res = req.res!;
      res.setHeader('Content-Type', f.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.-]/g, '_')}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200);
      for await (const chunk of f.stream) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise<void>((r) => { res.once('drain', () => r()); res.once('close', () => r()); });
      }
      res.end();
    },
  });
  // ---- Visual comparison + HTML / asset differences (screenshots taken by a real browser; never made up)
  // -------------------------------------------------------------- Image Audit (separate from crawling)
  const imageQuery = (req: Request): import('@sentinel/shared').ImageAuditQuery => ({
    state: optStr(req.query.state) as never, issue: optStr(req.query.issue) as never, q: optStr(req.query.q), sort: optStr(req.query.sort) as never, dir: optStr(req.query.dir) as never,
    offset: req.query.offset ? num(req.query.offset, 0) : undefined, limit: req.query.limit ? num(req.query.limit, 50) : undefined,
  });
  add({ method: 'get', path: '/api/image-audits/status', permission: 'crawls.view', description: 'Crawls whose images can be audited, the latest audit of each, the running one', handle: (req) => imageAudits.status(actorOf(req)) });
  add({ method: 'post', path: '/api/image-audits', permission: 'crawls.run', status: 202, description: 'Start an Image Audit of one finished crawl (body: runId): each unique image checked once', handle: (req) => imageAudits.start(actorOf(req), str(req.body?.runId, 'runId')) });
  add({ method: 'get', path: '/api/image-audits/:id', permission: 'crawls.view', description: 'Progress and counts of an Image Audit', handle: (req) => imageAudits.get(actorOf(req), prm(req, 'id')) });
  add({ method: 'get', path: '/api/image-audits/:id/occurrences', permission: 'crawls.view', description: 'Every page showing one image with each <img> instance and where it is on the page (query: url, repeated=1 for pages showing it more than once, offset, limit ≤ 500)', handle: (req) => imageAudits.occurrences(actorOf(req), prm(req, 'id'), String(req.query.url ?? ''), { repeated: req.query.repeated === '1' || req.query.repeated === 'true', offset: Number(req.query.offset ?? 0), limit: Number(req.query.limit ?? 100) }) });
  add({ method: 'post', path: '/api/image-audits/:id/resume', permission: 'crawls.run', description: 'Continue a stopped, cancelled or failed Image Audit with the images not answered yet (answered ones are not requested again)', handle: (req) => imageAudits.resume(actorOf(req), prm(req, 'id')) });
  add({ method: 'post', path: '/api/image-audits/:id/cancel', permission: 'crawls.run', description: 'Cancel a running Image Audit (images not checked become deferred)', handle: (req) => imageAudits.cancel(actorOf(req), prm(req, 'id')) });
  add({ method: 'get', path: '/api/image-audits/:id/images', permission: 'crawls.view', description: 'Images of an audit (query: state, issue, q, sort, dir, offset, limit ≤ 500) with facet counts', handle: (req) => imageAudits.list(actorOf(req), prm(req, 'id'), imageQuery(req)) });
  add({
    method: 'get', path: '/api/image-audits/:id/export', permission: 'crawls.view', description: 'Download an audit\'s images as CSV or JSON (same filters as the list), streamed', raw: true,
    handle: async (req) => {
      const f = await imageAudits.export(actorOf(req), prm(req, 'id'), String(req.query.format ?? 'csv'), imageQuery(req));
      const res = req.res!;
      res.setHeader('Content-Type', f.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.-]/g, '_')}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200);
      for await (const chunk of f.stream) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise<void>((r) => { res.once('drain', () => r()); res.once('close', () => r()); });
      }
      res.end();
    },
  });
  add({ method: 'get', path: '/api/changes/captures/status', permission: 'crawls.view', description: 'Whether page captures can run here (browser, memory), watched pages, recent capture jobs', handle: (req) => captures.status(actorOf(req)) });
  add({ method: 'post', path: '/api/changes/captures', permission: 'crawls.run', status: 202, description: 'Capture screenshots + rendered HTML of pages of this website (body: urls ≤ 20, viewports: ["desktop","mobile"])', handle: (req) => captures.request(actorOf(req), req.body ?? {}) });
  add({ method: 'get', path: '/api/changes/captures/jobs/:id', permission: 'crawls.view', description: 'Progress of a capture job', handle: (req) => captures.job(actorOf(req), prm(req, 'id')) });
  add({ method: 'put', path: '/api/changes/captures/watch', permission: 'crawls.configure', description: 'Pages captured after every crawl, so later changes have a "before" (body: urls ≤ 50)', handle: (req) => captures.setWatch(actorOf(req), req.body?.urls) });
  add({ method: 'get', path: '/api/changes/captures/pages', permission: 'crawls.view', description: 'Pages that have captures', handle: (req) => captures.pages(actorOf(req)) });
  add({ method: 'get', path: '/api/changes/captures', permission: 'crawls.view', description: 'Captures of one page (query: url), newest first', handle: (req) => captures.list(actorOf(req), String(req.query.url ?? '')) });
  add({
    method: 'get', path: '/api/changes/captures/:id/:kind', permission: 'crawls.view', description: 'A capture\'s screenshot (image), pixel-difference image (diff) or rendered HTML (html)', raw: true,
    handle: async (req) => {
      const kind = prm(req, 'kind');
      if (kind !== 'image' && kind !== 'diff' && kind !== 'html') throw badRequest('kind must be image, diff or html.');
      const f = await captures.file(actorOf(req), prm(req, 'id'), kind);
      const res = req.res!;
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (kind === 'html') {
        // Served as a download of plain text: the captured page's own HTML must never run on this origin.
        const { gunzipSync } = await import('node:zlib');
        const { readFile } = await import('node:fs/promises');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/\.gz$/, '').replace(/[^\w.-]/g, '_')}.txt"`);
        res.status(200).send(gunzipSync(await readFile(f.path)));
        return;
      }
      res.setHeader('Content-Type', f.type);
      res.status(200).sendFile(f.path);
    },
  });
  add({ method: 'get', path: '/api/changes/compare', permission: 'crawls.view', description: 'Previous vs current capture of a page: visual, rendered DOM diff, SEO fields, CSS / JS changes (query: url, viewport, from, to)', handle: (req) => captures.compare(actorOf(req), { url: String(req.query.url ?? ''), viewport: optStr(req.query.viewport), from: optStr(req.query.from), to: optStr(req.query.to) }) });
  add({ method: 'get', path: '/api/changes/compare/asset', permission: 'crawls.view', description: 'Line diff of one CSS / JS file between two captures (query: url, from, to, key)', handle: (req) => captures.assetDiff(actorOf(req), { url: String(req.query.url ?? ''), from: String(req.query.from ?? ''), to: String(req.query.to ?? ''), key: String(req.query.key ?? '') }) });
  add({ method: 'post', path: '/api/shopify/theme-snapshots', permission: 'shopify.theme', description: 'Read a theme\'s source files (read-only, authorised connection) and keep them as a snapshot for comparison (body: themeId)', handle: (req) => shopify.themeSnapshot(actorOf(req), req.body?.themeId) });
  add({ method: 'get', path: '/api/shopify/theme-snapshots', permission: 'shopify.theme', description: 'Theme source snapshots, newest first', handle: (req) => shopify.themeSnapshots(actorOf(req)) });
  add({ method: 'get', path: '/api/shopify/theme-snapshots/diff', permission: 'shopify.theme', description: 'Theme files added / removed / changed between two snapshots; with file, its line diff (query: from, to, file)', handle: (req) => shopify.themeSnapshotDiff(actorOf(req), String(req.query.from ?? ''), String(req.query.to ?? ''), optStr(req.query.file)) });
  add({ method: 'get', path: '/api/crawls/:id/page', permission: 'crawls.view', description: 'One page of a crawl with its SEO audit: every element checked, value found and what to do (id = crawl id or "latest"; query: url)', handle: (req) => crawls.page(actorOf(req), prm(req, 'id'), String(req.query.url ?? '')) });
  add({ method: 'get', path: '/api/lighthouse/status', permission: 'crawls.view', description: 'Whether Lighthouse / rendered checks can run on this server', handle: (req) => lighthouse.status(actorOf(req)) });
  add({ method: 'get', path: '/api/lighthouse/runs', permission: 'crawls.view', description: 'Recent Lighthouse audits and rendered checks', handle: (req) => lighthouse.list(actorOf(req)) });
  add({ method: 'post', path: '/api/lighthouse/runs', permission: 'crawls.run', status: 202, description: 'Queue Lighthouse audits (body: url, formFactors: ["mobile","desktop"], render)', handle: (req) => lighthouse.start(actorOf(req), req.body ?? {}) });
  add({ method: 'get', path: '/api/crawls/:id/coverage', permission: 'crawls.view', description: 'URL coverage of a crawl: found, crawled, failed, excluded, sitemap vs link graph, duplicates', handle: (req) => crawls.coverage(actorOf(req), prm(req, 'id')) });
  add({ method: 'post', path: '/api/crawls', permission: 'crawls.run', description: 'Start a crawl (body: type, and for a live crawl options: startUrl, maxPages, maxDepth, timeoutMs, concurrency)', handle: (req) => crawls.startManual(actorOf(req), str(req.body.type, 'type') as CrawlType, req.body.options) });
  add({ method: 'post', path: '/api/crawls/:id/cancel', permission: 'crawls.run', description: 'Cancel a running crawl', handle: (req) => crawls.cancel(actorOf(req), prm(req, 'id')) });

  // -------------------------------------------------------------- Shopify connection + SEO editor (token never leaves the server)
  const ids = (v: unknown): string[] => { const a = arr(v) ?? []; if (!a.every((x) => typeof x === 'string' && x.length < 80)) throw badRequest('ids must be draft ids.'); return a; };
  const sendFile = (req: Request, f: { filename: string; mimeType: string; content: string }) => {
    const res = req.res!;
    res.setHeader('Content-Type', f.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.filename.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(f.content);
  };
  add({ method: 'get', path: '/api/shopify/status', permission: 'integrations.view', description: 'Shopify connection: shop, granted scopes, missing scopes, capabilities (never the token)', handle: (req) => shopify.status(actorOf(req)) });
  add({ method: 'post', path: '/api/shopify/oauth/start', permission: 'integrations.manage', description: 'Start Shopify OAuth (body: shop) → authorize URL', handle: (req) => shopify.startOAuth(actorOf(req), str(req.body.shop, 'shop')) });
  add({
    method: 'get', path: '/api/shopify/oauth/callback', public: true, raw: true, description: 'Shopify OAuth callback (HMAC + single-use state verified; redirects to the app)',
    handle: async (req) => { const to = await handleOAuthCallback(req, c.env); req.res!.setHeader('Cache-Control', 'no-store'); req.res!.redirect(302, to); },
  });
  add({ method: 'put', path: '/api/shopify/app-credentials', permission: 'integrations.manage', description: 'Save the Shopify app Client ID, Client secret (stored encrypted, never returned) and app URL for this website', handle: (req) => shopify.saveAppCredentials(actorOf(req), (req.body ?? {}) as Record<string, unknown>) });
  add({ method: 'delete', path: '/api/shopify/app-credentials', permission: 'integrations.manage', description: 'Remove the Shopify app credentials entered in Sentinel', handle: (req) => shopify.removeAppCredentials(actorOf(req)) });
  add({ method: 'post', path: '/api/shopify/disconnect', permission: 'integrations.manage', description: 'Drop the Shopify token from server memory', handle: (req) => shopify.disconnect(actorOf(req)) });
  add({ method: 'get', path: '/api/shopify/resolve', permission: 'shopify.edit', description: 'Match a crawled URL to its Shopify product / collection / page / article', handle: (req) => shopify.resolveUrl(actorOf(req), str(req.query.url, 'url')) });
  add({ method: 'get', path: '/api/shopify/resources', permission: 'shopify.edit', description: 'List products, collections, pages or articles (query: kind, q, after)', handle: (req) => shopify.list(actorOf(req), str(req.query.kind, 'kind') as never, optStr(req.query.q), optStr(req.query.after)) });
  add({ method: 'get', path: '/api/shopify/drafts', permission: 'shopify.edit', description: 'SEO editor drafts', handle: (req) => shopify.listDrafts(actorOf(req)) });
  add({ method: 'post', path: '/api/shopify/drafts', permission: 'shopify.edit', status: 201, description: 'Create a draft with suggested changes (body: url, or kind + id). Writes nothing to Shopify.', handle: (req) => shopify.createDraft(actorOf(req), { url: optStr(req.body.url), kind: optStr(req.body.kind) as never, id: optStr(req.body.id) }) });
  add({ method: 'post', path: '/api/shopify/drafts/preview', permission: 'shopify.edit', description: 'Live values, exact changes, conflicts and the confirmation phrase (body: ids)', handle: (req) => shopify.preview(actorOf(req), ids(req.body.ids)) });
  add({ method: 'get', path: '/api/shopify/drafts/backup', permission: 'shopify.edit', raw: true, description: 'Download the current (original) values of drafts (query: ids)', handle: async (req) => sendFile(req, await shopify.backup(actorOf(req), ids(req.query.ids))) });
  add({ method: 'post', path: '/api/shopify/drafts/apply', permission: 'shopify.edit', description: 'Apply drafts after confirmation (body: ids, confirm); verifies and re-audits', handle: (req) => shopify.apply(actorOf(req), ids(req.body.ids), String(req.body.confirm ?? '')) });
  add({ method: 'get', path: '/api/shopify/drafts/:id', permission: 'shopify.edit', description: 'One draft', handle: (req) => shopify.getDraft(actorOf(req), prm(req, 'id')) });
  add({ method: 'patch', path: '/api/shopify/drafts/:id', permission: 'shopify.edit', description: 'Manual edits (body: fields: { key: { proposed, include } })', handle: (req) => shopify.updateDraft(actorOf(req), prm(req, 'id'), req.body ?? {}) });
  add({ method: 'delete', path: '/api/shopify/drafts/:id', permission: 'shopify.edit', description: 'Discard a draft', handle: (req) => shopify.deleteDraft(actorOf(req), prm(req, 'id')) });
  add({ method: 'post', path: '/api/shopify/drafts/:id/refresh', permission: 'shopify.edit', description: 'Rebuild a draft from the live values', handle: (req) => shopify.refreshDraft(actorOf(req), prm(req, 'id')) });
  add({ method: 'post', path: '/api/shopify/drafts/:id/reaudit', permission: 'shopify.edit', description: 'Fetch the storefront page again and check the applied values', handle: (req) => shopify.reauditDraft(actorOf(req), prm(req, 'id')) });
  add({ method: 'get', path: '/api/shopify/themes', permission: 'shopify.theme', description: 'Themes and their roles', handle: (req) => shopify.themes(actorOf(req)) });
  add({ method: 'get', path: '/api/shopify/themes/file', permission: 'shopify.theme', description: 'Read a theme file (query: themeId, filename)', handle: (req) => shopify.themeFile(actorOf(req), str(req.query.themeId, 'themeId'), str(req.query.filename, 'filename')) });
  add({ method: 'get', path: '/api/shopify/theme-proposals', permission: 'shopify.theme', description: 'Theme change proposals', handle: (req) => shopify.proposalsList(actorOf(req)) });
  add({ method: 'post', path: '/api/shopify/theme-proposals', permission: 'shopify.theme', status: 201, description: 'Propose a theme file change (body: themeId, filename, content, reason) → diff; writes nothing', handle: (req) => shopify.propose(actorOf(req), req.body ?? {}) });
  add({ method: 'post', path: '/api/shopify/theme-proposals/:id/apply', permission: 'shopify.theme', description: 'Write a proposal to an UNPUBLISHED theme after confirmation (never publishes)', handle: (req) => shopify.applyProposal(actorOf(req), prm(req, 'id'), String(req.body.confirm ?? '')) });
  add({ method: 'get', path: '/api/shopify/theme-proposals/:id/backup', permission: 'shopify.theme', raw: true, description: 'Download the original theme file of a proposal', handle: async (req) => sendFile(req, await shopify.proposalBackup(actorOf(req), prm(req, 'id'))) });

  // -------------------------------------------------------------- opportunities & content planning
  add({ method: 'get', path: '/api/opportunities', permission: 'opportunities.view', description: 'Opportunity backlog', handle: (req) => insights.listOpportunities(actorOf(req)) });
  add({ method: 'post', path: '/api/opportunities/:id/dismiss', permission: 'opportunities.manage', description: 'Dismiss an opportunity', handle: (req) => insights.dismissOpportunity(actorOf(req), prm(req, 'id')) });
  add({ method: 'get', path: '/api/keyword-gaps', permission: 'opportunities.view', description: 'Keyword gaps', handle: (req) => insights.keywordGaps(actorOf(req)) });
  add({ method: 'patch', path: '/api/keyword-gaps/:id', permission: 'opportunities.manage', description: 'Update a keyword gap', handle: (req) => insights.updateKeywordGap(actorOf(req), prm(req, 'id'), str(req.body.status, 'status') as never) });
  add({ method: 'get', path: '/api/striking-distance', permission: 'opportunities.view', description: 'Striking-distance queries', handle: (req) => insights.striking(actorOf(req)) });
  add({ method: 'get', path: '/api/ctr-rewrites', permission: 'opportunities.view', description: 'Low-CTR rewrite suggestions', handle: (req) => insights.ctrRewrites(actorOf(req)) });
  add({ method: 'get', path: '/api/briefs', permission: 'opportunities.view', description: 'Content briefs', handle: (req) => insights.listBriefs(actorOf(req)) });
  add({ method: 'post', path: '/api/briefs', permission: 'opportunities.manage', description: 'Create or update a brief', handle: (req) => insights.saveBrief(actorOf(req), req.body) });
  add({ method: 'post', path: '/api/briefs/from-gap/:gapId', permission: 'opportunities.manage', description: 'Generate a brief from an approved gap', handle: (req) => insights.briefFromGap(actorOf(req), prm(req, 'gapId')) });
  add({ method: 'get', path: '/api/briefs/:id', permission: 'opportunities.view', description: 'Brief detail', handle: (req) => insights.getBrief(actorOf(req), prm(req, 'id')) });
  add({ method: 'get', path: '/api/clusters', permission: 'opportunities.view', description: 'Topic clusters', handle: (req) => insights.clusters(actorOf(req)) });
  add({ method: 'get', path: '/api/seasonal-plan', permission: 'opportunities.view', description: 'Seasonal / festival plan', handle: (req) => insights.seasonal(actorOf(req)) });

  // -------------------------------------------------------------- off-page, competitors, local, AI
  add({ method: 'get', path: '/api/backlinks', permission: 'modules.view', description: 'Backlinks + referring-domain trend', handle: (req) => insights.backlinks(actorOf(req)) });
  add({ method: 'get', path: '/api/link-prospects', permission: 'opportunities.view', description: 'Link prospects', handle: (req) => insights.prospects(actorOf(req)) });
  add({ method: 'get', path: '/api/brand-mentions', permission: 'opportunities.view', description: 'Brand mentions', handle: (req) => insights.mentions(actorOf(req)) });
  add({ method: 'patch', path: '/api/brand-mentions/:id', permission: 'opportunities.manage', description: 'Update a brand mention', handle: (req) => insights.updateMention(actorOf(req), prm(req, 'id'), str(req.body.status, 'status') as never) });
  add({ method: 'get', path: '/api/disavow', permission: 'modules.view', description: 'Disavow candidates', handle: (req) => insights.disavow(actorOf(req)) });
  add({ method: 'post', path: '/api/disavow/:id/decide', permission: 'disavow.approve', description: 'Approve/reject a disavow candidate', handle: (req) => insights.decideDisavow(actorOf(req), prm(req, 'id'), str(req.body.decision, 'decision') as never) });
  add({ method: 'get', path: '/api/competitors', permission: 'opportunities.view', description: 'Competitor view', handle: (req) => insights.competitors(actorOf(req)) });
  add({ method: 'get', path: '/api/local-health', permission: 'modules.view', description: 'Local/GBP health', handle: (req) => insights.localHealth(actorOf(req)) });
  add({ method: 'get', path: '/api/ai-visibility', permission: 'modules.view', description: 'AI-visibility panel', handle: (req) => insights.aiVisibility(actorOf(req)) });

  // -------------------------------------------------------------- AI compliance & rules
  add({ method: 'get', path: '/api/ai-flags', permission: 'modules.view', description: 'AI-compliance flags', handle: (req) => rules.listFlags(actorOf(req)) });
  add({ method: 'post', path: '/api/ai-flags/:id/decide', permission: 'qa_gate.approve', description: 'Decide a QA-gate hold', handle: (req) => rules.decideQaHold(actorOf(req), prm(req, 'id'), str(req.body.decision, 'decision') as never, str(req.body.note, 'note')) });
  add({ method: 'get', path: '/api/rules', permission: 'rules.view', description: 'Custom rules', handle: (req) => rules.list(actorOf(req)) });
  add({ method: 'post', path: '/api/rules', permission: 'rules.manage', description: 'Create or update a rule', handle: (req) => rules.save(actorOf(req), req.body) });
  add({ method: 'post', path: '/api/rules/dry-run', permission: 'rules.manage', description: 'Dry-run a rule', handle: (req) => rules.dryRun(actorOf(req), req.body) });
  add({ method: 'patch', path: '/api/rules/:id/enabled', permission: 'rules.manage', description: 'Enable/disable a rule', handle: (req) => rules.setEnabled(actorOf(req), prm(req, 'id'), !!req.body.enabled) });
  add({ method: 'delete', path: '/api/rules/:id', permission: 'rules.manage', description: 'Delete a rule', handle: async (req) => { await rules.remove(actorOf(req), prm(req, 'id')); return { ok: true }; } });

  // -------------------------------------------------------------- reports
  add({ method: 'get', path: '/api/reports/history', permission: 'reports.view', description: 'Report history', handle: (req) => reports.history(actorOf(req)) });
  add({ method: 'get', path: '/api/reports/daily', permission: 'reports.view', description: 'Daily digest', handle: (req) => reports.daily(actorOf(req), optStr(req.query.date)) });
  add({ method: 'get', path: '/api/reports/weekly', permission: 'reports.view', description: 'Weekly rollup', handle: (req) => reports.weekly(actorOf(req)) });
  add({ method: 'get', path: '/api/reports/monthly', permission: 'reports.view', description: 'Monthly report', handle: (req) => reports.monthly(actorOf(req)) });
  add({ method: 'get', path: '/api/reports/:kind/export', permission: 'reports.export', description: 'Export a report', raw: true, handle: async (req) => { const out = await reports.export(actorOf(req), prm(req, 'kind') as never, (optStr(req.query.format) ?? 'json') as never); const res = (req as unknown as { res: import('express').Response }).res; res.setHeader('Content-Type', out.mime); res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`); res.send(out.content); } });
  add({ method: 'post', path: '/api/reports/:kind/send', permission: 'reports.export', description: 'Send a report through configured channels', handle: (req) => reports.sendManual(actorOf(req), prm(req, 'kind') as never) });

  // -------------------------------------------------------------- notifications & deliveries
  add({ method: 'get', path: '/api/notifications', description: 'My notifications', handle: (req) => admin.listNotifications(actorOf(req)) });
  add({ method: 'post', path: '/api/notifications/:id/read', description: 'Mark a notification read (or all)', handle: async (req) => { await admin.markRead(actorOf(req), prm(req, 'id')); return { ok: true }; } });
  add({ method: 'get', path: '/api/deliveries', permission: 'reports.view', description: 'Delivery attempts', handle: (req) => admin.listDeliveries(actorOf(req)) });
  add({ method: 'put', path: '/api/alert-rules', permission: 'notifications.configure', description: 'Update real-time alert routing', handle: (req) => admin.updateAlertRules(actorOf(req), req.body) });

  // -------------------------------------------------------------- people & permissions
  add({ method: 'get', path: '/api/employees', permission: 'employees.view', description: 'Employees', handle: (req) => admin.listEmployees(actorOf(req)) });
  add({ method: 'post', path: '/api/employees', permission: 'employees.manage', description: 'Invite an employee', handle: (req) => admin.createEmployee(actorOf(req), req.body) });
  add({ method: 'patch', path: '/api/employees/:id', permission: 'employees.manage', description: 'Update an employee', handle: (req) => admin.updateEmployee(actorOf(req), prm(req, 'id'), req.body ?? {}) });
  add({ method: 'get', path: '/api/permissions', permission: 'employees.view', description: 'Permission matrix', handle: (req) => admin.getPermissionMatrix(actorOf(req)) });
  add({ method: 'put', path: '/api/permissions', permission: 'roles.manage', description: 'Update the permission matrix', handle: (req) => admin.updatePermissionMatrix(actorOf(req), req.body) });

  // -------------------------------------------------------------- config & integrations
  add({ method: 'get', path: '/api/config', permission: 'settings.view', description: 'Configuration', handle: (req) => admin.getConfig(actorOf(req)) });
  add({ method: 'patch', path: '/api/config', permission: 'settings.manage', description: 'Update configuration', handle: (req) => admin.updateConfig(actorOf(req), req.body ?? {}) });
  add({ method: 'get', path: '/api/integrations', permission: 'integrations.view', description: 'Integration states', handle: (req) => admin.listIntegrations(actorOf(req)) });
  add({ method: 'patch', path: '/api/integrations/:id', permission: 'integrations.manage', description: 'Update integration settings', handle: (req) => admin.updateIntegration(actorOf(req), prm(req, 'id') as IntegrationId, req.body ?? {}) });
  add({ method: 'post', path: '/api/integrations/:id/test', permission: 'integrations.manage', description: 'Test an integration connection', handle: (req) => admin.testIntegration(actorOf(req), prm(req, 'id') as IntegrationId) });
  add({
    method: 'post', path: '/api/integrations/:id/sync', permission: 'integrations.manage', description: 'Run the data sync for a connected integration (ga4, gsc, psi_crux)',
    handle: async (req) => {
      const actor = actorOf(req);
      await need(c.ctx, actor, 'integrations.manage');
      const id = prm(req, 'id');
      if (!isSyncId(id)) throw badRequest(`No data sync exists for "${id}". Syncable integrations: ${SYNC_IDS.join(', ')}.`);
      return runSync(c.ctx, id, { fetchImpl: c.fetchImpl, actor, ingest: c.services.issues.ingestFindings });
    },
  });

  // -------------------------------------------------------------- audit, system, search, diagnostics
  add({ method: 'get', path: '/api/audit', permission: 'audit.view', description: 'Audit log', handle: (req) => admin.auditLog(actorOf(req), { q: optStr(req.query.q), entityType: optStr(req.query.entityType), actorId: optStr(req.query.actorId), page: req.query.page ? num(req.query.page, 1) : undefined, pageSize: req.query.pageSize ? num(req.query.pageSize, 50) : undefined }) });
  add({ method: 'get', path: '/api/system/health', permission: 'system.view', description: 'System health', handle: (req) => admin.systemHealth(actorOf(req)) });
  add({ method: 'get', path: '/api/search', description: 'Global search', handle: (req) => admin.search(actorOf(req), optStr(req.query.q) ?? '') });
  add({ method: 'get', path: '/api/diagnostics', permission: 'diagnostics.view', description: 'API diagnostics', handle: (req) => admin.diagnostics(actorOf(req)) });
}
