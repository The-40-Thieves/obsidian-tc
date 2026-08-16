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
  /** Module exporting createEmbeddingProvider, for provider "module". See providers/module-loader.ts. */
  modulePath?: string;
  /** THE-460: model revision / commit / checkpoint id, folded into vec_index_fingerprint. Declaring
   *  it makes a checkpoint upgrade at the SAME model name and width rebuild the index instead of
   *  silently serving the old checkpoint's vectors against queries embedded by the new one.
   *  Undefined reproduces today's fingerprint byte-for-byte. */
  revision?: string;
  /** THE-460/THE-683: pooling strategy the backend applies (e.g. "mean", "last-token"). Read by
   *  buildRepresentationManifest and folded into vec_index_fingerprint, so changing it rebuilds the
   *  vector index (from the stored embeddings — no re-embed). */
  pooling?: string;
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

/** Everything a registry entry may read off a config block, for either slot.
 *
 *  `model` is OPTIONAL here (unlike EmbeddingsConfigLike's required one): the reranker schema
 *  cannot require it, because the `model-tier` entry ignores it entirely (it sources its model
 *  from embeddings.modelTier.full.model) — an entry that DOES need it (`cohere-compatible`) is
 *  responsible for throwing its own actionable "reranker.model is required" error at build time. */
export interface ProviderDescriptor {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  modulePath?: string;
}

export interface ResolveContext {
  fetchFn?: FetchFn;
  /** `dirname(configPath)` — the trust root for `modulePath`. `configPath` is whatever was passed
   *  to `buildServerRuntime`: undefined when it is genuinely absent (no `--config`, no
   *  `OBSIDIAN_TC_CONFIG`), but in zero-config vault-path mode `configPath` is the VAULT directory,
   *  not a config file — so this is NOT undefined there, it's that vault directory's parent (an
   *  accidental value, not a deliberate trust root; the module hatch is unreachable from that mode
   *  today only because nothing constructs a `module` provider without an actual config file). A
   *  relative `configPath` (e.g. `--config cfg.json`) makes this `"."`, i.e. cwd-relative — see
   *  module-loader.ts's resolution comment. Review round 2 (Minor 5): this comment previously
   *  claimed "undefined when derived from a vault path", which was false. */
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
  /** THE-837: why this built-in is on its way out, and what to move to. Advisory ONLY — a
   *  deprecated entry keeps working unchanged, because the alternative is not free: this repo
   *  stores `provider.id` in `chunk_embeddings.model` (search/vec.ts), so it IS the vec-index
   *  fingerprint (THE-460/THE-678). Switching a user off a built-in re-embeds their whole vault,
   *  which is a major-version migration, not something a deprecation notice may trigger by itself.
   *  Surfaced by doctor so the notice reaches an operator before that release, not with it. */
  readonly deprecated?: string;
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
