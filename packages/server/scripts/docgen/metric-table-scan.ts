// docgen — hand-written metric-table scanner (THE-595 guard case (c)). marker-scan.ts's guard
// catches (a) a render target absent from targets.ts and (b) a marker with no renderer, but not
// case (c): a doc table enumerating `obsidian_tc_*` metric names with NO marker at all — exactly
// how docs/G2.4-observability.md's catalog table went 21 metrics stale, invisible to every
// existing gate because nothing ever looked at hand-written prose for a duplicated catalog.
//
// Scans the SAME doc surface as marker-scan.ts's candidateFiles (single list, multiple consumers —
// see that file's export comment), strips generated regions (a catalog appearing INSIDE a
// generated region is expected and correct — that is the fix, not the bug), and flags any file
// whose remaining hand-written prose still enumerates a metric catalog in table form.
import { readFileSync } from "node:fs";
import { candidateFiles } from "./marker-scan";

const METRIC_NAME_RE = /`(obsidian_tc_[a-zA-Z0-9_]+)`/g;
const GENERATED_REGION_RE =
  /<!-- BEGIN GENERATED: [\w-]+ -->[\s\S]*?<!-- END GENERATED: [\w-]+ -->/g;
const TABLE_ROW_RE = /^\s*\|/;

/** A table enumerating this many or more distinct metric names outside any generated region reads
 *  as a hand-copied catalog, not an incidental example row referencing one metric in passing. */
const MIN_TABLE_METRICS = 3;

export interface HandWrittenMetricTable {
  file: string;
  metrics: string[];
}

export interface MetricTableScanResult {
  /** Total `` `obsidian_tc_*` `` mentions across the scanned surface, generated regions included —
   *  a sanity floor. Zero means the regex or the file list is broken, not that the docs are clean;
   *  a caller must treat that as a FAILURE (the same class of silent-empty-scan bug marker-scan.ts
   *  guards against for markers), never a pass. */
  totalMentions: number;
  violations: HandWrittenMetricTable[];
}

/** Every candidate doc, scanned for a hand-written table duplicating the metrics catalog. */
export function findHandWrittenMetricTables(repoRoot: string): MetricTableScanResult {
  let totalMentions = 0;
  const violations: HandWrittenMetricTable[] = [];
  for (const rel of candidateFiles(repoRoot)) {
    let text: string;
    try {
      text = readFileSync(`${repoRoot}/${rel}`, "utf8");
    } catch {
      continue;
    }
    totalMentions += [...text.matchAll(METRIC_NAME_RE)].length;

    const outsideGenerated = text.replace(GENERATED_REGION_RE, "");
    const names = new Set<string>();
    for (const line of outsideGenerated.split("\n")) {
      if (!TABLE_ROW_RE.test(line)) continue;
      for (const m of line.matchAll(METRIC_NAME_RE)) {
        const name = m[1];
        if (name) names.add(name);
      }
    }
    if (names.size >= MIN_TABLE_METRICS) {
      violations.push({ file: rel, metrics: [...names].sort() });
    }
  }
  return { totalMentions, violations };
}
