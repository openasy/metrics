import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { checkUrl, createJobs } from "./jobs.ts";
import { sealer } from "./seal.ts";

const setup = () => {
  const db = openDb(":memory:");
  return { db, jobs: createJobs(db, { sealer: sealer(Buffer.alloc(32, 3)), clock: () => Date.parse("2026-10-28T12:00:00Z") }) };
};

describe("addresses", () => {
  it("are http or https, read /metrics without a path, and keep their query", () => {
    expect(checkUrl(" http://10.0.0.5:9100 ")).toBe("http://10.0.0.5:9100/metrics");
    expect(checkUrl("https://db.example.com/probe?module=pg")).toBe("https://db.example.com/probe?module=pg");
    expect(() => checkUrl("ftp://x")).toThrow(/http/);
    expect(() => checkUrl("10.0.0.5:9100")).toThrow(/http/);
  });

  it("never hold a password, which every viewer would see", () => {
    expect(() => checkUrl("http://admin:hunter2@10.0.0.5:9100/metrics")).toThrow(/sign-in/);
  });
});

describe("jobs", () => {
  it("seal the secret, never return it, and open it only for the scrape config", () => {
    const { db, jobs } = setup();
    const j = jobs.create({ name: "pg", urls: ["http://10.0.0.7:9187"], auth: "basic", username: "prom", secret: "hunter2", labels: { team: "db" } }, "Ayşe");
    expect(j).toMatchObject({
      name: "pg",
      urls: ["http://10.0.0.7:9187/metrics"],
      intervalSeconds: 30,
      auth: "basic",
      username: "prom",
      hasSecret: true,
      createdBy: "Ayşe",
    });
    expect(JSON.stringify(j)).not.toContain("hunter2");
    expect(JSON.stringify(db.prepare("SELECT * FROM jobs").all())).not.toContain("hunter2");
    expect(jobs.forScrape()[0]!.secret).toBe("hunter2");
  });

  it("keep the secret when edited without it, and drop it when signing in another way", () => {
    const { jobs } = setup();
    const j = jobs.create({ name: "api", urls: ["https://api.example.com/metrics"], auth: "bearer", secret: "tok" }, "x");
    jobs.update(j.id, { name: "api", urls: ["https://api.example.com/metrics", "https://api2.example.com/metrics"], auth: "bearer" });
    expect(jobs.forScrape()[0]).toMatchObject({ secret: "tok", urls: ["https://api.example.com/metrics", "https://api2.example.com/metrics"] });
    expect(() => jobs.update(j.id, { name: "api", urls: ["https://api.example.com/metrics"], auth: "basic", username: "u" })).toThrow(/password/);
    expect(jobs.update(j.id, { name: "api", urls: ["https://api.example.com/metrics"], auth: "none" }).hasSecret).toBe(false);
  });

  it("refuse what VictoriaMetrics could not use", () => {
    const { jobs } = setup();
    const job = (b: Record<string, unknown>) => jobs.create({ name: "n", urls: ["http://h:1"], ...b }, "x");
    expect(() => job({ name: "openasy" })).toThrow(/OpenAsy products/);
    expect(() => job({ name: "has space" })).toThrow(/name/);
    expect(() => job({ urls: [] })).toThrow(/urls/);
    expect(() => job({ intervalSeconds: 1 })).toThrow(/intervalSeconds/);
    expect(() => job({ labels: { __address__: "x" } })).toThrow(/label name/);
    expect(() => job({ labels: { job: "x" } })).toThrow(/job label/);
    expect(() => job({ auth: "bearer" })).toThrow(/token/);
    expect(() => job({ auth: "bearer", secret: "a\nb" })).toThrow(/one line/);
    job({});
    expect(() => job({})).toThrow(/already exists/);
  });
});
