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
    const single = registry.getSingleMetric(m.name) as { labelNames?: string[] } | undefined;
    out.push({
      name: m.name,
      type: (KNOWN.has(m.type) ? m.type : "gauge") as MetricDoc["type"],
      help: m.help,
      labels: (single?.labelNames ?? []).slice().sort(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
