// THE-460: single source of truth for the vec_chunks "representation" — every constant that
// changes what a stored vector MEANS. ensureVecChunks (search/vec.ts) folds all of these, plus
// the embedding provider/model/dimensions, into one fingerprint string that gets persisted
// alongside the index; any change here makes the stored fingerprint stop matching, which forces
// a rebuild/rotate rather than silently serving vectors built under a stale representation.

import { createHash } from "node:crypto";
import { canonicalJson } from "../hash";
import { DEFAULT_CHUNK_TOKENS } from "./chunk";

/** The vec0 table's distance_metric. Bump/change this when the DDL's distance_metric changes
 *  (e.g. cosine -> l2) — stored distances are meaningless across a metric change. */
export const VEC_DISTANCE_METRIC = "cosine";

/** The current vec0 table shape generation (columns / partition+aux structure, see THE-277).
 *  Bump this when the CREATE VIRTUAL TABLE DDL's column set or partitioning changes, so a
 *  differently-shaped table is never mistaken for being up to date. */
export const VEC_SCHEMA_GEN = "partition+aux";

/** Bump when chunking logic changes what text ends up embedded (span boundaries, splitting
 *  strategy, merge heuristics, ...) — the vec index would otherwise mix vectors built from
 *  differently-chunked text. */
export const CHUNKER_VERSION = 1;

/** Bump when the THE-406 chunk-context enrichment (note-title + heading-breadcrumb prefix on the
 *  embedded/BM25 text) changes. Callers fold this in only when enrichment is ON — pass
 *  `enrichmentVersion: chunkContext ? ENRICHMENT_VERSION : 0` — so toggling chunkContext itself
 *  also changes the fingerprint and triggers a rebuild. */
export const ENRICHMENT_VERSION = 1;

/** Everything that determines what a vector in vec_chunks actually represents. Two indexes are
 *  interchangeable iff every field here matches. */
export interface VecFingerprint {
  provider: string;
  model: string;
  dimensions: number;
  distanceMetric: string;
  enrichmentVersion: number;
  chunkerVersion: number;
  schemaGen: string;
  /** Optional extra disambiguator (e.g. a provider/model revision or checkpoint id) when one is
   *  readily available; omitted otherwise. */
  revision?: string;
}

/** Stable canonical string for a VecFingerprint — persisted in vec_index_fingerprint and compared
 *  on every ensureVecChunks call. Field order is fixed; any field's value changing changes the
 *  string, which is exactly the rebuild trigger. */
export function vecFingerprint(f: VecFingerprint): string {
  return [
    f.provider,
    f.model,
    String(f.dimensions),
    f.distanceMetric,
    String(f.enrichmentVersion),
    String(f.chunkerVersion),
    f.schemaGen,
    f.revision ?? "",
  ].join("|");
}

// ---------------------------------------------------------------------------------------------
// Representation manifest — the identity `embeddings/providers.ts`'s `${provider}:${o.model}` id
// SHOULD be, but isn't: that id is what stored embeddings (chunk_embeddings.model / provider.id)
// and THE-531's unchanged-note re-embed decision key on, and it is strictly WEAKER than
// VecFingerprint above — it carries none of the fields that can make two "same provider, same
// model" representations produce vectors that are not interchangeable (a revision bump, a
// pooling change, an instruct prefix, MRL truncation, a multi-vector head, normalisation).
//
// RepresentationManifest is a structural SUPERSET of VecFingerprint, not a competing notion: every
// VecFingerprint field is present here under the identical name and type (`revision` widened from
// optional to a required string — see the "unknown" sentinel below), so `manifestVecFingerprint`
// is a straight field projection with nothing to keep in sync by hand. Adopting the manifest as
// the STORED key (replacing provider.id, and folding it into ensureVecChunks in place of the
// separately-built VecFingerprint object) is a follow-up change — see the module-level callers in
// runtime/indexing-wiring.ts and search/indexing/index-vault.ts — because that adoption changes
// vecFingerprint()'s stored string and forces a one-time reindex; this module only adds the type
// and its hash.
//
// A field this repo's provider/config surface cannot report today is spelled "unknown" rather
// than omitted. Omitting a field and setting it to a known-absent sentinel must hash differently
// (a manifest predating the field, vs. one that checked and found nothing) — see
// representationManifestHash's tests for why "unknown" is a value, not a gap.
export type Knowable<T> = T | "unknown";

/** THE-460's VecFingerprint fields, plus every axis the current `provider:model` id ignores.
 *  Two representations are interchangeable iff every field here matches — the same rule
 *  VecFingerprint already states, extended to axes VecFingerprint doesn't see. */
export interface RepresentationManifest {
  // --- VecFingerprint, verbatim (same names/types) — see manifestVecFingerprint. ---
  provider: string;
  model: string;
  dimensions: number;
  distanceMetric: string;
  enrichmentVersion: number;
  chunkerVersion: number;
  schemaGen: string;
  /** Model revision / commit / checkpoint id. Config-pinned (model/factory.ts's
   *  ModelTierDenseConfig.revision) or server-reported (model/tei.ts's GET /info model_sha) when
   *  the backend exposes one; every other adapter in embeddings/providers.ts has no such concept
   *  in its config today, so "unknown" — not the empty string VecFingerprint defaults to, which
   *  would silently equate "checked, no revision" with "never asked". */
  revision: Knowable<string>;
  /** Pooling strategy (e.g. "last-token", "mean"). Only model/tei.ts's TeiClientOptions.pooling
   *  is configurable in this codebase; the OpenAI-style/Cohere/Ollama/bge-m3 adapters never
   *  surface one. */
  pooling: Knowable<string>;
  /** THE-405 asymmetric instruct prefixes. Always knowable: EmbeddingsConfigLike.queryPrefix /
   *  documentPrefix default to "", and "" is itself the real (default, off) value — distinct from
   *  "unknown", which would claim the config was never inspected. */
  queryPrefix: string;
  documentPrefix: string;
  /** THE-387 Matryoshka (MRL) output-truncation policy (EmbeddingsConfigLike.truncate). Always
   *  knowable — a plain boolean, default false. */
  truncate: boolean;
  /** Per-input truncation/context ceiling. No adapter in embeddings/providers.ts or
   *  model/factory.ts surfaces one today (maxBatchTokens is a request-BATCHING cap, not a
   *  per-input truncation length) — "unknown" until one does. */
  maxInputTokens: Knowable<number>;
  /** Whether this representation emits more than one vector per chunk (bge-m3's / the model
   *  tier's learned-sparse + ColBERT heads via `embedFull`). Always knowable — it is exactly
   *  `typeof provider.embedFull === "function"`. */
  multiVector: boolean;
  /** Whether the dense vector is L2-normalised. Only model/tei.ts's EmbedResult reports this
   *  (ports.ts RepresentationMeta / EmbedResult.normalized, always true for TEI, but that is a
   *  RUNTIME response field, not something config states up front) — "unknown" for every
   *  statically-configured provider. */
  normalized: Knowable<boolean>;
  /** THE-424: the chunker's token budget (indexing.chunkTokens, default 512). Always knowable —
   *  a plain int with a schema default, so there is no "never asked" case to distinguish.
   *
   *  This is the ONLY axis here that changes what a chunk IS rather than what its vector MEANS,
   *  which is why the UPGRADE COST note on `representationFingerprint` does not extend to it.
   *  Every other axis leaves chunk ids and boundaries alone, so `vec_chunks` can refill from the
   *  stored `chunk_embeddings` rows. Move this one and those rows describe text that no current
   *  chunk contains — the refill would silently repopulate the index with vectors for chunks that
   *  no longer exist. Changing it means a real re-index, provider calls and all. */
  chunkTokens: number;
}

/** Project a RepresentationManifest down to the VecFingerprint it embeds — a straight field pick,
 *  never a re-derivation, so the two cannot drift apart. "unknown" maps to VecFingerprint's own
 *  "not supplied" value (undefined, which `vecFingerprint` treats as "") — the manifest's stronger
 *  "explicitly unknown" collapses to VecFingerprint's weaker "omitted" exactly where VecFingerprint
 *  has no way to say the stronger thing. */
export function manifestVecFingerprint(m: RepresentationManifest): VecFingerprint {
  return {
    provider: m.provider,
    model: m.model,
    dimensions: m.dimensions,
    distanceMetric: m.distanceMetric,
    enrichmentVersion: m.enrichmentVersion,
    chunkerVersion: m.chunkerVersion,
    schemaGen: m.schemaGen,
    revision: m.revision === "unknown" ? undefined : m.revision,
  };
}

/** Bump when a change to what goes INTO the manifest hash (a field added/removed/renamed, or the
 *  serialisation/digest scheme itself) should be detectable independent of any single manifest's
 *  field values — e.g. two old hashes computed under v1 must never be compared against a v2 hash
 *  and read as "equal" or "different" as if they meant the same thing. Folded into the hashed
 *  payload AND prefixed onto the returned string, so a version mismatch is visible without
 *  recomputing anything. */
export const MANIFEST_HASH_VERSION = 1;

/**
 * Stable, key-order-independent hash of a RepresentationManifest — the identity a cache or index
 * keyed on a representation should use instead of `${provider}:${model}`.
 *
 * Determinism: `canonicalJson` (hash.ts) recursively sorts object keys before serialising, so two
 * manifests with identical field VALUES hash identically regardless of the order those fields
 * were assigned in the object literal that built them.
 *
 * Distinguishing: every RepresentationManifest field participates (nothing is excluded from the
 * payload before serialising), so any field differing — including one the OLD `provider:model` id
 * ignored entirely, like `revision` or `queryPrefix` — changes the hash. A field that is
 * genuinely unknown must be the literal "unknown", never omitted: an omitted key changes the
 * canonicalized key SET (and therefore the hash) relative to a manifest that has the key set to
 * "unknown", which is exactly the point — "never checked" and "checked, found nothing" must not
 * collide.
 */
export function representationManifestHash(m: RepresentationManifest): string {
  const payload = canonicalJson({ hashVersion: MANIFEST_HASH_VERSION, ...m });
  const digest = createHash("sha256").update(payload, "utf8").digest("hex");
  return `v${MANIFEST_HASH_VERSION}:${digest}`;
}

// ---------------------------------------------------------------------------------------------
// THE-683: the production producer. Before this, RepresentationManifest was a type with a hash and
// no caller, which is why `embeddings.pooling` reached nothing and its own .describe() had to admit
// the key did not affect the index.

/** The provider fields the manifest reads. Structural, so any EmbeddingProvider satisfies it and
 *  tests can pass a literal. `embedFull`'s PRESENCE is the multiVector axis — see the field's doc. */
export interface ManifestProviderLike {
  provider: string;
  model: string;
  dimensions: number;
  embedFull?: unknown;
}

/** The config fields the manifest reads. A narrow slice of EmbeddingsConfigLike plus `chunkContext`,
 *  which lives outside it (the chunker consumes that key too, not only the fingerprint). */
export interface ManifestConfigLike {
  chunkContext?: boolean;
  revision?: string;
  pooling?: string;
  truncate?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
  /** THE-424: indexing.chunkTokens. Optional here and defaulted below to the chunker's own 512,
   *  so a caller that predates this field keeps producing the pre-THE-424 fingerprint string. */
  chunkTokens?: number;
}

/**
 * Build the manifest for a running configuration — the ONE place a representation identity is
 * derived.
 *
 * Being the only derivation is the point, not a side benefit. `runtime/indexing-wiring.ts` and
 * `search/indexing/index-vault.ts` each used to construct a VecFingerprint by hand from the same
 * inputs, with a comment on the second warning that if they diverge "boot and index_vault each DROP
 * and rebuild the table the other just built — an unbounded rebuild loop". That hazard was guarded
 * only by a parity TEST; routing both through this function makes the divergence unrepresentable.
 *
 * Sentinels follow the Knowable<T> rule above: a field this config surface genuinely cannot report
 * is the literal "unknown", never omitted and never a plausible-looking default, so "checked, found
 * nothing" and "never asked" stay distinguishable in the hash.
 */
export function buildRepresentationManifest(
  provider: ManifestProviderLike,
  cfg: ManifestConfigLike,
): RepresentationManifest {
  return {
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    distanceMetric: VEC_DISTANCE_METRIC,
    // Folded only when enrichment is ON, so toggling chunkContext itself moves the fingerprint.
    enrichmentVersion: cfg.chunkContext === true ? ENRICHMENT_VERSION : 0,
    chunkerVersion: CHUNKER_VERSION,
    schemaGen: VEC_SCHEMA_GEN,
    revision: cfg.revision ?? "unknown",
    pooling: cfg.pooling ?? "unknown",
    // Always knowable: "" is the real (default, off) value, distinct from never having looked.
    queryPrefix: cfg.queryPrefix ?? "",
    documentPrefix: cfg.documentPrefix ?? "",
    truncate: cfg.truncate ?? false,
    // No adapter surfaces a per-input truncation ceiling; maxBatchTokens is a request-BATCHING cap,
    // which is a different thing and deliberately not folded in here.
    maxInputTokens: "unknown",
    multiVector: typeof provider.embedFull === "function",
    // Only reported at RUNTIME (model/tei.ts's EmbedResult.normalized); nothing states it up front.
    normalized: "unknown",
    chunkTokens: cfg.chunkTokens ?? DEFAULT_CHUNK_TOKENS,
  };
}

/**
 * The canonical fingerprint string persisted in `vec_index_fingerprint`, extended to the axes
 * `VecFingerprint` cannot see.
 *
 * The first eight fields are `vecFingerprint`'s, in its exact order, so this is a strict suffix
 * extension rather than a re-ordering — a legacy string is a prefix of the new one, which makes a
 * mismatch obvious when read by a human debugging a rebuild.
 *
 * UPGRADE COST — read before assuming this is expensive. A fingerprint change does NOT re-embed.
 * `ensureVecChunks` drops `vec_chunks` and backfills from `chunk_embeddings` (the already-stored
 * vectors), filtered on `e.model = activeModel` where activeModel is `provider.id`. None of the
 * axes added here move `provider.id`, so the filter still matches every stored row and the index
 * refills locally: no provider calls, no re-embed, no billing. That is why no compatibility shim
 * is carried — one would buy immunity from a cost that does not exist, at the price of
 * conditional-equivalence logic inside the identity comparison.
 *
 * THE-424 — `chunkTokens` is the ONE exception, and the paragraph above must not be read as
 * covering it. The free-refill argument rests on stored vectors still describing the chunks that
 * exist. Every other axis preserves chunk boundaries and only changes how a vector is interpreted;
 * chunkTokens changes the boundaries themselves, so after a change the stored rows describe text
 * no current chunk contains and the refill would repopulate the index with vectors for chunks that
 * are gone. Changing it costs a real re-index. Adding it did not: existing configs take the 512
 * default, their chunks are byte-identical, and only the fingerprint string gains a suffix — which
 * is the cheap local rebuild this paragraph describes.
 */
export function representationFingerprint(m: RepresentationManifest): string {
  return [
    // --- vecFingerprint's fields, same order (see manifestVecFingerprint for the projection). ---
    m.provider,
    m.model,
    String(m.dimensions),
    m.distanceMetric,
    String(m.enrichmentVersion),
    String(m.chunkerVersion),
    m.schemaGen,
    m.revision === "unknown" ? "" : m.revision,
    // --- axes VecFingerprint ignores; each can change what a stored vector MEANS. ---
    m.pooling === "unknown" ? "" : m.pooling,
    m.queryPrefix,
    m.documentPrefix,
    String(m.truncate),
    String(m.multiVector),
    m.normalized === "unknown" ? "" : String(m.normalized),
    // THE-424. Appended, never inserted: the suffix-extension rule above is what lets a legacy
    // string stay a readable prefix of a current one. Unconditional, per the same paragraph's
    // refusal of conditional-equivalence logic — a default-512 deployment does move its
    // fingerprint string, and that costs it a local vec rebuild rather than a re-embed.
    String(m.chunkTokens),
  ].join("|");
}
