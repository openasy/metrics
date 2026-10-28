// The scrape config VictoriaMetrics reads (Prometheus' scrape_configs): the install's OpenAsy products under the job
// `openasy`, Metrics itself, and the jobs people add. It is written to a directory in /tmp, never to the data volume,
// with each job's password or token in a file of its own that only this process can read (ADR 0021).
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScrapeJob } from "./jobs.ts";

/** An OpenAsy product to scrape: its id and the full address of its /metrics. */
export interface Source {
  product: string;
  url: string;
}

interface StaticConfig {
  targets: string[];
  labels: Record<string, string>;
}

/**
 * One address as a target of a static config. The scheme, path and query go in the labels Prometheus reads them from,
 * so one job can read addresses that differ in them.
 */
export function staticConfig(address: string, labels: Record<string, string> = {}): StaticConfig {
  const url = new URL(address);
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) params[`__param_${k}`] = v;
  return {
    targets: [url.host],
    labels: { ...labels, __scheme__: url.protocol.slice(0, -1), __metrics_path__: url.pathname === "/" ? "/metrics" : url.pathname, ...params },
  };
}

export interface ScrapeInput {
  jobs: ScrapeJob[];
  /** The install's other OpenAsy products, from OPENASY_PRODUCTS or METRICS_SOURCES. */
  sources: Source[];
  /** Metrics' own /metrics. */
  self: string;
  intervalSeconds: number;
  /** Where a job's secret file is. */
  secretPath: (jobId: string) => string;
}

const timeout = (interval: number) => `${Math.min(10, interval)}s`;

/** The scrape config as an object; JSON is YAML, so it is written as it is. */
export function renderScrapeConfig({ jobs, sources, self, intervalSeconds, secretPath }: ScrapeInput) {
  const openasy = [staticConfig(self, { product: "metrics" }), ...sources.map((s) => staticConfig(s.url, { product: s.product }))];
  return {
    global: { scrape_interval: `${intervalSeconds}s`, scrape_timeout: timeout(intervalSeconds) },
    scrape_configs: [
      // A product's own labels, such as product on openasy_build_info, are kept as it sent them rather than renamed
      // exported_product; they are the same products.
      { job_name: "openasy", honor_labels: true, static_configs: openasy },
      ...jobs.map((j) => ({
        job_name: j.name,
        scrape_interval: `${j.intervalSeconds}s`,
        scrape_timeout: timeout(j.intervalSeconds),
        static_configs: j.urls.map((u) => staticConfig(u, j.labels)),
        ...(j.auth === "bearer" && { authorization: { type: "Bearer", credentials_file: secretPath(j.id) } }),
        ...(j.auth === "basic" && { basic_auth: { username: j.username ?? "", password_file: secretPath(j.id) } }),
      })),
    ],
  };
}

/** Writes the config and the secret files to dir, removing those of jobs that are gone. Returns the config's path. */
export function writeScrapeConfig(dir: string, input: Omit<ScrapeInput, "secretPath">): string {
  const secrets = join(dir, "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const secretPath = (id: string) => join(secrets, id);
  const keep = new Set<string>();
  for (const j of input.jobs) {
    if (j.auth === "none" || j.secret === null) continue;
    writeFileSync(secretPath(j.id), j.secret, { mode: 0o600 });
    keep.add(j.id);
  }
  for (const f of readdirSync(secrets)) if (!keep.has(f)) rmSync(join(secrets, f), { force: true });
  const path = join(dir, "scrape.yaml");
  // Written whole, then moved over the old one, so VictoriaMetrics never reads half a file.
  writeFileSync(`${path}.next`, JSON.stringify(renderScrapeConfig({ ...input, secretPath }), null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.next`, path);
  return path;
}
