// What the search window (Cmd+K) finds in Metrics: dashboards by name, folder and tag, and metric names, which open
// in Explore. Both lists are read whole and filtered here.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { LayoutDashboard, List } from "lucide-react";
import type { Dashboard, MetricName } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [{ dashboards }, names] = await Promise.all([
      call<{ dashboards: Dashboard[] }>("/api/v1/dashboards", { signal }),
      call<{ metrics: MetricName[] }>("/api/v1/metric-names", { signal }).catch(() => ({ metrics: [] as MetricName[] })),
    ]);
    const boards = dashboards
      .filter((d) => [d.name, d.folder, ...d.tags].some((s) => s.toLowerCase().includes(q)))
      .slice(0, 5)
      .map((d): SearchResult => ({
        id: `dashboard:${d.id}`,
        label: d.name,
        detail: d.folder || undefined,
        kind: t("search.dashboard"),
        icon: LayoutDashboard,
        href: `/dashboards/${encodeURIComponent(d.id)}`,
      }));
    const metrics = names.metrics
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((m): SearchResult => ({
        id: `metric:${m.name}`,
        label: m.name,
        detail: m.type ?? undefined,
        kind: t("search.metric"),
        icon: List,
        href: `/explore?${new URLSearchParams({ q: m.name })}`,
      }));
    return [...boards, ...metrics];
  };
}
