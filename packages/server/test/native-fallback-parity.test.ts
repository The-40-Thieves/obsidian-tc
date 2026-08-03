// THE-712 — packages/native/fallback.js is the pure-JS fallback that runs whenever no .node
// resolves for the host. It is listed in the native package's `files`, so it SHIPS to npm and is
// what a user on an unsupported platform actually executes. Before this file, nothing verified its
// numbers:
//
//   * `ci-native.yml`'s `fallback-test` job looks like it covers this, but
//     `search/native.ts:loadNative` returns null on OBSIDIAN_TC_FORCE_JS_FALLBACK=1 BEFORE the
//     require(), so that job exercises the SERVER's js* twins and never loads fallback.js.
//   * `ci-install-smoke.yml` does load it, but asserts only `nativeLoaded === false` and
//     `typeof cosineSimilarity === 'function'` — presence, never a value.
//   * `tsconfig.json` sets "noEmit": true, so fallback.ts is typechecked but never compiled;
//     fallback.js is an independent hand-written mirror with no drift gate.
//
// Three arms, deliberately, so this cannot degrade into a vacuous pass:
//   1. GOLDEN — fixed inputs to hand-derived constants. Holds on ANY host, including one with no
//      compiled addon, so the file is never left with "nothing to compare against".
//   2. vs the SERVER twins — those are already pinned against the native module by
//      search-native.test.ts, so this transitively ties fallback.js to the Rust.
//   3. vs the NATIVE module — the direct check, skipped (not silently passed) when no .node exists.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  jsBm25Score,
  jsCosineBatch,
  jsCosineSimilarity,
  jsRougeLLcs,
  jsTokenize,
  loadNative,
} from "../src/search/native";

const requireCjs = createRequire(import.meta.url);

interface FallbackModule {
  cosineSimilarity(a: number[], b: Float32Array | number[]): number;
  cosineBatch(query: Float32Array, docsFlat: Float32Array, dim: number): Float64Array;
  tokenize(text: string): string[];
  bm25Score(
    tf: number,
    docLen: number,
    avgDocLen: number,
    docFreq: number,
    docCount: number,
  ): number;
  rougeLLcs(a: Int32Array, b: Int32Array): number;
}

// Required by PATH, not through the package entry: index.js would hand back the compiled .node
// when one exists, and this file is specifically about the JS mirror.
const fb = requireCjs("../../native/fallback.js") as FallbackModule;

// The real native module, or null on a host with no prebuild. `loadNative()` is called with an
// empty env so OBSIDIAN_TC_FORCE_JS_FALLBACK in the ambient environment cannot suppress it.
const native = loadNative({} as NodeJS.ProcessEnv);

describe("THE-712 — packages/native/fallback.js parity", () => {
  it("exports every function the loader wires up", () => {
    for (const name of ["cosineSimilarity", "cosineBatch", "tokenize", "bm25Score", "rougeLLcs"]) {
      expect(typeof (fb as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });

  // ---- ARM 1: golden constants. Independent of every other implementation. ----
  it("GOLDEN: cosineSimilarity matches hand-derived values", () => {
    expect(fb.cosineSimilarity([1, 0], new Float32Array([1, 0]))).toBe(1); // identical
    expect(fb.cosineSimilarity([1, 0], new Float32Array([0, 1]))).toBe(0); // orthogonal
    // (3*4 + 4*3) / (5 * 5) = 24/25
    expect(fb.cosineSimilarity([3, 4], new Float32Array([4, 3]))).toBeCloseTo(0.96, 12);
    expect(fb.cosineSimilarity([1, 2], new Float32Array([1, 2, 3]))).toBe(0); // length mismatch
    expect(fb.cosineSimilarity([], new Float32Array([]))).toBe(0); // empty
    expect(fb.cosineSimilarity([0, 0], new Float32Array([1, 1]))).toBe(0); // zero norm
  });

  it("GOLDEN: bm25Score matches hand-derived values (k1=1.2, b=0.75)", () => {
    // idf = ln(1 + (N - df + 0.5)/(df + 0.5)); denom = tf + k1*(1 - b + b*(dl/avgdl));
    // score = idf * tf*(k1+1) / denom.
    // tf=1, dl=avgdl=100 -> denom = 1 + 1.2 = 2.2, numerator factor = 1*2.2, so score == idf.
    expect(fb.bm25Score(1, 100, 100, 1, 10)).toBeCloseTo(1.992430164690206, 12);
    expect(fb.bm25Score(3, 200, 100, 5, 1000)).toBeCloseTo(6.734596889158205, 12);
    expect(fb.bm25Score(0, 100, 100, 1, 10)).toBe(0); // tf <= 0
    expect(fb.bm25Score(1, 100, 100, 1, 0)).toBe(0); // docCount <= 0
  });

  it("GOLDEN: tokenize and rougeLLcs match hand-derived values", () => {
    expect(fb.tokenize("Hello, World! 42")).toEqual(["hello", "world", "42"]);
    expect(fb.tokenize("")).toEqual([]);
    expect(fb.rougeLLcs(Int32Array.from([1, 2, 3, 4]), Int32Array.from([2, 4]))).toBe(2);
    expect(fb.rougeLLcs(Int32Array.from([1, 2, 3]), Int32Array.from([3, 2, 1]))).toBe(1);
    expect(fb.rougeLLcs(Int32Array.from([-1, -1]), Int32Array.from([0, 1]))).toBe(0);
    expect(fb.rougeLLcs(Int32Array.from([]), Int32Array.from([1]))).toBe(0);
  });

  it("GOLDEN: cosineBatch scores a whole corpus in row order", () => {
    // query [1,0] against docs [1,0], [0,1], [3,4] -> 1, 0, 3/5
    const out = Array.from(
      fb.cosineBatch(new Float32Array([1, 0]), new Float32Array([1, 0, 0, 1, 3, 4]), 2),
    );
    expect(out.length).toBe(3);
    expect(out[0]).toBeCloseTo(1, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(0.6, 12);
    // Bad shapes yield an empty result rather than throwing.
    expect(fb.cosineBatch(new Float32Array([1, 2]), new Float32Array([1, 2, 3]), 2).length).toBe(0);
    expect(fb.cosineBatch(new Float32Array([1]), new Float32Array([1]), 0).length).toBe(0);
  });

  // ---- ARM 2: against the server twins, which search-native.test.ts already pins to native. ----
  it("agrees with the server's js* twins across pseudorandom inputs", () => {
    let state = 0x9e3779b9 >>> 0;
    const rnd = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) % 2001) / 1000 - 1; // [-1, 1]
    };
    for (let dim = 1; dim <= 12; dim++) {
      const q = Array.from({ length: dim }, rnd);
      const d = new Float32Array(Array.from({ length: dim }, rnd));
      expect(fb.cosineSimilarity(q, d)).toBe(jsCosineSimilarity(q, d));

      const nDocs = 5;
      const qf = new Float32Array(q);
      const docs = new Float32Array(Array.from({ length: dim * nDocs }, rnd));
      expect(Array.from(fb.cosineBatch(qf, docs, dim))).toEqual(
        Array.from(jsCosineBatch(qf, docs, dim)),
      );
    }
    for (const t of ["Alpha beta", "  ", "Ünïcödé 123 test", "a-b_c.d"]) {
      expect(fb.tokenize(t)).toEqual(jsTokenize(t));
    }
    for (const [tf, dl, ad, df, dc] of [
      [1, 10, 10, 1, 5],
      [7, 300, 120, 3, 900],
      [2, 50, 400, 40, 41],
    ] as const) {
      expect(fb.bm25Score(tf, dl, ad, df, dc)).toBe(jsBm25Score(tf, dl, ad, df, dc));
    }
    for (let c = 0; c < 25; c++) {
      const alphabet = c % 2 === 0 ? 3 : 13;
      const mk = (n: number) =>
        Int32Array.from({ length: n }, () => Math.abs(Math.round(rnd() * alphabet)));
      const a = mk(1 + (c % 17));
      const b = mk(1 + (c % 23));
      expect(fb.rougeLLcs(a, b)).toBe(jsRougeLLcs(a, b));
    }
  });

  // ---- ARM 3: directly against the compiled module, when this host has one. ----
  const describeNative = native ? describe : describe.skip;
  describeNative("against the compiled native module", () => {
    it("cosineSimilarity / cosineBatch / tokenize / bm25Score / rougeLLcs all agree", () => {
      const n = native as NonNullable<typeof native>;
      const q = [0.1, 0.2, 0.3];
      const d = new Float32Array([0.2, 0.1, 0.4]);
      // Bit-identical: fallback.js and the Rust both accumulate in f64 over the same order.
      expect(fb.cosineSimilarity(q, d)).toBe(n.cosineSimilarity(q, d));

      const qf = new Float32Array([0.1, 0.2, 0.3]);
      const docs = new Float32Array([0.2, 0.1, 0.4, 0.9, 0.1, 0.1, 0, 0, 0]);
      expect(Array.from(fb.cosineBatch(qf, docs, 3))).toEqual(
        Array.from(n.cosineBatch(qf, docs, 3)),
      );

      expect(fb.tokenize("Hello, World! 42")).toEqual(n.tokenize("Hello, World! 42"));
      expect(fb.bm25Score(3, 200, 100, 5, 1000)).toBe(n.bm25Score(3, 200, 100, 5, 1000));

      const a = Int32Array.from([1, 2, 3, 4, 5, 2, 1]);
      const b = Int32Array.from([2, 4, 1, 5, 2]);
      // rougeLLcs is feature-detected: absent on a .node predating it, in which case the server
      // twin is the reference and the direct comparison does not apply.
      if (typeof n.rougeLLcs === "function") {
        expect(fb.rougeLLcs(a, b)).toBe(n.rougeLLcs(a, b));
      } else {
        expect(fb.rougeLLcs(a, b)).toBe(jsRougeLLcs(a, b));
      }
    });
  });
});
