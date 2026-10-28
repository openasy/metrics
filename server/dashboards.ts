// Dashboards: panels of PromQL, drawn over a time range. The ones Metrics comes with read what every OpenAsy product
// serves at /metrics (ADR 0026) and what every scrape records; they cannot be changed, only copied.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bad, conflict, isObject, notFound } from "./problem.ts";

export const UNITS = ["none", "percent", "ratio", "bytes", "bytesPerSecond", "seconds", "perSecond"] as const;
export type Unit = (typeof UNITS)[number];

export interface Panel {
  title: string;
  /** PromQL; each series it returns is one line. */
  expr: string;
  unit: Unit;
  /** How a line is named, such as {{instance}}; empty names it by its labels. */
  legend: string;
  stacked: boolean;
}

export interface Dashboard {
  id: string;
  name: string;
  folder: string;
  description: string;
  tags: string[];
  panels: Panel[];
  /** Comes with Metrics: read-only. */
  builtIn: boolean;
  createdBy: string;
  updatedAt: string;
}

const panel = (title: string, expr: string, unit: Unit, legend = "", stacked = false): Panel => ({ title, expr, unit, legend, stacked });

/** The dashboards every install has. */
export const BUILT_IN: Dashboard[] = [
  {
    id: "openasy",
    name: "OpenAsy products",
    folder: "OpenAsy",
    description: "Every OpenAsy product of this install, from what each serves at /metrics.",
    tags: ["openasy"],
    builtIn: true,
    createdBy: "Metrics",
    updatedAt: "2026-10-28T00:00:00.000Z",
    panels: [
      panel("Answering", 'up{job="openasy"}', "none", "{{product}}"),
      panel("Requests / s", 'sum by (product) (rate(openasy_http_requests_total{job="openasy"}[5m]))', "perSecond", "{{product}}", true),
      panel("Server errors / s", 'sum by (product) (rate(openasy_http_requests_total{job="openasy",status=~"5.."}[5m]))', "perSecond", "{{product}}"),
      panel("Uptime", 'process_uptime_seconds{job="openasy"}', "seconds", "{{product}}"),
    ],
  },
  {
    id: "scrapes",
    name: "Scrapes",
    folder: "OpenAsy",
    description: "Whether each target answers, how long a scrape takes and how many samples it brings.",
    tags: ["targets"],
    builtIn: true,
    createdBy: "Metrics",
    updatedAt: "2026-10-28T00:00:00.000Z",
    panels: [
      panel("Targets up, by job", "sum by (job) (up)", "none", "{{job}}", true),
      panel("Targets down, by job", "count by (job) (up == 0)", "none", "{{job}}"),
      panel("Scrape duration", "scrape_duration_seconds", "seconds", "{{job}} {{instance}}"),
      panel("Samples per scrape", "scrape_samples_scraped", "none", "{{job}} {{instance}}"),
    ],
  },
  {
    id: "storage",
    name: "Metrics storage",
    folder: "OpenAsy",
    description: "The series Metrics keeps and the disk they take.",
    tags: ["openasy", "storage"],
    builtIn: true,
    createdBy: "Metrics",
    updatedAt: "2026-10-28T00:00:00.000Z",
    panels: [
      panel("Active series", 'openasy_metrics_active_series{product="metrics"}', "none", "active"),
      panel("Samples stored / s", 'rate(openasy_metrics_samples_total{product="metrics"}[5m])', "perSecond", "samples"),
      panel("Disk used", 'openasy_metrics_storage_bytes{product="metrics"}', "bytes", "used"),
      panel("Disk free", 'openasy_metrics_storage_free_bytes{product="metrics"}', "bytes", "free"),
    ],
  },
];

const MAX_PANELS = 40;

function text(v: unknown, field: string, max: number, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw bad(`${field} is required.`);
    return "";
  }
  if (typeof v !== "string") throw bad(`${field} must be text.`);
  const t = v.trim();
  if (required && !t) throw bad(`${field} is required.`);
  if (t.length > max) throw bad(`${field} must be at most ${max} characters.`);
  return t;
}

function parsePanels(v: unknown): Panel[] {
  if (!Array.isArray(v) || v.length > MAX_PANELS) throw bad(`panels must be a list of at most ${MAX_PANELS} panels.`);
  return v.map((p, i) => {
    if (!isObject(p)) throw bad(`Panel ${i + 1} must be an object.`);
    const unit = (p.unit ?? "none") as Unit;
    if (!UNITS.includes(unit)) throw bad(`Panel ${i + 1}: unit must be one of ${UNITS.join(", ")}.`);
    if (p.stacked !== undefined && typeof p.stacked !== "boolean") throw bad(`Panel ${i + 1}: stacked must be true or false.`);
    return {
      title: text(p.title, `Panel ${i + 1}: title`, 120, true),
      expr: text(p.expr, `Panel ${i + 1}: expr`, 4000, true),
      unit,
      legend: text(p.legend, `Panel ${i + 1}: legend`, 200),
      stacked: p.stacked === true,
    };
  });
}

function parseTags(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10 || v.some((t) => typeof t !== "string" || !t.trim() || t.trim().length > 30))
    throw bad("tags must be a list of at most 10 words, each at most 30 characters.");
  return [...new Set(v.map((t) => (t as string).trim().toLowerCase()))];
}

type Row = { id: string; name: string; folder: string; description: string; tags: string; panels: string; created_by: string; updated_at: string };

const toDashboard = (r: Row): Dashboard => ({
  id: r.id,
  name: r.name,
  folder: r.folder,
  description: r.description,
  tags: JSON.parse(r.tags) as string[],
  panels: JSON.parse(r.panels) as Panel[],
  builtIn: false,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
});

export function createDashboards(db: DatabaseSync, { clock = Date.now }: { clock?: () => number } = {}) {
  const builtIn = (id: string) => BUILT_IN.find((d) => d.id === id);

  function parse(body: Record<string, unknown>) {
    return {
      name: text(body.name, "name", 120, true),
      folder: text(body.folder, "folder", 60),
      description: text(body.description, "description", 500),
      tags: parseTags(body.tags),
      panels: parsePanels(body.panels ?? []),
    };
  }

  const taken = (folder: string, name: string, id: string | null) => {
    const other = db.prepare("SELECT id FROM dashboards WHERE folder = ? AND name = ?").get(folder, name) as { id: string } | undefined;
    if (other && other.id !== id) throw conflict(`A dashboard named ${name} is already in ${folder || "no folder"}.`);
  };

  return {
    list(): Dashboard[] {
      const own = (db.prepare("SELECT * FROM dashboards ORDER BY folder, name").all() as Row[]).map(toDashboard);
      return [...own, ...BUILT_IN];
    },

    count(): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM dashboards").get() as { n: number }).n + BUILT_IN.length;
    },

    get(id: string): Dashboard {
      const b = builtIn(id);
      if (b) return b;
      const r = db.prepare("SELECT * FROM dashboards WHERE id = ?").get(id) as Row | undefined;
      if (!r) throw notFound("The dashboard");
      return toDashboard(r);
    },

    create(body: Record<string, unknown>, actor: string): Dashboard {
      const d = parse(body);
      taken(d.folder, d.name, null);
      const id = randomUUID();
      const now = new Date(clock()).toISOString();
      db.prepare(
        "INSERT INTO dashboards (id, name, folder, description, tags, panels, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, d.name, d.folder, d.description, JSON.stringify(d.tags), JSON.stringify(d.panels), actor, now, now);
      return this.get(id);
    },

    update(id: string, body: Record<string, unknown>): Dashboard {
      if (builtIn(id)) throw conflict("A dashboard that comes with Metrics cannot be changed; save a copy and change that.");
      this.get(id);
      const d = parse(body);
      taken(d.folder, d.name, id);
      db.prepare("UPDATE dashboards SET name = ?, folder = ?, description = ?, tags = ?, panels = ?, updated_at = ? WHERE id = ?").run(
        d.name,
        d.folder,
        d.description,
        JSON.stringify(d.tags),
        JSON.stringify(d.panels),
        new Date(clock()).toISOString(),
        id,
      );
      return this.get(id);
    },

    remove(id: string): void {
      if (builtIn(id)) throw conflict("A dashboard that comes with Metrics cannot be deleted.");
      if (!db.prepare("DELETE FROM dashboards WHERE id = ?").run(id).changes) throw notFound("The dashboard");
    },
  };
}

export type Dashboards = ReturnType<typeof createDashboards>;
