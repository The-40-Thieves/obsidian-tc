// THE-417 Phase 1 end-state gate: every registered tool declares an `outputSchema`.
//
// The ticket is explicit that this test is an END-of-Phase-1 gate and NOT a driver — asserting it
// before adoption would simply have failed 150 times and told nobody anything. It goes in once the
// surface is covered, and from then on a new tool cannot land without a declared output contract.
//
// It reuses `buildFullRegistry()` from scripts/docgen rather than re-assembling the registry, which
// is the third place today that recipe would otherwise have been copied. THE-548 found the
// tool-count literal duplicated across two test files with only one of them read by the version
// gate; a duplicated 60-line assembly is the same failure with more surface.
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";

describe("THE-417: output-schema coverage", () => {
  it("every registered tool declares an outputSchema", () => {
    const missing = buildFullRegistry()
      .list()
      .filter((t) => !t.outputSchema)
      .map((t) => t.name)
      .sort();

    // Named rather than counted: a bare number tells whoever hits this nothing about which tool
    // they forgot, and the list is the actionable half.
    expect(missing, `tools without an outputSchema:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  // The coverage assertion above passes vacuously against an empty registry — the same
  // measures-nothing-while-green shape that let three gauges stay dead in THE-585. A floor makes
  // "assembled nothing" fail instead of reporting perfect coverage.
  it("checked a non-empty registry, so coverage is not vacuous", () => {
    expect(buildFullRegistry().list().length).toBeGreaterThan(100);
  });
});
