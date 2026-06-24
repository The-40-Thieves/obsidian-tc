// Pure-JS fallback for @the-40-thieves/obsidian-tc-native. Typed source of truth for
// fallback.js (its committed CommonJS runtime form, loaded by index.js when no compiled
// .node binary resolves for the host). Kept numerically identical to the Rust
// (src/lib.rs) so search results never depend on which backend is active.

/** Cosine similarity; 0 for empty or mismatched-length inputs. Mirrors the Rust. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
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
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Lowercase tokenizer over Unicode alphabetic + numbers (matches Rust is_alphanumeric). Mirrors the Rust. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/[^\p{Alphabetic}\p{N}]+/u)) {
    if (t.length > 0) {
      out.push(t.toLowerCase());
    }
  }
  return out;
}

/** BM25 contribution of one query term to one document; k1=1.2, b=0.75. Mirrors the Rust. */
export function bm25Score(
  tf: number,
  docLen: number,
  avgDocLen: number,
  docFreq: number,
  docCount: number,
): number {
  if (tf <= 0 || docCount <= 0) {
    return 0;
  }
  const k1 = 1.2;
  const b = 0.75;
  const idf = Math.log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5));
  const denom = tf + k1 * (1 - b + b * (docLen / Math.max(avgDocLen, 1)));
  return (idf * (tf * (k1 + 1))) / denom;
}
