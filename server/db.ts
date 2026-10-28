import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones. The time series themselves
// are in VictoriaMetrics; this file keeps what people set up (ADR 0011, 0063).
const MIGRATIONS = [
  `-- A scrape job: the addresses VictoriaMetrics reads, how often, the labels added to what it reads and how it signs
   -- in. The password or bearer token is sealed with the install's key (ADR 0021) and only ever written to a file in
   -- /tmp for VictoriaMetrics to read.
   CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     urls TEXT NOT NULL,
     interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 5 AND 3600),
     labels TEXT NOT NULL DEFAULT '{}',
     auth TEXT NOT NULL CHECK (auth IN ('none', 'bearer', 'basic')),
     username TEXT,
     secret TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   -- A dashboard and its panels, each a PromQL query. The ones that come with the product are in dashboards.ts.
   CREATE TABLE dashboards (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     folder TEXT NOT NULL DEFAULT '',
     description TEXT NOT NULL DEFAULT '',
     tags TEXT NOT NULL DEFAULT '[]',
     panels TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (folder, name)
   )`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
