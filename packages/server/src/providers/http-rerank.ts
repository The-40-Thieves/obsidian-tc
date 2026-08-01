// The generic "any Cohere-shaped /rerank endpoint" reranker. LiteLLM follows the Cohere rerank
// format for ALL rerank providers; Jina, Voyage, TogetherAI and Infinity speak it.
//
// Cohere rerank is VERSIONED and the dialects differ: v2 replaced v1's max_chunks_per_doc with
// max_tokens_per_doc. Since this adapter appends only "/rerank", the dialect is decided by whether
// baseUrl ends in /v1 or /v2 — which is why neither truncation parameter is ever sent.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { type FetchFn, postJson } from "../embeddings/http";
import type { Reranker, RerankHit } from "../search/rerank";

export interface HttpRerankOpts {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export function cohereCompatibleReranker(o: HttpRerankOpts): Reranker {
  if (!o.baseUrl) {
    throw err.invalidInput("reranker.baseUrl is required for provider 'cohere-compatible'", {
      provider: "cohere-compatible",
      hint: "set reranker.baseUrl to the prefix preceding /rerank, INCLUDING the dialect version segment (e.g. http://127.0.0.1:4000/v2)",
    });
  }
  const base = o.baseUrl.replace(/\/+$/, "");
  return async (query: string, documents: string[], topN: number): Promise<RerankHit[]> => {
    const payload = await postJson<{ results?: Array<{ index: number; relevance_score: number }> }>(
      {
        url: `${base}/rerank`,
        headers: o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {},
        body: { model: o.model, query, documents, ...(topN > 0 ? { top_n: topN } : {}) },
        fetchFn: o.fetchFn,
        timeoutMs: o.timeoutMs,
        provider: "cohere-compatible",
      },
    );
    return (payload.results ?? []).map((r) => ({
      index: r.index,
      relevanceScore: r.relevance_score,
    }));
  };
}
