// Guard for the Obsidian community-directory scanner (obsidianmd/obsidian-workflows, src/lint.ts).
//
// The scanner runs eslint from the REPO ROOT. With a root `tsconfig.json` it takes the typed
// branch (typescript-eslint `projectService`); without one it takes the untyped branch, which
// crashes on `@typescript-eslint/await-thenable requires type information` (exit 2, no JSON) and
// is reported as `scanner-eslint-execution-failed`. The typed branch in turn raises a fatal parse
// error for every linted file that no `tsconfig.json` owns: the project service only discovers
// files NAMED `tsconfig.json` (not tsconfig.eval.json / tsconfig.bun-smoke.json), walking up from
// the file's directory, and a file counts as owned when it is in that project's program.
//
// This test replays that ownership rule for every tracked file the scanner would lint, so a new
// directory of TS/JS that no tsconfig.json reaches fails here instead of on the scorecard.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, matchesGlob, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "lib", "tsc.js");

// Verbatim from obsidian-workflows v1.2.3 src/lint.ts SCANNER_STYLELINT_CONFIG.ignoreFiles, which
// buildScannerEslintConfig also uses as its eslint `globalIgnores`. Re-check on a scanner bump.
const SCANNER_IGNORES = [
  "node_modules",
  "dist",
  "build",
  "pkg",
  "test-vault",
  ".obsidian",
  "**/.obsidian/**",
  "esbuild.config.mjs",
  "version-bump.mjs",
  "**/*.test.*",
  "**/*.tests.*",
  "**/*.spec.*",
  "**/*.specs.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/mocks/**",
  "**/__mocks__/**",
  "**/*.cjs",
  "**/*.mjs",
  "**/*.cts",
  "**/*.mts",
  "**/vite*",
  "**/scripts/**",
  "**/docs/**",
  "**/i18n/**",
  "**/i18next/**",
  "**/locale/**",
  "**/locales/**",
  "**/translations/**",
  "**/l10n/**",
  ".pnpm-store",
  "**/*.spec.ts",
  "**/testUtils**",
  "automation/**",
  "e2e-tests/**",
];

/** The scanner's own file-type filter: the `files` globs of its typed config. */
const LINTED_EXTENSION = /\.(ts|tsx|js|jsx)$/;

/** eslint flat-config ignore semantics: a bare name is a root-level file or directory prefix. */
export function isScannerIgnored(rel) {
  return SCANNER_IGNORES.some((pattern) =>
    /[*?]/.test(pattern)
      ? matchesGlob(rel, pattern)
      : rel === pattern || rel.startsWith(`${pattern}/`),
  );
}

function trackedLintableFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter((rel) => rel && LINTED_EXTENSION.test(rel) && !isScannerIgnored(rel));
}

const programCache = new Map();

/** Repo-relative files in the program of `<dir>/tsconfig.json` (tsc exits non-zero on type errors
 *  such as an uninstalled optional package; the listing is still printed, so the status is not
 *  what we are asking). */
function programFiles(dir) {
  const cached = programCache.get(dir);
  if (cached) return cached;
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [TSC, "-p", join(ROOT, dir, "tsconfig.json"), "--listFilesOnly"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    stdout = err.stdout ?? "";
  }
  const prefix = `${ROOT.replaceAll("\\", "/")}/`;
  const files = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.replaceAll("\\", "/"))
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length)),
  );
  programCache.set(dir, files);
  return files;
}

/** The directory of the nearest ancestor `tsconfig.json` whose program contains `rel`, or null. */
export function owningProject(rel) {
  const parts = rel.split("/");
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    if (!existsSync(join(ROOT, dir, "tsconfig.json"))) continue;
    if (programFiles(dir).has(rel)) return dir === "" ? "(root)" : dir;
  }
  return null;
}

test("a root tsconfig.json exists, so the scanner takes its typed branch", () => {
  assert.ok(
    existsSync(join(ROOT, "tsconfig.json")),
    "without a root tsconfig.json the scanner runs untyped and crashes (scanner-eslint-execution-failed)",
  );
});

test("every tracked file the scanner lints is owned by a tsconfig.json project", () => {
  const files = trackedLintableFiles();
  // Floor: an empty or tiny set would pass vacuously (git unavailable, ignore glob swallowing all).
  assert.ok(files.length > 100, `only ${files.length} lintable files found; the filter is broken`);
  const orphans = files.filter((rel) => owningProject(rel) === null);
  assert.deepEqual(
    orphans,
    [],
    `${orphans.length} file(s) the scanner lints are in no tsconfig.json project (typescript-eslint ` +
      "reports each as a fatal parse error). Add them to the root tsconfig.json `include`.",
  );
});

test("the root project is what owns the files no package tsconfig.json reaches", () => {
  // Known members that only the root project covers (incident: eval harness + native fallback .js).
  assert.equal(owningProject("packages/server/eval/compare.ts"), "(root)");
  assert.equal(owningProject("packages/native/fallback.js"), "(root)");
  assert.equal(owningProject("packages/native/index.js"), "(root)");
});

test("ownership resolves to the package project for ordinary source (the root does not shadow it)", () => {
  assert.equal(owningProject("packages/server/src/acl.ts"), "packages/server");
  assert.equal(owningProject("packages/plugin/src/routes/files.ts"), "packages/plugin");
});

test("scanner ignore emulation: tests, scripts and .mjs are skipped; package source is not", () => {
  assert.equal(isScannerIgnored("packages/server/test/x.ts"), true);
  assert.equal(isScannerIgnored("packages/native/scripts/x.js"), true);
  assert.equal(isScannerIgnored("scripts/check-x.mjs"), true);
  assert.equal(isScannerIgnored("packages/server/src/foo.test.ts"), true);
  assert.equal(isScannerIgnored("packages/server/eval/metrics.ts"), false);
  assert.equal(isScannerIgnored("packages/native/fallback.js"), false);
});
