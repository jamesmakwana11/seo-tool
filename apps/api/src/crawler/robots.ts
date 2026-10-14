/**
 * robots.txt parser + matcher (RFC 9309 semantics as implemented by Google):
 *  - consecutive `User-agent` lines form one group; rules that follow belong to it;
 *  - the group whose user-agent token is the longest match for the crawler's product token wins, else `*`;
 *  - within a group the longest matching path rule wins; on a tie `Allow` wins;
 *  - `*` wildcard and `$` end anchor are supported.
 */
export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  line: number;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
  invalidLines: { line: number; text: string }[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const invalidLines: { line: number; text: string }[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) {
      invalidLines.push({ line: i + 1, text: raw });
      return;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      sitemaps.push(value);
      return;
    }
    if (key === 'allow' || key === 'disallow') {
      if (!current) {
        invalidLines.push({ line: i + 1, text: raw });
        return;
      }
      // Empty Disallow = allow everything; it is not a rule.
      if (value === '') return;
      current.rules.push({ type: key, path: value, line: i + 1 });
      return;
    }
    // crawl-delay, host, clean-param … are accepted but not used.
  });
  return { groups, sitemaps, invalidLines };
}

/** Product token of a full User-Agent string ("DeoDapSEOSentinel/1.0 (+x)" → "deodapseosentinel"). */
export function productToken(userAgent: string): string {
  return (userAgent.trim().split(/[\s/]/)[0] || userAgent).toLowerCase();
}

/** Rules applicable to `userAgent` (a product token such as "GPTBot" or a full UA string). */
export function groupFor(robots: ParsedRobots, userAgent: string): { agent: string; rules: RobotsRule[] } {
  const token = productToken(userAgent);
  let best: { agent: string; rules: RobotsRule[] } | undefined;
  for (const g of robots.groups) {
    for (const a of g.agents) {
      if (a === '*') continue;
      if (token === a || token.includes(a)) {
        if (!best || a.length > best.agent.length) best = { agent: a, rules: [] };
        if (best.agent === a) best.rules.push(...g.rules);
      }
    }
  }
  if (best) return best;
  const star = robots.groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
  return { agent: '*', rules: star };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export interface RobotsDecision {
  allowed: boolean;
  rule?: RobotsRule;
  agent: string;
}

/** Decide whether `pathWithQuery` (e.g. "/collections/x?page=2") is allowed for `userAgent`. */
export function isAllowed(robots: ParsedRobots, userAgent: string, pathWithQuery: string): RobotsDecision {
  const { agent, rules } = groupFor(robots, userAgent);
  let best: RobotsRule | undefined;
  for (const r of rules) {
    if (!patternToRegExp(r.path).test(pathWithQuery)) continue;
    const len = r.path.replace(/\$$/, '').length;
    const bestLen = best ? best.path.replace(/\$$/, '').length : -1;
    if (len > bestLen || (len === bestLen && r.type === 'allow')) best = r;
  }
  return { allowed: !best || best.type === 'allow', rule: best, agent };
}

export function pathAndQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Line diff (added/removed, order-insensitive, comments/blank lines ignored). */
export function diffRobots(prev: string, curr: string): { added: string[]; removed: string[] } {
  const norm = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const a = norm(prev);
  const b = norm(curr);
  const count = (arr: string[]) => arr.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const ca = count(a);
  const cb = count(b);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of cb) for (let i = 0; i < n - (ca.get(l) ?? 0); i++) added.push(l);
  for (const [l, n] of ca) for (let i = 0; i < n - (cb.get(l) ?? 0); i++) removed.push(l);
  return { added, removed };
}
