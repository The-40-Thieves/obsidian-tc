// THE-630: federated multi-vault search — the fan-out/fusion engine in search/federated_search.ts.
// Structural sibling of multi-query-fanout.test.ts (THE-448), on the vault axis instead of the
// query-phrasing axis: same two kinds of test.
//
//  - `fuseFederatedResults` unit tests: pure function, synthetic per-vault ranked lists, no DB —
//    pins down the rank-based RRF math and, the one thing that differs from fuseVariants, dedupe on
//    the COMPOSITE (vault, path) key rather than bare path (AC6: two vaults sharing a relative path
//    must both survive fusion as distinct, correctly-tagged entries, never merged into one).
//  - `runFederatedLegs`/`federatedGraphSearch` orchestration tests: synthetic `run` thunks prove
//    bounded concurrency and per-leg error isolation without a live DB or graphSearch call.
import { describe, expect, it } from "vitest";
import {
  type FederatedLeg,
  federatedGraphSearch,
  fuseFederatedResults,
  runFederatedLegs,
} from "../src/search/federated_search";
import type { GraphSearchResult } from "../src/search/graph_search";

function result(path: string, overrides: Partial<GraphSearchResult> = {}): GraphSearchResult {
  return {
    chunk_id: `c-${path}`,
    path,
    source: "seed",
    hop: 0,
    via_edge: null,
    root_seed: null,
    rerank_score: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fuseFederatedResults: pure RRF-across-vaults math, no DB.
// ---------------------------------------------------------------------------
describe("fuseFederatedResults (pure RRF-across-vaults fusion)", () => {
  it("scores a single vault's list by its own rank (1/(rrfK+rank)), preserving order, tagged with vault", () => {
    const legs = [{ vaultId: "a", results: [result("x.md"), result("y.md"), result("z.md")] }];
    const fused = fuseFederatedResults(legs, 10, 30);
    expect(fused.map((r) => [r.vault, r.path])).toEqual([
      ["a", "x.md"],
      ["a", "y.md"],
      ["a", "z.md"],
    ]);
  });

  // AC6: two vaults sharing a relative path must NEVER collapse into one entry — they are
  // different notes. This is the one place fusion here structurally differs from THE-448's
  // fuseVariants, which dedupes on bare `path` because every variant IS the same vault.
  it("two vaults sharing a relative path both survive, distinctly tagged — never merged (AC6)", () => {
    const legA = { vaultId: "vault-a", results: [result("shared/note.md", { chunk_id: "a-1" })] };
    const legB = { vaultId: "vault-b", results: [result("shared/note.md", { chunk_id: "b-1" })] };
    const fused = fuseFederatedResults([legA, legB], 10, 30);
    expect(fused).toHaveLength(2);
    const byVault = new Map(fused.map((r) => [r.vault, r]));
    expect(byVault.get("vault-a")?.chunk_id).toBe("a-1");
    expect(byVault.get("vault-b")?.chunk_id).toBe("b-1");
  });

  it("a path ranked #1 in TWO vaults outscores one ranked #1 in only one — but still two entries (AC6)", () => {
    // Both vaults rank their own "shared.md" #1: each contributes 1/(10+1) independently — RRF
    // does NOT accumulate across vaults the way it accumulates across query variants for the SAME
    // vault, because the (vault, path) key keeps them apart. Each entry's score is exactly its own
    // vault's contribution, not a sum.
    const legA = { vaultId: "a", results: [result("shared.md"), result("only-a.md")] };
    const legB = { vaultId: "b", results: [result("shared.md"), result("only-b.md")] };
    const fused = fuseFederatedResults([legA, legB], 10, 30);
    const shared = fused.filter((r) => r.path === "shared.md");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((r) => r.vault))).toEqual(new Set(["a", "b"]));
  });

  it("keeps the BEST-ranked occurrence's result object for a REPEAT within one vault's own list", () => {
    // graphSearch itself never emits a repeated path within one vault's ranked list, but the
    // accumulation branch is real code and worth pinning: same vault, same path, better rank wins.
    const bestHit = result("dup.md", { chunk_id: "c-dup-best" });
    const worstHit = result("dup.md", { chunk_id: "c-dup-worst" });
    const leg = { vaultId: "a", results: [bestHit, result("filler.md"), worstHit] };
    const fused = fuseFederatedResults([leg], 10, 30);
    const dup = fused.find((r) => r.path === "dup.md");
    expect(dup?.chunk_id).toBe("c-dup-best");
  });

  it("a vault that contributed nothing (empty list) does not break fusion", () => {
    const fused = fuseFederatedResults(
      [
        { vaultId: "a", results: [result("x.md")] },
        { vaultId: "b", results: [] },
        { vaultId: "c", results: [result("y.md")] },
      ],
      10,
      30,
    );
    expect(fused.map((r) => r.path).sort()).toEqual(["x.md", "y.md"]);
  });

  it("truncates the fused list to finalTopK", () => {
    const results = Array.from({ length: 20 }, (_, i) => result(`p${i}.md`));
    const fused = fuseFederatedResults([{ vaultId: "a", results }], 10, 5);
    expect(fused).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// runFederatedLegs / federatedGraphSearch orchestration: synthetic `run` thunks, no DB.
// ---------------------------------------------------------------------------
describe("runFederatedLegs / federatedGraphSearch orchestration", () => {
  it("runs every leg and returns per-vault outcomes positionally aligned with the input", async () => {
    const legs: FederatedLeg[] = [
      { vaultId: "a", run: async () => ({ results: [result("a1.md")] }) },
      { vaultId: "b", run: async () => ({ results: [result("b1.md")] }) },
    ];
    const outcomes = await runFederatedLegs(legs);
    expect(outcomes.map((o) => o.vaultId)).toEqual(["a", "b"]);
    expect(outcomes[0]?.results.map((r) => r.path)).toEqual(["a1.md"]);
    expect(outcomes[1]?.results.map((r) => r.path)).toEqual(["b1.md"]);
  });

  it("a leg that throws contributes empty results rather than failing the whole federated call", async () => {
    const legs: FederatedLeg[] = [
      {
        vaultId: "bad",
        run: async () => {
          throw new Error("embedding provider down for this vault");
        },
      },
      { vaultId: "good", run: async () => ({ results: [result("ok.md")] }) },
    ];
    const outcomes = await runFederatedLegs(legs);
    expect(outcomes.find((o) => o.vaultId === "bad")?.results).toEqual([]);
    expect(outcomes.find((o) => o.vaultId === "good")?.results.map((r) => r.path)).toEqual([
      "ok.md",
    ]);
  });

  it("carries caller-defined `meta` through untouched, per leg", async () => {
    const legs: FederatedLeg<{ mode: string }>[] = [
      { vaultId: "a", run: async () => ({ results: [], meta: { mode: "graph" } }) },
      { vaultId: "b", run: async () => ({ results: [], meta: { mode: "lexical-route" } }) },
    ];
    const outcomes = await runFederatedLegs(legs);
    expect(outcomes.find((o) => o.vaultId === "a")?.meta).toEqual({ mode: "graph" });
    expect(outcomes.find((o) => o.vaultId === "b")?.meta).toEqual({ mode: "lexical-route" });
  });

  it("respects the configured concurrency limit across vault legs", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { results: [] as GraphSearchResult[] };
    };
    const legs: FederatedLeg[] = Array.from({ length: 8 }, (_, i) => ({
      vaultId: `v${i}`,
      run,
    }));
    await runFederatedLegs(legs, { concurrency: 2 });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1); // proves it actually ran concurrently, not serially
  });

  it("defaults concurrency to 3 when unspecified", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const run = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { results: [] as GraphSearchResult[] };
    };
    const legs: FederatedLeg[] = Array.from({ length: 8 }, (_, i) => ({ vaultId: `v${i}`, run }));
    await runFederatedLegs(legs);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("federatedGraphSearch composes run + fuse: fused output is tagged and deduped by (vault, path)", async () => {
    const legs: FederatedLeg[] = [
      { vaultId: "a", run: async () => ({ results: [result("shared.md"), result("a-only.md")] }) },
      { vaultId: "b", run: async () => ({ results: [result("shared.md"), result("b-only.md")] }) },
    ];
    const { legOutcomes, fused } = await federatedGraphSearch(legs, 30);
    expect(legOutcomes).toHaveLength(2);
    const shared = fused.filter((r) => r.path === "shared.md");
    expect(shared).toHaveLength(2); // AC6: one per vault, never merged
    expect(fused.map((r) => r.path).sort()).toEqual([
      "a-only.md",
      "b-only.md",
      "shared.md",
      "shared.md",
    ]);
  });
});
