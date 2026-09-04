#!/usr/bin/env node
// check-bun-version-coherence (THE-947) — mise.toml is the pin's source of truth
// (`bun = "1.4.0"` under [tools]), and `package.json`'s `packageManager` plus
// `.github/actions/setup-repo/action.yml`'s `bun-version` default are supposed to track it. But
// seven `oven-sh/setup-bun` steps across `.github/workflows` call the action DIRECTLY with a
// hardcoded `bun-version:` literal instead of going through setup-repo, so bumping the pin
// (THE-946, mise.toml + package.json + setup-repo's default -> 1.4.0) silently left those steps
// on the old 1.3.14 — the build matrix, native builds, install smoke and perf baseline all ran a
// different Bun than the one every other job used.
//
// This gate reads the pin from mise.toml, then asserts every other declared Bun version agrees:
// package.json's packageManager, setup-repo's default, and every literal `bun-version:` value
// under .github/workflows and .github/actions (composite actions included — actionlint's own
// coverage gap for those is check-actions-shellcheck.mjs's territory, not a reason to skip them
// here). `${{ inputs.bun-version }}`-style references are not literals and are skipped; they
// resolve to whatever the caller passed, which is itself a checked literal somewhere else.
//
// Existence floor: a scan that finds zero workflow/action files, or finds files but zero literal
// `bun-version:` occurrences in them, is reported as a broken scanner — not a clean repo. Without
// this floor a renamed directory or a reworded key would make the gate pass by finding nothing to
// check, exactly the failure mode THE-580 already fixed once for check-version-coherence.mjs's
// tool-count anchors.
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(".");

const readText = (p) => {
  const target = resolve(ROOT, p);
  if (relative(ROOT, target).startsWith("..")) {
    throw new Error(`refusing to read outside repo root: ${p}`);
  }
  return readFileSync(target, "utf8");
};

/** Parses `bun = "1.4.0"` out of mise.toml's [tools] table. Returns null if absent. */
export function readMiseBunPin(text) {
  const m = text.match(/^\s*bun\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/**
 * Parses setup-repo/action.yml's `inputs.bun-version.default`. Line-based on purpose (see
 * check-actions-shellcheck.mjs's header) — this repo's convention is to avoid a YAML-parser
 * dependency for extractions this targeted. Finds the bare `bun-version:` input key, then the
 * next `default:` line before another input key starts.
 */
export function readSetupRepoDefault(text) {
  const lines = text.split("\n");
  const keyLine = lines.findIndex((l) => /^\s*bun-version:\s*$/.test(l));
  if (keyLine === -1) return null;
  for (let i = keyLine + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at the next sibling input key (same or shallower indent, ending in ':' alone).
    if (i > keyLine + 1 && /^\s{0,2}\S[^:]*:\s*$/.test(line)) break;
    const m = line.match(/^\s*default:\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Extracts every literal `bun-version: X.Y.Z` occurrence from one file's text — quoted or bare,
 * one per line. Skips the bare key form (`bun-version:` with nothing after it, e.g. an `inputs:`
 * declaration) and template expressions (`${{ inputs.bun-version }}`), neither of which is a
 * literal this gate can check. Pure and filesystem-free so it is directly testable.
 */
export function findBunVersionOccurrences(text, filePath) {
  const occurrences = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(/\bbun-version:\s*(.+?)\s*$/);
    if (!m) return;
    const raw = m[1];
    const vm = raw.match(/^['"]?(\d+\.\d+\.\d+)['"]?$/);
    if (!vm) return;
    occurrences.push({ file: filePath, line: i + 1, value: vm[1] });
  });
  return occurrences;
}

/**
 * Pure check, injectable so it is testable without a filesystem (mirrors check-mcp-name.mjs's
 * shape). `occurrences` is every literal `bun-version:` found under .github/workflows and
 * .github/actions; `filesScanned` is how many files were scanned to produce it. Returns a list of
 * problem strings; an empty list means the gate passes.
 */
export function bunVersionProblems({
  pin,
  packageManager,
  setupRepoDefault,
  occurrences,
  filesScanned,
}) {
  const problems = [];
  if (!pin) {
    problems.push('mise.toml has no `bun = "..."` pin under [tools] — nothing to check against.');
    return problems;
  }

  const expectedPackageManager = `bun@${pin}`;
  if (packageManager !== expectedPackageManager) {
    problems.push(
      `package.json's packageManager is "${packageManager ?? "(missing)"}", expected ` +
        `"${expectedPackageManager}" to match mise.toml's bun pin.`,
    );
  }

  if (setupRepoDefault !== pin) {
    problems.push(
      `.github/actions/setup-repo/action.yml's bun-version default is ` +
        `"${setupRepoDefault ?? "(missing)"}", expected "${pin}".`,
    );
  }

  if (filesScanned === 0) {
    problems.push(
      "scanned zero files under .github/workflows and .github/actions — the scanner is broken, " +
        "not the repo clean.",
    );
  } else if (occurrences.length === 0) {
    problems.push(
      `scanned ${filesScanned} file(s) under .github/workflows and .github/actions but found ` +
        "zero literal `bun-version:` occurrences — the scanner is broken, not the repo clean.",
    );
  } else {
    for (const occ of occurrences) {
      if (occ.value !== pin) {
        problems.push(`${occ.file}:${occ.line}: bun-version is "${occ.value}", expected "${pin}".`);
      }
    }
  }

  return problems;
}

function listFilesRecursive(dir) {
  let entries;
  try {
    entries = readdirSync(resolve(ROOT, dir), { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(ROOT, resolve(e.parentPath, e.name)));
}

function main() {
  const pin = readMiseBunPin(readText("mise.toml"));
  const pkg = JSON.parse(readText("package.json"));
  const setupRepoDefault = readSetupRepoDefault(readText(".github/actions/setup-repo/action.yml"));

  const files = [
    ...listFilesRecursive(".github/workflows"),
    ...listFilesRecursive(".github/actions"),
  ];
  const occurrences = files.flatMap((f) => findBunVersionOccurrences(readText(f), f));

  const problems = bunVersionProblems({
    pin,
    packageManager: pkg.packageManager,
    setupRepoDefault,
    occurrences,
    filesScanned: files.length,
  });

  if (problems.length > 0) {
    console.error("check-bun-version-coherence: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-bun-version-coherence: OK — bun@${pin} agrees across mise.toml, package.json, ` +
      `setup-repo, and ${occurrences.length} workflow/action occurrence(s) across ${files.length} file(s).`,
  );
}

// Importing this module (as its test file does) must have no side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
