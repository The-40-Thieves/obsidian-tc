import { describe, expect, it } from "vitest";
import { type VecFingerprint, vecFingerprint } from "../src/search/representation";

const BASE: VecFingerprint = {
  provider: "openai-compatible",
  model: "BAAI/bge-m3",
  dimensions: 1024,
  distanceMetric: "cosine",
  enrichmentVersion: 0,
  chunkerVersion: 1,
  schemaGen: "v1",
};

describe("revision in the vec fingerprint", () => {
  it("a declared revision changes the fingerprint", () => {
    expect(vecFingerprint({ ...BASE, revision: "abc123" })).not.toBe(vecFingerprint(BASE));
  });
  it("two different revisions differ", () => {
    expect(vecFingerprint({ ...BASE, revision: "abc123" })).not.toBe(
      vecFingerprint({ ...BASE, revision: "def456" }),
    );
  });
  it("an absent revision is byte-identical to today's fingerprint", () => {
    // Back-compat: an existing index must NOT rebuild merely because this feature landed.
    expect(vecFingerprint({ ...BASE, revision: undefined })).toBe(vecFingerprint(BASE));
  });
});
