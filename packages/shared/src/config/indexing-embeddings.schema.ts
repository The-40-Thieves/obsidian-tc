// WP1.4: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. IndexingConfigSchema chains only
// `.prefault({})` (a default-application combinator, not a `.refine`/`.superRefine`) — there is
// no cross-domain field read to keep back in config.schema.ts, so the whole schema moves here.
import { z } from "zod";

export const EmbeddingsConfigSchema = z.object({
  provider: z
    .string()
    .min(1)
    .default("ollama")
    .describe(
      "Embeddings backend name, resolved against the provider registry at startup. Built-ins: ollama, openai, voyage, cohere, bge-m3, model-tier (splits dense and multi-vector across two services), the generic openai-compatible, and the profile-gated module. An unregistered name is a startup error listing every valid option.",
    ),
  model: z
    .string()
    .default("nomic-embed-text")
    .describe("Embedding model name as the provider names it."),
  dimensions: z
    .number()
    .int()
    .positive()
    .default(768)
    .describe(
      "Stored vector width, and the width of the vec0 column. Changing it requires a fresh index — existing vectors are not re-projected.",
    ),
  baseUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Provider base URL. Required for self-hosted runners; hosted providers default to their public API.",
    ),
  apiKey: z
    .string()
    .optional()
    .describe("Provider API key. Secret — never logged or returned by a tool."),
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of the environment variable holding the provider API key. Needed for generic providers, which have no entry in the built-in per-vendor variable map. An inline apiKey takes precedence.",
    ),
  modulePath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Module exporting createEmbeddingProvider, for provider 'module'. Resolved against the config file's directory. Refused under the hardened security profile, and refused on CLI/eval entry points (module providers load only from the server's boot wiring). The factory may be sync or async (an async factory is awaited). It must return an object with a non-empty string id, provider, and model — id is what chunk_embeddings.model and the vec fingerprint identify the provider by, so two module providers sharing (or omitting) id are indistinguishable to the index — a positive integer dimensions, and embed(texts). Validated at load time, before first use.",
    ),
  revision: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model revision / commit / checkpoint id. Folded into vec_index_fingerprint, so declaring it makes a checkpoint upgrade at the SAME model name and width rebuild the index instead of silently serving the old checkpoint's vectors against queries embedded by the new one. Omitting it reproduces today's behaviour exactly.",
    ),
  pooling: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Pooling strategy the backend applies (e.g. 'mean', 'last-token'). Recorded for provenance. NOTE: descriptive only today — RepresentationManifest has no production producer, so this does not affect the index.",
    ),
  // GH #171/#172: local-runner indexing robustness. Local models are far slower than hosted APIs,
  // and a stock local runner (llama-server) crashes on a token-dense batch, so these are
  // configurable with local-safe defaults. `timeoutMs` bounds each embed request (was a hardcoded
  // 30s with no knob). `batchSize` caps inputs/request; `maxBatchTokens` caps a request's estimated
  // tokens (chars/4) so a dense sub-batch is split before it overruns a local runner's budget (a
  // single over-budget text still goes alone). `concurrency` is how many embed requests run in flight.
  // THE-390: `maxBatchTokens` must stay UNDER the provider's loaded context — Ollama defaults to
  // n_ctx 4096 and 400-rejects a request whose summed tokens exceed it, and the chars/4 estimate
  // undercounts real tokenization (~2-2.5x on link-dense markdown). 2048 estimated keeps a batch
  // inside a 4096 context with that drift; the indexer also bisects + retries a rejected batch,
  // so an occasional overshoot costs a retry, not the reindex.
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(120000)
    .describe(
      "Timeout in ms for a single embed request. Defaults high because local runners are far slower than hosted APIs.",
    ),
  batchSize: z.number().int().positive().default(512).describe("Maximum inputs per embed request."),
  maxBatchTokens: z
    .number()
    .int()
    .positive()
    .default(2048)
    .describe(
      "Estimated-token ceiling per request (chars/4), splitting a dense sub-batch before it overruns a local runner's budget. Must stay UNDER the provider's loaded context: Ollama defaults to n_ctx 4096 and rejects an over-budget request, and the chars/4 estimate undercounts real tokenization on link-dense markdown.",
    ),
  concurrency: z
    .number()
    .int()
    .positive()
    .default(4)
    .describe("How many embed requests run in flight at once."),
  // THE-387: Matryoshka (MRL) dimension truncation. When true, a provider that returns vectors
  // WIDER than `dimensions` is truncated to the first `dimensions` components + renormalised (so a
  // wide MRL model such as Qwen3-8B at 4096 can be stored at 1024). Off by default; a non-MRL width
  // mismatch still errors rather than silently truncating meaningless prefixes.
  truncate: z
    .boolean()
    .default(false)
    .describe(
      "Matryoshka (MRL) truncation: accept a provider vector WIDER than `dimensions` by keeping the first `dimensions` components and renormalising. Off by default so a non-MRL width mismatch errors instead of silently storing a meaningless prefix.",
    ),
  /** THE-406: contextual chunk enrichment. When true, each chunk is embedded and BM25-indexed as
   *  "{note title}{ — heading breadcrumb}\n\n{content}" instead of the bare section text — the
   *  chunker strips heading lines into metadata, so title/heading-only evidence is otherwise
   *  invisible to both retrieval streams. Display content (chunks.content) stays raw. The chunk
   *  content hash covers the enriched text, so flipping this re-embeds the vault on the next
   *  reconcile. DEFAULT ON since THE-408: measured +0.223 nDCG@10 (p=0.0001) with the divergence
   *  rebuild now enrichment-aware. UPGRADE NOTE: an index built with the flag off re-embeds in
   *  full on the first reconcile after upgrading (hash change) — set `chunkContext: false` to
   *  keep the old representation. */
  chunkContext: z
    .boolean()
    .default(true)
    .describe(
      'Embed and BM25-index each chunk as "{title}{ — heading breadcrumb}\\n\\n{content}" rather than bare section text, so title- and heading-only evidence is visible to both retrieval streams. Displayed content stays raw. The chunk hash covers the enriched text, so changing this re-embeds the vault on the next reconcile.',
    ),
  /** THE-405: asymmetric instruct prefixes for models whose cards require them (e.g.
   *  Qwen3-Embedding's "Instruct: ...\nQuery: " on the query side, documents plain). Applied at
   *  the provider factory: `queryPrefix` on embeds marked input:"query", `documentPrefix` on
   *  everything else (indexing). BOTH default empty — nomic-style prefixes measured HARMFUL on
   *  this vault (2026-07-11), so nothing changes unless a config opts in. Changing
   *  `documentPrefix` re-embeds nothing by itself (hashes cover chunk text, not the prefix) —
   *  pair a document-prefix change with a fresh cacheDir. */
  queryPrefix: z
    .string()
    .default("")
    .describe(
      "Instruct prefix prepended to query-side embeds, for models whose cards require one. Empty by default — such prefixes measured harmful on this corpus.",
    ),
  documentPrefix: z
    .string()
    .default("")
    .describe(
      "Instruct prefix prepended to document-side (indexing) embeds. Empty by default. Changing it re-embeds nothing on its own, since hashes cover chunk text and not the prefix — pair a change with a fresh cacheDir.",
    ),
  /** #237: polyglot model tier - dense retrieval from Qwen3 via the Rust TEI service,
   *  sparse+ColBERT from BGE-M3 via the Python service (services/bge-m3-service). Required when
   *  provider is "model-tier". The two are SEPARATE streams fused by RRF on ranks;
   *  embeddings.dimensions is the Qwen dense width (the vec0 column). */
  modelTier: z
    .object({
      dense: z
        .object({
          baseUrl: z
            .string()
            .url()
            .describe("Base URL of the dense (Qwen3 via Rust TEI) embedding service."),
          model: z
            .string()
            .default("Qwen/Qwen3-Embedding-0.6B")
            .describe("Dense model id. Its width is what embeddings.dimensions must match."),
          revision: z
            .string()
            .optional()
            .describe(
              "Pinned model revision for the dense service. PROVENANCE ONLY: it moves neither provider.id nor vec_index_fingerprint, so changing it does not rebuild the index. Use the top-level embeddings.revision to force a re-embed — it applies to model-tier too.",
            ),
          pooling: z
            .string()
            .default("last-token")
            .describe("Pooling strategy for the dense model."),
        })
        .describe("Dense retrieval half of the model tier. Required when provider is model-tier."),
      full: z
        .object({
          baseUrl: z.string().url().describe("Base URL of the multi-vector (BGE-M3) service."),
          model: z.string().default("BAAI/bge-m3").describe("Multi-vector model id."),
          revision: z
            .string()
            .optional()
            .describe(
              "Pinned model revision for the multi-vector service. PROVENANCE ONLY: it moves neither provider.id nor vec_index_fingerprint, so changing it does not rebuild the index. Use the top-level embeddings.revision to force a re-embed — it applies to model-tier too.",
            ),
          authToken: z
            .string()
            .optional()
            .describe("Bearer token for the multi-vector service. Secret."),
          dimensions: z
            .number()
            .int()
            .positive()
            .default(1024)
            .describe(
              "Dense width of the multi-vector model, separate from embeddings.dimensions.",
            ),
        })
        .optional()
        .describe(
          "Sparse and ColBERT half of the model tier. Absent disables the retrieval.sparse and retrieval.colbert streams.",
        ),
    })
    .optional()
    .describe(
      "Polyglot model tier: dense retrieval from one service and sparse/ColBERT from another, fused by RRF on ranks. Required when provider is model-tier.",
    ),
});

// THE-458 (audit #5): index-on-write coordinator concurrency + backpressure. Fully defaulted so a
// config predating it validates unchanged. `writeConcurrency` bounds concurrent index/embed calls
// across ALL vaults; `writeConcurrencyPerVault` bounds them per vault (audit recommends 2–4);
// `queueMax` is a soft distinct-pending-path cap that surfaces backpressure in server_health (writes
// are never dropped).
export const IndexingConfigSchema = z
  .object({
    writeConcurrency: z
      .number()
      .int()
      .positive()
      .default(8)
      .describe("Ceiling on concurrent index/embed calls across ALL vaults."),
    writeConcurrencyPerVault: z
      .number()
      .int()
      .positive()
      .default(4)
      .describe("Ceiling on concurrent index/embed calls for a single vault."),
    queueMax: z
      .number()
      .int()
      .positive()
      .default(1000)
      .describe(
        "Soft cap on distinct pending paths, surfaced as backpressure in server_health. Writes are never dropped when it is exceeded.",
      ),
    /** THE-490/THE-591: indexVault's opt-in per-directory-sorted streaming walk
     *  (walkVaultStream), vs the default eager walkVault that materializes the whole sorted
     *  file list before any note is processed. Measured -43% peak RSS on a full reindex; index
     *  OUTPUT is unchanged either way (test/index-stream-walk-equivalence.test.ts). Until this
     *  flag existed, none of the three production callers (add_vault, the boot reconcile, the
     *  index_vault tool) ever set it, so the flag was unreachable outside tests — OFF by default
     *  and stays off until enabling it is a deliberate decision, not a de facto one. */
    streamingWalk: z
      .boolean()
      .default(false)
      .describe(
        "Walk the vault lazily per-directory (walkVaultStream) instead of materializing the full sorted file list before indexing starts. Lower peak memory on large vaults; index output is unchanged either way.",
      ),
  })
  .prefault({});
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
