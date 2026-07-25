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
 *  A top-level file (src/cli.ts) has no subsystem and is skipped for edge purposes. */
const subsystemOf = (p) => {
  const m = /^packages\/(?:server|shared)\/src\/([^/]+)\//.exec(p);
  return m ? m[1] : null;
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

if (after === before) {
  console.log(`gen-tree-map: up to date (${modules.length} modules, ${totalDeps} dependencies)`);
  process.exit(0);
}
if (CHECK) {
  console.error("gen-tree-map: TREE.md is STALE — run `just map`");
  process.exit(1);
}
writeFileSync("TREE.md", after);
console.log(`gen-tree-map: wrote TREE.md (${modules.length} modules, ${totalDeps} dependencies)`);
