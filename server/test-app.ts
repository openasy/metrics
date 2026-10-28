// Starts the app on a random port for tests, with the real VictoriaMetrics from vendor/ (npm test fetches it) and a
// fake exporter that only answers its bearer token.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { createDashboards } from "./dashboards.ts";
import { openDb } from "./db.ts";
import { createJobs } from "./jobs.ts";
import { sealer } from "./seal.ts";
import { createService } from "./service.ts";
import type { Source } from "./scrape.ts";
import { createVmClient, startVictoriaMetrics, waitHealthy } from "./vm.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const ADMIN_TOKEN = "test-admin-token";
export const EXPORTER_TOKEN = "exporter-s3cret";
export const BINARY = new URL("../vendor/victoria-metrics", import.meta.url).pathname;

/** A free port on 127.0.0.1, for VictoriaMetrics. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** An exporter, as node_exporter would be: one counter, behind a bearer token. */
export async function fakeExporter() {
  let hits = 0;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${EXPORTER_TOKEN}`) return void res.writeHead(401).end("unauthorized");
    hits++;
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(`# HELP demo_requests_total Requests the demo served.\n# TYPE demo_requests_total counter\ndemo_requests_total{code="200"} ${100 + hits}\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Waits until check returns something truthy, up to ms. */
export async function until<T>(check: () => Promise<T | undefined | false | null | "">, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function startApp(opts: Partial<AppOptions> & { version: string; sources?: Source[] }) {
  const dir = mkdtempSync(join(tmpdir(), "metrics-test-"));
  const db = openDb(":memory:");
  const jobs = createJobs(db, { sealer: sealer(Buffer.alloc(32, 5)), defaultIntervalSeconds: 5 });
  const dashboards = createDashboards(db);
  const vmPort = await freePort();
  const vm = createVmClient(`http://127.0.0.1:${vmPort}`);
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  let storage: ReturnType<typeof startVictoriaMetrics> | undefined;
  const { sources = [], ...appOptions } = opts;
  const service = createService({
    vm,
    jobs,
    dashboards,
    sources,
    self: `http://127.0.0.1:${port}/metrics`,
    runDir: join(dir, "run"),
    intervalSeconds: 5,
    retentionDays: 30,
    maxSeries: 100_000,
    running: () => storage?.state.running ?? false,
  });
  storage = startVictoriaMetrics({
    binary: BINARY,
    dataPath: join(dir, "vm"),
    port: vmPort,
    scrapeConfig: service.write(),
    retentionDays: 30,
    maxSeries: 100_000,
    latencyOffsetSeconds: 1,
  });
  if (!(await waitHealthy(vm))) throw new Error("VictoriaMetrics did not start");
  const auth = createAuth({ db, product: "metrics", productName: "OpenAsy Metrics", origin: base });
  handler = createApp({ db, vm, service, jobs, dashboards, auth, ingestToken: INGEST_TOKEN, adminToken: ADMIN_TOKEN, ...appOptions });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage!.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { db, vm, jobs, service, auth, base, dir, admin, get, send, close };
}
