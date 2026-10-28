// VictoriaMetrics inside the product's container (ADR 0063, as VictoriaLogs is in Logs, ADR 0035): started as a child
// process on 127.0.0.1, restarted when it stops, and reached only through this client. It scrapes the targets of the
// config file scrape.ts writes, keeps the series and answers PromQL; nobody talks to it but Metrics.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { log } from "./log.ts";

export interface VmOptions {
  binary: string;
  dataPath: string;
  port: number;
  /** The scrape config file, rewritten by Metrics and reloaded without a restart. */
  scrapeConfig: string;
  retentionDays: number;
  /** New series refused above this many in an hour, so one label with a request id cannot fill the disk. 0 is no limit. */
  maxSeries: number;
  /** How far behind now instant queries look, for samples still arriving. VictoriaMetrics' default is 30 seconds. */
  latencyOffsetSeconds?: number;
}

/** A target as VictoriaMetrics reports it at /api/v1/targets, in Prometheus' shape. */
export interface VmTarget {
  labels: Record<string, string>;
  scrapePool: string;
  scrapeUrl: string;
  lastError: string;
  lastScrape: string;
  lastScrapeDuration: number;
  lastSamplesScraped?: number;
  health: "up" | "down" | "unknown";
}

/** Storage, from VictoriaMetrics' own /metrics. */
export interface VmUsage {
  storageBytes: number;
  freeBytes: number;
  /** Series that got a sample in the last hour. */
  activeSeries: number;
  /** Every sample stored since VictoriaMetrics started. */
  samplesTotal: number;
  /** New series refused by the series limit since it started. */
  refusedSeries: number;
}

export class VmError extends Error {
  /** 400 when VictoriaMetrics refused the query itself, with its reason; 503 when it could not be reached. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sum = (text: string, re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);

export function createVmClient(base: string, opts: { timeoutMs?: number } = {}) {
  const timeout = opts.timeoutMs ?? 30_000;

  async function get(path: string, params: Record<string, string | number | undefined> = {}) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") form.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(new URL(path, base), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new VmError(503, `VictoriaMetrics is unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text.trim();
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? detail;
      } catch {
        // Not JSON: its text as it is.
      }
      throw new VmError(res.status >= 500 ? 503 : 400, detail.slice(0, 2000) || `VictoriaMetrics answered ${res.status}`);
    }
    return res;
  }

  const data = async <T>(path: string, params?: Record<string, string | number | undefined>) => ((await (await get(path, params)).json()) as { data: T }).data;

  return {
    async healthy(): Promise<boolean> {
      try {
        const r = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },

    /** Reads the scrape config file again; targets added or removed take effect at once. */
    async reload(): Promise<void> {
      await get("/-/reload");
    },

    /**
     * Passes a request of the Prometheus HTTP API on as it came: its query string, and its form body for POST, which
     * Grafana uses. The answer is VictoriaMetrics' own, errors too, as Prometheus clients expect.
     */
    async forward(path: string, search: string, init: { method: string; body?: Buffer; type?: string; encoding?: string }): Promise<Response> {
      try {
        return await fetch(new URL(path + search, base), {
          method: init.method === "POST" ? "POST" : "GET",
          headers: {
            ...(init.type && { "content-type": init.type }),
            ...(init.encoding && { "content-encoding": init.encoding }),
          },
          ...(init.method === "POST" && init.body && { body: init.body }),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        throw new VmError(503, `VictoriaMetrics is unreachable: ${(err as Error).message}`);
      }
    },

    async targets(): Promise<VmTarget[]> {
      return (await data<{ activeTargets: VmTarget[] }>("/api/v1/targets")).activeTargets;
    },

    /** An instant query: each series' labels and value now. */
    async query(expr: string): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
      return (await data<{ result: Array<{ metric: Record<string, string>; value: [number, string] }> }>("/api/v1/query", { query: expr })).result;
    },

    async names(): Promise<string[]> {
      return data<string[]>("/api/v1/label/__name__/values");
    },

    /** Type and help of each metric, as its target sent them. */
    async metadata(): Promise<Record<string, Array<{ type: string; help: string }>>> {
      return data<Record<string, Array<{ type: string; help: string }>>>("/api/v1/metadata");
    },

    /** Series counts: in all, and of the metrics with the most. */
    async tsdb(topN: number): Promise<{ totalSeries: number; seriesCountByMetricName: Array<{ name: string; value: number }> }> {
      return data("/api/v1/status/tsdb", { topN });
    },

    async usage(): Promise<VmUsage> {
      let text: string;
      try {
        text = await (await fetch(new URL("/metrics", base), { signal: AbortSignal.timeout(5000) })).text();
      } catch (err) {
        throw new VmError(503, `VictoriaMetrics is unreachable: ${(err as Error).message}`);
      }
      return {
        storageBytes: sum(text, /^vm_data_size_bytes\{[^}]*\} (\S+)$/gm),
        freeBytes: sum(text, /^vm_free_disk_space_bytes\{[^}]*\} (\S+)$/gm),
        activeSeries: sum(text, /^vm_cache_entries\{type="storage\/hour_metric_ids"\} (\S+)$/gm),
        samplesTotal: sum(text, /^vm_rows_inserted_total\{[^}]*\} (\S+)$/gm),
        refusedSeries: sum(text, /^vm_hourly_series_limit_rows_dropped_total (\S+)$/gm),
      };
    },
  };
}

export type VmClient = ReturnType<typeof createVmClient>;

/**
 * Starts VictoriaMetrics and keeps it running: it is restarted a second after it stops, then after longer waits if it
 * keeps stopping.
 */
export function startVictoriaMetrics(o: VmOptions) {
  mkdirSync(o.dataPath, { recursive: true });
  let child: ChildProcess | undefined;
  let stopping = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  const state = { running: false, restarts: 0, lastExit: null as string | null };

  const args = [
    `-storageDataPath=${o.dataPath}`,
    `-httpListenAddr=127.0.0.1:${o.port}`,
    `-retentionPeriod=${o.retentionDays}d`,
    `-promscrape.config=${o.scrapeConfig}`,
    // A target that does not answer is shown on the Targets screen with its error, not logged every interval.
    "-promscrape.suppressScrapeErrors",
    // Type and help of each metric, for the metric list.
    "-enableMetadata",
    // OpenTelemetry names such as http.server.duration become http_server_duration_seconds, as in Prometheus.
    "-opentelemetry.usePrometheusNaming",
    ...(o.maxSeries > 0 ? [`-storage.maxHourlySeries=${o.maxSeries}`] : []),
    ...(o.latencyOffsetSeconds !== undefined ? [`-search.latencyOffset=${o.latencyOffsetSeconds}s`] : []),
    "-loggerFormat=json",
    "-loggerLevel=WARN",
    "-search.maxQueryDuration=30s",
    "-search.maxConcurrentRequests=8",
    "-http.disableResponseCompression",
  ];

  function run() {
    const c = spawn(o.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    child = c;
    state.running = true;
    // Its own JSON logs go out with ours, marked as VictoriaMetrics' (ADR 0017).
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        let msg = line;
        let level = "warn";
        try {
          const j = JSON.parse(line) as { msg?: string; level?: string };
          msg = j.msg ?? line;
          level = j.level === "error" || j.level === "fatal" || j.level === "panic" ? "error" : j.level === "info" ? "info" : "warn";
        } catch {
          // Not JSON: passed on as it is.
        }
        log(level as "info" | "warn" | "error", "victoriametrics", { detail: msg });
      }
    };
    c.stdout!.on("data", relay);
    c.stderr!.on("data", relay);
    c.on("error", (err) => log("error", "victoriametrics could not start", { error: String(err), binary: o.binary }));
    c.on("exit", (code, signal) => {
      state.running = false;
      if (child !== c) return;
      child = undefined;
      if (stopping) return;
      failures++;
      state.restarts++;
      state.lastExit = `${new Date().toISOString()}: ${signal ?? `exit ${code}`}`;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      log("error", "victoriametrics stopped; starting it again", { code, signal, inMs: wait });
      timer = setTimeout(run, wait);
    });
    // Running for a minute counts as healthy again.
    setTimeout(() => child === c && (failures = 0), 60_000).unref();
  }
  run();

  function stop(): Promise<void> {
    stopping = true;
    clearTimeout(timer);
    const c = child;
    if (!c || c.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => c.kill("SIGKILL"), 10_000);
      c.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      c.kill("SIGTERM");
    });
  }

  return { url: `http://127.0.0.1:${o.port}`, state, stop };
}

export type VictoriaMetrics = ReturnType<typeof startVictoriaMetrics>;

/** Waits until VictoriaMetrics answers /health, up to `ms`. */
export async function waitHealthy(client: VmClient, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await client.healthy()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
