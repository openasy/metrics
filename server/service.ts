// What the screens and /metrics read: targets with their health, the metric list, the summary and the storage, put
// together from VictoriaMetrics, the jobs and the dashboards. Changing a job rewrites the scrape config and has
// VictoriaMetrics read it again.
import type { Dashboards } from "./dashboards.ts";
import type { Jobs } from "./jobs.ts";
import { log } from "./log.ts";
import { MetricsError } from "./problem.ts";
import { writeScrapeConfig, type Source } from "./scrape.ts";
import { VmError, type VmClient, type VmTarget, type VmUsage } from "./vm.ts";

export interface Target {
  job: string;
  /** The address scraped. */
  url: string;
  /** The OpenAsy product, for targets of the job `openasy`. */
  product: string | null;
  /** The job's id, for a job people added; null for the ones Metrics adds itself. */
  jobId: string | null;
  labels: Record<string, string>;
  health: "up" | "down" | "unknown";
  lastScrape: string | null;
  durationMs: number | null;
  samples: number | null;
  error: string | null;
}

export interface MetricName {
  name: string;
  type: string | null;
  help: string | null;
  /** Series of it now; null when it is not among the 1000 metrics with the most. */
  series: number | null;
}

export interface ServiceOptions {
  vm: VmClient;
  jobs: Jobs;
  dashboards: Dashboards;
  sources: Source[];
  /** Metrics' own /metrics, scraped as the product `metrics`. */
  self: string;
  /** Where the scrape config and the secret files are written: a directory in /tmp. */
  runDir: string;
  intervalSeconds: number;
  retentionDays: number;
  maxSeries: number;
  /** Whether the VictoriaMetrics process is running. */
  running: () => boolean;
  clock?: () => number;
}

/** Storage numbers are read at most this often. */
const USAGE_EVERY_MS = 5000;
const EMPTY_USAGE: VmUsage = { storageBytes: 0, freeBytes: 0, activeSeries: 0, samplesTotal: 0, refusedSeries: 0 };

/** VictoriaMetrics' time of a scrape, or null for one that has not happened. */
function scrapeTime(t: string): string | null {
  const ms = Date.parse(t);
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) ? new Date(ms).toISOString() : null;
}

const storageError = (err: unknown) =>
  err instanceof VmError && err.status === 503
    ? new MetricsError(503, "storage-unavailable", err.message)
    : err instanceof VmError
      ? new MetricsError(422, "invalid-body", err.message)
      : err;

export function createService(o: ServiceOptions) {
  const clock = o.clock ?? Date.now;
  let usage: { at: number; value: VmUsage } | undefined;
  let rate: { at: number; total: number; perSecond: number | null } | undefined;

  /** The config path, written at start before VictoriaMetrics reads it, and after every change to a job. */
  const write = () => writeScrapeConfig(o.runDir, { jobs: o.jobs.forScrape(), sources: o.sources, self: o.self, intervalSeconds: o.intervalSeconds });

  async function readUsage(): Promise<VmUsage> {
    const now = clock();
    if (usage && now - usage.at < USAGE_EVERY_MS) return usage.value;
    const value = await o.vm.usage();
    usage = { at: now, value };
    // Samples per second between two readings at least 5 seconds apart.
    if (!rate) rate = { at: now, total: value.samplesTotal, perSecond: null };
    else if (now - rate.at >= USAGE_EVERY_MS)
      rate = { at: now, total: value.samplesTotal, perSecond: Math.max(0, ((value.samplesTotal - rate.total) * 1000) / (now - rate.at)) };
    return value;
  }

  async function targets(): Promise<Target[]> {
    let raw: VmTarget[];
    try {
      raw = await o.vm.targets();
    } catch (err) {
      throw storageError(err);
    }
    const ids = new Map(o.jobs.list().map((j) => [j.name, j.id]));
    return raw
      .map((t): Target => {
        const { job = t.scrapePool, ...labels } = t.labels;
        const last = scrapeTime(t.lastScrape);
        return {
          job,
          url: t.scrapeUrl,
          product: job === "openasy" ? (labels.product ?? null) : null,
          jobId: ids.get(job) ?? null,
          labels,
          // VictoriaMetrics calls a target down before its first scrape; it is not known yet.
          health: last && (t.health === "up" || t.health === "down") ? t.health : "unknown",
          lastScrape: last,
          durationMs: last ? Math.round(t.lastScrapeDuration * 1000) : null,
          samples: last ? (t.lastSamplesScraped ?? null) : null,
          error: t.lastError || null,
        };
      })
      .sort((a, b) => a.job.localeCompare(b.job) || a.url.localeCompare(b.url));
  }

  const count = (ts: Target[]) => ({
    up: ts.filter((t) => t.health === "up").length,
    down: ts.filter((t) => t.health === "down").length,
    unknown: ts.filter((t) => t.health === "unknown").length,
  });

  return {
    write,

    /** Writes the scrape config and has VictoriaMetrics read it. When it is not running, it reads it as it starts. */
    async sync(): Promise<void> {
      write();
      try {
        await o.vm.reload();
      } catch (err) {
        log("warn", "victoriametrics did not reload the scrape config; it reads it when it starts again", { error: String(err) });
      }
    },

    targets,

    async metricNames(): Promise<{ metrics: MetricName[]; totalSeries: number }> {
      try {
        const [names, metadata, tsdb] = await Promise.all([o.vm.names(), o.vm.metadata(), o.vm.tsdb(1000)]);
        const series = new Map(tsdb.seriesCountByMetricName.map((s) => [s.name, s.value]));
        return {
          metrics: names.map((name) => ({
            name,
            type: metadata[name]?.[0]?.type ?? null,
            help: metadata[name]?.[0]?.help ?? null,
            series: series.get(name) ?? null,
          })),
          totalSeries: tsdb.totalSeries,
        };
      } catch (err) {
        throw storageError(err);
      }
    },

    /** Everything the first screen and /metrics show. VictoriaMetrics not answering is a state, not an error. */
    async summary() {
      const answering = o.running() && (await o.vm.healthy());
      const [u, ts] = answering
        ? await Promise.all([readUsage().catch(() => EMPTY_USAGE), targets().catch(() => [] as Target[])])
        : [EMPTY_USAGE, [] as Target[]];
      return {
        storage: {
          running: answering,
          activeSeries: u.activeSeries,
          storageBytes: u.storageBytes,
          freeBytes: u.freeBytes,
          samplesTotal: u.samplesTotal,
          samplesPerSecond: answering ? (rate?.perSecond ?? null) : null,
          refusedSeries: u.refusedSeries,
          retentionDays: o.retentionDays,
          maxSeries: o.maxSeries,
        },
        targets: count(ts),
        jobs: o.jobs.list().length,
        products: o.sources.length,
        dashboards: o.dashboards.count(),
        down: ts.filter((t) => t.health === "down").slice(0, 20),
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;
export type Summary = Awaited<ReturnType<Service["summary"]>>;
