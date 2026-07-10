// bge-m3 ColBERT multi-vector (late-interaction) reranking — THE-388. A ColBERT representation is a
// per-token matrix (number[][]). maxSim scores a query matrix against a doc matrix by summing, over
// each query token, its max cosine to any doc token — the standard ColBERT late-interaction score.
// Used to rerank the fused top-K (bounded compute) once doc ColBERT vectors are available; the
// bge-m3 encoder that produces them is separate and infra-gated. Pure functions, unit-tested.
import { jsCosineSimilarity } from "./native";

export type ColbertMatrix = number[][];

/** ColBERT late-interaction score: sum over query tokens of the max cosine to any doc token. */
export function maxSim(query: ColbertMatrix, doc: ColbertMatrix): number {
  if (query.length === 0 || doc.length === 0) return 0;
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
