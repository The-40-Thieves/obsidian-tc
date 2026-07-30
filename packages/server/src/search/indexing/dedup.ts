// WP3 slice 2 (docs/plans/2026-07-30-codebase-refactor-map.md): the cross-path embedding dedup
// LOOKUP + COPY, moved verbatim out of indexer.ts. This file reads a dedup owner chunk's already-
// stored vectors and copies them onto a skipEmbed chunk's rows; it performs NO embedding calls of
// its own (the owner's vector was computed by a prior embedPlans call, in a prior transaction or
// earlier in this same one). persist-note-plan.ts calls copyDedupVectors for each skipEmbed chunk
// in a plan; it never calls fetchDedupSource directly.
import { cachedPrepare, type Database } from "../../db/types";
import { blobToFloats, upsertVec } from "../vec";
import type { DedupCache, DedupSource } from "./types";

// THE-454: copy an identical EMBED TEXT's already-stored vectors onto a cross-path-dedup (skipEmbed)
// chunk so it stays retrievable by dense/sparse/ColBERT, not just FTS. The source is another chunk
// (c.id != target) with the same embed representation + model. It MUST match on content_hash (the
// enriched embed-text hash under THE-406), not body_sha alone: two identical raw bodies under
// DIFFERENT titles share a body_sha but embed different text, so copying by body_sha handed the second
// note the first note's (wrongly-titled) vector. body_sha stays in the predicate purely as the indexed
// access path (index chunks_body_sha); content_hash enforces correctness. The owner is visible because
// its plan was applied earlier in this same transaction (walk order) or committed in a prior run
// (THE-445 seed). If the owner has no stored embedding (e.g. it was quarantined), nothing is copied —
// the chunk degrades to FTS-only, no worse than before. Requires the body_sha column (guaranteed:
// skipEmbed is only set when it exists, see computeNotePlan dedupEnabled).

// THE-488: fetch the owner chunk's stored vectors for a content_hash — one embedding SELECT plus, when
// the columns exist, one sparse and one colbert SELECT. Memoized by copyDedupVectors so this runs once
// per DISTINCT content_hash per flush, not once per deduped chunk.
function fetchDedupSource(
  db: Database,
  args: { vaultId: string; bodySha: string; contentHash: string; model: string; targetId: string },
  hasChunkSparse: boolean,
  hasChunkColbert: boolean,
): DedupSource {
  const emb = cachedPrepare(
    db,
    "SELECT e.embedding AS embedding, e.dimensions AS dimensions FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ? AND e.model = ? AND e.is_active = 1 AND c.id != ? LIMIT 1",
  ).get(args.vaultId, args.bodySha, args.contentHash, args.model, args.targetId) as
    | { embedding: Uint8Array; dimensions: number }
    | undefined;
  if (!emb) return null;
  const sparse = hasChunkSparse
    ? ((
        cachedPrepare(
          db,
          "SELECT s.weights AS weights FROM chunk_sparse s JOIN chunks c ON c.id = s.chunk_id WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ? AND c.id != ? LIMIT 1",
        ).get(args.vaultId, args.bodySha, args.contentHash, args.targetId) as
          | { weights: string }
          | undefined
      )?.weights ?? null)
    : null;
  const colbert = hasChunkColbert
    ? ((
        cachedPrepare(
          db,
          "SELECT cb.vectors AS vectors FROM chunk_colbert cb JOIN chunks c ON c.id = cb.chunk_id WHERE c.vault_id = ? AND c.body_sha = ? AND c.content_hash = ? AND c.id != ? LIMIT 1",
        ).get(args.vaultId, args.bodySha, args.contentHash, args.targetId) as
          | { vectors: string }
          | undefined
      )?.vectors ?? null)
    : null;
  return { embedding: emb.embedding, dimensions: emb.dimensions, sparse, colbert };
}

export function copyDedupVectors(
  db: Database,
  args: {
    targetId: string;
    bodySha: string;
    contentHash: string;
    vaultId: string;
    path: string;
    model: string;
    ts: number;
    hasVec: boolean;
    hasChunkSparse: boolean;
    hasChunkColbert: boolean;
  },
  cache: DedupCache,
): { resolved: boolean } {
  // THE-488: memoize the owner's vectors by content_hash for this flush. The source is the same owner
  // chunk for every duplicate of a content_hash, so the JOINs run once per distinct content_hash, not
  // once per deduped chunk (a hot repeated JOIN inside the write txn on template-heavy vaults).
  let src = cache.get(args.contentHash);
  if (src === undefined) {
    src = fetchDedupSource(db, args, args.hasChunkSparse, args.hasChunkColbert);
    cache.set(args.contentHash, src);
  }
  // THE-588: no stored embedding to copy — chunk degrades to FTS-only (unchanged behaviour). The
  // caller counts this as an UNRESOLVED dedup skip, distinct from the reused-work counter.
  if (!src) return { resolved: false };

  cachedPrepare(
    db,
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding, is_active = 1, generated_at = excluded.generated_at",
  ).run(args.targetId, args.model, src.dimensions, src.embedding, args.ts);
  // THE-531: the copied vector is under the current model, so retire any superseded-model row for the
  // target chunk (same "active = current representation" rule as the direct-embed path).
  cachedPrepare(
    db,
    "UPDATE chunk_embeddings SET is_active = 0 WHERE chunk_id = ? AND model != ? AND is_active = 1",
  ).run(args.targetId, args.model);
  if (args.hasVec)
    upsertVec(db, args.targetId, Array.from(blobToFloats(src.embedding)), {
      vaultId: args.vaultId,
      path: args.path,
      model: args.model,
    });
  // sparse + ColBERT are plain TEXT columns — write the memoized owner values onto the target.
  if (args.hasChunkSparse && src.sparse !== null)
    cachedPrepare(
      db,
      "INSERT INTO chunk_sparse (chunk_id, vault_id, weights) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, weights = excluded.weights",
    ).run(args.targetId, args.vaultId, src.sparse);
  if (args.hasChunkColbert && src.colbert !== null)
    cachedPrepare(
      db,
      "INSERT INTO chunk_colbert (chunk_id, vault_id, vectors) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, vectors = excluded.vectors",
    ).run(args.targetId, args.vaultId, src.colbert);
  return { resolved: true };
}
