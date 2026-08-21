// THE-905: search-native.test.ts and native-fallback-parity.test.ts both compare the ACTIVE
// backend (native when built, else JS) against the JS reference — a comparison that holds
// whichever backend is active, so it never forces the native path to run. #855 shipped two
// callers that violated the native signature (Vec<f64>, Float32Array) while passing every
// existing test, because the CI lane those tests ran in never had the addon built. This suite
// calls the REAL compiled binding directly, with exactly the types NativeOps declares, so a
// signature drift is caught here rather than only tolerated by the lenient JS fallback.
//
// `search/native.ts`'s exported `nativeLoaded` is NOT the right gate for that: it only checks
// that requiring the package produced the expected function *names*, and
// `packages/native/index.js` itself falls back to its own bundled `fallback.js` (same
// function names, lenient types) whenever no local `.node` and no published platform prebuild
// resolve — exactly the state of every `--ignore-scripts` CI checkout. The package's OWN
// `nativeLoaded` export (index.js) is the only signal that distinguishes "real napi binding" from
// "the package's internal JS fallback", so this suite reads that one directly instead.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { loadNative } from "../src/search/native";

// Empty env: OBSIDIAN_TC_FORCE_JS_FALLBACK in the ambient environment must not suppress this.
const native = loadNative({} as NodeJS.ProcessEnv);
// The real napi binding's own liveness flag — see the file-header note above for why this,
// and not truthiness of `native` itself, is the correct gate.
const isRealNative =
  (native as unknown as { nativeLoaded?: boolean } | null)?.nativeLoaded === true;
const hasRougeLLcs = typeof native?.rougeLLcs === "function";

describe.skipIf(!isRealNative)("NativeOps contract — real compiled binding (THE-905)", () => {
  const n = native as NonNullable<typeof native>;

  it("cosineSimilarity(number[], Float32Array) -> finite number in [-1, 1]", () => {
    const score = n.cosineSimilarity([0.1, 0.2, 0.3], new Float32Array([0.2, 0.1, 0.4]));
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(-1);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("cosineSimilarity(number[], number[]) THROWS — the #855 class, pinned open", () => {
    // The native signature is (Vec<f64>, Float32Array); a plain array on the document side
    // fails at the napi boundary instead of degrading. The JS fallback (both native.ts's own
    // and packages/native/fallback.js) tolerates this same call silently (fallback-strictness
    // left open as a follow-up option), so this pin documents the divergence rather than
    // closing it.
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

describe.skipIf(isRealNative)(
  "NativeOps contract — SKIPPED: no .node built on this host (THE-905)",
  () => {
    it("names why: run this suite where ci-server.yml's native-contract job builds the addon", () => {
      expect(isRealNative).toBe(false);
    });
  },
);

describe("packages/native/index.js's own nativeLoaded is the real-binding signal, not the package's function shape", () => {
  // Documents the trap this file's header explains: requiring the package always succeeds with
  // the right function names, whether backed by the real .node or its bundled fallback.js, so
  // `typeof mod.cosineSimilarity === "function"` alone (search/native.ts's own completeness
  // check) cannot tell the two apart. `mod.nativeLoaded` can.
  it("mod.nativeLoaded reflects reality even though the function surface is identical either way", () => {
    if (native === null) return; // OBSIDIAN_TC_FORCE_JS_FALLBACK or a require failure; nothing to check
    const req = createRequire(import.meta.url);
    const mod = req("@the-40-thieves/obsidian-tc-native") as { nativeLoaded?: boolean };
    expect(typeof mod.nativeLoaded).toBe("boolean");
    expect(mod.nativeLoaded).toBe(isRealNative);
  });
});
