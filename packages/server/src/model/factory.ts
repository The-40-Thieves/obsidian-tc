// Composition-root factory + EmbeddingProvider adapter for the model tier. This is the ONE bridge from
// the new ModelClient boundary (Qwen3 dense via the Rust TEI service + BGE-M3 multi-vector via the
// Python service) onto the mature EmbeddingProvider seam the indexer and search already speak — so the
// whole index/retrieval/RRF path stays unchanged while its dense backbone becomes Qwen and BGE feeds
// the sparse/ColBERT streams. The two are SEPARATE vector spaces: embedFull's dense slot is Qwen (the
// required dense stream), NOT BGE's dense (eval-only, discarded here); sparse + ColBERT come from BGE.
// RRF fuses them downstream on ranks, never by adding a Qwen cosine to a BGE score.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { FetchFn } from "../embeddings/http";
import type { EmbeddingProvider, EmbedOptions, MultiVectorEmbedding } from "../embeddings/provider";
import type { Reranker } from "../search/rerank";
import { bgeModelClient } from "./bge";
import { composeModelClient } from "./compose";
import type { ModelClient } from "./ports";
import { teiModelClient } from "./tei";

export interface ModelProviderOptions {
  /** Provenance tag stored as chunk_embeddings.model — identifies the DENSE model that produced the
   *  stored vectors, e.g. "model-tier:Qwen/Qwen3-Embedding-0.6B". */
  id: string;
  provider: string;
  /** The dense model id. */
  model: string;
  /** Dense (Qwen) width — drives the vec0 column and width validation. */
  dimensions: number;
  /** Qwen's asymmetric query instruction, applied to the DENSE query side only; BGE stays bare. */
  queryPrefix?: string;
  documentPrefix?: string;
}

/** Adapt a ModelClient composition to the EmbeddingProvider the indexer/search speak. embed() returns
 *  the required dense stream (Qwen); embedFull() MERGES Qwen's dense vector with BGE's sparse+ColBERT
 *  heads into one aligned MultiVectorEmbedding, so a chunk lands with a Qwen dense vector AND BGE
 *  sparse/ColBERT in one write. Prefixing is asymmetric and owned here (not the outer withPrefixes):
 *  the Qwen dense query gets `queryPrefix` (its Instruct string); BGE always gets the raw text. */
export function modelClientProvider(
  client: ModelClient,
  o: ModelProviderOptions,
): EmbeddingProvider {
  const affixDense = (texts: string[], input?: EmbedOptions["input"]): string[] => {
    const pre = input === "query" ? (o.queryPrefix ?? "") : (o.documentPrefix ?? "");
    return pre === "" ? texts : texts.map((t) => pre + t);
  };
  const dense = (texts: string[], input?: EmbedOptions["input"]) =>
    client.embed({ texts: affixDense(texts, input), input });

  const provider: EmbeddingProvider = {
    id: o.id,
    provider: o.provider,
    model: o.model,
    dimensions: o.dimensions,
    async embed(texts, opts) {
      return (await dense(texts, opts?.input)).vectors;
    },
  };

  const full = client.embedFull?.bind(client);
  if (full) {
    provider.embedFull = async (texts, opts): Promise<MultiVectorEmbedding[]> => {
      const [d, m] = await Promise.all([
        dense(texts, opts?.input),
        full({ texts, input: opts?.input }),
      ]);
      return texts.map((_t, i) => ({
        dense: d.vectors[i] ?? [], // Qwen — the required dense stream
        sparse: m.items[i]?.sparse ?? {}, // BGE learned-sparse
        colbert: m.items[i]?.colbert ?? [], // BGE ColBERT
      }));
    };
  }
  return provider;
}

export interface ModelTierDenseConfig {
  baseUrl: string;
  model?: string;
  revision?: string;
  pooling?: string;
}
export interface ModelTierFullConfig {
  baseUrl: string;
  model?: string;
  revision?: string;
  authToken?: string;
  dimensions?: number;
}
export interface ModelTierConfigLike {
  dimensions: number;
  truncate?: boolean;
  timeoutMs?: number;
  queryPrefix?: string;
  documentPrefix?: string;
  modelTier?: { dense: ModelTierDenseConfig; full?: ModelTierFullConfig };
}

const DEFAULT_DENSE_MODEL = "Qwen/Qwen3-Embedding-0.6B";
const DEFAULT_FULL_MODEL = "BAAI/bge-m3";
const DEFAULT_FULL_DIM = 1024;

/** Build the model-tier EmbeddingProvider from config: Qwen3 dense via the Rust TEI service, BGE-M3
 *  multi-vector via the Python service, composed and adapted. Throws if the modelTier block is absent. */
export function buildModelTierProvider(
  cfg: ModelTierConfigLike,
  opts: { fetchFn?: FetchFn } = {},
): EmbeddingProvider {
  const mt = cfg.modelTier;
  if (!mt)
    throw err.invalidInput(
      "embeddings.provider 'model-tier' requires an embeddings.modelTier block",
      {},
    );
  const denseModel = mt.dense.model ?? DEFAULT_DENSE_MODEL;
  const dense = teiModelClient({
    baseUrl: mt.dense.baseUrl,
    dimensions: cfg.dimensions,
    model: denseModel,
    revision: mt.dense.revision,
    pooling: mt.dense.pooling,
    truncate: cfg.truncate,
    fetchFn: opts.fetchFn,
    timeoutMs: cfg.timeoutMs,
  });
  const full = mt.full
    ? bgeModelClient({
        baseUrl: mt.full.baseUrl,
        dimensions: mt.full.dimensions ?? DEFAULT_FULL_DIM,
        model: mt.full.model ?? DEFAULT_FULL_MODEL,
        revision: mt.full.revision,
        authToken: mt.full.authToken,
        truncate: cfg.truncate,
        fetchFn: opts.fetchFn,
        timeoutMs: cfg.timeoutMs,
      })
    : undefined;
  const client = composeModelClient({ dense, full });
  return modelClientProvider(client, {
    id: `model-tier:${denseModel}`,
    provider: "model-tier",
    model: denseModel,
    dimensions: cfg.dimensions,
    queryPrefix: cfg.queryPrefix,
    documentPrefix: cfg.documentPrefix,
  });
}

/** A live Reranker (the search rerank seam) backed by the model tier's BGE /v1/rerank
 *  (bge-reranker-v2-m3), when the full (BGE) backend is configured. Null otherwise, so the caller
 *  falls back to the gateway reranker. This only chooses WHICH reranker answers - it stays dark
 *  until a rerank stage is actually enabled in graphSearch. */
export function buildModelTierReranker(
  cfg: ModelTierConfigLike,
  opts: { fetchFn?: FetchFn } = {},
): Reranker | null {
  const full = cfg.modelTier?.full;
  if (!full) return null;
  const client = bgeModelClient({
    baseUrl: full.baseUrl,
    dimensions: full.dimensions ?? DEFAULT_FULL_DIM,
    model: full.model ?? DEFAULT_FULL_MODEL,
    revision: full.revision,
    authToken: full.authToken,
    truncate: cfg.truncate,
    fetchFn: opts.fetchFn,
    timeoutMs: cfg.timeoutMs,
  });
  const rerank = client.rerank;
  if (!rerank) return null;
  return (query, documents, topN) => rerank({ query, documents, topN }).then((r) => r.results);
}
