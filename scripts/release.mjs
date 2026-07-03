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

// Core version set; packages/plugin is bumped separately below — it now tracks the repo
// version in lockstep (decision 2026-07-02; see the block after server.json).
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

// packages/plugin rejoins the repo version lockstep (decision 2026-07-02): bump its Obsidian
// manifest + package.json, and add a `next -> minAppVersion` entry to versions.json (the
// community-store requirement). minAppVersion itself is unchanged.
for (const p of ["packages/plugin/package.json", "packages/plugin/manifest.json"]) {
  setVersion(p, (o) => {
    o.version = next;
  });
}
setVersion("packages/plugin/versions.json", (o) => {
  o[next] = readJson("packages/plugin/manifest.json").minAppVersion;
});

// Roll the CHANGELOG now that the JSON files are written: rename [Unreleased]
// -> [next] - date and prepend a fresh [Unreleased].
const rebuilt =
  cl.slice(0, at) +
  `## [Unreleased]\n\n## [${next}] - ${date}\n\n${body}\n` +
  (nextHeading === -1 ? "\n" : `\n${cl.slice(nextHeading + 1)}`);
writeFileSync("CHANGELOG.md", rebuilt);
console.log(`  rolled CHANGELOG -> [${next}] - ${date}`);

// Bump the "current version" prose in the docs that reference the shipped version literally — the
// README status badge/line and the docs-site current-release line + ghcr example tags. These are the
// only files that carry the version as prose (history lives in the CHANGELOG), so a scoped
// replace-all of the old version is safe. Recurrence fix: this prose drifted (1.3.2 vs the shipped
// 1.3.3) until swept by hand; check-version-coherence.mjs now also gates it.
for (const p of [
  "README.md",
  "packages/server/README.md",
  "docs/src/content/docs/index.md",
  "docs/src/content/docs/getting-started/install.md",
  "docs/src/content/docs/getting-started/first-run.md",
]) {
  const target = inRepo(p);
  const before = readFileSync(target, "utf8");
  const after = before.split(current).join(next);
  if (after !== before) {
    writeFileSync(target, after);
    console.log(`  version prose bumped in ${p}`);
  }
}

// Refresh the lockfile for the workspace version bump (the step that broke 1.2.1).
console.log("bun install (refresh bun.lock) ...");
execSync("bun install", { stdio: "inherit" });

// Normalize formatting of the freshly bumped files so the release commit never carries biome drift
// (THE-301). Runs after the writes + lockfile refresh; biome formats the JSON/CHANGELOG in place.
console.log("bun run format (biome) ...");
execSync("bun run format", { stdio: "inherit" });

// Coherence gate.
execSync("node scripts/check-version-coherence.mjs", { stdio: "inherit" });

console.log(
  `\nstaged ${next}. next: commit on a branch, open a PR, review, merge, then a human pushes tag v${next}.`,
);
