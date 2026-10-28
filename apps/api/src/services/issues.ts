import {
  CHECKS_BY_ID, TEAMS, canTransition, classifySeverity, compareSeverity, filterIssues, generateFixCard, isIssueOpen, proposeTemplateGroups, slaDueAt, type AlertType, type Evidence, type Exclusion, type Issue, type IssueDetail, type IssueFilter, type PageTemplate, type PageTier, type SentinelConfig, type Severity, type TeamId, issueFixSummary,
} from '@sentinel/shared';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import { audit, need, notify, seoLead, teamLead, SYSTEM_ACTOR, type Actor, type Ctx } from './context';
import type { CrawlOutcome, Finding } from './ports';
import type { TaskService } from './tasks';

const CLOSED_FOR_ALLOCATION = ['NOT_AN_ISSUE', 'SUPERSEDED', 'CLOSED', 'VERIFIED'];
/** An absolute URL whose path is "/" (the homepage), without parsing it. */
const HOMEPAGE_URL = /^https?:\/\/[^/?#]+\/?(?:[?#]|$)/i;

/** Exclusion patterns are site paths; `*` matches any run of characters. */
export function exclusionMatches(ex: Pick<Exclusion, 'checkId' | 'urlPattern'>, checkId: string, url: string): boolean {
  if (ex.checkId && ex.checkId !== checkId) return false;
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  const pat = ex.urlPattern.trim();
  if (!pat.includes('*')) return path === pat || path === pat.replace(/\/$/, '');
  const re = new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(path);
}

/**
 * exclusionMatches for a whole ingest at once: patterns compiled once, grouped by check, and each URL's path parsed once.
 * A finding whose check has no exclusions is not filtered at all (the common case on a 50,000-page crawl).
 */
export function compileExclusions(list: Pick<Exclusion, 'checkId' | 'urlPattern'>[]) {
  type C = { exact?: [string, string]; re?: RegExp };
  const byCheck = new Map<string, C[]>();
  for (const ex of list) {
    const pat = ex.urlPattern.trim();
    const c: C = pat.includes('*')
      ? { re: new RegExp(`^${pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`) }
      : { exact: [pat, pat.replace(/\/$/, '')] };
    const k = ex.checkId ?? '';
    const arr = byCheck.get(k);
    if (arr) arr.push(c); else byCheck.set(k, [c]);
  }
  const paths = new Map<string, string>();
  const pathOfUrl = (url: string) => {
    let p = paths.get(url);
    if (p === undefined) {
      try { p = new URL(url).pathname; } catch { p = url; }
      paths.set(url, p);
    }
    return p;
  };
  const match = (cs: C[], path: string) => cs.some((c) => (c.exact ? path === c.exact[0] || path === c.exact[1] : c.re!.test(path)));
  return {
    /** True when this check has any exclusion (or a global one). */
    applies: (checkId: string) => byCheck.has(checkId) || byCheck.has(''),
    matches(checkId: string, url: string): boolean {
      const own = byCheck.get(checkId);
      const global = byCheck.get('');
      if (!own && !global) return false;
      const path = pathOfUrl(url);
      return (!!own && match(own, path)) || (!!global && match(global, path));
    },
  };
}

/** Default identity of an issue across runs: one issue per check × template (site-level checks: "site"). */
export const defaultKey = (checkId: string, template?: PageTemplate) => `${checkId}::${template ?? 'site'}`;
/** Analyzers may emit several findings per check × template with their own stable key (one per blocked bot, per near-duplicate cluster…). */
export const findingKeyOf = (f: Pick<Finding, 'checkId' | 'template' | 'key'>) => f.key ?? defaultKey(f.checkId, f.template);
export const issueKeyOf = (i: Pick<Issue, 'checkId' | 'template' | 'findingKey'>) => i.findingKey ?? defaultKey(i.checkId, i.template);

/** PDF §12.2 real-time alert types for a newly detected Critical issue. */
export function alertTypeFor(issue: Pick<Issue, 'checkId' | 'highestTier' | 'severity'>, ctx: Finding['severityContext'] = {}): AlertType | undefined {
  if (issue.severity !== 'critical') return undefined;
  switch (issue.checkId) {
    case 'TECH-5XX': return ctx?.sitewide || ctx?.templateWide ? 'sitewide_5xx' : undefined;
    case 'TECH-ROBOTS': return 'robots_change';
    case 'TECH-NOINDEX': return issue.highestTier === 1 ? 'tier1_noindex' : undefined;
    case 'TECH-HTTPS': return 'ssl_failure';
    case 'TECH-INDEX-COVERAGE': return 'index_collapse';
    case 'OFF-TOXIC': return 'toxic_link_spike';
    case 'PERF-CRUX': return 'cwv_poor_template';
    default: return undefined;
  }
}

export function createIssueService(ctx: Ctx, tasks: TaskService) {
  const r = ctx.repos;
  const iso = () => ctx.clock().toISOString();

  async function load(id: string) {
    const i = await r.issues.get(id);
    if (!i) throw notFound(`Issue ${id}`);
    return i;
  }

  /** Page-value tier for a URL (PDF §14): from the site page inventory; unknown URLs default to Tier 3 (home = Tier 1). */
  async function tierLookup(): Promise<(url: string) => PageTier> {
    const pages = await r.sitePages.list();
    const byUrl = new Map<string, PageTier>();
    const byPath = new Map<string, PageTier>();
    for (const p of pages) {
      byUrl.set(p.url, p.tier);
      byPath.set(p.path, p.tier);
    }
    return (url: string) => {
      const hit = byUrl.get(url);
      if (hit) return hit;
      let path = url;
      try { path = new URL(url).pathname; } catch { /* keep */ }
      if (path === '/' || path === '') return 1;
      return byPath.get(path) ?? byPath.get(path.replace(/\/$/, '')) ?? 3;
    };
  }

  async function detail(_actor: Actor, i: Issue): Promise<IssueDetail> {
    const cfg = await r.config.get();
    const task = i.taskId ? await r.tasks.get(i.taskId) : undefined;
    const page = i.affectedUrls[0] ? (await r.sitePages.where({ url: i.affectedUrls[0] }))[0] : undefined;
    const children = i.childIssueIds ? (await Promise.all(i.childIssueIds.map((c) => r.issues.get(c)))).filter((x): x is Issue => !!x) : undefined;
    const allAudit = await r.audit.list();
    return {
      issue: i,
      fixCard: generateFixCard(i, cfg, { now: ctx.clock(), pageName: page?.title }),
      group: i.groupId ? await r.groups.get(i.groupId) : undefined,
      children,
      verification: (await r.verifications.where({ issueId: i.id })),
      audit: allAudit.filter((a) => a.entityId === i.id || (task && a.entityId === task.id)).slice(-40),
    };
  }

  async function allocate(actor: Actor, i: Issue, team: TeamId, reason?: string, bulkGroupId?: string, automatic = false) {
    const prev = i.allocatedTeam;
    i.allocation.push({ id: `${i.id}-alc${i.allocation.length + 1}`, issueId: i.id, allocatedById: actor.id, allocatedByName: actor.name, fromTeam: prev, toTeam: team, at: iso(), reason, automatic, bulkGroupId });
    i.allocatedTeam = team;
    if (i.status === 'NEW') i.status = 'ASSIGNED';
    await r.issues.update(i);
    await audit(ctx, actor, prev ? 'issue.reallocate' : 'issue.allocate', 'issue', i.id, `${prev ? `Reallocated ${TEAMS[prev].name} → ` : 'Allocated → '}${TEAMS[team].name}${automatic ? ' (automatic)' : ''}${reason ? `: ${reason}` : ''}`);
  }

  /** Allocation + task creation / reassignment in one step (API and the automatic rule for unallocated Criticals). */
  async function allocateWithTask(actor: Actor, i: Issue, team: TeamId, reason?: string, bulkGroupId?: string, automatic = false) {
    if (!TEAMS[team]) throw badRequest('Choose a team.');
    if (CLOSED_FOR_ALLOCATION.includes(i.status)) throw conflict(`Issue ${i.id} is ${i.status} and cannot be allocated.`);
    if (i.allocatedTeam === team && i.taskId) throw conflict(`Already allocated to ${TEAMS[team].name}.`);
    await allocate(actor, i, team, reason, bulkGroupId, automatic);
    let task = i.taskId ? await r.tasks.get(i.taskId) : undefined;
    if (!task || ['CANCELLED'].includes(task.status)) {
      task = await tasks.createForIssue(actor, i, team, automatic);
      i.taskId = task.id;
      await r.issues.update(i);
      await notify(ctx, [await teamLead(ctx, team)], { type: 'assignment', title: `New ${i.severity} task for ${TEAMS[team].name}`, body: i.title, link: `/issues/${i.id}`, severity: i.severity });
      const att = await ctx.delivery.deliver('allocation', ['slack'], { subject: `[${i.severity.toUpperCase()}] ${i.title} → ${TEAMS[team].name}`, text: `${i.summary}\nTask ${task.id} created${automatic ? ' automatically (Critical unallocated past the threshold)' : ` by ${actor.name}`}.`, links: [{ label: 'Open task', url: `/tasks/${task.id}` }] }, { issueId: i.id, taskId: task.id });
      void att;
    } else {
      const from = task.team;
      task.team = team;
      task.assignmentHistory.push({ at: iso(), byId: actor.id, byName: actor.name, fromTeam: from, toTeam: team, fromAssigneeId: task.assigneeId, reason });
      task.assigneeId = undefined;
      if (!['NEW', 'TRIAGED', 'ASSIGNED'].includes(task.status)) task.status = 'ASSIGNED';
      task.activity.push({ id: `${task.id}-a${task.activity.length + 1}`, type: 'reallocated', actorId: actor.id, actorName: actor.name, at: iso(), message: `Reallocated ${TEAMS[from].name} → ${TEAMS[team].name}${reason ? `: ${reason}` : ''}. Both teams notified.` });
      task.updatedAt = iso();
      await r.tasks.update(task);
      await notify(ctx, [await teamLead(ctx, from), await teamLead(ctx, team)], { type: 'assignment', title: `Reallocated: ${i.title}`, body: `${TEAMS[from].name} → ${TEAMS[team].name}`, link: `/issues/${i.id}`, severity: i.severity });
      await tasks.syncTaskOps(task, i);
    }
    return task;
  }

  async function bulk(actor: Actor, parent: Issue, team: TeamId, reason?: string): Promise<IssueDetail> {
    const task = await allocateWithTask(actor, parent, team, reason, parent.groupId);
    for (const cid of parent.childIssueIds ?? []) {
      const c = await r.issues.get(cid);
      // Superseded children are exactly what bulk allocation is for (PDF §11.1a.6); only finished/dismissed ones are skipped.
      if (!c || ['NOT_AN_ISSUE', 'CLOSED', 'VERIFIED'].includes(c.status)) continue;
      c.allocation.push({ id: `${c.id}-alc${c.allocation.length + 1}`, issueId: c.id, allocatedById: actor.id, allocatedByName: actor.name, fromTeam: c.allocatedTeam, toTeam: team, at: iso(), automatic: false, reason: `Bulk allocation via template-level ${parent.id}`, bulkGroupId: parent.groupId });
      c.allocatedTeam = team;
      c.taskId = task.id;
      if (c.status === 'NEW') c.status = 'ASSIGNED';
      await r.issues.update(c);
    }
    await audit(ctx, actor, 'issue.bulk_allocate', 'issue', parent.id, `Bulk-allocated ${parent.childIssueIds?.length ?? 0} child issues → ${TEAMS[team].name}`);
    return detail(actor, (await r.issues.get(parent.id))!);
  }

  // ------------------------------------------------------------------------------------------------ ingestion

  function evidenceFrom(f: Finding, source: Issue['source']): Evidence[] {
    const at = iso();
    return f.evidence.slice(0, 20).map((e, n) => ({ ...e, id: `EV-${Date.now().toString(36)}-${n}`, capturedAt: at, source }));
  }

  function issueClassFor(checkId: string, sev: Severity): Issue['issueClass'] {
    const c = CHECKS_BY_ID[checkId];
    return c?.issueClass === 'opportunity' ? 'opportunity' : sev;
  }

  async function realtimeAlert(issue: Issue, sc: Finding['severityContext'], cfg: SentinelConfig) {
    const type = alertTypeFor(issue, sc);
    if (!type) return;
    const rule = cfg.alerts.find((a) => a.type === type);
    if (!rule || !rule.enabled) return;
    const recipients = await Promise.all(rule.recipients.map((t) => teamLead(ctx, t)));
    if (rule.channels.includes('in_app')) await notify(ctx, recipients, { type: 'alert', title: `Critical: ${issue.title}`, body: issue.summary, link: `/issues/${issue.id}`, severity: 'critical' });
    const ext = rule.channels.filter((c): c is 'email' | 'whatsapp' | 'slack' => c !== 'in_app');
    const delivered = ext.length
      ? await ctx.delivery.deliver('realtime_alert', ext, {
        subject: `[Critical] ${rule.label}: ${issue.title}`,
        text: `${issue.summary}\nAffected: ${issue.affectedCount} URL(s), highest Tier ${issue.highestTier}. SLA: ${issue.slaDueAt}.\nThe Fix Card has the steps, where to fix it and the time it takes.`,
        links: [{ label: 'Open the Fix Card', url: `/issues/${issue.id}` }],
      }, { issueId: issue.id })
      : [];
    const m = await r.metrics.get();
    const alertId = `ALR-${issue.id}-${m.criticalAlerts.length + 1}`;
    m.criticalAlerts.push({ id: alertId, type, title: issue.title, at: iso(), issueId: issue.id });
    await r.metrics.set(m);
    // PDF §17.5: every alert is in the audit log, with the provider-confirmed outcome per channel.
    const outcomes = delivered.map((d) => `${d.channel}: ${d.outcome}`).join(', ') || 'in-app only';
    await audit(ctx, SYSTEM_ACTOR, 'alert.realtime', 'alert', alertId, `${rule.label} — ${issue.title} (${issue.id}). Delivery: ${outcomes}.`);
    ctx.log.info({ alert: type, issueId: issue.id, outcomes: delivered.map((d) => `${d.channel}:${d.outcome}`) }, 'realtime alert');
  }

  /**
   * Turn a crawl outcome into issue state (PDF §2 subsystems C→D→E):
   *  - exclusions applied (Not-an-issue learning, §11.1a)
   *  - delta detection vs. existing issues: new / worsening / improving / unchanged / recurring (regression)
   *  - severity = check × page tier via the shared classifier, SLA from severity
   *  - auto-resolution only where the check was evaluated AND every affected URL was re-crawled
   *  - template grouping (≥3 related Medium) and real-time alerts for new Criticals
   */
  async function ingestFindings(runId: string, outcome: Pick<CrawlOutcome, 'findings' | 'evaluatedChecks' | 'evaluatedTemplates' | 'urls' | 'pageTexts'> & { answeredUrls?: Set<string> }) {
    const cfg = await r.config.get();
    const tierOfRaw = await tierLookup();
    const tierCache = new Map<string, PageTier>();
    const tierOf = (u: string) => {
      let t = tierCache.get(u);
      if (t === undefined) { t = tierOfRaw(u); tierCache.set(u, t); }
      return t;
    };
    const exclusions = compileExclusions(await r.exclusions.list());
    const now = ctx.clock();
    const all = await r.issues.list();
    // Page/finding-level issues (superseded group children included — they keep tracking their own URLs).
    const live = all.filter((i) => i.source !== 'demo' && !i.isTemplateGroup);
    const liveByKey = new Map<string, Issue[]>();
    for (const i of live) { const k = issueKeyOf(i); const list = liveByKey.get(k); if (list) list.push(i); else liveByKey.set(k, [i]); }
    const seen = new Set<string>();
    const stats = { newIssues: 0, resolvedIssues: 0, recurringIssues: 0, excludedUrls: 0 };
    // URLs that answered in this run (Go crawls pass the set from their result store instead of every row).
    const crawled = outcome.answeredUrls ?? new Set(outcome.urls.filter((u) => u.status !== null).map((u) => u.url));
    const primaryTask = async (i: Issue) => {
      // A grouped child shares its parent's task; only the task's own issue drives verification.
      const t = i.taskId ? await r.tasks.get(i.taskId) : undefined;
      return t && (!t.issueId || t.issueId === i.id) ? t : undefined;
    };

    for (const f of outcome.findings) {
      if (!CHECKS_BY_ID[f.checkId]) { ctx.log.warn({ checkId: f.checkId }, 'finding for unknown check ignored'); continue; }
      const urls = exclusions.applies(f.checkId) ? f.urls.filter((u) => !exclusions.matches(f.checkId, u)) : f.urls;
      stats.excludedUrls += f.urls.length - urls.length;
      if (f.urls.length > 0 && urls.length === 0) continue; // every URL is excluded
      const key = findingKeyOf(f);
      seen.add(key);
      const tiers = urls.map(tierOf);
      const highestTier = (tiers.length ? tiers.reduce((a, b) => (b < a ? b : a)) : 1) as PageTier;
      const tierBreakdown: Record<PageTier, number> = { 1: 0, 2: 0, 3: 0 };
      for (const t of tiers) tierBreakdown[t]++;
      const sevCtx = { ...f.severityContext, checkId: f.checkId, highestTier, isHomepage: urls.some((u) => HOMEPAGE_URL.test(u)) };
      const decision = classifySeverity(sevCtx, cfg);
      const existing = liveByKey.get(key) ?? [];
      const open = existing.find((i) => isIssueOpen(i.status) || i.status === 'SUPERSEDED');
      const closed = existing.filter((i) => i.status === 'VERIFIED' || i.status === 'CLOSED').sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
      const dismissed = existing.find((i) => i.status === 'NOT_AN_ISSUE');

      if (open) {
        const prevCount = open.affectedCount;
        open.affectedUrls = urls;
        open.affectedCount = urls.length || 1;
        open.highestTier = highestTier;
        open.tierBreakdown = tierBreakdown;
        open.lastSeenAt = now.toISOString();
        open.summary = f.summary;
        open.title = f.title;
        open.crawlRunId = runId;
        open.evidence = evidenceFrom(f, 'live');
        open.delta = open.affectedCount > prevCount ? 'worsening' : open.affectedCount < prevCount ? 'improving' : 'unchanged';
        if (compareSeverity(decision.severity, open.severity) < 0 && !open.supersededById) {
          open.severityHistory.push({ at: now.toISOString(), from: open.severity, to: decision.severity, reason: decision.rationale, rule: 'reclassification' });
          open.severity = decision.severity;
          open.severityRationale = decision.rationale;
          open.slaDueAt = slaDueAt(decision.severity, now, cfg).toISOString();
          open.issueClass = issueClassFor(f.checkId, decision.severity);
        }
        await r.issues.update(open);
        // A FIXED task whose issue is still detected on fully re-crawled URLs fails verification (PDF §11: closes only at 0 failing).
        const t = await primaryTask(open);
        if (t && t.status === 'FIXED' && (!urls.length || urls.every((u) => crawled.has(u)))) {
          await tasks.applyVerification(t, {
            id: await r.verifications.nextId('VER'), taskId: t.id, issueId: open.id, at: iso(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'failed',
            checkedUrls: urls.length || 1, failingUrls: urls.length || 1, details: `Crawl ${runId} still detects "${f.title}" on ${urls.length || 'the site-level'} URL(s).`, source: 'live',
          });
        }
        continue;
      }
      if (dismissed && !closed) continue; // a human marked this Not an issue — respect it (use exclusions/reopen to change)

      if (closed) {
        // Regression (PDF §12.3 "Regression detected"): reopen to the same team.
        closed.status = closed.allocatedTeam ? 'ASSIGNED' : 'NEW';
        closed.delta = 'recurring';
        closed.occurrences += 1;
        closed.affectedUrls = urls;
        closed.affectedCount = urls.length || 1;
        closed.highestTier = highestTier;
        closed.tierBreakdown = tierBreakdown;
        closed.lastSeenAt = now.toISOString();
        closed.crawlRunId = runId;
        closed.evidence = evidenceFrom(f, 'live');
        closed.severity = decision.severity;
        closed.severityRationale = decision.rationale;
        closed.slaDueAt = slaDueAt(decision.severity, now, cfg).toISOString();
        await r.issues.update(closed);
        stats.recurringIssues++;
        const t = await primaryTask(closed);
        if (t && (t.status === 'VERIFIED' || t.status === 'CLOSED')) {
          await tasks.transition(SYSTEM_ACTOR, t.id, 'reopen_regression', `Crawl ${runId} detected the problem again on ${urls.length} URL(s).`);
        }
        await audit(ctx, SYSTEM_ACTOR, 'issue.regression', 'issue', closed.id, `Regression detected by crawl ${runId}; reopened${closed.allocatedTeam ? ` to ${TEAMS[closed.allocatedTeam].name}` : ''}.`);
        await notify(ctx, [closed.allocatedTeam ? await teamLead(ctx, closed.allocatedTeam) : await seoLead(ctx)], { type: 'alert', title: `Regression: ${closed.title}`, body: `Previously verified issue is back (${urls.length} URLs).`, link: `/issues/${closed.id}`, severity: closed.severity });
        continue;
      }

      const check = CHECKS_BY_ID[f.checkId];
      const issue: Issue = {
        id: await r.issues.nextId('ISS'), checkId: f.checkId, module: check.module, title: f.title, summary: f.summary, severity: decision.severity,
        severityRationale: decision.rationale, issueClass: issueClassFor(f.checkId, decision.severity), status: 'NEW', delta: 'new', template: f.template,
        affectedUrls: urls, affectedCount: urls.length || 1, highestTier, tierBreakdown, businessImpact: f.businessImpact ?? check.detects,
        detectedAt: now.toISOString(), firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(), slaDueAt: slaDueAt(decision.severity, now, cfg).toISOString(),
        occurrences: 1, recommendedTeam: check.ownerTeam, allocation: [], severityHistory: [], evidence: evidenceFrom(f, 'live'), crawlRunId: runId, source: 'live',
        findingKey: f.key && f.key !== defaultKey(f.checkId, f.template) ? f.key : undefined,
      };
      await r.issues.insert(issue);
      live.push(issue); // a later finding with the same key in this run updates it instead of duplicating
      { const k = issueKeyOf(issue); const list = liveByKey.get(k); if (list) list.push(issue); else liveByKey.set(k, [issue]); }
      stats.newIssues++;
      await realtimeAlert(issue, f.severityContext, cfg);
    }

    // Auto-resolution: evaluated in this run, not seen, and every affected URL re-crawled.
    const evaluated = new Set(outcome.evaluatedChecks);
    const resolvable = (i: Issue) => {
      if (!isIssueOpen(i.status) || !evaluated.has(i.checkId)) return false;
      const tpls = outcome.evaluatedTemplates?.[i.checkId];
      if (i.template && tpls && tpls.length && !tpls.includes(i.template)) return false;
      return !i.affectedUrls.length || i.affectedUrls.every((u) => crawled.has(u));
    };
    const resolve = async (i: Issue) => {
      const fresh = (await r.issues.get(i.id))!;
      fresh.delta = 'resolved';
      const t = await primaryTask(fresh);
      if (t && t.status === 'FIXED') {
        await r.issues.update(fresh);
        await tasks.applyVerification(t, {
          id: await r.verifications.nextId('VER'), taskId: t.id, issueId: fresh.id, at: iso(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'passed',
          checkedUrls: fresh.affectedUrls.length || 1, failingUrls: 0, details: `Crawl ${runId} re-checked ${fresh.affectedUrls.length || 'the site-level'} URL(s): 0 failing.`, source: 'live',
        });
      } else if (t && !['VERIFIED', 'CLOSED', 'CANCELLED'].includes(t.status)) {
        await r.issues.update(fresh);
        t.activity.push({ id: `${t.id}-a${t.activity.length + 1}`, type: 'comment', actorId: 'system', actorName: SYSTEM_ACTOR.name, at: iso(), message: `Crawl ${runId} no longer detects this problem on the affected URLs. Submit for review so it can be verified and closed.` });
        await r.tasks.update(t);
      } else {
        fresh.status = 'VERIFIED';
        await r.issues.update(fresh);
        for (const cid of fresh.childIssueIds ?? []) {
          const child = await r.issues.get(cid);
          if (child && child.status === 'SUPERSEDED') await r.issues.update({ ...child, status: 'VERIFIED', delta: 'resolved' });
        }
        await audit(ctx, SYSTEM_ACTOR, 'issue.auto_resolved', 'issue', fresh.id, `Not detected by crawl ${runId} on any affected URL — verified resolved by the crawler.`);
      }
      stats.resolvedIssues++;
    };
    for (const i of live) if (!seen.has(issueKeyOf(i)) && resolvable(i)) await resolve(i);

    // Template-level parents (PDF §11.2.4): the parent card is the actionable one; it resolves as a unit when none of
    // its children is detected any more, and otherwise tracks the union of the children's URLs.
    for (const parent of (await r.issues.list()).filter((i) => i.isTemplateGroup && i.source !== 'demo' && isIssueOpen(i.status))) {
      const children = (await Promise.all((parent.childIssueIds ?? []).map((id) => r.issues.get(id)))).filter((x): x is Issue => !!x);
      const stillSeen = children.some((c) => seen.has(issueKeyOf(c)));
      if (stillSeen) {
        const urls = [...new Set(children.filter((c) => seen.has(issueKeyOf(c))).flatMap((c) => c.affectedUrls))];
        await r.issues.update({ ...parent, affectedUrls: urls, affectedCount: urls.length || parent.affectedCount, lastSeenAt: now.toISOString(), crawlRunId: runId });
        const t = await primaryTask(parent);
        if (t && t.status === 'FIXED' && urls.every((u) => crawled.has(u))) {
          await tasks.applyVerification(t, {
            id: await r.verifications.nextId('VER'), taskId: t.id, issueId: parent.id, at: iso(), triggeredBy: 'system', method: 'automated_recrawl', outcome: 'failed',
            checkedUrls: urls.length, failingUrls: urls.length, details: `Crawl ${runId} still detects the template-level problem on ${urls.length} URL(s).`, source: 'live',
          });
        }
      } else if (resolvable(parent)) {
        await resolve(parent);
      }
    }

    await groupTemplates();
    await storePageTexts(outcome.pageTexts ?? [], tierOf);
    return stats;
  }

  /** PDF §3.3: ≥ threshold related Medium issues on one template → one Critical template-level issue that supersedes them (§11.2.4). */
  async function groupTemplates() {
    const cfg = await r.config.get();
    const issues = (await r.issues.list()).filter((i) => i.source !== 'demo');
    for (const p of proposeTemplateGroups(issues, cfg)) {
      const children = (await Promise.all(p.issueIds.map((id) => r.issues.get(id)))).filter((x): x is Issue => !!x);
      const groupId = await r.groups.nextId('GRP');
      const now = ctx.clock();
      const urls = [...new Set(children.flatMap((c) => c.affectedUrls))];
      const tiers = children.map((c) => c.highestTier);
      const parentId = await r.issues.nextId('ISS');
      const parent: Issue = {
        ...children[0], id: parentId, title: `Template-level: ${CHECKS_BY_ID[p.checkId]?.name ?? p.checkId} on ${p.template} pages`, summary: p.reason,
        severity: 'critical', severityRationale: p.reason, issueClass: 'critical', status: 'NEW', delta: 'new', affectedUrls: urls, affectedCount: urls.length,
        highestTier: tiers.reduce((a, b) => (b < a ? b : a)) as PageTier, detectedAt: now.toISOString(), firstSeenAt: now.toISOString(), lastSeenAt: now.toISOString(),
        slaDueAt: slaDueAt('critical', now, cfg).toISOString(), occurrences: 1, groupId, isTemplateGroup: true, childIssueIds: children.map((c) => c.id),
        findingKey: `GROUP::${p.checkId}::${p.template}`, supersededById: undefined,
        allocation: [], allocatedTeam: undefined, taskId: undefined, severityHistory: [{ at: now.toISOString(), from: 'medium', to: 'critical', reason: p.reason, rule: 'template_grouping' }],
      };
      await r.issues.insert(parent);
      await r.groups.insert({ id: groupId, checkId: p.checkId, template: p.template, issueIds: parent.childIssueIds!, severity: 'critical', reason: p.reason, createdAt: now.toISOString() });
      for (const c of children) await r.issues.update({ ...c, groupId, supersededById: parentId, status: 'SUPERSEDED' });
      await audit(ctx, SYSTEM_ACTOR, 'issue.template_group', 'issue', parent.id, `${p.reason} Supersedes ${children.map((c) => c.id).join(', ')}.`);
    }
  }

  async function storePageTexts(pages: NonNullable<CrawlOutcome['pageTexts']>, tierOf: (u: string) => PageTier) {
    for (const p of pages) {
      const prev = await r.pageTexts.get(p.url);
      let handle: string | undefined;
      try { handle = new URL(p.url).pathname.match(/^\/collections\/([^/]+)/)?.[1]; } catch { /* ignore */ }
      await r.pageTexts.upsert({ id: p.url, url: p.url, template: p.template, tier: tierOf(p.url), collectionHandle: handle, text: p.text.slice(0, 50_000), publishedAt: prev?.publishedAt ?? iso(), source: 'live' });
    }
  }

  // ------------------------------------------------------------------------------------------------ API
  return {
    tierLookup,
    ingestFindings,
    allocateWithTask,
    detail,

    /**
     * An issue whose affected URLs were re-checked by the reverifier after a fix applied through Sentinel (bulk SEO
     * fixes) with 0 failing: closed as verified. Never called on a suggestion alone — only with a passed re-check.
     * Issues with a task go through the task's verification (FIXED → VERIFIED → CLOSED).
     */
    async confirmFixedByRecheck(actor: Actor, issueId: string, check: { checkedUrls: number; details: string }): Promise<Issue | undefined> {
      const i = await r.issues.get(issueId);
      if (!i || !isIssueOpen(i.status)) return i;
      const t = i.taskId ? await r.tasks.get(i.taskId) : undefined;
      const primary = t && (!t.issueId || t.issueId === i.id) ? t : undefined;
      if (primary && !['VERIFIED', 'CLOSED', 'CANCELLED'].includes(primary.status)) {
        if (primary.status !== 'FIXED') {
          primary.status = 'FIXED';
          primary.progress = 100;
          primary.activity.push({ id: `${primary.id}-a${primary.activity.length + 1}-${Date.now().toString(36)}`, type: 'status_changed', actorId: actor.id, actorName: actor.name, at: iso(), message: `Fixed in Shopify through Sentinel by ${actor.name}; re-checked automatically.` });
          await r.tasks.update(primary);
        }
        await tasks.applyVerification(primary, { id: await r.verifications.nextId('VER'), taskId: primary.id, issueId: i.id, at: iso(), triggeredBy: actor.id, method: 'automated_recrawl', outcome: 'passed', checkedUrls: check.checkedUrls, failingUrls: 0, details: check.details, source: 'live' });
      } else {
        const fresh = { ...i, status: 'VERIFIED' as const, delta: 'resolved' as const };
        await r.issues.update(fresh);
        for (const cid of fresh.childIssueIds ?? []) {
          const child = await r.issues.get(cid);
          if (child && child.status === 'SUPERSEDED') await r.issues.update({ ...child, status: 'VERIFIED', delta: 'resolved' });
        }
      }
      await audit(ctx, actor, 'issue.verified_after_fix', 'issue', i.id, check.details);
      return r.issues.get(issueId);
    },

    async list(actor: Actor, f: IssueFilter) {
      await need(ctx, actor, 'issues.view');
      const page = filterIssues(await r.issues.list(), f, ctx.clock());
      // Each listed issue says how long the fix takes, where it is made and the first step (from its Fix Card).
      const cfg = await r.config.get();
      return { ...page, items: page.items.map((i) => ({ ...i, fix: issueFixSummary(i, cfg) })) };
    },
    async get(actor: Actor, id: string) {
      await need(ctx, actor, 'issues.view');
      return detail(actor, await load(id));
    },
    async allocate(actor: Actor, id: string, team: TeamId, reason?: string) {
      await need(ctx, actor, 'issues.allocate');
      const i = await load(id);
      if (i.isTemplateGroup) return bulk(actor, i, team, reason);
      await allocateWithTask(actor, i, team, reason);
      return detail(actor, (await r.issues.get(id))!);
    },
    async bulkAllocate(actor: Actor, groupId: string, team: TeamId, reason?: string) {
      await need(ctx, actor, 'issues.allocate');
      const parent = (await r.issues.list()).find((i) => i.groupId === groupId && i.isTemplateGroup);
      if (!parent) throw notFound(`Group ${groupId}`);
      return bulk(actor, parent, team, reason);
    },
    async acknowledge(actor: Actor, id: string) {
      await need(ctx, actor, 'issues.view');
      const i = await load(id);
      i.acknowledgedBy = { id: actor.id, name: actor.name, at: iso() };
      await r.issues.update(i);
      await audit(ctx, actor, 'issue.acknowledge', 'issue', id, 'Acknowledged');
      return detail(actor, i);
    },
    async markNotAnIssue(actor: Actor, id: string, reason: string, addExclusion: boolean) {
      await need(ctx, actor, 'issues.mark_not_issue');
      if (!reason || reason.trim().length < 5) throw badRequest('Give a reason (at least 5 characters) so the classifier can learn the exclusion.');
      const i = await load(id);
      if (i.status === 'NOT_AN_ISSUE') throw conflict('Already marked Not an issue.');
      i.status = 'NOT_AN_ISSUE';
      i.notAnIssue = { byId: actor.id, byName: actor.name, at: iso(), reason: reason.trim(), excluded: addExclusion };
      await r.issues.update(i);
      if (addExclusion) {
        for (const u of i.affectedUrls.slice(0, 50)) {
          let path = u;
          try { path = new URL(u).pathname; } catch { /* keep */ }
          await r.exclusions.insert({ id: await r.exclusions.nextId('EXC'), checkId: i.checkId, urlPattern: path, reason: reason.trim(), createdById: actor.id, createdByName: actor.name, createdAt: iso() });
        }
      }
      const t = i.taskId ? await r.tasks.get(i.taskId) : undefined;
      if (t && !['VERIFIED', 'CLOSED', 'CANCELLED', 'FIXED'].includes(t.status)) {
        t.status = 'CANCELLED';
        t.cancelReason = `Issue marked Not an issue: ${reason.trim()}`;
        t.activity.push({ id: `${t.id}-a${t.activity.length + 1}`, type: 'status_changed', actorId: actor.id, actorName: actor.name, at: iso(), message: `Cancelled — issue marked Not an issue: ${reason.trim()}` });
        t.updatedAt = iso();
        await r.tasks.update(t);
      }
      await audit(ctx, actor, 'issue.not_an_issue', 'issue', id, `Not an issue: ${reason.trim()}${addExclusion ? ' (exclusion added)' : ''}`);
      return detail(actor, i);
    },
    async reopen(actor: Actor, id: string, reason: string) {
      await need(ctx, actor, 'issues.allocate');
      if (!reason || reason.trim().length < 3) throw badRequest('A reason is required to reopen.');
      const i = await load(id);
      if (!['NOT_AN_ISSUE', 'VERIFIED', 'CLOSED'].includes(i.status)) throw conflict('Only closed, verified or not-an-issue findings can be reopened.');
      const t = i.taskId ? await r.tasks.get(i.taskId) : undefined;
      if (t && (t.status === 'VERIFIED' || t.status === 'CLOSED')) {
        const chk = canTransition(t.status, 'reopen_regression', { kind: 'user', id: actor.id, role: actor.role, isAssignee: t.assigneeId === actor.id }, reason);
        if (!chk.ok) throw new ApiError(chk.code === 'FORBIDDEN' ? 403 : 409, chk.code!, chk.error!);
        await tasks.transition(actor, t.id, 'reopen_regression', reason);
        i.status = 'ASSIGNED';
      } else {
        i.status = i.allocatedTeam ? 'ASSIGNED' : 'NEW';
        i.notAnIssue = undefined;
      }
      i.occurrences += 1;
      i.delta = 'recurring';
      await r.issues.update(i);
      await audit(ctx, actor, 'issue.reopen', 'issue', id, `Reopened: ${reason.trim()}`);
      return detail(actor, (await r.issues.get(id))!);
    },
    async approveProposal(actor: Actor, id: string, note: string) {
      await need(ctx, actor, 'fixcards.approve_proposal');
      const i = await load(id);
      await audit(ctx, actor, 'fixcard.approve_proposal', 'issue', id, `Human approval recorded for proposed change: ${note?.trim() || '(no note)'} — Sentinel does not apply live-site changes (PDF §17).`);
      return detail(actor, i);
    },
    async listGroups(actor: Actor) {
      await need(ctx, actor, 'issues.view');
      const out = [];
      for (const g of await r.groups.list()) {
        const parent = (await r.issues.list()).find((i) => i.groupId === g.id && i.isTemplateGroup);
        if (parent) out.push({ ...g, parent });
      }
      return out;
    },
    async listExclusions(actor: Actor) {
      await need(ctx, actor, 'issues.view');
      return r.exclusions.list();
    },
    async removeExclusion(actor: Actor, id: string) {
      await need(ctx, actor, 'issues.manage_exclusions');
      const ex = await r.exclusions.get(id);
      if (!ex) throw notFound('Exclusion');
      await r.exclusions.delete(id);
      await audit(ctx, actor, 'exclusion.remove', 'exclusion', id, `Removed exclusion ${ex.urlPattern}`);
    },
    async allocationHistory(actor: Actor) {
      await need(ctx, actor, 'issues.view');
      return (await r.issues.list()).flatMap((i) => i.allocation.map((a) => ({ ...a, issueTitle: i.title }))).sort((a, b) => b.at.localeCompare(a.at));
    },
  };
}
export type IssueService = ReturnType<typeof createIssueService>;
