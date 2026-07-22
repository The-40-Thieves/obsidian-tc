// docgen — render CLI (THE-472). Builds the model, renders the reference tables, and injects them
// into the wiki pages' GENERATED marker regions (THE-473). Deterministic: re-running with unchanged
// code + schema is a no-op. Pass --check to fail (exit 1) if any target is stale — the drift gate
// (THE-476) uses that.
//
//   bun scripts/docgen/render.ts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractConfig } from "./extract-config";
import { extractStats } from "./extract-stats";
import { extractTools } from "./extract-tools";
import { injectGenerated } from "./inject";
import { renderConfig } from "./render-config";
import { renderStats } from "./render-stats";
import { renderToolSummary, renderTools } from "./render-tools";
import { GENERATED_DOC_FILES } from "./targets";

const check = process.argv.includes("--check");
const repo = (rel: string): string => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

// Render each surface once; the same content fills every target that hosts it.
const toolDocs = extractTools();
const toolsMd = renderTools(toolDocs);
// THE-473: README/ARCHITECTURE get the COMPACT summary, not the ~30KB reference table — injecting
// the full catalog into a 260-line README would bury the prose it supports. THE-469's root cause
// was that these two files named none of the write tools, so the summary names them explicitly.
const toolSummaryMd = renderToolSummary(toolDocs);
const configMd = renderConfig(extractConfig());

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
