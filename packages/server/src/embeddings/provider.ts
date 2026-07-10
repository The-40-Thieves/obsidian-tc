// Embedding provider abstraction (G2.2 component 8).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { ColbertMatrix } from "../search/colbert";
import type { SparseVec } from "../search/sparse";
/** THE-308: how to encode the input. Asymmetric models (e.g. Cohere v3) embed a search query
 *  differently from a corpus document; "document" is the default (indexing is the common path). */
export interface EmbedOptions {
  input?: "query" | "document";
}
/** THE-388: bge-m3 multi-representation output — a dense vector, learned-sparse weights, and a
 *  ColBERT per-token matrix. Providers that can emit all three implement `embedFull()`; dense-only
 *  providers omit it and the indexer stores dense only. */
export interface MultiVectorEmbedding {
  dense: number[];
  sparse: SparseVec;
  colbert: ColbertMatrix;
}
export interface EmbeddingProvider {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
  /** THE-388: optional multi-representation encode. When present, the indexer stores the sparse +
   *  ColBERT heads (chunk_sparse / chunk_colbert) alongside the dense vector, so the bge-m3 sparse
   *  RRF stream + ColBERT rerank have data. Absent -> dense-only indexing, unchanged. */
  embedFull?(texts: string[], opts?: EmbedOptions): Promise<MultiVectorEmbedding[]>;
}
const ENV_KEY: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  cohere: "COHERE_API_KEY",
};
export function resolveApiKey(provider: string, configKey?: string): string | undefined {
  if (configKey && configKey.length > 0) return configKey;
  const name = ENV_KEY[provider];
  return name ? process.env[name] : undefined;
}
/** Matryoshka (MRL) truncation: keep the first `dim` components and L2-renormalise to unit length. */
function mrlTruncate(v: number[], dim: number): number[] {
  const head = v.slice(0, dim);
  let norm = 0;
  for (const x of head) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return head;
  return head.map((x) => x / norm);
}

/**
 * Validate provider output: exactly `count` vectors, each finite, each of width `expected`. Width
 * handling:
 * - length === expected: pass through.
 * - length > expected AND opts.truncate: Matryoshka (MRL) truncation to `expected` + renormalise —
 *   for running a wider MRL model (e.g. Qwen3-8B at 4096) stored at a smaller dimension.
 * - otherwise (wrong width, or wider without truncate): error, so a genuinely mismatched non-MRL
 *   model is never silently truncated into meaningless prefixes.
 */
export function assertVectors(
  vectors: number[][],
  expected: number,
  count: number,
  opts: { truncate?: boolean } = {},
): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count)
    throw err.embeddingProviderError("wrong number of vectors", { expected_count: count });
  return vectors.map((v) => {
    if (!Array.isArray(v))
      throw err.embeddingProviderError("unexpected dimension", { expected_dim: expected });
    let out = v;
    if (v.length !== expected) {
      if (opts.truncate && v.length > expected) out = mrlTruncate(v, expected);
      else
        throw err.embeddingProviderError("unexpected dimension", {
          expected_dim: expected,
          got_dim: v.length,
        });
    }
    if (!out.every((x) => Number.isFinite(x)))
      throw err.embeddingProviderError("non-finite embedding component", {
        expected_dim: expected,
      });
    return out;
  });
}
