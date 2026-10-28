import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Dashboards } from "./dashboards.ts";
import type { Jobs } from "./jobs.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import { MetricsError, type ProblemCode } from "./problem.ts";
import type { ProductLink } from "./products.ts";
import type { Service } from "./service.ts";
import { VmError, type VmClient } from "./vm.ts";

export interface AppOptions {
  db: DatabaseSync;
  vm: VmClient;
  service: Service;
  jobs: Jobs;
  dashboards: Dashboards;
  version: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** Token OpenTelemetry collectors and Prometheus remote write push samples with. It can push and nothing else (ADR 0003). */
  ingestToken?: string;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

async function metricsText(service: Service, version: string) {
  return renderMetrics(version, await service.summary());
}

/** Serves only /metrics, for a port that is not exposed with the rest (METRICS_METRICS_PORT). */
export function createMetricsHandler(service: Service, version: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, await metricsText(service, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'`,
};

/** Largest push of samples accepted, as sent (snappy or gzip); VictoriaMetrics limits it again once unpacked. */
const PUSH_LIMIT = 32 * 1024 * 1024;
/** Largest form of a Prometheus API request: a long PromQL query and its match[] selectors. */
const QUERY_LIMIT = 1024 * 1024;

/**
 * The read part of the Prometheus HTTP API, as Grafana, vmalert and other Prometheus clients call it, under
 * /prometheus. Only these are passed on: VictoriaMetrics' admin paths, such as deleting series, are not reachable.
 */
const PROMETHEUS_READ = ["query", "query_range", "series", "labels", "label/:name/values", "metadata", "status/buildinfo"];

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "payload-too-large": "Payload too large",
  "storage-unavailable": "Storage unavailable",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json");
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

/** Reads the whole body as it was sent, up to limit bytes; compressed bodies stay compressed. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new MetricsError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024 / 1024)} MiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    throw new MetricsError(400, "invalid-json", "The body must be JSON, not compressed.");
  const raw = await readBody(req, limit).catch((err: unknown) => {
    if (err instanceof MetricsError && err.code === "payload-too-large")
      throw new MetricsError(400, "invalid-json", `The body must be JSON, at most ${Math.round(limit / 1024)} KiB.`);
    throw err;
  });
  try {
    const body = JSON.parse(raw.toString("utf8")) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new MetricsError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003), or "ingest" for samples pushed by collectors and Prometheus. */
type Access = "none" | "ingest" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  /** Who made the request, for the record of a change. */
  actor: () => string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

export function createApp({
  db,
  vm,
  service,
  jobs,
  dashboards,
  version,
  auth,
  adminToken,
  ingestToken,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, SECURITY_HEADERS).end();
  };

  /** Passes a request on to VictoriaMetrics and its answer back as it is. */
  async function forward({ req, res, url }: Ctx, path: string, limit: number) {
    const body = req.method === "POST" ? await readBody(req, limit) : undefined;
    const type = req.headers["content-type"];
    const encoding = req.headers["content-encoding"];
    let answer: Response;
    try {
      answer = await vm.forward(path, url.search, { method: req.method ?? "GET", body, type, encoding });
    } catch (err) {
      if (err instanceof VmError) throw new MetricsError(503, "storage-unavailable", err.message);
      throw err;
    }
    const out = Buffer.from(await answer.arrayBuffer());
    if (answer.status === 204 || !out.length) {
      res.writeHead(answer.status, { ...SECURITY_HEADERS, "content-length": 0 }).end();
      return;
    }
    send(res, answer.status, out, answer.headers.get("content-type") ?? "application/json");
  }

  /** A change to the jobs takes effect at once: the scrape config is written again and VictoriaMetrics reads it. */
  const synced = async <T>(value: T) => (await service.sync(), value);

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "metrics", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => service.summary() },

    // What is scraped: the targets and their health, and the jobs people add. A job may hold a password, so changing
    // them is for admins.
    { method: "GET", path: "/api/v1/targets", auth: "viewer", handle: async () => ({ targets: await service.targets() }) },
    { method: "GET", path: "/api/v1/jobs", auth: "viewer", handle: () => ({ jobs: jobs.list() }) },
    {
      method: "POST",
      path: "/api/v1/jobs",
      auth: "admin",
      handle: async ({ res, body, actor }) => json(res, 201, await synced(jobs.create(await body(), actor()))),
    },
    { method: "GET", path: "/api/v1/jobs/:id", auth: "viewer", handle: ({ params }) => jobs.get(params[0]!) },
    { method: "PUT", path: "/api/v1/jobs/:id", auth: "admin", handle: async ({ params, body }) => synced(jobs.update(params[0]!, await body())) },
    {
      method: "DELETE",
      path: "/api/v1/jobs/:id",
      auth: "admin",
      handle: async ({ res, params }) => (jobs.remove(params[0]!), await service.sync(), noContent(res)),
    },

    // Dashboards.
    { method: "GET", path: "/api/v1/dashboards", auth: "viewer", handle: () => ({ dashboards: dashboards.list() }) },
    {
      method: "POST",
      path: "/api/v1/dashboards",
      auth: "editor",
      handle: async ({ res, body, actor }) => json(res, 201, dashboards.create(await body(), actor())),
    },
    { method: "GET", path: "/api/v1/dashboards/:id", auth: "viewer", handle: ({ params }) => dashboards.get(params[0]!) },
    { method: "PUT", path: "/api/v1/dashboards/:id", auth: "editor", handle: async ({ params, body }) => dashboards.update(params[0]!, await body()) },
    { method: "DELETE", path: "/api/v1/dashboards/:id", auth: "editor", handle: ({ res, params }) => (dashboards.remove(params[0]!), noContent(res)) },

    // Every metric name, with its type, help and series.
    { method: "GET", path: "/api/v1/metric-names", auth: "viewer", handle: () => service.metricNames() },

    // PromQL, as Prometheus answers it, for the screens, Grafana and vmalert.
    ...PROMETHEUS_READ.flatMap((p) =>
      ["GET", "POST"].map((method): Route => ({
        method,
        path: `/prometheus/api/v1/${p}`,
        auth: "viewer",
        handle: (ctx) => {
          // A label named . or .. would move the path VictoriaMetrics is asked for up a level.
          if (ctx.params[0] !== undefined && /^\.+$/.test(ctx.params[0])) throw new MetricsError(404, "not-found", "No such label.");
          return forward(ctx, `/api/v1/${p.replace(":name", encodeURIComponent(ctx.params[0] ?? ""))}`, QUERY_LIMIT);
        },
      })),
    ),

    // Samples pushed in: Prometheus remote write and OpenTelemetry metrics over HTTP (protobuf).
    { method: "POST", path: "/prometheus/api/v1/write", auth: "ingest", handle: (ctx) => forward(ctx, "/api/v1/write", PUSH_LIMIT) },
    { method: "POST", path: "/opentelemetry/v1/metrics", auth: "ingest", handle: (ctx) => forward(ctx, "/opentelemetry/v1/metrics", PUSH_LIMIT) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "([^/]+)")}$`) }));

  /** Returns who is calling, or null for the ingest token. */
  function authorize(req: IncomingMessage, access: Access): string | null {
    if (access === "none") return null;
    if (access === "ingest" && tokenMatches(req.headers.authorization, ingestToken)) return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return "admin token";
    if (access === "ingest") {
      // An API token with the editor role can push too, for a collector set up from Settings.
      if (!ingestToken && !req.headers.authorization?.startsWith("Bearer oa_"))
        throw new MetricsError(503, "not-configured", "Set METRICS_INGEST_TOKEN on metrics, or send an API token with the editor role.");
      if (!req.headers.authorization?.startsWith("Bearer oa_"))
        throw new MetricsError(401, "invalid-token", "Send METRICS_INGEST_TOKEN or an API token as a bearer token.");
    }
    const p = auth.authorize(req, access === "ingest" ? "editor" : access);
    return p.kind === "session" ? p.user.name : `API token ${p.name}`;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      // Ready while the database and VictoriaMetrics both answer.
      let ready = "ready";
      try {
        db.prepare("SELECT 1").get();
      } catch {
        ready = "database unavailable";
      }
      if (ready === "ready" && !(await vm.healthy())) ready = "storage unavailable";
      json(res, ready === "ready" ? 200 : 503, { status: ready });
      return "/readyz";
    }

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, await metricsText(service, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const who = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, body: () => readJson(req), actor: () => who ?? "unknown" });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof MetricsError)) throw err;
        problem(res, err.status, err.code, err.message);
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/") || path.startsWith("/prometheus/") || path.startsWith("/opentelemetry/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    if (routeName !== "/healthz" && routeName !== "/metrics") {
      log("info", "request", { method: req.method, path: url(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string. */
const url = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];
