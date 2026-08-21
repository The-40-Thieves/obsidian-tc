// THE-905: search-native.test.ts and native-fallback-parity.test.ts both compare the ACTIVE
// backend (native when built, else JS) against the JS reference — a comparison that holds
// whichever backend is active, so it never forces the native path to run. #855 shipped two
// callers that violated the native signature (Vec<f64>, Float32Array) while passing every
// existing test, because the CI lane those tests ran in never had the addon built. This suite
// calls the REAL compiled binding directly, with exactly the types NativeOps declares, so a
// signature drift is caught here rather than only tolerated by the lenient JS fallback.
import { describe, expect, it } from "vitest";
import { loadNative } from "../src/search/native";

// Empty env: OBSIDIAN_TC_FORCE_JS_FALLBACK in the ambient environment must not suppress this.
const native = loadNative({} as NodeJS.ProcessEnv);
const hasRougeLLcs = typeof native?.rougeLLcs === "function";

describe.skipIf(native === null)("NativeOps contract — real compiled binding (THE-905)", () => {
  const n = native as NonNullable<typeof native>;

  it("cosineSimilarity(number[], Float32Array) -> finite number in [-1, 1]", () => {
    const score = n.cosineSimilarity([0.1, 0.2, 0.3], new Float32Array([0.2, 0.1, 0.4]));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("cosineSimilarity(number[], number[]) THROWS — the #855 class, pinned open", () => {
    // The native signature is (Vec<f64>, Float32Array); a plain array on the document side
    // fails at the napi boundary instead of degrading. The JS fallback tolerates this same
    // call silently (fallback-strictness left open as a follow-up option), so this pin
    // documents the divergence rather than closing it.
    expect(() => n.cosineSimilarity([0.1, 0.2], [0.2, 0.1] as unknown as Float32Array)).toThrow();
  });

  it("cosineBatch(Float32Array, Float32Array, dim) -> Float64Array of expected length", () => {
    const out = n.cosineBatch(new Float32Array([1, 0]), new Float32Array([1, 0, 0, 1, 3, 4]), 2);
    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0.6, 6);
  });

  it("tokenize(string) -> string[]", () => {
    const out = n.tokenize("Hello, World! 42");
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["hello", "world", "42"]);
  });

  it("bm25Score(tf, docLen, avgDocLen, docFreq, docCount) -> finite positive number", () => {
    const score = n.bm25Score(3, 200, 100, 5, 1000);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });

  it.skipIf(!hasRougeLLcs)(
    "rougeLLcs(Int32Array, Int32Array) -> number (feature-detected, when this .node exports it)",
    () => {
      const out = n.rougeLLcs?.(Int32Array.from([1, 2, 3, 4]), Int32Array.from([2, 4]));
      expect(out).toBe(2);
    },
  );
});

describe.skipIf(native !== null)(
  "NativeOps contract — SKIPPED: no .node built on this host (THE-905)",
  () => {
    it("names why: run this suite where ci-server.yml's native-contract job builds the addon", () => {
      expect(native).toBeNull();
    });
  },
);
