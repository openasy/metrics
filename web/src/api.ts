// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Health = "up" | "down" | "unknown";
export type JobAuth = "none" | "bearer" | "basic";
export type Unit = "none" | "percent" | "ratio" | "bytes" | "bytesPerSecond" | "seconds" | "perSecond";
export const UNITS: Unit[] = ["none", "percent", "ratio", "bytes", "bytesPerSecond", "seconds", "perSecond"];

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface Target {
  job: string;
  url: string;
  product: string | null;
  jobId: string | null;
  labels: Record<string, string>;
  health: Health;
  lastScrape: string | null;
  durationMs: number | null;
  samples: number | null;
  error: string | null;
}

export interface Job {
  id: string;
  name: string;
  urls: string[];
  intervalSeconds: number;
  labels: Record<string, string>;
  auth: JobAuth;
  username: string | null;
  hasSecret: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Panel {
  title: string;
  expr: string;
  unit: Unit;
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
  builtIn: boolean;
  createdBy: string;
  updatedAt: string;
}

export interface MetricName {
  name: string;
  type: string | null;
  help: string | null;
  series: number | null;
}

export interface Summary {
  storage: {
    running: boolean;
    activeSeries: number;
    storageBytes: number;
    freeBytes: number;
    samplesTotal: number;
    samplesPerSecond: number | null;
    refusedSeries: number;
    retentionDays: number;
    maxSeries: number;
  };
  targets: { up: number; down: number; unknown: number };
  jobs: number;
  products: number;
  dashboards: number;
  down: Target[];
}

/** A range query's result, as Prometheus answers it. */
export interface Matrix {
  resultType: "matrix";
  result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    // Problem Details from Metrics, or Prometheus' { status: "error", error } from a query.
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; error?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? problem.error ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
