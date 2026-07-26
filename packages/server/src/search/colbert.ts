// bge-m3 ColBERT multi-vector (late-interaction) reranking — THE-388. A ColBERT representation is a
// per-token matrix (number[][]). maxSim scores a query matrix against a doc matrix by summing, over
// each query token, its max cosine to any doc token — the standard ColBERT late-interaction score.
// Used to rerank the fused top-K (bounded compute) once doc ColBERT vectors are available; the
// bge-m3 encoder that produces them is separate and infra-gated. Pure functions, unit-tested.
import { cosineBatch, jsCosineSimilarity } from "./native";

export type ColbertMatrix = number[][];

/** Flatten a rectangular (uniform-width) token matrix into one row-major f32 buffer for a single
 *  `cosineBatch` crossing, or `null` when the rows don't share a width — cosineBatch's contract is
 *  one fixed `dim` for the whole scan, which a ragged matrix can't express. Real bge-m3 output is
 *  always rectangular; `null` is a defensive fallback, not the expected case. */
function flattenRectangular(m: ColbertMatrix): { flat: Float32Array; dim: number } | null {
  const dim = m[0]?.length ?? 0;
  if (dim === 0) return null;
  for (const row of m) if (row.length !== dim) return null;
  const flat = new Float32Array(m.length * dim);
  for (let i = 0; i < m.length; i++) flat.set(m[i] as number[], i * dim);
  return { flat, dim };
}

/** Pairwise JS scorer — one `jsCosineSimilarity` call per (query-token, doc-token) pair. Kept as
 *  the ragged-matrix fallback for `maxSim` below; also the pre-THE-418 implementation this diff
 *  replaces on the (common) rectangular path. */
function maxSimPairwise(query: ColbertMatrix, doc: ColbertMatrix): number {
  let total = 0;
  for (const q of query) {
    let best = Number.NEGATIVE_INFINITY;
    for (const d of doc) {
      const s = jsCosineSimilarity(q, d);
      if (s > best) best = s;
    }
    total += best === Number.NEGATIVE_INFINITY ? 0 : best;
  }
  return total;
}

/**
 * ColBERT late-interaction score: sum over query tokens of the max cosine to any doc token.
 *
 * THE-418: one BATCHED native crossing per query token — marshal the query token once, scan the
 * WHOLE doc matrix in native via `cosineBatch` — never one native call per (query-token,
 * doc-token) pair. That per-pair shape would be SLOWER than the pure-JS loop it replaces: per-pair
 * cosine across the native boundary is dominated by re-marshaling the query on every call
 * (measured 13-22x slower than JS — see semantic.ts's `cosineBatch` comment, THE-420/THE-504's
 * precedent for this exact tradeoff). Here the doc's token matrix is flattened ONCE per `maxSim`
 * call and `cosineBatch` marshals each query token once against it — the query side of the
 * boundary crossing, mirrored from semantic.ts's per-search (not per-document) batching.
 *
 * Falls back to the pairwise JS scorer when the doc isn't a uniform-width matrix (cosineBatch's
 * single-`dim` contract can't express a ragged one) — real bge-m3 output is always rectangular, so
 * this is a defensive path, not the common case.
 */
export function maxSim(query: ColbertMatrix, doc: ColbertMatrix): number {
  if (query.length === 0 || doc.length === 0) return 0;
  const flatDoc = flattenRectangular(doc);
  if (!flatDoc) return maxSimPairwise(query, doc);
  const { flat, dim } = flatDoc;
  let total = 0;
  for (const q of query) {
    let best = Number.NEGATIVE_INFINITY;
    if (q.length === dim) {
      const sims = cosineBatch(Float32Array.from(q), flat, dim);
      for (let i = 0; i < sims.length; i++) {
        const s = sims[i] ?? Number.NEGATIVE_INFINITY;
        if (s > best) best = s;
      }
    }
    // q.length !== dim: every pairwise cosine in this row would be 0 under jsCosineSimilarity's
    // mismatched-length contract (every doc row shares `dim`, and q doesn't) — same result as the
    // pairwise fallback for this token, without a boundary crossing that can't score it anyway.
    total += best === Number.NEGATIVE_INFINITY ? 0 : best;
  }
  return total;
}

/**
 * Rerank items by ColBERT maxSim against the query, taking each item's doc matrix from `docById`.
 * Items whose ColBERT vectors are missing keep their input order after the scored ones (stable), so
 * this is a no-op when no doc has ColBERT data (or the query is empty). Descending maxSim.
 */
export function colbertRerank<T extends { chunk_id: string }>(
  items: T[],
  query: ColbertMatrix,
  docById: Map<string, ColbertMatrix>,
): T[] {
  if (query.length === 0) return items;
  const scored = items.map((item, i) => {
    const doc = docById.get(item.chunk_id);
    return { item, i, score: doc ? maxSim(query, doc) : Number.NEGATIVE_INFINITY };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}
