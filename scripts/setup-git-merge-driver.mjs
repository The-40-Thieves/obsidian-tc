#!/usr/bin/env node
/**
 * Bootstrap for the "regen" merge driver. .gitattributes names it for
 * packages/server/src/db/migrations-embedded.ts; this script is what actually DEFINES it, since a merge driver's
 * definition lives in .git/config, which git never commits or clones — see check-merge-driver.mjs
 * for the empirical proof that skipping this step leaves the fix silently vacuous.
 *
 * Wired as the root package.json's `prepare` script, so it runs automatically on every
 * `bun install` — the same one-command bootstrap CONTRIBUTING.md already documents (no new step
 * for contributors to remember). Idempotent: safe on every install, harmless in CI (CI never runs
 * `git merge` against a conflicting branch), and safe to re-run by hand
 * (`bun run setup:git-merge-driver`).
 *
 * Skips (exit 0) outside a git working tree. The Dockerfile's `bun install --frozen-lockfile
 * --ignore-scripts` never runs this at all, but the guard is cheap and keeps this safe if that
 * ever changes, or if this package is ever installed as a plain dependency with no .git present.
 *
 * After writing the config, re-reads it back via check-merge-driver.mjs and FAILS the install if
 * the write didn't actually take — the same gate a developer can also run standalone
 * (`bun run check:merge-driver` / `just check-merge-driver`) to confirm their own clone is set up.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER_NAME = "regen";
// Pre-`regen` name (it deferred TREE.md / dependency-graph.json to manual regeneration). Both files
// stopped being committed, so the definition is removed rather than left dangling at a deleted script.
const LEGACY_DRIVER_NAME = "regenerate";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let repoRoot;
try {
  repoRoot = git(["rev-parse", "--show-toplevel"]);
} catch {
  console.log(
    "setup-git-merge-driver: not inside a git working tree — skipping (nothing to configure).",
  );
  process.exit(0);
}

// Absolute, and correctly so: this script SPAWNS check-merge-driver.mjs itself below, so it needs a
// path resolvable from wherever node was invoked. Only the value written into git config must be
// relative — see the comment on driverScript.
const here = path.dirname(fileURLToPath(import.meta.url));

// REPO-RELATIVE, deliberately — never an absolute path built from import.meta.url.
//
// `.git/config` is SHARED by every linked worktree (git only splits it when
// extensions.worktreeConfig is set, which this repo does not set). An absolute path therefore made
// this script's last caller win for the whole repo: a `bun install` inside a throwaway worktree
// rewrote the MAIN checkout's driver to point into that worktree, and deleting the worktree left a
// dangling path. Git then failed to run the driver and fell back to an ordinary text merge — the
// exact conflict-prone behaviour this driver exists to prevent, silently.
//
// Git runs a merge driver with its working directory at the top of the working tree being merged,
// so one relative command resolves correctly in EVERY worktree simultaneously and cannot be
// invalidated by another worktree's install or removal.
const driverScript = path.posix.join("scripts", "merge-drivers", "regen.mjs");

try {
  git(["config", "--remove-section", `merge.${LEGACY_DRIVER_NAME}`]);
} catch {
  // no legacy section — nothing to remove
}

git([
  "config",
  `merge.${DRIVER_NAME}.name`,
  "Regenerate packages/server/src/db/migrations-embedded.ts from the three sides as data " +
    "(filename -> SQL) instead of text-merging it; a same-migration edit is a real conflict",
]);
git(["config", `merge.${DRIVER_NAME}.driver`, `node "${driverScript}" %O %A %B %P`]);

console.log(
  `setup-git-merge-driver: configured merge.${DRIVER_NAME}.driver in ${repoRoot}/.git/config`,
);

try {
  execFileSync("node", [path.join(here, "check-merge-driver.mjs")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch (err) {
  console.error(
    "setup-git-merge-driver: wrote the git config but check-merge-driver still fails — see above.",
  );
  process.exit(typeof err.status === "number" ? err.status : 1);
}
