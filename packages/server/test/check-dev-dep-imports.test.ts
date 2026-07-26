// THE-593: `.dependency-cruiser.cjs`'s `not-to-dev-dep` (severity: "error", wired into the
// required `check:boundaries` CI job) cannot fire. dependency-cruiser 18.1.0 has no TypeScript 7
// support (root package.json pins `^7.0.2`), falls back to a degraded parser, and classifies
// every npm import as `['unknown']` — never `['npm-dev']`. A rule keyed on
// `dependencyTypes: ["npm-dev"]` therefore matches nothing, silently, forever.
//
// scripts/check-dev-dep-imports.mjs replaces that rule's coverage with a plain-text scan that
// does not depend on dependency-cruiser's TypeScript support at all. This test is the point of
// the ticket: a rule nobody has watched reject something is exactly what let `not-to-dev-dep` go
// vacuous unnoticed (`check:boundaries` reported "0 errors" and looked like coverage). It plants
// a real file that imports `vitest` — a real devDependency of packages/server/package.json — from
// non-test `src`, then asserts the gate rejects it, before asserting it stays green on the actual,
// currently-clean tree.
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = "scripts/check-dev-dep-imports.mjs";
const FIXTURE_REL = "packages/server/src/__the593_dev_dep_probe.ts";
const FIXTURE_ABS = fileURLToPath(new URL(`../../../${FIXTURE_REL}`, import.meta.url));

function runCheck() {
  return spawnSync("node", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
}

function removeFixture() {
  if (!existsSync(FIXTURE_ABS)) return;
  // The gate scans `git ls-files`, which lists only tracked content — an untracked fixture is
  // invisible to it (the same trap check-nul-bytes.mjs has: a scan built on `git ls-files` sees
  // nothing new until it is staged). `git add` before running the check, then `git reset` here
  // to un-stage before deleting, so the worktree is left exactly as it was found.
  spawnSync("git", ["reset", FIXTURE_REL], { cwd: REPO_ROOT });
  unlinkSync(FIXTURE_ABS);
}

afterEach(() => {
  // Idempotent backstop: the violation test removes the fixture itself in a finally, but this
  // guards against a thrown assertion leaving it (staged or not) behind for later tests to trip
  // over.
  removeFixture();
});

describe("check-dev-dep-imports.mjs (THE-593)", () => {
  it("passes against the real, currently-clean tree", () => {
    const result = runCheck();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/0 violation\(s\)/);
  });

  it("rejects a src file importing a real devDependency", () => {
    // vitest is a devDependency of packages/server/package.json, not a runtime dependency — the
    // exact shape `not-to-dev-dep` was written to catch and, per THE-593, cannot.
    writeFileSync(
      FIXTURE_ABS,
      'import { expect } from "vitest";\nexport const probe = (): unknown => expect;\n',
    );
    // See removeFixture(): the gate scans `git ls-files`, so the fixture must be staged to be
    // seen at all.
    spawnSync("git", ["add", FIXTURE_REL], { cwd: REPO_ROOT });
    try {
      const result = runCheck();
      expect(result.status).not.toBe(0);
      expect(result.stdout).toMatch(
        /__the593_dev_dep_probe\.ts:1\s+imports "vitest" \(devDependency "vitest"\)/,
      );
      expect(result.stderr).toMatch(/must not import a devDependency/);
    } finally {
      removeFixture();
    }
  });
});
