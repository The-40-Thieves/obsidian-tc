// THE-470: TREE.md's headline "**Scale:** N files, M lines" was hand-written and restated a
// machine-derivable fact. Measured 2026-07-28, it had been generated against `f1360b8` — 177
// commits earlier — and had drifted in BOTH directions at once: files 773 -> 767, total lines
// 124,033 -> 121,784, but lines-of-code 93,787 -> 96,233. Neither the size nor the SIGN of the
// error was guessable, which is the whole argument against hand-maintained restatements.
//
// gen-tree-map.mjs now emits that headline into a `tree-headline-scale` marker region, so
// `map:check` (ci-docgen) fails when it drifts. This test is the point of that change: a gate
// nobody has watched reject something is exactly how `not-to-dev-dep` went vacuous while
// reporting "0 errors" (see check-dev-dep-imports.test.ts). It plants a real tracked source file,
// asserts the gate rejects the resulting drift, and asserts it stays green on the clean tree.
//
// The fixture is a .sql file ON PURPOSE. The pre-existing regions of TREE.md are all derived from
// the TypeScript module graph, which SQL cannot touch — so a .sql fixture changes the headline and
// NOTHING else. If this test passes with a .ts fixture but fails with .sql, the headline is not
// actually being covered and the assertion is riding on the module-graph regions instead.
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = "scripts/gen-tree-map.mjs";
// scripts/ rather than packages/server/src/migrations/: a stray .sql under migrations/ is picked
// up by the migration manifest and embedded-migrations gates, so the fixture would trip checks
// that have nothing to do with this one.
const FIXTURE_REL = "scripts/__the470_headline_probe.sql";
const FIXTURE_ABS = fileURLToPath(new URL(`../../../${FIXTURE_REL}`, import.meta.url));

function runCheck() {
  return spawnSync("node", [SCRIPT, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
}

function removeFixture() {
  if (!existsSync(FIXTURE_ABS)) return;
  // The headline is counted from `git ls-files`, which lists only TRACKED content. An untracked
  // fixture is invisible to it — this exact mistake made the first manual drift probe "pass"
  // while proving nothing. `git add` below is therefore load-bearing, and this un-stages it again
  // so the worktree is left as found.
  spawnSync("git", ["reset", "--", FIXTURE_REL], { cwd: REPO_ROOT });
  unlinkSync(FIXTURE_ABS);
}

afterEach(() => {
  // Idempotent backstop: the drift test removes the fixture in a finally, but a thrown assertion
  // must not leave a staged file behind for every later test to trip over.
  removeFixture();
});

// ONE test, not three. Vitest runs test FILES in parallel (packages/server/vitest.config.ts leaves
// maxWorkers uncapped in CI), and check-dev-dep-imports.test.ts stages a `.ts` fixture into the
// index for part of its run. `.ts` is counted by this very gate, so while that fixture is staged
// the headline is legitimately stale — and a separate "clean tree passes" test would fail for a
// reason that has nothing to do with this code. Splitting the clean/dirty assertions across
// `it()` blocks makes that window wider, not narrower.
//
// Instead: establish the baseline and assert the transition inside a single test, and SKIP rather
// than fail if the tree is already stale when we arrive. A skipped run reports honestly; a red one
// would train people to re-run CI until it passes, which is how a flaky gate becomes an ignored
// gate.
describe("gen-tree-map headline scale gate", () => {
  it("REJECTS a tracked line-count change that does not touch the module graph", (ctx) => {
    const baseline = runCheck();
    if (baseline.status !== 0) {
      ctx.skip(
        "TREE.md was already stale on entry — most likely a concurrently-running test with a " +
          "staged fixture (check-dev-dep-imports.test.ts). Nothing this test asserts would be " +
          "meaningful from a dirty baseline.",
      );
      return;
    }

    try {
      writeFileSync(
        FIXTURE_ABS,
        "-- THE-470 headline drift probe. Not a migration; see the test that writes it.\n" +
          "SELECT 1;\nSELECT 2;\nSELECT 3;\n",
      );
      // Load-bearing. The headline counts `git ls-files`, which lists TRACKED paths only — an
      // untracked fixture is invisible and the gate would stay green, giving a false pass in the
      // one test that exists to prove it can fail. This exact mistake made the first manual probe
      // "succeed" while proving nothing.
      const add = spawnSync("git", ["add", "--intent-to-add", "--", FIXTURE_REL], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(add.status, `git add failed: ${add.stderr}`).toBe(0);

      const drifted = runCheck();
      expect(drifted.status, "map:check accepted a drifted headline").toBe(1);
      expect(`${drifted.stdout}${drifted.stderr}`).toMatch(/STALE/);
    } finally {
      removeFixture();
    }

    // Restoring must return the gate to green. Without this the test would still pass if the
    // fixture had permanently broken the tree, and would leave every later run red.
    expect(runCheck().status, "gate did not recover after the fixture was removed").toBe(0);
  }, 120_000);
  // ^ NOT arbitrary. Each runCheck() spawns gen-tree-map.mjs, which runs depcruise across 289
  // modules — measured 1.4-1.8s per invocation on an idle box, and this test makes THREE
  // (baseline, drifted, recovered). That is ~5s against vitest's 5000ms default, so the test
  // passes on a quiet machine and times out under parallel load. It did exactly that here once
  // the plugin suite started running alongside it. The ceiling is generous on purpose: a
  // subprocess-heavy gate test that flakes on timing gets muted, and a muted gate is no gate.
});
