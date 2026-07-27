// THE-458 perf gate — SQLite write-lock contention.
//
// The instrument under test is NOT new: `inWriteTransaction` has measured lock wait correctly since
// THE-585 #5. What was missing is anything that ever watched it FIRE. That distinction is the whole
// reason this file exists — on this project the same histogram was independently zeroed by three
// layers (a deployed image predating the metric, `prometheus.enabled` defaulting false, and a scrape
// config with no targets), and every one of them looks identical to "no contention" from outside.
//
// So these tests assert the probe genuinely contends, not merely that it returns numbers.
import { describe, expect, it } from "vitest";
import { collectLock } from "../eval/perf/collectors/lock";

describe("collectLock — the instrument fires under real contention", () => {
  it("observes a non-zero wait, a busy failure, and a wait at least as long as the timeout", async () => {
    // One run, three claims, because they fail for different reasons:
    //   wait_observed=0        -> the instrument stopped reporting (or the write path went back to a
    //                             deferred BEGIN, which takes no lock and reports ~0 forever)
    //   busy_observed=0        -> the probe stopped CONTENDING; wait_observed could then still pass
    //                             on a fast uncontended acquisition
    //   at_least_timeout=0     -> it returned early, so it never really waited
    const by = new Map((await collectLock()).map((m) => [m.key, m]));
    expect(by.get("storage.lock_wait_observed")?.value).toBe(1);
    expect(by.get("storage.lock_busy_observed")?.value).toBe(1);
    expect(by.get("storage.lock_wait_at_least_timeout")?.value).toBe(1);
  }, 20_000);

  it("reports a wait AT OR ABOVE busy_timeout, never below — a timeout overshoots itself", async () => {
    // Measured across adapters: 200→201.5ms, 1000→1003.8ms, 5000→5006.1ms. A bucket set AT the
    // timeout can therefore never contain a timed-out acquisition, which is why production's
    // histogram tops out at 10s against a 5s timeout. Asserting `>=` rather than a tidy equality is
    // the point — an exact-value test would hide the overshoot entirely.
    const by = new Map((await collectLock()).map((m) => [m.key, m]));
    const waitMs = by.get("storage.lock_wait_ms")?.value ?? 0;
    expect(waitMs).toBeGreaterThanOrEqual(250);
    // Sanity ceiling: a wildly larger number means something other than our timeout governed the
    // wait, and the metric would be measuring the wrong thing while still looking plausible.
    expect(waitMs).toBeLessThan(5_000);
  }, 20_000);

  it("classes the two structural claims HARD and the wall-clock one WARN", async () => {
    // Deliberate split. The booleans are deterministic facts about whether contention happened, so
    // they can block. The millisecond figure is wall-clock on shared CI hardware and must not —
    // every other timing figure in this harness is warn for the same reason.
    const by = new Map((await collectLock()).map((m) => [m.key, m]));
    expect(by.get("storage.lock_wait_observed")?.class).toBe("hard");
    expect(by.get("storage.lock_busy_observed")?.class).toBe("hard");
    expect(by.get("storage.lock_wait_at_least_timeout")?.class).toBe("hard");
    expect(by.get("storage.lock_wait_ms")?.class).toBe("warn");
  }, 20_000);

  it("is baselined, or the gate would treat it as informational and never fail", async () => {
    // gate.ts walks the BASELINE, not the report: "Samples present in the report but absent from the
    // baseline remain informational — a new metric is not yet a promise." A collector that emits
    // perfect metrics nobody baselined is exactly the shape of gate this ticket exists to fix.
    const baseline = (await import("../eval/perf/baseline.small.json")).default as Record<
      string,
      { class: string }
    >;
    for (const k of [
      "storage.lock_wait_observed",
      "storage.lock_busy_observed",
      "storage.lock_wait_at_least_timeout",
      "storage.lock_wait_ms",
    ]) {
      expect(baseline[k], `${k} must be baselined to be gated`).toBeDefined();
    }
    expect(baseline["storage.lock_wait_observed"]?.class).toBe("hard");
  });
});
