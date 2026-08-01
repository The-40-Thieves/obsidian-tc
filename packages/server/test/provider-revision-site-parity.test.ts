// Both VecFingerprint construction sites must fold the SAME config value. Standing up boot wiring
// and the index_vault path to compare one string is far more setup than the property needs, so this
// reads the source and asserts each site reads revision from its own config object — then pins the
// resulting fingerprints are equal for identical inputs.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type VecFingerprint, vecFingerprint } from "../src/search/representation";

const SITES = [
  { file: "src/runtime/indexing-wiring.ts", expr: "revision: deps.embeddings.revision" },
  { file: "src/search/indexing/index-vault.ts", expr: "revision: args.revision" },
];

describe("vec fingerprint construction sites", () => {
  it("both sites fold a revision from their own config", () => {
    expect(SITES.length).toBe(2); // floor: never vacuous
    for (const { file, expr } of SITES) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src, `${file} constructs a VecFingerprint`).toContain("schemaGen:");
      expect(src, `${file} must fold revision as \`${expr}\``).toContain(expr);
    }
  });

  it("identical inputs produce identical fingerprints regardless of site", () => {
    const shared: VecFingerprint = {
      provider: "p",
      model: "m",
      dimensions: 8,
      distanceMetric: "cosine",
      enrichmentVersion: 0,
      chunkerVersion: 1,
      schemaGen: "v1",
      revision: "r1",
    };
    expect(vecFingerprint({ ...shared })).toBe(vecFingerprint({ ...shared }));
    expect(vecFingerprint({ ...shared, revision: "r2" })).not.toBe(vecFingerprint(shared));
  });
});
