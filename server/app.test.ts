import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, EXPORTER_TOKEN, fakeExporter, INGEST_TOKEN, startApp, until } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let exporter: Awaited<ReturnType<typeof fakeExporter>>;

beforeAll(async () => {
  exporter = await fakeExporter();
  app = await startApp({ version: "0.1.0" });
});
afterAll(async () => {
  await app.close();
  await exporter.close();
});

const query = async (expr: string) => {
  const r = (await app.get(`/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`)) as {
    status: string;
    data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
  };
  return r.data.result;
};

// The smallest OTLP request that carries one gauge, as an OpenTelemetry collector sends it over HTTP: protobuf, by hand.
function otlpGauge(name: string, value: number, service: string): Buffer {
  const varint = (n: number) => {
    const out: number[] = [];
    while (n > 127) (out.push((n & 127) | 128), (n = Math.floor(n / 128)));
    return [...out, n];
  };
  const bytes = (field: number, b: Buffer) => Buffer.concat([Buffer.from([...varint((field << 3) | 2), ...varint(b.length)]), b]);
  const str = (field: number, s: string) => bytes(field, Buffer.from(s, "utf8"));
  const fixed = (field: number, write: (b: Buffer) => void) => {
    const b = Buffer.alloc(8);
    write(b);
    return Buffer.concat([Buffer.from(varint((field << 3) | 1)), b]);
  };
  const point = Buffer.concat([fixed(3, (b) => b.writeBigUInt64LE(BigInt(Date.now()) * 1_000_000n)), fixed(4, (b) => b.writeDoubleLE(value))]);
  const metric = Buffer.concat([str(1, name), bytes(5, bytes(1, point))]);
  const resource = bytes(1, Buffer.concat([str(1, "service.name"), bytes(2, str(1, service))]));
  return bytes(1, Buffer.concat([bytes(1, resource), bytes(2, bytes(2, metric))]));
}

describe("scraping", () => {
  it("reads a job's exporter with its bearer token, and answers PromQL over what it read", async () => {
    const res = await app.send("POST", "/api/v1/jobs", {
      name: "demo",
      urls: [`${exporter.base}/metrics`],
      intervalSeconds: 5,
      auth: "bearer",
      secret: EXPORTER_TOKEN,
      labels: { team: "payments" },
    });
    expect(res.status).toBe(201);
    const job = (await res.json()) as { id: string; hasSecret: boolean };
    expect(job.hasSecret).toBe(true);
    const [sample] = await until(async () => {
      const r = await query('demo_requests_total{job="demo"}');
      return r.length ? r : undefined;
    });
    expect(sample!.metric).toMatchObject({ code: "200", team: "payments", job: "demo" });
    expect(Number(sample!.value[1])).toBeGreaterThan(100);
    expect(exporter.hits()).toBeGreaterThan(0);
  }, 30_000);

  it("shows each target with its health, and why one is down", async () => {
    await app.send("POST", "/api/v1/jobs", { name: "gone", urls: ["http://127.0.0.1:9/metrics"], intervalSeconds: 5 });
    const targets = await until(async () => {
      const { targets } = (await app.get("/api/v1/targets")) as { targets: Array<Record<string, any>> };
      const gone = targets.find((t) => t.job === "gone");
      return gone?.health === "down" && gone.error && targets.find((t) => t.job === "demo")?.health === "up" ? targets : undefined;
    });
    const gone = targets.find((t) => t.job === "gone")!;
    expect(gone).toMatchObject({ url: "http://127.0.0.1:9/metrics", health: "down", jobId: expect.any(String) });
    expect(gone.error).toMatch(/refused/);
    // Metrics reads its own /metrics too, as the product metrics.
    expect(targets.find((t) => t.job === "openasy")).toMatchObject({ product: "metrics", jobId: null });
    const summary = await app.get("/api/v1/summary");
    expect(summary).toMatchObject({ storage: { running: true, retentionDays: 30 }, jobs: 2, products: 0 });
    expect(summary.targets.down).toBeGreaterThanOrEqual(1);
    expect(summary.down.map((t: { job: string }) => t.job)).toContain("gone");
  }, 30_000);

  it("stops scraping a job once it is deleted", async () => {
    const { jobs } = (await app.get("/api/v1/jobs")) as { jobs: Array<{ id: string; name: string }> };
    const gone = jobs.find((j) => j.name === "gone")!;
    expect((await app.send("DELETE", `/api/v1/jobs/${gone.id}`)).status).toBe(204);
    // VictoriaMetrics applies a reloaded config within a second or two.
    const jobsLeft = await until(async () => {
      const { targets } = (await app.get("/api/v1/targets")) as { targets: Array<{ job: string }> };
      const names = targets.map((t) => t.job);
      return names.includes("gone") ? undefined : names;
    });
    expect(jobsLeft).toContain("demo");
  }, 30_000);

  it("lists every metric name with its type and help", async () => {
    const { metrics } = (await app.get("/api/v1/metric-names")) as { metrics: Array<Record<string, unknown>> };
    expect(metrics.find((m) => m.name === "demo_requests_total")).toMatchObject({ type: "counter", help: "Requests the demo served.", series: 1 });
    expect(metrics.map((m) => m.name)).toContain("up");
  });
});

describe("pushed samples", () => {
  it("take OpenTelemetry metrics over HTTP with the ingest token", async () => {
    const push = (token: string) =>
      fetch(`${app.base}/opentelemetry/v1/metrics`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" },
        body: otlpGauge("queue_depth", 42, "billing-worker"),
      });
    expect((await push("wrong")).status).toBe(401);
    expect((await push(INGEST_TOKEN)).status).toBe(200);
    const [s] = await until(async () => {
      const r = await query("queue_depth");
      return r.length ? r : undefined;
    });
    expect(s!.metric).toMatchObject({ __name__: "queue_depth", service_name: "billing-worker" });
    expect(s!.value[1]).toBe("42");
  }, 30_000);
});

describe("the Prometheus API", () => {
  it("answers as Prometheus does, for Grafana: errors too, over GET and POST", async () => {
    const form = (path: string, body: string) => app.admin(path, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
    const bad = await form("/prometheus/api/v1/query", "query=sum(rate(x[5m]");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ status: "error", errorType: expect.any(String) });
    expect(await (await form("/prometheus/api/v1/query_range", "query=up&start=-60s&step=15s")).json()).toMatchObject({
      status: "success",
      data: { resultType: "matrix" },
    });
    expect(await app.get("/prometheus/api/v1/label/job/values")).toMatchObject({ status: "success", data: expect.arrayContaining(["demo", "openasy"]) });
    expect(await app.get("/prometheus/api/v1/status/buildinfo")).toMatchObject({ status: "success" });
  });

  it("needs a viewer, and reaches nothing of VictoriaMetrics but the read API", async () => {
    expect((await fetch(`${app.base}/prometheus/api/v1/query?query=up`)).status).toBe(401);
    expect((await app.admin("/prometheus/api/v1/admin/tsdb/delete_series?match[]=up", { method: "POST" })).status).toBe(404);
    expect((await app.admin("/prometheus/api/v1/export?match[]=up")).status).toBe(404);
    // fetch would resolve the dots itself; a raw request sends them as they are.
    const raw = await new Promise<number>((resolve, reject) =>
      request(`${app.base}/prometheus/api/v1/label/%2E%2E/values`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on("error", reject)
        .end(),
    );
    expect(raw).toBe(404);
  });
});

describe("the product", () => {
  it("names itself, and has metrics for Prometheus", async () => {
    expect(await (await fetch(`${app.base}/api/v1/version`)).json()).toEqual({ product: "metrics", version: "0.1.0" });
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="metrics",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_metrics_storage_up 1");
    expect(metrics).toMatch(/openasy_metrics_targets\{health="up"\} [1-9]/);
    expect(metrics).toContain("openasy_metrics_jobs 1");
  });

  it("is ready while VictoriaMetrics answers", async () => {
    expect(await (await fetch(`${app.base}/readyz`)).json()).toEqual({ status: "ready" });
  });
});
