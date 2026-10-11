// lint_wiki and the scheduled wiki lint ran their orphan / dangling-link / missing-sources scans in
// one synchronous piece, so on a big vault a timer, a concurrent tool call and SIGTERM all waited
// behind them. They now drain the same step generators as the standalone scan tools. RED before
// the change: no timer tick and no second call is serviced until the lint returns.
import { afterEach, describe, expect, it } from "vitest";
import { registerWikiLintSweep } from "../src/runtime/wiki-lint-sweep";
import { NO_EXCLUSION } from "../src/search/index-exclusion";
import type { LintReport } from "../src/tools/m7/knowledge/wiki-lint";
import { scanFixtureFiles } from "./fixtures/scan-yield-vault";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let h: WikiHarness | undefined;
afterEach(() => h?.v.cleanup());

/** Enough notes that one synchronous lint takes a few hundred ms on a slow runner. */
function bigVault(): WikiHarness {
  h = makeWikiHarness({ files: scanFixtureFiles(2500), wikiFolder: "wiki" });
  return h;
}

/** Run `lint` while a timer and a second tool call (issued from a macrotask) compete for the loop. */
async function serviced(lint: () => Promise<unknown>, other: () => Promise<{ ok: boolean }>) {
  let lintDone = false;
  const ticks: number[] = [];
  const timer = setInterval(() => {
    if (!lintDone) ticks.push(performance.now());
  }, 2);
  let otherDoneBeforeLint = false;
  const main = lint().then((r) => {
    lintDone = true;
    return r;
  });
  // Issued from a macrotask: it can only run if the lint handed the loop back.
  const second = tick(5)
    .then(other)
    .then((r) => {
      otherDoneBeforeLint = !lintDone;
      return r;
    });
  const [, o] = await Promise.all([main, second]);
  clearInterval(timer);
  expect(o.ok).toBe(true);
  expect(ticks.length, "timer ticks during the lint").toBeGreaterThanOrEqual(3);
  expect(otherDoneBeforeLint, "read_note finished while the lint was running").toBe(true);
}

describe("lint_wiki does not hold the event loop", () => {
  it("a timer and a concurrent tool call are serviced mid-lint", async () => {
    const hh = bigVault();
    await serviced(
      async () => {
        const r = await hh.call("lint_wiki", {
          checks: ["orphans", "unresolved_links", "missing_sources", "contradictions"],
        });
        expect(r.ok).toBe(true);
      },
      () => hh.call("read_note", { path: "hub.md" }),
    );
  }, 60_000);

  it("an aborted ctx.signal stops the lint between notes", async () => {
    const hh = bigVault();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    const r = await hh.v.call(
      "lint_wiki",
      { vault: "test", checks: ["orphans", "unresolved_links", "missing_sources"] },
      { signal: ac.signal },
    );
    // Not a `skipped` check: the abort is the call's own outcome.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("aborted");
  }, 60_000);
});

describe("the scheduled wiki lint does not hold the event loop", () => {
  function sweep(hh: WikiHarness, reports: LintReport[]) {
    let task: { run: (s: AbortSignal) => Promise<void> } | undefined;
    registerWikiLintSweep({ register: (t: never) => (task = t) } as never, {
      cacheDb: hh.v.db,
      vaults: [{ id: "test", root: hh.v.root, wikiFolder: "wiki" }],
      exclusionFor: () => NO_EXCLUSION,
      embeddingModel: "stub:4",
      intervalMs: 1000,
      maxNotes: 100,
      onReport: (r) => reports.push(r),
    });
    if (!task) throw new Error("sweep not registered");
    return task;
  }

  it("a timer and a concurrent tool call are serviced mid-tick", async () => {
    const hh = bigVault();
    const reports: LintReport[] = [];
    const task = sweep(hh, reports);
    await serviced(
      () => task.run(new AbortController().signal),
      () => hh.call("read_note", { path: "hub.md" }),
    );
    expect(reports).toHaveLength(1);
  }, 60_000);

  it("a shutdown signal mid-tick stops the lint without reporting or throwing", async () => {
    const hh = bigVault();
    const reports: LintReport[] = [];
    const task = sweep(hh, reports);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await expect(task.run(ac.signal)).resolves.toBeUndefined();
    expect(reports).toHaveLength(0);
  }, 60_000);
});
