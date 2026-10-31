/** GH #1433: `embeddings.maxBatchTokens` (2048) and `.concurrency` (4) are provider-AGNOSTIC
 *  schema defaults, and the schema records why those numbers: 2048 estimated tokens keeps a batch
 *  inside Ollama's n_ctx 4096. Both were therefore sized for a runner in ANOTHER process, where a
 *  large batch costs that process's memory and this one only waits.
 *
 *  Under `provider: "local"` the same two numbers decide how large each IN-PROCESS ONNX inference
 *  is and how many run at once. A reporter measured the resident plateau scaling with chunks per
 *  request — 1 -> ~0.5 GB, 2 -> ~0.73 GB, 4 -> ~1.1 GB, 32 -> 1.9-2.7 GB for nomic q8 — on a
 *  server that settled at 1.5 GB and peaked at 2.9 GB, filling swap on a 12 GB host. 2048/4 is up
 *  to four of the ~1.1 GB case in flight at once.
 *
 *  WHY NOT A PROVIDER-CONDITIONAL SCHEMA DEFAULT: an earlier change made `model`/`dimensions`
 *  default on `provider` via a schema-level `.transform()`, which turns the schema into a ZodPipe
 *  — scripts/docgen/extract-config.ts's introspection walker needs a literal object with a
 *  `.shape` to recurse into, so the WHOLE `embeddings` subtree silently vanished from generated
 *  docs. indexing-embeddings.schema.ts's LOCAL_DEFAULT_MODEL comment records that in full.
 *
 *  WHY A BASELINE AND NOT A ONE-WAY LOWERING (review of the first version of this change): the
 *  schema-resolved provider is NOT final. `applyStickyEmbeddings` runs later, at boot and in five
 *  CLI commands, and restores an unconfigured install's EXISTING provider — and it fires exactly
 *  when `provider` was absent, i.e. precisely when it had defaulted to "local". A lowering applied
 *  once in finalizeConfig therefore left an ollama/openai install that merely omits `provider`
 *  running at 512/1, slowing its indexing for no reason. So the parsed values are recorded here
 *  and `applyEmbedBatchingDefaults` is idempotent: it RE-derives from the provider each time it is
 *  called, restoring the baseline when the provider turns out not to be local. It is called from
 *  finalizeConfig (covering every path) and again at the end of applyStickyEmbeddings (covering
 *  the one place that can change the provider afterwards, so no caller of it can forget).
 *
 *  PER KEY, and never over an operator's own value — including one that happens to equal what
 *  would have been derived. That needs the RAW pre-parse object: a Zod default and an explicit
 *  value equal to it are indistinguishable once `parse` has run, the same reason
 *  isEmbeddingsDimensionsExplicit exists in config/load.ts.
 *
 *  The WeakMap is keyed on the `embeddings` sub-object for the reasons provider-explicit.ts's
 *  header gives: it survives every `{...cfg}`-shaped spread of a resolved config, because
 *  `embeddings` is mutated in place and never rebuilt. An `embeddings` object that never went
 *  through finalizeConfig (a test literal, a programmatic caller) has no entry, and the apply
 *  below leaves it exactly as it was — the safe side, since that object's values are whatever its
 *  author chose.
 *
 *  The cost is reindex throughput, not correctness: `concurrency: 1` leaves a many-core host
 *  under-used during a full reindex, so a host with memory to spare should raise it explicitly.
 *  Steady-state edits arrive as small batches and barely change, and a long-lived server's memory
 *  ceiling is the thing that actually needed bounding. */
export const LOCAL_EMBED_MAX_BATCH_TOKENS = 512;
export const LOCAL_EMBED_CONCURRENCY = 1;

/** The narrow structural slice this module reads and writes — never the full `ServerConfig`, so
 *  `applyStickyEmbeddings`'s own `StickyEmbeddingsConfigLike` can carry these two keys as
 *  optional without any caller of it being forced to supply them. */
export interface EmbedBatchingConfigLike {
  provider: string;
  maxBatchTokens?: number;
  concurrency?: number;
}

interface EmbedBatchingBaseline {
  maxBatchTokensExplicit: boolean;
  concurrencyExplicit: boolean;
  maxBatchTokens: number | undefined;
  concurrency: number | undefined;
}

const BASELINE = new WeakMap<object, EmbedBatchingBaseline>();

/** Did the config literally name `embeddings.<key>`? Asked by key rather than by a function per
 *  key, because both keys need the identical question — config/load.ts's four per-key
 *  `is*Explicit` functions each carry their own distinct reason and are left as they are. */
export function isEmbeddingsKeyExplicit(raw: Record<string, unknown>, key: string): boolean {
  const embeddings = raw.embeddings;
  return (
    typeof embeddings === "object" &&
    embeddings !== null &&
    !Array.isArray(embeddings) &&
    key in embeddings
  );
}

/** Called once, by config/load.ts's `finalizeConfig`, BEFORE the first apply — so the recorded
 *  values are the parsed ones (the schema defaults, or whatever the operator wrote). */
export function markEmbedBatchingBaseline(
  embeddings: EmbedBatchingConfigLike,
  raw: Record<string, unknown>,
): void {
  BASELINE.set(embeddings, {
    maxBatchTokensExplicit: isEmbeddingsKeyExplicit(raw, "maxBatchTokens"),
    concurrencyExplicit: isEmbeddingsKeyExplicit(raw, "concurrency"),
    maxBatchTokens: embeddings.maxBatchTokens,
    concurrency: embeddings.concurrency,
  });
}

/** Idempotent, and safe to call again whenever `provider` may have changed. Mutates in place, like
 *  finalizeConfig's other post-parse derivations. */
export function applyEmbedBatchingDefaults(embeddings: EmbedBatchingConfigLike): void {
  const baseline = BASELINE.get(embeddings);
  if (baseline === undefined) return;
  const isLocal = embeddings.provider === "local";
  if (!baseline.maxBatchTokensExplicit) {
    embeddings.maxBatchTokens = isLocal ? LOCAL_EMBED_MAX_BATCH_TOKENS : baseline.maxBatchTokens;
  }
  if (!baseline.concurrencyExplicit) {
    embeddings.concurrency = isLocal ? LOCAL_EMBED_CONCURRENCY : baseline.concurrency;
  }
}
