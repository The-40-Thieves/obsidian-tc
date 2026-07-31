#!/usr/bin/env node
/**
 * WP3.4 — facade parity gate, generalised from check-export-surface.mjs.
 *
 * Across 17 refactor slices, verification that a facade's public export surface survived a
 * refactor was ad-hoc shell and inline `node -e` written fresh each time. Those throwaway
 * checkers produced confident wrong answers five separate times: a `sed` that silently didn't
 * match (a gate was declared "proven" when nothing was tested), a hardcoded fixture path
 * (verified the wrong branch and passed), a range bounded at the wrong terminator (reported "no
 * external dependencies" when there were some, twice), and a `require` + top-level `await` crash.
 *
 * This script is the fix: one committed, tested checker that generalises check-export-surface.mjs
 * (hardcoded to packages/shared/src/config.schema.ts) to any facade the refactor produces. It
 * reuses check-export-surface.mjs's `parseExportedNames` rather than reimplementing the parser —
 * a second parser is exactly how these five bugs happened in the first place.
 *
 * Non-empty floor: refuses to compare a facade if its BASELINE parse yields fewer than
 * MIN_EXPORTS names — see check-boundaries.mjs's header for the shape of failure this guards
 * against (a gate that passes because it saw nothing is worse than no gate).
 *
 * Missing-file handling: a facade may be new (didn't exist at the baseline ref). That is not a
 * lost export surface, so it is skipped with a clear note rather than failing the gate.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseExportedNames } from "./check-export-surface.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASELINE_REF = "origin/main";
/** Below this, assume the baseline parse collapsed rather than that the facade shrank this far. */
const MIN_EXPORTS = 5;

// The facades this refactor produces. Add new facades here as later slices extract more of them.
export const DEFAULT_FACADES = [
  "packages/shared/src/config.schema.ts",
  "packages/server/src/tools/m7/knowledge-tools.ts",
  "packages/server/src/search/indexer.ts",
  "packages/server/src/mcp/registry.ts",
  "packages/plugin/src/routes.ts",
];

/** Reads `file` at `ref` via `git show`, or returns `{ missing: true }` if it doesn't exist there. */
export function readAtRef(ref, file, { cwd = ROOT } = {}) {
  try {
    return { source: execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", cwd }) };
  } catch (e) {
    return { missing: true, error: e?.message ?? String(e) };
  }
}

/**
 * Does `ref` resolve to a commit here? Checked ONCE before any comparison, because `readAtRef`
 * cannot tell "this file is new at a valid baseline" from "the baseline ref does not exist at all"
 * — both surface as a failed `git show`. Without this, an unfetched baseline (the default
 * `actions/checkout` fetch-depth is 1, which leaves no `origin/main`) makes EVERY facade report
 * "skipped, absent at <ref> (new facade)" and the gate exits 0 having compared nothing.
 *
 * check-export-surface.mjs, which this script generalises, already fails loudly in that case. That
 * property was lost in the generalisation; this restores it. Same reasoning as the non-empty floor
 * below — a gate that cannot see its baseline must say so, not pass.
 */
export function refResolves(ref, { cwd = ROOT } = {}) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * One facade's parity verdict, as a pure function of its baseline/current source text (or absence
 * thereof) — no filesystem or git access, so directly unit-testable.
 */
export function compareFacade({
  file,
  baselineSource,
  baselineMissing,
  currentSource,
  floor = MIN_EXPORTS,
}) {
  if (baselineMissing) {
    return { file, status: "skipped-new" };
  }
  const baselineNames = parseExportedNames(baselineSource);
  if (baselineNames.size < floor) {
    return { file, status: "floor", baselineCount: baselineNames.size, floor };
  }
  const currentNames = parseExportedNames(currentSource);
  const missing = [...baselineNames].filter((n) => !currentNames.has(n)).sort();
  return {
    file,
    status: missing.length > 0 ? "missing" : "ok",
    missing,
    baselineCount: baselineNames.size,
    currentCount: currentNames.size,
  };
}

/** Parses `--baseline <ref>` and one or more `--file <path>` flags. Unrecognised args are errors. */
export function parseArgs(argv) {
  let baseline = process.env.FACADE_PARITY_BASELINE_REF || DEFAULT_BASELINE_REF;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--baseline") {
      baseline = argv[++i];
      if (baseline === undefined) throw new Error("--baseline requires a value");
    } else if (arg === "--file") {
      const file = argv[++i];
      if (file === undefined) throw new Error("--file requires a value");
      files.push(file);
    } else {
      throw new Error(`unrecognised argument: ${arg}`);
    }
  }
  return { baseline, files: files.length > 0 ? files : [...DEFAULT_FACADES] };
}

function main() {
  let baseline, files;
  try {
    ({ baseline, files } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`facade-parity: ${e.message}`);
    process.exit(1);
    return;
  }

  if (!refResolves(baseline)) {
    console.error(
      `facade-parity: baseline ref "${baseline}" does not resolve to a commit here, so every ` +
        "facade would be reported as new and this gate would pass having compared nothing. " +
        "Fetch it first (in CI: `git fetch --no-tags --depth=1 origin " +
        "main:refs/remotes/origin/main`, or check out with fetch-depth: 0), or set " +
        "FACADE_PARITY_BASELINE_REF to a ref that exists.",
    );
    process.exit(1);
    return;
  }

  const results = files.map((file) => {
    const { source: baselineSource, missing: baselineMissing } = readAtRef(baseline, file);
    let currentSource;
    if (!baselineMissing) {
      currentSource = readFileSync(join(ROOT, file), "utf8");
    }
    return compareFacade({ file, baselineSource, baselineMissing, currentSource });
  });

  let failed = false;
  for (const result of results) {
    if (result.status === "skipped-new") {
      console.log(`facade-parity: ${result.file} — skipped, absent at "${baseline}" (new facade).`);
      continue;
    }
    if (result.status === "floor") {
      console.error(
        `facade-parity: ${result.file} — baseline "${baseline}" parsed to only ` +
          `${result.baselineCount} export(s), expected >= ${result.floor}. This almost certainly ` +
          "means the parse collapsed, not that the facade shrank that far. Refusing to compare.",
      );
      failed = true;
      continue;
    }
    if (result.status === "missing") {
      console.error(
        `facade-parity: ${result.file} — ${result.missing.length} name(s) exported at ` +
          `"${baseline}" are missing now:\n${result.missing.map((n) => `  ${n}`).join("\n")}`,
      );
      failed = true;
      continue;
    }
    console.log(
      `facade-parity: ${result.file} — ${result.currentCount} export(s) ` +
        `(${result.baselineCount} at "${baseline}"), none missing.`,
    );
  }

  process.exit(failed ? 1 : 0);
}

// Importing this module (as its test file does) must have no side effects — no git calls, no
// filesystem reads, no process.exit. Only run the gate when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
