// docgen — render CLI (THE-472). Builds the model, renders the reference tables, and injects them
// into the wiki pages' GENERATED marker regions (THE-473). Deterministic: re-running with unchanged
// code + schema is a no-op. Pass --check to fail (exit 1) if any target is stale — the drift gate
// (THE-476) uses that.
//
//   bun scripts/docgen/render.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractConfig } from "./extract-config";
import { extractErrors } from "./extract-errors";
import { extractMetrics } from "./extract-metrics";
import { extractStats } from "./extract-stats";
import { extractTools } from "./extract-tools";
import { injectGenerated } from "./inject";
import { findGeneratedMarkers } from "./marker-scan";
import { findHandWrittenMetricTables } from "./metric-table-scan";
import { renderBridgeCompat } from "./render-bridge-compat";
import { renderConfig } from "./render-config";
import { renderErrors } from "./render-errors";
import { renderMetrics } from "./render-metrics";
import { renderStats } from "./render-stats";
import { renderToolSummary, renderTools } from "./render-tools";
import { GENERATED_DOC_FILES } from "./targets";

const check = process.argv.includes("--check");
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const repo = (rel: string): string => `${repoRoot}/${rel}`;

// Render each surface once; the same content fills every target that hosts it.
const toolDocs = extractTools();
const toolsMd = renderTools(toolDocs);
// THE-473: README/ARCHITECTURE get the COMPACT summary, not the ~30KB reference table — injecting
// the full catalog into a 260-line README would bury the prose it supports. THE-469's root cause
// was that these two files named none of the write tools, so the summary names them explicitly.
const toolSummaryMd = renderToolSummary(toolDocs);
const configMd = renderConfig(extractConfig());
const metricsMd = renderMetrics(await extractMetrics());
const errorsMd = renderErrors(extractErrors());

// Assert the render targets and the shared list stay in step: a target added here without a
// corresponding entry in targets.ts would leave the prose watcher (THE-477) blind to it, which is
// exactly the drift that motivated the shared list.
const targets: Array<{ rel: string; file: string; marker: string; content: string }> = [
  // GitHub wiki (THE-475 publishes these).
  {
    rel: "docs/wiki/Tool-Reference.md",
    file: repo("docs/wiki/Tool-Reference.md"),
    marker: "tools",
    content: toolsMd,
  },
  {
    rel: "docs/wiki/Configuration.md",
    file: repo("docs/wiki/Configuration.md"),
    marker: "config",
    content: configMd,
  },
  {
    rel: "docs/wiki/Home.md",
    file: repo("docs/wiki/Home.md"),
    marker: "stats",
    content: renderStats(extractStats()),
  },
  // Astro docs site (THE-474) — Starlight autogenerate slots these into the Tools / Configuration nav.
  {
    rel: "docs/src/content/docs/tools/tool-catalog.md",
    file: repo("docs/src/content/docs/tools/tool-catalog.md"),
    marker: "tools",
    content: toolsMd,
  },
  {
    rel: "docs/src/content/docs/configuration/config-reference.md",
    file: repo("docs/src/content/docs/configuration/config-reference.md"),
    marker: "config",
    content: configMd,
  },
  // THE-470 hole 2: the metrics catalog table, generated from extract-metrics.ts so the counts and
  // "no v1 source" caveats can never drift from what is actually registered/fed.
  {
    rel: "docs/src/content/docs/observability/prometheus.md",
    file: repo("docs/src/content/docs/observability/prometheus.md"),
    marker: "metrics-catalog",
    content: metricsMd,
  },
  // THE-595: G2.4's design-doc catalog was a hand-typed enumeration that drifted 21 metrics
  // behind the live registry, invisible to every gate above (docs/*.md was outside the marker
  // scan entirely). Same content as prometheus.md's region — one source, two surfaces.
  {
    rel: "docs/G2.4-observability.md",
    file: repo("docs/G2.4-observability.md"),
    marker: "metrics-catalog",
    content: metricsMd,
  },
  // THE-470 hole 1: the server<->companion version-compatibility matrix, generated from
  // src/bridge/version.ts. This region previously had no renderer at all — only a vitest test
  // (bridge-compat-docs.test.ts) asserted it, which is why the bidirectional guard below exists.
  {
    rel: "docs/wiki/Plugin-Bridges.md",
    file: repo("docs/wiki/Plugin-Bridges.md"),
    marker: "bridge-compat",
    content: renderBridgeCompat(),
  },
  // THE-470: the error catalog. extract-errors.ts has worked and been tested since THE-471, but
  // its only consumer was build-model.ts — which prints JSON to stdout, is committed nowhere, and
  // runs in no workflow. 35 error codes every client must branch on reached no reader at all. The
  // ticket framed it as "render it or delete the extractor"; this renders it, and folds in the
  // THE-512 recovery hints from the same taxonomy so the two cannot disagree.
  {
    rel: "docs/src/content/docs/tools/error-catalog.md",
    file: repo("docs/src/content/docs/tools/error-catalog.md"),
    marker: "errors",
    content: errorsMd,
  },
  // Hand-authored narrative docs (THE-473). Only the marked region is replaced; every byte of
  // surrounding prose is preserved, so positioning stays human-written.
  { rel: "README.md", file: repo("README.md"), marker: "tools-summary", content: toolSummaryMd },
  {
    rel: "ARCHITECTURE.md",
    file: repo("ARCHITECTURE.md"),
    marker: "tools-summary",
    content: toolSummaryMd,
  },
];

const declared = new Set<string>(GENERATED_DOC_FILES);
for (const t of targets) {
  // Use the repo-relative path the target already carries. Deriving it from the absolute path via
  // indexOf("obsidian-tc/") broke on CI, where the checkout is .../work/obsidian-tc/obsidian-tc/:
  // the first match left a stray prefix. Locally there is one occurrence, so it passed here and
  // failed there.
  const rel = t.rel;
  if (!declared.has(rel)) {
    throw new Error(
      `docgen: render target "${rel}" is missing from GENERATED_DOC_FILES (scripts/docgen/targets.ts). ` +
        "Add it there so the prose watcher sees it too.",
    );
  }
}

// THE-470 hole 1: the check above is one-directional — it only fires when a TARGET forgets to
// declare itself. It says nothing about a marker that exists in a doc with no target at all,
// which is exactly how docs/wiki/Plugin-Bridges.md's `bridge-compat` region went unrendered:
// nothing here noticed, because nothing here ever looked at what markers the docs tree actually
// carries. This scan closes that gap in the other direction.
const discoveredMarkers = findGeneratedMarkers(repoRoot);
// A scan finding zero markers is a broken glob, not a clean docs tree — fail loudly rather than
// pass vacuously (the same class of silent-empty-scan bug this repo has hit before).
if (discoveredMarkers.length === 0) {
  throw new Error(
    "docgen: marker scan found ZERO <!-- BEGIN GENERATED --> markers across the docs tree — the " +
      "scan is broken (scripts/docgen/marker-scan.ts), not the docs. Refusing to report success.",
  );
}
const registeredMarkers = new Set<string>(targets.map((t) => `${t.rel}::${t.marker}`));
const orphaned = discoveredMarkers.filter((d) => !registeredMarkers.has(`${d.file}::${d.marker}`));
if (orphaned.length > 0) {
  throw new Error(
    `docgen: marker(s) with no registered renderer:\n${orphaned
      .map((d) => `  ${d.file} (marker: ${d.marker})`)
      .join("\n")}\n` +
      "Add an extract-*.ts/render-*.ts pair and a target entry above, or delete the marker if " +
      "it is no longer meant to be generated.",
  );
}

// THE-595 guard case (c): the two checks above are both marker-shaped — they say nothing about a
// hand-written table that duplicates the metrics catalog with NO marker at all, which is exactly
// how docs/G2.4-observability.md drifted 21 metrics behind reality, invisible to both checks
// above. Same silent-empty-scan risk as the marker scan: a broken regex/glob reads as "nothing to
// report", so the total-mentions floor must be non-zero too.
const metricTableScan = findHandWrittenMetricTables(repoRoot);
if (metricTableScan.totalMentions === 0) {
  throw new Error(
    "docgen: metric-table scan matched ZERO `obsidian_tc_*` mentions across the docs tree — the " +
      "scan is broken (scripts/docgen/metric-table-scan.ts), not the docs. Refusing to report success.",
  );
}
if (metricTableScan.violations.length > 0) {
  throw new Error(
    `docgen: hand-written table(s) duplicating the metrics catalog with no generated marker:\n${metricTableScan.violations
      .map((v) => `  ${v.file} (${v.metrics.length} metrics: ${v.metrics.join(", ")})`)
      .join("\n")}\n` +
      "Convert the table to a generated marker region fed by render-metrics.ts (see the " +
      "docs/G2.4-observability.md target above for an example), or shrink it below the " +
      "hand-written-catalog threshold if it is a genuine one-off example.",
  );
}

let stale = 0;
for (const t of targets) {
  const before = readFileSync(t.file, "utf8");
  const after = injectGenerated(before, t.marker, t.content);
  if (before === after) continue;
  stale += 1;
  if (check) {
    process.stderr.write(
      `docgen: STALE ${t.file} (marker: ${t.marker}) — run \`bun run docgen:render\`\n`,
    );
  } else {
    writeFileSync(t.file, after);
    process.stderr.write(`docgen: wrote ${t.file} (marker: ${t.marker})\n`);
  }
}

if (check && stale > 0) process.exit(1);
if (!check) process.stderr.write(`docgen:render done (${stale} file(s) updated)\n`);
