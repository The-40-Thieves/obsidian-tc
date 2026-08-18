// THE-645: end-to-end wiring of index_vault's in-flight progress into get_index_status — mirrors
// runtime/tool-wiring.ts's wireDomainTools/wireHealthTools wiring (onProgress sets indexHealth's
// in-flight entry; onIndexVaultComplete/onIndexVaultError both clear it) so a real registry dispatch
// of index_vault, observed concurrently through a real registry dispatch of get_index_status,
// exercises the exact wiring production uses rather than a hand-fed value.
import { describe, expect, it } from "vitest";
import { deterministicVector, fakeEmbeddingProvider } from "../src/embeddings";
import { createIndexStatusTool, type IndexInFlightInfo } from "../src/tools/admin/health";
import { makeM2Vault } from "./m2-helpers";

/** A deferred promise the test releases by hand, to hold a provider call mid-flight (mirrors
 *  test/index-coordinator.test.ts's helper). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Dispatch's full pipeline (parse/auth/scope/ACL/idempotency/throttle gates, then the handler's
 *  own synchronous walk of 100+ notes) runs across many chained microtask hops before the first
 *  gated provider.embed() call is even reached — empirically ~100-130 `Promise.resolve()` ticks
 *  for this fixture, not a handful. Polling a real condition with a generous bound is what makes
 *  this robust rather than tuned to one measured number. */
async function pollUntil(predicate: () => boolean, maxIters = 5000): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`pollUntil: condition not met within ${maxIters} microtask ticks`);
}

describe("index_vault in-flight progress -> get_index_status (THE-645)", () => {
  it("a concurrent get_index_status call mid-run observes growing progress, cleared on completion", async () => {
    // DEFAULT_BATCH_MAX_NOTES is 100 (index-vault.ts) — 120 notes forces exactly two flush()
    // batches (100, then 20), so there is a real window between the first batch's onProgress and
    // the run's completion in which in_flight is non-zero but not yet final.
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) files[`n${i}.md`] = `note number ${i} unique body text`;

    let embedCalls = 0;
    const gate = deferred();
    const provider = {
      ...fakeEmbeddingProvider({ dimensions: 8 }),
      embed: async (texts: string[]): Promise<number[][]> => {
        embedCalls += 1;
        if (embedCalls === 2) await gate.promise; // pause the SECOND (final) batch's embed
        return texts.map((t) => deterministicVector(t, 8));
      },
    };

    let inFlight: IndexInFlightInfo | null = null;
    const v = makeM2Vault({
      files,
      provider,
      onProgress: (vaultId, p) => {
        inFlight = { vault: vaultId, ...p };
      },
      onIndexVaultComplete: () => {
        inFlight = null;
      },
      onIndexVaultError: () => {
        inFlight = null;
      },
    });
    v.registry.register(
      createIndexStatusTool({
        vecEnabled: false,
        ftsEnabled: false,
        getIndexHealth: () => ({ reconcile: "ok", reconcile_at: 1, write_failures: 0 }),
        getLastChunksUpserted: () => null,
        getInFlightProgress: () => inFlight,
      }),
    );

    try {
      const runPromise = v.call("index_vault", { vault: v.id });
      // First batch (100 notes) has committed and reported progress; the second batch's embed()
      // call is parked on the gate, so the run is genuinely still in flight here.
      await pollUntil(() => embedCalls >= 2);
      const midStatus = await v.call("get_index_status", {});
      expect(midStatus.ok).toBe(true);
      const midData = (midStatus.ok ? midStatus.data : {}) as { in_flight?: IndexInFlightInfo };
      expect(midData.in_flight).toBeDefined();
      expect(midData.in_flight?.notesProcessed).toBeGreaterThan(0);
      expect(midData.in_flight?.notesProcessed).toBeLessThan(120);
      expect(midData.in_flight?.chunksUpserted).toBeGreaterThan(0);

      gate.resolve();
      const res = await runPromise;
      expect(res.ok).toBe(true);

      const finalStatus = await v.call("get_index_status", {});
      const finalData = (finalStatus.ok ? finalStatus.data : {}) as {
        in_flight?: IndexInFlightInfo;
      };
      expect(finalData.in_flight).toBeUndefined();
    } finally {
      v.cleanup();
    }
  });

  it("get_index_status shows in_flight cleared, not stuck, after index_vault rejects", async () => {
    const files = { "a.md": "alpha", "b.md": "bravo" };
    const provider = {
      ...fakeEmbeddingProvider({ dimensions: 8 }),
      embed: async (): Promise<number[][]> => {
        throw new Error("boom — provider outage");
      },
    };

    let inFlight: IndexInFlightInfo | null = null;
    const v = makeM2Vault({
      files,
      provider,
      onProgress: (vaultId, p) => {
        inFlight = { vault: vaultId, ...p };
      },
      onIndexVaultComplete: () => {
        inFlight = null;
      },
      onIndexVaultError: () => {
        inFlight = null;
      },
    });
    v.registry.register(
      createIndexStatusTool({
        vecEnabled: false,
        ftsEnabled: false,
        getIndexHealth: () => ({ reconcile: "ok", reconcile_at: 1, write_failures: 0 }),
        getLastChunksUpserted: () => null,
        getInFlightProgress: () => inFlight,
      }),
    );

    try {
      const res = await v.call("index_vault", { vault: v.id });
      // The embed provider always throws, so the dispatch surfaces an error result — never a
      // stuck in_flight entry.
      expect(res.ok).toBe(false);

      const status = await v.call("get_index_status", {});
      const data = (status.ok ? status.data : {}) as { in_flight?: IndexInFlightInfo };
      expect(data.in_flight).toBeUndefined();
    } finally {
      v.cleanup();
    }
  });
});
