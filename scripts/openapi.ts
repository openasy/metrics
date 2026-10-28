// Writes openapi.json (ADR 0014, 0024). Run `node scripts/openapi.ts` after changing the API; a test fails when the
// file is out of date. Sign-in routes come from @openasy/auth and are merged in when the description is served.
import { writeFileSync } from "node:fs";

type S = Record<string, unknown>;
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dt = { type: "string", format: "date-time" };
const nul = (s: S) => ({ anyOf: [s, { type: "null" }] });
const arr = (s: S) => ({ type: "array", items: s });
const obj = (properties: Record<string, S>, required = Object.keys(properties)) => ({ type: "object", required, properties });
const map = (s: S = str) => ({ type: "object", additionalProperties: s });

const problem = { $ref: "#/components/responses/Problem" };
const ok = (schema: S, description = "OK") => ({ description, content: { "application/json": { schema } } });
const VIEWER = [{ session: [] }, { apiToken: [] }, { adminToken: [] }];
const INGEST = [{ ingestToken: [] }, { apiToken: [] }, { adminToken: [] }];
const id = (what: string) => [{ name: "id", in: "path", required: true, description: `The ${what}'s id.`, schema: str }];

/** An operation that needs a role (ADR 0003), with the refusals every such operation can answer. */
function op(role: "viewer" | "editor" | "admin", o: S & { responses: Record<string, unknown> }) {
  return {
    ...o,
    security: VIEWER,
    "x-openasy-role": role,
    description: [`Needs the ${role} role.`, o.description].filter(Boolean).join(" "),
    responses: { ...o.responses, "401": problem, "403": problem, "503": problem },
  };
}

const UNIT = {
  type: "string",
  enum: ["none", "percent", "ratio", "bytes", "bytesPerSecond", "seconds", "perSecond"],
  description: "How values are shown: percent is 0 to 100, ratio 0 to 1 shown as a percent.",
};

const schemas: Record<string, S> = {
  Problem: obj(
    {
      type: { type: "string", format: "uri" },
      title: str,
      status: int,
      code: {
        type: "string",
        enum: [
          "invalid-token",
          "invalid-json",
          "invalid-body",
          "conflict",
          "not-found",
          "not-configured",
          "payload-too-large",
          "storage-unavailable",
          "internal-error",
          "unauthenticated",
          "invalid-credentials",
          "mfa-required",
          "mfa-setup-required",
          "forbidden",
          "cross-site",
          "rate-limited",
        ],
        description: "Stable; match on this.",
      },
      detail: str,
    },
    ["type", "title", "status", "code"],
  ),
  Status: obj({ status: str }),
  Version: obj({ product: { const: "metrics" }, version: str }),
  ProductLink: obj({
    id: { type: "string", description: "The product, as OpenAsy names it.", examples: ["infrastructure"] },
    url: { type: "string", format: "uri", description: "The address people open it at.", examples: ["https://infra.example.com"] },
  }),
  ProductList: obj({ products: arr(ref("ProductLink")) }),
  Target: {
    ...obj({
      job: { type: "string", description: "The job; `openasy` for the OpenAsy products Metrics scrapes itself." },
      url: { type: "string", description: "The address scraped." },
      product: { ...nul(str), description: "The OpenAsy product, for targets of the job openasy." },
      jobId: { ...nul(str), description: "The job's id, for a job people added." },
      labels: { ...map(), description: "The labels of every series it brings, but job." },
      health: { type: "string", enum: ["up", "down", "unknown"], description: "Of the last scrape; unknown before the first." },
      lastScrape: nul(dt),
      durationMs: nul(int),
      samples: { ...nul(int), description: "Samples the last scrape brought." },
      error: { ...nul(str), description: "Why the last scrape failed." },
    }),
  },
  TargetList: obj({ targets: arr(ref("Target")) }),
  Job: obj({
    id: str,
    name: str,
    urls: arr(str),
    intervalSeconds: int,
    labels: map(),
    auth: { type: "string", enum: ["none", "bearer", "basic"] },
    username: nul(str),
    hasSecret: { type: "boolean", description: "Whether a password or bearer token is kept. It is never returned (ADR 0021)." },
    createdBy: str,
    createdAt: dt,
    updatedAt: dt,
  }),
  JobList: obj({ jobs: arr(ref("Job")) }),
  NewJob: obj(
    {
      name: { type: "string", pattern: "^[a-zA-Z_][a-zA-Z0-9_.-]{0,62}$", description: "The job label of what it reads. `openasy` is taken." },
      urls: {
        ...arr({ type: "string", format: "uri" }),
        minItems: 1,
        maxItems: 500,
        description: "http:// or https:// addresses; one without a path reads /metrics.",
      },
      intervalSeconds: { type: "integer", minimum: 5, maximum: 3600, description: "30 unless METRICS_SCRAPE_INTERVAL_SECONDS says otherwise." },
      labels: { ...map(), description: "Added to every series it reads; at most 20, not job and none starting with __." },
      auth: { type: "string", enum: ["none", "bearer", "basic"], default: "none" },
      username: { type: "string", description: "For basic." },
      secret: { type: "string", description: "The bearer token or password, sealed with the install's key. Leave it out to keep the one kept." },
    },
    ["name", "urls"],
  ),
  Panel: obj({
    title: str,
    expr: { type: "string", description: "PromQL; each series it returns is one line." },
    unit: UNIT,
    legend: { type: "string", description: "How a line is named, such as {{instance}}; empty names it by its labels." },
    stacked: bool,
  }),
  NewPanel: obj({ title: str, expr: str, unit: UNIT, legend: str, stacked: bool }, ["title", "expr"]),
  Dashboard: obj({
    id: str,
    name: str,
    folder: str,
    description: str,
    tags: arr(str),
    panels: arr(ref("Panel")),
    builtIn: { type: "boolean", description: "Comes with Metrics; it cannot be changed, only copied." },
    createdBy: str,
    updatedAt: dt,
  }),
  DashboardList: obj({ dashboards: arr(ref("Dashboard")) }),
  NewDashboard: obj(
    {
      name: { type: "string", maxLength: 120 },
      folder: { type: "string", maxLength: 60 },
      description: { type: "string", maxLength: 500 },
      tags: { ...arr(str), maxItems: 10 },
      panels: { ...arr(ref("NewPanel")), maxItems: 40 },
    },
    ["name"],
  ),
  MetricName: obj({
    name: str,
    type: { ...nul(str), description: "counter, gauge, histogram or summary, as the target sent it." },
    help: nul(str),
    series: { ...nul(int), description: "Its series now; null when it is not among the 1000 metrics with the most." },
  }),
  MetricNameList: obj({ metrics: arr(ref("MetricName")), totalSeries: int }),
  Summary: obj({
    storage: obj({
      running: { type: "boolean", description: "Whether VictoriaMetrics answers. When it does not, the numbers are 0." },
      activeSeries: int,
      storageBytes: int,
      freeBytes: int,
      samplesTotal: int,
      samplesPerSecond: nul(num),
      refusedSeries: { type: "integer", description: "New series refused by METRICS_MAX_SERIES since VictoriaMetrics started." },
      retentionDays: int,
      maxSeries: int,
    }),
    targets: obj({ up: int, down: int, unknown: int }),
    jobs: int,
    products: { type: "integer", description: "OpenAsy products scraped, besides Metrics itself." },
    dashboards: int,
    down: { ...arr(ref("Target")), description: "Targets down, at most 20." },
  }),
  PrometheusResponse: {
    type: "object",
    required: ["status"],
    properties: { status: { type: "string", enum: ["success", "error"] }, data: {}, errorType: str, error: str, warnings: arr(str), stats: {} },
    description: "As Prometheus' HTTP API answers: https://prometheus.io/docs/prometheus/latest/querying/api/",
  },
};

const PROMETHEUS: Record<string, { id: string; summary: string; params?: S[] }> = {
  query: { id: "Query", summary: "Instant query" },
  query_range: { id: "QueryRange", summary: "Range query" },
  series: { id: "Series", summary: "Series that match" },
  labels: { id: "Labels", summary: "Label names" },
  "label/{name}/values": {
    id: "LabelValues",
    summary: "Values of a label",
    params: [{ name: "name", in: "path", required: true, description: "The label, such as job or __name__.", schema: str }],
  },
  metadata: { id: "Metadata", summary: "Type and help of each metric" },
  "status/buildinfo": { id: "BuildInfo", summary: "Build information, which Grafana reads" },
};

function prometheus(method: "get" | "post", p: { id: string; summary: string; params?: S[] }) {
  return op("viewer", {
    operationId: `prometheus${p.id}${method === "post" ? "Post" : ""}`,
    tags: ["Prometheus API"],
    summary: method === "post" ? `${p.summary} (form)` : p.summary,
    description: "Prometheus' own parameters and answer, passed to VictoriaMetrics as they are; errors in the query come back in Prometheus' shape.",
    ...(p.params && { parameters: p.params }),
    ...(method === "post" && {
      requestBody: { content: { "application/x-www-form-urlencoded": { schema: { type: "object", additionalProperties: str } } } },
    }),
    responses: {
      "200": ok(ref("PrometheusResponse"), "Prometheus' answer."),
      "400": ok(ref("PrometheusResponse"), "The query could not be run, with why."),
      "422": ok(ref("PrometheusResponse"), "The query could not be run, with why."),
      "404": problem,
      "413": problem,
    },
  });
}

function push(operationId: string, summary: string, description: string, type: string) {
  return {
    post: {
      operationId,
      tags: ["Push"],
      summary,
      description: `${description} With \`METRICS_INGEST_TOKEN\`, or an API token with the editor role.`,
      security: INGEST,
      requestBody: { required: true, content: { [type]: { schema: { type: "string", format: "binary" } } } },
      responses: {
        "200": { description: "Stored." },
        "204": { description: "Stored." },
        "400": { description: "The body could not be read, with why.", content: { "text/plain": { schema: str } } },
        "401": problem,
        "403": problem,
        "413": problem,
        "503": problem,
      },
    },
  };
}

const spec = {
  openapi: "3.1.1",
  info: {
    title: "OpenAsy Metrics API",
    version: "0.1.0",
    summary: "The numbers behind your systems: scraped, kept in VictoriaMetrics, graphed and queried with PromQL.",
    description:
      "Every screen of Metrics uses this API, and so can your scripts (ADR 0014). Within `/api/v1` changes are additive only; anything removed is deprecated first (ADR 0024). Errors use Problem Details (RFC 9457).\n\nPromQL is answered under `/prometheus` exactly as Prometheus answers it, so Grafana, vmalert and any Prometheus client take `https://metrics.example.com/prometheus` as a Prometheus data source, with an API token as bearer token. Samples are pushed with `METRICS_INGEST_TOKEN`: OpenTelemetry metrics to `/opentelemetry/v1/metrics`, Prometheus remote write to `/prometheus/api/v1/write`. Everything else takes the session of a signed-in person or an API token, and each operation names the role it needs (`x-openasy-role`: viewer, editor, admin; ADR 0003).\n\nSign-in, members and API tokens are under `/api/v1/auth`, provided by [@openasy/auth](https://github.com/openasy/auth#routes).",
    license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
  },
  servers: [{ url: "/", description: "This Metrics" }],
  tags: [
    { name: "Targets", description: "What is scraped, and whether it answers." },
    { name: "Dashboards", description: "Panels of PromQL." },
    { name: "Metric list", description: "Every metric name with its type and series." },
    { name: "Prometheus API", description: "PromQL, as Prometheus answers it, for Grafana and other clients." },
    { name: "Push", description: "Samples sent in: OpenTelemetry and Prometheus remote write." },
    { name: "Product", description: "Version and overview of this Metrics." },
  ],
  paths: {
    "/api/v1/targets": {
      get: op("viewer", {
        operationId: "listTargets",
        tags: ["Targets"],
        summary: "Targets and their health",
        description: "Every address scraped: the OpenAsy products, Metrics itself and each job's, with its last scrape and error.",
        responses: { "200": ok(ref("TargetList")) },
      }),
    },
    "/api/v1/jobs": {
      get: op("viewer", { operationId: "listJobs", tags: ["Targets"], summary: "Scrape jobs", responses: { "200": ok(ref("JobList")) } }),
      post: op("admin", {
        operationId: "createJob",
        tags: ["Targets"],
        summary: "Add a scrape job",
        description: "It is scraped from now on.",
        requestBody: { required: true, content: { "application/json": { schema: ref("NewJob") } } },
        responses: { "201": ok(ref("Job"), "Added."), "400": problem, "409": problem, "422": problem },
      }),
    },
    "/api/v1/jobs/{id}": {
      get: op("viewer", {
        operationId: "getJob",
        tags: ["Targets"],
        summary: "A scrape job",
        parameters: id("job"),
        responses: { "200": ok(ref("Job")), "404": problem },
      }),
      put: op("admin", {
        operationId: "updateJob",
        tags: ["Targets"],
        summary: "Change a scrape job",
        parameters: id("job"),
        requestBody: { required: true, content: { "application/json": { schema: ref("NewJob") } } },
        responses: { "200": ok(ref("Job")), "400": problem, "404": problem, "409": problem, "422": problem },
      }),
      delete: op("admin", {
        operationId: "deleteJob",
        tags: ["Targets"],
        summary: "Delete a scrape job",
        description: "It is not scraped from now on; what it brought is kept for the retention.",
        parameters: id("job"),
        responses: { "204": { description: "Deleted." }, "404": problem },
      }),
    },
    "/api/v1/dashboards": {
      get: op("viewer", {
        operationId: "listDashboards",
        tags: ["Dashboards"],
        summary: "Dashboards",
        description: "People's, then the ones that come with Metrics.",
        responses: { "200": ok(ref("DashboardList")) },
      }),
      post: op("editor", {
        operationId: "createDashboard",
        tags: ["Dashboards"],
        summary: "Add a dashboard",
        requestBody: { required: true, content: { "application/json": { schema: ref("NewDashboard") } } },
        responses: { "201": ok(ref("Dashboard"), "Added."), "400": problem, "409": problem, "422": problem },
      }),
    },
    "/api/v1/dashboards/{id}": {
      get: op("viewer", {
        operationId: "getDashboard",
        tags: ["Dashboards"],
        summary: "A dashboard",
        parameters: id("dashboard"),
        responses: { "200": ok(ref("Dashboard")), "404": problem },
      }),
      put: op("editor", {
        operationId: "updateDashboard",
        tags: ["Dashboards"],
        summary: "Change a dashboard",
        description: "One that comes with Metrics answers 409.",
        parameters: id("dashboard"),
        requestBody: { required: true, content: { "application/json": { schema: ref("NewDashboard") } } },
        responses: { "200": ok(ref("Dashboard")), "400": problem, "404": problem, "409": problem, "422": problem },
      }),
      delete: op("editor", {
        operationId: "deleteDashboard",
        tags: ["Dashboards"],
        summary: "Delete a dashboard",
        description: "One that comes with Metrics answers 409.",
        parameters: id("dashboard"),
        responses: { "204": { description: "Deleted." }, "404": problem, "409": problem },
      }),
    },
    "/api/v1/metric-names": {
      get: op("viewer", {
        operationId: "listMetricNames",
        tags: ["Metric list"],
        summary: "Every metric name",
        description: "With its type and help, as its target sent them, and its series now.",
        responses: { "200": ok(ref("MetricNameList")) },
      }),
    },
    ...Object.fromEntries(
      Object.entries(PROMETHEUS).map(([path, p]) => [`/prometheus/api/v1/${path}`, { get: prometheus("get", p), post: prometheus("post", p) }]),
    ),
    "/prometheus/api/v1/write": push(
      "remoteWrite",
      "Prometheus remote write",
      "For a Prometheus or an agent that keeps its own scraping: `remote_write` to this address, snappy-compressed protobuf.",
      "application/x-protobuf",
    ),
    "/opentelemetry/v1/metrics": push(
      "pushOtlp",
      "OpenTelemetry metrics",
      "OTLP over HTTP with protobuf, as a collector's otlphttp exporter sends it to `https://metrics.example.com/opentelemetry`; gzip is taken. Names become Prometheus names, and service.name becomes the label service_name.",
      "application/x-protobuf",
    ),
    "/api/v1/summary": {
      get: op("viewer", {
        operationId: "getSummary",
        tags: ["Product"],
        summary: "Overview",
        description: "Storage, targets by health and what is set up, for the first screen.",
        responses: { "200": ok(ref("Summary")) },
      }),
    },
    "/api/v1/products": {
      get: op("viewer", {
        operationId: "listProducts",
        tags: ["Product"],
        summary: "Other products of this install",
        responses: { "200": ok(ref("ProductList"), "From OPENASY_PRODUCTS, for the product switcher.") },
      }),
    },
    "/api/v1/version": {
      get: { operationId: "getVersion", tags: ["Product"], summary: "Version", security: [], responses: { "200": ok(ref("Version"), "The running version.") } },
    },
    "/healthz": {
      get: {
        operationId: "liveness",
        tags: ["Product"],
        summary: "Liveness",
        security: [],
        responses: { "200": ok(ref("Status"), "The process is running.") },
      },
    },
    "/readyz": {
      get: {
        operationId: "readiness",
        tags: ["Product"],
        summary: "Readiness",
        description: "Ready while the database and VictoriaMetrics answer.",
        security: [],
        responses: { "200": ok(ref("Status"), "Ready to serve."), "503": ok(ref("Status"), "The database or VictoriaMetrics is unavailable.") },
      },
    },
    "/metrics": {
      get: {
        operationId: "metrics",
        tags: ["Product"],
        summary: "Prometheus metrics",
        security: [],
        responses: { "200": { description: "Metrics in the Prometheus text format.", content: { "text/plain": { schema: str } } } },
      },
    },
  },
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "__Host-openasy-session",
        description:
          "The browser session after signing in (`openasy-session` when Metrics runs on plain http://localhost). Requests that change something must come from the Metrics origin.",
      },
      apiToken: {
        type: "http",
        scheme: "bearer",
        description:
          "An API token created under Settings → API tokens (`oa_metrics_...`): one role, always an expiry (ADR 0003). Grafana sends one as its data source's bearer token.",
      },
      adminToken: {
        type: "http",
        scheme: "bearer",
        description:
          "Only when Metrics is started by its tests or a local script: one shared token with the admin role. A production install does not have it.",
      },
      ingestToken: {
        type: "http",
        scheme: "bearer",
        description: "`METRICS_INGEST_TOKEN`: for OpenTelemetry collectors and Prometheus remote write. It can push samples, nothing else.",
      },
    },
    responses: { Problem: { description: "An error, as RFC 9457 Problem Details.", content: { "application/problem+json": { schema: ref("Problem") } } } },
    schemas,
  },
};

export const OPENAPI = spec;
if (import.meta.url === `file://${process.argv[1]}`) writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
