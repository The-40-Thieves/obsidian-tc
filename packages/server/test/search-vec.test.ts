import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import {
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
  type VecFingerprint,
  vecFingerprint,
} from "../src/search/representation";
import { blobToFloats, ensureVecChunks, floatBlob, loadVec } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

function fp(overrides: Partial<VecFingerprint> = {}): VecFingerprint {
  return {
    provider: "fake",
    model: "model-a",
    dimensions: 768,
    distanceMetric: VEC_DISTANCE_METRIC,
    enrichmentVersion: 0,
    chunkerVersion: CHUNKER_VERSION,
    schemaGen: VEC_SCHEMA_GEN,
    ...overrides,
  };
}

describe("vector blob codec", () => {
  it("round-trips a float vector through the float32 blob format", () => {
    const v = [0.5, -0.25, 0, 1, 0.125];
    const back = blobToFloats(floatBlob(v));
    expect(back).toHaveLength(v.length);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i] ?? 0, 6);
  });
  it("encodes exactly 4 bytes per dimension", () => {
    expect(floatBlob([1, 2, 3]).byteLength).toBe(12);
  });
});

// node:sqlite (the vitest runtime) opens without allowExtension, so the whole
// sqlite-vec path must degrade silently to false rather than throw. The real
// vec0 KNN behavior is exercised under bun:sqlite in the bun-smoke job.
describe("sqlite-vec degradation under node:sqlite", () => {
  it("loadVec returns false instead of throwing", () => {
    expect(loadVec(openMemoryDb())).toBe(false);
  });
  it("ensureVecChunks returns false and records no migration row", () => {
    const db = openMemoryDb();
    runMigrations(db, []);
    expect(ensureVecChunks(db, fp())).toBe(false);
    const row = db.prepare("SELECT count(*) c FROM schema_migrations").get() as { c: number };
    expect(row.c).toBe(0);
  });
});

describe("VecFingerprint (THE-460: full representation fingerprint, not just dims)", () => {
  it("produces a stable string that changes when any field changes", () => {
    const base = fp();
    const s1 = vecFingerprint(base);
    expect(vecFingerprint(base)).toBe(s1); // stable/deterministic
    expect(vecFingerprint({ ...base, model: "model-b" })).not.toBe(s1); // same-dim model swap
    expect(vecFingerprint({ ...base, dimensions: 1024 })).not.toBe(s1); // dimension change
    expect(vecFingerprint({ ...base, enrichmentVersion: ENRICHMENT_VERSION })).not.toBe(s1); // chunkContext toggled on
    expect(vecFingerprint({ ...base, chunkerVersion: base.chunkerVersion + 1 })).not.toBe(s1); // chunker bump
    expect(vecFingerprint({ ...base, schemaGen: "other-shape" })).not.toBe(s1); // schema-gen bump
    expect(vecFingerprint({ ...base, distanceMetric: "l2" })).not.toBe(s1); // metric change
    expect(vecFingerprint({ ...base, revision: "rev1" })).not.toBe(s1); // revision set
  });

  // Under node:sqlite, loadVec/ensureVecChunks can't exercise the real vec0 rebuild (see the
  // bun-smoke suite for that). This asserts the fingerprint-mismatch -> rebuild-decision INPUT at
  // the level that DOES run under node: ensureVecChunks still returns false (extension unloadable)
  // but the fingerprint comparison itself — which is what decides a same-dimension model swap
  // must rebuild — is exercised directly via vecFingerprint() above and end-to-end under bun.
  it("a same-dimension model swap yields a different fingerprint than the original", () => {
    const original = fp({ model: "model-a", dimensions: 768 });
    const swapped = fp({ model: "model-b", dimensions: 768 });
    expect(original.dimensions).toBe(swapped.dimensions); // same dims, by construction
    expect(vecFingerprint(original)).not.toBe(vecFingerprint(swapped));
  });
});
