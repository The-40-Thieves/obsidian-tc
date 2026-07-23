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

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const files = run("git", ["ls-files", ...SOURCE_GLOBS])
  .split("\n")
  .filter(Boolean);
if (files.length === 0) {
  console.error("boundary gate: git ls-files matched no source files — refusing to report success");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(
    run("npx", [
      "depcruise",
      ...files,
      "--config",
      ".dependency-cruiser.cjs",
      "--ignore-known",
      "--output-type",
      "json",
    ]),
  );
} catch (e) {
  // depcruise exits non-zero when it finds error-severity violations, and still prints the report
  // on stdout. Re-parse rather than treating a found violation as a crash.
  const out = e?.stdout;
  if (!out) {
    console.error("boundary gate: dependency-cruiser failed to produce a report");
    console.error(e?.stderr || e?.message || e);
    process.exit(1);
  }
  report = JSON.parse(out);
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
const UNREACHABLE_ALLOWLIST = new Map([
  [
    "packages/server/src/scheduler/job-queue.ts",
    "THE-517 — durable queue, not yet wired to a workload",
  ],
  [
    "packages/server/src/search/multi_query.ts",
    "THE-448 — fan-out engine, tool surface is a follow-up",
  ],
  ["packages/server/src/util/concurrency.ts", "THE-448 — exists only to serve multi_query.ts"],
  ["packages/server/src/vault/backend.ts", "FilesystemBackend — tested, never constructed in src/"],
]);

const bySource = new Map((report.modules ?? []).map((m) => [m.source, m]));
const reachable = new Set();
const queue = ROOTS.filter((r) => bySource.has(r));
for (const missing of ROOTS.filter((r) => !bySource.has(r))) {
  console.error(`boundary gate: declared root ${missing} is not in the graph — check SOURCE_GLOBS`);
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
