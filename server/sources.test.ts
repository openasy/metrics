import { describe, expect, it } from "vitest";
import { parseSources } from "./sources.ts";

describe("METRICS_SOURCES", () => {
  const products = [
    { id: "vpn", url: "https://vpn.example.com" },
    { id: "metrics", url: "https://metrics.example.com" },
    { id: "infrastructure", url: "https://example.com/infra" },
  ];

  it("reads each product of OPENASY_PRODUCTS at /metrics, without Metrics itself", () => {
    expect(parseSources(products, undefined)).toEqual({
      sources: [
        { product: "infrastructure", url: "https://example.com/infra/metrics" },
        { product: "vpn", url: "https://vpn.example.com/metrics" },
      ],
      invalid: [],
    });
  });

  it("takes another address for a product that serves /metrics on its own port", () => {
    const { sources, invalid } = parseSources(
      products,
      "vpn=http://vpn:9090/metrics, logs=http://logs:9091/metrics, metrics=http://x/metrics, vpn, Bad=http://x, a=http://u:p@x/metrics",
    );
    expect(sources).toEqual([
      { product: "infrastructure", url: "https://example.com/infra/metrics" },
      { product: "logs", url: "http://logs:9091/metrics" },
      { product: "vpn", url: "http://vpn:9090/metrics" },
    ]);
    expect(invalid).toEqual(["metrics=http://x/metrics", "vpn", "Bad=http://x", "a=http://u:p@x/metrics"]);
  });
});
