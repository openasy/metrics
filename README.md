# metrics

[![CI](https://github.com/openasy/metrics/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/metrics/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Metrics product: **the numbers behind your systems, kept and graphed, so
you see the cause and not only the symptom** (ADR 0063). Metrics scrapes the `/metrics` of every OpenAsy product of
the install and the exporters you add, takes OpenTelemetry metrics and Prometheus remote write, keeps the series in
VictoriaMetrics inside its one container, and answers PromQL: for its own dashboards and Explore, and for Grafana and
vmalert, which take it as a Prometheus data source as it is.

```
OpenAsy products' /metrics ──scraped──┐
node_exporter, exporters ────scraped──┼──▶  metrics  ──▶ VictoriaMetrics (127.0.0.1, /data)
OpenTelemetry, remote write ───push───┘        │
                                               ├──▶ dashboards, Explore, metric list, targets
                                               └──▶ /prometheus: Grafana, vmalert ──▶ Alerts
```

## What is scraped

- **Every OpenAsy product** in `OPENASY_PRODUCTS`, at its address with `/metrics` after it, as the job `openasy` with
  the label `product`. Products find each other the same way for the product switcher and Compliance (ADR 0058). A
  product that serves `/metrics` on a port of its own (ADR 0026) is named in `METRICS_SOURCES`, as
  `vpn=http://vpn:9090/metrics`. Metrics scrapes itself too.
- **Jobs** you add under Targets: a name, the addresses (`http://10.0.0.5:9100/metrics`; one without a path reads
  `/metrics`), how often, labels added to what it reads, and a bearer token or a user and password. The token or
  password is sealed with `openasy-kek` (ADR 0021), never shown again, and written for VictoriaMetrics only to a file in
  `/tmp`, which is a tmpfs, readable by Metrics alone. Adding, changing or deleting a job takes effect at once.
- **A target that stops answering** is shown as down, with its last scrape error; the first screen says so too.

## Reading it

- **Dashboards**: panels of PromQL over a time range, read again every minute, with one cursor across them. Three come
  with Metrics and cannot be changed, only copied: the OpenAsy products (answering, requests, server errors, uptime),
  the scrapes (up by job, duration, samples) and Metrics' own storage.
- **Explore**: any PromQL, graphed, with each series' last value. The last queries are kept in the browser.
- **Metric list**: every metric name with its type and help, as its target sent them, and its series now.
- **Grafana** reads Metrics as a Prometheus data source: URL `https://metrics.example.com/prometheus`, with an API
  token of the viewer role sent as `Authorization: Bearer`. vmalert takes the same URL as `-datasource.url` and sends
  what fires to Alerts (ADR 0059). Only Prometheus' read API is passed on (query, query_range, series, labels, label
  values, metadata, buildinfo); VictoriaMetrics' admin paths, such as deleting series, are not reachable.

## Pushing to it

```yaml
# OpenTelemetry collector: OTLP/HTTP with protobuf, gzip allowed
exporters:
  otlphttp/openasy:
    metrics_endpoint: https://metrics.example.com/opentelemetry/v1/metrics
    headers: { Authorization: "Bearer <METRICS_INGEST_TOKEN>" }

# prometheus.yml, for a Prometheus that keeps its own scraping
remote_write:
  - url: https://metrics.example.com/prometheus/api/v1/write
    authorization: { credentials: <METRICS_INGEST_TOKEN> }
```

OpenTelemetry names become Prometheus names (`http.server.duration` is `http_server_duration_seconds`), and
`service.name` becomes the label `service_name`.

## Run

```bash
openssl rand -hex 32 > openasy-kek
export METRICS_INGEST_TOKEN=$(openssl rand -hex 32)   # only if something pushes
docker compose up -d
docker compose logs metrics | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `METRICS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `OPENASY_PRODUCTS` | | The install's OpenAsy products: each is scraped, and shown in the product switcher |
| `METRICS_SOURCES` | | `product=address` for a product whose `/metrics` is not at its address |
| `METRICS_INGEST_TOKEN` | | Lets collectors and remote write push samples and nothing else. An API token with the editor role works too |
| `METRICS_SCRAPE_INTERVAL_SECONDS` | `30` | How often products are scraped, and jobs unless they say otherwise |
| `METRICS_RETENTION_DAYS` | `30` | How long series are kept |
| `METRICS_MAX_SERIES` | `1000000` | New series taken per hour; above it they are refused and counted. `0` is no limit |
| `METRICS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `METRICS_DATA` | `/data` | SQLite file and VictoriaMetrics' storage, on the `/data` volume |
| `METRICS_RUN_DIR` | `/tmp/metrics` | The scrape config and the secret files of jobs; keep it on a tmpfs |
| `METRICS_STORAGE_PORT` | `8428` | VictoriaMetrics' port, on 127.0.0.1 inside the container |
| `METRICS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `METRICS_HEADLESS` | `false` | `true` serves only the API |
| `METRICS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

To scrape `https://` targets signed by the install's own CA, mount its root and set `SSL_CERT_FILE` to it;
VictoriaMetrics reads it.

When the data volume is nearly full, VictoriaMetrics stops taking new samples rather than stopping, and the screens
say so. `/metrics` has `openasy_metrics_storage_up`, `openasy_metrics_targets{health}`, `openasy_metrics_active_series`,
`openasy_metrics_series_refused_total` and the disk used and free. Watch `openasy_metrics_storage_up` from a system
other than Metrics.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.
VictoriaMetrics listens only on 127.0.0.1 and is reached only through Metrics, which checks every request's role.

## Roles

Viewers see and query everything, Grafana's token included; editors also keep dashboards and push samples; admins also
add, change and delete scrape jobs, which may hold passwords, and manage members and API tokens (ADR 0003).

## Not yet

Recording rules, starring dashboards, targets from the install's hosts file (ADR 0052) and Kubernetes discovery,
per-panel time overrides, variables in dashboards, downsampling and a size limit for the disk are planned. Alerting
rules stay in vmalert or Prometheus and go to Alerts. Logs, traces and profiles are other products.

## Develop

```bash
npm install
npm test        # fetches the pinned VictoriaMetrics into vendor/, then scrapes, pushes and queries it for real, and checks every API response against openapi.json
npm run dev     # the UI, with the API on :8080
node scripts/openapi.ts   # after changing the API
```

## Licence

AGPL-3.0 (ADR 0008).
