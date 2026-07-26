import { describe, expect, it } from "vitest";

import { collectDensification } from "../eval/perf/collectors/densification";
import type { VaultCtx } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

// The real densify build needs sqlite-vec, which node:sqlite (the vitest runtime) cannot load — so
// the end-to-end scenario is exercised in bun-smoke. What IS testable here, and is the part most
// worth pinning, is the collector's REFUSAL logic: the guards that turn a silently-skipped
// densification pass into a loud failure instead of a clean-looking baseline of zeros.
function stubVault(over: Partial<VaultCtx> & { edges?: Record<string, number> }): VaultCtx {
  const edges = over.edges ?? {};
  return {
    // countDerivedEdges issues one COUNT(*) with (vault_id, edge_type); the stub answers from the
    // `edges` map so a test can pose "the pass ran but built no graph" without a real index.
    db: {
      exec: () => undefined,
      prepare: (_sql: string) => ({
        run: () => ({ changes: 0 }),
        get: (..._p: unknown[]) => ({ n: edges[_p[1] as string] ?? 0 }),
        all: () => [],
      }),
    },
    root: "/tmp/none",
    vaultId: "densify",
    provider: { calls: 0, texts: 0 },
    stats: {},
    chunkCount: 200,
    writeTxnCount: 1,
    vecKnnCalls: 0,
    scenario: SCENARIOS.densify,
    indexMs: 42,
    cleanup: () => undefined,
    ...over,
  } as unknown as VaultCtx;
}

describe("densification collector (THE-581)", () => {
  it("emits nothing for a scenario without densification", () => {
    // The existing scenarios' metric sets — and therefore their committed baselines — must be
    // untouched by this family. Emitting a row of zeros would also gate nothing forever, since a
    // hard/exact 0 always matches a baseline 0.
    expect(collectDensification(stubVault({ scenario: SCENARIOS.small }))).toEqual([]);
  });

  it("throws when the kNN pass did not execute", () => {
    expect(() =>
      collectDensification(stubVault({ vecKnnCalls: 0, edges: { similar_to: 5, shared_tag: 5 } })),
    ).toThrow(/ZERO vec0 KNN calls/);
  });

  it("throws when the pass ran but built no similarity graph", () => {
    expect(() =>
      collectDensification(stubVault({ vecKnnCalls: 200, edges: { shared_tag: 5 } })),
    ).toThrow(/ZERO similar_to edges/);
  });

  it("throws on an untagged corpus, where tag co-occurrence measures nothing", () => {
    expect(() =>
      collectDensification(stubVault({ vecKnnCalls: 200, edges: { similar_to: 5 } })),
    ).toThrow(/ZERO shared_tag edges/);
  });

  it("emits the gated cost + edge metrics when the pass really ran", () => {
    const samples = collectDensification(
      stubVault({ vecKnnCalls: 200, edges: { similar_to: 533, shared_tag: 865 } }),
    );
    const byKey = Object.fromEntries(samples.map((s) => [s.key, s]));
    expect(byKey["densify.vec_knn_calls"]?.value).toBe(200);
    expect(byKey["densify.edges_similar_to"]?.value).toBe(533);
    expect(byKey["densify.edges_shared_tag"]?.value).toBe(865);
    expect(byKey["densify.index_ms"]?.value).toBe(42);

    // The call count is a COST: gated hard so a regression fails, but higher-worse rather than
    // exact so a genuine improvement (the THE-486 shape) registers as a win instead of a violation.
    expect(byKey["densify.vec_knn_calls"]?.class).toBe("hard");
    expect(byKey["densify.vec_knn_calls"]?.direction).toBe("higher-worse");
    // The edge sets are CORRECTNESS: fewer edges is a different graph, not a faster one.
    expect(byKey["densify.edges_similar_to"]?.direction).toBe("exact");
    expect(byKey["densify.edges_shared_tag"]?.direction).toBe("exact");
    // Wall time stays warn, like every other latency figure in this harness.
    expect(byKey["densify.index_ms"]?.class).toBe("warn");
  });
});
