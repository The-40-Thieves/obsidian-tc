#!/usr/bin/env node
// THE-426 recurrence guard: flag when `main` has drifted far ahead of the latest published tag
// while carrying unreleased Fixed/Security CHANGELOG entries — the THE-285 pattern, where CRITICAL
// fixes sat unshipped on main for 40+ commits. Advisory by default; exits non-zero only past
// THRESHOLD *and* with unreleased Fixed/Security entries, so a scheduled run goes red as a nag.
// Deliberately NOT a per-PR gate: there is always some unreleased content between releases.
//
// Shell-free: every git call is execFileSync with an argument array (no interpolation into a shell).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const THRESHOLD = Number(process.env.RELEASE_LAG_THRESHOLD ?? 30);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let tag;
try {
  tag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"]);
} catch {
  console.log("release-lag: no v* tag reachable (shallow clone without tags?); skipping.");
  process.exit(0);
}

const ahead = Number(git(["rev-list", "--count", `${tag}..HEAD`]));

// Extract the CHANGELOG [Unreleased] section (up to the next "## [" version header) and check
// whether it carries any ### Fixed / ### Security entries — i.e. shippable fixes are waiting.
const changelog = readFileSync(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), "utf8");
const m = changelog.match(/## \[Unreleased\]([\s\S]*?)(?=\n## \[)/);
const unreleased = m ? m[1] : "";
const hasSecurityFixes = /^###\s+(Fixed|Security)\b/m.test(unreleased);

console.log(
  `release-lag: ${ahead} commit(s) ahead of ${tag}; unreleased Fixed/Security entries: ${hasSecurityFixes} (threshold ${THRESHOLD}).`,
);

if (ahead >= THRESHOLD && hasSecurityFixes) {
  console.error(
    `::error::main is ${ahead} commits ahead of ${tag} AND the CHANGELOG has unreleased Fixed/Security entries. Cut a release (recurrence of THE-285 / THE-426).`,
  );
  process.exit(1);
}
if (ahead >= THRESHOLD) {
  console.log(
    `::warning::main is ${ahead} commits ahead of ${tag} (no unreleased Fixed/Security entries, so advisory only).`,
  );
}
process.exit(0);
