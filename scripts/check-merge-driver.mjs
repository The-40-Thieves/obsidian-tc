#!/usr/bin/env node
/**
 * check-merge-driver — asserts the "regenerate" merge driver named in .gitattributes for
 * TREE.md / docs/dependency-graph.json is actually DEFINED in this clone's local git config.
 *
 * .gitattributes can only NAME a merge driver (`merge=regenerate`); its *definition*
 * (merge.regenerate.driver) lives in .git/config, which git never commits or clones. Verified
 * empirically in a scratch repo: a `.gitattributes`-only change is silently vacuous — a fresh
 * clone still gets ordinary 3-way text conflicts on these files, exit 1, conflict markers and
 * all, exactly as if nothing had changed. This gate exists so that gap fails loudly instead of
 * quietly regressing to the status quo (the same trap THE-593 found in a dependency-cruiser rule
 * that could never fire).
 *
 * Deliberately a LOCAL-only check, not a CI job — mirrors `ticket-drift` in the justfile, which is
 * local for the same class of reason. CI clones fresh and never runs `git merge` against a
 * conflicting branch, so a CI job here would be theater either way: with the Dockerfile's `bun
 * install --ignore-scripts` it would always fail (nothing ever configures the driver there), and
 * with a normal CI `bun install` it would always trivially pass once `prepare` runs — neither
 * outcome says anything about whether a DEVELOPER's own machine is set up to merge cleanly. Run it
 * via `just check-merge-driver` / `bun run check:merge-driver`, and automatically at the end of
 * `bun install` (scripts/setup-git-merge-driver.mjs) — the one command every contributor already
 * runs both configures the driver and asserts the configuration actually took.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DRIVER_NAME = "regenerate";
const ARTIFACTS = ["TREE.md", "docs/dependency-graph.json"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Extract the driver script path from a `merge.<name>.driver` command line. The setup script
 *  writes `node "<path>" %O %A %B %P`; the quoted form is authoritative, the bare form is accepted
 *  so a hand-written config is diagnosed rather than silently passed. */
export function driverScriptPath(driverCmd) {
  return (
    /^node\s+"([^"]+)"/.exec(driverCmd)?.[1] ?? /^node\s+([^\s"]+)/.exec(driverCmd)?.[1] ?? null
  );
}

/**
 * Validate a configured driver command. Pure: `exists` is injected so this is testable without a
 * filesystem, and `isAbsolute` is passed in so a POSIX test can exercise Windows-shaped paths.
 *
 * A SET key is not a WORKING driver, which is what this function exists to say. `.git/config` is
 * shared by every linked worktree (git only splits it under extensions.worktreeConfig, which this
 * repo does not set), so an absolute path written by a `bun install` inside a throwaway worktree
 * outlives that worktree's removal and leaves the WHOLE repo pointing at a path that no longer
 * exists. Git then silently falls back to an ordinary text merge.
 *
 * Measured 2026-08-01: this gate reported OK while `merge.regenerate.driver` pointed into a deleted
 * worktree, and TREE.md had to be hand-resolved on PR #633. Asserting only that the key is
 * non-empty cannot detect that — the gate was vacuous for the exact failure it exists to catch.
 */
export function driverProblems({ driverCmd, repoRoot, exists, isAbsolute = path.isAbsolute }) {
  if (!driverCmd) {
    return [
      `merge.${DRIVER_NAME}.driver is not set in this clone's git config — a merge of TREE.md or ` +
        "docs/dependency-graph.json will fall back to an ordinary (conflict-prone) text merge. Run " +
        "`bun run setup:git-merge-driver` (or `bun install`, which runs it automatically) to fix.",
    ];
  }
  const scriptPath = driverScriptPath(driverCmd);
  if (!scriptPath) {
    return [
      `merge.${DRIVER_NAME}.driver is set but no script path could be parsed from it ` +
        `(got: ${driverCmd}). Run \`bun run setup:git-merge-driver\` to rewrite it.`,
    ];
  }
  const absolute = isAbsolute(scriptPath);
  // Relative paths resolve against the repo root — git runs a merge driver with its cwd at the top
  // of the working tree being merged, which is exactly why relative is the durable form.
  const resolved = absolute ? scriptPath : path.join(repoRoot, scriptPath);
  if (!exists(resolved)) {
    return [
      `merge.${DRIVER_NAME}.driver points at "${scriptPath}", which does not exist` +
        (absolute
          ? " — an absolute path left behind by a `bun install` in a worktree that has since been " +
            "removed (.git/config is shared by all worktrees)."
          : ` (resolved to ${resolved}).`) +
        " Git cannot run the driver and will fall back to an ordinary (conflict-prone) text merge. " +
        "Run `bun run setup:git-merge-driver` to fix.",
    ];
  }
  if (absolute) {
    return [
      `merge.${DRIVER_NAME}.driver is an ABSOLUTE path ("${scriptPath}"). \`.git/config\` is ` +
        "shared by every linked worktree, so this breaks the moment that checkout is removed or " +
        "another worktree runs the setup script. Run `bun run setup:git-merge-driver` to rewrite " +
        "it as a repo-relative path.",
    ];
  }
  return [];
}

function main() {
  let repoRoot;
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"]);
  } catch {
    console.log(
      "check-merge-driver: not inside a git working tree — skipping (nothing to verify).",
    );
    process.exit(0);
  }

  let driverCmd = "";
  try {
    driverCmd = git(["config", "--get", `merge.${DRIVER_NAME}.driver`]);
  } catch {
    // `git config --get` exits 1 when the key is unset — driverCmd stays "".
  }

  const problems = driverProblems({ driverCmd, repoRoot, exists: existsSync });

  for (const file of ARTIFACTS) {
    let attrLine = "";
    try {
      // `git check-attr merge -- <path>` prints exactly one line: "<path>: merge: <value>".
      attrLine = git(["check-attr", "merge", "--", file]);
    } catch (err) {
      problems.push(`git check-attr failed for ${file}: ${err.message}`);
      continue;
    }
    const match = /: merge: (.+)$/.exec(attrLine);
    const value = match?.[1];
    if (value !== DRIVER_NAME) {
      problems.push(
        `${file} is not attributed \`merge=${DRIVER_NAME}\` (git check-attr reported "${value}") — ` +
          ".gitattributes may be missing this entry or out of date in this checkout.",
      );
    }
  }

  if (problems.length > 0) {
    console.error("check-merge-driver: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-merge-driver: OK — merge.${DRIVER_NAME}.driver resolves to an existing repo-relative ` +
      `script and ${ARTIFACTS.join(", ")} carry \`merge=${DRIVER_NAME}\`.`,
  );
}

// Importing this module (as its test file does) must have no side effects — no git calls, no
// filesystem reads, no process.exit. Only run the gate when this file is the process entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
