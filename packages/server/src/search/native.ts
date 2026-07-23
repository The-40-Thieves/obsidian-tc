// Native-optional vector + lexical primitives. The Rust module
// (@the-40-thieves/obsidian-tc-native) accelerates cosine similarity, tokenization, and BM25
// scoring. When it is not built for the host — the clean-room install, the
// vitest suite, an unsupported platform — we fall back to pure-JS equivalents.
// This boundary is required by the M2 design and sanctioned by G2.2 (component
// 9 ships a pure-JS fallback): the server must run correctly without a compiled
// binary. The JS fallbacks are kept numerically identical to the Rust so search
// results never depend on which backend is active.
import { createRequire } from "node:module";

export interface NativeOps {
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
}

/** Cosine similarity; 0 for empty or mismatched-length inputs. Mirrors the Rust. */
export function jsCosineSimilarity(a: number[], b: Float32Array | number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Batched cosine: one query vs N concatenated f32 docs of length `dim`; scores in row order
 *  (empty for a bad shape). Mirrors the Rust `cosine_batch`.
 *
 *  THE-504: `query` is now a `Float32Array` (was `number[]`), and the query's norm is computed
 *  ONCE per batch instead of being recomputed per doc via a `jsCosineSimilarity` call (was: reuse
 *  jsCosineSimilarity per doc — the same inefficiency the Rust `cosine_batch_core` had). Each
 *  doc's dot product and norm are now computed together in a single pass. */
export function jsCosineBatch(
  query: Float32Array,
  docsFlat: Float32Array,
  dim: number,
): Float64Array {
  if (dim <= 0 || query.length !== dim || docsFlat.length % dim !== 0) return new Float64Array(0);
  let normQ = 0;
  for (let i = 0; i < dim; i++) {
    const q = query[i] ?? 0;
    normQ += q * q;
  }
  const n = docsFlat.length / dim;
  const out = new Float64Array(n);
  if (normQ === 0) return out; // all-zero query -> all-zero scores, matching jsCosineSimilarity
  const normQSqrt = Math.sqrt(normQ);
  for (let i = 0; i < n; i++) {
    const base = i * dim;
    let dot = 0;
    let normD = 0;
    for (let j = 0; j < dim; j++) {
      const q = query[j] ?? 0;
      const d = docsFlat[base + j] ?? 0;
      dot += q * d;
      normD += d * d;
    }
    out[i] = normD === 0 ? 0 : dot / (normQSqrt * Math.sqrt(normD));
  }
  return out;
}

/** Lowercase tokenizer over Unicode alphabetic + numbers (matches Rust is_alphanumeric). Mirrors the Rust. */
export function jsTokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/[^\p{Alphabetic}\p{N}]+/u)) {
    if (t.length > 0) out.push(t.toLowerCase());
  }
  return out;
}

/** BM25 contribution of one query term to one document; k1=1.2, b=0.75. Mirrors the Rust. */
export function jsBm25Score(
  tf: number,
  docLen: number,
  avgDocLen: number,
  docFreq: number,
  docCount: number,
): number {
  if (tf <= 0 || docCount <= 0) return 0;
  const k1 = 1.2;
  const b = 0.75;
  const idf = Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
  const denom = tf + k1 * (1 - b + b * (docLen / Math.max(avgDocLen, 1)));
  return (idf * (tf * (k1 + 1))) / denom;
}

/** Runtime `require` shape; injectable so unit tests can supply a fake native module. */
type NativeRequire = (specifier: string) => unknown;

// Computed specifier so the bundler (bun build) does not resolve and inline the
// platform-specific napi package; it stays a runtime require that throws
// cleanly (-> JS fallback) when the binary is absent.
const NATIVE_PKG = ["@the-40-thieves", "obsidian-tc-native"].join("/");

/**
 * Select the search backend: the compiled native module, or `null` to signal the
 * pure-JS fallback. Returns `null` when either:
 *   - `OBSIDIAN_TC_FORCE_JS_FALLBACK=1` is set — a deterministic escape hatch the
 *     pure-JS fallback CI job (ci-native.yml) uses to exercise the JS path even on
 *     a host where the .node IS built, so the fallback stays correct as the native
 *     API evolves; or
 *   - the native module is absent or incomplete (`require` throws, or an expected
 *     export is missing).
 *
 * @internal Exported for unit tests; production code uses the bound exports
 * (`cosineSimilarity` / `tokenize` / `bm25Score` / `nativeLoaded`) below.
 */
export function loadNative(
  env: NodeJS.ProcessEnv = process.env,
  requireFn: NativeRequire = createRequire(import.meta.url),
): NativeOps | null {
  if (env.OBSIDIAN_TC_FORCE_JS_FALLBACK === "1") return null;
  try {
    const mod = requireFn(NATIVE_PKG) as Partial<NativeOps>;
    if (
      typeof mod.cosineSimilarity === "function" &&
      typeof mod.tokenize === "function" &&
      typeof mod.bm25Score === "function"
    ) {
      return mod as NativeOps;
    }
    return null;
  } catch {
    return null;
  }
}

const native = loadNative();

/** True when the compiled native module is loaded (accelerated path active). */
export const nativeLoaded: boolean = native !== null;

export const cosineSimilarity: NativeOps["cosineSimilarity"] =
  native?.cosineSimilarity ?? jsCosineSimilarity;
export const cosineBatch: NativeOps["cosineBatch"] = native?.cosineBatch ?? jsCosineBatch;
export const tokenize: NativeOps["tokenize"] = native?.tokenize ?? jsTokenize;
export const bm25Score: NativeOps["bm25Score"] = native?.bm25Score ?? jsBm25Score;
