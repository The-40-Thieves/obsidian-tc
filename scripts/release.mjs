#!/usr/bin/env node
import { execSync } from "node:child_process";
// Single-source release prep (THE-256 Phase 1).
// Usage: bun scripts/release.mjs <patch|minor|major|x.y.z>
// Sets the version across every package.json + distribution file, refreshes
// bun.lock, rolls the CHANGELOG, and runs the coherence gate. Does NOT commit,
// push, or tag — branch + PR + review + human tag stay manual by design.
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { updateBunLockWorkspaceVersions } from "./lib/bun-lock-workspace-versions.mjs";

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

// Conventional-commit type is a coarse proxy for "user-visible" and it over-selects: a `fix(` on a
// CI script, the typechecker config or the merge driver changes nothing an operator can observe.
// The escape hatch the gate below suggests ("reclassify the commit") is only available BEFORE the
// commit is on main, so record the judgement here instead — keyed by PR number or 8-char sha, one
// line of reason each, where it is reviewable in a diff rather than argued once in a terminal.
const NOT_USER_VISIBLE = new Map([
  ["583", "CI only: cross-platform dependency-cruiser invocation in the boundary gate (WP0.1)"],
  ["599", "CI only: config-threading parser had to read the split WP1 schema leaves"],
  [
    "604",
    "pure refactor: WP4.2 dispatch observability/idempotency extraction, no behaviour change",
  ],
  ["606", "pure refactor: WP5.1 runtime store/governance/index wiring extraction"],
  ["608", "CI only: made the ingest-telemetry gate comment-aware (false negative in the gate)"],
  ["624", "docs tooling: TREE.md §3/§4 generation and a facts-check pattern"],
  ["635", "dev tooling: merge-driver registration path, not reachable from the product"],
  ["637", "dev tooling: brought bun-smoke into the typechecker as its own tsc project"],
  ["764", "eval harness: --activation/--bubble-safe flag validation, eval-only"],
  ["769", "eval harness: ACL overlay + per-principal expected sets for the corpus, eval-only"],
  ["770", "eval harness: ACL leakage gate, eval-only"],
  ["773", "perf baseline: warm the txn loop before timing; baseline recording, no shipped code"],
  [
    "774",
    "perf baseline: guard that a baseline still matches its recording, no shipped-code effect",
  ],
  ["775", "perf baseline re-record on the CI runner"],
  ["781", "eval harness: refuse a run whose flag cannot do its work, eval-only"],
  ["782", "eval harness: typecheck eval/ + mispaired-golden-set guard; dev tsconfig/script only"],
  ["783", "eval harness: ceiling + fusion-conversion probe result, eval-only"],
  ["816", "release tooling: reranker-local prepack build guard, no shipped-code effect"],
  ["822", "test-only: 15s timeout for plane-disabled-reflect-stays-wired"],
]);

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
  // Attribute each commit to a PR. Three merge styles land on main and only two leave a mark in
  // the commit graph:
  //   squash merge  -> `(#N)` in the commit's own subject
  //   merge commit  -> `Merge pull request #N from ...` on the MERGE COMMIT; every commit it
  //                    brings in carries no marker at all
  //   rebase merge  -> no marker anywhere
  // Reading subjects alone therefore sees only the squashes. At the v1.14.0 cut that was 18 of 61
  // user-visible commits: the gate printed "coverage OK (18 user-visible PR(s))" while 43 commits
  // were structurally invisible to it, among them the docker-compose quick start (THE-638) and the
  // PRM `bearer_methods` fix (THE-661). A gate whose domain is narrower than its name launders an
  // omission as a green check, which is worse than having no gate at all.
  //
  // Second-parent-minus-first-parent is exactly the set a merge brought in. Outer merges are
  // visited first (a merge inside a PR branch necessarily predates the merge OF that branch) and
  // `--not <first parent>` already excludes everything reachable from main at that point, so
  // first-claim-wins needs no further ordering care.
  const prOfCommit = new Map();
  for (const line of execSync(`git log ${prevTag}..HEAD --merges --format=%H%x09%P%x09%s`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)) {
    const [, parents, subject] = line.split("\t");
    const pr = /^Merge pull request #(\d+)\b/.exec(subject);
    if (!pr) continue;
    const [first, second] = parents.split(" ");
    if (!second) continue;
    for (const sha of execSync(`git rev-list ${second} --not ${first}`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)) {
      if (!prOfCommit.has(sha)) prOfCommit.set(sha, pr[1]);
    }
  }

  const commits = execSync(`git log ${prevTag}..HEAD --format=%H%x09%s`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const tab = l.indexOf("\t");
      return { sha: l.slice(0, tab), subject: l.slice(tab + 1).trim() };
    });
  // User-visible by type. docs/chore/test/ci/refactor/style are exempt.
  const userVisible = commits.filter((c) => /^(feat|fix|perf|build)[(!:]/.test(c.subject));

  const prs = new Set();
  const orphans = [];
  for (const c of userVisible) {
    if (NOT_USER_VISIBLE.has(c.sha.slice(0, 8))) continue;
    const inline = [...c.subject.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]);
    if (inline.length) {
      for (const n of inline) prs.add(n);
      continue;
    }
    const viaMerge = prOfCommit.get(c.sha);
    if (viaMerge) {
      prs.add(viaMerge);
      continue;
    }
    orphans.push(c);
  }

  const missing = [...prs].filter((n) => !NOT_USER_VISIBLE.has(n) && !body.includes(`#${n}`));
  // A rebase-merged commit carries no PR number anywhere, so it has to be cited by ticket. Require
  // EVERY ticket in the subject, not just one: a commit that lands three tickets and gets credited
  // for one leaves the other two undocumented, which is the same silent drop one level down.
  const uncited = orphans
    .map((c) => ({
      c,
      tickets: [...c.subject.matchAll(/\bTHE-\d+\b/g)].map((m) => m[0]),
    }))
    .map(({ c, tickets }) => ({ c, missing: tickets.filter((t) => !body.includes(t)) }))
    .filter(({ c, missing: m }) => m.length > 0 || c.subject.search(/\bTHE-\d+\b/) === -1);
  if (missing.length || uncited.length) {
    const lines = [`\nFAIL: user-visible work with no [Unreleased] entry.`];
    if (missing.length) lines.push(`  PRs:      ${missing.map((n) => `#${n}`).join(", ")}`);
    for (const { c, missing: m } of uncited) {
      lines.push(
        `  commit:   ${c.sha.slice(0, 8)}  ${m.length ? `[${m.join(", ")}] ` : "(no ticket) "}${c.subject}`,
      );
    }
    lines.push(
      `release.mjs only renames [Unreleased] -> [${next}], so these would ship undocumented.`,
      `Cite each one in a note, or add it to NOT_USER_VISIBLE above with a reason.`,
    );
    console.error(lines.join("\n"));
    process.exit(1);
  }
  console.log(
    `  CHANGELOG coverage OK (${prs.size} user-visible PR(s) + ${orphans.length} direct commit(s) since ${prevTag})`,
  );
}

// Core version set; packages/plugin is bumped separately below — it now tracks the repo
// version in lockstep (decision 2026-07-02; see the block after server.json).
// THE-944 review round 1 (F2): packages/reranker-local/package.json rejoins the repo version
// lockstep too. It is deliberately NOT a root workspace member (its own README explains why —
// the ~230 MB @huggingface/transformers dependency), but it publishes through its own CI job
// (publish-reranker-local in .github/workflows/publish.yml) whose F3-style preflight skips
// publishing any version already on npm — a version that never moves means, after the owner's
// one-time first manual publish, EVERY subsequent release finds that same version already
// published and silently no-ops forever, never shipping anything again (including a
// MODEL_REVISION bump or a fix in model-fetch.ts). Lockstep with the repo version is what keeps
// each tagged release a genuinely new, publishable version.
// THE-950: the MCPB bundle manifest lives at mcpb/manifest.json (the repo root now carries the
// companion plugin's Obsidian manifest instead — see the mirror step after packages/plugin's
// manifest.json is bumped, below).
for (const p of [
  "package.json",
  "packages/server/package.json",
  "packages/native/package.json",
  "packages/shared/package.json",
  "packages/reranker-local/package.json",
  "mcpb/manifest.json",
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

// THE-950: mirror the bumped plugin manifest onto the repo root, byte-for-byte. The root
// manifest.json is what Obsidian's community-directory validator reads from the default branch,
// and check-version-coherence.mjs's plugin-manifest gate fails the release if the two ever drift —
// this is the one place that writes both, so there is no second copy to hand-maintain.
writeFileSync(inRepo("manifest.json"), readFileSync(inRepo("packages/plugin/manifest.json")));
console.log("  set manifest.json (mirrors packages/plugin/manifest.json)");

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
  // THE-598: docs/wiki/Home.md's "Shipped — **v1.10.0**" (and its ghcr tag) sat stale nine lines
  // below a generated block already saying 1.11.0 — this file was in neither list. Added to both
  // per the warning above.
  "docs/wiki/Home.md",
]) {
  const target = inRepo(p);
  const before = readFileSync(target, "utf8");
  const after = before.split(current).join(next);
  if (after !== before) {
    writeFileSync(target, after);
    console.log(`  version prose bumped in ${p}`);
  }
}

// SECURITY.md advertises supported versions by MINOR ("1.11.x" covers every patch of that minor),
// not the full x.y.z release version, so it cannot go through the literal full-version
// string-replace loop above (THE-562: the table drifted silently for two days past the v1.11.0 tag
// because SECURITY.md was in no script at all). Bump it here, only when the minor actually
// changes — a patch release keeps the same supported minor, so the table is correctly left alone.
// check-version-coherence.mjs's SECURITY.md block asserts this table matches the package minor.
{
  const minorOf = (v) => v.split(".").slice(0, 2).join(".");
  const currentMinor = minorOf(current);
  const nextMinor = minorOf(next);
  if (currentMinor !== nextMinor) {
    const target = inRepo("SECURITY.md");
    const before = readFileSync(target, "utf8");
    const after = before
      .replace(`| ${currentMinor}.x`, `| ${nextMinor}.x`)
      .replace(`< ${currentMinor}`, `< ${nextMinor}`);
    if (after === before) {
      console.error(
        `FAIL: SECURITY.md supported-version row did not match the expected ${currentMinor}.x / < ${currentMinor} text; update the table format or this bump step.`,
      );
      process.exit(1);
    }
    writeFileSync(target, after);
    console.log(`  SECURITY.md supported-version bumped to ${nextMinor}.x`);
  }
}

// THE-948: `bun install` does not refresh bun.lock's `workspaces[*].version` fields after a
// version-only package.json bump (measured at the 1.26.0 and 1.27.0 cuts — `bun install` reported
// no changes, and check-version-coherence.mjs's lockfile assertion failed on every cut until the
// four entries were edited by hand, done for 1.26.0 as f54806ec). Rewrite them here, in the same
// pass as the package.json bumps above, before `bun install` runs.
{
  const lockPath = inRepo("bun.lock");
  const before = readFileSync(lockPath, "utf8");
  const after = updateBunLockWorkspaceVersions(before, next);
  if (after !== before) {
    writeFileSync(lockPath, after);
    console.log("  set bun.lock workspace versions");
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
