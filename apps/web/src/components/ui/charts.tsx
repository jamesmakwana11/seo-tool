import { useId, useState, type ReactNode } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Sector, Tooltip, XAxis, YAxis,
  type TooltipProps,
} from 'recharts';
import { fmtNum, fmtShortDate } from '@/lib/format';
import { useReducedMotion } from '@/lib/motion';

/* ------------------------------------------------------------------------------------------------ palette */

/** Violet first, then lavender and calm secondary hues — never saturated. */
export const SERIES = ['#7650D8', '#B6A0F5', '#E7A43B', '#6B8FE8', '#DC5C6A', '#27AE79', '#C9C4D6'];
export const SEVERITY_COLORS = { critical: '#DC5C6A', medium: '#E7A43B', low: '#B6A0F5' } as const;
const GRID = '#F1ECFA';
const axis = { fontSize: 11, fill: '#9A97A8' };
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
/** Axis ticks: compact only for large values, so nearby ticks (4,420 / 4,460) never collapse into the same label. */
export const axisNum = (v: number) => (Math.abs(v) >= 10000 ? compact.format(v) : fmtNum(v));

/** Kept for screens that pass Recharts' own Tooltip props. */
export const TOOLTIP_STYLE = { fontSize: 12, borderRadius: 12, border: '1px solid #EAE6F2', background: '#FFFFFF', color: '#252238', boxShadow: '0 12px 28px -8px rgba(37,34,56,.18)', padding: '8px 10px' };
export const TOOLTIP_LABEL = { color: '#777487', marginBottom: 2, fontWeight: 500 };
export const TOOLTIP_ITEM = { padding: 0 };

/* ------------------------------------------------------------------------------------------------ tooltip */

/** Dark, compact tooltip pill (the reference's style): label on top, one row per series with its colour dot. */
export function ChartTooltip({ active, payload, label, labelFormat, valueFormat }: TooltipProps<number, string> & { labelFormat?: (l: string) => string; valueFormat?: (v: number, key: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="pointer-events-none min-w-[132px] rounded-xl bg-[#252238] px-3 py-2 text-white shadow-pop">
      {label !== undefined && <div className="mb-1 text-[11px] font-medium text-white/60">{labelFormat ? labelFormat(String(label)) : String(label)}</div>}
      <ul className="space-y-0.5">
        {payload.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center gap-2 text-xs">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: (p.payload as Record<string, unknown>)?.fill as string ?? p.color }} />
            <span className="min-w-0 flex-1 truncate text-white/75">{p.name}</span>
            <span className="font-semibold tabular-nums">{typeof p.value === 'number' ? (valueFormat ? valueFormat(p.value, String(p.dataKey)) : fmtNum(p.value)) : p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small legend chips, used above charts instead of Recharts' default legend. */
export function ChartLegend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <li key={i.label} className="inline-flex items-center gap-1.5">
          {i.dashed ? <span className="h-0 w-3.5 border-t-2 border-dashed" style={{ borderColor: i.color }} /> : <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------------------------------ trend */

export interface SeriesDef { key: string; label: string; color?: string; dashed?: boolean; axis?: 'left' | 'right' }

/**
 * Time series. The first series is a smooth violet line over a lavender gradient fill (default for a single series, or
 * `area`); further series are lines (dashed for comparisons). Lines draw in once; the area fades up.
 */
export function TrendChart<T extends Record<string, unknown>>({ data, x, series, height = 220, yDomain, yFormat, area, xFormat, legend = true }: {
  data: T[]; x: keyof T & string; series: SeriesDef[]; height?: number; yDomain?: [number | 'auto', number | 'auto']; yFormat?: (v: number) => string; area?: boolean;
  xFormat?: (v: string) => string; legend?: boolean;
}) {
  const reduced = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const fmt = yFormat ?? axisNum;
  const xf = xFormat ?? ((v: string) => fmtShortDate(v));
  const fill = area ?? series.length === 1;
  const [first, ...rest] = series;
  const c0 = first?.color ?? SERIES[0];
  const right = series.some((s) => s.axis === 'right');
  const anim = { isAnimationActive: !reduced, animationDuration: 750, animationEasing: 'ease-out' as const };
  return (
    <div>
      {legend && series.length > 1 && <div className="mb-2 flex justify-end"><ChartLegend items={series.map((s, i) => ({ label: s.label, color: s.color ?? SERIES[i % SERIES.length], dashed: s.dashed }))} /></div>}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: right ? 0 : 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c0} stopOpacity={0.22} />
              <stop offset="70%" stopColor={c0} stopOpacity={0.05} />
              <stop offset="100%" stopColor={c0} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={x} tick={axis} tickFormatter={(v) => xf(String(v))} minTickGap={28} axisLine={false} tickLine={false} dy={6} />
          <YAxis yAxisId="left" tick={axis} domain={yDomain ?? ['auto', 'auto']} tickFormatter={fmt} axisLine={false} tickLine={false} width={46} />
          {right && <YAxis yAxisId="right" orientation="right" tick={axis} tickFormatter={axisNum} axisLine={false} tickLine={false} width={44} />}
          <Tooltip content={<ChartTooltip labelFormat={xf} valueFormat={(v, k) => (series.find((s) => s.key === k)?.axis === 'right' ? fmtNum(v) : fmt(v))} />} cursor={{ stroke: '#B6A0F5', strokeDasharray: '3 3' }} />
          {first && (fill
            ? <Area yAxisId={first.axis ?? 'left'} type="monotone" dataKey={first.key} name={first.label} stroke={c0} fill={`url(#g${gid})`} strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 3, stroke: '#fff', fill: c0 }} {...anim} />
            : <Line yAxisId={first.axis ?? 'left'} type="monotone" dataKey={first.key} name={first.label} stroke={c0} strokeWidth={2.5} dot={false} activeDot={{ r: 5, strokeWidth: 3, stroke: '#fff' }} {...anim} />)}
          {rest.map((s, i) => (
            <Line key={s.key} yAxisId={s.axis ?? 'left'} type="monotone" dataKey={s.key} name={s.label} stroke={s.color ?? SERIES[(i + 1) % SERIES.length]} strokeWidth={s.dashed ? 1.75 : 2} strokeDasharray={s.dashed ? '5 4' : undefined} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} {...anim} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ bars */

export function StackedBars<T extends Record<string, unknown>>({ data, x, series, height = 220, horizontal }: { data: T[]; x: keyof T & string; series: SeriesDef[]; height?: number; horizontal?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <div>
      <div className="mb-2 flex justify-end"><ChartLegend items={series.map((s, i) => ({ label: s.label, color: s.color ?? SERIES[i % SERIES.length] }))} /></div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 8, left: horizontal ? 4 : -14, bottom: 0 }} barCategoryGap={horizontal ? 7 : '30%'}>
          <CartesianGrid stroke={GRID} vertical={!horizontal} horizontal={!!horizontal === false} />
          {horizontal ? (
            <>
              <XAxis type="number" tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey={x} tick={{ ...axis, fill: '#777487' }} width={136} axisLine={false} tickLine={false} />
            </>
          ) : (
            <>
              <XAxis dataKey={x} tick={axis} axisLine={false} tickLine={false} />
              <YAxis tick={axis} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
            </>
          )}
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(118,80,216,0.05)' }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color ?? SERIES[i % SERIES.length]} isAnimationActive={!reduced} animationDuration={600} maxBarSize={14} radius={i === series.length - 1 ? (horizontal ? [0, 6, 6, 0] : [6, 6, 0, 0]) : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Rounded "pill" columns with a soft vertical gradient (reference: Traffic by Device). The highlighted column — by default
 * the latest — is violet; the others are pale lavender-grey, so the eye lands on the current value.
 */
export function PillBars<T extends Record<string, unknown>>({ data, x, y, name, height = 220, highlight, xFormat, yFormat }: {
  data: T[]; x: keyof T & string; y: keyof T & string; name: string; height?: number; highlight?: number; xFormat?: (v: string) => string; yFormat?: (v: number) => string;
}) {
  const reduced = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const hi = highlight ?? data.length - 1;
  const [hover, setHover] = useState<number | null>(null);
  const xf = xFormat ?? ((v: string) => fmtShortDate(v));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -14, bottom: 0 }} barCategoryGap="22%" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`on${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#B6A0F5" /><stop offset="100%" stopColor="#7650D8" /></linearGradient>
          <linearGradient id={`off${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F7F5FB" /><stop offset="100%" stopColor="#E9E5F1" /></linearGradient>
          <linearGradient id={`hv${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#EFE8FE" /><stop offset="100%" stopColor="#D8CBFA" /></linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={x} tick={axis} tickFormatter={(v) => xf(String(v))} axisLine={false} tickLine={false} minTickGap={8} dy={6} />
        <YAxis tick={axis} tickFormatter={yFormat ?? axisNum} axisLine={false} tickLine={false} width={42} />
        <Tooltip content={<ChartTooltip labelFormat={xf} />} cursor={false} />
        <Bar dataKey={y} name={name} radius={[999, 999, 999, 999]} maxBarSize={26} isAnimationActive={!reduced} animationDuration={650} animationEasing="ease-out" onMouseEnter={(_, i) => setHover(i)}>
          {data.map((_, i) => <Cell key={i} fill={i === hi ? `url(#on${gid})` : i === hover ? `url(#hv${gid})` : `url(#off${gid})`} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------------------------------------------ donut */

export interface DonutDatum { key: string; label: string; value: number; color: string }

/** Rounded donut with gaps, a centre total, hover emphasis and a legend that carries values and shares. */
export function DonutChart({ data, centerValue, centerLabel, size = 176 }: { data: DonutDatum[]; centerValue: ReactNode; centerLabel: string; size?: number }) {
  const reduced = useReducedMotion();
  const [active, setActive] = useState<number | undefined>();
  const total = data.reduce((a, d) => a + d.value, 0);
  const rows = total ? data : [{ key: 'none', label: 'None', value: 1, color: '#F1ECFA' }];
  const activeShape = (p: unknown) => {
    const s = p as { cx: number; cy: number; innerRadius: number; outerRadius: number; startAngle: number; endAngle: number; fill: string; cornerRadius?: number };
    return <Sector {...s} outerRadius={s.outerRadius + 5} innerRadius={s.innerRadius - 1} cornerRadius={6} />;
  };
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows} dataKey="value" nameKey="label" innerRadius="66%" outerRadius="92%" paddingAngle={total ? 3 : 0} cornerRadius={6} stroke="none"
              startAngle={90} endAngle={-270} activeIndex={active} activeShape={activeShape}
              onMouseEnter={(_, i) => setActive(i)} onMouseLeave={() => setActive(undefined)}
              isAnimationActive={!reduced} animationDuration={800} animationEasing="ease-out"
            >
              {rows.map((d, i) => <Cell key={d.key} fill={d.color} opacity={active === undefined || active === i ? 1 : 0.45} className="transition-opacity duration-200" />)}
            </Pie>
            {total > 0 && <Tooltip content={<ChartTooltip />} />}
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-ink">{active !== undefined && total ? fmtNum(rows[active].value) : centerValue}</span>
          <span className="mt-1 text-xs text-muted">{active !== undefined && total ? rows[active].label : centerLabel}</span>
        </div>
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1">
        {data.map((d, i) => (
          <li key={d.key}>
            <button type="button" onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(undefined)} onFocus={() => setActive(i)} onBlur={() => setActive(undefined)} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${active === i ? 'bg-raised' : ''}`}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} aria-hidden />
              <span className="min-w-0 flex-1 whitespace-nowrap text-ink-soft">{d.label}</span>
              <span className="font-semibold tabular-nums text-ink">{fmtNum(d.value)}</span>
              <span className="w-10 text-right text-xs tabular-nums text-muted">{total ? Math.round((d.value / total) * 100) : 0}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ compact lists */

/** Reference-style compact rows: a label and a short segmented bar (e.g. critical / medium / low per module). */
export function SegmentRows({ rows, segments, max }: { rows: { key: string; label: ReactNode; values: number[]; to?: string }[]; segments: { label: string; color: string }[]; max?: number }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.values.reduce((a, b) => a + b, 0)));
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const sum = r.values.reduce((a, b) => a + b, 0);
        return (
          <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2.5rem] items-center gap-3 text-sm">
            <span className="truncate text-ink-soft">{r.label}</span>
            <span className="flex h-1.5 items-center gap-[3px]" title={r.values.map((v, i) => `${segments[i].label}: ${v}`).join(' · ')}>
              {r.values.map((v, i) => (v > 0 ? <span key={i} className="h-full rounded-full" style={{ width: `${(v / top) * 100}%`, background: segments[i].color }} /> : null))}
              {sum === 0 && <span className="h-full w-full rounded-full bg-[#F1ECFA]" />}
            </span>
            <span className="text-right font-semibold tabular-nums text-ink">{sum}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Compact horizontal bars comparing one metric across a few items (e.g. websites). */
export function CompareBars({ rows, max, format = (v) => fmtNum(v) }: { rows: { key: string; label: ReactNode; value: number | undefined; color?: string; note?: string }[]; max?: number; format?: (v: number) => string }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <ul className="space-y-3.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-soft">{r.label}</span>
            <span className="shrink-0 font-semibold tabular-nums text-ink">{r.value === undefined ? <span className="text-xs font-normal text-faint">{r.note ?? 'No data'}</span> : format(r.value)}</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#F1ECFA]">
            {r.value !== undefined && <div className="bar-grow h-full rounded-full" style={{ width: `${Math.max(2, (r.value / top) * 100)}%`, background: r.color ?? 'linear-gradient(90deg,#B6A0F5,#7650D8)' }} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Tiny trend line with a soft fill, for cards and tables. */
export function Sparkline({ values, color = '#7650D8', height = 28, width = 96 }: { values: number[]; color?: string; height?: number; width?: number }) {
  const gid = useId().replace(/:/g, '');
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = pts.map(([px, py]) => `${px},${py}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs><linearGradient id={`s${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={0.22} /><stop offset="100%" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <polygon points={`0,${height} ${line} ${width},${height}`} fill={`url(#s${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
