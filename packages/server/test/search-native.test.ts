import { describe, expect, it } from "vitest";
import {
  bm25Score,
  cosineSimilarity,
  jsBm25Score,
  jsCosineSimilarity,
  jsTokenize,
  nativeLoaded,
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
});

describe("active backend (native when built, else JS) matches the JS reference", () => {
  it("exposes a boolean nativeLoaded flag", () => {
    expect(typeof nativeLoaded).toBe("boolean");
  });

  it("cosine/tokenize/bm25 agree with the JS reference", () => {
    expect(cosineSimilarity([0.1, 0.2, 0.3], [0.2, 0.1, 0.4])).toBeCloseTo(
      jsCosineSimilarity([0.1, 0.2, 0.3], [0.2, 0.1, 0.4]),
      6,
    );
    expect(tokenize("Alpha, beta_gamma 42")).toEqual(jsTokenize("Alpha, beta_gamma 42"));
    expect(bm25Score(3, 120, 95, 2, 50)).toBeCloseTo(jsBm25Score(3, 120, 95, 2, 50), 6);
  });
});
