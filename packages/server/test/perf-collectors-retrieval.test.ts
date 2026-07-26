import { describe, expect, it } from "vitest";
import { collectRetrieval } from "../eval/perf/collectors/retrieval";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

function tableExists(
  v: { db: { prepare(sql: string): { get(...p: unknown[]): unknown } } },
  name: string,
): boolean {
  return (
    v.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

describe("retrieval collectors", () => {
  it("emits deterministic stage counts and bounded recall/ndcg", async () => {
    const v = await buildVault(SCENARIOS.small);
    const a = Object.fromEntries((await collectRetrieval(v)).map((s) => [s.key, s.value]));
    const b = Object.fromEntries((await collectRetrieval(v)).map((s) => [s.key, s.value]));
    expect(a["graph.candidates_fused"]).toBe(b["graph.candidates_fused"]); // deterministic
    expect(a["retrieval.recall_at10"]).toBeGreaterThanOrEqual(0);
    expect(a["retrieval.recall_at10"]).toBeLessThanOrEqual(1);
    v.cleanup();
  });

  // THE-418 incident: seeding chunk_colbert into the `small` vault inflated storage.bytes ~39% and
  // failed the CI-gated perf comparison against baseline.small.json (the measurement instrument
  // mutating the thing collectStorage measures). Fixed by moving ColBERT seeding to its own
  // `colbert` scenario. This pins BOTH halves of that fix directly against the collector, without
  // needing the full isolated perf gate (which cannot run on this host — dev-host calibration CV
  // fails its own threshold, see perf-baseline.yml):
  it("does not touch chunk_colbert on `small` (storage.bytes must stay untouched)", async () => {
    const v = await buildVault(SCENARIOS.small);
    const samples = Object.fromEntries((await collectRetrieval(v)).map((s) => [s.key, s.value]));
    expect(tableExists(v, "chunk_colbert")).toBe(false);
    expect(samples["retrieval.colbert_ms"]).toBeUndefined(); // emitted only on `colbert`, not a phantom 0
    v.cleanup();
  });

  it("seeds chunk_colbert and reports a genuinely non-zero retrieval.colbert_ms on `colbert`", async () => {
    const v = await buildVault(SCENARIOS.colbert);
    const samples = Object.fromEntries((await collectRetrieval(v)).map((s) => [s.key, s.value]));
    expect(tableExists(v, "chunk_colbert")).toBe(true);
    expect(samples["retrieval.colbert_ms"]).toBeGreaterThan(0);
    v.cleanup();
  });
});
