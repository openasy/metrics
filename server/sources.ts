// Which OpenAsy products Metrics scrapes (ADR 0063), found as Compliance finds them (ADR 0058): each product of
// OPENASY_PRODUCTS at its address with /metrics after it, unless METRICS_SOURCES names another, as it must when a
// product serves /metrics on a port of its own (ADR 0026). Metrics itself is scraped on its own port, not through the
// proxy.
import type { ProductLink } from "./products.ts";
import type { Source } from "./scrape.ts";

export function parseSources(products: ProductLink[], value: string | undefined): { sources: Source[]; invalid: string[] } {
  const urls = new Map<string, string>();
  for (const p of products) if (p.id !== "metrics") urls.set(p.id, `${p.url}/metrics`);
  const invalid: string[] = [];
  for (const entry of (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)) {
    const at = entry.indexOf("=");
    const id = entry.slice(0, at).trim();
    const url = URL.parse(entry.slice(at + 1).trim());
    if (
      at < 1 ||
      !/^[a-z][a-z0-9-]*$/.test(id) ||
      id === "metrics" ||
      !url ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      invalid.push(entry);
      continue;
    }
    urls.set(id, url.href);
  }
  return { sources: [...urls].map(([product, url]) => ({ product, url })).sort((a, b) => a.product.localeCompare(b.product)), invalid };
}
