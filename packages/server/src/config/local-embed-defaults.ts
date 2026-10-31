import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";

/** GH #1433: `embeddings.maxBatchTokens` (2048) and `.concurrency` (4) are provider-AGNOSTIC
 *  schema defaults, and the schema's own comment records why those numbers: 2048 estimated tokens
 *  keeps a batch inside Ollama's n_ctx 4096. Both were therefore sized for a runner in ANOTHER
 *  process, where a large batch costs that process's memory and this one only waits.
 *
 *  Under `provider: "local"` the same two numbers decide how large each IN-PROCESS ONNX inference
 *  is and how many run at once. A reporter measured the resident plateau scaling with chunks per
 *  request — 1 -> ~0.5 GB, 2 -> ~0.73 GB, 4 -> ~1.1 GB, 32 -> 1.9-2.7 GB for nomic q8 — on a
 *  server that settled at 1.5 GB and peaked at 2.9 GB, filling swap on a 12 GB host. 2048/4 is up
 *  to four of the ~1.1 GB case in flight at once.
 *
 *  WHY THIS IS NOT A PROVIDER-CONDITIONAL SCHEMA DEFAULT: an earlier change made
 *  `model`/`dimensions` default on `provider` via a schema-level `.transform()`, which turns the
 *  schema into a ZodPipe — scripts/docgen/extract-config.ts's introspection walker needs a literal
 *  object with a `.shape` to recurse into, so the WHOLE `embeddings` subtree silently vanished
 *  from generated docs. indexing-embeddings.schema.ts's LOCAL_DEFAULT_MODEL comment records that
 *  in full. So this is applied post-parse, exactly as LOCAL_CATALOG_DIMENSIONS is.
 *
 *  PER KEY, and never over an operator's own value — including one that happens to equal what
 *  would have been derived. That needs the RAW pre-parse object: a Zod default and an explicit
 *  value equal to it are indistinguishable once `parse` has run, the same reason
 *  isEmbeddingsDimensionsExplicit exists in load.ts. Reading `raw` after the parse is safe because
 *  neither applyEnvOverlays nor applySecurityProfile touches `embeddings` (0 references in
 *  security-profile.ts).
 *
 *  The cost is reindex throughput, not correctness: `concurrency: 1` leaves a many-core host
 *  under-used during a full reindex, so a host with memory to spare should raise it explicitly.
 *  Steady-state edits arrive as small batches and barely change, and a long-lived server's memory
 *  ceiling is the thing that actually needed bounding. */
export const LOCAL_EMBED_MAX_BATCH_TOKENS = 512;
export const LOCAL_EMBED_CONCURRENCY = 1;

/** Did the config literally name `embeddings.<key>`? Asked by key rather than by a function per
 *  key, because both keys need the identical question — load.ts's four per-key `is*Explicit`
 *  functions each carry their own distinct reason and are left as they are. */
export function isEmbeddingsKeyExplicit(raw: Record<string, unknown>, key: string): boolean {
  const embeddings = raw.embeddings;
  return (
    typeof embeddings === "object" &&
    embeddings !== null &&
    !Array.isArray(embeddings) &&
    key in embeddings
  );
}

/** Mutates `config.embeddings` in place, like finalizeConfig's other post-parse derivations. */
export function applyLocalEmbedBatchingDefaults(
  config: ServerConfig,
  raw: Record<string, unknown>,
): void {
  if (config.embeddings.provider !== "local") return;
  if (!isEmbeddingsKeyExplicit(raw, "maxBatchTokens")) {
    config.embeddings.maxBatchTokens = LOCAL_EMBED_MAX_BATCH_TOKENS;
  }
  if (!isEmbeddingsKeyExplicit(raw, "concurrency")) {
    config.embeddings.concurrency = LOCAL_EMBED_CONCURRENCY;
  }
}
