#!/usr/bin/env node
/**
 * WP1.8 — export-surface gate for packages/shared/src/config.schema.ts.
 *
 * WP1.1-1.8 moved every schema DEFINITION out of config.schema.ts into
 * packages/shared/src/config/*.schema.ts, leaving it a pure re-export facade. The one thing an
 * incremental extraction can silently drop is a re-export itself: the facade still parses and
 * still exports *something* after a slice, so typecheck/lint do not by themselves prove nothing
 * fell off the re-export list — only a consumer of the exact dropped name would notice, and only
 * if it happens to exercise that import. This gate diffs the facade's exported NAME SET against a
 * baseline ref and fails if any name present at the baseline is missing now.
 *
 * It deliberately does NOT fail on additions — growing the surface is normal, expected work.
 *
 * Parses two shapes:
 *   1. A name DEFINED in this file: `export const X`, `export type X = ...`, `export function
 *      X(...)`, `export class X`, `export interface X`, `export enum X`.
 *   2. The contents of `export { A, B, ... }` and `export type { A, B, ... }` re-export lists.
 * A checker that only matched shape 2's bare `export {` form would misreport every name inside an
 * `export type { ... }` list as "missing" — that has already happened once — so both forms are
 * parsed explicitly, and check-export-surface.test.mjs pins that `export type { ... }` contents
 * parse correctly.
 *
 * Non-empty floor: refuses to compare if the BASELINE side parses to fewer than MIN_EXPORTS names.
 * A gate that silently parses zero and reports "nothing missing" is worse than no gate at all —
 * see check-boundaries.mjs's header for the shape of failure this guards against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_FILE = "packages/shared/src/config.schema.ts";
const DEFAULT_BASELINE_REF = "origin/main";
/** Below this, assume the baseline parse collapsed rather than that the facade shrank this far. */
const MIN_EXPORTS = 30;

// A DEFINED export. Deliberately excludes `export type {` (a re-export list, handled by
// REEXPORT_BLOCK below) — `\{` can never satisfy the `[A-Za-z_$]` this pattern requires
// immediately after the keyword and whitespace, so the two patterns partition cleanly.
const DECL =
  /^export\s+(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

// Both `export { ... }` and `export type { ... }` re-export blocks. Non-greedy `[^}]*` is safe
// here because this codebase's style never nests a `{}` inside one of these lists (one name per
// line, optional `as` alias, optional leading `type`) — a nested brace would need a different
// parser, not a bigger version of this one.
const REEXPORT_BLOCK = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;

/** Every name TARGET_FILE's source actually exports: declarations plus re-export list contents. */
export function parseExportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(DECL)) names.add(m[1]);
  for (const m of source.matchAll(REEXPORT_BLOCK)) {
    for (const raw of m[1].split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      // `export { A as B }` exports B, not A; `export type { A }` / `export { A }` export A.
      const aliased = entry.match(/^(?:type\s+)?[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/);
      const plain = entry.match(/^(?:type\s+)?([A-Za-z_$][\w$]*)$/);
      if (aliased) names.add(aliased[1]);
      else if (plain) names.add(plain[1]);
    }
  }
  return names;
}

/** Names present in `baselineNames` but absent from `currentNames`, sorted for stable output. */
export function findMissing(baselineNames, currentNames) {
  return [...baselineNames].filter((n) => !currentNames.has(n)).sort();
}

/**
 * The gate's decision, as a pure function of the two file contents — no filesystem or git access,
 * so it is directly unit-testable. `floor` defaults to MIN_EXPORTS; tests override it to exercise
 * the floor without needing a 30-export fixture.
 */
export function evaluate({ baselineSource, currentSource, floor = MIN_EXPORTS }) {
  const baselineNames = parseExportedNames(baselineSource);
  if (baselineNames.size < floor) {
    return { status: "floor", baselineCount: baselineNames.size, floor };
  }
  const currentNames = parseExportedNames(currentSource);
  const missing = findMissing(baselineNames, currentNames);
  return {
    status: missing.length > 0 ? "missing" : "ok",
    missing,
    baselineCount: baselineNames.size,
    currentCount: currentNames.size,
  };
}

function main() {
  const ref = process.env.EXPORT_SURFACE_BASELINE_REF || DEFAULT_BASELINE_REF;

  let baselineSource;
  try {
    baselineSource = execFileSync("git", ["show", `${ref}:${TARGET_FILE}`], {
      encoding: "utf8",
      cwd: ROOT,
    });
  } catch (e) {
    console.error(
      `export-surface: could not read ${TARGET_FILE} at "${ref}" (${e?.message ?? e}).\n` +
        `Set EXPORT_SURFACE_BASELINE_REF to a ref that has this file, or fetch "${ref}" first.`,
    );
    process.exit(1);
    return;
  }

  const currentSource = readFileSync(join(ROOT, TARGET_FILE), "utf8");
  const result = evaluate({ baselineSource, currentSource });

  if (result.status === "floor") {
    console.error(
      `export-surface: baseline "${ref}:${TARGET_FILE}" parsed to only ${result.baselineCount} ` +
        `export(s), expected >= ${result.floor}. This almost certainly means the parse collapsed, ` +
        "not that the facade shrank that far. Refusing to compare against a floor this low.",
    );
    process.exit(1);
    return;
  }

  if (result.status === "missing") {
    console.error(
      `export-surface: ${result.missing.length} name(s) exported at "${ref}" are missing from ` +
        `${TARGET_FILE} now:\n${result.missing.map((n) => `  ${n}`).join("\n")}`,
    );
    process.exit(1);
    return;
  }

  console.log(
    `export-surface: ${TARGET_FILE} exports ${result.currentCount} name(s) ` +
      `(${result.baselineCount} at "${ref}"), none missing.`,
  );
}

// Importing this module (as its test file does, to reach the exported functions) must have no
// side effects — no git calls, no filesystem reads, no process.exit. Only run the gate when this
// file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
