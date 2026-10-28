// Scrape jobs people add: node_exporter on hosts, a database's exporter, a service's own /metrics. The OpenAsy
// products of the install are scraped without one (scrape.ts).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bad, conflict, isObject, notFound } from "./problem.ts";
import type { Sealer } from "./seal.ts";

export type JobAuth = "none" | "bearer" | "basic";

export interface Job {
  id: string;
  name: string;
  /** Full addresses such as http://10.0.0.5:9100/metrics; one without a path reads /metrics. */
  urls: string[];
  intervalSeconds: number;
  /** Added to every series the job reads. */
  labels: Record<string, string>;
  auth: JobAuth;
  username: string | null;
  /** Whether a password or bearer token is kept. It is never returned (ADR 0021). */
  hasSecret: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A job with its secret opened, for the scrape config only. */
export type ScrapeJob = Job & { secret: string | null };

/** The job names Metrics gives the targets it adds itself. */
export const RESERVED_JOBS = ["openasy"];
const JOB_NAME = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,62}$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const MAX_URLS = 500;

/** Checks an address a job reads and returns it as it will be kept. */
export function checkUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw bad("Each address must be a URL such as http://10.0.0.5:9100/metrics.");
  const url = URL.parse(raw.trim());
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) throw bad(`${raw.trim()} is not an http:// or https:// address.`);
  // A password in the address would be shown to every viewer on the Targets screen; it belongs in the job's sign-in.
  if (url.username || url.password) throw bad(`${url.host}: put the user and password in the job's sign-in, not in the address.`);
  if (url.hash) throw bad(`${raw.trim()}: an address to scrape has no #fragment.`);
  if (url.pathname === "/") url.pathname = "/metrics";
  return url.href;
}

type Row = {
  id: string;
  name: string;
  urls: string;
  interval_seconds: number;
  labels: string;
  auth: JobAuth;
  username: string | null;
  secret: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const toJob = (r: Row): Job => ({
  id: r.id,
  name: r.name,
  urls: JSON.parse(r.urls) as string[],
  intervalSeconds: r.interval_seconds,
  labels: JSON.parse(r.labels) as Record<string, string>,
  auth: r.auth,
  username: r.username,
  hasSecret: r.secret !== null,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createJobs(
  db: DatabaseSync,
  { sealer, clock = Date.now, defaultIntervalSeconds = 30 }: { sealer: Sealer; clock?: () => number; defaultIntervalSeconds?: number },
) {
  const row = (id: string) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;

  function parse(body: Record<string, unknown>, existing: Row | undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!JOB_NAME.test(name)) throw bad("name must be 1 to 63 letters, digits, _ . or -, starting with a letter or _.");
    if (RESERVED_JOBS.includes(name)) throw bad(`${name} is the job of the OpenAsy products Metrics scrapes itself; choose another name.`);
    if (!Array.isArray(body.urls) || !body.urls.length || body.urls.length > MAX_URLS) throw bad(`urls must list 1 to ${MAX_URLS} addresses.`);
    const urls = [...new Set(body.urls.map(checkUrl))];

    const interval = body.intervalSeconds ?? defaultIntervalSeconds;
    if (!Number.isInteger(interval) || (interval as number) < 5 || (interval as number) > 3600)
      throw bad("intervalSeconds must be a whole number of seconds, 5 to 3600.");

    const labels: Record<string, string> = {};
    if (body.labels !== undefined) {
      if (!isObject(body.labels)) throw bad("labels must be an object of names and values.");
      const entries = Object.entries(body.labels);
      if (entries.length > 20) throw bad("A job adds at most 20 labels.");
      for (const [k, v] of entries) {
        if (!LABEL_NAME.test(k) || k.startsWith("__")) throw bad(`${k} is not a label name: letters, digits and _, not starting with __.`);
        if (k === "job") throw bad("The job label is the job's name.");
        if (typeof v !== "string" || !v || v.length > 200) throw bad(`The value of ${k} must be text, 1 to 200 characters.`);
        labels[k] = v;
      }
    }

    const auth = (body.auth ?? "none") as JobAuth;
    if (!["none", "bearer", "basic"].includes(auth)) throw bad("auth must be none, bearer or basic.");
    const username = auth === "basic" ? (typeof body.username === "string" ? body.username.trim() : "") : null;
    if (auth === "basic" && (!username || username.length > 200)) throw bad("A job that signs in with basic auth needs a username.");

    // Empty or absent keeps the secret already kept for the same way of signing in, so editing a job does not need it
    // typed again; a bearer token never becomes a password.
    let secret: string | null = null;
    if (typeof body.secret === "string" && body.secret !== "") {
      if (body.secret.length > 4096 || /[\r\n]/.test(body.secret)) throw bad("secret must be one line, at most 4096 characters.");
      secret = sealer.seal(body.secret);
    } else if (body.secret !== undefined && body.secret !== "" && body.secret !== null) {
      throw bad("secret must be text.");
    } else if (existing && existing.auth === auth) {
      secret = existing.secret;
    }
    if (auth === "none") secret = null;
    else if (secret === null)
      throw bad(
        auth === "bearer"
          ? "A job that signs in with a bearer token needs the token, in secret."
          : "A job that signs in with basic auth needs the password, in secret.",
      );

    return { name, urls, interval: interval as number, labels, auth, username, secret };
  }

  const taken = (name: string, id: string | null) => {
    const other = db.prepare("SELECT id FROM jobs WHERE name = ?").get(name) as { id: string } | undefined;
    if (other && other.id !== id) throw conflict(`A job named ${name} already exists.`);
  };

  return {
    list(): Job[] {
      return (db.prepare("SELECT * FROM jobs ORDER BY name").all() as Row[]).map(toJob);
    },

    get(id: string): Job {
      const r = row(id);
      if (!r) throw notFound("The job");
      return toJob(r);
    },

    create(body: Record<string, unknown>, actor: string): Job {
      const j = parse(body, undefined);
      taken(j.name, null);
      const id = randomUUID();
      const now = new Date(clock()).toISOString();
      db.prepare(
        "INSERT INTO jobs (id, name, urls, interval_seconds, labels, auth, username, secret, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, j.name, JSON.stringify(j.urls), j.interval, JSON.stringify(j.labels), j.auth, j.username, j.secret, actor, now, now);
      return this.get(id);
    },

    update(id: string, body: Record<string, unknown>): Job {
      const existing = row(id);
      if (!existing) throw notFound("The job");
      const j = parse(body, existing);
      taken(j.name, id);
      db.prepare("UPDATE jobs SET name = ?, urls = ?, interval_seconds = ?, labels = ?, auth = ?, username = ?, secret = ?, updated_at = ? WHERE id = ?").run(
        j.name,
        JSON.stringify(j.urls),
        j.interval,
        JSON.stringify(j.labels),
        j.auth,
        j.username,
        j.secret,
        new Date(clock()).toISOString(),
        id,
      );
      return this.get(id);
    },

    remove(id: string): void {
      if (!db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes) throw notFound("The job");
    },

    /** Every job with its secret opened, for the scrape config. */
    forScrape(): ScrapeJob[] {
      return (db.prepare("SELECT * FROM jobs ORDER BY name").all() as Row[]).map((r) => ({
        ...toJob(r),
        secret: r.secret === null ? null : sealer.open(r.secret),
      }));
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
