/**
 * Merges the findings of one check produced over several page batches into the finding the whole crawl would have
 * produced: problems are unioned by label (URLs de-duplicated, evidence capped), `examined` is summed so template-wide
 * detection is recomputed, and titles/summaries are rebuilt by aggregate() from the merged problems.
 * Check-specific metrics are merged by their meaning: TECH-THIN and CONT-QUALITY report the lowest score (min),
 * AEO-EXTRACTABILITY the template average (weighted by pages), TECH-5XX the slowest response (max);
 * template checklists (ONP-TPL-*) sum their pass / fail / not-evaluable counts.
 */
import type { PageTemplate } from '@sentinel/shared';
import type { Finding } from '../services/ports';
import { aggregate, MAX_KEPT_EVIDENCE, withAggregateSink, type AggregateOpts, type AnalyzerResult, type Ev } from '../analysis/context';

type MetricRule = 'min' | 'max' | 'wavg';
const METRIC_RULES: Record<string, MetricRule> = { 'TECH-THIN': 'min', 'CONT-QUALITY': 'min', 'AEO-EXTRACTABILITY': 'wavg' };

interface Acc {
  base: AggregateOpts;
  problems: Map<string, { label: string; urls: string[]; seen: Set<string>; evidence: Ev[] }>;
  examined: number;
  severity: Record<string, unknown>;
  metric?: number;
  wsum: number;
  wn: number;
  extra: Ev[];
  post: Ev[];
}

interface Manual {
  f: Finding;
  seen: Set<string>;
}

const keyOf = (f: Finding) => f.key ?? `${f.checkId}::${f.template ?? 'site'}`;

export class FindingMerger {
  private accs = new Map<string, Acc>();
  private manual = new Map<string, Manual>();
  private order: string[] = [];
  readonly evaluated = new Map<string, { evaluated: boolean; templates: Set<PageTemplate>; reason?: string; hadTemplates: boolean }>();

  /** Runs one analyzer over a batch, capturing how each of its findings was aggregated. */
  run(checkId: string, analyze: () => AnalyzerResult): AnalyzerResult {
    const captured = new Map<Finding, { o: AggregateOpts; baseLen: number }>();
    const empty: AggregateOpts[] = [];
    const res = withAggregateSink((f, o) => (f ? captured.set(f, { o, baseLen: f.evidence.length }) : empty.push(o)), analyze);
    this.add(checkId, res, captured, empty);
    return res;
  }

  private accFor(k: string, o: AggregateOpts): Acc {
    let acc = this.accs.get(k);
    if (!acc) {
      const { problems: _p, examined: _e, severityContext: _s, extraEvidence: _x, title: _t, ...base } = o;
      acc = { base: { ...base, checkId: o.checkId, problems: [] }, problems: new Map(), examined: 0, severity: {}, wsum: 0, wn: 0, extra: [], post: [] };
      this.accs.set(k, acc);
      this.order.push(k);
    }
    return acc;
  }

  private addMetric(acc: Acc, checkId: string, metric: unknown, examined: number) {
    if (typeof metric !== 'number') return;
    const rule = METRIC_RULES[checkId] ?? 'max';
    if (rule === 'wavg') {
      const w = Math.max(1, examined);
      acc.wsum += metric * w;
      acc.wn += w;
      acc.metric = Math.round(acc.wsum / acc.wn);
    } else acc.metric = acc.metric === undefined ? metric : rule === 'min' ? Math.min(acc.metric, metric) : Math.max(acc.metric, metric);
  }

  private add(checkId: string, res: AnalyzerResult, captured: Map<Finding, { o: AggregateOpts; baseLen: number }>, empty: AggregateOpts[]) {
    let e = this.evaluated.get(checkId);
    if (!e) {
      e = { evaluated: false, templates: new Set(), hadTemplates: false };
      this.evaluated.set(checkId, e);
    }
    if (res.evaluated) {
      e.evaluated = true;
      if (res.templates) {
        e.hadTemplates = true;
        for (const t of res.templates) e.templates.add(t);
      }
    } else e.reason ??= res.reason;
    if (!res.evaluated) return;
    // Batches where nothing failed still count: their pages were examined (template-wide detection, averages, checklists).
    for (const o of empty) {
      const acc = this.accFor(`${o.checkId}::${o.template ?? 'site'}${o.keySuffix ? `::${o.keySuffix}` : ''}`, o);
      acc.examined += o.examined ?? 0;
      this.addMetric(acc, checkId, o.severityContext?.metric, o.examined ?? 0);
      mergeExtra(acc.extra, o.extraEvidence ?? []);
    }
    for (const f of res.findings) {
      const k = keyOf(f);
      const c = captured.get(f);
      if (!c) {
        this.addManual(k, f);
        continue;
      }
      const acc = this.accFor(k, c.o);
      for (const p of c.o.problems) {
        if (!p.urls.length) continue;
        let m = acc.problems.get(p.label);
        if (!m) {
          m = { label: p.label, urls: [], seen: new Set(), evidence: [] };
          acc.problems.set(p.label, m);
        }
        for (const u of p.urls) if (!m.seen.has(u)) { m.seen.add(u); m.urls.push(u); }
        for (const ev of p.evidence ?? []) if (m.evidence.length < MAX_KEPT_EVIDENCE) m.evidence.push(ev);
      }
      const examined = c.o.examined ?? 0;
      acc.examined += examined;
      // Severity inputs: the finding's final severityContext (analyzers may set the metric after aggregate()).
      const { templateWide: _tw, metric, ...rest } = (f.severityContext ?? {}) as Record<string, unknown>;
      for (const [kk, v] of Object.entries(rest)) {
        if (typeof v === 'boolean') acc.severity[kk] = (acc.severity[kk] as boolean | undefined) || v;
        else if (acc.severity[kk] === undefined) acc.severity[kk] = v;
      }
      this.addMetric(acc, checkId, metric, examined);
      mergeExtra(acc.extra, c.o.extraEvidence ?? []);
      mergePost(acc.post, f.evidence.slice(c.baseLen));
    }
  }

  private addManual(k: string, f: Finding) {
    const m = this.manual.get(k);
    if (!m) {
      this.manual.set(k, { f: { ...f, urls: [...f.urls], evidence: [...f.evidence] }, seen: new Set(f.urls) });
      this.order.push(k);
      return;
    }
    for (const u of f.urls) if (!m.seen.has(u)) { m.seen.add(u); m.f.urls.push(u); }
    for (const ev of f.evidence) if (m.f.evidence.length < 15) m.f.evidence.push(ev);
  }

  /** The merged findings in first-seen order. */
  findings(): Finding[] {
    const out: Finding[] = [];
    for (const k of this.order) {
      const acc = this.accs.get(k);
      if (acc) {
        const problems = [...acc.problems.values()].map((p) => ({ label: p.label, urls: p.urls, evidence: p.evidence }));
        const severityContext = { ...acc.severity, ...(acc.metric !== undefined ? { metric: acc.metric } : {}) };
        // A weighted template average (AEO-EXTRACTABILITY) is shown with the merged value.
        const extra = acc.extra.map((ev) => (acc.metric !== undefined && ev.data && typeof (ev.data as Record<string, unknown>).average === 'number'
          ? { ...ev, label: ev.label.replace(/\d+\/100/, `${acc.metric}/100`), data: { ...ev.data, average: acc.metric } }
          : ev));
        const f = aggregate({ ...acc.base, problems, examined: acc.examined || undefined, severityContext, extraEvidence: extra.length ? extra : undefined });
        if (!f) continue;
        for (const ev of acc.post) f.evidence.push(ev);
        out.push(f);
        continue;
      }
      const m = this.manual.get(k);
      if (m) out.push(m.f);
    }
    return out;
  }
}

const shape = (label: string) => label.replace(/\d+/g, '#');

/** Template checklists: pass/fail/not-evaluable counts are summed; per-page samples are concatenated (capped). */
function mergeExtra(into: Ev[], next: Ev[]) {
  for (const ev of next) {
    const i = into.findIndex((x) => shape(x.label) === shape(ev.label) && x.kind === ev.kind);
    if (i < 0) {
      into.push(ev);
      continue;
    }
    const a = into[i].data as Record<string, unknown> | undefined;
    const b = ev.data as Record<string, unknown> | undefined;
    if (!a || !b) continue;
    const merged: Record<string, unknown> = { ...a };
    if (Array.isArray(a.checklist) && Array.isArray(b.checklist)) {
      const rows = new Map<string, { item: string; pass: number; fail: number; notEvaluable: number }>();
      for (const r of [...(a.checklist as { item: string; pass: number; fail: number; notEvaluable: number }[]), ...(b.checklist as { item: string; pass: number; fail: number; notEvaluable: number }[])]) {
        const cur = rows.get(r.item) ?? { item: r.item, pass: 0, fail: 0, notEvaluable: 0 };
        cur.pass += r.pass;
        cur.fail += r.fail;
        cur.notEvaluable += r.notEvaluable;
        rows.set(r.item, cur);
      }
      merged.checklist = [...rows.values()];
    }
    if (typeof a.examined === 'number' && typeof b.examined === 'number') merged.examined = a.examined + b.examined;
    if (Array.isArray(a.pages) && Array.isArray(b.pages)) merged.pages = [...a.pages, ...b.pages].slice(0, typeof a.average === 'number' ? 50 : 20);
    into[i] = { ...into[i], data: merged };
  }
}

/** Evidence analyzers append after aggregate(): coverage counts are summed, page samples concatenated. */
function mergePost(into: Ev[], next: Ev[]) {
  for (const ev of next) {
    const i = into.findIndex((x) => shape(x.label) === shape(ev.label) && x.kind === ev.kind);
    if (i < 0) {
      into.push(ev);
      continue;
    }
    const a = into[i].data as Record<string, unknown> | undefined;
    const b = ev.data as Record<string, unknown> | undefined;
    if (!a || !b) continue;
    const merged: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (k === 'average') continue;
      if (typeof v === 'number' && typeof a[k] === 'number') merged[k] = (a[k] as number) + v;
      else if (Array.isArray(v) && Array.isArray(a[k])) merged[k] = [...(a[k] as unknown[]), ...v].slice(0, 50);
    }
    into[i] = { ...into[i], data: merged };
  }
}
