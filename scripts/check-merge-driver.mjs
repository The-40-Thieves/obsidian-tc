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

const DRIVER_NAME = "regenerate";
const ARTIFACTS = ["TREE.md", "docs/dependency-graph.json"];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

try {
  git(["rev-parse", "--show-toplevel"]);
} catch {
  console.log("check-merge-driver: not inside a git working tree — skipping (nothing to verify).");
  process.exit(0);
}

const problems = [];

let driverCmd = "";
try {
  driverCmd = git(["config", "--get", `merge.${DRIVER_NAME}.driver`]);
} catch {
  // `git config --get` exits 1 when the key is unset — driverCmd stays "".
}
if (!driverCmd) {
  problems.push(
    `merge.${DRIVER_NAME}.driver is not set in this clone's git config — a merge of TREE.md or ` +
      "docs/dependency-graph.json will fall back to an ordinary (conflict-prone) text merge. Run " +
      "`bun run setup:git-merge-driver` (or `bun install`, which runs it automatically) to fix.",
  );
}

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
  `check-merge-driver: OK — merge.${DRIVER_NAME}.driver is configured and ${ARTIFACTS.join(", ")} ` +
    `carry \`merge=${DRIVER_NAME}\`.`,
);
