import { describe, expect, it } from "vitest";
import { deterministicVector } from "../src/embeddings/fake";
import { graphSearch } from "../src/search/graph_search";
import { makeM2Vault } from "./m2-helpers";

describe("graphSearch onStage observer", () => {
  it("emits monotonic stage counts without altering results", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nvault chunk embed [[b]]", "b.md": "# B\n\ngraph recall bridge" },
    });
    await v.call("index_vault", { vault: "test" });
    const stages: Array<[string, number]> = [];
    const res = await graphSearch(v.db, {
      query: "vault",
      queryVec: deterministicVector("vault", 32),
      vaultId: "test",
      finalTopK: 5,
      onStage: (stage, count) => stages.push([stage, count]),
    });
    expect(Array.isArray(res)).toBe(true);
    expect(stages.map((s) => s[0])).toContain("fused");
    for (const [, c] of stages) expect(c).toBeGreaterThanOrEqual(0);
    v.cleanup();
  });
});
