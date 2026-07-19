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

// tsc gate (THE-426): run the type-checker BEFORE mutating anything, so a narrowing/type error
// that vitest+esbuild accept can never reach a published tag. CI runs tsc --noEmit; this makes the
// same check a hard local pre-release gate. Fails fast (execSync throws on non-zero) so a broken
// build never starts a release.
console.log("tsc gate (THE-426): shared build + server typecheck ...");
execSync("bun run build", { stdio: "inherit", cwd: inRepo("packages/shared") });
execSync("bun run typecheck", { stdio: "inherit", cwd: inRepo("packages/server") });

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

// Completeness gate. release.mjs only RENAMES [Unreleased] -> [next]; it does not generate notes.
// A PR that never wrote an entry is silently dropped from the release notes and nothing catches it.
// v1.10.0 nearly shipped documenting 1 of 5 changes, omitting #270 — the packaging fix that was the
// REASON for the release. Assert every user-visible PR in the range is cited in [Unreleased].
// Runs UP FRONT with the other CHANGELOG validation so a miss never leaves the tree half-written
// (the prose-drift bug failed mid-cut with every version file already rewritten).
//
// NOTE: no `^{commit}` peel anywhere below. execSync goes through cmd.exe on Windows, where `^` is
// the escape character, so `v1.2.3^{commit}` silently becomes `v1.2.3{commit}`, the lookup throws,
// and the gate SKIPS ITSELF. git peels annotated tags for rev-parse/merge-base on its own.
const prevTag = `v${current}`;
let haveTag = true;
try {
  execSync(`git rev-parse -q --verify refs/tags/${prevTag}`, { stdio: "ignore" });
} catch {
  console.log(`  (no ${prevTag} tag locally - skipping CHANGELOG coverage check)`);
  haveTag = false;
}
if (haveTag) {
  // A stale local tag makes the range meaningless: `git fetch` NEVER force-updates an existing tag,
  // and v1.9.1's local tag pointed at an orphaned pre-rebase commit that was never on main,
  // inflating "commits since release" from 9 to 18. Fail rather than compute against it.
  try {
    execSync(`git merge-base --is-ancestor ${prevTag} HEAD`, { stdio: "ignore" });
  } catch {
    console.error(
      `\nFAIL: ${prevTag} is not an ancestor of HEAD, so the commit range is meaningless.\n` +
        `The local tag is stale (git fetch does not force-update existing tags). Run:\n` +
        `  git fetch --tags --force origin`,
    );
    process.exit(1);
  }
  const subjects = execSync(`git log ${prevTag}..HEAD --format=%s`, { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // User-visible by type. docs/chore/test/ci/refactor/style are exempt.
  const userVisible = subjects.filter((l) => /^(feat|fix|perf|build)[(!:]/.test(l));
  const prs = [
    ...new Set(userVisible.flatMap((l) => [...l.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]))),
  ];
  const missing = prs.filter((n) => !body.includes(`#${n}`));
  if (missing.length) {
    console.error(
      `\nFAIL: user-visible PRs with no [Unreleased] entry: ${missing.map((n) => `#${n}`).join(", ")}\n` +
        `release.mjs only renames [Unreleased] -> [${next}], so these would ship undocumented.\n` +
        `Cite each PR in a note, or reclassify the commit if it is genuinely not user-visible.`,
    );
    process.exit(1);
  }
  console.log(`  CHANGELOG coverage OK (${prs.length} user-visible PR(s) since ${prevTag})`);
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
  // MUST contain every file check-version-coherence.mjs anchors on in its version-prose block,
  // or the release gate fails mid-cut with the version files already rewritten. roadmap.md was
  // anchored there but missing here, which blocked the 1.10.0 cut: two hardcoded lists, drifted.
  "docs/src/content/docs/roadmap.md",
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
