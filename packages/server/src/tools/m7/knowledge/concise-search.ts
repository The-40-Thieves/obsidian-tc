// GH #1027: the concise form of a graph-search result set, shared by vault_graph_search and
// knowledge_search so "what concise keeps" has one definition. A hit keeps what the caller acts on
// (which chunk, which note, its text, its score) plus the two flags that qualify the text it reads:
// `vault` (federated source) and `changed_since_d` (the honest-history flag of an as_of search).
// It drops the retrieval provenance: source arm, hop, via_edge and root_seed, which is why
// ConciseableGraphSearchResultSchema (schemas.ts) marks those four optional for these two tools only.
import type { GraphSearchResult } from "../../../search/graph_search";

export type ConciseGraphResult = Pick<
  GraphSearchResult,
  "chunk_id" | "path" | "content" | "rerank_score" | "changed_since_d"
> & { vault?: string };

export function conciseGraphResults(
  results: Array<GraphSearchResult & { vault?: string }>,
): ConciseGraphResult[] {
  return results.map((r) => ({
    chunk_id: r.chunk_id,
    path: r.path,
    ...(r.content !== undefined ? { content: r.content } : {}),
    rerank_score: r.rerank_score,
    ...(r.vault !== undefined ? { vault: r.vault } : {}),
    ...(r.changed_since_d !== undefined ? { changed_since_d: r.changed_since_d } : {}),
  }));
}
