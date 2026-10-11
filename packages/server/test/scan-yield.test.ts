// The whole-vault link scans (vault_health_score, find_orphans, find_unresolved_links,
// find_link_cycles, plus get_backlinks, audit_provenance and the graph-backed link tools) used to
// read and parse every note in one synchronous run: on a 20 000-note vault that held the event loop
// for ~6-8 s, so a timer, another tool call and SIGTERM all waited behind it. They now yield a
// macrotask every few notes. RED before the change: no timer tick and no second call is serviced
// until the scan returns.
import { describe, expect, it } from "vitest";
import { drainSteps, drainYielding } from "../src/util/scan-steps";
import { scanFixtureFiles } from "./fixtures/scan-yield-vault";
import { makeTestVault } from "./m1-helpers";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Enough notes that one synchronous pass takes a few hundred ms on a slow runner. */
function bigVault() {
  return makeTestVault({ files: scanFixtureFiles(2500) });
}

const SCANS: Array<[string, Record<string, unknown>]> = [
  ["vault_health_score", {}],
  ["find_orphans", {}],
  ["find_unresolved_links", {}],
  ["find_link_cycles", {}],
  ["get_backlinks", { path: "hub.md" }],
  ["audit_provenance", {}],
];

describe("whole-vault scans do not hold the event loop", () => {
  for (const [tool, input] of SCANS) {
    it(`${tool}: a timer and a concurrent tool call are serviced mid-scan`, async () => {
      const v = bigVault();
      try {
        let scanDone = false;
        const ticks: number[] = [];
        const timer = setInterval(() => {
          if (!scanDone) ticks.push(performance.now());
        }, 2);
        let otherDoneBeforeScan = false;
        const scan = v.call(tool, { vault: "test", ...input }).then((r) => {
          scanDone = true;
          return r;
        });
        // Issued from a macrotask: it can only run if the scan handed the loop back.
        const other = tick(5)
          .then(() => v.call("read_note", { vault: "test", path: "hub.md" }))
          .then((r) => {
            otherDoneBeforeScan = !scanDone;
            return r;
          });
        const [r, o] = await Promise.all([scan, other]);
        clearInterval(timer);
        expect(r.ok).toBe(true);
        expect(o.ok).toBe(true);
        expect(ticks.length, "timer ticks during the scan").toBeGreaterThanOrEqual(3);
        expect(otherDoneBeforeScan, "read_note finished while the scan was running").toBe(true);
      } finally {
        v.cleanup();
      }
    }, 60_000);
  }
});

describe("scan abort", () => {
  it("an aborted ctx.signal stops the scan between notes", async () => {
    const v = bigVault();
    try {
      const t0 = performance.now();
      const full = await v.call("find_orphans", { vault: "test" });
      const fullMs = performance.now() - t0;
      expect(full.ok).toBe(true);

      const ac = new AbortController();
      setTimeout(() => ac.abort(), Math.max(5, fullMs / 10));
      const t1 = performance.now();
      const r = await v.call("find_orphans", { vault: "test" }, { signal: ac.signal });
      const abortedMs = performance.now() - t1;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("aborted");
      expect(abortedMs).toBeLessThan(fullMs * 0.7);
    } finally {
      v.cleanup();
    }
  }, 60_000);

  it("drainYielding rejects on an already-aborted signal before taking a step", async () => {
    const ac = new AbortController();
    ac.abort();
    let steps = 0;
    function* gen(): Generator<void, number, void> {
      for (let i = 0; i < 100; i++) {
        steps++;
        yield;
      }
      return 1;
    }
    await expect(drainYielding(gen(), ac.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(steps).toBe(0);
  });
});

describe("scan steps", () => {
  function* counting(n: number): Generator<void, number, void> {
    for (let i = 0; i < n; i++) yield;
    return n;
  }

  it("drainSteps and drainYielding return the same value", async () => {
    expect(drainSteps(counting(100))).toBe(100);
    expect(await drainYielding(counting(100), undefined)).toBe(100);
  });

  it("hands the loop back on a real macrotask turn, with or without a signal", async () => {
    for (const signal of [undefined, new AbortController().signal]) {
      let ran = false;
      setImmediate(() => {
        ran = true;
      });
      await drainYielding(counting(3), signal, 0);
      expect(ran).toBe(true);
    }
    let ranSync = false;
    setImmediate(() => {
      ranSync = true;
    });
    drainSteps(counting(3));
    expect(ranSync).toBe(false);
    await new Promise<void>((r) => setImmediate(r));
  });
});
