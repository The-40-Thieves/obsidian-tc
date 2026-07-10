// bge-m3 ColBERT store — THE-388 encode->store. Per-chunk ColBERT matrices (one row per token), the
// input to the MaxSim late-interaction rerank (colbert.ts). Runtime-provisioned like chunk_sparse so
// an older cache.db gains it on next open; written at index time only when the provider emits the
// ColBERT head (`embedFull`), and read as a bounded lookup over the fused top-K (never a full index).
import type { Database } from "../db/types";
import type { ColbertMatrix } from "./colbert";

const colbertCache = new WeakMap<Database, boolean>();

function chunksTableExists(db: Database): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")
      .get() !== undefined
  );
}

/** Provision chunk_colbert (a plain table). Returns false only when the chunks table is absent. */
export function ensureChunkColbert(db: Database): boolean {
  const cached = colbertCache.get(db);
  if (cached !== undefined) return cached;
  if (!chunksTableExists(db)) {
    colbertCache.set(db, false);
    return false;
  }
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chunk_colbert (chunk_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, vectors TEXT NOT NULL)",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_chunk_colbert_vault ON chunk_colbert(vault_id)");
    colbertCache.set(db, true);
    return true;
  } catch {
    colbertCache.set(db, false);
    return false;
  }
}

/** Upsert a chunk's ColBERT matrix (JSON). Caller owns the transaction + the hasChunkColbert guard. */
export function upsertChunkColbert(
  db: Database,
  chunkId: string,
  vaultId: string,
  vectors: ColbertMatrix,
): void {
  db.prepare(
    "INSERT INTO chunk_colbert (chunk_id, vault_id, vectors) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, vectors = excluded.vectors",
  ).run(chunkId, vaultId, JSON.stringify(vectors));
}

/** Delete a chunk's ColBERT row. */
export function deleteChunkColbert(db: Database, chunkId: string): void {
  db.prepare("DELETE FROM chunk_colbert WHERE chunk_id = ?").run(chunkId);
}

/**
 * Load ColBERT matrices for the given chunk ids into a Map (the `docById` shape colbertRerank wants).
 * Bounded to the fused top-K by the caller; chunks with no stored matrix are simply absent from the
 * map (colbertRerank treats them as unscored). [] chunk ids or an absent table -> empty map.
 */
export function loadChunkColbert(db: Database, chunkIds: string[]): Map<string, ColbertMatrix> {
  const out = new Map<string, ColbertMatrix>();
  if (chunkIds.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < chunkIds.length; i += CHUNK) {
    const slice = chunkIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    let rows: Array<{ chunk_id: string; vectors: string }>;
    try {
      rows = db
        .prepare(`SELECT chunk_id, vectors FROM chunk_colbert WHERE chunk_id IN (${placeholders})`)
        .all(...slice) as Array<{ chunk_id: string; vectors: string }>;
    } catch {
      return out;
    }
    for (const r of rows) {
      try {
        out.set(r.chunk_id, JSON.parse(r.vectors) as ColbertMatrix);
      } catch {
        // skip a corrupt row
      }
    }
  }
  return out;
}
