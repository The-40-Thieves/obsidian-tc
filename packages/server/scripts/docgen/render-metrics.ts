// docgen — Prometheus metrics renderer (THE-470 hole 2). MetricDoc[] -> CommonMark: a one-line
// catalog-shape summary plus one table per metric type. Feeds
// docs/src/content/docs/observability/prometheus.md's marker region. Before this, the page's
// counts and "no v1 emission source" caveat were hand-typed prose that went stale the moment a
// metric was added, wired, or fed — deriving the count here is the fix; editing the prose alone
// would just re-drift the next time the catalog changes.
import type { MetricDoc } from "./model";

/** Markdown-table-safe cell: collapse newlines, escape backslashes THEN pipes (order matters — a
 *  bare `\|` in the input must not become an unescaped pipe that breaks the table). Mirrors
 *  render-config.ts's `cell()` — CodeQL flagged the first draft here for escaping `|` alone,
 *  which leaves a trailing backslash in `help` free to combine with the escape it just inserted. */
function cell(v: string): string {
  return v.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
}

function table(title: string, docs: MetricDoc[]): string[] {
  if (docs.length === 0) return [];
  return [
    `### ${title}`,
    "",
    "| Name | Labels | Help |",
    "|---|---|---|",
    ...docs.map(
      (d) =>
        `| \`${d.name}\` | ${
          d.labels.length ? d.labels.map((l) => `\`${l}\``).join(", ") : "—"
        } | ${cell(d.help)} |`,
    ),
    "",
  ];
}

export function renderMetrics(docs: MetricDoc[]): string {
  const counters = docs.filter((d) => d.type === "counter");
  const histograms = docs.filter((d) => d.type === "histogram");
  const gauges = docs.filter((d) => d.type === "gauge");
  const summaries = docs.filter((d) => d.type === "summary");

  const shape = [
    `${counters.length} counters`,
    `${histograms.length} histograms`,
    `${gauges.length} gauges`,
    ...(summaries.length ? [`${summaries.length} summaries`] : []),
  ].join(", ");

  return [
    `obsidian-tc maintains a Prometheus catalog of **${shape}**. The recorder is always live so ` +
      "the `get_metrics` tool and the optional `/metrics` scrape endpoint share the same " +
      "in-memory state. Every catalog name below is registered so `/metrics` is catalog-complete " +
      "even before a metric has live traffic to report.",
    "",
    ...table("Counters", counters),
    ...table("Histograms", histograms),
    ...table("Gauges", gauges),
    ...table("Summaries", summaries),
  ]
    .join("\n")
    .trimEnd();
}
