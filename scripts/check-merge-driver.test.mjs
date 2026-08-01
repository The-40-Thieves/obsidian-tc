// Tests for scripts/check-merge-driver.mjs — specifically the path validation added after this
// gate was measured PASSING on a broken configuration (2026-08-01).
//
// The gate exists to catch a silently-vacuous merge-driver setup. It had the same defect it was
// written to detect: it asserted only that `merge.regenerate.driver` was non-empty, so a command
// pointing into a deleted worktree reported OK while git fell back to ordinary text merges. TREE.md
// then conflicted by hand on PR #633.
//
// `driverProblems` takes injected `exists` / `isAbsolute`, so these cases run without a filesystem
// and a POSIX host can still exercise a Windows-shaped path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { driverProblems, driverScriptPath } from "./check-merge-driver.mjs";

const REPO = "/repo";
const RELATIVE_CMD = 'node "scripts/merge-drivers/defer-regeneration.mjs" %O %A %B %P';
const ABSOLUTE_CMD =
  'node "/gone/otc-task8/scripts/merge-drivers/defer-regeneration.mjs" %O %A %B %P';

const never = () => false;
const always = () => true;

test("driverScriptPath: extracts the quoted path the setup script writes", () => {
  assert.equal(driverScriptPath(RELATIVE_CMD), "scripts/merge-drivers/defer-regeneration.mjs");
});

test("driverScriptPath: accepts an unquoted path so a hand-written config is diagnosed", () => {
  assert.equal(driverScriptPath("node scripts/x.mjs %O %A %B %P"), "scripts/x.mjs");
});

test("driverScriptPath: returns null when no script path is present", () => {
  assert.equal(driverScriptPath("some-other-tool --merge"), null);
});

test("an unset driver is reported", () => {
  const problems = driverProblems({ driverCmd: "", repoRoot: REPO, exists: always });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is not set/);
});

// THE REGRESSION. Before this check, a set-but-dangling driver returned zero problems.
test("a dangling ABSOLUTE path (deleted worktree) is a failure, not an OK", () => {
  const problems = driverProblems({ driverCmd: ABSOLUTE_CMD, repoRoot: REPO, exists: never });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not exist/);
  // The message must name the actual cause, since that is what tells the reader why a path they
  // never typed is in their config at all.
  assert.match(problems[0], /shared by all worktrees/);
});

test("a dangling RELATIVE path is also a failure, and reports what it resolved to", () => {
  const problems = driverProblems({ driverCmd: RELATIVE_CMD, repoRoot: REPO, exists: never });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not exist/);
  assert.match(problems[0], /\/repo\/scripts\/merge-drivers\/defer-regeneration\.mjs/);
});

// An absolute path that happens to exist today is still wrong: .git/config is shared, so it breaks
// as soon as that checkout is removed or another worktree runs setup. Failing now is the point —
// this is the state that DECAYS into the dangling one above.
test("an EXISTING absolute path is still a failure, because it is shared-config-fragile", () => {
  const problems = driverProblems({ driverCmd: ABSOLUTE_CMD, repoRoot: REPO, exists: always });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ABSOLUTE path/);
});

test("an existing relative path is the only passing shape", () => {
  const problems = driverProblems({ driverCmd: RELATIVE_CMD, repoRoot: REPO, exists: always });
  assert.deepEqual(problems, []);
});

test("an unparseable command is reported rather than silently passing", () => {
  const problems = driverProblems({
    driverCmd: "custom-merge-tool %A %B",
    repoRoot: REPO,
    exists: always,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no script path could be parsed/);
});

// A Windows driver path must be treated as absolute even when the gate runs on POSIX, or CI on one
// platform would silently accept a config that is fragile on another.
test("a Windows-shaped absolute path is detected as absolute on any host", () => {
  const problems = driverProblems({
    driverCmd: 'node "C:\\dev\\otc\\scripts\\merge-drivers\\defer-regeneration.mjs" %O %A %B %P',
    repoRoot: REPO,
    exists: always,
    isAbsolute: (p) => /^[A-Za-z]:[\\/]/.test(p),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ABSOLUTE path/);
});
