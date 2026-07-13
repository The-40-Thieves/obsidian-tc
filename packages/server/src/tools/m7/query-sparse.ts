// Serve-path feed for the bge-m3 multi-vector streams. graph_search fuses a "sparse" RRF stream from
// the query's lexical weights (opts.querySparse) and reranks the fused top-K by ColBERT maxSim
// (opts.queryColbert), but only the offline eval harness supplied them; these resolve the query's
// heads on the serve path when the matching flag is on AND the embeddings provider can produce them
// (embedFull: bge-m3 or the model tier). Both return undefined otherwise, so each stream stays a
// no-op without a multi-vector provider — the flags default off and are measured on the golden set
// before shipping on. The query is encoded as a query (input:"query"), so the model tier keeps BGE
// bare while the Qwen dense side gets its Instruct.
import type { EmbeddingProvider } from "../../embeddings";
import type { ColbertMatrix } from "../../search/colbert";
import type { SparseVec } from "../../search/sparse";

export async function resolveQuerySparse(
  provider: EmbeddingProvider,
  query: string,
  enabled: boolean | undefined,
): Promise<SparseVec | undefined> {
  if (!enabled || !provider.embedFull) return undefined;
  const [full] = await provider.embedFull([query], { input: "query" });
  return full?.sparse;
}

export async function resolveQueryColbert(
  provider: EmbeddingProvider,
  query: string,
  enabled: boolean | undefined,
): Promise<ColbertMatrix | undefined> {
  if (!enabled || !provider.embedFull) return undefined;
  const [full] = await provider.embedFull([query], { input: "query" });
  return full?.colbert;
}
