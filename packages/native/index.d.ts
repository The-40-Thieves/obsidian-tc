// Type surface for @the-40-thieves/obsidian-tc-native (umbrella entry, index.js).
// Mirrors the napi-rs exports (src/lib.rs) and the pure-JS fallback (fallback.ts).

/** Cosine similarity between two equal-length vectors; 0 for empty/mismatched inputs. */
export declare function cosineSimilarity(a: number[], b: Float32Array | number[]): number;

/** Tokenize text into lowercase alphanumeric terms for BM25 scoring. */
export declare function tokenize(text: string): string[];

/** BM25 contribution of one query term to one document (k1=1.2, b=0.75). */
export declare function bm25Score(
  tf: number,
  docLen: number,
  avgDocLen: number,
  docFreq: number,
  docCount: number,
): number;

/** True when the compiled native binary is active; false when on the pure-JS fallback. */
export declare const nativeLoaded: boolean;

/** Host napi package triple (e.g. `"linux-x64-musl"`), or null on an unmapped platform. */
export declare function hostTriple(): string | null;

/** True when the host uses musl libc (Alpine); false on glibc or a non-linux platform. */
export declare function isMusl(): boolean;
