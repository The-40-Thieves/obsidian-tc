/**
 * Rerank seam — THE-233 W-RETRIEVAL (D1). The model call routes through the self-hosted
 * gateway's Cohere-compatible /rerank passthrough (rerank-v3.5 quality, no provider SDK in
 * the tree). The W-GATEWAY-CLIENT lives on its own branch, so the reranker is *injected*
 * here; at integration, adapt the gateway client:
 *
 *   const reranker: Reranker = (q, docs, topN) =>
 *     gatewayClient.rerank({ query: q, documents: docs, topN }).then((r) => r.results);
 *
 * The default is the graceful no-op fallback (KMS reranker.ts behavior): on a missing
 * reranker or any error, retrieval degrades to the pre-rerank order with synthetic
 * descending scores, never throwing.
 */

export interface RerankHit {
  index: number;
  relevanceScore: number;
}

/** Scores documents against a query, returning hits by descending relevance. */
export type Reranker = (query: string, documents: string[], topN: number) => Promise<RerankHit[]>;

export interface RankableDoc {
  content: string;
}

/**
 * Rerank `docs`, returning items paired with scores. Falls back to input order with
 * synthetic descending scores (1, 0.99, 0.98, ...) when the reranker is absent, empty, or
 * throws — so callers always get a usable number and retrieval never fails on rerank.
 */
export async function rerankWithScores<T extends RankableDoc>(
  query: string,
  docs: T[],
  topN: number,
  reranker: Reranker | null | undefined,
): Promise<Array<{ item: T; score: number }>> {
  const fallback = (): Array<{ item: T; score: number }> =>
    docs.slice(0, topN).map((item, i) => ({ item, score: 1 - i * 0.01 }));

  if (!reranker || docs.length === 0) return fallback();
  try {
    const hits = await reranker(
      query,
      docs.map((d) => d.content),
      topN,
    );
    const out: Array<{ item: T; score: number }> = [];
    for (const h of hits) {
      const item = docs[h.index];
      if (item !== undefined) out.push({ item, score: h.relevanceScore });
    }
    return out.length > 0 ? out : fallback();
  } catch {
    return fallback();
  }
}
