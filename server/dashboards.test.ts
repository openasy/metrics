import { describe, expect, it } from "vitest";
import { BUILT_IN, createDashboards } from "./dashboards.ts";
import { openDb } from "./db.ts";

describe("dashboards", () => {
  it("lists people's dashboards before the ones that come with Metrics", () => {
    const d = createDashboards(openDb(":memory:"));
    const own = d.create(
      {
        name: "orders-api",
        folder: "Payments",
        tags: ["RED", "slo", "red"],
        panels: [{ title: "Requests / s", expr: "sum(rate(http_requests_total[5m]))", unit: "perSecond" }],
      },
      "Ayşe",
    );
    expect(own).toMatchObject({ tags: ["red", "slo"], builtIn: false, createdBy: "Ayşe", panels: [{ legend: "", stacked: false }] });
    expect(d.list().map((x) => x.id)).toEqual([own.id, ...BUILT_IN.map((b) => b.id)]);
    expect(d.count()).toBe(1 + BUILT_IN.length);
  });

  it("keeps the built-in ones as they are", () => {
    const d = createDashboards(openDb(":memory:"));
    expect(d.get("openasy").builtIn).toBe(true);
    expect(() => d.update("openasy", { name: "x" })).toThrow(/copy/);
    expect(() => d.remove("openasy")).toThrow(/cannot be deleted/);
  });

  it("refuses panels it could not draw, and a second dashboard of the same name in a folder", () => {
    const d = createDashboards(openDb(":memory:"));
    expect(() => d.create({ name: "x", panels: [{ title: "t" }] }, "a")).toThrow(/expr is required/);
    expect(() => d.create({ name: "x", panels: [{ title: "t", expr: "up", unit: "furlongs" }] }, "a")).toThrow(/unit/);
    expect(() => d.create({ name: "" }, "a")).toThrow(/name/);
    d.create({ name: "x", folder: "A" }, "a");
    d.create({ name: "x", folder: "B" }, "a");
    expect(() => d.create({ name: "x", folder: "A" }, "a")).toThrow(/already in A/);
  });

  it("uses PromQL on what every product and every scrape records", () => {
    const exprs = BUILT_IN.flatMap((b) => b.panels.map((p) => p.expr)).join("\n");
    expect(exprs).toContain("openasy_http_requests_total");
    expect(exprs).toContain("scrape_duration_seconds");
    expect(exprs).toContain("openasy_metrics_active_series");
  });
});
