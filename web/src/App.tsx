import {
  AppShell,
  Badge,
  BrandProvider,
  Button,
  Callout,
  ChartSync,
  Checkbox,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  QueryBar,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  TextField,
  TimeRangePicker,
  TimeSeriesChart,
  formatBytes,
  formatNumber,
  toLocale,
  useAgo,
  useLocalePreference,
  usePath,
  useThemePreference,
  type Column,
  type ProductId,
  type Tone,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  ArrowDown,
  ArrowUp,
  ChartLine,
  Compass,
  Copy,
  Crosshair,
  KeyRound,
  LayoutDashboard,
  List,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  api,
  MfaSetupRequired,
  Unauthorized,
  UNITS,
  type Dashboard,
  type Health,
  type Job,
  type JobAuth,
  type Matrix,
  type MetricName,
  type Panel as PanelSpec,
  type ProductLink,
  type Summary,
  type Target,
  type Unit,
} from "./api.ts";
import { useT } from "./i18n.ts";
import { formatter, rangePath, toChart } from "./promql.ts";
import { search } from "./search.ts";

const PAGES = ["dashboards", "explore", "metric-list", "targets", "setup", "account", "members", "signin", "tokens", "about"] as const;
type Page = (typeof PAGES)[number];
type Route = { page: Page } | { page: "dashboard"; id: string } | { page: "edit"; id: string | null };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = [...PAGES];
function parseRoute(path: string): Route {
  const [page, id, action] = path.replace(/^\//, "").split("/");
  if (page === "dashboards" && id === "new") return { page: "edit", id: null };
  if (page === "dashboards" && id && action === "edit") return { page: "edit", id: decodeURIComponent(id) };
  if (page === "dashboards" && id) return { page: "dashboard", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as Page };
  return { page: "dashboards" };
}

/** A query parameter of the address. */
const param = (name: string) => new URLSearchParams(window.location.search).get(name);

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
type Call = ReturnType<typeof useApi>;

/** Loads a list once and on demand, for the pages that edit what they show. */
function useList<T>(call: Call, path: string, key: string) {
  const [items, setItems] = useState<T[]>();
  const load = useCallback(
    () =>
      void call<Record<string, T[]>>(path).then(
        (r) => setItems(r[key]),
        () => setItems([]),
      ),
    [call, path, key],
  );
  useEffect(load, [load]);
  return [items, load] as const;
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const labelText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

const HEALTH_TONE: Record<Health, Tone> = { up: "success", down: "danger", unknown: "neutral" };

function HealthBadge({ health }: { health: Health }) {
  const t = useT();
  return <StatusBadge tone={HEALTH_TONE[health]}>{t(`health.${health}`)}</StatusBadge>;
}

function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-fg">{children}</pre>;
}

function ErrorText({ message }: { message?: string }) {
  return message ? <p className="m-0 text-xs text-danger">{message}</p> : null;
}

/** Runs a change and reports its error, the way every form here does. */
function useAction(after: () => void) {
  const [error, setError] = useState<string>();
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(undefined);
        after();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [after],
  );
  return [run, error, setError] as const;
}

// ---------------------------------------------------------------- Charts

/** One panel: its PromQL over the range, drawn as lines. `tick` changes to read it again. */
function PanelChart({ call, panel, range, tick, actions }: { call: Call; panel: PanelSpec; range: string; tick: number; actions?: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<{ matrix?: Matrix; error?: string }>({});
  useEffect(() => {
    let live = true;
    void call<{ data: Matrix }>(rangePath(panel.expr, range)).then(
      (r) => live && setState({ matrix: r.data }),
      (err: Error) => live && setState({ error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [call, panel.expr, range, tick]);
  const chart = useMemo(() => (state.matrix ? toChart(state.matrix, range, panel.legend) : undefined), [state.matrix, range, panel.legend]);
  return (
    <Panel
      title={panel.title}
      description={
        <span className="metrics-clamp font-mono text-2xs" title={panel.expr}>
          {panel.expr}
        </span>
      }
      actions={actions}
    >
      {state.error ? (
        <Callout tone="danger" title={t("chart.failed")}>
          <span className="metrics-wrap font-mono text-xs">{state.error}</span>
        </Callout>
      ) : !chart ? (
        <div className="metrics-chart-empty text-xs text-fg-muted">{t("chart.loading")}</div>
      ) : !chart.series.length ? (
        <div className="metrics-chart-empty text-xs text-fg-muted">{t("chart.noData")}</div>
      ) : (
        <>
          <TimeSeriesChart
            label={panel.title}
            labels={chart.labels}
            series={chart.series}
            height={200}
            format={formatter(panel.unit)}
            stacked={panel.stacked}
            area={panel.stacked}
            yMax={panel.unit === "percent" ? 100 : panel.unit === "ratio" ? 1 : undefined}
            xTicks={4}
          />
          {chart.hidden > 0 && <p className="m-0 mt-1 text-2xs text-fg-muted">{t("chart.hidden", { count: chart.hidden })}</p>}
        </>
      )}
    </Panel>
  );
}

/** Reads again every so often while the page is open, and on demand. */
function useTick(every: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!every) return;
    const id = setInterval(() => setTick((n) => n + 1), every * 1000);
    return () => clearInterval(id);
  }, [every]);
  return [tick, () => setTick((n) => n + 1)] as const;
}

// ---------------------------------------------------------------- Dashboards

function DashboardsPage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const [dashboards] = useList<Dashboard>(call, "/api/v1/dashboards", "dashboards");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "own" | "builtIn">("all");
  const shown = (dashboards ?? []).filter(
    (d) =>
      (scope === "all" || (scope === "builtIn") === d.builtIn) &&
      [d.name, d.folder, d.description, ...d.tags].some((s) => s.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const columns: Column<Dashboard>[] = [
    {
      id: "name",
      header: t("dashboardsPage.name"),
      width: "40%",
      sortValue: (d) => d.name,
      cell: (d) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{d.name}</span>
          {d.description && <span className="metrics-clamp text-2xs text-fg-muted">{d.description}</span>}
        </span>
      ),
    },
    { id: "folder", header: t("dashboardsPage.folder"), sortValue: (d) => d.folder, cell: (d) => d.folder || "–" },
    {
      id: "panels",
      header: t("dashboardsPage.panels"),
      width: "80px",
      align: "right",
      mono: true,
      sortValue: (d) => d.panels.length,
      cell: (d) => d.panels.length,
    },
    {
      id: "tags",
      header: t("dashboardsPage.tags"),
      cell: (d) => (
        <span className="flex flex-wrap gap-1">
          {d.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
      ),
    },
    {
      id: "updated",
      header: t("dashboardsPage.updated"),
      width: "170px",
      align: "right",
      sortValue: (d) => (d.builtIn ? "" : d.updatedAt),
      cell: (d) =>
        d.builtIn ? <Badge tone="info">{t("dashboardsPage.builtIn")}</Badge> : <span className="whitespace-nowrap text-fg-muted">{when(d.updatedAt)}</span>,
    },
  ];
  return (
    <>
      <PageHeader
        title={t("dashboardsPage.dashboards")}
        description={t("dashboardsPage.description")}
        actions={
          <>
            <SearchInput label={t("dashboardsPage.search")} shortcut="/" className="w-56" value={q} onChange={(e) => setQ(e.target.value)} />
            {can("editor") && (
              <Button variant="primary" icon={<Plus />} onClick={() => navigate("/dashboards/new")}>
                {t("dashboardsPage.new")}
              </Button>
            )}
          </>
        }
      >
        <SegmentedControl
          label={t("dashboardsPage.scope")}
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: t("dashboardsPage.all") },
            { value: "own", label: t("dashboardsPage.own") },
            { value: "builtIn", label: t("dashboardsPage.builtInOnes") },
          ]}
        />
      </PageHeader>
      <Panel title={t("dashboardsPage.dashboards")} description={t("dashboardsPage.shown", { shown: shown.length, all: dashboards?.length ?? 0 })} flush>
        <DataTable
          label={t("dashboardsPage.dashboards")}
          columns={columns}
          rows={shown}
          loading={!dashboards}
          getRowId={(d) => d.id}
          onRowClick={(d) => navigate(`/dashboards/${encodeURIComponent(d.id)}`)}
          minWidth={760}
          empty={<EmptyState title={t("dashboardsPage.none")} icon={<LayoutDashboard />} />}
        />
      </Panel>
    </>
  );
}

const REFRESH = ["0", "30", "60", "300"] as const;

function DashboardPage({ call, id }: { call: Call; id: string }) {
  const t = useT();
  const { can } = useAuth();
  const [d, setD] = useState<Dashboard | null>();
  const [range, setRange] = useState(param("range") ?? "1h");
  const [every, setEvery] = useState<(typeof REFRESH)[number]>("60");
  const [tick, refresh] = useTick(Number(every));
  const [confirm, setConfirm] = useState(false);
  const [run, error] = useAction(useCallback(() => navigate("/dashboards"), []));
  useEffect(() => void call<Dashboard>(`/api/v1/dashboards/${encodeURIComponent(id)}`).then(setD, () => setD(null)), [call, id]);
  if (d === null)
    return (
      <EmptyState title={t("dashboardPage.notFound")} action={<Button onClick={() => navigate("/dashboards")}>{t("dashboardPage.back")}</Button>}>
        {t("dashboardPage.notFoundDetail")}
      </EmptyState>
    );
  if (!d) return <EmptyState title={t("product.loading")} icon={<LayoutDashboard />} />;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("dashboardsPage.dashboards"), href: "/dashboards" }, ...(d.folder ? [{ label: d.folder }] : [])]}
        title={d.name}
        description={d.description || undefined}
        meta={d.builtIn && <Badge tone="info">{t("dashboardsPage.builtIn")}</Badge>}
        actions={
          <>
            <TimeRangePicker value={range} onChange={setRange} />
            <SelectField
              aria-label={t("dashboardPage.autoRefresh")}
              value={every}
              onChange={(e) => setEvery(e.target.value as (typeof REFRESH)[number])}
              options={REFRESH.map((s) => ({
                value: s,
                label: s === "0" ? t("dashboardPage.refreshOff") : t("dashboardPage.refreshEvery", { seconds: Number(s) }),
              }))}
            />
            <IconButton label={t("dashboardPage.refreshNow")} onClick={refresh}>
              <RefreshCw />
            </IconButton>
            {can("editor") && (
              <Button icon={<Copy />} onClick={() => navigate(`/dashboards/new?from=${encodeURIComponent(d.id)}`)}>
                {t("dashboardPage.copy")}
              </Button>
            )}
            {can("editor") && !d.builtIn && (
              <Button icon={<Pencil />} onClick={() => navigate(`/dashboards/${encodeURIComponent(d.id)}/edit`)}>
                {t("dashboardPage.edit")}
              </Button>
            )}
            {can("editor") && !d.builtIn && (
              <IconButton label={t("dashboardPage.delete")} variant="ghost" onClick={() => setConfirm(true)}>
                <Trash2 />
              </IconButton>
            )}
          </>
        }
      />
      {!d.panels.length ? (
        <EmptyState
          title={t("dashboardPage.noPanels")}
          icon={<ChartLine />}
          action={
            can("editor") &&
            !d.builtIn && <Button onClick={() => navigate(`/dashboards/${encodeURIComponent(d.id)}/edit`)}>{t("dashboardPage.addPanels")}</Button>
          }
        />
      ) : (
        <ChartSync>
          <div className="metrics-panels">
            {d.panels.map((p, i) => (
              <PanelChart
                key={`${i}:${p.expr}`}
                call={call}
                panel={p}
                range={range}
                tick={tick}
                actions={
                  <Button size="xs" variant="ghost" onClick={() => navigate(`/explore?${new URLSearchParams({ q: p.expr, range })}`)}>
                    {t("dashboardPage.explore")}
                  </Button>
                }
              />
            ))}
          </div>
        </ChartSync>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("dashboardPage.deleteTitle", { name: d.name })}
        description={t("dashboardPage.deleteDetail")}
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("form.cancel")}</Button>
            <Button variant="danger" onClick={() => void run(() => call(`/api/v1/dashboards/${encodeURIComponent(d.id)}`, { method: "DELETE" }))}>
              {t("dashboardPage.delete")}
            </Button>
          </>
        }
      >
        <ErrorText message={error} />
      </Dialog>
    </>
  );
}

const emptyPanel = (): PanelSpec => ({ title: "", expr: "", unit: "none", legend: "", stacked: false });

/** A new dashboard, a copy of one (?from=) or changes to one. */
function DashboardEditor({ call, id }: { call: Call; id: string | null }) {
  const t = useT();
  const from = id ?? param("from");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [panels, setPanels] = useState<PanelSpec[]>(() => {
    const q = param("q");
    return [q ? { ...emptyPanel(), title: q.slice(0, 120), expr: q } : emptyPanel()];
  });
  const [loaded, setLoaded] = useState(!from);
  const [run, error] = useAction(useCallback(() => {}, []));
  useEffect(() => {
    if (!from) return;
    void call<Dashboard>(`/api/v1/dashboards/${encodeURIComponent(from)}`).then(
      (d) => {
        setName(id ? d.name : t("editor.copyOf", { name: d.name }));
        setFolder(d.folder);
        setDescription(d.description);
        setTags(d.tags.join(", "));
        setPanels(d.panels.length ? d.panels : [emptyPanel()]);
        setLoaded(true);
      },
      () => setLoaded(true),
    );
  }, [call, from, id, t]);
  const set = (i: number, p: Partial<PanelSpec>) => setPanels((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, by: number) =>
    setPanels((ps) => {
      const next = [...ps];
      const [p] = next.splice(i, 1);
      next.splice(i + by, 0, p!);
      return next;
    });
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = JSON.stringify({
      name,
      folder,
      description,
      tags: tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      panels: panels.filter((p) => p.title.trim() || p.expr.trim()),
    });
    void run(async () => {
      const d = await call<Dashboard>(id ? `/api/v1/dashboards/${encodeURIComponent(id)}` : "/api/v1/dashboards", { method: id ? "PUT" : "POST", body });
      navigate(`/dashboards/${encodeURIComponent(d.id)}`);
    });
  };
  if (!loaded) return <EmptyState title={t("product.loading")} icon={<LayoutDashboard />} />;
  return (
    <form className="flex flex-col gap-4" onSubmit={save} aria-label={id ? t("editor.edit") : t("editor.new")}>
      <PageHeader
        breadcrumbs={[{ label: t("dashboardsPage.dashboards"), href: "/dashboards" }]}
        title={id ? t("editor.edit") : t("editor.new")}
        actions={
          <>
            <Button onClick={() => (id ? navigate(`/dashboards/${encodeURIComponent(id)}`) : navigate("/dashboards"))}>{t("form.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>
              {t("form.save")}
            </Button>
          </>
        }
      />
      <ErrorText message={error} />
      <Panel title={t("editor.about")}>
        <div className="metrics-cols-2">
          <TextField label={t("editor.name")} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          <TextField label={t("editor.folder")} value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={60} />
          <TextField label={t("editor.description")} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          <TextField label={t("editor.tags")} hint={t("editor.tagsHint")} value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </Panel>
      {panels.map((p, i) => (
        <Panel
          key={i}
          title={t("editor.panel", { n: i + 1 })}
          actions={
            <span className="flex gap-1">
              <IconButton label={t("editor.up")} size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp />
              </IconButton>
              <IconButton label={t("editor.down")} size="sm" variant="ghost" disabled={i === panels.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown />
              </IconButton>
              <IconButton label={t("editor.remove")} size="sm" variant="ghost" onClick={() => setPanels((ps) => ps.filter((_, j) => j !== i))}>
                <Trash2 />
              </IconButton>
            </span>
          }
        >
          <div className="flex flex-col gap-2.5">
            <div className="metrics-cols-2">
              <TextField label={t("editor.title")} value={p.title} onChange={(e) => set(i, { title: e.target.value })} maxLength={120} />
              <TextField
                label={t("editor.legend")}
                hint={t("editor.legendHint", { example: "{{instance}}" })}
                mono
                value={p.legend}
                onChange={(e) => set(i, { legend: e.target.value })}
              />
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t("editor.expr")}
              <textarea
                className="metrics-textarea"
                rows={2}
                spellCheck={false}
                value={p.expr}
                onChange={(e) => set(i, { expr: e.target.value })}
                placeholder="sum by (job) (rate(openasy_http_requests_total[5m]))"
              />
            </label>
            <div className="metrics-cols-2">
              <SelectField
                label={t("editor.unit")}
                value={p.unit}
                onChange={(e) => set(i, { unit: e.target.value as Unit })}
                options={UNITS.map((u) => ({ value: u, label: t(`units.${u}`) }))}
              />
              <Checkbox label={t("editor.stacked")} checked={p.stacked} onChange={(e) => set(i, { stacked: e.target.checked })} />
            </div>
          </div>
        </Panel>
      ))}
      <div>
        <Button icon={<Plus />} onClick={() => setPanels((ps) => [...ps, emptyPanel()])} disabled={panels.length >= 40}>
          {t("editor.addPanel")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- Explore

const EXAMPLES = ["up", "sum by (job) (up)", "sum by (product) (rate(openasy_http_requests_total[5m]))", "scrape_duration_seconds"];
const HISTORY_KEY = "openasy-metrics-history";

/** The last queries run here, kept in this browser only. */
function readHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

function ExplorePage({ call }: { call: Call }) {
  const t = useT();
  const { can } = useAuth();
  const [draft, setDraft] = useState(param("q") ?? "");
  const [query, setQuery] = useState(param("q") ?? "");
  const [range, setRange] = useState(param("range") ?? "1h");
  const [stacked, setStacked] = useState(false);
  const [history, setHistory] = useState(readHistory);
  const [tick, refresh] = useTick(0);
  const [result, setResult] = useState<{ matrix?: Matrix; error?: string }>({});
  const runQuery = (q: string) => {
    const expr = q.trim();
    setDraft(expr);
    setQuery(expr);
    refresh();
    if (!expr) return;
    navigate(`/explore?${new URLSearchParams({ q: expr, range })}`, { replace: true });
    const next = [expr, ...history.filter((h) => h !== expr)].slice(0, 10);
    setHistory(next);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // A private window keeps no history; the query still runs.
    }
  };
  useEffect(() => {
    if (!query) return setResult({});
    let live = true;
    setResult({});
    void call<{ data: Matrix }>(rangePath(query, range)).then(
      (r) => live && setResult({ matrix: r.data }),
      (err: Error) => live && setResult({ error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [call, query, range, tick]);
  const chart = useMemo(() => (result.matrix ? toChart(result.matrix, range) : undefined), [result.matrix, range]);
  const format = formatter("none");
  const rows = (chart?.series ?? []).map((s) => ({ id: s.id, name: s.name, last: s.data.at(-1) ?? 0 }));
  return (
    <>
      <PageHeader title={t("explorePage.explore")} description={t("explorePage.description")}>
        <div className="metrics-querybar">
          <QueryBar value={draft} onChange={setDraft} onSubmit={runQuery} label={t("explorePage.query")} placeholder="rate(openasy_http_requests_total[5m])" />
          <TimeRangePicker value={range} onChange={setRange} size="md" />
          {can("editor") && query && (
            <Button icon={<Plus />} onClick={() => navigate(`/dashboards/new?${new URLSearchParams({ q: query })}`)}>
              {t("explorePage.toDashboard")}
            </Button>
          )}
        </div>
      </PageHeader>
      <div className="flex flex-wrap gap-1">
        {EXAMPLES.map((e) => (
          <Button key={e} size="xs" variant="ghost" onClick={() => runQuery(e)}>
            <span className="font-mono">{e}</span>
          </Button>
        ))}
      </div>
      {result.error && (
        <Callout tone="danger" title={t("explorePage.failed")}>
          <span className="metrics-wrap font-mono text-xs">{result.error}</span>
        </Callout>
      )}
      {!query ? (
        <EmptyState title={t("explorePage.start")} icon={<Compass />}>
          {t("explorePage.startDetail")}
        </EmptyState>
      ) : (
        !result.error && (
          <>
            <Panel
              title={t("explorePage.graph")}
              actions={
                <SegmentedControl
                  label={t("explorePage.style")}
                  size="sm"
                  value={stacked ? "stacked" : "lines"}
                  onChange={(v) => setStacked(v === "stacked")}
                  options={[
                    { value: "lines", label: t("explorePage.lines") },
                    { value: "stacked", label: t("explorePage.stacked") },
                  ]}
                />
              }
            >
              {!chart ? (
                <div className="metrics-chart-empty text-xs text-fg-muted">{t("chart.loading")}</div>
              ) : !chart.series.length ? (
                <div className="metrics-chart-empty text-xs text-fg-muted">{t("chart.noData")}</div>
              ) : (
                <>
                  <TimeSeriesChart
                    label={t("explorePage.resultOf", { query })}
                    labels={chart.labels}
                    series={chart.series}
                    height={280}
                    format={format}
                    stacked={stacked}
                    area={stacked}
                    xTicks={6}
                  />
                  {chart.hidden > 0 && <p className="m-0 mt-1 text-2xs text-fg-muted">{t("chart.hidden", { count: chart.hidden })}</p>}
                </>
              )}
            </Panel>
            <Panel title={t("explorePage.series")} description={t("explorePage.seriesDetail")} flush>
              <DataTable
                label={t("explorePage.series")}
                columns={[
                  { id: "name", header: t("explorePage.labels"), cell: (r) => <span className="metrics-wrap font-mono text-xs">{r.name}</span> },
                  {
                    id: "last",
                    header: t("explorePage.last"),
                    width: "140px",
                    align: "right",
                    mono: true,
                    sortValue: (r) => r.last,
                    cell: (r) => format(r.last),
                  },
                ]}
                rows={rows}
                loading={!chart}
                getRowId={(r) => r.id}
                minWidth={520}
                empty={<EmptyState title={t("chart.noData")} />}
              />
            </Panel>
          </>
        )
      )}
      {history.length > 0 && (
        <Panel title={t("explorePage.history")} flush>
          <ul className="metrics-list" aria-label={t("explorePage.history")}>
            {history.map((h) => (
              <li key={h}>
                <button type="button" className="metrics-history font-mono text-xs" onClick={() => runQuery(h)}>
                  {h}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Metric list

const TYPES = ["all", "counter", "gauge", "histogram", "summary"] as const;

function MetricListPage({ call, summary }: { call: Call; summary: Summary }) {
  const t = useT();
  const [data, setData] = useState<{ metrics: MetricName[]; totalSeries: number } | null>();
  const [q, setQ] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("all");
  useEffect(() => void call<{ metrics: MetricName[]; totalSeries: number }>("/api/v1/metric-names").then(setData, () => setData(null)), [call]);
  const shown = (data?.metrics ?? []).filter(
    (m) =>
      (type === "all" || m.type === type) &&
      (m.name.toLowerCase().includes(q.trim().toLowerCase()) || (m.help ?? "").toLowerCase().includes(q.trim().toLowerCase())),
  );
  const s = summary.storage;
  const columns: Column<MetricName>[] = [
    {
      id: "name",
      header: t("metricList.name"),
      width: "36%",
      sortValue: (m) => m.name,
      cell: (m) => <span className="metrics-wrap font-mono text-xs">{m.name}</span>,
    },
    { id: "type", header: t("metricList.type"), width: "110px", sortValue: (m) => m.type ?? "", cell: (m) => (m.type ? <Badge>{m.type}</Badge> : "–") },
    {
      id: "series",
      header: t("metricList.series"),
      width: "100px",
      align: "right",
      mono: true,
      sortValue: (m) => m.series ?? -1,
      cell: (m) => (m.series === null ? "–" : formatNumber(m.series)),
    },
    { id: "help", header: t("metricList.help"), cell: (m) => <span className="metrics-clamp text-xs text-fg-muted">{m.help ?? ""}</span> },
  ];
  return (
    <>
      <PageHeader title={t("metricList.metricList")} description={t("metricList.description")} />
      <KpiGrid minWidth={160}>
        <KpiCard label={t("metricList.names")} value={data ? formatNumber(data.metrics.length) : "–"} icon={List} />
        <KpiCard
          label={t("metricList.active")}
          value={formatNumber(s.activeSeries, { compact: true })}
          unit={s.maxSeries ? t("metricList.limit", { limit: formatNumber(s.maxSeries, { compact: true }) }) : undefined}
          tone={s.maxSeries && s.activeSeries > s.maxSeries * 0.8 ? "warning" : undefined}
        />
        <KpiCard
          label={t("metricList.samples")}
          value={s.samplesPerSecond === null ? "–" : formatNumber(Math.round(s.samplesPerSecond), { compact: true })}
          unit={t("metricList.perSecond")}
        />
        <KpiCard label={t("metricList.refused")} value={formatNumber(s.refusedSeries)} tone={s.refusedSeries ? "danger" : "success"} />
      </KpiGrid>
      {s.refusedSeries > 0 && (
        <Callout tone="danger" title={t("metricList.refusedTitle", { count: s.refusedSeries })}>
          {t("metricList.refusedDetail")}
        </Callout>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput label={t("metricList.search")} className="w-72" value={q} onChange={(e) => setQ(e.target.value)} />
        <SegmentedControl
          label={t("metricList.type")}
          value={type}
          onChange={setType}
          options={TYPES.map((v) => ({ value: v, label: v === "all" ? t("metricList.all") : v }))}
        />
      </div>
      <Panel title={t("metricList.metrics")} description={t("metricList.shown", { count: shown.length })} flush>
        <DataTable
          label={t("metricList.metrics")}
          columns={columns}
          rows={shown}
          loading={data === undefined}
          getRowId={(m) => m.name}
          onRowClick={(m) => navigate(`/explore?${new URLSearchParams({ q: m.name })}`)}
          defaultSort={{ id: "series", direction: "desc" }}
          pageSize={100}
          minWidth={760}
          empty={<EmptyState title={data === null ? t("metricList.failed") : t("metricList.none")} />}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Targets

const labelsText = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const parseLabels = (text: string) =>
  Object.fromEntries(
    text
      .split(/\n|,/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const at = l.indexOf("=");
        return at < 0 ? [l, ""] : [l.slice(0, at).trim(), l.slice(at + 1).trim()];
      }),
  );

function JobDialog({ call, job, open, onClose, onSaved }: { call: Call; job?: Job; open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [name, setName] = useState(job?.name ?? "");
  const [urls, setUrls] = useState(job?.urls.join("\n") ?? "");
  const [interval, setIntervalSeconds] = useState(String(job?.intervalSeconds ?? 30));
  const [labels, setLabels] = useState(job ? labelsText(job.labels) : "");
  const [auth, setAuth] = useState<JobAuth>(job?.auth ?? "none");
  const [username, setUsername] = useState(job?.username ?? "");
  const [secret, setSecret] = useState("");
  const [run, error] = useAction(
    useCallback(() => {
      onSaved();
      onClose();
    }, [onSaved, onClose]),
  );
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = JSON.stringify({
      name,
      urls: urls
        .split(/\s+/)
        .map((u) => u.trim())
        .filter(Boolean),
      intervalSeconds: Number(interval),
      labels: parseLabels(labels),
      auth,
      ...(auth === "basic" && { username }),
      ...(secret && { secret }),
    });
    void run(() => call(job ? `/api/v1/jobs/${job.id}` : "/api/v1/jobs", { method: job ? "PUT" : "POST", body }));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={job ? t("jobs.edit", { name: job.name }) : t("jobs.add")}
      description={t("jobs.addDetail")}
      onSubmit={save}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t("form.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || !urls.trim()}>
            {t("form.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <div className="metrics-cols-2">
          <TextField label={t("jobs.name")} hint={t("jobs.nameHint")} mono value={name} onChange={(e) => setName(e.target.value)} required />
          <TextField label={t("jobs.interval")} type="number" min={5} max={3600} value={interval} onChange={(e) => setIntervalSeconds(e.target.value)} />
        </div>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("jobs.urls")}
          <textarea
            className="metrics-textarea"
            rows={3}
            spellCheck={false}
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="http://10.0.0.5:9100/metrics"
          />
          <span className="font-normal text-fg-muted">{t("jobs.urlsHint")}</span>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {t("jobs.labels")}
          <textarea
            className="metrics-textarea"
            rows={2}
            spellCheck={false}
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="team=payments"
          />
          <span className="font-normal text-fg-muted">{t("jobs.labelsHint")}</span>
        </label>
        <div className="metrics-cols-3">
          <SelectField
            label={t("jobs.auth")}
            value={auth}
            onChange={(e) => setAuth(e.target.value as JobAuth)}
            options={(["none", "bearer", "basic"] as const).map((a) => ({ value: a, label: t(`auth.${a}`) }))}
          />
          {auth === "basic" && <TextField label={t("jobs.username")} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />}
          {auth !== "none" && (
            <TextField
              label={auth === "bearer" ? t("jobs.token") : t("jobs.password")}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={job?.hasSecret && job.auth === auth ? t("jobs.kept") : ""}
            />
          )}
        </div>
        {auth !== "none" && <p className="m-0 text-xs text-fg-muted">{t("jobs.sealed")}</p>}
        <ErrorText message={error} />
      </div>
    </Dialog>
  );
}

function TargetsPage({ call, reload }: { call: Call; reload: () => void }) {
  const t = useT();
  const ago = useAgo();
  const { can } = useAuth();
  const [targets, loadTargets] = useList<Target>(call, "/api/v1/targets", "targets");
  const [jobs, loadJobs] = useList<Job>(call, "/api/v1/jobs", "jobs");
  const [health, setHealth] = useState<Health | "all">(param("health") === "down" ? "down" : "all");
  const [editing, setEditing] = useState<Job | "new">();
  const [removing, setRemoving] = useState<Job>();
  const after = useCallback(() => {
    loadJobs();
    reload();
    // VictoriaMetrics applies the new config within a second or two.
    setTimeout(loadTargets, 2000);
  }, [loadJobs, loadTargets, reload]);
  const [run, error] = useAction(after);
  useEffect(() => {
    const id = setInterval(loadTargets, 15_000);
    return () => clearInterval(id);
  }, [loadTargets]);
  const all = targets ?? [];
  const count = (h: Health) => all.filter((x) => x.health === h).length;
  const shown = all.filter((x) => health === "all" || x.health === health);
  const columns: Column<Target>[] = [
    {
      id: "job",
      header: t("targetsPage.job"),
      width: "150px",
      sortValue: (x) => x.job,
      cell: (x) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{x.job}</span>
          {x.product && <span className="text-2xs text-fg-muted">{x.product}</span>}
        </span>
      ),
    },
    {
      id: "url",
      header: t("targetsPage.endpoint"),
      width: "30%",
      sortValue: (x) => x.url,
      cell: (x) => (
        <span className="flex min-w-0 flex-col">
          <span className="metrics-wrap font-mono text-xs">{x.url}</span>
          {x.error && (
            <span className="metrics-clamp text-2xs text-danger" title={x.error}>
              {x.error}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "labels",
      header: t("targetsPage.labels"),
      cell: (x) => (
        <span className="metrics-clamp font-mono text-2xs text-fg-muted" title={labelText(x.labels)}>
          {labelText(x.labels) || "–"}
        </span>
      ),
    },
    { id: "health", header: t("targetsPage.health"), width: "100px", sortValue: (x) => x.health, cell: (x) => <HealthBadge health={x.health} /> },
    {
      id: "last",
      header: t("targetsPage.lastScrape"),
      width: "120px",
      align: "right",
      sortValue: (x) => x.lastScrape ?? "",
      cell: (x) => <span className="whitespace-nowrap text-fg-muted">{ago(x.lastScrape)}</span>,
    },
    {
      id: "duration",
      header: t("targetsPage.duration"),
      width: "90px",
      align: "right",
      mono: true,
      sortValue: (x) => x.durationMs ?? -1,
      cell: (x) => (x.durationMs === null ? "–" : `${x.durationMs} ms`),
    },
    {
      id: "samples",
      header: t("targetsPage.samples"),
      width: "90px",
      align: "right",
      mono: true,
      sortValue: (x) => x.samples ?? -1,
      cell: (x) => (x.samples === null ? "–" : formatNumber(x.samples)),
    },
  ];
  const jobColumns: Column<Job>[] = [
    { id: "name", header: t("jobs.name"), sortValue: (j) => j.name, cell: (j) => <span className="font-mono text-xs">{j.name}</span> },
    {
      id: "urls",
      header: t("jobs.urls"),
      cell: (j) => (
        <span className="metrics-clamp font-mono text-2xs" title={j.urls.join("\n")}>
          {j.urls.join(", ")}
        </span>
      ),
    },
    { id: "interval", header: t("jobs.every"), width: "90px", align: "right", mono: true, cell: (j) => `${j.intervalSeconds} s` },
    { id: "auth", header: t("jobs.auth"), width: "120px", cell: (j) => t(`auth.${j.auth}`) },
    ...(can("admin")
      ? [
          {
            id: "actions",
            header: "",
            width: "90px",
            align: "right" as const,
            cell: (j: Job) => (
              <span className="flex justify-end gap-1">
                <IconButton label={t("jobs.edit", { name: j.name })} size="sm" variant="ghost" onClick={() => setEditing(j)}>
                  <Pencil />
                </IconButton>
                <IconButton label={t("jobs.delete", { name: j.name })} size="sm" variant="ghost" onClick={() => setRemoving(j)}>
                  <Trash2 />
                </IconButton>
              </span>
            ),
          },
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        title={t("targetsPage.targets")}
        description={t("targetsPage.description")}
        actions={
          <SegmentedControl
            label={t("targetsPage.health")}
            value={health}
            onChange={setHealth}
            options={[
              { value: "all", label: t("targetsPage.all") },
              { value: "up", label: t("health.up") },
              { value: "down", label: t("health.down") },
              { value: "unknown", label: t("health.unknown") },
            ]}
          />
        }
      />
      <KpiGrid minWidth={150}>
        <KpiCard label={t("health.up")} value={count("up")} tone="success" unit={t("targetsPage.of", { count: all.length })} />
        <KpiCard label={t("health.down")} value={count("down")} tone={count("down") ? "danger" : "success"} />
        <KpiCard label={t("health.unknown")} value={count("unknown")} />
        <KpiCard label={t("targetsPage.jobs")} value={jobs?.length ?? "–"} icon={Crosshair} />
      </KpiGrid>
      <Panel title={t("targetsPage.targets")} description={t("targetsPage.shown", { count: shown.length })} flush>
        <DataTable
          label={t("targetsPage.scrapeTargets")}
          columns={columns}
          rows={shown}
          loading={!targets}
          getRowId={(x) => `${x.job} ${x.url}`}
          minWidth={980}
          empty={<EmptyState title={t("targetsPage.none")} icon={<Crosshair />} />}
        />
      </Panel>
      <Panel
        title={t("jobs.jobs")}
        description={t("jobs.description")}
        actions={
          can("admin") && (
            <Button size="sm" icon={<Plus />} onClick={() => setEditing("new")}>
              {t("jobs.add")}
            </Button>
          )
        }
        flush
      >
        <DataTable
          label={t("jobs.jobs")}
          columns={jobColumns}
          rows={jobs ?? []}
          loading={!jobs}
          getRowId={(j) => j.id}
          minWidth={720}
          empty={<EmptyState title={t("jobs.none")}>{t("jobs.noneDetail")}</EmptyState>}
        />
      </Panel>
      {editing && <JobDialog call={call} job={editing === "new" ? undefined : editing} open onClose={() => setEditing(undefined)} onSaved={after} />}
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        title={removing ? t("jobs.delete", { name: removing.name }) : ""}
        description={t("jobs.deleteDetail")}
        size="sm"
        footer={
          <>
            <Button onClick={() => setRemoving(undefined)}>{t("form.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => void run(() => call(`/api/v1/jobs/${removing!.id}`, { method: "DELETE" })).then((ok) => ok && setRemoving(undefined))}
            >
              {t("form.delete")}
            </Button>
          </>
        }
      >
        <ErrorText message={error} />
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- Setup

function SetupPage({ summary }: { summary: Summary }) {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setupPage.setup")} description={t("setupPage.description")} />
      <Panel title={t("setupPage.products")} description={t("setupPage.productsDetail", { count: summary.products })}>
        <Code>{`# Every OpenAsy product, in each product's environment (ADR 0001):
OPENASY_PRODUCTS=vpn=https://vpn.example.com,logs=https://logs.example.com,metrics=${origin}
# A product that serves /metrics on a port of its own (ADR 0026), on metrics:
METRICS_SOURCES=vpn=http://vpn:9090/metrics`}</Code>
      </Panel>
      <Panel title={t("setupPage.grafana")} description={t("setupPage.grafanaDetail")}>
        <Code>{`# grafana/provisioning/datasources/openasy-metrics.yaml
apiVersion: 1
datasources:
  - name: OpenAsy Metrics
    type: prometheus
    url: ${origin}/prometheus
    jsonData: { httpHeaderName1: Authorization, prometheusType: Prometheus }
    secureJsonData: { httpHeaderValue1: "Bearer <API token, viewer role>" }`}</Code>
      </Panel>
      <Panel title={t("setupPage.vmalert")} description={t("setupPage.vmalertDetail")}>
        <Code>{`vmalert -rule=/etc/vmalert/*.yaml \\
  -datasource.url=${origin}/prometheus -datasource.bearerToken=<API token, viewer role> \\
  -notifier.url=https://alerts.example.com -notifier.bearerToken=<ALERTS_INGEST_TOKEN>`}</Code>
      </Panel>
      <Panel title={t("setupPage.otel")} description={t("setupPage.otelDetail")}>
        <Code>{`# OpenTelemetry collector
exporters:
  otlphttp/openasy:
    metrics_endpoint: ${origin}/opentelemetry/v1/metrics
    headers: { Authorization: "Bearer <METRICS_INGEST_TOKEN>" }`}</Code>
      </Panel>
      <Panel title={t("setupPage.remoteWrite")} description={t("setupPage.remoteWriteDetail")}>
        <Code>{`# prometheus.yml
remote_write:
  - url: ${origin}/prometheus/api/v1/write
    authorization: { credentials: <METRICS_INGEST_TOKEN> }`}</Code>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settingsPage.adminsOnly")}>{t("settingsPage.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settingsPage.${page}.title`)}
        description={t(`settingsPage.${page}.description`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settingsPage.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

/** Shown above every page while something needs attention: the storage, or targets that do not answer. */
function Attention({ summary, page }: { summary: Summary; page: string }) {
  const t = useT();
  const s = summary.storage;
  if (!s.running)
    return (
      <Callout tone="danger" title={t("attention.storage")}>
        {t("attention.storageDetail")}
      </Callout>
    );
  if (s.freeBytes > 0 && s.freeBytes < 1024 ** 3)
    return (
      <Callout tone="warning" title={t("attention.disk", { free: formatBytes(s.freeBytes) })}>
        {t("attention.diskDetail")}
      </Callout>
    );
  if (summary.targets.down > 0 && page !== "targets")
    return (
      <Callout
        tone="warning"
        title={t("attention.down", { count: summary.targets.down })}
        action={
          <Button size="sm" onClick={() => navigate("/targets?health=down")}>
            {t("attention.see")}
          </Button>
        }
      >
        {summary.down
          .slice(0, 3)
          .map((x) => `${x.job} ${x.url}`)
          .join(", ")}
      </Callout>
    );
  return null;
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "metrics" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => void call<Summary>("/api/v1/summary").then(setSummary, () => {}), [call]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const targets = summary ? summary.targets.up + summary.targets.down + summary.targets.unknown : undefined;
  const nav = [
    { id: "dashboards", label: msg("product.dashboards"), icon: LayoutDashboard, count: summary?.dashboards || undefined },
    { id: "explore", label: msg("product.explore"), icon: Compass },
    { id: "metric-list", label: msg("product.metricList"), icon: List },
    { id: "targets", label: msg("product.targets"), icon: Crosshair, count: targets || undefined },
    { id: "setup", label: msg("product.setup"), icon: Wrench },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("product.members"), icon: Users },
          { id: "signin", label: msg("product.signIn"), icon: LogIn },
          { id: "tokens", label: msg("product.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("product.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const settings = route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens";
  const active = route.page === "dashboard" || route.page === "edit" ? "dashboards" : route.page;

  return (
    <AppShell
      product="metrics"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {settings ? (
        <SettingsPage page={route.page as "account" | "members" | "signin" | "tokens"} />
      ) : !summary ? (
        <EmptyState title={msg("product.loading")} icon={<ChartLine />}>
          {msg("product.reading")}
        </EmptyState>
      ) : (
        <>
          <Attention summary={summary} page={route.page} />
          {route.page === "dashboard" ? (
            <DashboardPage key={route.id} call={call} id={route.id} />
          ) : route.page === "edit" ? (
            <DashboardEditor key={`${route.id}${window.location.search}`} call={call} id={route.id} />
          ) : route.page === "explore" ? (
            <ExplorePage call={call} />
          ) : route.page === "metric-list" ? (
            <MetricListPage call={call} summary={summary} />
          ) : route.page === "targets" ? (
            <TargetsPage key={window.location.search} call={call} reload={reload} />
          ) : route.page === "setup" ? (
            <SetupPage summary={summary} />
          ) : (
            <DashboardsPage call={call} />
          )}
        </>
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Metrics">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
