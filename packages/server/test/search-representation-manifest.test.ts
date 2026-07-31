import { describe, expect, it } from "vitest";
import {
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  MANIFEST_HASH_VERSION,
  manifestVecFingerprint,
  type RepresentationManifest,
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
