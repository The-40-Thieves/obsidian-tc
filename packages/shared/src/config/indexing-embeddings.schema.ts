// WP1.4: extracted from ../config.schema.ts (which stays a compatibility facade re-exporting
// these same symbol names). Leaf schema — imports Zod only, no shared scalars needed here.
//
// Import direction is non-negotiable: this file must never import config.schema.ts,
// server.schema.ts, or any other schema module. IndexingConfigSchema chains only
// `.prefault({})` (a default-application combinator, not a `.refine`/`.superRefine`) — there is
// no cross-domain field read to keep back in config.schema.ts, so the whole schema moves here.
import { z } from "zod";

// THE-1122: `LOCAL_DEFAULT_MODEL` MUST stay in sync with packages/embedder-local/src/model-info.ts's
// DEFAULT_MODEL_NAME — this file cannot import that optional, non-workspace package (it is
// Node-fs- and network-shaped; this schema leaf is isomorphic and imports Zod only, see the file
// header). embedder-local's own test/model-info.test.ts pins its DEFAULT_MODEL_NAME to the same
// literal string, so a future change to one side is caught by that test, not just by this comment.
//
// NOT the smallest/fastest catalog entry — measured, not assumed, each model with its own
// correct pooling strategy (docs/EVALUATION.md's "Local embedder model selection"). Both 384-dim
// candidates FAILED the −0.015 non-inferiority floor against this exact model — MiniLM's deficit
// is real and clearly detected; bge-small's nDCG@10 does not reach conventional significance at
// this n, so read that one number as non-inferiority not established at this corpus's resolution
// rather than a pass (its recall@10 IS significant, and it still fails the floor either way).
// nomic-embed-text-v1.5 is the default as the conservative choice under this underpowered
// comparison, not a claimed decisive win — see model-info.ts's own comment on DEFAULT_MODEL_NAME
// for the exact numbers.
//
// WHY THIS IS A PLAIN UNCONDITIONAL DEFAULT, NOT PROVIDER-CONDITIONAL: an earlier version of this
// change made `model`/`dimensions` default based on `provider` via a schema-level `.transform()`.
// That broke scripts/docgen/extract-config.ts's hand-rolled Zod introspection walker (it requires
// every nested config section to literally be `def.type === "object"` with a `.shape` to recurse
// into it; a `.transform()` turns the schema into a ZodPipe, and the WHOLE `embeddings` subtree
// silently vanished from generated docs — caught by test/docgen-config.test.ts, not by inspection).
// The plain default below is the one-line fix: `provider`/`model`/`dimensions` keep the exact
// unconditional-default shape every OTHER field in this schema already has. The one behavioural
// cost: `{ "provider": "ollama" }` with no `model` now resolves `model` to "nomic-embed-text-v1.5"
// (the new schema default) rather than the old "nomic-embed-text" (no version suffix — Ollama's
// own tag name) — Ollama then 404s LOUDLY on a model it was never asked to pull, rather than
// silently misconfiguring anything (the two happen to share `dimensions: 768`, so that half is
// unaffected). This shorthand (provider set, model omitted) was never actually documented
// anywhere in this repo's own config examples, which always pair `"provider": "ollama"` with an
// explicit `"model"` — see docs/src/content/docs/configuration/config-yaml.md and
// docs/wiki/Configuration.md.
const LOCAL_DEFAULT_MODEL = "nomic-embed-text-v1.5";

/** THE-1122 review (item 7): each "local" catalog entry's native vector width, duplicated from
 *  packages/embedder-local/src/model-info.ts for the SAME reason LOCAL_DEFAULT_MODEL above is
 *  duplicated rather than imported (this schema leaf cannot depend on that optional, Node-fs-
 *  shaped package — see this file's own header). Kept in sync by the same mechanism:
 *  embedder-local's own test/model-info.test.ts pins each catalog entry's real `dimensions`, so a
 *  future catalog change that drifts from this map is caught there, not only by this comment.
 *
 *  Exported for packages/server/src/config/load.ts's finalizeConfig, which uses this to (a)
 *  DERIVE `embeddings.dimensions` when a "local" config omits it (this schema's own `dimensions`
 *  default is a PROVIDER-AGNOSTIC 768 — see LOCAL_DEFAULT_MODEL's comment above for why it cannot
 *  be provider-conditional at the schema level — so a config selecting a 384-dim catalog entry
 *  with no explicit `dimensions` would otherwise silently inherit the wrong width and crash later
 *  at vec0 column-width mismatch), and (b) REJECT an explicit `dimensions` that contradicts the
 *  selected model's real width, naming both numbers, rather than letting that surface as an opaque
 *  failure far from the config that caused it. */
export const LOCAL_CATALOG_DIMENSIONS: Readonly<Record<string, number>> = {
  "all-MiniLM-L6-v2": 384,
  "bge-small-en-v1.5": 384,
  "nomic-embed-text-v1.5": 768,
};

export const EmbeddingsConfigSchema = z.object({
  provider: z
    .string()
    .min(1)
    .default("local")
    .describe(
      "Embeddings backend name, resolved against the provider registry at startup. Built-ins: local (a bundled, fully offline dense embedder via the optional @the-40-thieves/obsidian-tc-embedder-local package; no network, no Ollama, no API key), ollama, openai, voyage, cohere, bge-m3, model-tier (splits dense and multi-vector across two services), the generic openai-compatible, and the profile-gated module. `local` is the DEFAULT when this whole block is absent — semantic search works with zero configuration. An unregistered name is a startup error listing every valid option.",
    ),
  model: z
    .string()
    .min(1)
    .default(LOCAL_DEFAULT_MODEL)
    .describe(
      'Embedding model name as the provider names it. Defaults to nomic-embed-text-v1.5, the "local" provider\'s default catalog entry — set this explicitly for every other provider. Under provider "local" this MUST be one of embedder-local\'s pinned catalog names (all-MiniLM-L6-v2, bge-small-en-v1.5, nomic-embed-text-v1.5) — an unrecognized name is refused, since the local provider only ever loads checksum-verified weights it has a pinned manifest for.',
    ),
  dimensions: z
    .number()
    .int()
    .positive()
    .default(768)
    .describe(
      "Stored vector width, and the width of the vec0 column. Changing it requires a fresh index — existing vectors are not re-projected. Defaults to 768, nomic-embed-text-v1.5's native width (the \"local\" provider's default model) — set this explicitly to match whatever model you configure (e.g. 384 for the smaller local catalog entries).",
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
      "Pooling strategy the backend applies (e.g. 'mean', 'last-token'). Folded into the representation identity persisted as vec_index_fingerprint, so changing it rebuilds the vector index rather than serving vectors pooled a different way against queries pooled the new way. The rebuild reuses the stored embeddings — it does not re-embed, and costs no provider calls.",
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
  // THE-1122: only read by provider "local".
  quantized: z
    .boolean()
    .default(true)
    .describe(
      'provider "local" only. true (default) loads the pinned q8 (int8) quantized ONNX export; false loads the pinned fp32 export instead — larger, slower, marginally more precise. Both are separately checksum-verified; toggling this re-downloads the other variant on first use if it is not already cached.',
    ),
  threads: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'provider "local" only. onnxruntime-node intra-/inter-op thread count. Absent lets the runtime pick its own default (usually the CPU core count).',
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
    /** THE-424: the chunker's token budget. `ChunkOptions.maxTokens` has always existed and
     *  `chunkNote(body)` has always been called with NO options, so the budget was pinned at the
     *  512 default and the only way to change it was to edit chunk.ts. Same shape as
     *  experiential.activationDecay before THE-644 item 3: a knob with no handle. Additive,
     *  defaulted to the existing 512, and threaded to its consumer in the same change.
     *
     *  UNLIKE every other representation axis, changing this DOES require a re-embed. The
     *  fingerprint comment in search/representation.ts explains that a fingerprint change is
     *  normally free because `vec_chunks` refills from the already-stored `chunk_embeddings`
     *  rows — that holds because no other axis moves `provider.id` OR the chunk boundaries. This
     *  one moves the boundaries: different budget means different chunk ids, different content
     *  hashes, and stored vectors that describe text no chunk contains any more. Budget a full
     *  re-index, and prefer a fresh cacheDir over mutating a live one.
     *
     *  Bounded [64, 8192]: below ~64 a chunk cannot carry a heading breadcrumb plus a sentence,
     *  and 8192 is bge-m3's context ceiling — past it the tail is silently truncated by the
     *  provider rather than by us, which is the failure mode hardest to see from the index. */
    chunkTokens: z
      .number()
      .int()
      .min(64)
      .max(8192)
      .default(512)
      .describe(
        "Chunker token budget: a note section over this many estimated tokens is sub-split on paragraph boundaries. Participates in the representation fingerprint, and unlike the other axes a change here requires a full re-index — different budget means different chunk boundaries, so stored vectors no longer describe any chunk that exists.",
      ),
  })
  .prefault({});
export type IndexingConfig = z.infer<typeof IndexingConfigSchema>;
