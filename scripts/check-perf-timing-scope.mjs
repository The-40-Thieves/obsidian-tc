#!/usr/bin/env node
/**
 * THE-594 — perf timing-scope gate (source-scan regression guard).
 *
 * `packages/server/eval/perf/contention.ts` exports the harness's real-timing primitives:
 * `calibrate()` (CPU busy-loop) and `calibrateIo()` (write+fsync loop), plus
 * `measureIoScalingRho()`, which samples `calibrateIo()` at ten sizes and computes a rank
 * correlation. All three measure genuine wall-clock work.
 *
 * Twice now (THE-584, then THE-594) a magnitude comparison built on `calibrateIo()` and living in
 * `packages/server/test/` -- which runs on three OSes, on shared runners, with no subprocess
 * isolation and no contention detection -- flaked in CI: first on macOS, then (after a careful
 * statistical recalibration) on windows-latest too. The fix both times was to relocate the
 * assertion into the perf harness (`eval/perf/`), which already provides isolation, median-of-N
 * gating and contention detection (see `eval/perf/README.md`'s "Timing assertions belong here, not
 * in `test/`"). This script does not re-derive that judgement call for a new file -- it enforces
 * the narrow, mechanical half of it: a NEW import of these primitives into `test/` must be an
 * explicit, reviewed exception (added to ALLOWLIST below), not a silent reintroduction of the same
 * bug class.
 *
 * This is deliberately NARROW, not a general "no wall-clock assertions in test/" checker: it can
 * only see imports of these three specific names. A brand-new `performance.now()` diff compared
 * via a raw `toBeLessThan` would not be caught here -- that class is caught by review against the
 * README section referenced above, not by tooling (see that section's closing paragraph).
 *
 * Floor check, per this repo's other source-scan gates (check-boundaries.mjs,
 * check-dev-dep-imports.mjs): finding zero test files means the glob broke, not that the test
 * suite shrank to nothing, and must FAIL rather than read as a clean scan.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MIN_EXPECTED_TEST_FILES = 50;

/** The real-timing primitives this gate restricts. */
const RESTRICTED_NAMES = new Set(["calibrate", "calibrateIo", "measureIoScalingRho"]);

/** Modules a restricted name may be imported from -- both the source module and its `.js`-suffixed
 *  form (this repo's TS emits/import specifiers are extensionless in source, but keeping both
 *  guards against a future move to NodeNext-style extensioned specifiers). */
const RESTRICTED_MODULE_SUFFIXES = ["eval/perf/contention"];

/**
 * file -> the restricted names it is allowed to import.
 *
 * Each entry here is a reviewed exception, not a default. Adding a name to an existing file's list
 * (or a new file to this map) should come with the same justification a wall-clock assertion in
 * `test/` always needs: why this specific use cannot flake the way the ones THE-584/THE-594 fixed
 * did (see eval/perf/README.md). Both current entries call the primitive exactly ONCE per test and
 * assert only `> 0` / `Number.isFinite` -- not a magnitude comparison BETWEEN two real
 * measurements, which is the actual failure mode this gate exists to keep out.
 */
const ALLOWLIST = new Map([
  ["packages/server/test/perf-contention.test.ts", new Set(["calibrate"])],
  ["packages/server/test/perf-contention-io.test.ts", new Set(["calibrateIo"])],
]);

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// Deliberately plain-text, matching this repo's other source-scan gates rather than an AST walk.
const IMPORT_PATTERN = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)[^;]*/g;

function isRestrictedModule(specifier) {
  return RESTRICTED_MODULE_SUFFIXES.some((suffix) => specifier.endsWith(suffix));
}

function namedImports(clause) {
  return clause
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+as\s+/)[0]?.trim())
    .filter((s) => Boolean(s));
}

const files = run("git", ["ls-files", "packages/server/test/*.test.ts"])
  .split("\n")
  .filter(Boolean);

if (files.length < MIN_EXPECTED_TEST_FILES) {
  console.error(
    `perf-timing-scope gate: only ${files.length} test file(s) matched (expected >= ${MIN_EXPECTED_TEST_FILES}).\n` +
      "This almost certainly means the glob broke. Refusing to pass a check that examined (near-)nothing.",
  );
  process.exit(1);
}

const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const allowed = ALLOWLIST.get(file) ?? new Set();

  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const [, clause, specifier] = match;
    if (!isRestrictedModule(specifier)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    for (const name of namedImports(clause ?? "")) {
      if (!RESTRICTED_NAMES.has(name)) continue;
      if (allowed.has(name)) continue;
      violations.push({ file, line, name, specifier });
    }
  }

  // `await import("../eval/perf/contention")` (perf-contention-io.test.ts's fresh-module-cache
  // fsync-spy test) destructures dynamically rather than via a static import clause. The dynamic
  // form is flagged wholesale rather than parsed for names -- it is rare enough in this codebase
  // that a reviewer reading the diff is the right amount of friction, and the one existing use is
  // explicitly allowlisted below by file path alone.
  const dynamicAllowlist = new Set(["packages/server/test/perf-contention-io.test.ts"]);
  for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    const specifier = match[1];
    if (!specifier || !isRestrictedModule(specifier)) continue;
    if (dynamicAllowlist.has(file)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push({ file, line, name: "(dynamic import)", specifier });
  }
}

console.log(
  `perf-timing-scope gate: ${files.length} test file(s) scanned, ${violations.length} violation(s)`,
);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  imports "${v.name}" from "${v.specifier}"`);
}

if (violations.length > 0) {
  console.error(
    "\nperf-timing-scope gate: a real-timing primitive (calibrate/calibrateIo/measureIoScalingRho) " +
      "was imported into packages/server/test/ outside the reviewed allowlist in " +
      "scripts/check-perf-timing-scope.mjs. Wall-clock assertions belong in eval/perf/ (isolated, " +
      "median-of-N gated, contention-checked), not the unit suite, which runs on three OSes with " +
      'no isolation -- see eval/perf/README.md\'s "Timing assertions belong here, not in `test/`" ' +
      "(THE-584/THE-594). If this use genuinely cannot flake that way, add it to ALLOWLIST with a " +
      "one-line justification.",
  );
  process.exit(1);
}

process.exit(0);
