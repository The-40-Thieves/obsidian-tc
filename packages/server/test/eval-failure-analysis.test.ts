// Unit tests for the failure taxonomy (eval/failure_analysis.ts). Synthetic cases drive
// analyzeQuery through EACH of the six failing classes and assert the mapped v1.1 lever, plus the
// success branch and the recommendV11 aggregate. All inputs are plain data — no DB, no network.
import { describe, expect, it } from "vitest";
import { analyzeQuery, recommendV11 } from "../eval/failure_analysis";
import type { GoldenQuery, QueryMetrics, RankedChunk } from "../eval/metrics";

const query: GoldenQuery = {
  id: "q1",
  query_text: "how does s relate to t",
  seed_domain: "alpha",
  target_domain: "beta",
  seed_paths: ["s.md"],
  target_paths: ["t.md"],
  bridge_paths: [],
  description: "s -> t multi-hop",
};

/** QueryMetrics factory — only recall_at_10 and bridge_recall drive classification. */
function qm(recall: number, bridge: 0 | 1): QueryMetrics {
  return {
    query_id: "q1",
    recall_at_10: recall,
    mrr_at_10: 0,
    ndcg_at_10: 0,
    bridge_recall: bridge,
    bridge_ndcg_at_10: null,
    expected_found_in_top10: 0,
    expected_total: 2,
    bridge_satisfied: bridge === 1,
    result_paths_unique: 0,
  };
}

const chunk = (path: string, source?: RankedChunk["source"]): RankedChunk => ({
  chunk_id: `c-${path}-${source ?? "x"}`,
  path,
  ...(source ? { source } : {}),
});

const FAIL = qm(0, 0); // treatment fails both thresholds

describe("analyzeQuery — six failure classes + success, with mapped lever", () => {
  it("success -> none", () => {
    const a = analyzeQuery(
      query,
      qm(1, 1),
      qm(1, 1),
      [chunk("s.md")],
      [chunk("t.md")],
      new Set<string>(),
    );
    expect(a.failure_class).toBe("success");
    expect(a.recommended_v1_1_lever).toBe("none");
  });

  it("no_seeds -> sync_fix (no expected path in baseline at all)", () => {
    const a = analyzeQuery(query, FAIL, FAIL, [chunk("unrelated.md")], [], new Set<string>());
    expect(a.failure_class).toBe("no_seeds");
    expect(a.recommended_v1_1_lever).toBe("sync_fix");
  });

  it("ranking_miss -> golden_set_fix (target in baseline but seed never ranks)", () => {
    // baseline has the target path but NOT the seed path.
    const a = analyzeQuery(query, FAIL, FAIL, [chunk("t.md")], [], new Set<string>());
    expect(a.failure_class).toBe("ranking_miss");
    expect(a.recommended_v1_1_lever).toBe("golden_set_fix");
  });

  it("no_expansion -> llm_enrichment (seed found, zero expansion chunks)", () => {
    const a = analyzeQuery(
      query,
      FAIL,
      FAIL,
      [chunk("s.md")],
      [chunk("s.md", "seed")], // no source==='expansion' chunk
      new Set<string>(),
    );
    expect(a.failure_class).toBe("no_expansion");
    expect(a.recommended_v1_1_lever).toBe("llm_enrichment");
  });

  it("unreachable_in_graph -> llm_enrichment (expansion ran, target not reachable)", () => {
    const a = analyzeQuery(
      query,
      FAIL,
      FAIL,
      [chunk("s.md")],
      [chunk("s.md", "seed"), chunk("noise.md", "expansion")],
      new Set<string>(), // target not reachable in graph
    );
    expect(a.failure_class).toBe("unreachable_in_graph");
    expect(a.recommended_v1_1_lever).toBe("llm_enrichment");
  });

  it("intra_domain_expansion -> hub_noise_filter (target reachable but buried)", () => {
    const a = analyzeQuery(
      query,
      FAIL,
      FAIL,
      [chunk("s.md")],
      [chunk("s.md", "seed"), chunk("noise.md", "expansion")],
      new Set(["t.md"]), // target IS reachable in the graph, just not surfaced by expansion
    );
    expect(a.failure_class).toBe("intra_domain_expansion");
    expect(a.recommended_v1_1_lever).toBe("hub_noise_filter");
  });

  it("expansion_low_quality -> reranker_tuning (expansion reached target, still fails)", () => {
    const a = analyzeQuery(
      query,
      FAIL,
      FAIL,
      [chunk("s.md")],
      [chunk("s.md", "seed"), chunk("t.md", "expansion")], // expansion reached the target
      new Set(["t.md"]),
    );
    expect(a.failure_class).toBe("expansion_low_quality");
    expect(a.recommended_v1_1_lever).toBe("reranker_tuning");
  });
});

describe("recommendV11 — aggregate what-to-build-next", () => {
  it("counts classes/levers and picks the dominant + secondary lever", () => {
    const analyses = [
      analyzeQuery(query, FAIL, FAIL, [chunk("s.md")], [chunk("s.md", "seed")], new Set<string>()), // no_expansion -> llm_enrichment
      analyzeQuery(
        query,
        FAIL,
        FAIL,
        [chunk("s.md")],
        [chunk("s.md", "seed"), chunk("n.md", "expansion")],
        new Set<string>(), // unreachable_in_graph -> llm_enrichment
      ),
      analyzeQuery(
        query,
        FAIL,
        FAIL,
        [chunk("s.md")],
        [chunk("s.md", "seed"), chunk("n.md", "expansion")],
        new Set(["t.md"]), // intra_domain_expansion -> hub_noise_filter
      ),
      analyzeQuery(query, qm(1, 1), qm(1, 1), [chunk("s.md")], [chunk("t.md")], new Set<string>()), // success
    ];
    const reco = recommendV11(analyses);
    expect(reco.failures_by_lever.llm_enrichment).toBe(2);
    expect(reco.failures_by_lever.hub_noise_filter).toBe(1);
    expect(reco.failures_by_class.success).toBe(1);
    expect(reco.primary_lever).toBe("llm_enrichment");
    expect(reco.secondary_lever).toBe("hub_noise_filter");
    expect(reco.reasoning).toContain("3/4 queries did not meet");
  });

  it("recommends nothing when all queries pass", () => {
    const pass = analyzeQuery(
      query,
      qm(1, 1),
      qm(1, 1),
      [chunk("s.md")],
      [chunk("t.md")],
      new Set<string>(),
    );
    const reco = recommendV11([pass]);
    expect(reco.primary_lever).toBe("none");
    expect(reco.secondary_lever).toBe(null);
    expect(reco.reasoning).toContain("No v1.1 work indicated");
  });
});
