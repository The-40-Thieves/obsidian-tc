// Through the 2.x line the Prometheus exposition carries every project metric family twice: under
// its current name and under the pre-2.0 name, so existing dashboards and alerts keep working
// while they are migrated. Only the metric name at the start of a line is rewritten, never a label.
import { CURRENT_NAMES, LEGACY_NAMES } from "@the-40-thieves/reliquary-tc-shared";

const CURRENT = CURRENT_NAMES.metricPrefix;
const LEGACY = LEGACY_NAMES.metricPrefix;

function legacyLine(line: string): string | undefined {
  for (const marker of ["# HELP ", "# TYPE "]) {
    if (line.startsWith(marker + CURRENT)) {
      return marker + LEGACY + line.slice(marker.length + CURRENT.length);
    }
  }
  if (line.startsWith(CURRENT)) return LEGACY + line.slice(CURRENT.length);
  return undefined;
}

/** Append a copy of every current-prefix family under the legacy prefix. */
export function withLegacyMetricNames(exposition: string): string {
  const legacy: string[] = [];
  for (const line of exposition.split("\n")) {
    const mapped = legacyLine(line);
    if (mapped !== undefined) legacy.push(mapped);
  }
  const base = exposition.endsWith("\n") ? exposition : `${exposition}\n`;
  return legacy.length === 0 ? base : `${base}${legacy.join("\n")}\n`;
}
