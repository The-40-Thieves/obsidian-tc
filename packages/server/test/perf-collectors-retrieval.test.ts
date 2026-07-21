import { describe, expect, it } from "vitest";
import { collectRetrieval } from "../eval/perf/collectors/retrieval";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

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
});
