#!/usr/bin/env node
// check-legacy-shims — LEGACY_SHIMS.md is the inventory of every 2025-era (legacy protocol) code
// path that the one-PR removal deletes. Each legacy-only block in source carries the marker line
// `// legacy-era shim: see LEGACY_SHIMS.md`. This gate fails when a marked file has no row in the
// inventory, or a row names a file with no marker (or no file), so the list cannot drift from code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MARKER = "// legacy-era shim: see LEGACY_SHIMS.md";
const INVENTORY = "LEGACY_SHIMS.md";
const SECTION = "## Legacy-only code";

const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages/*/src/*.ts"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

const marked = new Set(
  tracked.filter((file) =>
    readFileSync(resolve(ROOT, file), "utf8")
      .split("\n")
      .some((line) => line.includes(MARKER)),
  ),
);

if (!existsSync(resolve(ROOT, INVENTORY))) {
  console.error(`legacy shims: ${INVENTORY} is missing`);
  process.exit(1);
}
const lines = readFileSync(resolve(ROOT, INVENTORY), "utf8").split("\n");
const start = lines.indexOf(SECTION);
if (start === -1) {
  console.error(`legacy shims: ${INVENTORY} has no "${SECTION}" section`);
  process.exit(1);
}
// Rows are `| \`path:line\` | ...`; only the first column names a file. The section ends at the
// next level-2 heading, so the dual-era table below it is never read as inventory.
const ROW = /^\|\s*`([^`]+?)(?::\d+(?:-\d+)?)?`\s*\|/;
const inventoried = new Set();
for (const line of lines.slice(start + 1)) {
  if (line.startsWith("## ")) break;
  const match = ROW.exec(line);
  if (match) inventoried.add(match[1]);
}

const errors = [];
if (inventoried.size === 0) errors.push(`${INVENTORY}: "${SECTION}" lists no files`);
for (const file of marked) {
  if (!inventoried.has(file)) errors.push(`marked but not inventoried: ${file}`);
}
for (const file of inventoried) {
  if (!tracked.includes(file))
    errors.push(`inventoried file is not a tracked source file: ${file}`);
  else if (!marked.has(file)) errors.push(`inventoried but has no "${MARKER}" marker: ${file}`);
}

if (errors.length > 0) {
  console.error(`legacy shims: ${errors.length} problem(s)`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`legacy shims OK (${marked.size} marked files, ${inventoried.size} inventoried)`);
