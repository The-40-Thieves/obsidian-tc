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

const SOURCE_GLOBS = ["packages/server/src/**/*.ts", "packages/shared/src/**/*.ts"];
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

process.exit(errors.length > 0 ? 1 : 0);
