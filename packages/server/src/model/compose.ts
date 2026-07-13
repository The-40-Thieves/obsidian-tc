// Composition root for the retrieval-model tier. The seam (ports.ts) lets one process implement every
// ModelClient method or lets a composition fan each method to a different backend; this is that
// composition. The workload partition (#237) is deliberate: the REQUIRED dense stream is Qwen3 (a
// different vector space from BGE), served by the Rust TEI adapter, while the multi-vector heads
// (dense+sparse+ColBERT) come from the Python BGE-M3 service. The two are SEPARATE retrieval streams
// fused downstream by RRF on ranks - never by adding a Qwen cosine to a BGE score - so embed() and
// embedFull() intentionally answer from different backends and different vector spaces.
import type { ModelClient } from "./ports";

export interface ModelClientParts {
  /** Backend for the required dense stream (Qwen3 via TEI). Supplies embed(). */
  dense: ModelClient;
  /** Backend for the multi-vector stream (BGE-M3 via the Python service). Supplies embedFull(). */
  full?: ModelClient;
  /** Cross-encoder rerank backend. Falls back to whichever of dense/full exposes rerank(). */
  reranker?: ModelClient;
}

/**
 * Assemble a ModelClient that routes each method to its owning backend. embed -> dense (Qwen);
 * embedFull -> full (BGE-M3) when present; rerank -> the first backend that exposes it (explicit
 * reranker, else dense, else full). embedFull / rerank stay absent when no backend provides them, so
 * a dense-only deployment yields a ModelClient with just embed() - unchanged from serving Qwen alone.
 */
export function composeModelClient(parts: ModelClientParts): ModelClient {
  const client: ModelClient = {
    embed: (req) => parts.dense.embed(req),
  };
  const embedFull = parts.full?.embedFull;
  if (embedFull) {
    client.embedFull = (req) => embedFull(req);
  }
  const rerank = [parts.reranker, parts.dense, parts.full].find((c) => c?.rerank)?.rerank;
  if (rerank) {
    client.rerank = (req) => rerank(req);
  }
  return client;
}
