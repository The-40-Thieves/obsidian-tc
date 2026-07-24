// THE-566 — the narrative fact assert gate. Tests the PURE scanFacts (no filesystem, no registry
// build) so the contract is verifiable without a build, the same discipline that makes the gate
// trustworthy. The CLI half (currentFactRules / file walk) is a thin wrapper and is exercised by
// running `bun scripts/docgen/facts-check.ts` against the repo.
import { describe, expect, it } from "vitest";
import { factRules, scanFacts } from "../scripts/docgen/facts-check";

// The REAL production patterns, bound to test values — so these cases validate the shipped regexes.
const RULES = factRules(146, 250);

describe("scanFacts (THE-566 narrative fact gate)", () => {
  it("passes when narrative matches the current facts", () => {
    const text = [
      "The surface is 146 governed capabilities across 31 domains.",
      "Every ranking change is gated against a 250-query golden set.",
      "It exposes 146 tools across 31 domains.",
    ].join("\n");
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("flags a stale tool count with the line number", () => {
    const text = "One\nThe surface is 143 governed capabilities.\nThree";
    const v = scanFacts(text, RULES);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ fact: "toolCount", line: 2, found: 143, expected: 146 });
  });

  it("flags a stale golden-set size (n=136) on a golden line", () => {
    const v = scanFacts("gated against an n=136 golden set with a ship rule", RULES);
    expect(v).toEqual([
      expect.objectContaining({ fact: "goldenSetSize", found: 136, expected: 250 }),
    ]);
  });

  it("does NOT flag the 3-tool facade (a real, different fact)", () => {
    const text = [
      "**obsidian-tc** | 146 (3-tool facade)",
      "advertised by default through a three-tool facade",
      "the facade fronts the surface with 3 tools",
    ].join("\n");
    // "3-tool facade" / "3 tools" are not surface phrasings, so no false positive; the 146 passes.
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("does NOT flag an unrelated n= outside a golden line", () => {
    expect(scanFacts("with n=30 samples per bucket in the perf harness", RULES)).toEqual([]);
  });

  it("does NOT flag numbers embedded in tokens (G2.1, THE-135, r2, V1)", () => {
    // Every one of these was a false positive in the first dry run against the repo.
    const text = [
      "The complete G2.1 tool surface — 146 tools across 31 domains — is shipped.",
      "It inherits the G2.1 r2 tool surface from G1.",
      "the THE-135 query-time virtual-hop hit an 80% ceiling on the golden-set A/B",
      "the 128-tool G2.1 set plus post-1.0 additive tools",
    ].join("\n");
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("does NOT flag a milestone sub-count (anchored to 'across 31 domains')", () => {
    // M4's real contribution, not the surface total.
    expect(scanFacts("Plugin bridges — 20 tools across 9 domains — merged", RULES)).toEqual([]);
  });

  it("skips a line marked facts-check:ignore (intentional historical value)", () => {
    const text =
      "the golden set expanded 136 to 250 in July <!-- facts-check:ignore -->\nnext line 143 tools across 31 domains";
    const v = scanFacts(text, RULES);
    // line 1 ignored; line 2's stale 143 still caught
    expect(v).toEqual([expect.objectContaining({ fact: "toolCount", line: 2, found: 143 })]);
  });

  it("skips an entire file marked facts-check:ignore-file", () => {
    const text = "<!-- facts-check:ignore-file -->\n143 tools across 31 domains\nn=136 golden set";
    expect(scanFacts(text, RULES)).toEqual([]);
  });

  it("ignores numbers inside a GENERATED marker region (owned by injectGenerated)", () => {
    const text = [
      "<!-- BEGIN GENERATED: tools-summary -->",
      "143 governed capabilities", // a generated block is byte-owned elsewhere; not narrative
      "<!-- END GENERATED: tools-summary -->",
      "narrative says 143 tools across 31 domains", // this one IS narrative -> caught
    ].join("\n");
    const v = scanFacts(text, RULES);
    expect(v).toEqual([expect.objectContaining({ fact: "toolCount", line: 4, found: 143 })]);
  });

  it("reports every mismatch on a line, not just the first", () => {
    const text = "143 typed tools and a 200-query golden set";
    const v = scanFacts(text, RULES);
    expect(v.map((x) => x.fact).sort()).toEqual(["goldenSetSize", "toolCount"]);
  });
});
