import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { createDashboards } from "./dashboards.ts";
import { openDb } from "./db.ts";
import { createJobs } from "./jobs.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { sealer } from "./seal.ts";
import { createService } from "./service.ts";
import { parseSources } from "./sources.ts";
import { createVmClient, startVictoriaMetrics, waitHealthy } from "./vm.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.METRICS_DATA ?? "/data";
// The scrape config and the secret files of jobs: on tmpfs, never on the data volume (ADR 0021).
const runDir = process.env.METRICS_RUN_DIR ?? "/tmp/metrics";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.METRICS_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.METRICS_METRICS_PORT ? Number(process.env.METRICS_METRICS_PORT) : undefined;
const whole = (name: string, fallback: number, min: number, max: number) => {
  const v = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be a whole number, ${min} to ${max}`);
  return v;
};
const retentionDays = whole("METRICS_RETENTION_DAYS", 30, 1, 3650);
const maxSeries = whole("METRICS_MAX_SERIES", 1_000_000, 0, 1_000_000_000);
const intervalSeconds = whole("METRICS_SCRAPE_INTERVAL_SECONDS", 30, 5, 3600);
const vmPort = whole("METRICS_STORAGE_PORT", 8428, 1, 65_535);
const vmBinary = process.env.METRICS_VICTORIAMETRICS ?? new URL("../vendor/victoria-metrics", import.meta.url).pathname;

const db = openDb(join(dataDir, "metrics.db"));
// The address people open Metrics at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.METRICS_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.METRICS_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "metrics",
  productName: "OpenAsy Metrics",
  origin: publicUrl,
  // Locally the same metrics is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.METRICS_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "METRICS_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const sources = parseSources(products.products, process.env.METRICS_SOURCES);
if (sources.invalid.length) log("warn", "METRICS_SOURCES: left out entries that are not product=https://address/metrics", { entries: sources.invalid });

const jobs = createJobs(db, { sealer: sealer(secretsKey), defaultIntervalSeconds: intervalSeconds });
const dashboards = createDashboards(db);
const vm = createVmClient(`http://127.0.0.1:${vmPort}`);
let storage: ReturnType<typeof startVictoriaMetrics> | undefined;
const service = createService({
  vm,
  jobs,
  dashboards,
  sources: sources.sources,
  // Metrics reads its own /metrics directly, not through the proxy.
  self: `http://127.0.0.1:${metricsPort ?? port}/metrics`,
  runDir,
  intervalSeconds,
  retentionDays,
  maxSeries,
  running: () => storage?.state.running ?? false,
});
// The config is written before VictoriaMetrics starts, so it scrapes from its first second.
storage = startVictoriaMetrics({
  binary: vmBinary,
  dataPath: join(dataDir, "victoria-metrics"),
  port: vmPort,
  scrapeConfig: service.write(),
  retentionDays,
  maxSeries,
});
void waitHealthy(vm).then((ok) =>
  ok ? log("info", "victoriametrics is answering", { port: vmPort }) : log("error", "victoriametrics did not answer in 15 seconds"),
);

const server = createServer(
  createApp({
    db,
    vm,
    service,
    jobs,
    dashboards,
    version,
    auth,
    ingestToken: process.env.METRICS_INGEST_TOKEN,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(service, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () =>
  log("info", "metrics started", {
    version,
    port,
    data: dataDir,
    headless,
    retentionDays,
    maxSeries,
    intervalSeconds,
    products: sources.sources.map((s) => s.product),
  }),
);
if (!process.env.METRICS_INGEST_TOKEN)
  log(
    "info",
    "METRICS_INGEST_TOKEN is not set; OpenTelemetry collectors and remote write need an API token with the editor role (Settings, API tokens) to push",
  );
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "METRICS_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put metrics behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (!secretsKey)
  log("warn", "no secrets key: TOTP secrets and the passwords and tokens of scrape jobs are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", {
    file: secretsKeyFile,
  });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  server.close(() => {
    void storage!.stop().then(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
