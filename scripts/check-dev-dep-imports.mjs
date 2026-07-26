#!/usr/bin/env node
/**
 * THE-593 — dev-dependency import gate (source-scan replacement for the vacuous
 * dependency-cruiser `not-to-dev-dep` rule).
 *
 * dependency-cruiser 18.1.0 cannot parse TypeScript 7 (root package.json pins `^7.0.2`): it
 * prints "Support for typescript@>=7 will follow when its API is published and stable" and falls
 * back to a degraded resolver that classifies every npm import as `['unknown']`, never
 * `['npm-dev']`. A `.dependency-cruiser.cjs` rule keyed on `dependencyTypes: ["npm-dev"]`
 * therefore matches nothing, ever — proven directly: a `src` file importing `vitest` (a
 * devDependency) produced `violations: [] error: 0`, exit 0. This script re-expresses the same
 * intent — shipped code must not import a devDependency, because it resolves locally and breaks
 * for anyone installing the published package — as a plain-text scan that does not depend on
 * dependency-cruiser's TypeScript support at all.
 *
 * SCOPE mirrors scripts/check-boundaries.mjs's SOURCE_GLOBS exactly (packages/server/src and
 * packages/shared/src), not the broader "packages, any package, src" the original rule's from.path
 * implied. That is deliberate: packages/plugin/src legitimately imports its own devDependency
 * `obsidian` — Obsidian plugins receive the real module from the host app at runtime and declare
 * the package only for its type definitions, the shape a peerDependency would have if
 * dependency-cruiser modelled one. check-boundaries.mjs never fed plugin/src to depcruise either,
 * for the same reason; this gate keeps that scope rather than inventing coverage (and a false
 * positive on every plugin build) that was never actually enforced. packages/native has no
 * TypeScript source to scan.
 *
 * A devDependency name is looked up per scope as (that workspace's own devDependencies) UNION
 * (the root devDependencies), matching how a bun/npm workspace install actually resolves it.
 *
 * Two floors, both a hard failure rather than a silent pass, per THE-544/THE-585's lesson that a
 * check which can pass by finding nothing is not a check:
 *   - zero source files matched  -> the glob broke, not that the codebase shrank to zero files.
 *   - zero devDependency names   -> a package.json read failed or workspaces moved.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Below this, assume the file list collapsed rather than that the codebase shrank. */
const MIN_EXPECTED_FILES = 100;

const ROOT_MANIFEST = "package.json";

/**
 * Each scope's `globs` is fed to `git ls-files` verbatim (already POSIX-separated, so this holds
 * on windows-latest too), and its `manifest` supplies the devDependency names specific to that
 * workspace, on top of the root manifest's.
 */
const SCOPES = [
  {
    globs: ["packages/server/src/*.ts", "packages/server/src/**/*.ts"],
    manifest: "packages/server/package.json",
  },
  {
    globs: ["packages/shared/src/*.ts", "packages/shared/src/**/*.ts"],
    manifest: "packages/shared/package.json",
  },
];

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readDevDependencyNames(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Object.keys(manifest.devDependencies ?? {});
}

/** A relative import, a subpath of the current package, or a node: builtin isn't an npm package. */
function packageNameOf(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

// Deliberately plain-text, not an AST walk: matches this repo's other source-scan gates
// (check-vault-leak.mjs, check-workflow-injection.mjs). Three shapes cover every way a module
// specifier string reaches the module graph:
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import ... from "x"; export ... from "x";
  /\brequire\(\s*["']([^"']+)["']\s*\)/g, // require("x")
  /\bimport\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
];

function findViolations(file, source, devDepNames) {
  const violations = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      const pkg = packageNameOf(specifier);
      if (pkg && devDepNames.has(pkg)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push({ file, line, specifier, pkg });
      }
    }
  }
  return violations;
}

const rootDevDepNames = new Set(readDevDependencyNames(ROOT_MANIFEST));

let totalFiles = 0;
const totalDevDepNames = new Set(rootDevDepNames);
const violations = [];

for (const scope of SCOPES) {
  const devDepNames = new Set([...rootDevDepNames, ...readDevDependencyNames(scope.manifest)]);
  for (const name of devDepNames) totalDevDepNames.add(name);

  const files = run("git", ["ls-files", ...scope.globs])
    .split("\n")
    .filter((f) => f && !f.endsWith(".test.ts"));
  totalFiles += files.length;

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    violations.push(...findViolations(file, source, devDepNames));
  }
}

if (totalFiles < MIN_EXPECTED_FILES) {
  console.error(
    `dev-dep-imports gate: only ${totalFiles} source file(s) matched (expected >= ${MIN_EXPECTED_FILES}).\n` +
      "This almost certainly means the glob or SCOPES list broke. Refusing to pass a check that\n" +
      "examined (near-)nothing.",
  );
  process.exit(1);
}

if (totalDevDepNames.size === 0) {
  console.error(
    "dev-dep-imports gate: zero devDependency names read from any manifest — refusing to report " +
      "success over a check that has nothing to look for.",
  );
  process.exit(1);
}

console.log(
  `dev-dep-imports gate: ${totalFiles} source file(s) scanned, ${totalDevDepNames.size} ` +
    `devDependency name(s) tracked, ${violations.length} violation(s)`,
);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  imports "${v.specifier}" (devDependency "${v.pkg}")`);
}

if (violations.length > 0) {
  console.error(
    "\ndev-dep-imports gate: shipped code under packages/*/src must not import a devDependency — " +
      "it resolves locally in this repo and fails for anyone installing the published package.",
  );
  process.exit(1);
}

process.exit(0);
