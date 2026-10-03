#!/usr/bin/env node
/**
 * Structural-map generator (THE-470, partial).
 *
 * TREE.md's machine-derivable half — scale, per-subsystem file/line table, largest files, subsystem
 * graph, fan-in/fan-out — plus its machine-readable twin (the full edge list as JSON). All of it is
 * a function of the WHOLE tracked tree (`git ls-files`, every line count, every import edge), so
 * any PR that touches any source file moves it, and any two PRs therefore conflicted on it by
 * construction. It is no longer committed: `bun run map` writes it to the gitignored `generated/`
 * directory (tree-map.md + dependency-graph.json) for whoever wants the numbers, and TREE.md keeps
 * only the hand-written prose.
 *
 * `bun run map:check` (ci-docgen) still gates two things: the generator must RUN to completion on
 * any working tree state (it refuses an empty module set, table or scale rather than reporting
 * success over nothing), and nothing generated may be COMMITTED again — no
 * `<!-- BEGIN GENERATED -->` region in TREE.md, no tracked file under `generated/` or at the old
 * docs/dependency-graph.json path (scripts/lib/tree-map-guard.mjs).
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { committedGeneratedProblems } from "./lib/tree-map-guard.mjs";

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

// ── headline scale ───────────────────────────────────────────────────────────
// This describes THE WHOLE CODEBASE, not the TypeScript subset the module graph above is built
// from. TREE.md is the structural map of the repo, and a headline scoped to
// packages/{server,shared,plugin}/src would silently omit the Rust native addon, both Python
// services, the SQL migrations and the shell scripts — a third of the languages here.
//
// Counted from `git ls-files`, NOT by walking the working tree. tokei/cloc over the tree also count
// build leftovers and gitignored caches (graphify-out/ is one on this box), so the headline would
// depend on what happened to be on disk when someone last ran it. git cannot drift that way.
//
// Files and lines only — no "lines of code". Separating comment from code needs a real parser per
// language, and this repo runs ~20% comments in TypeScript; a hand-rolled approximation would be
// wrong by thousands of lines in the direction nobody re-checks. The previous hand-written headline
// claimed a LOC figure and was off by 2,446 after 177 commits, in the opposite direction to its own
// total-lines figure.
const CODE_EXTENSIONS = ["ts", "tsx", "js", "mjs", "cjs", "rs", "py", "sql", "sh"];
const codeFiles = run("git", ["ls-files", ...CODE_EXTENSIONS.map((e) => `*.${e}`)])
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

if (codeFiles.length === 0) {
  console.error("gen-tree-map: git ls-files matched no code files — refusing to emit a zero scale");
  process.exit(1);
}

const countLines = (f) => {
  const text = readFileSync(f, "utf8");
  if (text === "") return 0;
  // A trailing newline terminates the last line, it does not start a new one.
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
};

const byLanguage = new Map();
let totalCodeLines = 0;
for (const f of codeFiles) {
  const ext = f.slice(f.lastIndexOf(".") + 1);
  const lines = countLines(f);
  totalCodeLines += lines;
  const prev = byLanguage.get(ext) ?? { files: 0, lines: 0 };
  byLanguage.set(ext, { files: prev.files + 1, lines: prev.lines + lines });
}

const LANGUAGE_NAMES = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  rs: "Rust",
  py: "Python",
  sql: "SQL",
  sh: "Shell",
};
// Fold the extension buckets into language buckets (ts+tsx, js+mjs+cjs) so the reader sees
// languages, not file suffixes.
const perLanguage = new Map();
for (const [ext, v] of byLanguage) {
  const name = LANGUAGE_NAMES[ext] ?? ext;
  const prev = perLanguage.get(name) ?? { files: 0, lines: 0 };
  perLanguage.set(name, { files: prev.files + v.files, lines: prev.lines + v.lines });
}
const num = (n) => n.toLocaleString("en-US");
const breakdown = [...perLanguage.entries()]
  .sort(([, a], [, b]) => b.lines - a.lines)
  .map(([name, v]) => `${name} ${num(v.lines)}`)
  .join(" · ");

const headlineScale = `**Scale:** ${num(codeFiles.length)} tracked code files · ${num(totalCodeLines)} lines.

${breakdown}.

Counted from \`git ls-files\` over ${CODE_EXTENSIONS.map((e) => `\`.${e}\``).join(", ")} — tracked sources only, so build output and gitignored caches cannot inflate it. §7 carries the module graph.`;

// ── §3 subsystem table ───────────────────────────────────────────────────────
// This table was hand-maintained and carried its own "Last measured <date> against <sha>" stamp —
// the honest form of a hand-written fact, and it still drifted within ONE DAY of being re-measured:
// three PRs landed, one of them adding search/query-encoder.ts, and the table went on claiming
// `search/` had 51 files while the GENERATED subsystem graph 173 lines further down in the same
// file already said 52. A file disagreeing with itself is the clearest possible argument that the
// numbers should not be typed by hand.
//
// Only the NUMBERS are derived. The `notes` column is real prose — what a subsystem is FOR is not
// machine-derivable — so it lives here, keyed by directory name. A subsystem with no entry renders
// an empty note rather than being dropped: a new directory must show up in the table immediately
// (with a blank a human then fills in), because silently omitting it is how a table stays "correct"
// while describing less and less of the tree.
const SUBSYSTEM_NOTES = {
  tools: "domains m1–m8 + admin. The MCP tool surface",
  search: "retrieval + indexing. Includes `graph_search_stages/` (THE-465) and `indexing/` (WP3)",
  mcp: "registry + facade + transport binding. `registry/` holds the dispatch pipeline (WP4)",
  runtime: "**composition root** (WP5) — stores, governance, wiring, transports, shutdown",
  experiential: "work-memory tier: activation, retrieval log, forget, citations",
  vault: "filesystem primitives — paths, links, ACL, snapshots, prune",
  cli: "arg parsing + subcommands",
  scheduler: "unified background scheduler + durable job queue (THE-517)",
  formats: "canvas, base, dataview, kanban parsing",
  db: "provisioning, migrate runner, experiential store",
  migrations: "hand-registered SQL. **Two chains** — see below",
  plane: "generative plane; `jobs/` holds the contradiction detector",
  bridge: "Obsidian plugin bridge clients",
  model: "model-service clients",
  embeddings: "providers incl. the deterministic fake used in tests",
  capability: "`defineTool` and the capability registry",
  // Everything below was invisible before this table was generated — the hand-written version
  // rolled all fourteen into one `others` row with no counts, so `metrics/` at 832 lines read as
  // indistinguishable from `morgiana/` at 101.
  metrics: "Prometheus catalog + `/metrics` endpoint, gauge sources, ingest stats",
  transports: "stdio, HTTP and the shared serve loop",
  doctor: "`obsidian-tc doctor` — checks, report rendering, runner",
  memory: "entity extraction and materialization for the memory folder",
  auth: "JWT verification, JWKS, RFC 9728 protected-resource metadata",
  graph: "graph analytics (centrality, components) behind the health tools",
  config: "config load, `explain`, and the security-profile resolver",
  gateway: "inference-gateway client — the `judge`/`synthesize` roles",
  plur: "PLUR client (local + remote) for the experiential plane",
  workspace: "session tracking",
  otel: "OpenTelemetry tracing, attributes, context propagation",
  capture: "the capture queue",
  util: "concurrency, error shapes, ISO week, pagination",
  morgiana: "Morgiana observability emitter (spike, paused)",
};

// Same scope the hand-written table declared: `.ts` + `.sql` under packages/server/src, excluding
// tests. (Tests live in packages/server/test/, so the exclusion is currently vacuous — asserted
// below rather than assumed, so moving a test under src/ cannot silently inflate a subsystem.)
const TABLE_EXT = /\.(ts|sql)$/;
const tableFiles = run("git", ["ls-files", "packages/server/src"])
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && TABLE_EXT.test(l) && !/\.test\.ts$/.test(l));

if (tableFiles.length === 0) {
  console.error("gen-tree-map: no packages/server/src sources — refusing to emit an empty table");
  process.exit(1);
}

const bySubsystem = new Map();
for (const f of tableFiles) {
  const m = /^packages\/server\/src\/([^/]+)\//.exec(f);
  if (!m) continue; // top-level file (cli.ts, hash.ts, …) — belongs to no subsystem
  const key = m[1];
  const cur = bySubsystem.get(key) ?? { files: 0, lines: 0 };
  cur.files++;
  cur.lines += countLines(f);
  bySubsystem.set(key, cur);
}

const subsystemTable = [
  "| subsystem | files | lines | notes |",
  "|---|---:|---:|---|",
  ...[...bySubsystem.entries()]
    .sort((a, b) => b[1].lines - a[1].lines || a[0].localeCompare(b[0]))
    .map(
      ([name, s]) =>
        `| \`${name}/\` | ${s.files} | ${s.lines.toLocaleString("en-US")} | ${SUBSYSTEM_NOTES[name] ?? ""} |`,
    ),
  "",
  `Derived from \`git ls-files packages/server/src\` over \`.ts\`/\`.sql\`, tests excluded — ${tableFiles.length} files across ${bySubsystem.size} subsystems. Top-level files (\`cli.ts\`, \`hash.ts\`, …) belong to no subsystem and are not counted here.`,
].join("\n");

// ── §4 largest files ─────────────────────────────────────────────────────────
// Also previously hand-maintained with a "re-measure with fd | wc -l" instruction and its own
// dated stamp, and also stale within a day of that stamp: three of eight rows were wrong
// (server-runtime.ts 680 -> 688, search-tools.ts 644 -> 647, metrics/registry.ts 582 -> 600).
// A table whose refresh instruction is a shell one-liner is a table that should just run it.
// Reuses `files` (SOURCE_GLOBS, already resolved above) rather than issuing a fresh
// `git ls-files packages/*/src`: passed through execFileSync there is no shell to expand the glob,
// git receives it literally, and it matches NOTHING. The first draft did exactly that and rendered
// "0 file(s) over 500 lines" for a tree whose largest file is 701 — an empty table that would have
// passed every gate, since map:check only compares committed bytes to regenerated bytes and both
// were equally empty. Visibly-wrong output was the only thing that caught it.
const LARGE_FILE_FLOOR = 500;
const largest = files
  .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
  .map((f) => ({ f, n: countLines(f) }))
  .filter((r) => r.n > LARGE_FILE_FLOOR)
  .sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));

if (largest.length === 0) {
  console.error(
    "gen-tree-map: no file over " +
      `${LARGE_FILE_FLOOR} lines across ${files.length} sources — refusing to emit an empty table`,
  );
  process.exit(1);
}

const largestTable = [
  "| lines | file |",
  "|---:|---|",
  ...largest.map((r) => `| ${r.n} | \`${r.f}\` |`),
  "",
  `${largest.length} file(s) over ${LARGE_FILE_FLOOR} lines, from the same \`git ls-files\` source set as the module graph (\`.ts\` under packages/{server,shared,plugin}/src, tests excluded). The biome \`noExcessiveLinesPerFile\` cap of 700 counts CODE lines, so a file can appear here — raw \`wc -l\` — while sitting well under the cap.`,
].join("\n");

const mapMd = `# Structural map (generated)

Generated by \`scripts/gen-tree-map.mjs\` (\`bun run map\`) from \`git ls-files\` and the real module
graph. Not committed: every number here moves with every source change, so a committed copy made
any two PRs conflict. TREE.md holds the hand-written prose; this file holds the derived numbers.

## Scale

${headlineScale}

${scale}

## Module boundaries — packages/server/src

${subsystemTable}

## Largest files

${largestTable}

## Subsystem graph

${graphBlock}

## Fan-in / fan-out

${fanTable}
`;

// Machine-readable twin of the Mermaid diagram. The edge weights are already computed above for
// the diagram, which only renders pairs at or above MIN_EDGE_WEIGHT — this emits the FULL set, so
// a tool (or an agent) reading the graph is not limited to what happened to be legible in a
// picture. Sorted so the file is diffable and the drift check below is stable.
const OUT_DIR = "generated";
const MAP_MD = `${OUT_DIR}/tree-map.md`;
const GRAPH_JSON = `${OUT_DIR}/dependency-graph.json`;
const graphJson = `${JSON.stringify(
  {
    generatedBy: "scripts/gen-tree-map.mjs",
    note: "Generated — do not edit. Subsystem = first path segment under a package's src/; the whole plugin package is one subsystem (see TREE.md §7; narrative in generated/tree-map.md).",
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

const problems = committedGeneratedProblems({
  treeText: readFileSync("TREE.md", "utf8"),
  tracked: run("git", ["ls-files", "--", "TREE.md", "generated", "docs/dependency-graph.json"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean),
});
if (problems.length > 0) {
  console.error(
    `gen-tree-map: generated content is committed again:\n  - ${problems.join("\n  - ")}`,
  );
  process.exit(1);
}

if (CHECK) {
  // The generator ran to completion above (every refusal is a process.exit(1) before this point),
  // and nothing generated is committed. There is no committed copy to be stale against.
  console.log(
    `gen-tree-map: OK (${modules.length} modules, ${totalDeps} dependencies; nothing generated is committed)`,
  );
  process.exit(0);
}
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(MAP_MD, mapMd);
writeFileSync(GRAPH_JSON, graphJson);
console.log(
  `gen-tree-map: wrote ${MAP_MD} + ${GRAPH_JSON} (${modules.length} modules, ${totalDeps} dependencies)`,
);
