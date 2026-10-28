// Prometheus text exposition, written by hand: a few lines, no client library needed.
import type { Summary } from "./service.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export function renderMetrics(version: string, s: Summary): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="metrics",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_metrics_storage_up 1 while VictoriaMetrics, which keeps the series, answers. Watch this from another system.",
    "# TYPE openasy_metrics_storage_up gauge",
    `openasy_metrics_storage_up ${s.storage.running ? 1 : 0}`,
    "# HELP openasy_metrics_targets Scrape targets by the health of their last scrape.",
    "# TYPE openasy_metrics_targets gauge",
    ...(["up", "down", "unknown"] as const).map((h) => `openasy_metrics_targets{health="${h}"} ${s.targets[h]}`),
    "# HELP openasy_metrics_active_series Series that got a sample in the last hour.",
    "# TYPE openasy_metrics_active_series gauge",
    `openasy_metrics_active_series ${s.storage.activeSeries}`,
    "# HELP openasy_metrics_samples_total Samples stored since VictoriaMetrics started.",
    "# TYPE openasy_metrics_samples_total counter",
    `openasy_metrics_samples_total ${s.storage.samplesTotal}`,
    "# HELP openasy_metrics_series_refused_total New series refused by the series limit since VictoriaMetrics started.",
    "# TYPE openasy_metrics_series_refused_total counter",
    `openasy_metrics_series_refused_total ${s.storage.refusedSeries}`,
    "# HELP openasy_metrics_storage_bytes Disk taken by the series.",
    "# TYPE openasy_metrics_storage_bytes gauge",
    `openasy_metrics_storage_bytes ${s.storage.storageBytes}`,
    "# HELP openasy_metrics_storage_free_bytes Free space on the data volume.",
    "# TYPE openasy_metrics_storage_free_bytes gauge",
    `openasy_metrics_storage_free_bytes ${s.storage.freeBytes}`,
    "# HELP openasy_metrics_retention_days How long series are kept.",
    "# TYPE openasy_metrics_retention_days gauge",
    `openasy_metrics_retention_days ${s.storage.retentionDays}`,
    "# HELP openasy_metrics_jobs Scrape jobs people added.",
    "# TYPE openasy_metrics_jobs gauge",
    `openasy_metrics_jobs ${s.jobs}`,
    "# HELP openasy_metrics_dashboards Dashboards, with the ones that come with Metrics.",
    "# TYPE openasy_metrics_dashboards gauge",
    `openasy_metrics_dashboards ${s.dashboards}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
