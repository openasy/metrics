import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI } from "../scripts/openapi.ts";
import { ADMIN_TOKEN, INGEST_TOKEN, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "metrics-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("is what scripts/openapi.ts writes", () => {
    expect(spec).toEqual(JSON.parse(JSON.stringify(OPENAPI)));
  });

  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Metrics' own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("jobs and targets", async () => {
    const j = "/api/v1/jobs/{id}";
    const job = (
      (await call("POST", "/api/v1/jobs", admin({ name: "node", urls: ["http://127.0.0.1:9/metrics"], labels: { team: "a" } }))).body as { id: string }
    ).id;
    await call("POST", "/api/v1/jobs", admin({ name: "node", urls: ["http://127.0.0.1:9/metrics"] }));
    await call("POST", "/api/v1/jobs", admin({ name: "x", urls: ["nope"] }));
    await call("POST", "/api/v1/jobs", admin("nope"));
    await call("POST", "/api/v1/jobs", { method: "POST" });
    await call("GET", "/api/v1/jobs", admin());
    await call("GET", "/api/v1/jobs", {});
    await call("GET", j, admin(), `/api/v1/jobs/${job}`);
    await call("GET", j, admin(), "/api/v1/jobs/missing");
    await call("GET", j, {}, `/api/v1/jobs/${job}`);
    await call("PUT", j, admin({ name: "node", urls: ["http://127.0.0.1:9/metrics"], auth: "bearer", secret: "t" }), `/api/v1/jobs/${job}`);
    await call("PUT", j, admin({ name: "node", urls: [] }), `/api/v1/jobs/${job}`);
    await call("PUT", j, admin("nope"), `/api/v1/jobs/${job}`);
    await call("PUT", j, admin({ name: "x", urls: ["http://h/"] }), "/api/v1/jobs/missing");
    await call("PUT", j, { method: "PUT" }, `/api/v1/jobs/${job}`);
    const other = ((await call("POST", "/api/v1/jobs", admin({ name: "other", urls: ["http://127.0.0.1:9/metrics"] }))).body as { id: string }).id;
    await call("PUT", j, admin({ name: "node", urls: ["http://127.0.0.1:9/metrics"] }), `/api/v1/jobs/${other}`);
    await call("GET", "/api/v1/targets", admin());
    await call("GET", "/api/v1/targets", {});
    await call("DELETE", j, admin(), `/api/v1/jobs/${job}`);
    await call("DELETE", j, admin(), "/api/v1/jobs/missing");
    await call("DELETE", j, { method: "DELETE" }, `/api/v1/jobs/${other}`);
  });

  it("dashboards", async () => {
    const d = "/api/v1/dashboards/{id}";
    const body = { name: "orders-api", folder: "Payments", tags: ["red"], panels: [{ title: "Up", expr: "up", unit: "none" }] };
    const id = ((await call("POST", "/api/v1/dashboards", admin(body))).body as { id: string }).id;
    await call("POST", "/api/v1/dashboards", admin(body));
    await call("POST", "/api/v1/dashboards", admin({ name: "" }));
    await call("POST", "/api/v1/dashboards", admin("nope"));
    await call("POST", "/api/v1/dashboards", { method: "POST" });
    await call("GET", "/api/v1/dashboards", admin());
    await call("GET", "/api/v1/dashboards", {});
    await call("GET", d, admin(), `/api/v1/dashboards/${id}`);
    await call("GET", d, admin(), "/api/v1/dashboards/openasy");
    await call("GET", d, admin(), "/api/v1/dashboards/missing");
    await call("GET", d, {}, `/api/v1/dashboards/${id}`);
    await call("PUT", d, admin({ ...body, panels: [...body.panels, { title: "Load", expr: "node_load1", stacked: true }] }), `/api/v1/dashboards/${id}`);
    await call("PUT", d, admin({ name: "x", panels: [{ title: "t" }] }), `/api/v1/dashboards/${id}`);
    await call("PUT", d, admin("nope"), `/api/v1/dashboards/${id}`);
    await call("PUT", d, admin(body), "/api/v1/dashboards/missing");
    await call("PUT", d, admin(body), "/api/v1/dashboards/openasy");
    await call("PUT", d, { method: "PUT" }, `/api/v1/dashboards/${id}`);
    await call("DELETE", d, admin(), "/api/v1/dashboards/openasy");
    await call("DELETE", d, admin(), `/api/v1/dashboards/${id}`);
    await call("DELETE", d, admin(), "/api/v1/dashboards/missing");
    await call("DELETE", d, { method: "DELETE" }, `/api/v1/dashboards/${id}`);
  });

  it("the metric list and the Prometheus API", async () => {
    await call("GET", "/api/v1/metric-names", admin());
    await call("GET", "/api/v1/metric-names", {});
    const form = (body: string) => auth(ADMIN_TOKEN, body, "application/x-www-form-urlencoded");
    for (const p of ["query", "query_range", "series", "labels", "metadata", "status/buildinfo"]) {
      const path = `/prometheus/api/v1/${p}`;
      const q = p === "series" ? "match[]=up" : p.startsWith("query") ? "query=up&start=-5m&step=30s" : "";
      await call("GET", path, admin(), `${path}?${q}`);
      await call("POST", path, form(q));
      await call("GET", path, {}, path);
      await call("POST", path, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: q });
    }
    await call("GET", "/prometheus/api/v1/query", admin(), "/prometheus/api/v1/query?query=sum(");
    await call("POST", "/prometheus/api/v1/query", form("query=sum("));
    await call("POST", "/prometheus/api/v1/query", form(`query=${"x".repeat(1024 * 1024)}`));
    await call("GET", "/prometheus/api/v1/query_range", admin(), "/prometheus/api/v1/query_range?query=up&start=x");
    const v = "/prometheus/api/v1/label/{name}/values";
    await call("GET", v, admin(), "/prometheus/api/v1/label/job/values");
    await call("POST", v, form(""), "/prometheus/api/v1/label/__name__/values");
    await call("GET", v, admin(), "/prometheus/api/v1/label/.../values");
    await call("GET", v, {}, "/prometheus/api/v1/label/job/values");
    await call("POST", v, { headers: { "content-type": "application/x-www-form-urlencoded" } }, "/prometheus/api/v1/label/job/values");
  });

  it("pushed samples, and every refusal", async () => {
    const proto = (token: string, body = "") => auth(token, body, "application/x-protobuf");
    await call("POST", "/opentelemetry/v1/metrics", proto(INGEST_TOKEN));
    await call("POST", "/opentelemetry/v1/metrics", proto(INGEST_TOKEN, "not protobuf at all"));
    await call("POST", "/opentelemetry/v1/metrics", proto("wrong"));
    await call("POST", "/opentelemetry/v1/metrics", { method: "POST" });
    await call("POST", "/prometheus/api/v1/write", proto(INGEST_TOKEN));
    await call("POST", "/prometheus/api/v1/write", proto(INGEST_TOKEN, "not snappy"));
    await call("POST", "/prometheus/api/v1/write", proto("wrong"));
    await call("POST", "/prometheus/api/v1/write", { method: "POST" });
    await call("POST", "/prometheus/api/v1/write", { ...proto(INGEST_TOKEN), body: Buffer.alloc(33 * 1024 * 1024) });
    await call("POST", "/opentelemetry/v1/metrics", { ...proto(INGEST_TOKEN), body: Buffer.alloc(33 * 1024 * 1024) });
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
