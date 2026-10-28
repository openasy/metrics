import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScrapeJob } from "./jobs.ts";
import { renderScrapeConfig, staticConfig, writeScrapeConfig } from "./scrape.ts";

const job = (over: Partial<ScrapeJob>): ScrapeJob => ({
  id: "j1",
  name: "node",
  urls: ["http://10.0.0.5:9100/metrics"],
  intervalSeconds: 15,
  labels: {},
  auth: "none",
  username: null,
  hasSecret: false,
  secret: null,
  createdBy: "x",
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("scrape config", () => {
  it("puts scheme, path and query of each address in the labels Prometheus reads them from", () => {
    expect(staticConfig("https://example.com/infra/metrics?x=1", { product: "infrastructure" })).toEqual({
      targets: ["example.com"],
      labels: { product: "infrastructure", __scheme__: "https", __metrics_path__: "/infra/metrics", __param_x: "1" },
    });
  });

  it("scrapes Metrics itself and every product as the job openasy, then each job with its sign-in", () => {
    const config = renderScrapeConfig({
      jobs: [
        job({}),
        job({ id: "j2", name: "api", intervalSeconds: 5, auth: "bearer", secret: "t" }),
        job({ id: "j3", name: "pg", auth: "basic", username: "prom", secret: "p" }),
      ],
      sources: [{ product: "vpn", url: "https://vpn.example.com/metrics" }],
      self: "http://127.0.0.1:8080/metrics",
      intervalSeconds: 30,
      secretPath: (id) => `/run/${id}`,
    });
    expect(config.global).toEqual({ scrape_interval: "30s", scrape_timeout: "10s" });
    const [openasy, node, api, pg] = config.scrape_configs as Array<Record<string, any>>;
    expect(openasy).toMatchObject({ job_name: "openasy", honor_labels: true });
    expect(node).not.toHaveProperty("honor_labels");
    expect(openasy!.static_configs.map((s: { labels: { product: string } }) => s.labels.product)).toEqual(["metrics", "vpn"]);
    expect(node).toMatchObject({ job_name: "node", scrape_interval: "15s", scrape_timeout: "10s" });
    expect(node).not.toHaveProperty("authorization");
    // A timeout longer than the interval is refused by Prometheus' rules.
    expect(api).toMatchObject({ scrape_timeout: "5s", authorization: { type: "Bearer", credentials_file: "/run/j2" } });
    expect(pg).toMatchObject({ basic_auth: { username: "prom", password_file: "/run/j3" } });
    expect(JSON.stringify(config)).not.toMatch(/"t"|"p"/);
  });

  it("writes secrets to files only this process reads, and removes those of jobs that are gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-scrape-"));
    const input = { sources: [], self: "http://127.0.0.1:8080/metrics", intervalSeconds: 30 };
    writeScrapeConfig(dir, { ...input, jobs: [job({ id: "a", auth: "bearer", secret: "token-a" })] });
    writeFileSync(join(dir, "secrets", "stale"), "old");
    expect(readFileSync(join(dir, "secrets", "a"), "utf8")).toBe("token-a");
    expect(statSync(join(dir, "secrets", "a")).mode & 0o077).toBe(0);
    const path = writeScrapeConfig(dir, { ...input, jobs: [] });
    expect(readdirSync(join(dir, "secrets"))).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).scrape_configs).toHaveLength(1);
  });
});
