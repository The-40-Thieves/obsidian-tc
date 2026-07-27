#!/usr/bin/env node
/**
 * Custom git merge driver for TREE.md and docs/dependency-graph.json (gitattr).
 *
 * .gitattributes names `merge=regenerate` for both files; this script is the driver that name
 * points at (wired into this clone's local git config by scripts/setup-git-merge-driver.mjs — a
 * merge driver's *definition* lives in .git/config, which git never commits or clones for you).
 *
 * WHY THIS DOES NOT RE-RUN THE GENERATOR (an earlier draft tried that — do not reintroduce it):
 *
 * git invokes a custom merge driver for EVERY conflicting path before it finishes applying
 * non-conflicting single-side changes elsewhere in the tree. Verified empirically with a scratch
 * repo (two branches, each adding a different tracked file and regenerating TREE.md /
 * dependency-graph.json from the full module list): a debug driver run mid-merge found the OTHER
 * branch's new file present in NEITHER the working tree NOR the index yet —
 * `git show :src/b.txt` failed with "path does not exist (neither on disk nor in the index)" at
 * the exact moment the driver ran. A driver that shells out to `node scripts/gen-tree-map.mjs`
 * here regenerates from a tree that is missing whatever the other side just added, and reports
 * success — a SILENTLY WRONG artifact, strictly worse than an ordinary conflict, and exactly the
 * failure mode this change must not trade a conflict for. (A `post-merge` hook would see the
 * complete tree, but does not fire for `git rebase` — the PR #503 scenario this fixes — so it
 * would not close the actual gap either, at the cost of real added complexity.)
 *
 * So: never attempt to regenerate here. Best-effort a genuine textual 3-way merge via
 * `git merge-file` (pure text, no dependency on the ambient working tree — safe regardless of
 * invocation order); if that has no conflicts, keep it — it can only be more accurate than
 * discarding a side outright. If it conflicts (the common case: both sides touched the same
 * derived "scale" line), do NOT leave conflict markers — this is machine-generated content nobody
 * should hand-resolve — restore "ours" instead and let the merge/rebase proceed without stopping
 * here. Either way the result is left deliberately possibly-stale; `bun run map:check`
 * (`just map-check`, wired into CI's ci-docgen) is what actually catches that and forces
 * `just map` once the merge/rebase has FULLY completed, when the tree is guaranteed complete.
 *
 * Invoked by git as: defer-regeneration.mjs %O %A %B %P
 *   %O = common ancestor's version (temp file)
 *   %A = current branch's version (temp file) — driver MUST leave the result here
 *   %B = other branch's version (temp file)
 *   %P = the real repo-relative path being merged (e.g. "TREE.md") — used only for logging
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [ancestorPath, currentPath, otherPath, mergedPath] = process.argv.slice(2);

if (!ancestorPath || !currentPath || !otherPath) {
  console.error(
    "defer-regeneration: expected %O %A %B (%P) — check merge.regenerate.driver in this clone's " +
      "git config (scripts/setup-git-merge-driver.mjs sets it up).",
  );
  process.exit(1);
}

const oursOriginal = readFileSync(currentPath);

let clean = false;
try {
  // `git merge-file <current> <base> <other>` merges INTO <current> in place. Exits 0 only when
  // there were no conflicts.
  execFileSync("git", ["merge-file", "--quiet", currentPath, ancestorPath, otherPath]);
  clean = true;
} catch {
  // Conflicting (or erroring) — merge-file may have left conflict markers in `currentPath`.
  // Restore "ours" rather than asking anyone to hand-resolve generated content.
  writeFileSync(currentPath, oursOriginal);
}

console.error(
  `defer-regeneration: ${mergedPath ?? "(path)"} ${clean ? "merged cleanly (kept as-is)" : 'left as "ours" (conflicting regions discarded)'} — ` +
    "this file is machine-generated; run `just map` once your merge/rebase finishes and commit " +
    "the refreshed result (`just map-check` / CI's ci-docgen fails until you do).",
);
// Never reports a conflict for these two paths — that is the point of this driver. Staleness is
// enforced downstream by map:check, not here.
process.exit(0);
