#!/usr/bin/env node
import { execSync } from "node:child_process";
// Single-source release prep (THE-256 Phase 1).
// Usage: bun scripts/release.mjs <patch|minor|major|x.y.z>
// Sets the version across every package.json + distribution file, refreshes
// bun.lock, rolls the CHANGELOG, and runs the coherence gate. Does NOT commit,
// push, or tag — branch + PR + review + human tag stay manual by design.
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

// Every path below is a hardcoded repo-relative metadata file; this guard keeps
// the reads/writes provably contained to the repo root (defense in depth).
const ROOT = resolve(".");
const inRepo = (p) => {
  const base = resolve(ROOT);
  const target = resolve(base, p);
  // relative() expresses any escape (absolute paths included) as a "../" prefix.
  if (relative(base, target).startsWith("..")) {
    throw new Error(`refusing to touch path outside repo root: ${p}`);
  }
  return target;
};
const readJson = (p) => JSON.parse(readFileSync(inRepo(p), "utf8"));

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun scripts/release.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const bump = (v, kind) => {
  const [a, b, c] = v.split(".").map(Number);
  if (kind === "major") return `${a + 1}.0.0`;
  if (kind === "minor") return `${a}.${b + 1}.0`;
  if (kind === "patch") return `${a}.${b}.${c + 1}`;
  throw new Error(`unknown bump kind: ${kind}`);
};

const current = readJson("packages/server/package.json").version;
const next = SEMVER.test(arg) ? arg : bump(current, arg);
if (!SEMVER.test(next)) {
  console.error(`computed version is not semver: ${next}`);
  process.exit(1);
}
console.log(`release: ${current} -> ${next}`);

const setVersion = (path, mutate) => {
  const target = inRepo(path);
  const obj = JSON.parse(readFileSync(target, "utf8"));
  mutate(obj);
  writeFileSync(target, `${JSON.stringify(obj, null, 2)}\n`);
  console.log(`  set ${path}`);
};

// CHANGELOG: validate up front, before any file is mutated, so a bad
// [Unreleased] state can't leave the working tree partially written.
// Fail if [Unreleased] is missing or has no notes (no silent version).
const date = new Date().toISOString().slice(0, 10);
const cl = readFileSync("CHANGELOG.md", "utf8");
const marker = "## [Unreleased]";
const at = cl.indexOf(marker);
if (at === -1) {
  console.error("CHANGELOG.md has no [Unreleased] section.");
  process.exit(1);
}
const afterMarker = at + marker.length;
const nextHeading = cl.indexOf("\n## [", afterMarker);
const body = (
  nextHeading === -1 ? cl.slice(afterMarker) : cl.slice(afterMarker, nextHeading)
).trim();
if (!body) {
  console.error("CHANGELOG [Unreleased] is empty; add release notes before releasing.");
  process.exit(1);
}

// packages/plugin is intentionally omitted: the Obsidian companion plugin is
// released on its own cadence (see scripts/check-version-coherence.mjs).
for (const p of [
  "package.json",
  "packages/server/package.json",
  "packages/native/package.json",
  "packages/shared/package.json",
  "manifest.json",
]) {
  setVersion(p, (o) => {
    o.version = next;
  });
}
setVersion("server.json", (o) => {
  o.version = next;
  if (Array.isArray(o.packages)) for (const pkg of o.packages) pkg.version = next;
});

// Roll the CHANGELOG now that the JSON files are written: rename [Unreleased]
// -> [next] - date and prepend a fresh [Unreleased].
const rebuilt =
  cl.slice(0, at) +
  `## [Unreleased]\n\n## [${next}] - ${date}\n\n${body}\n` +
  (nextHeading === -1 ? "\n" : `\n${cl.slice(nextHeading + 1)}`);
writeFileSync("CHANGELOG.md", rebuilt);
console.log(`  rolled CHANGELOG -> [${next}] - ${date}`);

// Refresh the lockfile for the workspace version bump (the step that broke 1.2.1).
console.log("bun install (refresh bun.lock) ...");
execSync("bun install", { stdio: "inherit" });

// Coherence gate.
execSync("node scripts/check-version-coherence.mjs", { stdio: "inherit" });

console.log(
  `\nstaged ${next}. next: commit on a branch, open a PR, review, merge, then a human pushes tag v${next}.`,
);
