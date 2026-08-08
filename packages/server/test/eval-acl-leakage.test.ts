// THE-751: the ACL leakage gate must be able to FAIL. A gate that has only ever reported PASS
// proves nothing about the boundary it guards — it is indistinguishable from one wired to a
// constant, which is exactly the defect THE-699 found in the eval harness itself (an `isReadable`
// that two harnesses set to `() => true`, making an ACL filter and no ACL filter produce identical
// numbers).
//
// So these pin all three states explicitly, including the one that matters:
//   no predicate      -> null   ("not checked" — never 0, which would claim a clean result)
//   permissive        -> 0      (checked, nothing leaked)
//   restrictive       -> > 0    (checked, leaked — the gate fires)
//
// leaked_paths is a CORRECTNESS signal, not a quality metric: its expected value is exactly 0, so n
// does not bound its conclusiveness and there is no "not significant" reading of a leak.
import { describe, expect, it } from "vitest";
import { computeQueryMetrics, type GoldenQuery, type RankedChunk } from "../eval/metrics";

const QUERY: GoldenQuery = {
  id: "q-leak",
  query_text: "anything",
  seed_domain: "evergreen",
  target_domain: "evergreen",
  seed_paths: [],
  target_paths: ["notes/Attention.md"],
  bridge_paths: [],
  description: "leakage fixture",
};

// Two chunks from two notes: one inside an a-f whitelist, one outside it.
const RESULTS: RankedChunk[] = [
  { chunk_id: "c1", path: "notes/Attention.md" },
  { chunk_id: "c2", path: "notes/Zettelkasten.md" },
];

describe("ACL leakage accounting (THE-751)", () => {
  it("reports NULL when no ACL is in force — 'not checked' must not read as 'none'", () => {
    const m = computeQueryMetrics(QUERY, RESULTS);
    expect(m.leaked_paths).toBeNull();
    // The distinction is the point: a consumer that treats null as 0 would report a clean leakage
    // result for an arm where the boundary was never evaluated.
    expect(m.leaked_paths).not.toBe(0);
  });

  it("reports 0 when every returned path is readable", () => {
    const m = computeQueryMetrics(QUERY, RESULTS, () => true);
    expect(m.leaked_paths).toBe(0);
  });

  it("FIRES when a returned path is not readable — the gate can fail", () => {
    // An a-f whitelist: Attention.md is readable, Zettelkasten.md is not.
    const readable = (rel: string): boolean => /^notes\/[A-Fa-f]/.test(rel);
    const m = computeQueryMetrics(QUERY, RESULTS, readable);
    expect(m.leaked_paths).toBe(1);
  });

  it("counts every unreadable path, not just the first", () => {
    const m = computeQueryMetrics(QUERY, RESULTS, () => false);
    expect(m.leaked_paths).toBe(2);
    expect(m.result_paths_unique).toBe(2);
    // Leakage is bounded by the unique path count — it counts paths, never chunks, so a note
    // returning six chunks is one leak rather than six.
    expect(m.leaked_paths).toBeLessThanOrEqual(m.result_paths_unique);
  });

  it("is independent of relevance — a leaked path counts even when it is an expected target", () => {
    // Attention.md IS the expected target, so this query scores well. Leakage must not be
    // suppressed by a good ranking: returning content the caller cannot read is a defect
    // regardless of how relevant it was.
    const m = computeQueryMetrics(QUERY, RESULTS, () => false);
    expect(m.recall_at_10).toBeGreaterThan(0);
    expect(m.leaked_paths).toBe(2);
  });
});
