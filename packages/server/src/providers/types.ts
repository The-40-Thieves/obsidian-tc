// Descriptor and entry shapes shared by BOTH provider slots. Types only.
import type { FetchFn } from "../embeddings/http";
import type { EmbeddingProvider } from "../embeddings/provider";
import type { Reranker } from "../search/rerank";

// Moved here (rather than staying in embeddings/index.ts, which re-exports it for compatibility)
// to break a circular dependency: embeddings/index.ts imports providers/registry.ts, and
// providers/types.ts needs this shape — a type-only cycle .dependency-cruiser.cjs still forbids.
export interface EmbeddingsConfigLike {
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  /** Name of the env var holding the provider API key — see resolveApiKey (embeddings/provider.ts).
   *  Needed for generic providers, which have no entry in the built-in per-vendor ENV_KEY map. */
  apiKeyEnv?: string;
  /** GH #171: per-request embed timeout (ms). Undefined -> the postJson default. */
  timeoutMs?: number;
  /** THE-387: Matryoshka (MRL) truncation of a wider native output to `dimensions`. */
  truncate?: boolean;
  /** THE-405: asymmetric instruct prefixes (see config schema docs). Both default empty. */
  queryPrefix?: string;
  documentPrefix?: string;
  /** #237: polyglot model tier — Qwen3 dense (Rust TEI) + BGE-M3 multi-vector (Python service).
   *  Required when `provider === "model-tier"`. */
  modelTier?: {
    dense: { baseUrl: string; model?: string; revision?: string; pooling?: string };
    full?: {
      baseUrl: string;
      model?: string;
      revision?: string;
      authToken?: string;
      dimensions?: number;
    };
  };
}

/** Everything a registry entry may read off a config block, for either slot. */
export interface ProviderDescriptor {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  modulePath?: string;
}

export interface ResolveContext {
  fetchFn?: FetchFn;
  /** Directory of the loaded config file — the trust root for `modulePath`. Undefined when the
   *  config was derived from a vault path rather than a file. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
  /** The EMBEDDINGS config, needed by the model-tier reranker entry: buildModelTierReranker takes
   *  ModelTierConfigLike, which requires `dimensions` and `modelTier` (model/factory.ts:87-94) —
   *  fields a reranker descriptor does not carry. Passing it as ambient context is what makes that
   *  entry work; the first draft cast the descriptor instead, which compiled and returned null. */
  embeddings?: EmbeddingsConfigLike;
}

export interface EmbeddingsEntry {
  /** The path this entry appends to `baseUrl`. Declared so the resolver can refuse a baseUrl that
   *  would duplicate it — the adapters do NOT agree on whether baseUrl carries a version segment. */
  readonly appendsPath: string;
  /** True when the entry does its own query/document prefixing and must bypass withPrefixes.
   *  Only model-tier does (Qwen instruct on the dense query, BGE bare). */
  readonly ownsPrefixing?: boolean;
  /** True when the entry can only be built asynchronously (the module hatch). The sync
   *  createEmbeddingProvider refuses these with an actionable error. */
  readonly asyncOnly?: boolean;
  build(cfg: EmbeddingsConfigLike, ctx: ResolveContext): EmbeddingProvider;
  buildAsync?(cfg: EmbeddingsConfigLike, ctx: ResolveContext): Promise<EmbeddingProvider>;
}

export interface RerankerEntry {
  readonly appendsPath: string;
  /** Null means "configured, but this backend is unavailable" — the caller falls back to the
   *  graceful no-op, exactly as buildModelTierReranker does today. Async because the module hatch
   *  needs it and both slots share one resolver contract. */
  build(cfg: ProviderDescriptor, ctx: ResolveContext): Promise<Reranker | null>;
}
