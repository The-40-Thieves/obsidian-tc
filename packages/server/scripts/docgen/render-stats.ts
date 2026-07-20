// docgen — stats renderer (homepage "at a glance"). Pure: StatsDoc -> CommonMark.
import type { StatsDoc } from "./extract-stats";

export function renderStats(s: StatsDoc): string {
  return [
    "| | |",
    "|---|---|",
    `| **Version** | \`${s.version}\` |`,
    `| **Tools** | ${s.tools} governed capabilities (advertised via the 3-tool facade) |`,
    `| **Config keys** | ${s.configKeys} |`,
    `| **Golden set** | ${s.goldenSetSize} queries, statistical ship rule on every ranking change |`,
    `| **Retrieval** | contextual chunk enrichment ${s.enrichmentGain}, defaults on |`,
    "| **MCP spec** | [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) |",
    "| **License** | AGPL-3.0-only |",
  ].join("\n");
}
