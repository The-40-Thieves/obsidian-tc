import { describe, expect, it } from "vitest";
import {
  bm25Score,
  cosineBatch,
  cosineSimilarity,
  jsBm25Score,
  jsCosineBatch,
  jsCosineSimilarity,
  jsRougeLLcs,
  jsTokenize,
  loadNative,
  type NativeOps,
  nativeLoaded,
  rougeLLcs,
  tokenize,
} from "../src/search/native";

// JS fallbacks are tested directly so they're covered even on hosts where the
// native module IS built; the exported (possibly-native) functions are then
// asserted to agree with the JS reference, verifying the native path when present.
describe("vector/lexical primitives — JS fallbacks", () => {
  it("cosine: identical=1, orthogonal=0, mismatched/empty=0", () => {
    expect(jsCosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(jsCosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(jsCosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(jsCosineSimilarity([], [])).toBe(0);
  });

  it("tokenize: lowercases, splits non-alphanumeric, drops empties", () => {
    expect(jsTokenize("Hello, World!")).toEqual(["hello", "world"]);
    expect(jsTokenize("  Foo--Bar  baz ")).toEqual(["foo", "bar", "baz"]);
    expect(jsTokenize("")).toEqual([]);
  });

  it("bm25: zero tf -> 0; rarer term, shorter doc, higher tf each score higher", () => {
    expect(jsBm25Score(0, 100, 100, 1, 10)).toBe(0);
    expect(jsBm25Score(2, 100, 100, 1, 10)).toBeGreaterThan(jsBm25Score(2, 100, 100, 9, 10));
    expect(jsBm25Score(2, 50, 100, 2, 10)).toBeGreaterThan(jsBm25Score(2, 200, 100, 2, 10));
    expect(jsBm25Score(5, 100, 100, 2, 10)).toBeGreaterThan(jsBm25Score(1, 100, 100, 2, 10));
  });

  it("cosineBatch: scores rows in order; bad shape -> empty", () => {
    expect(
      Array.from(jsCosineBatch(new Float32Array([1, 0]), new Float32Array([1, 0, 0, 1]), 2)),
    ).toEqual([1, 0]);
    expect(jsCosineBatch(new Float32Array([1, 2]), new Float32Array([1, 2, 3]), 2).length).toBe(0);
    expect(jsCosineBatch(new Float32Array([1, 2]), new Float32Array([]), 2).length).toBe(0);
  });
});

describe("active backend (native when built, else JS) matches the JS reference", () => {
  it("exposes a boolean nativeLoaded flag", () => {
    expect(typeof nativeLoaded).toBe("boolean");
  });

  it("cosine/tokenize/bm25 agree with the JS reference", () => {
    // THE-266: the native doc param is a strict Float32Array, so feed both the native
    // and JS paths the SAME Float32Array — identical f32->f64 widening makes the result
    // bit-identical (strict === parity, not merely close).
    const parityQuery = [0.1, 0.2, 0.3];
    const parityDoc = new Float32Array([0.2, 0.1, 0.4]);
    expect(cosineSimilarity(parityQuery, parityDoc)).toBe(
      jsCosineSimilarity(parityQuery, parityDoc),
    );
    expect(tokenize("Alpha, beta_gamma 42")).toEqual(jsTokenize("Alpha, beta_gamma 42"));
    expect(bm25Score(3, 120, 95, 2, 50)).toBeCloseTo(jsBm25Score(3, 120, 95, 2, 50), 6);
  });

  it("cosineBatch agrees with the JS reference and with per-pair cosine (close, not strict ===)", () => {
    // THE-504: cosineBatch's query is now a Float32Array, so cosineSimilarity (which still takes
    // a plain f64 number[]) sees the query at full f64 precision while cosineBatch sees it
    // narrowed to f32 — a deliberate, epsilon-bounded difference (see the Rust-side
    // cosine_batch_f32_query_narrowing_within_epsilon test), so this compares closely rather than
    // with strict ===.
    const q = new Float32Array([0.1, 0.2, 0.3]);
    const qNumbers = Array.from(q);
    const flat = new Float32Array([0.2, 0.1, 0.4, 0.9, 0.0, 0.1]);
    expect(Array.from(cosineBatch(q, flat, 3))).toEqual(Array.from(jsCosineBatch(q, flat, 3)));
    expect(cosineBatch(q, flat, 3)[0]).toBeCloseTo(
      cosineSimilarity(qNumbers, flat.subarray(0, 3)),
      6,
    );
    expect(cosineBatch(q, flat, 3)[1]).toBeCloseTo(
      cosineSimilarity(qNumbers, flat.subarray(3, 6)),
      6,
    );
  });
});

describe("loadNative selector — OBSIDIAN_TC_FORCE_JS_FALLBACK escape hatch", () => {
  // A complete fake native module lets us prove the flag forces the JS path even
  // when a compiled binary IS present — the property the pure-JS fallback CI job
  // (ci-native.yml) relies on. We inject env + require rather than mutating the
  // process or deleting build artifacts, so the selector is tested deterministically.
  const fakeNative: NativeOps = {
    cosineSimilarity: () => 1,
    cosineBatch: () => new Float64Array(),
    tokenize: () => ["native"],
    bm25Score: () => 1,
  };
  const requireOk = (): NativeOps => fakeNative;

  it("loads the native module when present and the flag is unset", () => {
    expect(loadNative({}, requireOk)).toBe(fakeNative);
  });

  it("forces the JS fallback (null) when the flag is '1', even though native is present", () => {
    expect(loadNative({ OBSIDIAN_TC_FORCE_JS_FALLBACK: "1" }, requireOk)).toBeNull();
  });

  it("treats any value other than '1' as unset (flag not tripped)", () => {
    expect(loadNative({ OBSIDIAN_TC_FORCE_JS_FALLBACK: "0" }, requireOk)).toBe(fakeNative);
    expect(loadNative({ OBSIDIAN_TC_FORCE_JS_FALLBACK: "" }, requireOk)).toBe(fakeNative);
  });

  it("falls back (null) when the native require throws or an export is missing", () => {
    expect(
      loadNative({}, () => {
        throw new Error("missing .node");
      }),
    ).toBeNull();
    expect(loadNative({}, () => ({ cosineSimilarity: () => 0 }))).toBeNull();
  });
});

describe("rougeLLcs — native/JS parity", () => {
  const i32 = (xs: number[]) => Int32Array.from(xs);

  it("jsRougeLLcs: shapes, subsequence semantics, and the negative sentinel", () => {
    expect(jsRougeLLcs(i32([]), i32([1, 2]))).toBe(0);
    expect(jsRougeLLcs(i32([1, 2]), i32([]))).toBe(0);
    expect(jsRougeLLcs(i32([1, 2, 3]), i32([1, 2, 3]))).toBe(3);
    expect(jsRougeLLcs(i32([1, 2, 3]), i32([4, 5, 6]))).toBe(0);
    expect(jsRougeLLcs(i32([1, 2, 3, 4]), i32([2, 4]))).toBe(2); // subsequence, not substring
    expect(jsRougeLLcs(i32([1, 2, 3]), i32([3, 2, 1]))).toBe(1); // order matters
    // -1 marks a chunk token absent from the transcript: it must not match a real id, and two
    // sentinels must not match each other.
    expect(jsRougeLLcs(i32([-1, -1]), i32([0, 1, 2]))).toBe(0);
    expect(jsRougeLLcs(i32([-1, 1, -1]), i32([0, 1, 2]))).toBe(1);
  });

  it("the exported rougeLLcs agrees EXACTLY with the JS reference", () => {
    // Integer LCS has no floating point, so this is exact equality, not an epsilon. Covers the
    // native kernel when a .node is loaded and is a self-check otherwise.
    let state = 0x2545f49 >>> 0;
    const next = (m: number) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return Math.abs(state >>> 0) % m;
    };
    for (let c = 0; c < 40; c++) {
      const alphabet = c % 2 === 0 ? 3 : 17;
      const a = i32(Array.from({ length: 1 + ((c * 7) % 23) }, () => next(alphabet)));
      const b = i32(Array.from({ length: 1 + ((c * 11) % 29) }, () => next(alphabet)));
      expect(rougeLLcs(a, b)).toBe(jsRougeLLcs(a, b));
    }
  });

  it("rougeLLcs is bounded by the shorter input", () => {
    const a = i32(Array.from({ length: 50 }, (_, i) => i));
    const b = i32(Array.from({ length: 10 }, (_, i) => i));
    expect(rougeLLcs(a, b)).toBe(10);
  });
});
