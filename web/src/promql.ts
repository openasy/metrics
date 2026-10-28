// From a time range and PromQL to the lines of a chart: the range query's start, end and step, each series' name,
// and its values on one time axis.
import { formatBytes, formatDuration, type TimeSeries } from "@openasy/ui";
import type { Matrix, Unit } from "./api.ts";

export const RANGES: Record<string, number> = { "15m": 900, "1h": 3600, "6h": 21_600, "24h": 86_400, "7d": 604_800, "30d": 2_592_000 };
/** About this many points per line, whatever the range. */
const POINTS = 120;
/** More lines than this make a chart nobody can read; the rest are left out and counted. */
export const MAX_LINES = 30;

export function rangeQuery(range: string, now = Date.now()) {
  const seconds = RANGES[range] ?? RANGES["1h"]!;
  const step = Math.max(15, Math.ceil(seconds / POINTS / 15) * 15);
  const end = Math.floor(now / 1000 / step) * step;
  return { start: end - seconds, end, step };
}

export function rangePath(expr: string, range: string, now = Date.now()) {
  const { start, end, step } = rangeQuery(range, now);
  return `/prometheus/api/v1/query_range?${new URLSearchParams({ query: expr, start: String(start), end: String(end), step: String(step) })}`;
}

/** A series' name: the legend with {{label}} filled in, or its labels. */
export function seriesName(metric: Record<string, string>, legend = ""): string {
  if (legend.trim()) return legend.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, l: string) => metric[l] ?? "").trim() || "–";
  const labels = Object.entries(metric).filter(([k]) => k !== "__name__");
  if (!labels.length) return metric.__name__ ?? "{}";
  return labels.map(([k, v]) => `${k}="${v}"`).join(", ");
}

const time = (seconds: number, long: boolean) =>
  new Date(seconds * 1000).toLocaleString(
    undefined,
    long ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
  );

/**
 * The lines of a range query on one time axis, one point per step. A step a series has no sample at takes its last
 * value, or its first before it has one, so a line never breaks into a fall to zero.
 */
export function toChart(m: Matrix, range: string, legend = "", now = Date.now()): { labels: string[]; series: TimeSeries[]; hidden: number } {
  const { start, end, step } = rangeQuery(range, now);
  const steps: number[] = [];
  for (let t = start; t <= end; t += step) steps.push(t);
  const shown = m.result.slice(0, MAX_LINES);
  const series = shown.map((s, i): TimeSeries => {
    const at = new Map(s.values.map(([t, v]) => [Math.round(t), Number(v)]));
    const first = s.values.length ? Number(s.values[0]![1]) : 0;
    let last = first;
    const data = steps.map((t) => {
      const v = at.get(t);
      if (v !== undefined && Number.isFinite(v)) last = v;
      return last;
    });
    // The id names an SVG gradient, so it holds no quotes or spaces.
    return { id: `s${i}`, name: seriesName(s.metric, legend), data };
  });
  return { labels: steps.map((t) => time(t, end - start > 86_400)), series, hidden: m.result.length - shown.length };
}

/** Up to three significant digits, without a long tail. */
const round = (v: number) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? Math.round(v).toLocaleString() : Number(v.toPrecision(3)).toLocaleString());

/** How a value of a unit is written. */
export function formatter(unit: Unit): (v: number) => string {
  switch (unit) {
    case "percent":
      return (v) => `${round(v)}%`;
    case "ratio":
      return (v) => `${round(v * 100)}%`;
    case "bytes":
      return (v) => formatBytes(Math.max(0, v), 1);
    case "bytesPerSecond":
      return (v) => `${formatBytes(Math.max(0, v), 1)}/s`;
    case "seconds":
      return (v) => (Math.abs(v) < 1 ? `${round(v * 1000)} ms` : Math.abs(v) < 60 ? `${round(v)} s` : formatDuration(Math.round(v)));
    case "perSecond":
      return (v) => `${round(v)}/s`;
    default:
      return round;
  }
}
