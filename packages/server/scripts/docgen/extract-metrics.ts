// docgen — metrics extractor (THE-471). Instantiate MetricsRecorder (it registers every Prometheus
// metric on its private Registry) and read them back: name, type, help, and label names. Uses the
// prom-client Registry API so it stays accurate as metrics are added/renamed.
import { MetricsRecorder } from "../../src/metrics/registry";
import type { MetricDoc } from "./model";

const KNOWN = new Set(["counter", "gauge", "histogram", "summary"]);

export async function extractMetrics(): Promise<MetricDoc[]> {
  const rec = new MetricsRecorder();
  const registry = rec.registry;
  const json = (await registry.getMetricsAsJSON()) as unknown as Array<{
    name: string;
    help: string;
    type: string;
  }>;
  const out: MetricDoc[] = [];
  for (const m of json) {
    const single = registry.getSingleMetric(m.name) as
      | { labelNames?: string[]; upperBounds?: number[] }
      | undefined;
    const type = (KNOWN.has(m.type) ? m.type : "gauge") as MetricDoc["type"];
    out.push({
      name: m.name,
      type,
      help: m.help,
      labels: (single?.labelNames ?? []).slice().sort(),
      // THE-595: bucket bounds live on the Histogram instance (set at construction from its
      // `buckets` config), NOT in getMetricsAsJSON()'s `values` — those are empty until a metric
      // has an observation, which would make buckets vanish from a freshly-booted process.
      ...(type === "histogram" && single?.upperBounds
        ? { buckets: single.upperBounds.slice() }
        : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
