import { describe, expect, it } from "vitest";
import {
  buildRepresentationManifest,
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  MANIFEST_HASH_VERSION,
  manifestVecFingerprint,
  type RepresentationManifest,
  representationFingerprint,
  representationManifestHash,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
  vecFingerprint,
} from "../src/search/representation";

// The old `${provider}:${model}` id (embeddings/providers.ts) this manifest replaces as the
// STRONGER representation identity. Every field below except provider/model/dimensions is
// something that id silently ignored.
function manifest(overrides: Partial<RepresentationManifest> = {}): RepresentationManifest {
  return {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    distanceMetric: VEC_DISTANCE_METRIC,
    enrichmentVersion: ENRICHMENT_VERSION,
    chunkerVersion: CHUNKER_VERSION,
    schemaGen: VEC_SCHEMA_GEN,
    revision: "unknown",
    pooling: "unknown",
    queryPrefix: "",
    documentPrefix: "",
    truncate: false,
    maxInputTokens: "unknown",
    multiVector: false,
    normalized: "unknown",
    ...overrides,
  };
}

describe("RepresentationManifest / representationManifestHash", () => {
  it("distinguishes a revision the old provider:model id ignored", () => {
    const base = manifest();
    const revved = manifest({ revision: "abcd1234" });
    expect(representationManifestHash(revved)).not.toBe(representationManifestHash(base));
  });

  it("distinguishes a query/document prefix the old provider:model id ignored", () => {
    const base = manifest();
    const withQueryPrefix = manifest({ queryPrefix: "Instruct: retrieve\nQuery: " });
    const withDocPrefix = manifest({ documentPrefix: "passage: " });
    expect(representationManifestHash(withQueryPrefix)).not.toBe(representationManifestHash(base));
    expect(representationManifestHash(withDocPrefix)).not.toBe(representationManifestHash(base));
    expect(representationManifestHash(withQueryPrefix)).not.toBe(
      representationManifestHash(withDocPrefix),
    );
  });

  it("distinguishes a truncation policy the old provider:model id ignored", () => {
    const base = manifest();
    const truncated = manifest({ truncate: true });
    expect(representationManifestHash(truncated)).not.toBe(representationManifestHash(base));
  });

  // Rounding out the fields the id ignored beyond the three above.
  it("distinguishes pooling, multi-vector-ness, and normalization", () => {
    const base = manifest();
    expect(representationManifestHash(manifest({ pooling: "mean" }))).not.toBe(
      representationManifestHash(base),
    );
    expect(representationManifestHash(manifest({ multiVector: true }))).not.toBe(
      representationManifestHash(base),
    );
    expect(representationManifestHash(manifest({ normalized: true }))).not.toBe(
      representationManifestHash(base),
    );
  });

  it("is independent of the object literal's key insertion order", () => {
    const a: RepresentationManifest = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: ENRICHMENT_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
      revision: "abcd1234",
      pooling: "last-token",
      queryPrefix: "q: ",
      documentPrefix: "",
      truncate: true,
      maxInputTokens: 8192,
      multiVector: true,
      normalized: true,
    };
    // Same values, reverse insertion order — a fresh object literal, not a copy of `a`.
    const b: RepresentationManifest = {
      normalized: true,
      multiVector: true,
      maxInputTokens: 8192,
      truncate: true,
      documentPrefix: "",
      queryPrefix: "q: ",
      pooling: "last-token",
      revision: "abcd1234",
      schemaGen: VEC_SCHEMA_GEN,
      chunkerVersion: CHUNKER_VERSION,
      enrichmentVersion: ENRICHMENT_VERSION,
      distanceMetric: VEC_DISTANCE_METRIC,
      dimensions: 1536,
      model: "text-embedding-3-small",
      provider: "openai",
    };
    expect(representationManifestHash(a)).toBe(representationManifestHash(b));
  });

  it("hashes a known-absent field differently from an omitted one", () => {
    const known = manifest({ revision: "unknown" });
    // Simulate a manifest built before `revision` existed — the key is genuinely ABSENT, not
    // merely set to the sentinel. Bypass the type (which requires the field) to construct that
    // shape directly, the same way an older caller's object literal would.
    const omitted = { ...known } as Partial<RepresentationManifest>;
    delete omitted.revision;
    expect(representationManifestHash(omitted as RepresentationManifest)).not.toBe(
      representationManifestHash(known),
    );
  });

  it("is stable and deterministic for the same manifest", () => {
    const m = manifest({ revision: "abcd1234" });
    expect(representationManifestHash(m)).toBe(representationManifestHash(manifest({ ...m })));
  });

  it("prefixes the hash with the current MANIFEST_HASH_VERSION", () => {
    expect(representationManifestHash(manifest())).toMatch(
      new RegExp(`^v${MANIFEST_HASH_VERSION}:[0-9a-f]{64}$`),
    );
  });
});

describe("manifestVecFingerprint (no-reindex guarantee)", () => {
  // The default embeddings config (packages/shared/src/config/indexing-embeddings.schema.ts):
  // provider "ollama", model "nomic-embed-text", dimensions 768, chunkContext true (so
  // enrichmentVersion === ENRICHMENT_VERSION), truncate false, both prefixes "". This is the
  // representation `ensureVecChunks` already builds and persists today via
  // runtime/indexing-wiring.ts / search/indexing/index-vault.ts.
  function defaultConfigManifest(): RepresentationManifest {
    return {
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: ENRICHMENT_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
      revision: "unknown", // no adapter in embeddings/providers.ts reports one
      pooling: "unknown",
      queryPrefix: "",
      documentPrefix: "",
      truncate: false,
      maxInputTokens: "unknown",
      multiVector: false, // ollamaProvider has no embedFull
      normalized: "unknown",
    };
  }

  it("projects to the exact VecFingerprint ensureVecChunks builds for the default config today", () => {
    const projected = manifestVecFingerprint(defaultConfigManifest());
    const liveConfigFingerprint = vecFingerprint({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: ENRICHMENT_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
      // no revision field — no call site in the repo passes one today.
    });
    expect(vecFingerprint(projected)).toBe(liveConfigFingerprint);
    // Literal, so a future change to any constant folded in here is loud rather than only
    // detected by a relative comparison that could drift alongside a bug.
    expect(vecFingerprint(projected)).toBe("ollama|nomic-embed-text|768|cosine|1|1|partition+aux|");
  });
});

// THE-683. `embeddings.pooling` was a validated, documented config key that reached NO consumer:
// its own .describe() had to admit it "does not affect the index". These pin the two halves of the
// fix — that a producer exists, and that what it produces actually reaches the stored identity.
describe("buildRepresentationManifest (THE-683: the production producer)", () => {
  const provider = { provider: "openai", model: "text-embedding-3-small", dimensions: 1536 };

  it("carries pooling through from config, instead of dropping it", () => {
    expect(buildRepresentationManifest(provider, { pooling: "mean" }).pooling).toBe("mean");
  });

  // THE COMPLAINT, closed. Before this, changing pooling changed nothing anywhere.
  it("a pooling change moves the STORED fingerprint", () => {
    const a = representationFingerprint(buildRepresentationManifest(provider, {}));
    const b = representationFingerprint(buildRepresentationManifest(provider, { pooling: "mean" }));
    expect(b).not.toBe(a);
  });

  it.each([
    ["revision", { revision: "chk2" }],
    ["queryPrefix", { queryPrefix: "Instruct: " }],
    ["documentPrefix", { documentPrefix: "passage: " }],
    ["truncate", { truncate: true }],
    ["chunkContext", { chunkContext: true }],
  ])("a %s change moves the stored fingerprint too", (_name, cfg) => {
    const base = representationFingerprint(buildRepresentationManifest(provider, {}));
    expect(representationFingerprint(buildRepresentationManifest(provider, cfg))).not.toBe(base);
  });

  // multiVector is derived from the PROVIDER, not config: a provider with the sparse/ColBERT heads
  // stores different data for the same text, so it must not share an index with a dense-only one.
  it("a provider that gains embedFull moves the fingerprint", () => {
    const dense = representationFingerprint(buildRepresentationManifest(provider, {}));
    const multi = representationFingerprint(
      buildRepresentationManifest({ ...provider, embedFull: () => [] }, {}),
    );
    expect(multi).not.toBe(dense);
    expect(buildRepresentationManifest({ ...provider, embedFull: () => [] }, {}).multiVector).toBe(
      true,
    );
  });

  // A field the config surface genuinely cannot report must be the literal "unknown" — never
  // omitted, and never a plausible-looking default that would collide with a real measurement.
  it("reports unreportable axes as the explicit 'unknown' sentinel", () => {
    const m = buildRepresentationManifest(provider, {});
    expect(m.revision).toBe("unknown");
    expect(m.pooling).toBe("unknown");
    expect(m.maxInputTokens).toBe("unknown");
    expect(m.normalized).toBe("unknown");
    // These four ARE knowable, so "" / false are real values rather than gaps.
    expect(m.queryPrefix).toBe("");
    expect(m.documentPrefix).toBe("");
    expect(m.truncate).toBe(false);
    expect(m.multiVector).toBe(false);
  });

  // The producer is the single derivation — that is what makes it impossible for boot and the
  // index_vault tool to disagree about the identity of the table they share. Same inputs in, byte
  // -identical fingerprint out, is the property both call sites now rely on.
  it("is deterministic: the same inputs yield the identical fingerprint", () => {
    const cfg = { pooling: "mean", revision: "chk2", chunkContext: true, queryPrefix: "q: " };
    expect(representationFingerprint(buildRepresentationManifest(provider, cfg))).toBe(
      representationFingerprint(buildRepresentationManifest(provider, cfg)),
    );
  });
});

describe("representationFingerprint", () => {
  // A strict SUFFIX extension of vecFingerprint's field order, so a legacy stored string is a
  // prefix of the new one — which is what makes a mismatch legible to a human reading the two.
  it("begins with exactly the legacy vecFingerprint string", () => {
    const m = manifest({ revision: "chk2" });
    expect(representationFingerprint(m).startsWith(vecFingerprint(manifestVecFingerprint(m)))).toBe(
      true,
    );
  });

  it("collapses an 'unknown' sentinel to the empty field, never the literal text", () => {
    expect(representationFingerprint(manifest())).not.toContain("unknown");
  });
});
