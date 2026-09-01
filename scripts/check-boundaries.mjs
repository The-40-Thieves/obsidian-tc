#!/usr/bin/env node
/**
 * THE-525 — module boundary gate.
 *
 * Wraps dependency-cruiser for two reasons that matter more than convenience:
 *
 * 1. DIRECTORY SCANNING IS BROKEN ON THIS REPO. dependency-cruiser 18.x supports
 *    `typescript >=2.0.0 <7.0.0`; this repo is on TypeScript 7. Given a directory it enumerates
 *    zero `.ts` files and cheerfully reports "no dependency violations found (0 modules)". Given
 *    an explicit file list it works fine — 200+ modules, 690+ dependencies resolved. So the file
 *    list is not a style choice; without it the gate silently checks nothing.
 *
 * 2. THEREFORE: A ZERO-MODULE RESULT IS A FAILURE, NOT A PASS. That is the whole point of this
 *    wrapper. If a future TypeScript bump, a moved directory or a changed glob empties the input,
 *    this exits non-zero instead of reporting success over an empty set. A gate that passes
 *    because it saw nothing is worse than no gate, because it is trusted.
 *
 * Legacy violations live in .dependency-cruiser-known-violations.json and are ignored via
 * --ignore-known, so new rules could land green. That file should only ever shrink.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// `**/` requires at least one directory component, so it excludes top-level files (cli.ts,
// index.ts, ...) — a plain `*.ts` pattern is needed alongside it to also match those. Listing
// both (rather than relying on either alone) is the point: it documents that top-level files are
// a deliberate inclusion, not an accident of one pattern's reach. git ls-files dedupes the union.
const SOURCE_GLOBS = [
  "packages/server/src/*.ts",
  "packages/server/src/**/*.ts",
  "packages/shared/src/*.ts",
  "packages/shared/src/**/*.ts",
];
/** Below this, assume the input collapsed rather than that the codebase shrank. */
const MIN_EXPECTED_MODULES = 100;

// THE-544 — reachability gate.
//
// dependency-cruiser's `no-orphans` cannot catch a module that is dead but imports things: its
// predicate is "no dependents AND no dependencies". scheduler/job-queue.ts imports ../db/types and
// node:crypto, so it is not an orphan — yet nothing in src/ constructs it. That is how THE-517
// merged fully unwired, past 26 green checks, having already provisioned a `jobs` table.
//
// Reachability from declared entry points is the right predicate: a module that no entry point can
// transitively reach is not shipped, whatever its import list looks like.
const ROOTS = [
  "packages/server/src/cli.ts",
  "packages/server/src/index.ts",
  // Required, and not a workaround: server modules import the shared package by its published name
  // (@the-40-thieves/obsidian-tc-shared), which dependency-cruiser does not resolve back into
  // packages/shared/src/. Without this root every shared module reads as unreachable.
  "packages/shared/src/index.ts",
];

// Modules that are genuinely unreachable today and are TRACKED work, not accidents. Each entry
// must name its ticket. Anything unreachable and NOT listed here fails the gate — adding to this
// list has to be a deliberate act with a reason, which is the whole point.
//
// WP0.2 (2026-07-30-filesystem-backend-disposition-adr.md): this map's last entry,
// `packages/server/src/vault/backend.ts` (`FilesystemBackend`), was resolved by deletion rather
// than by wiring it in — the disposition ADR's evidence found zero production selection points and
// zero second implementations. Deleting the exemption along with the class is the point: this list
// stays empty until a genuinely new case earns its own entry.
const UNREACHABLE_ALLOWLIST = new Map([
  // THE-694/695 landed packages/server/src/search/acl_path_set.ts dark, ahead of its consumers, and
  // held an entry here until they existed. THE-852 wired it into buildGraphSearchOptions
  // (retrieval-runtime.ts's resolveAclWalkFilter), so it is reachable now — this comment is the
  // historical note the gate's own header asks for; the entry itself is gone.
  //
  // THE-635: point_in_time.ts held an entry here (a tested-but-unwired filter/flag primitive) until
  // this ticket wired filterChunksAsOf into candidateAssembly (search/graph_search_stages/
  // candidate_assembly.ts) behind knowledge_search's/vault_graph_search's new `as_of` argument. It
  // is reachable now — this comment is the historical note the gate's own header asks for; the
  // entry itself is gone. Same acl_path_set.ts precedent.
]);

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// execFileSync(shell:false) cannot invoke a package-manager shim like "npx"/"npx.cmd" — on Windows
// it throws ENOENT (this repo's earlier fix attempt), and even where the shim resolves it is one
// more process hop that can fail in its own platform-specific way (an external review reported
// EINVAL for the same underlying problem). The actual fix is to not go through npx at all: resolve
// dependency-cruiser's CLI script on disk and invoke it directly with `process.execPath` (the node
// binary itself), which needs no shell and no shim on any platform.
//
// dependency-cruiser 18.1.0 only exports "." from its package.json (-> src/main/index.mjs) — it
// exports NEITHER "bin/dependency-cruise.mjs" NOR "package.json". That means
// `createRequire(...).resolve("dependency-cruiser/bin/dependency-cruise.mjs")` throws
// ERR_PACKAGE_PATH_NOT_EXPORTED: the package is ESM-only and its exports map does not admit that
// path. The only resolvable entry point is the bare specifier itself, so this walks from there:
// resolve "." to find where the package lives, then step relative to the known bin/ layout.
// Verified empirically against the installed dependency-cruiser@18.1.0:
//   import.meta.resolve("dependency-cruiser")
//     -> file:///.../node_modules/.bun/dependency-cruiser@18.1.0/node_modules/dependency-cruiser/src/main/index.mjs
//   -> ../../bin/dependency-cruise.mjs from there exists on disk.
// Someone will be tempted to "simplify" this back to require.resolve() or a bare "npx" call —
// both are the bug this function exists to avoid re-introducing.
export function resolveDependencyCruiserCli(resolve = import.meta.resolve) {
  const entry = resolve("dependency-cruiser");
  const cli = fileURLToPath(new URL("../../bin/dependency-cruise.mjs", entry));
  if (!existsSync(cli)) {
    throw new Error(
      `boundary gate: dependency-cruiser CLI not found at ${cli} (resolved package entry: ${entry})`,
    );
  }
  return cli;
}

/** Builds the depcruise invocation. Side-effect-free so it is directly unit-testable. */
export function buildDependencyCruiserCommand(
  files,
  { execPath = process.execPath, cliPath = resolveDependencyCruiserCli() } = {},
) {
  return {
    command: execPath,
    args: [
      cliPath,
      ...files,
      "--config",
      ".dependency-cruiser.cjs",
      "--ignore-known",
      "--output-type",
      "json",
    ],
  };
}

/** dependency-cruiser's JSON report, from either the string or Buffer form execFileSync can return. */
export function parseDependencyCruiserReport(output) {
  return JSON.parse(typeof output === "string" ? output : output.toString("utf8"));
}

function main() {
  // GOTCHA guard (THE-664): shares gen-tree-map.mjs's stale-dist hazard — with packages/*/dist
  // present, depcruise resolves the shared package's bare specifier through its published
  // exports/main (dist) instead of the tsconfig `paths` mapping to src, producing a wrong-but-
  // internally-deterministic module/dependency count (measured: 287 modules / 1184 dependencies
  // clean vs 286 / 1089 with packages/shared/dist built). Refuse rather than report over it.
  const staleDistDirs = readdirSync("packages", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/${e.name}/dist`)
    .filter((p) => existsSync(p));

  if (staleDistDirs.length > 0) {
    console.error(
      `boundary gate: found built output at ${staleDistDirs.join(", ")} — depcruise resolves\n` +
        "workspace packages differently with dist/ present, producing a wrong-but-stable module\n" +
        "count (see scripts/gen-tree-map.mjs header). Refusing to report over it.\n" +
        `Remedy: rm -rf ${staleDistDirs.join(" ")} and re-run.`,
    );
    process.exit(1);
  }

  const files = run("git", ["ls-files", ...SOURCE_GLOBS])
    .split("\n")
    .filter(Boolean);
  if (files.length === 0) {
    console.error(
      "boundary gate: git ls-files matched no source files — refusing to report success",
    );
    process.exit(1);
  }

  const { command, args } = buildDependencyCruiserCommand(files);

  let report;
  try {
    report = parseDependencyCruiserReport(run(command, args));
  } catch (e) {
    // depcruise exits non-zero when it finds error-severity violations, and still prints the report
    // on stdout. Re-parse rather than treating a found violation as a crash.
    const out = e?.stdout;
    if (!out) {
      console.error("boundary gate: dependency-cruiser failed to produce a report");
      console.error(e?.stderr || e?.message || e);
      process.exit(1);
    }
    report = parseDependencyCruiserReport(out);
  }

  const { totalCruised = 0, totalDependenciesCruised = 0, violations = [] } = report.summary ?? {};

  if (totalCruised < MIN_EXPECTED_MODULES) {
    console.error(
      `boundary gate: only ${totalCruised} modules cruised (expected >= ${MIN_EXPECTED_MODULES}).\n` +
        "This almost certainly means the analyzer stopped seeing TypeScript — dependency-cruiser\n" +
        "supports typescript <7 and this repo is on 7.x, so a directory scan silently yields zero.\n" +
        "Refusing to pass a check that examined nothing.",
    );
    process.exit(1);
  }

  const errors = violations.filter((v) => v.rule.severity === "error");
  const warns = violations.filter((v) => v.rule.severity === "warn");

  console.log(
    `boundary gate: ${totalCruised} modules, ${totalDependenciesCruised} dependencies, ` +
      `${errors.length} error(s), ${warns.length} warning(s) (known violations ignored)`,
  );
  for (const v of [...errors, ...warns]) {
    console.log(`  ${v.rule.severity} ${v.rule.name}: ${v.from} -> ${v.to}`);
  }

  const bySource = new Map((report.modules ?? []).map((m) => [m.source, m]));
  const reachable = new Set();
  const queue = ROOTS.filter((r) => bySource.has(r));
  for (const missing of ROOTS.filter((r) => !bySource.has(r))) {
    console.error(
      `boundary gate: declared root ${missing} is not in the graph — check SOURCE_GLOBS`,
    );
    process.exit(1);
  }
  while (queue.length > 0) {
    const src = queue.pop();
    if (reachable.has(src)) continue;
    reachable.add(src);
    for (const d of bySource.get(src)?.dependencies ?? []) {
      if (!reachable.has(d.resolved) && bySource.has(d.resolved)) queue.push(d.resolved);
    }
  }

  // Only first-party source is subject to reachability; node_modules and core modules are not.
  const unreachable = [...bySource.keys()]
    .filter((s) => s.startsWith("packages/") && !reachable.has(s))
    .sort();
  const unexpected = unreachable.filter((s) => !UNREACHABLE_ALLOWLIST.has(s));
  const staleAllowlist = [...UNREACHABLE_ALLOWLIST.keys()].filter((s) => reachable.has(s));

  console.log(
    `boundary gate: ${reachable.size} modules reachable from ${ROOTS.length} roots, ` +
      `${unreachable.length} unreachable (${unexpected.length} unexpected)`,
  );
  for (const s of unreachable) {
    const why = UNREACHABLE_ALLOWLIST.get(s);
    console.log(why ? `  allowed  ${s}  (${why})` : `  UNWIRED  ${s}`);
  }
  // A module that became reachable must leave the allowlist, or the list rots into decoration.
  for (const s of staleAllowlist) {
    console.error(`boundary gate: ${s} is now reachable — remove it from UNREACHABLE_ALLOWLIST`);
  }

  if (unexpected.length > 0) {
    console.error(
      `\nboundary gate: ${unexpected.length} module(s) unreachable from any entry point.\n` +
        "Either wire them in, delete them, or add them to UNREACHABLE_ALLOWLIST with a ticket.",
    );
  }

  process.exit(errors.length > 0 || unexpected.length > 0 || staleAllowlist.length > 0 ? 1 : 0);
}

// Importing this module (as the test file does, to reach the exported functions) must have no
// side effects — no filesystem checks, no subprocess spawns, no process.exit. Only run the gate
// when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
