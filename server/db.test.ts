import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "metrics-")), "nested", "metrics.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("keeps a job from scraping more often than every 5 seconds, or signing in some unknown way", () => {
    const db = openDb(":memory:");
    const insert = (interval: number, auth: string) =>
      db
        .prepare("INSERT INTO jobs (id, name, urls, interval_seconds, auth, created_by, created_at, updated_at) VALUES (?, ?, '[]', ?, ?, 'x', 'now', 'now')")
        .run(`${interval}${auth}`, `${interval}${auth}`, interval, auth);
    expect(() => insert(1, "none")).toThrow(/CHECK/);
    expect(() => insert(30, "digest")).toThrow(/CHECK/);
    expect(() => insert(30, "basic")).not.toThrow();
  });
});
