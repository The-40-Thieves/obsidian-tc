// Native-optional vector + lexical primitives. The Rust module
// (@obsidian-tc/native) accelerates cosine similarity, tokenization, and BM25
// scoring. When it is not built for the host — the clean-room install, the
// vitest suite, an unsupported platform — we fall back to pure-JS equivalents.
// This boundary is required by the M2 design and sanctioned by G2.2 (component
// 9 ships a pure-JS fallback): the server must run correctly without a compiled
// binary. The JS fallbacks are kept numerically identical to the Rust so search
// results never depend on which backend is active.
import { createRequire } from "node:module";

export interface NativeOps {
  cosineSimilarity(a: number[], b: number[]): number;
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
export function jsCosineSimilarity(a: number[], b: number[]): number {
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

/** Lowercase tokenizer over Unicode letters + numbers. Mirrors the Rust. */
export function jsTokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/[^\p{L}\p{N}]+/u)) {
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

function loadNative(): NativeOps | null {
  // Computed specifier so the bundler (bun build) does not resolve and inline the
  // platform-specific napi package; it stays a runtime require that throws
  // cleanly (-> JS fallback) when the binary is absent.
  const pkg = ["@obsidian-tc", "native"].join("/");
  try {
    const mod = createRequire(import.meta.url)(pkg) as Partial<NativeOps>;
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
export const tokenize: NativeOps["tokenize"] = native?.tokenize ?? jsTokenize;
export const bm25Score: NativeOps["bm25Score"] = native?.bm25Score ?? jsBm25Score;
