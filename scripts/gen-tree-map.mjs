#!/usr/bin/env node
// GOTCHA (THE-578): run this with NO built dist/ output present. depcruise resolves the workspace
// packages differently when packages/*/dist exists — with packages/shared/dist present this reports
// 246 modules / 888 dependencies for a tree that is really 247 / 977. Both runs are internally
// deterministic, so the wrong number looks perfectly stable and the drift gate then fails in CI
// (which never builds before map:check) for reasons that look unrelated to your change. If
// `map:check` disagrees with a fresh `map`, delete packages/*/dist and regenerate.
/**
 * TREE.md dependency-graph generator (THE-470, partial).
 *
 * TREE.md opens with "This file is hand-generated and **will drift**", and §7 spells out the exact
 * depcruise incantation to refresh it — which means the numbers were only ever as fresh as the last
 * time somebody ran it by hand. This generates the machine-derivable half (scale, subsystem graph,
 * fan-in/fan-out) into marker regions, so `just map` refreshes it and `just map-check` fails CI when
 * it drifts. The prose sections stay hand-written; only the bytes between markers are touched.
 *
 * Reuses docgen's marker convention (<!-- BEGIN GENERATED: name --> … <!-- END GENERATED: name -->)
 * rather than inventing a second one.
 *
 * TWO TRAPS, both already documented in check-boundaries.mjs and TREE.md §7, both re-hit while
 * writing this — they are guarded here rather than merely commented:
 *
 *   1. NEVER PASS A DIRECTORY. dependency-cruiser 18.x declares support for typescript <7.0.0 and
 *      this repo is on TypeScript 7; given a directory it enumerates ZERO .ts files and cheerfully
 *      reports success over an empty set. So the file list is explicit, and a zero-module result is
 *      treated as a FAILURE, never a pass.
 *   2. IN ZSH, `depcruise $FILES` PASSES ONE ARGUMENT, not many — zsh does not word-split unquoted
 *      parameters the way bash does. Irrelevant here because execFileSync takes an array, which is
 *      the real fix.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CHECK = process.argv.includes("--check");
const SOURCE_GLOBS = [
  "packages/server/src/*.ts",
  "packages/server/src/**/*.ts",
  "packages/shared/src/*.ts",
  "packages/shared/src/**/*.ts",
  // The companion plugin was invisible to this map: its coupling to the server — the thing an
  // architecture diagram exists to show — did not appear anywhere. packages/plugin/src/routes.ts
  // is one of the largest files in the repo (36KB) and was absent from the dependency graph that
  // check-boundaries and every reader treat as the picture of the system.
  "packages/plugin/src/*.ts",
  "packages/plugin/src/**/*.ts",
];
/** Subsystem = first path segment under src/. Edges below this weight are omitted from the diagram
 *  so it stays readable; the full pair count is still reported in the scale line. */
const MIN_EDGE_WEIGHT = 5;
const TOP_N = 5;

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const files = run("git", ["ls-files", ...SOURCE_GLOBS])
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

if (files.length === 0) {
  console.error(
    "gen-tree-map: git ls-files matched no sources — refusing to generate from nothing",
  );
  process.exit(1);
}

const DEPCRUISE = "./node_modules/.bin/depcruise";
let raw;
try {
  raw = run(DEPCRUISE, [...files, "--config", ".dependency-cruiser.cjs", "--output-type", "json"]);
} catch (err) {
  // A fresh git worktree has no node_modules, so this is the first thing that breaks there — and a
  // raw ENOENT stack trace is a poor way to say "run bun install", especially now that this runs as
  // a pre-commit hook and a CI gate.
  if (err?.code === "ENOENT") {
    console.error(`gen-tree-map: ${DEPCRUISE} not found — run \`bun install\` in this checkout`);
    process.exit(1);
  }
  throw err;
}
const graph = JSON.parse(raw);
const modules = graph.modules ?? [];

// The false-green guard. See trap 1 above: an empty module set is the symptom of a resolver
// mismatch, not of a repo with no code.
if (modules.length === 0) {
  console.error(
    "gen-tree-map: depcruise resolved 0 modules from " +
      `${files.length} file(s). That is a resolver failure (see trap 1), not an empty repo.`,
  );
  process.exit(1);
}

/** First path segment under a package's src/ — "packages/server/src/tools/x.ts" -> "tools".
 *  A top-level file (src/cli.ts) has no subsystem and is skipped for edge purposes.
 *
 *  The plugin is deliberately a SINGLE subsystem rather than being decomposed the same way. Its
 *  files sit directly under src/ with no subdirectories, so the segment rule above would return
 *  null for every one of them — adding the glob alone counts the modules and then drops them from
 *  every edge, which looks like coverage and shows nothing. Treating the package as one node is
 *  what actually surfaces the server<->plugin coupling, and it keeps server/shared grouping
 *  byte-identical to before: nothing about the existing subsystems changes. */
const subsystemOf = (p) => {
  const m = /^packages\/(?:server|shared)\/src\/([^/]+)\//.exec(p);
  if (m) return m[1];
  return /^packages\/plugin\/src\//.test(p) ? "plugin" : null;
};

const fileCount = new Map();
const edges = new Map(); // "from->to" -> count
let totalDeps = 0;
let crossImports = 0;

for (const mod of modules) {
  const from = subsystemOf(mod.source);
  if (from) fileCount.set(from, (fileCount.get(from) ?? 0) + 1);
  for (const dep of mod.dependencies ?? []) {
    totalDeps += 1;
    const to = subsystemOf(dep.resolved);
    if (!from || !to || from === to) continue;
    crossImports += 1;
    const key = `${from}\u0000${to}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
}

const sortedEdges = [...edges.entries()]
  .map(([k, weight]) => {
    const [from, to] = k.split("\u0000");
    return { from, to, weight };
  })
  .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));

// ── scale ────────────────────────────────────────────────────────────────────
const scale =
  `**${modules.length} modules · ${totalDeps} dependencies · ${sortedEdges.length} distinct ` +
  `subsystem pairs · ${crossImports} cross-subsystem imports.**`;

// ── mermaid subsystem graph ──────────────────────────────────────────────────
const shown = sortedEdges.filter((e) => e.weight >= MIN_EDGE_WEIGHT);
const nodes = [...new Set(shown.flatMap((e) => [e.from, e.to]))].sort(
  (a, b) => (fileCount.get(b) ?? 0) - (fileCount.get(a) ?? 0) || a.localeCompare(b),
);
const nodeLine = (n) => {
  const c = fileCount.get(n);
  const label = c ? `${n}<br/>${c} files` : n;
  // db is rendered as a cylinder purely to make the storage layer legible at a glance.
  return n === "db" ? `  ${n}[(${label})]` : `  ${n}[${label}]`;
};
const mermaid = [
  "```mermaid",
  "flowchart LR",
  ...nodes.map(nodeLine),
  "",
  ...shown.map((e) => `  ${e.from} -->|${e.weight}| ${e.to}`),
  "```",
].join("\n");

const graphBlock = [
  `Edge labels are import counts. Only edges with weight ≥ ${MIN_EDGE_WEIGHT} are shown; the full`,
  `set is ${sortedEdges.length} pairs.`,
  "",
  mermaid,
].join("\n");

// ── fan-in / fan-out ─────────────────────────────────────────────────────────
const tally = (pick) => {
  const m = new Map();
  for (const e of sortedEdges) m.set(e[pick], (m.get(e[pick]) ?? 0) + e.weight);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
};
const fanIn = tally("to");
const fanOut = tally("from");
const fanTable = [
  "| most depended-on | imports | most dependent | imports |",
  "|---|---:|---|---:|",
  ...Array.from({ length: Math.max(fanIn.length, fanOut.length) }, (_, i) => {
    const [inName, inN] = fanIn[i] ?? ["", ""];
    const [outName, outN] = fanOut[i] ?? ["", ""];
    const cell = (n) => (n ? `\`${n}\`` : "");
    return `| ${cell(inName)} | ${inN} | ${cell(outName)} | ${outN} |`;
  }),
].join("\n");

// ── inject ───────────────────────────────────────────────────────────────────
const markers = (name) => ({
  begin: `<!-- BEGIN GENERATED: ${name} -->`,
  end: `<!-- END GENERATED: ${name} -->`,
});

function inject(source, name, content) {
  const { begin, end } = markers(name);
  const b = source.indexOf(begin);
  const e = source.indexOf(end);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`gen-tree-map: missing or mismatched marker pair for "${name}" in TREE.md`);
  }
  return `${source.slice(0, b + begin.length)}\n${content.trim()}\n${source.slice(e)}`;
}

const before = readFileSync("TREE.md", "utf8");
let after = before;
after = inject(after, "tree-scale", scale);
after = inject(after, "tree-subsystem-graph", graphBlock);
after = inject(after, "tree-fan", fanTable);

// Machine-readable twin of the Mermaid diagram. The edge weights are already computed above for
// the diagram, which only renders pairs at or above MIN_EDGE_WEIGHT — this emits the FULL set, so
// a tool (or an agent) reading the graph is not limited to what happened to be legible in a
// picture. Sorted so the file is diffable and the drift check below is stable.
const GRAPH_JSON = "docs/dependency-graph.json";
const graphJson = `${JSON.stringify(
  {
    generatedBy: "scripts/gen-tree-map.mjs",
    note: "Generated — do not edit. Subsystem = first path segment under a package's src/; the whole plugin package is one subsystem (see TREE.md §7).",
    scale: {
      modules: modules.length,
      dependencies: totalDeps,
      subsystemPairs: edges.size,
      crossSubsystemImports: crossImports,
    },
    subsystems: Object.fromEntries([...fileCount.entries()].sort(([a], [b]) => a.localeCompare(b))),
    // Reuses the already-split `sortedEdges` above rather than re-splitting edges.entries(). The
    // key separator is a NUL (line ~122); splitting on a guessed "->" produced `{from:"a<NUL>b"}`
    // with no `to` field and wrote NUL bytes into a tracked file — the exact thing
    // check-nul-bytes.mjs rejects. One split, one place, no second chance to get it wrong.
    edges: sortedEdges,
  },
  null,
  2,
)}\n`;
let jsonBefore = "";
try {
  jsonBefore = readFileSync(GRAPH_JSON, "utf8");
} catch {
  // absent — treated as stale below, which is what a first run should be
}
const jsonStale = jsonBefore !== graphJson;

// Both artifacts are checked together: TREE.md can be current while the JSON is not (only one of
// them is rewritten when the other's inputs change), and an early exit on TREE.md alone would let
// a stale graph.json pass the gate forever.
if (after === before && !jsonStale) {
  console.log(`gen-tree-map: up to date (${modules.length} modules, ${totalDeps} dependencies)`);
  process.exit(0);
}
if (CHECK) {
  const stale = [after !== before ? "TREE.md" : null, jsonStale ? GRAPH_JSON : null]
    .filter(Boolean)
    .join(" + ");
  console.error(`gen-tree-map: ${stale} is STALE — run \`just map\``);
  process.exit(1);
}
if (after !== before) writeFileSync("TREE.md", after);
if (jsonStale) writeFileSync(GRAPH_JSON, graphJson);
console.log(
  `gen-tree-map: wrote ${[after !== before ? "TREE.md" : null, jsonStale ? GRAPH_JSON : null].filter(Boolean).join(" + ")} (${modules.length} modules, ${totalDeps} dependencies)`,
);
