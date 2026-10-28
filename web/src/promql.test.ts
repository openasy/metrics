import { describe, expect, it } from "vitest";
import { formatter, MAX_LINES, rangeQuery, seriesName, toChart } from "./promql.ts";

const NOW = Date.parse("2026-10-28T12:00:07Z");

describe("range queries", () => {
  it("ask for about 120 points, on whole steps", () => {
    expect(rangeQuery("1h", NOW)).toEqual({ start: 1793188800 - 3600, end: 1793188800, step: 30 });
    expect(rangeQuery("15m", NOW).step).toBe(15);
    expect(rangeQuery("30d", NOW).step).toBe(21_600);
    expect(rangeQuery("nonsense", NOW).step).toBe(30);
  });
});

describe("series names", () => {
  it("fill a legend with labels, or list the labels", () => {
    expect(seriesName({ __name__: "up", job: "node", instance: "a:9100" }, "{{job}} on {{ instance }}")).toBe("node on a:9100");
    expect(seriesName({ __name__: "up", job: "node" })).toBe('job="node"');
    expect(seriesName({ __name__: "up" })).toBe("up");
    expect(seriesName({})).toBe("{}");
  });
});

describe("charts", () => {
  it("put every series on one axis, and keep a line from falling to zero where a sample is missing", () => {
    const { start, step } = rangeQuery("15m", NOW);
    const chart = toChart(
      {
        resultType: "matrix",
        result: [
          {
            metric: { instance: "a" },
            values: [
              [start + step, "5"],
              [start + 3 * step, "7"],
            ],
          },
        ],
      },
      "15m",
      "{{instance}}",
      NOW,
    );
    expect(chart.labels).toHaveLength(61);
    expect(chart.series[0]!.name).toBe("a");
    expect(chart.series[0]!.data.slice(0, 5)).toEqual([5, 5, 5, 7, 7]);
  });

  it("draws at most 30 lines and counts the rest", () => {
    const result = Array.from({ length: 40 }, (_, i) => ({ metric: { i: String(i) }, values: [] as Array<[number, string]> }));
    const chart = toChart({ resultType: "matrix", result }, "1h", "", NOW);
    expect(chart.series).toHaveLength(MAX_LINES);
    expect(chart.hidden).toBe(10);
  });
});

describe("units", () => {
  it("write values as people read them", () => {
    expect(formatter("ratio")(0.4567)).toBe("45.7%");
    expect(formatter("seconds")(0.0421)).toBe("42.1 ms");
    expect(formatter("perSecond")(1240.4)).toBe(`${(1240).toLocaleString()}/s`);
    expect(formatter("none")(0.123456)).toBe((0.123).toLocaleString());
  });
});
