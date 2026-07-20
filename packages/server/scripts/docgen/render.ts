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
import { renderTools } from "./render-tools";

const check = process.argv.includes("--check");
const repo = (rel: string): string => fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

// Render each surface once; the same content fills every target that hosts it.
const toolsMd = renderTools(extractTools());
const configMd = renderConfig(extractConfig());

const targets: Array<{ file: string; marker: string; content: string }> = [
  // GitHub wiki (THE-475 publishes these).
  { file: repo("docs/wiki/Tool-Reference.md"), marker: "tools", content: toolsMd },
  { file: repo("docs/wiki/Configuration.md"), marker: "config", content: configMd },
  { file: repo("docs/wiki/Home.md"), marker: "stats", content: renderStats(extractStats()) },
  // Astro docs site (THE-474) — Starlight autogenerate slots these into the Tools / Configuration nav.
  { file: repo("docs/src/content/docs/tools/tool-catalog.md"), marker: "tools", content: toolsMd },
  {
    file: repo("docs/src/content/docs/configuration/config-reference.md"),
    marker: "config",
    content: configMd,
  },
];

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
