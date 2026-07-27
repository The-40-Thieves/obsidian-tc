// THE-458 item 6: reconcile outcome folding, extracted from cli.ts so it can be asserted at all.
//
// Every case below corresponds to a real defect in this path's history — none is hypothetical:
//   THE-288  a degraded index was invisible; server_health reads what this records
//   THE-390  a pass that COMPLETED but skipped notes must still degrade health
//   GH #171  a swallowed failure "presents as a permanent silent stall", hence stderr as well
//
// The recovery case is new: now that the reconcile runs on a SCHEDULE rather than only at boot,
// "degraded" has to be able to return to "ok" on a later pass. Before scheduling, that transition
// could not happen in a process lifetime, so nothing had ever exercised it.
import { describe, expect, it } from "vitest";
import { applyReconcileOutcome, type ReconcileHealth } from "../src/runtime/reconcile-outcome";

const NOW = 1_800_000_000_000;

function health(): ReconcileHealth {
  return { reconcile: "pending", reconcileAt: null, reconcileErrors: [] };
}
function harness() {
  const written: string[] = [];
  return { written, deps: { now: () => NOW, write: (s: string) => written.push(s) } };
}

describe("applyReconcileOutcome", () => {
  it("records ok and writes nothing when every vault succeeded", () => {
    const h = health();
    const { written, deps } = harness();
    const errs = applyReconcileOutcome([{ vault: "v1", error: null }], h, deps);
    expect(errs).toEqual([]);
    expect(h.reconcile).toBe("ok");
    expect(h.reconcileAt).toBe(NOW);
    expect(written).toEqual([]); // a clean pass must be silent, or the signal is worthless
  });

  it("degrades on a failure AND surfaces it on stderr (GH #171)", () => {
    // Both halves matter: in-memory health alone is only visible to an authenticated health call,
    // which is why a swallowed failure read as a permanent silent stall.
    const h = health();
    const { written, deps } = harness();
    applyReconcileOutcome([{ vault: "v1", error: "embed backend timeout" }], h, deps);
    expect(h.reconcile).toBe("degraded");
    expect(h.reconcileErrors).toEqual([{ vault: "v1", error: "embed backend timeout" }]);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('vault "v1"');
    expect(written[0]).toContain("embed backend timeout");
    // The message has to say what to DO, not just that something broke.
    expect(written[0]).toContain("embeddings.batchSize");
  });

  it("degrades if ANY vault failed, and reports only the failures", () => {
    const h = health();
    const { written, deps } = harness();
    applyReconcileOutcome(
      [
        { vault: "ok1", error: null },
        { vault: "bad", error: "boom" },
        { vault: "ok2", error: null },
      ],
      h,
      deps,
    );
    expect(h.reconcile).toBe("degraded");
    expect(h.reconcileErrors.map((e) => e.vault)).toEqual(["bad"]);
    expect(written).toHaveLength(1); // one line per FAILING vault, not per vault
  });

  it("RECOVERS to ok on a later pass — the case scheduling makes reachable", () => {
    // The load-bearing new test. Health is recomputed from THIS pass, not accumulated; otherwise a
    // single transient embed failure would pin the server to "degraded" until restart, and a
    // scheduled reconcile would make that a permanent lie rather than a boot-time one.
    const h = health();
    const { deps } = harness();
    applyReconcileOutcome([{ vault: "v1", error: "transient" }], h, deps);
    expect(h.reconcile).toBe("degraded");

    applyReconcileOutcome([{ vault: "v1", error: null }], h, deps);
    expect(h.reconcile).toBe("ok");
    expect(h.reconcileErrors).toEqual([]); // and the stale error is cleared, not left behind
  });

  it("does not go stale: reconcileAt advances on every pass", () => {
    // An operator reading `reconcileAt` needs it to mean "when we last checked", including the
    // passes that found nothing wrong.
    const h = health();
    let t = NOW;
    const deps = { now: () => t, write: () => {} };
    applyReconcileOutcome([{ vault: "v1", error: null }], h, deps);
    expect(h.reconcileAt).toBe(NOW);
    t = NOW + 60_000;
    applyReconcileOutcome([{ vault: "v1", error: null }], h, deps);
    expect(h.reconcileAt).toBe(NOW + 60_000);
  });

  it("treats an empty result set as ok rather than throwing", () => {
    // Reachable if every vault's promise rejected upstream and was filtered, or a zero-vault config
    // slipped past validation. It must not throw inside a background pass.
    const h = health();
    const { deps } = harness();
    expect(() => applyReconcileOutcome([], h, deps)).not.toThrow();
    expect(h.reconcile).toBe("ok");
  });
});
