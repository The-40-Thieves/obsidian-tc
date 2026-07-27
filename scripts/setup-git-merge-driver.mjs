#!/usr/bin/env node
/**
 * Bootstrap for the "regenerate" merge driver. .gitattributes names it for TREE.md and
 * docs/dependency-graph.json; this script is what actually DEFINES it, since a merge driver's
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

const DRIVER_NAME = "regenerate";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const driverScript = path.join(here, "merge-drivers", "defer-regeneration.mjs");

git([
  "config",
  `merge.${DRIVER_NAME}.name`,
  "Defer TREE.md / docs/dependency-graph.json to regeneration instead of hand-merging machine " +
    "output (run `just map` after; `just map-check` / CI catches staleness)",
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
