// The two model-tier ports (workload-partition ADR, #237). The control plane speaks these two
// interfaces and never a concrete backend, so the retrieval models and the LLM gateway scale and
// fail independently:
//   - ModelClient       retrieval models: dense embed (Qwen3 via the Rust TEI service), multi-vector
//                       encode (BGE-M3 dense+sparse+ColBERT via the Python service), cross-encoder rerank.
//   - GenerationClient  the LLM gateway: extract / synthesize / judge, a SEPARATE boundary.
// rerank lives on ModelClient, not GenerationClient: a cross-encoder is a retrieval model, not a chat
// completion. Keeping the two apart is the rule that the retrieval service never impersonates the LLM
// gateway, and the gateway never owns a retrieval model.
import type { MultiVectorEmbedding } from "../embeddings/provider";
import type { CompletionRequest, CompletionResult, RerankRequest, RerankResult } from "../gateway";

export type {
  CompletionRequest,
  CompletionResult,
  MultiVectorEmbedding,
  RerankRequest,
  RerankResult,
};

/** How to encode: asymmetric models embed a query differently from a document ("document" is the
 *  indexing default). The query-side instruction (Qwen3's `Instruct:`) is applied by the caller via
 *  the config prefix seam, never baked into the service. */
export type EncodeInput = "query" | "document";

/** Provenance stamped on every representation so a stored vector's generation is self-describing. A
 *  representation whose identity (model + revision + pooling + dimensions) differs from the active
 *  config's manifest is marked stale and rebuilt into a new generation, never silently fused. */
export interface RepresentationMeta {
  /** Backend-resolved model id, e.g. "Qwen/Qwen3-Embedding-0.6B". */
  model: string;
  /** Immutable model revision (commit hash). A silent upstream update thus starts a new generation. */
  revision: string;
}

export interface EmbedRequest {
  texts: string[];
  input?: EncodeInput;
}

/** Dense embeddings (Qwen3 via TEI, or any dense backend). */
export interface EmbedResult extends RepresentationMeta {
  /** One vector per input, in request order, L2-normalised, width === `dimensions`. */
  vectors: number[][];
  dimensions: number;
  /** Pooling that produced the vectors, e.g. "last-token" (Qwen3). Part of the generation identity. */
  pooling: string;
  normalized: boolean;
}

/** BGE-M3's three heads per input. A head the backend cannot produce comes back empty ({} / [])
 *  rather than failing the encode, so a dense-only deployment still yields usable dense vectors. */
export interface EmbedFullResult extends RepresentationMeta {
  items: MultiVectorEmbedding[];
}

/**
 * Retrieval-model boundary. One process may implement all three methods (a single model service) or
 * a composition may fan each method out to a different backend (dense -> Rust TEI, full -> Python
 * BGE-M3). Callers depend only on this interface, never on which backend answered.
 */
export interface ModelClient {
  /** Dense embeddings for the required dense stream (Qwen3). */
  embed(req: EmbedRequest): Promise<EmbedResult>;
  /** Aligned dense+sparse+ColBERT for the BGE-M3 streams. Optional: a dense-only deployment omits it. */
  embedFull?(req: EmbedRequest): Promise<EmbedFullResult>;
  /** Cross-encoder rerank of a candidate set. Optional: reranking is a gated stage, off by default. */
  rerank?(req: RerankRequest): Promise<RerankResult>;
}

/**
 * Generative boundary: the self-hosted LLM gateway. The engine speaks ROLES (extract / synthesize /
 * judge), never providers; the gateway binds each role to a concrete model in config. Kept separate
 * from ModelClient so the retrieval service never impersonates the LLM gateway. The existing
 * GatewayClient structurally satisfies this: it is GenerationClient plus a legacy rerank passthrough,
 * and that rerank migrates onto ModelClient.rerank.
 */
export interface GenerationClient {
  extract(req: CompletionRequest): Promise<CompletionResult>;
  synthesize(req: CompletionRequest): Promise<CompletionResult>;
  judge(req: CompletionRequest): Promise<CompletionResult>;
}
